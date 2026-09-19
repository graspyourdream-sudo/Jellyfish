"""4.2 图片提示词生成编排服务。

统一内部模式：组装上下文 → 构建提示词 → 调 LLM（经守卫）→ 解析 JSON + 确定性后校验 → 返回预览。

要点：
- 输出按 Jellyfish 提示词类别**逐槽位**生成（角色正/侧、场景正/侧、服装正/侧、首/尾/关键帧）；
- 分层结构固定为 主体描述 + 动作姿态 + 场景环境 + 镜头语言 + 风格 + 画质词，
  最终 prompt 由**确定性代码**按固定顺序拼接，避免模型自由发挥破坏结构；
- 同一实体的主体描述一律取画像卡的 ``canonical_subject``（画像卡思路），
  模型改写会被覆盖并记 warning，从而保证跨槽位/跨镜头一致。
"""

from __future__ import annotations

import re
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.types import PromptCategory
from app.schemas.studio.llm_orchestration import (
    EntityProfileCardRead,
    EntityProfileInput,
    ImagePromptPreviewRead,
    ImagePromptPreviewRequest,
    ImagePromptSlotRead,
)
from app.services.studio.llm_orchestration import dry_run
from app.services.studio.llm_orchestration.client import (
    LLMRequestError,
    TextLLMCaller,
    TextLLMTarget,
    call_text_llm,
    resolve_text_llm_target,
)
from app.services.studio.llm_orchestration.context import (
    build_profile_cards,
    load_project_entity_profiles,
    load_shot_context,
    render_profile_cards,
    render_project_context,
    resolve_project_id,
)
from app.services.studio.llm_orchestration.json_utils import (
    JSONParseError,
    coerce_str,
    normalize_name,
    parse_json_object_with_repairs,
)
from app.services.studio.llm_orchestration.prompt_templates import IMAGE_PROMPT_TEMPLATE
from app.services.studio.llm_orchestration.registry import (
    DEFAULT_IMAGE_PROMPT_CATEGORIES,
    DEFAULT_NEGATIVE_PROMPT,
    DEFAULT_QUALITY_WORDS,
    DEFAULT_STYLE_WORDS,
    IMAGE_PROMPT_LAYER_LABELS,
    IMAGE_PROMPT_LAYER_ORDER,
    IMAGE_PROMPT_SLOT_BY_CATEGORY,
    SLOT_NEGATIVE_EXTRA,
    SLOT_STYLE_RULES,
    ImagePromptSlotSpec,
)
from app.services.studio.llm_orchestration.support import (
    build_run_meta,
    dry_run_warning,
    raise_llm_failure,
    raise_parse_failure,
)

PLACEHOLDER_PREFIX = "[DRY_RUN 占位]"
# 需要镜头上下文的槽位类别（资产级生成时自动排除）
FRAME_SLOT_CATEGORIES: tuple[str, ...] = (
    "frame_head_image",
    "frame_tail_image",
    "frame_key_image",
)
ASSET_ONLY_SHOT_TEXT = "（本次为资产级生成，没有具体镜头文本；只需生成资产参考图提示词。）"
MAX_SHOT_TEXT_CHARS = 4000


# ---------------------------------------------------------------------------
# 槽位 / 实体选择
# ---------------------------------------------------------------------------


def resolve_requested_categories(raw: list[PromptCategory] | None) -> list[PromptCategory]:
    """归一化请求的槽位类别；为空时使用默认九槽位。"""
    if not raw:
        return list(DEFAULT_IMAGE_PROMPT_CATEGORIES)
    result: list[PromptCategory] = []
    seen: set[str] = set()
    for item in raw:
        value = str(getattr(item, "value", item))
        if value in IMAGE_PROMPT_SLOT_BY_CATEGORY and value not in seen:
            seen.add(value)
            result.append(PromptCategory(value))
    return result


def pick_entity_for_slot(
    spec: ImagePromptSlotSpec,
    *,
    cards: list[EntityProfileCardRead],
    shot_text: str,
) -> EntityProfileCardRead | None:
    """为槽位挑选实体画像卡：优先镜头文本里**最先出现**的实体。"""
    if not spec.entity_type:
        return None
    candidates = [card for card in cards if card.entity_type == spec.entity_type]
    if not candidates:
        return None

    haystack = normalize_name(shot_text)
    if not haystack:
        return candidates[0]

    mentioned: list[tuple[int, EntityProfileCardRead]] = []
    for card in candidates:
        name_key = normalize_name(card.name)
        if name_key and name_key in haystack:
            mentioned.append((haystack.index(name_key), card))
    if mentioned:
        return min(mentioned, key=lambda item: item[0])[1]
    return candidates[0]


