"""第 2 步「资产准备」的数据源：**基于本章完整剧本 + 分镜**生成规范化资产清单。

要解决的问题（一条数据链路，不是页面补丁）
==========================================

原先这一段的真实链路是：

    /script-processing/extract（按镜头提取）
      → shot_extracted_candidates（payload 只留 id/file_id/thumbnail/description）
      → 人工逐条确认 → characters/scenes/props/costumes.description（常常是空）
      → /studio/llm/image-prompt/preview 只读 description
      → 画像卡兜底成「外观信息不足，需人工补充」，并被要求**逐字**写进提示词

所以图片提示词拿不到剧本里的资产资料，不是页面少画了东西，而是**中间三层都把资料丢了**。

本模块补的就是中间这一层，并且**复用上游"整集剧本分析"的能力而不是另造一套**：

- 文本模型调用走既有编排层 ``llm_orchestration.client``（``resolve_text_llm_target`` +
  ``call_text_llm``，含 DRY_RUN 守卫），**不新建 Provider、不新建 client**；
- 章节原文读既有 ``llm_orchestration.context.load_chapter_source``；
- 候选聚合复用既有 ``chapter_asset_candidates.build_chapter_asset_candidates``
  （类型 + 归一化名称聚合、别名收集、已有同名资产检测）；
- 结构化字段规格来自 ``asset_profiles``（四类资产各一套），术语表与上游四个
  "信息缺失分析" agent（人物画像 / 场景 / 道具 / 服装）保持一致；
- 存在性判定复用既有 ``entity_existence.check_names_existence``。

产出结构（**用户主流程**与**技术详情**分开，前端默认收起后者）：

- ``user_flow``：一行一个资产 —— 类型、规范名、别名、结构化资料、缺什么、
  出场镜头与剧本原文依据、建议动作（新建 / 选用已有）、是否需要人工处理及原因；
- ``technical_detail``：原始候选、聚合组、内部匹配状态、别名合并过程、
  被丢弃的模型条目、大模型调用元信息。

**本模块只读 + 只预览，不建资产、不写库。** 确认动作在
``chapter_asset_profile_confirm`` 里，一事务内建/绑资产并保留全部来源证据。
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.studio import Chapter, Shot
from app.services.common import entity_not_found
from app.services.studio.asset_profiles import (
    ASSET_TYPES,
    all_asset_type_schemas_for_prompt,
    field_specs,
    normalize_asset_type,
    normalize_profile,
    profile_completeness,
    profile_missing_fields,
    render_profile_text,
    type_label,
)
from app.services.studio.chapter_asset_candidates import (
    build_chapter_asset_candidates,
)
from app.services.studio.chapter_asset_profile_cache import (
    build_chapter_profile_cache_key,
    get_cached_chapter_profile,
    set_cached_chapter_profile,
)
from app.services.studio.entity_existence import check_names_existence
from app.services.studio.llm_orchestration import dry_run
from app.services.studio.llm_orchestration.client import (
    LLMRequestError,
    TextLLMCaller,
    TextLLMTarget,
    call_text_llm,
    resolve_text_llm_target,
)
from app.services.studio.llm_orchestration.context import load_chapter_source
from app.services.studio.llm_orchestration.json_utils import (
    JSONParseError,
    coerce_str,
    coerce_str_list,
    normalize_name,
    parse_json_object_with_repairs,
)
from app.services.studio.llm_orchestration.prompt_templates import CHAPTER_ASSET_PROFILE_TEMPLATE
from app.services.studio.llm_orchestration.support import build_run_meta, dry_run_warning

#: 参与本流程的资产类型（与候选类型一致）
CANDIDATE_TYPES: tuple[str, ...] = ASSET_TYPES

#: 出场镜头依据里，每段剧本原文保留的字符数上限（脱敏/控体积）
MAX_EVIDENCE_CHARS = 240
#: 单个资产的出场镜头证据条数上限
MAX_EVIDENCE_SHOTS = 12
#: 一次结构化提取返回的资产条数上限
MAX_ITEMS = 60

PLACEHOLDER_PREFIX = "[DRY_RUN 占位]"


# ---------------------------------------------------------------------------
# 组装 LLM 输入
# ---------------------------------------------------------------------------


def build_shot_list_text(shots: list[dict[str, Any]]) -> str:
    """把本章分镜渲染成提示词里的一段（带镜头 id 与序号，便于回填出场镜头）。"""
    lines: list[str] = []
    for shot in shots:
        excerpt = str(shot.get("script_excerpt") or "").strip() or "（本镜无剧本摘录）"
        lines.append(f"- 镜头 {shot.get('index')}（{shot.get('shot_id')}）｜{shot.get('title') or '未命名'}：{excerpt}")
    return "\n".join(lines) if lines else "（本章还没有分镜；请只依据剧本原文提取资产。）"


def build_candidate_list_text(groups: list[dict[str, Any]]) -> str:
    """把聚合后的候选组渲染出来（**告诉模型"已经有哪些资产"，避免自创新名字**）。"""
    if not groups:
        return "（本章还没有提取候选；请完全依据剧本原文提取。）"
    lines: list[str] = []
    for item in groups:
        aliases = "、".join(item.get("aliases") or []) or "无"
        lines.append(
            f"- [{item.get('candidate_type')}] {item.get('name')}（别名：{aliases}；"
            f"出现镜头数：{item.get('shot_count')}）"
        )
    return "\n".join(lines)


def build_chapter_asset_profile_prompt(
    *,
    chapter_title: str,
    chapter_text: str,
    shot_list_text: str,
    candidate_list_text: str,
    extra_instructions: str = "",
) -> str:
    """构造结构化资产清单的提示词（模板在 ``prompt_templates`` 里，字段表来自 asset_profiles）。"""
    return CHAPTER_ASSET_PROFILE_TEMPLATE.safe_substitute(
        chapter_title=chapter_title or "未命名章节",
        chapter_text=chapter_text,
        shot_list=shot_list_text,
        candidate_list=candidate_list_text,
        field_schemas=all_asset_type_schemas_for_prompt(),
        max_items=str(MAX_ITEMS),
        extra_instructions=str(extra_instructions or "").strip() or "无。",
    )


# ---------------------------------------------------------------------------
# 确定性后处理
# ---------------------------------------------------------------------------


def _clip(text: Any, limit: int = MAX_EVIDENCE_CHARS) -> str:
    value = str(text or "").strip()
    if len(value) <= limit:
        return value
    return value[:limit].rstrip() + "…"


def extract_raw_asset_items(parsed: dict[str, Any]) -> list[dict[str, Any]]:
    """从模型 JSON 里取出资产数组（兼容几种常见顶层写法）。"""
    for key in ("assets", "items", "asset_list", "results"):
        value = parsed.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    for value in parsed.values():
        if isinstance(value, list) and value and all(isinstance(item, dict) for item in value):
            return list(value)
    raise JSONParseError("模型返回的 JSON 里找不到资产数组（assets）。")


def shot_refs_for_name(
    name: str,
    aliases: list[str],
    shots: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """该资产在哪些镜头出现（按归一化名/别名匹配剧本摘录），并带上原文依据。

    ``shot_refs`` 是"哪一段原文、哪个镜头 id/序号"的落地形式 —— 用户要求的
    "保留剧本片段/分镜依据"就是这一份数据，它同时进 ``user_flow``（可读）
    与候选表 ``payload``（可追溯）。
    """
    keys = [normalize_name(name), *(normalize_name(alias) for alias in aliases)]
    keys = [key for key in keys if key]
    refs: list[dict[str, Any]] = []
    for shot in shots:
        haystack = normalize_name(shot.get("script_excerpt") or "")
        matched = next((key for key in keys if key and key in haystack), "")
        if not matched:
            continue
        refs.append(
            {
                "shot_id": str(shot.get("shot_id") or ""),
                "shot_index": int(shot.get("index") or 0),
                "title": str(shot.get("title") or ""),
                "matched": matched,
                "script_excerpt": _clip(shot.get("script_excerpt")),
            }
        )
        if len(refs) >= MAX_EVIDENCE_SHOTS:
            break
    return refs


def _grounded_in_chapter(name: str, aliases: list[str], chapter_haystack: str) -> bool:
    """名称/别名是否能在**本章原文**里找到（不在原文里 = 幻觉，丢弃）。"""
    for value in (name, *aliases):
        key = normalize_name(value)
        if key and key in chapter_haystack:
            return True
    return False


def merge_model_items_into_groups(
    *,
    model_items: list[dict[str, Any]],
    groups: list[dict[str, Any]],
    chapter_haystack: str,
) -> tuple[dict[tuple[str, str], dict[str, Any]], list[dict[str, Any]]]:
    """把模型返回的资产条目并进聚合组；返回 ``(并入结果, 被丢弃的条目)``。

    并入规则（**别名与重复候选在这里合成一组**）：

    1. 归一化名称与某个组的名称/别名一致 → 并进该组（组里的别名集合被扩充）；
    2. 名称在原文里，但不在任何组里 → 建一个新的 ``llm_new`` 组
       （说明提取候选漏了它，不能白丢）；
    3. 名称在**另一类**资产里已经用过同名 → 并入那一组（类型以候选表为准，
       并记一条冲突说明给人工看）；
    4. 名称在原文里找不到，或类型不在四类之内 → 丢弃并给中文原因。

    "保留所有来源证据"体现在：并进同一组的每个模型条目都会在
    ``sources`` 里留下自己的原始名称 + 原始字段，别名集合是并集而不是覆盖。
    """
    by_key: dict[tuple[str, str], dict[str, Any]] = {
        (str(group["candidate_type"]), normalize_name(group["name"])): {
            **group,
            "aliases": list(group.get("aliases") or []),
            "sources": [],
            "model_fields": {},
            "model_names": [],
        }
        for group in groups
    }
    dropped: list[dict[str, Any]] = []

    for raw in model_items:
        name = coerce_str(raw.get("name"))
        if not name:
            dropped.append({"name": "", "asset_type": "", "reason": "模型返回的条目没有 name，已丢弃。"})
            continue
        aliases = [alias for alias in coerce_str_list(raw.get("aliases")) if alias and alias != name]
        asset_type = normalize_asset_type(raw.get("asset_type") or raw.get("type"))
        if asset_type is None:
            dropped.append(
                {
                    "name": name,
                    "asset_type": str(raw.get("asset_type") or raw.get("type") or ""),
                    "reason": (
                        "资产类型不在本次支持范围内（只能是 character/scene/prop/costume），"
                        "已丢弃，不猜类型。"
                    ),
                }
            )
            continue
        if not _grounded_in_chapter(name, aliases, chapter_haystack):
            dropped.append(
                {
                    "name": name,
                    "asset_type": asset_type,
                    "reason": "名称与别名都无法在本章剧本原文中找到（疑似幻觉），已丢弃。",
                }
            )
            continue

        match_key = (asset_type, normalize_name(name))
        entry = by_key.get(match_key)
        if entry is None:
            # 名称对不上，但可能对得上同一类里的某个别名
            for key, candidate in by_key.items():
                if key[0] != asset_type:
                    continue
                alias_keys = {normalize_name(alias) for alias in candidate.get("aliases") or []}
                if normalize_name(name) in alias_keys:
                    entry = candidate
                    break
        if entry is None:
            entry = {
                "candidate_type": asset_type,
                "type_label": type_label(asset_type),
                "name": name,
                # 这一组的别名起点就是模型给的别名（候选表里没有它）
                "aliases": list(aliases),
                "shot_count": 0,
                "shot_ids": [],
                "statuses": {},
                "linked_entity_id": None,
                "existing_asset_id": None,
                "linked_to_project": False,
                "linked_to_shot": False,
                "recommendation": "create_new",
                "source_kind": "llm_new",
                "sources": [],
                "model_fields": {},
                "model_names": [],
            }
            by_key[(asset_type, normalize_name(name))] = entry

        merged_aliases = {str(alias) for alias in (entry.get("aliases") or []) if str(alias).strip()}
        if normalize_name(entry.get("name")) != normalize_name(name):
            merged_aliases.add(name)
        merged_aliases.update(aliases)
        entry["aliases"] = sorted(merged_aliases)
        entry["model_names"] = [*entry.get("model_names", []), name]
        fields = normalize_profile(asset_type, raw.get("fields") or raw.get("profile") or {})
        for key, value in fields.items():
            if value and not entry["model_fields"].get(key):
                entry["model_fields"][key] = value
        entry["sources"].append(
            {
                "name": name,
                "aliases": aliases,
                "asset_type": asset_type,
                "fields": fields,
                "evidence": coerce_str_list(raw.get("evidence")),
                "shot_indexes": [
                    int(index)
                    for index in (raw.get("shot_indexes") or [])
                    if isinstance(index, int) or str(index).isdigit()
                ],
            }
        )

    return by_key, dropped


def _build_user_flow_item(
    *,
    entry: dict[str, Any],
    shots: list[dict[str, Any]],
    chapter_haystack: str,
) -> dict[str, Any]:
    """把聚合组 + 模型字段整理成"用户主流程"里的一行。"""
    asset_type = str(entry["candidate_type"])
    name = str(entry["name"])
    aliases = [str(alias) for alias in entry.get("aliases") or []]
    profile = normalize_profile(asset_type, entry.get("model_fields") or {})
    refs = shot_refs_for_name(name, aliases, shots)

    # 「出场镜头」既是结构化资料的一个字段（给模型/人看），也是证据列表（给追溯用）
    shot_labels = [f"#{ref['shot_index']}" for ref in refs]
    if shot_labels:
        profile["shot_refs"] = "、".join(shot_labels)
    if not profile.get("related_plot"):
        profile["related_plot"] = _clip("；".join(ref["script_excerpt"] for ref in refs[:3]))

    # 模型自己给的原文依据：只保留能在本章原文里逐字找到的（防止拼接出不存在的话）
    evidence: list[dict[str, Any]] = []
    for source in entry.get("sources") or []:
        for snippet in source.get("evidence") or []:
            text = str(snippet or "").strip()
            if not text:
                continue
            grounded = normalize_name(text)[:20] in chapter_haystack if len(normalize_name(text)) >= 6 else True
            evidence.append(
                {
                    "snippet": _clip(text),
                    "grounded": grounded,
                    "from_name": source.get("name") or "",
                }
            )

    missing = profile_missing_fields(asset_type, profile)
    missing_visual = profile_missing_fields(asset_type, profile, visual_only=True)
    return {
        "group_key": f"{asset_type}:{normalize_name(name)}",
        "asset_type": asset_type,
        "type_label": type_label(asset_type),
        "name": name,
        "display_name": (f"{name}（{'、'.join(sorted(set(aliases) - {name}))}）" if aliases else name),
        "aliases": sorted(set(aliases) - {name}),
        "fields": profile,
        "summary": render_profile_text(asset_type, profile),
        "missing_fields": missing,
        "missing_visual_fields": missing_visual,
        "completeness": profile_completeness(asset_type, profile),
        "shot_refs": refs,
        "evidence": evidence,
        "shot_count": max(len(refs), int(entry.get("shot_count") or 0)),
        "source_kind": str(entry.get("source_kind") or "candidate"),
        # ↓ 内部匹配状态（用户主流程只用来决定"要不要人工处理"）
        "existing_asset_id": entry.get("existing_asset_id"),
        "linked_entity_id": entry.get("linked_entity_id"),
        "linked_to_project": bool(entry.get("linked_to_project")),
        "linked_to_shot": bool(entry.get("linked_to_shot")),
        "candidate_recommendation": entry.get("recommendation"),
        "notices": [],
    }


# ---------------------------------------------------------------------------
# 冲突判定
# ---------------------------------------------------------------------------


#: 冲突码 → 中文原因（页面直接展示）
CONFLICT_TYPE_MISMATCH = "same_name_other_type"
CONFLICT_ALIAS_SPLIT = "alias_points_to_two_assets"
CONFLICT_DUPLICATE_NAME = "duplicate_name_across_types"
#: 下面三个是**真正需要人工**的冲突（会挡住自动确认）
CONFLICT_LIBRARY_PROFILE = "library_profile_mismatch"

CONFLICT_LABELS: dict[str, str] = {
    CONFLICT_TYPE_MISMATCH: "库里已有同名资产，但类型与本次判断不同",
    CONFLICT_ALIAS_SPLIT: "这一组的两个别名分别指向库里两个不同资产",
    CONFLICT_DUPLICATE_NAME: "同一章里有两个不同类型的资产用同一个名字",
}

#: 库里同名同类型资产已有描述、但与本章资料**没有一个共同用词** —— 这只是**提示**，
#: 不是冲突：同名同类型本身已经足够安全（会走"选用已有"，且不覆盖任何已有内容），
#: 措辞不同不足以判定"不是同一个资产"。把它升级成冲突只会让"无冲突直接确认"变成空话。
NOTICE_LIBRARY_PROFILE = CONFLICT_LIBRARY_PROFILE

NOTICE_LABELS: dict[str, str] = {
    NOTICE_LIBRARY_PROFILE: (
        "库里已有同名同类型资产，但它的描述与本章剧本里的资料没有共同用词；"
        "本次会选用已有且**不改动**它的描述，请顺手确认一下是不是同一个资产"
    ),
}


def _bigrams(text: str) -> set[str]:
    """取文本的 2-gram 字符集合（中英文都适用），用于"有没有共同点"的粗判。"""
    cleaned = "".join(ch for ch in str(text or "") if ch.isalnum())
    if len(cleaned) < 2:
        return {cleaned} if cleaned else set()
    return {cleaned[index : index + 2] for index in range(len(cleaned) - 1)}


def _has_any_overlap(left: str, right: str) -> bool:
    """两段文本是否有任何 2-gram 共同点。

    为什么用 2-gram 而不是"字段值整体包含"：同一资产的描述措辞差异极大
    （「素白襦裙」vs「白色长裙」），整串包含会把**正常的**同名资产误判成冲突；
    2-gram 至少能捕捉「素白/襦裙/白裙」这类实际共现，把误报压到
    "两段话一个字都不一样"这种确实需要人看一眼的情况。
    """
    left_set = _bigrams(left)
    right_set = _bigrams(right)
    if not left_set or not right_set:
        return True  # 有一边没内容 → 谈不上冲突
    return bool(left_set & right_set)


def detect_conflicts(
    *,
    items: list[dict[str, Any]],
    existing_by_type: dict[tuple[str, str], dict[str, Any]],
    existing_description_by_id: dict[str, str],
) -> None:
    """给每个 item 打上 ``conflict``（None = 无冲突，可直接确认）。"""
    # 同章内同名不同类型 → 冲突
    name_to_types: dict[str, set[str]] = {}
    for item in items:
        name_to_types.setdefault(normalize_name(item["name"]), set()).add(item["asset_type"])

    for item in items:
        asset_type = item["asset_type"]
        name_key = normalize_name(item["name"])
        conflicts: list[dict[str, str]] = []
        notices: list[dict[str, str]] = []

        if len(name_to_types.get(name_key) or set()) > 1:
            other = sorted((name_to_types.get(name_key) or set()) - {asset_type})
            conflicts.append(
                {
                    "code": CONFLICT_DUPLICATE_NAME,
                    "reason": f"{CONFLICT_LABELS[CONFLICT_DUPLICATE_NAME]}（另一组是 {'/'.join(type_label(x) for x in other)}）",
                }
            )

        # 同名不同类型已在库里
        for other_type in ASSET_TYPES:
            if other_type == asset_type:
                continue
            hit = existing_by_type.get((other_type, name_key))
            if hit and hit.get("exists"):
                conflicts.append(
                    {
                        "code": CONFLICT_TYPE_MISMATCH,
                        "reason": (
                            f"{CONFLICT_LABELS[CONFLICT_TYPE_MISMATCH]}："
                            f"库里「{item['name']}」已有 {type_label(other_type)}"
                        ),
                        "existing_asset_id": str(hit.get("asset_id") or ""),
                        "existing_asset_type": other_type,
                    }
                )

        # 别名分别指向库里两个不同资产
        alias_ids: dict[str, str] = {}
        for alias in [item["name"], *(item.get("aliases") or [])]:
            hit = existing_by_type.get((asset_type, normalize_name(alias)))
            if hit and hit.get("exists") and hit.get("asset_id"):
                alias_ids[str(hit["asset_id"])] = str(alias)
        if len(alias_ids) > 1:
            conflicts.append(
                {
                    "code": CONFLICT_ALIAS_SPLIT,
                    "reason": (
                        f"{CONFLICT_LABELS[CONFLICT_ALIAS_SPLIT]}："
                        + "、".join(f"「{alias}」→ {aid}" for aid, alias in alias_ids.items())
                    ),
                    "existing_asset_ids": sorted(alias_ids),
                }
            )

        # 库里同名同类型资产已有描述，且与本章剧本里的资料**没有一个字的共同点**
        hit = existing_by_type.get((asset_type, name_key))
        if hit and hit.get("exists") and hit.get("asset_id"):
            existing_id = str(hit["asset_id"])
            existing_desc = str(existing_description_by_id.get(existing_id) or "").strip()
            item["existing_asset_id"] = existing_id
            if existing_desc:
                summary = str(item.get("summary") or "")
                if summary and not _has_any_overlap(summary, existing_desc):
                    notices.append(
                        {
                            "code": NOTICE_LIBRARY_PROFILE,
                            "message": NOTICE_LABELS[NOTICE_LIBRARY_PROFILE],
                            "existing_asset_id": existing_id,
                            "existing_excerpt": _clip(existing_desc, 80),
                        }
                    )

        item["conflict"] = conflicts[0] if conflicts else None
        item["conflicts"] = conflicts
        item["notices"] = notices
        item["needs_review"] = bool(conflicts)
        item["suggested_action"] = (
            "needs_review"
            if conflicts
            else ("link_existing" if item.get("existing_asset_id") else "create_new")
        )
        item["auto_confirmable"] = not conflicts
        item["action_reason"] = (
            conflicts[0]["reason"]
            if conflicts
            else (
                "库里已有同名同类型资产，且没有冲突 → 可直接选用已有（不会新建重复资产）。"
                if item.get("existing_asset_id")
                else "库里没有同名资产，且本章判断无冲突 → 可直接新建。"
            )
        )


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------


def _make_target_caller(target: TextLLMTarget | None) -> TextLLMCaller:
    """把"解析出来的模型目标"包成一个 :data:`TextLLMCaller`（真实调用路径）。

    单独抽成模块级函数，而不是在主编排里内嵌 ``async def`` —— 让"真实调用"
    与"注入桩"在调用点上完全同构，测试才能一行不改地替换掉它。
    """

    async def _call(text: str) -> str:  # pragma: no cover - 真实网络路径（测试一律注入桩）
        completion = await call_text_llm(text, target=target)  # type: ignore[arg-type]
        return completion.text

    return _call


async def _load_shots(db: AsyncSession, *, chapter_id: str) -> list[dict[str, Any]]:
    rows = (
        (await db.execute(select(Shot).where(Shot.chapter_id == chapter_id).order_by(Shot.index))).scalars().all()
    )
    return [
        {
            "shot_id": str(row.id),
            "index": int(row.index or 0),
            "title": str(row.title or ""),
            "script_excerpt": str(row.script_excerpt or ""),
        }
        for row in rows
    ]


async def _load_existing_descriptions(
    db: AsyncSession,
    *,
    existing_by_type: dict[tuple[str, str], dict[str, Any]],
) -> dict[str, str]:
    """取库中同名资产的 ``description``（冲突判定要用，只读）。"""
    from app.models.studio import Character, Costume, Prop, Scene

    models = {"character": Character, "scene": Scene, "prop": Prop, "costume": Costume}
    ids_by_type: dict[str, set[str]] = {asset_type: set() for asset_type in ASSET_TYPES}
    for (asset_type, _key), hit in existing_by_type.items():
        if hit.get("exists") and hit.get("asset_id"):
            ids_by_type.setdefault(asset_type, set()).add(str(hit["asset_id"]))
    result: dict[str, str] = {}
    for asset_type, ids in ids_by_type.items():
        if not ids:
            continue
        rows = (await db.execute(select(models[asset_type]).where(models[asset_type].id.in_(sorted(ids))))).scalars().all()
        for row in rows:
            result[str(row.id)] = str(getattr(row, "description", "") or "")
    return result


def _dry_run_items(groups: list[dict[str, Any]], *, shots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """DRY_RUN 占位条目：只做**确定性**的骨架，不编造外观细节。

    与既有编排层同口径：占位内容带 ``[DRY_RUN 占位]``，写库路径会被
    ``product_guardrails`` 拒绝，所以不可能被误存成"已就绪"。
    """
    items: list[dict[str, Any]] = []
    for group in groups[:MAX_ITEMS]:
        asset_type = str(group["candidate_type"])
        name = str(group["name"])
        fields = {
            key: f"{PLACEHOLDER_PREFIX} {key}待模型依据本章剧本生成"
            for key in normalize_profile(asset_type, {}).keys()
        }
        refs = shot_refs_for_name(name, list(group.get("aliases") or []), shots)
        items.append(
            {
                "name": name,
                "aliases": list(group.get("aliases") or []),
                "asset_type": asset_type,
                "fields": fields,
                "_dry_run": True,
                "_refs": refs,
            }
        )
    return items


async def _match_existing(
    db: AsyncSession,
    *,
    project_id: str,
    items: list[dict[str, Any]],
) -> dict[tuple[str, str], dict[str, Any]]:
    """用既有存在性接口做"是否已有同名资产"的匹配（复用，不另写一套）。

    **每个名称都要在四类里各查一次**（不是只查自己那一类）：只有这样才可能发现
    "库里已有同名资产，但类型与本次判断不同"这种冲突 —— 只查同类是永远看不见它的。
    """
    buckets: dict[str, list[str]] = {f"{asset_type}_names": [] for asset_type in ASSET_TYPES}
    for item in items:
        names = [str(item["name"]), *(str(alias) for alias in (item.get("aliases") or []))]
        for asset_type in ASSET_TYPES:
            buckets[f"{asset_type}_names"].extend(names)
    try:
        checked = await check_names_existence(
            db,
            project_id=project_id,
            shot_id=None,
            character_names=buckets["character_names"],
            prop_names=buckets["prop_names"],
            scene_names=buckets["scene_names"],
            costume_names=buckets["costume_names"],
        )
    except HTTPException:
        return {}
    result: dict[tuple[str, str], dict[str, Any]] = {}
    for asset_type in ASSET_TYPES:
        for hit in checked.get(f"{asset_type}s") or []:
            if isinstance(hit, dict):
                result[(asset_type, normalize_name(hit.get("name")))] = hit
    return result


async def build_chapter_asset_profiles(
    db: AsyncSession,
    *,
    chapter_id: str,
    llm_caller: TextLLMCaller | None = None,
    extra_instructions: str = "",
    use_cache: bool = True,
) -> dict[str, Any]:
    """基于**本章完整剧本 + 分镜**生成规范化的角色/场景/道具/服装清单（只读预览）。

    返回里 ``user_flow`` 是用户主流程要看的，``technical_detail`` 是默认收起的
    技术详情（原始候选 / 聚合组 / 内部匹配状态 / 别名合并过程 / 被丢弃条目）。
    """
    chapter = await db.get(Chapter, chapter_id)
    if chapter is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=entity_not_found("Chapter"))

    source = await load_chapter_source(db, chapter_id)
    shots = await _load_shots(db, chapter_id=chapter_id)
    chapter_haystack = normalize_name(source.text)

    candidates = await build_chapter_asset_candidates(db, chapter_id=chapter_id)
    groups = [
        {**item, "source_kind": "candidate"}
        for item in candidates.get("items") or []
        if item.get("candidate_type") in CANDIDATE_TYPES
    ]

    cache_key = build_chapter_profile_cache_key(
        project_id=source.project_id,
        chapter_id=chapter_id,
        chapter_text=source.text,
        shots=shots,
        extra_instructions=extra_instructions,
    )

    # 读缓存：签名相同（剧本 / 分镜 / 附加要求都没变）就不重复调大模型。
    # 真实调用是花钱的；而且两次结果不一致会让"用户刚看到的清单"和"确认落库的清单"对不上。
    if use_cache and llm_caller is None:
        cached = get_cached_chapter_profile(cache_key)
        if cached is not None:
            meta = cached.get("meta")
            if isinstance(meta, dict):
                meta["from_cache"] = True
            return cached

    warnings: list[str] = []
    target: TextLLMTarget | None = None
    dry_run_reason: str | None = None

    if llm_caller is None:
        try:
            target = await resolve_text_llm_target(db)
        except HTTPException as exc:
            target = None
            if not dry_run.dry_run_enabled():
                raise
            warnings.append(f"未能解析默认文本模型配置：{exc.detail}")

    prompt = build_chapter_asset_profile_prompt(
        chapter_title=source.title,
        chapter_text=source.text,
        shot_list_text=build_shot_list_text(shots),
        candidate_list_text=build_candidate_list_text(groups),
        extra_instructions=extra_instructions,
    )

    if llm_caller is not None or (target is not None and not dry_run.dry_run_enabled()):
        caller = llm_caller or _make_target_caller(target)
        try:
            raw_text = await caller(prompt)
            parsed, repairs = parse_json_object_with_repairs(raw_text)
            model_items = extract_raw_asset_items(parsed)
        except LLMRequestError as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail={"code": "llm_request_failed", "message": f"结构化资产提取调用失败：{exc}"},
            ) from exc
        except JSONParseError as exc:
            raise HTTPException(
                status_code=422,  # 字面量：starlette 新旧版本对该常量命名不一致
                detail={
                    "code": "llm_json_parse_failed",
                    "message": f"结构化资产提取返回的不是合法 JSON：{exc}",
                    "fix": "请重试；若反复失败，可在附加要求里强调「只输出 JSON 对象」。",
                },
            ) from exc
        if repairs:
            warnings.append(f"模型输出经 JSON 抢救后解析成功：{'、'.join(repairs)}。")
        llm_called = True
        raw_output_chars = len(raw_text)
    else:
        model_items = _dry_run_items(groups, shots=shots)
        llm_called = False
        raw_output_chars = 0
        warnings.append(dry_run_warning(skill="结构化资产清单生成"))
        dry_run_reason = dry_run.short_status()

    by_key, dropped = merge_model_items_into_groups(
        model_items=model_items,
        groups=groups,
        chapter_haystack=chapter_haystack,
    )

    merged_groups = list(by_key.values())
    items = [_build_user_flow_item(entry=entry, shots=shots, chapter_haystack=chapter_haystack) for entry in merged_groups]

    existing_by_type = await _match_existing(db, project_id=source.project_id, items=items)
    existing_descriptions = await _load_existing_descriptions(db, existing_by_type=existing_by_type)
    detect_conflicts(
        items=items,
        existing_by_type=existing_by_type,
        existing_description_by_id=existing_descriptions,
    )

    items.sort(key=lambda item: (CANDIDATE_TYPES.index(item["asset_type"]), -int(item["shot_count"]), item["name"]))

    # 出场镜头证据：按镜头序号稳定排序（保证跨次调用一致）
    for item in items:
        item["shot_refs"] = sorted(item["shot_refs"], key=lambda ref: (ref["shot_index"], ref["shot_id"]))

    auto_confirmable = [item for item in items if item["auto_confirmable"]]
    needs_review = [item for item in items if not item["auto_confirmable"]]

    payload = {
        "chapter_id": chapter_id,
        "project_id": source.project_id,
        "chapter_title": source.title or "",
        "script_chars": len(source.text),
        "shot_total": len(shots),
        # ---------------- 用户主流程 ----------------
        "user_flow": {
            "items": items,
            "summary": {
                "asset_total": len(items),
                "by_type": {
                    asset_type: len([item for item in items if item["asset_type"] == asset_type])
                    for asset_type in CANDIDATE_TYPES
                },
                "evidence_backed": len([item for item in items if item["shot_refs"]]),
                "auto_confirmable": len(auto_confirmable),
                "needs_review": len(needs_review),
                "ready_for_image_prompt": len(
                    [item for item in items if not item["missing_visual_fields"]]
                ),
            },
            "auto_confirmable_group_keys": [item["group_key"] for item in auto_confirmable],
            "needs_review": [
                {
                    "group_key": item["group_key"],
                    "name": item["name"],
                    "asset_type": item["asset_type"],
                    "conflict_code": (item["conflict"] or {}).get("code", ""),
                    "reason": item["action_reason"],
                    "conflict": item["conflict"],
                }
                for item in needs_review
            ],
            "field_labels": {
                asset_type: [
                    {"key": spec.key, "label": spec.label, "visual": spec.visual}
                    for spec in field_specs(asset_type)
                ]
                for asset_type in CANDIDATE_TYPES
            },
            "notes": [
                "本清单只做预览与冲突判定，**不建资产、不写库**；确认请调用 "
                f"POST /api/v1/studio/chapters/{chapter_id}/asset-profiles/confirm。",
                "无冲突项（auto_confirmable）可直接确认；只有 needs_review 里的冲突项需要人工处理。",
                "结构化资料会随确认写入资产描述与候选证据，图片提示词生成会直接读它，"
                "不再出现「外观信息不足，需人工补充」。",
            ],
        },
        # ---------------- 技术详情（默认收起） ----------------
        "technical_detail": {
            "candidate_groups": groups,
            "merged_groups": [
                {
                    "group_key": f"{entry['candidate_type']}:{normalize_name(entry['name'])}",
                    "name": entry["name"],
                    "asset_type": entry["candidate_type"],
                    "aliases": sorted(set(entry.get("aliases") or [])),
                    "merged_names": sorted(set(entry.get("model_names") or [])),
                    "source_kind": entry.get("source_kind"),
                    "shot_ids": entry.get("shot_ids") or [],
                    "candidate_statuses": entry.get("statuses") or {},
                }
                for entry in merged_groups
            ],
            "alias_merge": [
                {
                    "group_key": f"{entry['candidate_type']}:{normalize_name(entry['name'])}",
                    "canonical_name": entry["name"],
                    "merged_names": sorted(set(entry.get("model_names") or [])),
                    "aliases": sorted(set(entry.get("aliases") or [])),
                    "sources": entry.get("sources") or [],
                }
                for entry in merged_groups
            ],
            "match_status": [
                {
                    "group_key": item["group_key"],
                    "asset_type": item["asset_type"],
                    "name": item["name"],
                    "existing_asset_id": item.get("existing_asset_id"),
                    "linked_entity_id": item.get("linked_entity_id"),
                    "linked_to_project": item.get("linked_to_project"),
                    "linked_to_shot": item.get("linked_to_shot"),
                    "candidate_recommendation": item.get("candidate_recommendation"),
                    "suggested_action": item.get("suggested_action"),
                }
                for item in items
            ],
            "dropped_model_items": dropped,
            "candidates_raw": {
                "summary": candidates.get("summary") or {},
                "shot_total": candidates.get("shot_total"),
                "shot_with_candidates": candidates.get("shot_with_candidates"),
            },
            "llm": {
                "prompt_chars": len(prompt),
                "prompt_excerpt": _clip(prompt, 1200),
                "candidate_list_text": build_candidate_list_text(groups),
                "shot_list_chars": len(build_shot_list_text(shots)),
            },
            "cache_key": cache_key,
            "warnings": warnings,
        },
        # meta 存成普通 dict（不是 pydantic 模型）：这份 payload 要进进程内缓存
        # （json 深拷贝），模型实例没法直接序列化；对外的 JSON 形状完全一样。
        "meta": {
            **build_run_meta(
                target=target,
                llm_called=llm_called,
                raw_output_chars=raw_output_chars,
                dry_run_reason=dry_run_reason,
            ).model_dump(),
            "from_cache": False,
        },
        "note": (
            "本接口只返回预览：不建资产、不写库、不出图；"
            "LLM 调用受 DRY_RUN 守卫保护，演练模式下返回带 [DRY_RUN 占位] 的确定性骨架。"
        ),
    }

    set_cached_chapter_profile(cache_key, payload)
    return payload


__all__ = [
    "CANDIDATE_TYPES",
    "MAX_EVIDENCE_CHARS",
    "MAX_EVIDENCE_SHOTS",
    "MAX_ITEMS",
    "build_chapter_asset_profile_prompt",
    "build_chapter_asset_profiles",
    "build_candidate_list_text",
    "build_shot_list_text",
    "detect_conflicts",
    "extract_raw_asset_items",
    "merge_model_items_into_groups",
    "shot_refs_for_name",
]
