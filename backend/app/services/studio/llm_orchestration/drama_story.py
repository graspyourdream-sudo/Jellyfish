"""分层剧情的**三个阶段**：一句话核心创意 → 完整剧情 → 分镜。

为什么要把"一次出全部"拆成三段（用户口径）
==========================================

用户流程是**逐步确认**的：先定一句话核心创意，再展开成完整剧情，最后拆成分镜。
一次调用出全部时，"人物表与镜头对不上""详细剧情跑题"这类问题只能事后打补丁；
分段之后每一段的输入是**用户已经确认过的上一步产物**，一致性由输入保证：

    one_liner   → 出 one_liner + audience_emotion（顺带人物关系与场景）
    story       → **必须基于已确认的一句话**出 story 段（钩子/冲突/商品介入/高潮/结尾引导 + 全文）
    storyboard  → **必须基于当前完整剧情**出 shots（沿用 ``postprocess_plan`` 的镜头归一规则）
    all         → 兼容旧行为：一次出全部（直接转交 ``preview_drama_plan``）

三条写死在提示词模板里的口径（见 ``prompt_templates``）：

1. 详细剧情**必须围绕已确认的一句话**展开，不许换主题、不许另起一个故事；
2. 分镜**必须来自当前完整剧情**，不许新增剧情线或新人物；
3. 商品**自然介入**，结尾是自然的购买暗示，**不要硬 CTA**。

边界（与编排层其他服务同一口径）
================================

- **本模块不写库**：只返回"合并后的完整草稿 + warnings + meta"；落草稿列由
  ``drama_plan_service`` 负责，且**只在成功后**写（演练、解析失败都不写）。
- **不破坏已有内容**：分段生成是"把这一段的结果合并进当前草稿"，
  不改动这一步管不到的字段（生成分镜不会把已经确认的一句话/完整剧情冲掉）。
- **前置条件不满足就明确拒绝**（409，中文消息 + 可执行 fix）：没有已确认的一句话
  就没有完整剧情；没有完整剧情就没有分镜。
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.studio import Chapter, Project
from app.schemas.studio.drama_plan import (
    DEFAULT_SHOT_COUNT,
    DEFAULT_STAGE,
    STAGE_ALL,
    STAGE_LABELS,
    STAGE_ONE_LINER,
    STAGE_STORY,
    STAGE_STORYBOARD,
    STAGES,
    DramaPlanDraft,
    DramaPlanStoryDraft,
)
from app.services.studio.llm_orchestration import drama_plan as plan_module
from app.services.studio.llm_orchestration.client import TextLLMCaller
from app.services.studio.llm_orchestration.json_utils import (
    coerce_int,
    coerce_str,
    coerce_str_list,
)
from app.services.studio.llm_orchestration.prompt_templates import (
    DRAMA_ONE_LINER_TEMPLATE,
    DRAMA_STORY_TEMPLATE,
    DRAMA_STORYBOARD_TEMPLATE,
)

#: 完整剧情全文的最短长度（与 ``drama_plan.MIN_STORY_CHARS`` 同源，避免两处阈值打架）
MIN_STORY_CHARS = plan_module.MIN_STORY_CHARS

#: 送进提示词的章节原文上限（与 ``drama_plan.MAX_SOURCE_CHARS`` 同量级）
MAX_SOURCE_CHARS = plan_module.MAX_SOURCE_CHARS


def _stage_conflict(code: str, message: str, *, fix: str, extra: dict[str, Any] | None = None) -> HTTPException:
    """结构化 409（路由会用 ``error_envelope`` 原样放进 ``meta.error``）。"""
    detail: dict[str, Any] = {"code": code, "message": message, "fix": fix}
    if extra:
        detail.update(extra)
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


def _stage_failure(code: str, message: str, *, fix: str, extra: dict[str, Any] | None = None) -> HTTPException:
    """结构化 422（模型返回的内容不可用 → **本次生成视为失败，不落草稿**）。"""
    detail: dict[str, Any] = {"code": code, "message": message, "fix": fix}
    if extra:
        detail.update(extra)
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=detail)


def parse_stage(stage: Any) -> str:
    """阶段取值归一；非法取值抛 422（**不猜**用户想生成哪一段）。"""
    value = coerce_str(stage) or DEFAULT_STAGE
    if value not in STAGES:
        raise _stage_failure(
            "drama_plan_invalid_stage",
            f"生成阶段「{value}」不是允许的取值。",
            fix="只能取 one_liner（一句话创意）/ story（完整剧情）/ storyboard（分镜）/ all（一次出全部）。",
            extra={"allowed": list(STAGES)},
        )
    return value


def as_draft(raw: dict[str, Any] | DramaPlanDraft | None) -> tuple[DramaPlanDraft, list[str]]:
    """把库里的草稿（或调用方传的 dict）转成 DTO；坏结构**降级为空草稿并如实告警**。

    为什么降级而不是报错：分段生成的目的是"在已有草稿上补一段"。草稿里某处结构坏了
    （例如用户手改时把 shots 写成了字符串），不该让整次生成失败——这一阶段能写的那部分
    照写，改动不了的部分按空处理，并把这件事作为 warning 一并返回（不静默）。
    """
    if isinstance(raw, DramaPlanDraft):
        return raw, []
    try:
        return DramaPlanDraft.model_validate(raw or {}), []
    except Exception:  # noqa: BLE001 - 坏结构降级，不能因为旧草稿坏掉就整段生成失败
        return DramaPlanDraft(), ["已有草稿的结构不完整，本次只保留能识别的部分（其余按空处理）。"]


def require_stage_prerequisites(stage: str, plan: DramaPlanDraft) -> None:
    """阶段前置条件（**调用模型之前**的确定性闸门）。

    - ``story``：必须有**已确认的一句话核心创意**（``one_liner``），否则 409
      「先确认一句话创意」——让模型自己编一句话再展开，等于整段跑题风险；
    - ``storyboard``：必须有**当前完整剧情全文**（``story.full_text``），
      否则 409「先有完整剧情」——分镜凭空拆只会得到和剧情无关的镜头。
    """
    if stage == STAGE_STORY and not plan.one_liner.strip():
        raise _stage_conflict(
            "drama_plan_one_liner_required",
            "先确认一句话创意：完整剧情必须围绕它展开，现在还没有这一句。",
            fix="先点「生成一句话创意」并确认它（或手工填一句），再生成完整剧情。",
        )
    if stage == STAGE_STORYBOARD and not plan.story.full_text.strip():
        raise _stage_conflict(
            "drama_plan_story_required",
            "先有完整剧情：分镜必须来自完整剧情，现在剧情全文还是空的。",
            fix="先点「生成完整剧情」（或手工填好剧情全文），再生成分镜。",
        )


def _current_hint(lines: list[str]) -> str:
    """把"当前已有内容"渲染成提示词里的一段（没有内容时返回空串，不留空标题）。"""
    kept = [line for line in lines if coerce_str(line)]
    if not kept:
        return ""
    body = "\n".join(f"- {line}" for line in kept)
    return (
        "\n【当前草稿里已有的内容（重新生成时可以参考，但不要因为重生成丢掉已经确认的设定）】\n"
        f"{body}"
    )


def _characters_text(plan: DramaPlanDraft) -> str:
    """人物表渲染（含 relation）：分镜的出场角色只能从这里选。"""
    lines: list[str] = []
    for item in plan.characters:
        relation = f"（关系：{item.relation}）" if item.relation.strip() else ""
        identity = coerce_str((item.profile or {}).get("identity"))
        suffix = f"｜{identity}" if identity else ""
        lines.append(f"- {item.name}{relation}{suffix}")
    return "\n".join(lines) if lines else "（人物表为空：请只使用剧情全文里出现过的人，不要新增角色）"


def _product_text(plan: DramaPlanDraft) -> str:
    """商品渲染：没有商品时明确要求 product_present 全为 false。"""
    if plan.product is None:
        return "（本方案没有商品：所有镜头的 product_present 必须为 false）"
    description = plan.product.description or coerce_str((plan.product.profile or {}).get("package"))
    return f"{plan.product.name}｜{description}" if description else plan.product.name


# ---------------------------------------------------------------------------
# 提示词构建（三个各一份；价格/口径都从 brief 与当前草稿来，不让模型猜）
# ---------------------------------------------------------------------------


def build_one_liner_prompt(
    *,
    brief: dict[str, Any],
    chapter_title: str,
    chapter_text: str,
    style_hint: str,
    current: DramaPlanDraft | None = None,
) -> str:
    """阶段一提示词：一句话核心创意 + 目标受众情绪（顺带人物关系与场景）。"""
    plan = current or DramaPlanDraft()
    return DRAMA_ONE_LINER_TEMPLATE.safe_substitute(
        brief_text=plan_module.render_brief_text(brief),
        chapter_title=chapter_title or "（未命名）",
        chapter_text=(chapter_text or "（本章还没有原文，请完全依据商品信息创作）")[:MAX_SOURCE_CHARS],
        style_hint=style_hint or "（沿用项目风格）",
        current_hint=_current_hint(
            [
                f"当前一句话创意：{plan.one_liner}" if plan.one_liner.strip() else "",
                f"当前受众情绪：{plan.audience_emotion}" if plan.audience_emotion.strip() else "",
            ]
        ),
    )


def build_story_prompt(
    *,
    brief: dict[str, Any],
    chapter_title: str,
    chapter_text: str,
    one_liner: str,
    audience_emotion: str,
    style_hint: str,
    current: DramaPlanDraft | None = None,
) -> str:
    """阶段二提示词：**围绕已确认的一句话**写完整剧情。

    ``one_liner`` 是这里的核心变量：它是用户确认过的那一句，
    提示词把它放在最前面并写明"唯一主题，必须围绕它展开"。
    """
    plan = current or DramaPlanDraft()
    existing_story = plan.story.full_text.strip()
    return DRAMA_STORY_TEMPLATE.safe_substitute(
        one_liner=one_liner.strip(),
        audience_emotion=audience_emotion.strip() or "（未指定，按一句话创意推断）",
        brief_text=plan_module.render_brief_text(brief),
        chapter_title=chapter_title or "（未命名）",
        chapter_text=(chapter_text or "（本章还没有原文，请完全依据商品信息创作）")[:MAX_SOURCE_CHARS],
        style_hint=style_hint or "（沿用项目风格）",
        current_hint=_current_hint(
            [
                f"当前人物表：{'、'.join(item.name for item in plan.characters)}" if plan.characters else "",
                f"当前商品：{plan.product.name}" if plan.product is not None else "",
                f"当前已有的剧情全文（{len(existing_story)} 字，本次重写它）：{existing_story[:200]}…"
                if len(existing_story) > 200
                else "",
            ]
        ),
    )


def build_storyboard_prompt(
    *,
    brief: dict[str, Any],
    chapter_title: str,
    story_full_text: str,
    shot_count: int,
    duration_hint: int,
    style_hint: str,
    characters_text: str,
    product_text: str,
    allowed_durations: str,
    current: DramaPlanDraft | None = None,
) -> str:
    """阶段三提示词：**基于当前完整剧情**拆镜头（人物表是白名单，不许新增角色）。"""
    plan = current or DramaPlanDraft()
    existing = [f"第 {shot.index} 镜：{shot.title}" for shot in plan.shots]
    return DRAMA_STORYBOARD_TEMPLATE.safe_substitute(
        story_full_text=(story_full_text or "").strip()[:MAX_SOURCE_CHARS],
        characters_text=characters_text,
        product_text=product_text,
        shot_count=shot_count,
        product_need=(shot_count + 1) // 2,
        duration_hint=duration_hint or shot_count * 8,
        allowed_durations=allowed_durations,
        style_hint=style_hint or "（沿用项目风格）",
        current_hint=_current_hint(
            [f"当前已有 {len(existing)} 个镜头（本次全部重拆）：{'；'.join(existing[:8])}"] if existing else []
        ),
    )


# ---------------------------------------------------------------------------
# 阶段产物的合并（确定性：这一步管不到的字段一个字都不动）
# ---------------------------------------------------------------------------


def seed_product_from_brief(plan: dict[str, Any], brief: dict[str, Any]) -> dict[str, Any]:
    """商品段落为空时，用 brief 里的商品信息补上（**确定性、不编造**）。

    为什么需要它：分层生成里"一句话 / 完整剧情"两步可能没给商品段，而分镜的
    "商品至少一半镜头"与确认落库的商品关联都依赖 ``plan.product``。商品信息是
    **用户在 brief（商品卡）里填的事实**，直接用它比让模型复述更可靠；
    模型给了商品段时以模型为准（它可能补了包装描述）。
    """
    name = coerce_str(brief.get("product_name"))
    existing = _as_dict(plan.get("product"))
    if not name or coerce_str(existing.get("name")):
        return plan
    selling = "；".join(coerce_str_list(brief.get("selling_points")))
    description = coerce_str(brief.get("product_description"))
    payload = dict(plan)
    payload["product"] = {
        "name": name,
        "relation": "",
        "description": description,
        "profile": {"selling_points": selling} if selling else {},
        "shot_indexes": [],
    }
    return payload


def _as_dict(value: Any) -> dict[str, Any]:
    """取 dict（坏值一律当空，读别人的草稿不能假设结构）。"""
    return dict(value) if isinstance(value, dict) else {}


def validate_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """校验一份要写回库的草稿；不合法就 422（**绝不把坏草稿写进库**）。"""
    try:
        return DramaPlanDraft.model_validate(payload).model_dump()
    except Exception as exc:  # noqa: BLE001 - 合并后仍不合法 → 如实报，绝不写坏草稿
        raise _stage_failure(
            "drama_plan_merge_failed",
            f"本阶段的结果与已有草稿合并后不合法，未保存：{exc}",
            fix="重新生成一次；若反复失败，请先检查已有草稿里的人物表与镜头字段。",
        ) from exc


def _dump_with(draft: DramaPlanDraft, *, overrides: dict[str, Any], warnings: list[str]) -> dict[str, Any]:
    """在当前草稿上套用本阶段的产物并校验（保证写回库里的一定是合法草稿）。"""
    payload = draft.model_dump()
    payload.update(overrides)
    payload["warnings"] = warnings
    return validate_payload(payload)


def merge_stage_output(
    stage: str,
    *,
    current: DramaPlanDraft,
    raw: dict[str, Any],
    shot_count: int,
) -> tuple[dict[str, Any], list[str]]:
    """把模型返回的**本阶段内容**合并进当前草稿，返回 (plan dict, warnings)。

    合并规则（按阶段）：

    - ``one_liner``：只替换 ``one_liner`` / ``audience_emotion``；模型若顺带给人物表/场景表
      就用新的（它们是这一句话的人物关系），镜头保持不动；
    - ``story``：只替换 ``story`` 段（顺带人物表/场景表）；一句话与镜头保持不动；
    - ``storyboard``：只替换 ``shots``，并且**用当前人物表当白名单**跑 ``postprocess_plan``
      （景别/机位/运镜别名、时长档位、序号重排、悬空角色剔除都沿用同一套规则，不另写）。
    """
    warnings: list[str] = []

    if stage == STAGE_ONE_LINER:
        one_liner = plan_module.text_or_joined(raw.get("one_liner") or raw.get("oneLiner"))
        audience_emotion = plan_module.text_or_joined(
            raw.get("audience_emotion") or raw.get("audienceEmotion")
        )
        if not one_liner:
            raise _stage_failure(
                "drama_plan_one_liner_empty",
                "模型没有给出可用的一句话核心创意，本次生成视为失败（不落草稿）。",
                fix="重新生成一次；若反复为空，请把商品信息与本章剧本补充得更具体。",
            )
        if not audience_emotion:
            warnings.append("模型没有给出受众情绪，已留空（可手工补写）。")
        overrides: dict[str, Any] = {"one_liner": one_liner, "audience_emotion": audience_emotion}
        characters = plan_module.normalize_named_assets(
            raw.get("characters"), warnings=warnings, relation_field=True
        )
        scenes = plan_module.normalize_named_assets(raw.get("scenes"), warnings=warnings)
        if characters:
            overrides["characters"] = [item.model_dump() for item in characters]
        if scenes:
            overrides["scenes"] = [item.model_dump() for item in scenes]
        product = plan_module.normalize_product(raw.get("product"), warnings=warnings)
        if product is not None:
            overrides["product"] = product.model_dump()
        return _dump_with(current, overrides=overrides, warnings=warnings), warnings

    if stage == STAGE_STORY:
        story: DramaPlanStoryDraft = plan_module.normalize_story_fields(raw.get("story"))
        if not story.full_text.strip():
            raise _stage_failure(
                "drama_plan_story_empty",
                "模型没有给出可用的完整剧情全文，本次生成视为失败（不落草稿）。",
                fix="重新生成一次；一句话创意太短或商品信息太少都会让它写不出剧情。",
            )
        if len(story.full_text.strip()) < MIN_STORY_CHARS:
            warnings.append(
                f"完整剧情只有 {len(story.full_text.strip())} 字，短于 {MIN_STORY_CHARS} 字，"
                "建议重新生成或手工补写得更具体。"
            )
        overrides = {"story": story.model_dump()}
        characters = plan_module.normalize_named_assets(
            raw.get("characters"), warnings=warnings, relation_field=True
        )
        scenes = plan_module.normalize_named_assets(raw.get("scenes"), warnings=warnings)
        if characters:
            overrides["characters"] = [item.model_dump() for item in characters]
        if scenes:
            overrides["scenes"] = [item.model_dump() for item in scenes]
        product = plan_module.normalize_product(raw.get("product"), warnings=warnings)
        if product is not None:
            overrides["product"] = product.model_dump()
        return _dump_with(current, overrides=overrides, warnings=warnings), warnings

    if stage == STAGE_STORYBOARD:
        # 镜头归一复用既有 postprocess_plan：把**当前**人物表与商品喂进去，
        # 于是"悬空角色剔除""有商品标记但没有商品信息则置 false"等规则自动生效。
        shot_raw = {
            "characters": [item.model_dump() for item in current.characters],
            "product": current.product.model_dump() if current.product is not None else None,
            "shots": raw.get("shots"),
        }
        dto, shot_warnings = plan_module.postprocess_plan(shot_raw, shot_count=shot_count)
        warnings.extend(shot_warnings)
        overrides = {"shots": [shot.model_dump() for shot in dto.shots]}
        return _dump_with(current, overrides=overrides, warnings=warnings), warnings

    # 走到这里说明 stage 没被 parse_stage 拦住（不应发生）：不猜，直接报错
    raise _stage_failure(
        "drama_plan_invalid_stage",
        f"生成阶段「{stage}」没有对应的实现。",
        fix="只能取 one_liner / story / storyboard / all。",
        extra={"allowed": list(STAGES)},
    )


# ---------------------------------------------------------------------------
# 阶段化入口（编排层对外的唯一函数）
# ---------------------------------------------------------------------------


async def preview_drama_stage(
    db: AsyncSession,
    *,
    chapter_id: str,
    brief: dict[str, Any],
    stage: str = DEFAULT_STAGE,
    current_plan: dict[str, Any] | None = None,
    llm_caller: TextLLMCaller | None = None,
) -> dict[str, Any]:
    """按阶段生成（返回形状与 ``preview_drama_plan`` 一致）。

    ``current_plan``：库里已归一化过的草稿（分段生成要在它上面合并）。
    ``stage="all"`` **直接转交** ``preview_drama_plan``：一次出全部是既有行为，
    这里不复制一份，免得两条路慢慢长出差异。
    """
    resolved = parse_stage(stage)
    if resolved == STAGE_ALL:
        return await plan_module.preview_drama_plan(
            db, chapter_id=chapter_id, brief=brief, llm_caller=llm_caller
        )

    chapter = await db.get(Chapter, chapter_id)
    if chapter is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"章节不存在：{chapter_id}")
    project = await db.get(Project, chapter.project_id)

    current, base_warnings = as_draft(current_plan)
    # 前置条件在**调用模型之前**判定：不合格就不该花这次钱
    require_stage_prerequisites(resolved, current)

    shot_count = coerce_int(brief.get("shot_count"), default=DEFAULT_SHOT_COUNT) or DEFAULT_SHOT_COUNT
    shot_count = max(1, min(plan_module.MAX_SHOT_COUNT, shot_count))
    duration_hint = coerce_int(brief.get("duration_seconds"), default=0) or 0
    style_hint = " / ".join(
        item
        for item in (
            coerce_str(brief.get("genre")) or (project.style if project else ""),
            coerce_str(brief.get("tone")),
        )
        if item
    )
    chapter_text = chapter.raw_text or chapter.condensed_text

    if resolved == STAGE_ONE_LINER:
        prompt = build_one_liner_prompt(
            brief=brief,
            chapter_title=chapter.title,
            chapter_text=chapter_text,
            style_hint=style_hint,
            current=current,
        )
    elif resolved == STAGE_STORY:
        prompt = build_story_prompt(
            brief=brief,
            chapter_title=chapter.title,
            chapter_text=chapter_text,
            one_liner=current.one_liner,
            audience_emotion=current.audience_emotion,
            style_hint=style_hint,
            current=current,
        )
    else:
        prompt = build_storyboard_prompt(
            brief=brief,
            chapter_title=chapter.title,
            story_full_text=current.story.full_text,
            shot_count=shot_count,
            duration_hint=duration_hint,
            style_hint=style_hint,
            characters_text=_characters_text(current),
            product_text=_product_text(current),
            allowed_durations="/".join(str(item) for item in plan_module.ALLOWED_DURATIONS),
            current=current,
        )

    outcome = await plan_module.run_plan_completion(db, prompt=prompt, llm_caller=llm_caller)
    if outcome["parsed"] is None:
        # 演练：一次模型都不调，也不给出假草稿（分段生成同样不许写半成品）
        return plan_module.dry_run_stage_result(outcome, note="演练模式：未调用模型，未生成草稿。")

    merged, warnings = merge_stage_output(
        resolved, current=current, raw=outcome["parsed"], shot_count=shot_count
    )
    # 商品段落兜底：模型没给就用 brief（商品卡）里的商品信息补上（确定性，不编造）。
    # 没有它，"商品至少一半镜头"与确认落库的商品关联都会因为 plan.product 为空而失效。
    seeded = seed_product_from_brief(merged, brief)
    if seeded is not merged and not merged.get("product"):
        warnings.append("本阶段没有返回商品段，已按商品信息里的商品名补上商品资产。")
    merged = validate_payload(seeded)
    warnings = [*base_warnings, *warnings]
    repairs = list(outcome["repairs"] or [])
    if repairs:
        warnings.insert(0, f"模型输出经 JSON 抢救后解析成功：{'、'.join(repairs)}。")
        merged["warnings"] = warnings
    return {
        "plan": merged,
        "warnings": warnings,
        "meta": outcome["meta"],
        "note": (
            f"本阶段只更新「{STAGE_LABELS.get(resolved, resolved)}」，草稿的其他部分保持原样；"
            "确认之前不落任何正式行。"
        ),
    }


__all__ = [
    "MAX_SOURCE_CHARS",
    "MIN_STORY_CHARS",
    "as_draft",
    "build_one_liner_prompt",
    "build_story_prompt",
    "build_storyboard_prompt",
    "merge_stage_output",
    "parse_stage",
    "preview_drama_stage",
    "require_stage_prerequisites",
    "seed_product_from_brief",
    "validate_payload",
]