# ---------------------------------------------------------------------------
# 确定性拼装
# ---------------------------------------------------------------------------


def _dedupe_phrases(phrases: list[str]) -> list[str]:
    """按逗号/顿号拆分后逐条去重，避免全局负面词与默认规则重复。"""
    seen: set[str] = set()
    result: list[str] = []
    for phrase in phrases:
        for token in re.split(r"[,，、;；]+", str(phrase or "")):
            text = token.strip().strip("。 ")
            if not text:
                continue
            key = text.lower()
            if key in seen:
                continue
            seen.add(key)
            result.append(text)
    return result


def assemble_image_prompt(layers: dict[str, str]) -> str:
    """按固定层序拼接提示词（确定性，保证结构不被模型打乱）。"""
    parts = [str(layers.get(key, "")).strip().strip("，,。;；") for key in IMAGE_PROMPT_LAYER_ORDER]
    return "，".join(part for part in parts if part) + "。"


def build_slot_negative_prompt(*, slot_category: str, global_negative: str) -> str:
    """拼接槽位负面提示词：全局 + 默认规则 + 槽位特有规则。"""
    phrases = [global_negative, DEFAULT_NEGATIVE_PROMPT, *SLOT_NEGATIVE_EXTRA.get(slot_category, ())]
    return ", ".join(_dedupe_phrases(phrases))


def build_slot_layers(
    *,
    spec: ImagePromptSlotSpec,
    raw: dict[str, Any],
    card: EntityProfileCardRead | None,
    warnings: list[str],
) -> dict[str, str]:
    """把模型输出规整成固定的分层结构，并做画像卡一致性覆盖。"""
    layers: dict[str, str] = {
        "subject": coerce_str(raw.get("subject")),
        "action_pose": coerce_str(raw.get("action_pose")),
        "environment": coerce_str(raw.get("environment")),
        "camera_language": coerce_str(raw.get("camera_language")),
        "style": coerce_str(raw.get("style")),
        "quality": coerce_str(raw.get("quality")),
    }

    # 画像卡一致性：有画像卡时主体描述必须与画像卡完全一致。
    if card is not None and card.canonical_subject:
        provided = layers["subject"]
        if provided and normalize_name(provided) != normalize_name(card.canonical_subject):
            warnings.append(
                f"槽位 {spec.category.value} 的主体描述与画像卡不一致，已用画像卡统一"
                f"（保证同一实体跨槽位一致）。"
            )
        layers["subject"] = card.canonical_subject
    elif not layers["subject"]:
        warnings.append(f"槽位 {spec.category.value} 缺少主体描述，已按“信息不足”占位。")
        layers["subject"] = "主体信息不足，需人工补充"

    if not layers["action_pose"]:
        layers["action_pose"] = spec.view_hint
        warnings.append(f"槽位 {spec.category.value} 缺少动作姿态，已用槽位视角说明兜底。")
    if not layers["environment"]:
        layers["environment"] = "按镜头文本描述的环境"
        warnings.append(f"槽位 {spec.category.value} 缺少场景环境，已用默认描述兜底。")
    if not layers["camera_language"]:
        layers["camera_language"] = "中景平视，柔和主光"
        warnings.append(f"槽位 {spec.category.value} 缺少镜头语言，已用默认描述兜底。")
    if not layers["style"]:
        layers["style"] = DEFAULT_STYLE_WORDS
    if not layers["quality"]:
        layers["quality"] = DEFAULT_QUALITY_WORDS

    extra_rules = SLOT_STYLE_RULES.get(spec.category.value, ())
    if extra_rules:
        style_text = layers["style"].lower()
        missing = [rule for rule in extra_rules if rule.lower() not in style_text]
        if missing:
            layers["style"] = ", ".join([layers["style"], *missing])

    return layers


