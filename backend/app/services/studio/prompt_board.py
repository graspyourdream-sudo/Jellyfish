"""集级「视频提示词看板」：进入分镜工作台**之前**的批量生成 / 批量导入 / 统一确认。

用户流程修正（2026-09-19）：一整集的视频提示词（7~20 条）应当**一次生成或一次导入**、
统一预览校对后确认，再进工作台做绑定与生成；工作台只保留"单镜补漏"。
因此本模块是第 4 步的**服务端主干**，工作台里的面板降级为补漏入口。

三条硬约束（都是用户明确要求的）：
1. **默认只补空白**：覆盖模式三选一，默认 ``fill_empty``；任何模式都不会静默覆盖已有内容。
2. **导入先预览再落库**：``parse_import`` 只解析与匹配（返回逐条匹配状态与冲突），保存要另调一次。
3. **模板/演练不得冒充大模型**：``generate_entries`` 只有在后端 ``meta.llm_called is True``
   时才写 ``video_prompt_source='llm'``；演练模式返回草稿但**不落库**，并把原因说清楚。
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.studio import Shot, ShotDetail
from app.schemas.studio.shots import ShotDetailUpdate
from app.services.studio import shot_details as shot_details_service
from app.services.studio.llm_orchestration import dry_run
from app.services.studio.llm_orchestration.video_prompt import preview_video_prompt
from app.schemas.studio.llm_orchestration import VideoPromptPreviewRequest
from app.services.studio.product_guardrails import SAVABLE_VIDEO_PROMPT_SOURCES

# 覆盖模式：**只保留两个**（用户 2026-09-19 修正）。
# 为什么删掉"跳过已确认"：系统当前没有可靠的"已确认"状态，它与"只填充空白"行为完全相同；
# 更不能用来源字段猜确认状态（把 internal / shot_description 自动当成"用户已确认"是错的）。
# 等真正的草稿/已确认状态落地后，再把这个选项加回来。
OverwriteMode = Literal["fill_empty", "overwrite_selected"]

#: 演练占位标记（与 llm_orchestration/dry_run 的占位文案一致）
_PLACEHOLDER_MARKERS: tuple[str, ...] = ("[DRY_RUN 占位]", "[DRY_RUN]")

#: 草稿签名密钥的环境变量名
DRAFT_SECRET_ENV = "JELLYFISH_PROMPT_DRAFT_SECRET"
#: 运行环境标识（production/prod/staging 时密钥必须来自环境变量）
RUNTIME_ENV_ENV = "JELLYFISH_ENV"

#: 写入口允许的来源（与 product_guardrails 保持一份口径）
ALLOWED_SOURCES: tuple[str, ...] = tuple(SAVABLE_VIDEO_PROMPT_SOURCES)
MODE_FILL_EMPTY: OverwriteMode = "fill_empty"
MODE_OVERWRITE_SELECTED: OverwriteMode = "overwrite_selected"

#: 导入时的来源标记（巨日禄）
JURILU_SOURCE = "jurilu"
#: 其它外部平台批量导入
EXTERNAL_IMPORT_SOURCE = "external_import"
#: 大模型批量生成的来源标记
LLM_SOURCE = "llm"
#: 工作台人工修改
MANUAL_SOURCE = "manual"

#: **来源由流程决定**（用户要求）：前端只能说明"这批内容是哪种流程来的"，
#: 由服务端映射成真实 source，避免把普通导入内容标成 llm。
ORIGIN_TO_SOURCE: dict[str, str] = {
    "llm_draft": LLM_SOURCE,
    "jurilu_import": JURILU_SOURCE,
    "external_import": EXTERNAL_IMPORT_SOURCE,
    "manual": MANUAL_SOURCE,
}
#: 允许的流程来源
BoardOrigin = Literal["llm_draft", "jurilu_import", "external_import", "manual"]

# 形如 "S001"、"#12"、"12."、"12、"、"12:" 的编号
_NUMBER_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"^\s*[Ss]\s*0*(\d{1,3})\s*[\.、:：\)]?\s*(.*)$"),
    re.compile(r"^\s*#\s*0*(\d{1,3})\s*[\.、:：\)]?\s*(.*)$"),
    re.compile(r"^\s*(\d{1,3})\s*[\.、:：\)]\s*(.*)$"),
)


@dataclass(slots=True)
class BoardShot:
    """看板上的一行镜头。"""

    shot_id: str
    index: int
    code: str
    title: str
    script_excerpt: str
    video_prompt: str
    video_prompt_source: str

    @property
    def has_prompt(self) -> bool:
        return bool(self.video_prompt.strip())

    @property
    def is_confirmed(self) -> bool:
        """是否"用户已确认"。

        当前**没有**可靠的确认状态（没有草稿/已确认列），因此这里只说"已有内容且来源合法"，
        不声称"已确认"；等确认状态落地后再改成读真实字段。
        """
        return self.has_prompt and self.video_prompt_source.strip().lower() in ALLOWED_SOURCES

    def to_read(self) -> dict[str, Any]:
        return {
            "shot_id": self.shot_id,
            "index": self.index,
            "code": self.code,
            "title": self.title,
            "script_excerpt": self.script_excerpt,
            "video_prompt": self.video_prompt,
            "video_prompt_source": self.video_prompt_source,
            "has_prompt": self.has_prompt,
        }


@dataclass(slots=True)
class ImportEntry:
    """一条待导入的提示词（解析结果）。"""

    number: int | None
    prompt: str
    shot_id: str = ""
    matched_by: str = ""  # number / order / manual / none
    status: str = "unmatched"  # ok / unmatched / duplicate / conflict
    message: str = ""

    def to_read(self) -> dict[str, Any]:
        return {
            "number": self.number,
            "prompt": self.prompt,
            "shot_id": self.shot_id,
            "matched_by": self.matched_by,
            "status": self.status,
            "message": self.message,
        }


@dataclass(slots=True)
class ImportPreview:
    entries: list[ImportEntry] = field(default_factory=list)
    issues: list[str] = field(default_factory=list)
    #: 默认口径是否允许整体保存（数量不一致 / 无法匹配 / 编号重复 → False）
    save_allowed: bool = False
    #: 是否数量不一致（前端据此提示"可切换为仅保存已匹配项"）
    count_mismatch: bool = False
    #: 用户显式降级为"仅保存已匹配项"时是否允许（无重复且至少有一条匹配成功）
    matched_only_save_allowed: bool = False

    def to_read(self) -> dict[str, Any]:
        return {
            "entries": [item.to_read() for item in self.entries],
            "issues": list(self.issues),
            "save_allowed": self.save_allowed,
            "count_mismatch": self.count_mismatch,
            "matched_only_save_allowed": self.matched_only_save_allowed,
            "summary": {
                "total": len(self.entries),
                "ok": len([item for item in self.entries if item.status == "ok"]),
                "unmatched": len([item for item in self.entries if item.status != "ok"]),
            },
        }


def draft_signing_key() -> bytes:
    """草稿令牌的签名密钥。

    优先用 ``JELLYFISH_PROMPT_DRAFT_SECRET``；没配时用数据库位置派生一个**部署内稳定**的随机盐
    （首次调用即固定下来，写在 backend/.prompt_draft_secret）。不把默认值写死在代码里，
    避免"任何人都能算出令牌"。
    """
    # ① 生产/预发：**必须**从环境变量读取（缺失直接拒绝服务，不静默退化）
    raw = (os.environ.get(DRAFT_SECRET_ENV) or "").strip()
    if raw:
        return raw.encode("utf-8")
    env_name = (os.environ.get(RUNTIME_ENV_ENV) or "").strip().lower()
    if env_name in {"production", "prod", "staging"}:
        raise RuntimeError(
            f"{RUNTIME_ENV_ENV}={env_name} 时必须通过环境变量 {DRAFT_SECRET_ENV} 提供草稿签名密钥；"
            "拒绝使用本地文件或进程内密钥。"
        )
    # ② 本地开发：密钥落在**已被 .gitignore 忽略**的运行数据目录里（backend/storage/），
    #    不再放在仓库根附近，避免误提交。
    secret_file = _dev_secret_path()
    try:
        if secret_file.exists():
            value = secret_file.read_bytes().strip()
            if value:
                return value
        value = secrets.token_urlsafe(48).encode("utf-8")
        secret_file.parent.mkdir(parents=True, exist_ok=True)
        secret_file.write_bytes(value)
        try:
            os.chmod(secret_file, 0o600)
        except OSError:
            pass
        return value
    except OSError:
        # 只读环境：退化为进程内密钥（重启后旧草稿需重新生成；安全口径不变）
        return secrets.token_urlsafe(48).encode("utf-8")


def _dev_secret_path() -> Path:
    """本地开发密钥文件路径：运行数据目录（已被 .gitignore 忽略）。"""
    return Path(__file__).resolve().parents[3] / "storage" / ".prompt_draft_secret"


def draft_token(*, shot_id: str, prompt: str) -> str:
    """大模型草稿令牌：``HMAC-SHA256(密钥, 镜头|<提示词>)``。

    为什么不是普通 sha1：sha1 谁都能算 —— 手工粘贴的内容也能自己算出一个"合法"令牌，
    等于没有校验。这里用服务端密钥签名（密钥不进代码、不进响应），保存时声明
    ``origin=llm_draft`` 必须带令牌，否则拒写。
    """
    message = f"{shot_id}|{prompt}".encode("utf-8")
    return hmac.new(draft_signing_key(), message, hashlib.sha256).hexdigest()


def draft_token_matches(*, shot_id: str, prompt: str, token: str) -> bool:
    """常数时间比较（避免通过时间差猜令牌）。"""
    expected = draft_token(shot_id=shot_id, prompt=prompt)
    return hmac.compare_digest(expected, str(token or "").strip())


def shot_code(index: int) -> str:
    """镜头编号口径与交付导出一致：``S%03d``。"""
    return f"S{int(index or 0):03d}"


async def load_board(db: AsyncSession, *, chapter_id: str) -> list[BoardShot]:
    """取该集全部镜头（按集内顺序），带当前视频提示词与来源。"""
    rows = (
        await db.execute(
            select(
                Shot.id,
                Shot.index,
                Shot.title,
                Shot.script_excerpt,
                ShotDetail.video_prompt,
                ShotDetail.video_prompt_source,
            )
            .outerjoin(ShotDetail, ShotDetail.id == Shot.id)
            .where(Shot.chapter_id == chapter_id)
            .order_by(Shot.index.asc())
        )
    ).all()
    return [
        BoardShot(
            shot_id=str(row[0]),
            index=int(row[1] or 0),
            code=shot_code(int(row[1] or 0)),
            title=str(row[2] or ""),
            script_excerpt=str(row[3] or ""),
            video_prompt=str(row[4] or ""),
            video_prompt_source=str(row[5] or ""),
        )
        for row in rows
    ]


def split_import_text(text: str) -> list[tuple[int | None, str]]:
    """把整段粘贴文本切成 "（编号, 正文）" 列表。

    切分规则（对巨日禄/表格/纯段落三种常见形态都成立）：
    - 先按"编号开头"切块（``S001`` / ``#12`` / ``12.`` / ``12、``）；
    - 没有编号的行……按空行分块（一块一条）；
    - 同一块里后续行都算这条提示词的正文（多行提示词不会被切碎）。
    """
    raw = str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return []

    blocks: list[tuple[int | None, list[str]]] = []
    current_number: int | None = None
    current_lines: list[str] = []

    def flush() -> None:
        nonlocal current_number, current_lines
        body = "\n".join(line for line in current_lines).strip()
        if body or current_number is not None:
            blocks.append((current_number, current_lines[:]))
        current_number, current_lines = None, []

    for line in raw.split("\n"):
        matched_number: int | None = None
        rest = line
        for pattern in _NUMBER_PATTERNS:
            m = pattern.match(line)
            if m:
                matched_number = int(m.group(1))
                rest = m.group(2)
                break
        if matched_number is not None:
            flush()
            current_number = matched_number
            current_lines = [rest] if rest.strip() else []
            continue
        if not line.strip():
            # 空行：若有编号则作为块边界；纯段落模式也以空行分块
            flush()
            continue
        current_lines.append(line)

    flush()
    result: list[tuple[int | None, str]] = []
    for number, lines in blocks:
        body = "\n".join(lines).strip()
        if body:
            result.append((number, body))
    return result


def match_import_entries(text: str, shots: list[BoardShot]) -> ImportPreview:
    """解析 + 匹配：返回逐条匹配状态与冲突（**不落库**，供预览）。"""
    parsed = split_import_text(text)
    preview = ImportPreview()
    if not shots:
        preview.issues.append("该集还没有镜头，无法导入。")
        return preview
    if not parsed:
        preview.issues.append("没有解析出任何提示词，请检查粘贴内容或文件格式。")
        return preview

    by_number: dict[int, BoardShot] = {shot.index: shot for shot in shots}
    by_code: dict[str, BoardShot] = {shot.code.upper(): shot for shot in shots}
    used_shot_ids: set[str] = set()
    seen_numbers: dict[int, int] = {}

    # 先按编号匹配（编号即集内镜头序号，或 S001 形式的镜头编号）
    entries: list[ImportEntry] = []
    numbered_only = [item for item in parsed if item[0] is not None]
    for number, prompt in parsed:
        entry = ImportEntry(number=number, prompt=prompt)
        if number is not None:
            seen_numbers[number] = seen_numbers.get(number, 0) + 1
            shot = by_number.get(number) or by_code.get(f"S{number:03d}")
            if shot is None:
                entry.status = "unmatched"
                entry.message = f"编号 {number} 在本集里找不到对应镜头。"
            elif shot.shot_id in used_shot_ids:
                entry.status = "duplicate"
                entry.message = f"编号 {number} 重复，前一条已经占了镜头 {shot.code}。"
            else:
                entry.shot_id = shot.shot_id
                entry.matched_by = "number"
                entry.status = "ok"
                used_shot_ids.add(shot.shot_id)
        entries.append(entry)

    # 再按顺序补齐没编号的条目（只补还没被占用的镜头）
    if len(numbered_only) < len(entries):
        free_shots = [shot for shot in shots if shot.shot_id not in used_shot_ids]
        cursor = 0
        for entry in entries:
            if entry.number is not None:
                continue
            if cursor < len(free_shots):
                shot = free_shots[cursor]
                cursor += 1
                entry.shot_id = shot.shot_id
                entry.matched_by = "order"
                entry.status = "ok"
                used_shot_ids.add(shot.shot_id)
            else:
                entry.status = "unmatched"
                entry.message = "没有可匹配的剩余镜头（提示词条数多于镜头数）。"

    duplicates = [number for number, count in seen_numbers.items() if count > 1]
    if duplicates:
        preview.issues.append(f"编号重复：{[f'S{n:03d}' for n in sorted(duplicates)]}（请合并或删除重复条目）。")
    unmatched = [item for item in entries if item.status != "ok"]
    if unmatched:
        preview.issues.append(f"有 {len(unmatched)} 条无法匹配到镜头，已阻止一键保存。")
    count_mismatch = len(entries) != len(shots)
    if count_mismatch:
        preview.issues.append(
            f"数量不一致：解析出 {len(entries)} 条，本集有 {len(shots)} 个镜头"
            "（顺序匹配只补空位，不会错位覆盖已匹配的镜头）。"
            "默认**阻止整体保存**；确需只保存已匹配项请显式切换为「仅保存已匹配项」。"
        )

    preview.entries = entries
    preview.count_mismatch = count_mismatch
    # 默认口径：只要数量不一致或存在无法匹配/重复，一律不允许保存
    preview.save_allowed = (not unmatched) and (not duplicates) and (not count_mismatch)
    # 允许用户显式降级为"只保存已匹配项"（对应 save 接口的 allow_partial）
    preview.matched_only_save_allowed = (not duplicates) and bool([item for item in entries if item.status == "ok"])
    return preview


def resolve_mode_action(shot: BoardShot, mode: OverwriteMode, *, selected: bool = True) -> tuple[bool, str]:
    """按覆盖模式判断这一镜该不该写；返回 ``(是否写入, 说明)``。"""
    if mode == MODE_OVERWRITE_SELECTED:
        if not selected:
            return False, "未被选中：按「只覆盖选中镜头」跳过。"
        return True, ""
    # 默认：只填充空白镜头
    if shot.has_prompt:
        return False, "已有提示词：默认「只填充空白镜头」，未覆盖。"
    return True, ""


async def save_entries(
    db: AsyncSession,
    *,
    chapter_id: str,
    entries: list[dict[str, Any]],
    mode: OverwriteMode = MODE_FILL_EMPTY,
    origin: str = "",
    selected_shot_ids: list[str] | None = None,
    allow_partial: bool = False,
) -> dict[str, Any]:
    """把（已确认的）条目批量写回镜头提示词。

    逐条按 ``mode`` 判定，返回每条的结果；**不做任何静默覆盖**。
    """
    board = await load_board(db, chapter_id=chapter_id)
    by_id = {shot.shot_id: shot for shot in board}
    selected = set(selected_shot_ids or [])
    targets = [str(item.get("shot_id") or "").strip() for item in (entries or [])]

    # 同一个镜头被写两次 = 错位/覆盖的典型征兆，直接拒绝（用户要求"不能错位写入"）。
    duplicated_targets = sorted({item for item in targets if item and targets.count(item) > 1})
    if duplicated_targets:
        return {
            "chapter_id": chapter_id,
            "mode": mode,
            "origin": origin,
            "applied_count": 0,
            "skipped_count": len(entries or []),
            "results": [],
            "error": f"有镜头被重复指定：{duplicated_targets}，已拒绝保存。",
        }
    # 数量不一致且未显式允许部分保存 → 拒绝（默认不做"能写几条算几条"）
    if len(entries or []) != len(board) and not allow_partial:
        return {
            "chapter_id": chapter_id,
            "mode": mode,
            "origin": origin,
            "applied_count": 0,
            "skipped_count": len(entries or []),
            "results": [],
            "error": (
                f"数量不一致：提交 {len(entries or [])} 条，本集 {len(board)} 个镜头；"
                "已按默认口径阻止保存。若确实只想保存已匹配项，请显式选择「仅保存已匹配项」。"
            ),
        }

    results: list[dict[str, Any]] = []
    applied = 0

    resolved_source = ORIGIN_TO_SOURCE.get(str(origin or "").strip(), "")
    if not resolved_source:
        return {
            "chapter_id": chapter_id,
            "mode": mode,
            "applied_count": 0,
            "skipped_count": len(entries or []),
            "results": [],
            "error": (
                "缺少合法的流程来源（origin）：只接受 llm_draft / jurilu_import / "
                "external_import / manual。来源由流程决定，不能由调用方随意指定 source。"
            ),
        }

    for item in entries or []:
        shot_id = str(item.get("shot_id") or "").strip()
        prompt = str(item.get("prompt") or "").strip()
        shot = by_id.get(shot_id)
        if shot is None:
            results.append({"shot_id": shot_id, "applied": False, "reason": "镜头不属于本集。", "code": ""})
            continue
        if not prompt:
            results.append({"shot_id": shot_id, "applied": False, "reason": "提示词为空。", "code": shot.code})
            continue
        # 流程来源与内容自证：声明 llm_draft 的条目必须带**由后端签发的草稿令牌**
        # （sha1(镜头|提示词)）。这样"把手工粘贴的内容标成 llm"会被直接拒绝。
        if resolved_source == LLM_SOURCE:
            if not draft_token_matches(
                shot_id=shot.shot_id,
                prompt=prompt,
                token=str(item.get("draft_token") or ""),
            ):
                results.append(
                    {
                        "shot_id": shot_id,
                        "applied": False,
                        "code": shot.code,
                        "reason": "缺少有效的大模型草稿令牌：不能把非生成内容按「大模型生成」保存。",
                    }
                )
                continue

        # 演练/占位内容绝不能存成正式提示词：逐条拒绝并说明，而不是让整批 422 崩掉
        if any(marker in prompt for marker in _PLACEHOLDER_MARKERS):
            results.append(
                {
                    "shot_id": shot_id,
                    "applied": False,
                    "code": shot.code,
                    "reason": "内容是演练占位文本，不能保存为正式提示词。",
                }
            )
            continue

        should_write, reason = resolve_mode_action(
            shot,
            mode,
            selected=(not selected) or shot.shot_id in selected,
        )
        if not should_write:
            results.append({"shot_id": shot_id, "applied": False, "reason": reason, "code": shot.code})
            continue
        await shot_details_service.update(
            db,
            shot_id=shot.shot_id,
            body=ShotDetailUpdate(video_prompt=prompt, video_prompt_source=resolved_source),
        )
        applied += 1
        results.append({"shot_id": shot_id, "applied": True, "reason": "已写入", "code": shot.code})

    await db.commit()
    return {
        "chapter_id": chapter_id,
        "mode": mode,
        "origin": origin,
        "source": resolved_source,
        "applied_count": applied,
        "skipped_count": len(results) - applied,
        "results": results,
    }


async def generate_draft(
    db: AsyncSession,
    *,
    chapter_id: str,
    shot_id: str,
    mode: OverwriteMode = MODE_FILL_EMPTY,
) -> dict[str, Any]:
    """**单镜**生成一条视频提示词草稿（**不落库**），供页面维护逐镜队列。

    为什么按"一次一镜"设计（用户 2026-09-19 修正）：
    如果后端在一个请求里循环调用全部镜头，用户点"停止"也拦不住后面已经排队的付费调用。
    改成页面逐镜请求：请求之间是用户可中断的边界 —— 点停止就不再发下一镜，
    已完成的草稿留在预览表里，失败项可以单独重试。不引入任何异步任务系统。
    """
    board = await load_board(db, chapter_id=chapter_id)
    shot = next((item for item in board if item.shot_id == shot_id), None)
    if shot is None:
        return {"shot_id": shot_id, "status": "error", "reason": "镜头不属于本集。"}

    should_write, reason = resolve_mode_action(shot, mode)
    if not should_write:
        return {"shot_id": shot_id, "code": shot.code, "status": "skipped", "reason": reason}

    preview = await preview_video_prompt(db, body=VideoPromptPreviewRequest(shot_id=shot.shot_id))
    llm_called = bool(getattr(preview.meta, "llm_called", False))
    prompt = str(preview.final_prompt or "").strip()
    if dry_run.dry_run_enabled() or not llm_called:
        return {
            "shot_id": shot_id,
            "code": shot.code,
            "status": "dry_run",
            "prompt": prompt,
            "reason": "演练模式：后端未真实调用大模型；这是占位草稿，不能保存。",
        }
    if not prompt:
        return {"shot_id": shot_id, "code": shot.code, "status": "failed", "reason": "生成结果为空。"}
    return {
        "shot_id": shot_id,
        "code": shot.code,
        "status": "draft",
        "prompt": prompt,
        "llm_called": True,
        "latency_ms": getattr(preview.meta, "latency_ms", None),
        "warnings": list(preview.warnings or []),
        # 后端签发的草稿令牌：保存时声明 llm_draft 必须带上它
        "draft_token": draft_token(shot_id=shot.shot_id, prompt=prompt),
    }


async def load_readiness(
    db: AsyncSession,
    *,
    chapter_id: str,
    reference_mode: str = "first",
) -> dict[str, Any]:
    """集级**就绪**批量读取（一次查询，不调模型、不触网）。

    为什么必须有它：顶部三态、第一个未完成镜头定位、生产卡按钮如果各自"猜"（比如把
    required frames 传空、planReady 固定 true），就会把缺首帧的镜头误判成可生成。
    这里一次性把每镜的**真实**输入读出来交给前端那唯一一个判定函数：

    - 提示词：正文 + 来源（导出就绪只认这个）；
    - 绑定：图片资产的可用文件数 + 声音状态（绑定 / 无需声音 / 缺）；
    - 参考帧：当前参考模式要求的帧类型 vs 真正有 file_id 的帧类型。
    """
    from app.models.studio import ShotFrameImage
    from app.services.studio.bound_asset_files import resolve_bound_files_for_shots
    from app.services.studio.shot_video_readiness import REQUIRED_FRAMES_BY_MODE

    board = await load_board(db, chapter_id=chapter_id)
    shot_ids = [shot.shot_id for shot in board]
    if not shot_ids:
        return {"chapter_id": chapter_id, "reference_mode": reference_mode, "rows": [], "summary": {"total": 0}}

    frames = (
        await db.execute(
            select(ShotFrameImage.shot_detail_id, ShotFrameImage.frame_type, ShotFrameImage.file_id).where(
                ShotFrameImage.shot_detail_id.in_(shot_ids)
            )
        )
    ).all()
    frames_by_shot: dict[str, dict[str, str]] = {}
    for shot_detail_id, frame_type, file_id in frames:
        key = str(frame_type.value if hasattr(frame_type, "value") else frame_type)
        frames_by_shot.setdefault(str(shot_detail_id), {})[key] = str(file_id or "")

    bound = await resolve_bound_files_for_shots(db, shot_ids=shot_ids)

    details = (
        await db.execute(
            select(ShotDetail.id, ShotDetail.audio_file_id, ShotDetail.audio_opt_out).where(
                ShotDetail.id.in_(shot_ids)
            )
        )
    ).all()
    audio_by_shot = {
        str(row[0]): {"file_id": str(row[1] or ""), "opt_out": bool(row[2])} for row in details
    }

    required = [
        str(item.value if hasattr(item, "value") else item)
        for item in REQUIRED_FRAMES_BY_MODE.get(reference_mode, ())
    ]

    # 参考帧是否可用必须按**供应商口径**判定（与计划预检、提交前校验同一份实现）：
    # "槽位里有 file_id" 只代表"已上传"；本机存储的帧对 APIMart 依然取不到
    # （只能变成本机 data URL，而它只接受 http(s):// / asset://）。此前这里拿 file_id
    # 有无当可用，于是页面显示"可生成"、真实提交才 400 —— 就是这条判定错误。
    from app.utils.files import resolve_vendor_image_ref

    video_vendor = await _resolve_video_vendor(db)
    frame_outcomes: dict[str, dict[str, Any]] = {}
    for shot_detail_id, frame_map in frames_by_shot.items():
        frame_outcomes[shot_detail_id] = {
            frame_type: await resolve_vendor_image_ref(db, file_id=file_id, vendor=video_vendor)
            for frame_type, file_id in frame_map.items()
        }

    rows: list[dict[str, Any]] = []
    for shot in board:
        shot_frames = frames_by_shot.get(shot.shot_id, {})
        outcomes = frame_outcomes.get(shot.shot_id, {})
        usable_frames = [
            frame
            for frame in required
            if shot_frames.get(frame) and bool(getattr(outcomes.get(frame), "vendor_usable", False))
        ]
        # 有 file_id 但供应商取不到：单列一类，页面说的是"帧已存在但供应商无法访问"，不是"缺帧"
        unusable_frames = [
            frame
            for frame in required
            if shot_frames.get(frame) and not bool(getattr(outcomes.get(frame), "vendor_usable", False))
        ]
        absent_frames = [frame for frame in required if not shot_frames.get(frame)]
        files = [item.to_read() for item in bound.get(shot.shot_id, [])]
        image_files = [item for item in files if str(item.get("slot")) != "audio"]
        audio = audio_by_shot.get(shot.shot_id, {"file_id": "", "opt_out": False})
        rows.append(
            {
                "shot_id": shot.shot_id,
                "code": shot.code,
                "index": shot.index,
                "title": shot.title,
                "has_prompt": shot.has_prompt,
                "video_prompt": shot.video_prompt,
                "video_prompt_source": shot.video_prompt_source,
                "bound_image_total": len(image_files),
                "bound_image_usable": len([item for item in image_files if item.get("usable")]),
                "bound_image_missing_names": [
                    str(item.get("asset_name") or item.get("asset_id")) for item in image_files if not item.get("usable")
                ],
                "audio_file_id": audio["file_id"],
                "audio_opt_out": audio["opt_out"],
                "required_frame_types": required,
                "usable_frame_types": usable_frames,
                # 「缺帧」（槽位没有 file_id）
                "missing_frame_types": absent_frames,
                # 「帧已存在但供应商无法访问」（本地地址只能变 data URL 等）
                "unusable_frame_types": unusable_frames,
                "frame_block_reasons": [
                    str(
                        getattr(outcomes.get(frame), "reason", "")
                        or f"参考帧「{frame}」供应商无法访问。"
                    )
                    for frame in unusable_frames
                ]
                + [f"缺少参考帧：{frame}（该帧槽位还没有文件）" for frame in absent_frames],
                # 生成阻断 = 缺帧 ∪ 帧不可用（非 text_only 模式）
                "generation_blocked": bool(absent_frames or unusable_frames) and reference_mode != "text_only",
            }
        )

    return {
        "chapter_id": chapter_id,
        "reference_mode": reference_mode,
        "rows": rows,
        "summary": {
            "total": len(rows),
            "with_prompt": len([row for row in rows if row["has_prompt"]]),
            # 「帧就绪」按供应商口径：缺帧或帧取不到都不算就绪
            "frames_ready": len([row for row in rows if not row["generation_blocked"]]),
            "frames_missing": len([row for row in rows if row["missing_frame_types"]]),
            "frames_unusable": len([row for row in rows if row["unusable_frame_types"]]),
        },
    }


async def _resolve_video_vendor(db: AsyncSession) -> str:
    """当前固定视频模型背后的供应商（就绪判定与计划/提交必须用同一家）。"""
    try:
        from app.services.film import load_provider_config_by_model
        from app.services.studio.image_pipeline.video_submit import resolve_pinned_video_model

        model, _warnings = await resolve_pinned_video_model(db)
        config = await load_provider_config_by_model(db, model)
        vendor = str(getattr(config, "provider", "") or "").strip().lower()
        return vendor or "apimart"
    except Exception:  # noqa: BLE001 - 取不到就按固定策略的 APIMart 处理（收敛而不是放松）
        return "apimart"


__all__ = [
    "load_readiness",
    "ALLOWED_SOURCES",
    "BoardShot",
    "EXTERNAL_IMPORT_SOURCE",
    "ImportEntry",
    "ImportPreview",
    "JURILU_SOURCE",
    "LLM_SOURCE",
    "MANUAL_SOURCE",
    "MODE_FILL_EMPTY",
    "MODE_OVERWRITE_SELECTED",
    "ORIGIN_TO_SOURCE",
    "draft_token",
    "generate_draft",
    "load_board",
    "match_import_entries",
    "resolve_mode_action",
    "save_entries",
    "shot_code",
    "split_import_text",
]
