"""商品资料提取：把「粘贴 / 上传 / 选已有商品」的资料变成商品卡字段预览。

做什么
======
``POST /studio/projects/{project_id}/product-card/extract`` 的**唯一实现**
（契约见 ``site/content/docs/plans/drama-ad-full-loop.md`` §二「商品卡」）。

为什么单独一个服务模块
======================
1. 端点是**付费出口（最多一次文本模型调用）**：调用的组装、守卫与失败口径集中在服务层，
   路由只负责 HTTP 形状（``routes/studio/product_card.py`` 懒加载本模块，模块缺失时如实 503）；
2. 提取**不落库**：契约要求「不落库、不生成剧情，由用户确认后走 PUT」。所以本模块
   从头到尾没有 ``db.add`` / ``db.flush`` / ``db.commit`` —— 测试用「商品卡行未变」断言这条纪律。

硬约束（每条都有对应测试）
==========================
- **一次调用**：真实路径最多调用一次文本模型，并过 :mod:`~app.services.studio.llm_orchestration.dry_run`
  守卫；演练模式下**一次都不调**，返回字段全空的结构化结果 + 如实说明（**绝不编造**）；
- **不编造**：可提取字段严格来自 ``EDITABLE_CARD_FIELDS``（去掉 `confirmed` / `reference_files`，
  理由见 :data:`EXTRACTABLE_CARD_FIELDS`）；模型没给的字段留空并进 ``missing_fields``，
  页面显示「待补充」；
- **不识图**：本仓库**没有任何识图 / OCR / 多模态能力**，``file_ids`` 里的图片只归档成
  ``reference_files``（kind=image）并在 ``warnings`` 里如实说明读不出文字，绝不假装；
- **解析复用**：TXT / MD / DOCX 用 :mod:`app.services.studio.doc_text`，与
  ``POST /studio/documents/parse`` 同一套规则（编码兜底、DOCX 标准库解析、`.doc` 明确拒绝）。

出口性质
========
只有**文本模型**算付费出口；读素材文件走既有对象存储封装（本机驱动就是本地磁盘读），
不产生费用，也不触网（外链素材一律不下载，见 :func:`_load_file_bytes`）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from string import Template
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import storage
from app.models.studio import FileItem, Product
from app.schemas.studio.product_card import (
    EDITABLE_CARD_FIELDS,
    ProductCardExtractRead,
    ProductCardUpdate,
)
from app.services.studio import doc_text, product_card_service
from app.services.studio.llm_orchestration import dry_run
from app.services.studio.llm_orchestration.client import (
    LLMRequestError,
    TextLLMCaller,
    TextLLMTarget,
    call_text_llm,
    resolve_text_llm_target,
)
from app.services.studio.llm_orchestration.json_utils import (
    JSONParseError,
    coerce_str,
    coerce_str_list,
    parse_json_object_with_repairs,
)
from app.services.studio.llm_orchestration.support import (
    dry_run_warning,
    raise_llm_failure,
    raise_parse_failure,
)

# ---------------------------------------------------------------------------
# 字段集合与来源类型
# ---------------------------------------------------------------------------

SOURCE_TYPES: tuple[str, ...] = ("manual", "paste", "upload", "existing")

#: 提示词允许模型产出的字段：**严格派生自** ``EDITABLE_CARD_FIELDS``，只去掉两项：
#: - ``confirmed``：确认是用户的动作，模型不得替用户确认商品卡；
#: - ``reference_files``：那是本地归档结果（图片/文档引用），不是从文字里"提取"出来的信息。
EXTRACTABLE_CARD_FIELDS: tuple[str, ...] = tuple(
    key for key in EDITABLE_CARD_FIELDS if key not in {"confirmed", "reference_files"}
)

#: 列表字段（归一用 ``coerce_str_list``）；其余可提取字段都是文本（归一用 ``coerce_str``）。
LIST_CARD_FIELDS: tuple[str, ...] = tuple(
    key for key in EXTRACTABLE_CARD_FIELDS if key in {"selling_points", "scenarios"}
)

#: 模型偶尔会换写法：常见别名归一（**不扩大字段集合**，只是把写法纠回来）。
FIELD_ALIASES: dict[str, str] = {
    "product_name": "name",
    "goods_name": "name",
    "brand_name": "brand",
    "category_name": "category",
    "sellingPoints": "selling_points",
    "selling_point": "selling_points",
    "core_selling_points": "selling_points",
    "target_audience": "audience",
    "targetAudience": "audience",
    "use_scenarios": "scenarios",
    "usage_scenarios": "scenarios",
    "priceInfo": "price_info",
    "price": "price_info",
    "compliance_notes": "compliance",
    "forbidden_expressions": "compliance",
    "extra_notes": "notes",
    "description": "notes",
}

#: 模型偶尔把字段包一层：这些键下的对象会被自动展开（展开动作会记进 warnings）。
WRAPPER_KEYS: tuple[str, ...] = ("product", "product_card", "card", "fields", "data", "result", "extracted")

#: 图片后缀（**只归档、不识别**）。
IMAGE_EXTENSIONS: set[str] = {"jpg", "jpeg", "png", "webp", "gif"}

#: 能解析出正文的文本类后缀（与 ``doc_text`` 同一口径）。
TEXT_FILE_EXTENSIONS: set[str] = set(doc_text.TEXT_EXTENSIONS) | set(doc_text.DOCX_EXTENSIONS)


# ---------------------------------------------------------------------------
# 对用户说的中文（口径集中在这里，页面与接口共用同一套说法）
# ---------------------------------------------------------------------------

NOTE_EXTRACTED = (
    "提取完成，**尚未落库**：请核对字段、补齐标了「待补充」的项，再点「确认商品卡」保存。"
)
NOTE_DRY_RUN = (
    "[DRY_RUN] 演练模式：本次**没有调用任何大模型**，所以一个字段都没有提取（也绝不编造）。"
    f"要真实提取请显式设置 {dry_run.DRY_RUN_ENV}=0 且 {dry_run.CONFIRM_ENV}=1 后重启后端；"
    "也可以先手工填写商品卡。"
)
NOTE_NO_TEXT = (
    "没有可用于提取的**文字**资料：本次未调用模型，也没有编造任何字段。"
    "请粘贴商品文案，或上传 TXT / DOCX 后重试（图片读不出文字，见下方说明）。"
)
NOTE_EXISTING = (
    "来源是**已有商品资产**：名称与描述直接映射进字段，其余字段留空待补充。"
    "这一步不需要、也没有调用模型（资料已存在，再让模型复述只会增加编造风险）。"
)

IMAGE_WARNING = (
    "「{name}」是图片：当前环境不识图（没有识图/OCR 能力），无法从图片里读出文字，"
    "已归档为商品参考图；它的文字信息请粘贴进来或上传 TXT / DOCX。"
)
UNSUPPORTED_FILE_WARNING = (
    "「{name}」类型（{ext}）暂不支持解析文字，已作为参考资料登记；"
    "请粘贴商品文案，或上传 TXT / DOCX 后重试。"
)
FILE_MISSING_WARNING = "文件不存在或已删除（file_id={file_id}），已跳过，未编造任何内容。"
FILE_READ_FAILED_WARNING = "「{name}」读取失败（{reason}），未提取到文字。"
FILE_PARSE_FAILED_WARNING = "「{name}」解析失败：{detail}"

#: 提取状态（机器可读，写进 ``source_summary["extraction_status"]``）。
STATUS_EXTRACTED = "llm_extracted"
STATUS_DRY_RUN = "dry_run_not_called"
STATUS_NO_TEXT = "no_text_source_not_called"
STATUS_EXISTING = "existing_mapped_not_called"


# ---------------------------------------------------------------------------
# 提示词（放在本模块：``llm_orchestration/prompt_templates.py`` 归剧情线所有，
# 商品资料提取与它没有共享变量，写在一起会让两条线互相踩）
# ---------------------------------------------------------------------------

PRODUCT_CARD_PROMPT_TEMPLATE = Template(
    """