def postprocess_slots(
    *,
    parsed: dict[str, Any],
    categories: list[PromptCategory],
    cards: list[EntityProfileCardRead],
    shot_text: str,
    global_negative: str,
) -> tuple[list[ImagePromptSlotRead], list[str]]:
    """后校验：槽位白名单 + 去重 + 画像卡一致性 + 分层补齐。"""
    warnings: list[str] = []
    raw_slots = parsed.get("slots")
    if not isinstance(raw_slots, list):
        raise JSONParseError("模型返回的 JSON 里找不到 slots 数组。")

    allowed = {str(category.value): category for category in categories}
    by_category: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(raw_slots, start=1):
        if not isinstance(raw, dict):
            warnings.append(f"第 {index} 个槽位不是对象，已忽略。")
            continue
        category = coerce_str(raw.get("category") or raw.get("slot") or raw.get("type"))
        if category not in allowed:
            warnings.append(f"槽位类别 {category or '空'} 不在本次请求范围内，已丢弃。")
            continue
        if category in by_category:
            warnings.append(f"槽位 {category} 重复返回，已保留第一条，其余合并丢弃。")
            continue
        by_category[category] = raw

    slots: list[ImagePromptSlotRead] = []
    for category in categories:
        spec = IMAGE_PROMPT_SLOT_BY_CATEGORY[str(category.value)]
        raw = by_category.get(str(category.value))
        if raw is None:
            warnings.append(f"槽位 {category.value}（{spec.label}）模型未返回，已跳过。")
            continue
        card = pick_entity_for_slot(spec, cards=cards, shot_text=shot_text)
        layers = build_slot_layers(spec=spec, raw=raw, card=card, warnings=warnings)
        entity_name = coerce_str(raw.get("entity_name")) or (card.name if card else "") or None
        slots.append(
            ImagePromptSlotRead(
                category=category,
                label=spec.label,
                entity_name=entity_name,
                layers={key: layers[key] for key in IMAGE_PROMPT_LAYER_ORDER},
                prompt=assemble_image_prompt(layers),
                negative_prompt=build_slot_negative_prompt(
                    slot_category=str(category.value),
                    global_negative=global_negative,
                ),
            )
        )
    return slots, warnings


def build_prompt_layer_reference() -> str:
    """给提示词的层名说明（保持模板与代码里的层名一致）。"""
    return "、".join(f"{name}={IMAGE_PROMPT_LAYER_LABELS[name]}" for name in IMAGE_PROMPT_LAYER_ORDER)