你是 AI 短剧 / 广告生产系统的**商品资料提取助手**。任务：把用户给的资料整理成"商品信息卡"字段。

## 硬性要求

- 只返回**一个合法 JSON 对象**：不要 Markdown、不要代码围栏、不要解释、不要多余文字。
- **只能返回下面结构里的键**，一个都不要增、一个都不要删；不要返回结构之外的字段。
- 资料里**没有写到**的信息一律留空（文本字段给 `""`，列表字段给 `[]`）：
  **禁止猜测、禁止用常识补全、禁止编造**品牌、价格、合规要求、人群等任何信息。
- 字段值只允许来自资料原文（可做最小改写）；不要写资料里没有的数字或承诺。
- 资料里没提到"禁止表达/合规要求"时，`compliance` 必须留空，不要自行发明合规条款。
- `selling_points` / `scenarios` 是字符串数组，每项一句话；不确定就给 `[]`。

## 输出 JSON 结构

{
  "name": "商品名称，没有就给空串",
  "category": "品类",
  "brand": "品牌",
  "selling_points": ["核心卖点"],
  "audience": "目标人群",
  "scenarios": ["使用场景"],
  "price_info": "价格或促销信息",
  "compliance": "资料里明确写到的禁止表达 / 合规要求",
  "notes": "其它对拍广告有用的关键补充"
}

## 来源

source_type=$source_type（paste=用户粘贴的商品文案；upload=用户上传文件的正文）

## 资料原文

$source_text

## 附加要求

$extra_instructions
""".strip()
)


# ---------------------------------------------------------------------------
# 来源材料
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class SourceMaterial:
    """一次提取的**来源材料**（全是确定性数据，不含任何模型输出）。"""

    #: 可用于提取的原始文字（多个文件的正文按顺序拼接）。
    text: str = ""
    #: 归档用的参考文件：``[{file_id, name, kind}]``（图片/文档/其它）。
    files: list[dict[str, str]] = field(default_factory=list)
    #: 需要如实告知用户的问题（图片不识图、文件读不到、.doc 不支持……）。
    warnings: list[str] = field(default_factory=list)
    #: 技术详情用：每个文件的处理结果（文件名 / 类型 / 是否取到文字 / 字数）。
    file_summary: list[dict[str, Any]] = field(default_factory=list)
    #: ``source_type=existing`` 时的确定性字段映射（不走模型）。
    existing_fields: dict[str, Any] = field(default_factory=dict)
    #: ``source_type=existing`` 时回显的商品资产信息（技术详情用）。
    existing_product: dict[str, Any] = field(default_factory=dict)


async def read_reference_bytes(*, storage_key: str) -> bytes:
    """读取素材文件字节（**唯一下载入口**，测试/嵌入式调用可注入替身）。

    只读不写：不落盘、不回传、不删原文件。
    """
    return await storage.download_file(key=storage_key)


def _classify_file(*, name: str, storage_key: str, file_type: str) -> tuple[str, str]:
    """判定素材类别，返回 ``(kind, ext)``。

    ``kind`` 取值与 ``ProductReferenceFile.kind`` 一致：``image`` / ``document`` / ``other``。
    后缀优先（用户看得懂的文件名），没有后缀再退回素材库的 ``files.type``。
    """
    ext = doc_text.extension(name) or doc_text.extension(storage_key)
    if ext in IMAGE_EXTENSIONS:
        return "image", ext
    if ext in doc_text.TEXT_EXTENSIONS or ext in doc_text.DOCX_EXTENSIONS:
        return "document", ext
    if not ext and str(file_type or "").strip().lower() == "image":
        # 素材库已登记为图片：即使没有后缀也按图片归档（不尝试解析）。
        return "image", ext
    return "other", ext


async def _load_file_bytes(item: FileItem) -> tuple[bytes | None, str]:
    """读一个素材文件的字节，返回 ``(字节 | None, 失败原因)``。

    外链素材（``storage_key`` 是 http(s)）**不下载**：那会隐式出网，而且商品资料完全可以让
    用户直接粘贴，没必要为了省一次粘贴去抓公网文件。读不到不阻断流程，如实降级成告警。
    """
    key = str(item.storage_key or "").strip()
    if not key:
        return None, "素材记录里没有存储 key"
    if key.startswith(("http://", "https://")):
        return None, "外链素材不在服务端下载，请粘贴文字或上传 TXT/DOCX"
    try:
        return await read_reference_bytes(storage_key=key), ""
    except Exception as exc:  # noqa: BLE001 - 读不到文件不该让整次提取失败，如实告警即可
        return None, str(exc) or exc.__class__.__name__


def _reference_file(file_id: str, name: str, kind: str) -> dict[str, str]:
    """组装一条 ``reference_files`` 项（键必须与 DTO 一致，DTO 是 extra=forbid）。"""
    return {"file_id": file_id, "name": name, "kind": kind}


async def collect_paste_material(text: str) -> SourceMaterial:
    """``source_type=paste``：粘贴文本就是原始资料。"""
    source_text = str(text or "").strip()
    if not source_text:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "product_card_paste_empty",
                "message": "选择了「粘贴资料」，但粘贴内容是空的。",
                "fix": "把商品文案（名称/卖点/人群/价格等）粘贴进来，或改用上传 / 选已有商品。",
            },
        )
    return SourceMaterial(text=source_text)


async def collect_upload_material(db: AsyncSession, *, file_ids: list[str]) -> SourceMaterial:
    """``source_type=upload``：逐个文件处理。

    - TXT / MD / DOCX：解析出正文，拼成提取用的原始文字（解析规则复用 ``doc_text``，
      与 ``POST /studio/documents/parse`` 完全一致）；
    - 图片（jpg/jpeg/png/webp/gif）：**不识别**，只归档为参考图 + 如实告警；
    - 其它（.doc / .pdf / 视频 / 音频）：不解析，登记为参考资料 + 如实告警。

    每个分支都保证"用户传进来的东西不会凭空消失"：要么进了 ``reference_files``，
    要么留下一条能看懂的告警。
    """
    ids = [str(item).strip() for item in file_ids if str(item).strip()]
    if not ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "product_card_upload_empty",
                "message": "选择了「上传资料」，但没有传任何文件 ID。",
                "fix": "先上传商品资料文件（TXT / DOCX / 图片），或改用粘贴资料。",
            },
        )

    material = SourceMaterial()
    texts: list[str] = []
    for file_id in dict.fromkeys(ids):  # 去重但保序：同一个文件传两次不重复提取
        item = await db.get(FileItem, file_id)
        if item is None:
            material.warnings.append(FILE_MISSING_WARNING.format(file_id=file_id))
            material.file_summary.append({"file_id": file_id, "name": "", "kind": "missing", "usage": "skipped"})
            continue

        name = str(item.name or "").strip() or file_id
        # ``files.type`` 是 String(16) 列但按枚举注解，取值可能是枚举成员也可能是裸字符串：
        # 统一取 ``value``，两种形态都能得到 "image" / "video" / "audio"。
        file_type = str(getattr(item.type, "value", item.type) or "")
        kind, ext = _classify_file(name=name, storage_key=str(item.storage_key or ""), file_type=file_type)

        if kind == "image":
            # 图片：**不许装识图**。只归档 + 如实说明。
            material.files.append(_reference_file(item.id, name, "image"))
            material.warnings.append(IMAGE_WARNING.format(name=name))
            material.file_summary.append({"file_id": item.id, "name": name, "kind": "image", "usage": "reference_only"})
            continue

        if ext in TEXT_FILE_EXTENSIONS:
            # 文本文件在商品卡里也要看得见：解析成功/失败都登记为参考资料（kind=document），
            # 这样"用户传进来的东西"不会只在提示词里出现过就消失。
            material.files.append(_reference_file(item.id, name, "document"))
            raw, reason = await _load_file_bytes(item)
            if raw is None:
                material.warnings.append(FILE_READ_FAILED_WARNING.format(name=name, reason=reason))
                material.file_summary.append({"file_id": item.id, "name": name, "kind": "document", "usage": "read_failed"})
                continue
            try:
                extracted, fmt, file_warnings = doc_text.extract_plain_text(raw, filename=name)
            except HTTPException as exc:
                material.warnings.append(FILE_PARSE_FAILED_WARNING.format(name=name, detail=str(exc.detail)))
                material.file_summary.append({"file_id": item.id, "name": name, "kind": "document", "usage": "parse_failed"})
                continue
            for warn in file_warnings:
                material.warnings.append(f"「{name}」：{warn}")
            if extracted.strip():
                texts.append(extracted)
                usage = "text_extracted"
            else:
                material.warnings.append(f"「{name}」里没有解析到任何文字，未贡献提取内容。")
                usage = "empty_text"
            material.file_summary.append(
                {"file_id": item.id, "name": name, "kind": "document", "format": fmt, "usage": usage, "chars": len(extracted)}
            )
            continue

        # 其余类型：不解析，也不假装（.doc 会在这里被明确点出「请另存为 DOCX」的同类提示）。
        material.files.append(_reference_file(item.id, name, "other"))
        material.warnings.append(UNSUPPORTED_FILE_WARNING.format(name=name, ext=ext or "未知"))
        material.file_summary.append({"file_id": item.id, "name": name, "kind": "other", "usage": "unsupported"})

    material.text = "\n\n".join(part for part in texts if part.strip())
    return material


async def collect_existing_material(db: AsyncSession, *, existing_product_id: str) -> SourceMaterial:
    """``source_type=existing``：从 ``products`` 表取已有商品的名称 / 描述。

    这里是**确定性映射，不调模型**：资料本来就已经是结构化的数据库记录，让模型"提取"一遍
    只会多一次付费、多一份编造风险。其余字段留空 → ``missing_fields`` 标「待补充」。
    """
    product_id = str(existing_product_id or "").strip()
    if not product_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "product_card_existing_required",
                "message": "选择了「选已有商品资料」，但没有传商品 ID。",
                "fix": "从商品资产列表里选一个商品（GET /studio/entities/product），或改用粘贴 / 上传。",
            },
        )
    product = await db.get(Product, product_id)
    if product is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "product_card_existing_not_found",
                "message": f"选用的商品资产不存在：{product_id}",
                "fix": "重新选一个已有商品，或改成粘贴 / 上传商品资料。",
            },
        )

    name = coerce_str(product.name)
    description = coerce_str(product.description)
    fields: dict[str, Any] = {"name": name}
    if description:
        # 商品资产只有"外观与卖点描述"一个自由文本列，商品卡里能承载它的位置是 notes
        # （用户补充说明）。原样搬运，不做任何改写。
        fields["notes"] = description
    material = SourceMaterial(
        text=description,
        existing_fields=fields,
        existing_product={
            "existing_product_id": product.id,
            "existing_product_name": name,
            "existing_description": description,
        },
    )
    material.file_summary.append(
        {"file_id": product.id, "name": name, "kind": "existing", "usage": "mapped"}
    )
    return material


# ---------------------------------------------------------------------------
# 提示词组装 / 模型输出归一
# ---------------------------------------------------------------------------


def build_product_card_prompt(
    *,
    source_type: str,
    source_text: str,
    extra_instructions: str = "",
) -> str:
    """组装商品资料提取提示词（变量用 ``$`` 占位，避免 JSON 示例里的大括号被误解析）。"""
    return PRODUCT_CARD_PROMPT_TEMPLATE.safe_substitute(
        source_type=source_type,
        source_text=source_text,
        extra_instructions=str(extra_instructions or "").strip() or "无。",
    )


def _unwrap_payload(parsed: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """模型偶尔把字段包一层（``{"product": {...}}``）；展开它并记一条说明。"""
    if any(key in EXTRACTABLE_CARD_FIELDS or key in FIELD_ALIASES for key in parsed):
        return parsed, []
    for key in WRAPPER_KEYS:
        value = parsed.get(key)
        if isinstance(value, dict) and value:
            return dict(value), [f"模型把字段包在 `{key}` 下，已自动展开。"]
    return parsed, []


def coerce_extracted_fields(parsed: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """模型 JSON → 商品卡字段（**只认** :data:`EXTRACTABLE_CARD_FIELDS`）。

    归一规则：文本字段 ``coerce_str``、列表字段 ``coerce_str_list``；别名纠回标准名；
    结构之外的键一律忽略并记 warning（"模型多给了字段"这件事要看得见，不能静默）。
    """
    payload, warnings = _unwrap_payload(parsed)
    fields: dict[str, Any] = {}
    unknown: list[str] = []
    for key, value in payload.items():
        if value is None:
            continue
        target = key if key in EXTRACTABLE_CARD_FIELDS else FIELD_ALIASES.get(key, "")
        if not target:
            unknown.append(str(key))
            continue
        if target in LIST_CARD_FIELDS:
            coerced: Any = coerce_str_list(value)
        else:
            coerced = coerce_str(value)
        if target in fields:
            # 同一字段给了两种写法（例如 selling_points 与 sellingPoints）：合并而不是丢弃。
            if isinstance(fields[target], list) and isinstance(coerced, list):
                fields[target] = list(dict.fromkeys([*fields[target], *coerced]))
            elif not fields[target] and coerced:
                fields[target] = coerced
            continue
        fields[target] = coerced

    if unknown:
        warnings.append(
            f"模型返回了字段集合之外的键 {sorted(unknown)}，已忽略"
            f"（可提取字段严格来自 EDITABLE_CARD_FIELDS：{'、'.join(EXTRACTABLE_CARD_FIELDS)}）。"
        )
    if not any(fields.values()):
        warnings.append("模型返回的 JSON 里没有任何可用的商品卡字段，所有字段都留空（「待补充」），不编造。")
    return fields, warnings


def parse_extracted_fields(raw_text: str) -> tuple[dict[str, Any], list[str], list[str]]:
    """模型原始输出 → ``(字段, 告警, JSON 修复动作)``；解析不出来走结构化 422。"""
    try:
        parsed, repairs = parse_json_object_with_repairs(raw_text)
    except JSONParseError as exc:
        raise_parse_failure(exc, raw_text=raw_text)
        raise  # pragma: no cover - raise_parse_failure 一定抛异常

    fields, warnings = coerce_extracted_fields(parsed)
    if repairs:
        warnings.insert(0, f"模型输出经 JSON 抢救后解析成功：{'、'.join(repairs)}。")
    return fields, warnings, repairs


# ---------------------------------------------------------------------------
# 运行元信息 / 响应组装
# ---------------------------------------------------------------------------


def build_source_summary(
    *,
    source_type: str,
    material: SourceMaterial,
    extraction_status: str,
    llm_called: bool,
    model: TextLLMTarget | None = None,
    raw_output_chars: int = 0,
    fields_extracted: list[str] | None = None,
    latency_ms: int | None = None,
) -> dict[str, Any]:
    """``source_summary``：契约要求的技术详情（来源文件名、原文字数、提取时间、使用的模型）。

    ``api_key`` 绝不出现（用 ``TextLLMTarget.public()``，它显式排除了密钥）。
    """
    summary: dict[str, Any] = {
        "origin": "product_card_extract",
        "source_type": source_type,
        "source_files": list(material.file_summary),
        "raw_chars": len(material.text or ""),
        "extracted_at": datetime.now(timezone.utc).isoformat(),
        "extraction_status": extraction_status,
        "llm_called": llm_called,
        "model": model.public() if model is not None else None,
        "dry_run": dry_run.dry_run_enabled(),
        "guard_status": dry_run.short_status(),
        "fields_extracted": list(fields_extracted or []),
        "raw_output_chars": raw_output_chars,
    }
    if latency_ms is not None:
        summary["latency_ms"] = latency_ms
    if material.existing_product:
        summary.update(material.existing_product)
        if material.existing_fields.get("notes"):
            # 说明描述被搬到哪个字段，避免"我选了已有商品，描述去哪了"这种疑问。
            summary["existing_description_mapped_to"] = "notes"
    return summary


def _card_fields_for_missing(card: Any) -> dict[str, Any]:
    """把现有商品卡读成"参与缺项计算"的字段视图（没有卡就是空视图）。"""
    if card is None:
        return {}
    return {key: getattr(card, key, None) for key in EDITABLE_CARD_FIELDS if key != "confirmed"}


def _build_read(
    *,
    fields: dict[str, Any],
    base_fields: dict[str, Any],
    warnings: list[str],
    source_summary: dict[str, Any],
    note: str,
) -> dict[str, Any]:
    """组装 ``ProductCardExtractRead`` 的 dict（**不落库**，调用方直接返回/保存由页面决定）。

    缺项口径与 ``product_card_service.apply_extraction`` 一致：**把本次字段叠加到当前商品卡上**
    再算 ``missing_fields`` —— 这样响应里的缺项就等于"按这份结果保存后卡里还缺什么"，
    页面不必自己再算一遍。
    """
    merged = {
        key: (fields[key] if key in fields else base_fields.get(key))
        for key in EDITABLE_CARD_FIELDS
        if key != "confirmed"
    }
    missing, labels = product_card_service.compute_missing(merged)
    # 只把 DTO 认识的键交给 pydantic（DTO 是 extra=forbid）：多出来的键在这里被挡掉，
    # 而不是等到路由 model_validate 时炸出一个看不懂的 422。
    allowed_keys = set(ProductCardUpdate.model_fields)
    return ProductCardExtractRead(
        fields=ProductCardUpdate(**{key: value for key, value in fields.items() if key in allowed_keys}),
        missing_fields=missing,
        missing_labels=labels,
        source_summary=source_summary,
        warnings=warnings,
        note=note,
    ).model_dump()


# ---------------------------------------------------------------------------
# 编排入口
# ---------------------------------------------------------------------------


async def _try_resolve_target(
    db: AsyncSession,
    *,
    needed: bool,
) -> tuple[TextLLMTarget | None, str | None]:
    """解析默认文本模型；演练模式（或注入了 caller）下解析失败只记 warning，不阻断。"""
    try:
        return await resolve_text_llm_target(db), None
    except HTTPException as exc:
        if needed and not dry_run.dry_run_enabled():
            raise
        return None, f"未能解析默认文本模型配置：{exc.detail}"


async def extract_product_card(
    db: AsyncSession,
    *,
    project_id: str,
    source_type: str,
    text: str = "",
    file_ids: list[str] | None = None,
    existing_product_id: str = "",
    extra_instructions: str = "",
    llm_caller: TextLLMCaller | None = None,
) -> dict[str, Any]:
    """从资料提取商品卡字段（**付费出口，最多一次模型调用；不落库**）。

    返回 ``ProductCardExtractRead`` 的 dict：``fields`` / ``missing_fields`` /
    ``missing_labels`` / ``source_summary`` / ``warnings`` / ``note``。

    分支与"绝不编造"的对应关系：

    ==================  ==========================================================
    ``paste``           粘贴文本作为原始资料 → 一次模型调用 → 字段归一 + 缺项
    ``upload``          TXT/MD/DOCX 解析出正文后同上；图片只归档 + 告警（不识图）；
                        全都拿不到文字时**不调模型**，返回空字段 + 说明
    ``existing``        从 ``products`` 取名称/描述**直接映射**，不调模型
    ``manual``          没有"资料"可提取 → 400，引导直接保存商品卡
    ==================  ==========================================================
    """
    await product_card_service.require_project(db, project_id)

    normalized = str(source_type or "").strip().lower()
    if normalized not in SOURCE_TYPES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "product_card_source_type_invalid",
                "message": f"不支持的资料来源类型：{source_type or '（空）'}",
                "fix": f"source_type 只能是 {' / '.join(SOURCE_TYPES)} 之一。",
            },
        )
    if normalized == "manual":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "product_card_manual_needs_no_extraction",
                "message": "手工填写不需要提取：没有可提取的资料来源。",
                "fix": "直接调 PUT /studio/projects/{project_id}/product-card 保存你填好的商品卡。",
            },
        )

    if normalized == "paste":
        material = await collect_paste_material(text)
    elif normalized == "upload":
        material = await collect_upload_material(db, file_ids=list(file_ids or []))
    else:
        material = await collect_existing_material(db, existing_product_id=existing_product_id)

    # 现有商品卡：只用来算"按这份结果保存后还缺什么"，绝不会在本模块被改写。
    base_fields = _card_fields_for_missing(await product_card_service.get_card(db, project_id=project_id))

    # ---- existing：确定性映射，不调模型（资料本来就是结构化记录） ----
    if normalized == "existing":
        fields = dict(material.existing_fields)
        summary = build_source_summary(
            source_type=normalized,
            material=material,
            extraction_status=STATUS_EXISTING,
            llm_called=False,
            fields_extracted=[key for key in EXTRACTABLE_CARD_FIELDS if fields.get(key)],
        )
        return _build_read(
            fields=fields,
            base_fields=base_fields,
            warnings=list(material.warnings),
            source_summary=summary,
            note=NOTE_EXISTING,
        )

    # ---- upload 但一个字的正文都没拿到（例如只传了图片）：不调模型，因为调了也只能编造 ----
    if not material.text.strip():
        no_text_warnings = list(material.warnings)
        no_text_warnings.append("没有可用于提取的文字资料，因此**未调用模型**（避免用模型编造字段）。")
        fields = {"reference_files": list(material.files)} if material.files else {}
        summary = build_source_summary(
            source_type=normalized,
            material=material,
            extraction_status=STATUS_NO_TEXT,
            llm_called=False,
        )
        return _build_read(
            fields=fields,
            base_fields=base_fields,
            warnings=no_text_warnings,
            source_summary=summary,
            note=NOTE_NO_TEXT,
        )

    target, target_warning = await _try_resolve_target(db, needed=llm_caller is None)

    # ---- 演练模式（且没有注入替身 caller）：一次都不调，字段全空 ----
    # 注入 caller 优先于演练占位：那是测试/嵌入式替身，不触网、不产生费用（与
    # llm_orchestration/entity_extraction.py 同一口径）。
    if llm_caller is None and dry_run.dry_run_enabled():
        dry_warnings = [dry_run_warning(skill="商品资料提取"), *material.warnings]
        if target_warning:
            dry_warnings.append(target_warning)
        fields = {"reference_files": list(material.files)} if material.files else {}
        summary = build_source_summary(
            source_type=normalized,
            material=material,
            extraction_status=STATUS_DRY_RUN,
            llm_called=False,
            fields_extracted=[],
        )
        return _build_read(
            fields=fields,
            base_fields=base_fields,
            warnings=dry_warnings,
            source_summary=summary,
            note=NOTE_DRY_RUN,
        )

    # ---- 真实（或注入替身）路径：**唯一一次付费调用** ----
    prompt = build_product_card_prompt(
        source_type=normalized,
        source_text=material.text,
        extra_instructions=extra_instructions,
    )
    latency_ms: int | None = None
    if llm_caller is not None:
        raw_text = await llm_caller(prompt)
    else:
        if target is None:  # pragma: no cover - dry_run 关闭时 _try_resolve_target 必然抛出
            target, _ = await _try_resolve_target(db, needed=True)
        try:
            completion = await call_text_llm(prompt, target=target)
        except LLMRequestError as exc:
            raise_llm_failure(exc)
            raise  # pragma: no cover - raise_llm_failure 一定抛异常
        raw_text = completion.text
        latency_ms = completion.latency_ms

    fields, field_warnings, _repairs = parse_extracted_fields(raw_text)
    # 参考文件不来自模型：它是本次上传的归档结果（模型也无权决定归档什么）。
    if material.files:
        fields["reference_files"] = list(material.files)

    warnings = [*field_warnings, *material.warnings]
    if target_warning:
        warnings.append(target_warning)
    summary = build_source_summary(
        source_type=normalized,
        material=material,
        extraction_status=STATUS_EXTRACTED,
        llm_called=True,
        model=target,
        raw_output_chars=len(raw_text),
        fields_extracted=[key for key in EXTRACTABLE_CARD_FIELDS if fields.get(key)],
        latency_ms=latency_ms,
    )
    return _build_read(
        fields=fields,
        base_fields=base_fields,
        warnings=warnings,
        source_summary=summary,
        note=NOTE_EXTRACTED,
    )


__all__ = [
    "EXTRACTABLE_CARD_FIELDS",
    "IMAGE_EXTENSIONS",
    "NOTE_EXISTING",
    "NOTE_EXTRACTED",
    "SOURCE_TYPES",
    "SourceMaterial",
    "build_product_card_prompt",
    "build_source_summary",
    "coerce_extracted_fields",
    "collect_existing_material",
    "collect_paste_material",
    "collect_upload_material",
    "extract_product_card",
    "parse_extracted_fields",
    "read_reference_bytes",
]