def build_slot_list_text(categories: list[PromptCategory]) -> str:
    lines = []
    for category in categories:
        spec = IMAGE_PROMPT_SLOT_BY_CATEGORY[str(category.value)]
        lines.append(f"- {category.value}（{spec.label}）：{spec.view_hint}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# DRY_RUN 占位
# ---------------------------------------------------------------------------


def build_dry_run_slots(
    *,
    categories: list[PromptCategory],
    cards: list[EntityProfileCardRead],
    shot_text: str,
    global_negative: str,
) -> tuple[list[ImagePromptSlotRead], list[str]]:
    """DRY_RUN 占位：结构完整、内容明确标注为未生成。"""
    warnings = [dry_run_warning(skill="图片提示词生成")]
    slots: list[ImagePromptSlotRead] = []
    for category in categories:
        spec = IMAGE_PROMPT_SLOT_BY_CATEGORY[str(category.value)]
        card = pick_entity_for_slot(spec, cards=cards, shot_text=shot_text)
        subject = card.canonical_subject if card else f"{PLACEHOLDER_PREFIX} 主体描述待模型依据镜头文本生成"
        layers = {
            "subject": subject,
            "action_pose": f"{PLACEHOLDER_PREFIX} 动作姿态待模型生成",
            "environment": f"{PLACEHOLDER_PREFIX} 场景环境待模型生成",
            "camera_language": f"{PLACEHOLDER_PREFIX} {spec.view_hint}",
            "style": ", ".join([DEFAULT_STYLE_WORDS, *SLOT_STYLE_RULES.get(str(category.value), ())]),
            "quality": DEFAULT_QUALITY_WORDS,
        }
        slots.append(
            ImagePromptSlotRead(
                category=category,
                label=spec.label,
                entity_name=card.name if card else None,
                layers={key: layers[key] for key in IMAGE_PROMPT_LAYER_ORDER},
                prompt=assemble_image_prompt(layers),
                negative_prompt=build_slot_negative_prompt(
                    slot_category=str(category.value),
                    global_negative=global_negative,
                ),
            )
        )
    return slots, warnings


# ---------------------------------------------------------------------------
# 编排入口
# ---------------------------------------------------------------------------


async def preview_image_prompts(
    db: AsyncSession,
    *,
    body: ImagePromptPreviewRequest,
    llm_caller: TextLLMCaller | None = None,
) -> ImagePromptPreviewRead:
    """图片提示词预览。

    两种调用形态：
    - **镜头级**：给 ``shot_id`` 或 ``shot_text``，生成全部九个槽位（含首/尾/关键帧）；
    - **资产级**（资产准备页「生成图片提示词」用）：只给 ``entity_profiles``，
      不传镜头文本，只生成资产槽位（角色正/侧、场景正/侧、服装正/侧）。
      资产级不需要镜头，所以这里不再强制要求 shot_id / shot_text。
    """
    shot_context = None
    shot_text = str(body.shot_text or "").strip()
    shot_id = body.shot_id
    asset_only = False

    if not shot_text:
        if body.shot_id:
            shot_context = await load_shot_context(db, body.shot_id)
            shot_text = shot_context.script_excerpt or shot_context.title
            shot_id = shot_context.shot_id
            if not shot_text.strip():
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"镜头 {body.shot_id} 没有剧本摘录，无法生成图片提示词。",
                )
        elif body.entity_profiles:
            # 资产级：没有镜头文本是正常的，用占位文案让模板有东西可渲染
            asset_only = True
            shot_text = ""
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="需要提供 shot_id / shot_text（镜头级），或 entity_profiles（资产级）。",
            )
    elif body.shot_id:
        shot_id = body.shot_id

    shot_text = shot_text[:MAX_SHOT_TEXT_CHARS]

    project_id = await resolve_project_id(
        db,
        shot_id=shot_id,
        chapter_id=shot_context.chapter_id if shot_context else None,
        project_id=body.project_id or (shot_context.project_id if shot_context else None),
    )

    profiles: list[EntityProfileInput] = list(body.entity_profiles)
    profile_source = "request"
    if not profiles and project_id:
        profiles = await load_project_entity_profiles(db, project_id=project_id)
        profile_source = "project"
    cards = build_profile_cards(profiles, source=profile_source)

    categories = resolve_requested_categories(body.categories)
    if asset_only and not body.categories:
        # 帧槽位（首/尾/关键帧）需要镜头文本，资产级默认不出
        categories = [c for c in categories if str(c.value) not in FRAME_SLOT_CATEGORIES]
        asset_only_note = (
            "本次为资产级生成（没有镜头文本），已只生成资产槽位（角色/场景/服装正侧视图）；"
            "首帧/尾帧/关键帧提示词请在镜头页生成。"
        )
    else:
        asset_only_note = ""
    if not categories:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="没有可生成的槽位类别，请检查 categories 取值。",
        )

    project_context = render_project_context(
        project_name=shot_context.project_name if shot_context else "",
        style=shot_context.style if shot_context else "",
        visual_style=shot_context.visual_style if shot_context else "",
    )

    warnings: list[str] = []
    if asset_only_note:
        warnings.append(asset_only_note)
    if not cards:
        warnings.append("本次没有可用的实体画像卡，图片提示词只依据镜头文本生成，实体一致性可能较弱。")

    target, target_warning = await _try_resolve_target(db, needed=llm_caller is None)

    if llm_caller is not None:
        return await _run_with_caller(
            llm_caller=llm_caller,
            shot_id=shot_id,
            project_id=project_id,
            shot_text=shot_text,
            categories=categories,
            cards=cards,
            project_context=project_context,
            body=body,
            target=target,
            warnings=warnings,
        )

    if dry_run.dry_run_enabled():
        slots, dry_warnings = build_dry_run_slots(
            categories=categories,
            cards=cards,
            shot_text=shot_text,
            global_negative=body.negative_prompt,
        )
        warnings.extend(dry_warnings)
        if target_warning:
            warnings.append(target_warning)
        return ImagePromptPreviewRead(
            shot_id=shot_id,
            project_id=project_id,
            shot_text_chars=len(shot_text),
            slots=slots,
            entity_cards=cards,
            warnings=warnings,
            meta=build_run_meta(
                target=target,
                llm_called=False,
                raw_output_chars=0,
                dry_run_reason=dry_run.short_status(),
            ),
        )

    if target is None:  # pragma: no cover
        target, _ = await _try_resolve_target(db, needed=True)

    prompt = _build_prompt(
        categories=categories,
        cards=cards,
        shot_text=shot_text,
        project_context=project_context,
        body=body,
    )
    try:
        completion = await call_text_llm(prompt, target=target)
    except LLMRequestError as exc:
        raise_llm_failure(exc)
        raise  # pragma: no cover

    slots, slot_warnings = _parse_and_build_slots(
        raw_text=completion.text,
        categories=categories,
        cards=cards,
        shot_text=shot_text,
        global_negative=body.negative_prompt,
    )
    warnings.extend(slot_warnings)
    return ImagePromptPreviewRead(
        shot_id=shot_id,
        project_id=project_id,
        shot_text_chars=len(shot_text),
        slots=slots,
        entity_cards=cards,
        warnings=warnings,
        meta=build_run_meta(
            target=target,
            llm_called=True,
            latency_ms=completion.latency_ms,
            raw_output_chars=len(completion.text),
        ),
    )


def _build_prompt(
    *,
    categories: list[PromptCategory],
    cards: list[EntityProfileCardRead],
    shot_text: str,
    project_context: str,
    body: ImagePromptPreviewRequest,
) -> str:
    extra = str(body.extra_instructions or "").strip()
    return IMAGE_PROMPT_TEMPLATE.safe_substitute(
        slot_list=build_slot_list_text(categories),
        entity_profiles=render_profile_cards(cards),
        shot_text=shot_text or ASSET_ONLY_SHOT_TEXT,
        project_context=project_context,
        style_hint=str(body.style_hint or "").strip() or "（未指定，按项目风格）",
        negative_prompt=str(body.negative_prompt or "").strip() or DEFAULT_NEGATIVE_PROMPT,
    ) + (f"\n\n附加要求：{extra}" if extra else "")


def _parse_and_build_slots(
    *,
    raw_text: str,
    categories: list[PromptCategory],
    cards: list[EntityProfileCardRead],
    shot_text: str,
    global_negative: str,
) -> tuple[list[ImagePromptSlotRead], list[str]]:
    try:
        parsed, repairs = parse_json_object_with_repairs(raw_text)
        slots, warnings = postprocess_slots(
            parsed=parsed,
            categories=categories,
            cards=cards,
            shot_text=shot_text,
            global_negative=global_negative,
        )
    except JSONParseError as exc:
        raise_parse_failure(exc, raw_text=raw_text)
        raise  # pragma: no cover
    if repairs:
        warnings.insert(0, f"模型输出经 JSON 抢救后解析成功：{'、'.join(repairs)}。")
    return slots, warnings


async def _try_resolve_target(
    db: AsyncSession,
    *,
    needed: bool,
) -> tuple[TextLLMTarget | None, str | None]:
    try:
        return await resolve_text_llm_target(db), None
    except HTTPException as exc:
        if needed and not dry_run.dry_run_enabled():
            raise
        return None, f"未能解析默认文本模型配置：{exc.detail}"


async def _run_with_caller(
    *,
    llm_caller: TextLLMCaller,
    shot_id: str | None,
    project_id: str | None,
    shot_text: str,
    categories: list[PromptCategory],
    cards: list[EntityProfileCardRead],
    project_context: str,
    body: ImagePromptPreviewRequest,
    target: TextLLMTarget | None,
    warnings: list[str],
) -> ImagePromptPreviewRead:
    prompt = _build_prompt(
        categories=categories,
        cards=cards,
        shot_text=shot_text,
        project_context=project_context,
        body=body,
    )
    raw_text = await llm_caller(prompt)
    slots, slot_warnings = _parse_and_build_slots(
        raw_text=raw_text,
        categories=categories,
        cards=cards,
        shot_text=shot_text,
        global_negative=body.negative_prompt,
    )
    warnings = [*warnings, *slot_warnings]
    return ImagePromptPreviewRead(
        shot_id=shot_id,
        project_id=project_id,
        shot_text_chars=len(shot_text),
        slots=slots,
        entity_cards=cards,
        warnings=warnings,
        meta=build_run_meta(
            target=target,
            llm_called=True,
            raw_output_chars=len(raw_text),
        ),
    )


__all__ = [
    "assemble_image_prompt",
    "build_dry_run_slots",
    "build_slot_layers",
    "pick_entity_for_slot",
    "postprocess_slots",
    "preview_image_prompts",
    "resolve_requested_categories",
]
