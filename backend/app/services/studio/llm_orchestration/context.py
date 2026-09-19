"""编排服务的上下文装配：把 DB 里的章节/镜头/实体画像整理成提示词可用的稳定结构。

这一层是**只读**的：只 select，不 add / update / delete，符合"LLM 结果只预览、不落库"的约束。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.studio import (
    Chapter,
    Character,
    Costume,
    ProjectCostumeLink,
    ProjectPropLink,
    ProjectSceneLink,
    Project,
    Prop,
    Scene,
    Shot,
)
from app.services.common import entity_not_found
from app.schemas.studio.llm_orchestration import EntityProfileCardRead, EntityProfileInput

MAX_ENTITY_PROFILES = 60
MAX_PROFILE_CHARS = 600
MAX_SOURCE_CHARS = 24000

ENTITY_TYPE_ZH: dict[str, str] = {
    "character": "角色",
    "scene": "场景",
    "prop": "道具",
    "costume": "服装",
    "actor": "演员",
}


@dataclass(slots=True)
class ChapterSource:
    chapter_id: str
    project_id: str
    title: str
    text: str


@dataclass(slots=True)
class ShotContext:
    shot_id: str
    chapter_id: str
    project_id: str
    title: str
    script_excerpt: str
    style: str
    visual_style: str
    project_name: str


def _clip(text: Any, limit: int) -> str:
    value = str(text or "").strip()
    if len(value) <= limit:
        return value
    return value[:limit].rstrip() + "…（已截断）"


def profile_canonical_subject(*, name: str, entity_type: str, profile: str) -> str:
    """确定性画像卡主体描述：同一实体在所有槽位共用同一段文字。"""
    type_zh = ENTITY_TYPE_ZH.get(entity_type, entity_type or "实体")
    body = str(profile or "").strip() or "外观信息不足，需人工补充"
    return f"{name}（{type_zh}）：{body}"


def build_profile_card(profile: EntityProfileInput, *, source: str = "request") -> EntityProfileCardRead:
    """把一条画像输入转成画像卡（含确定性主体描述）。"""
    entity_type = str(profile.entity_type or "character").strip().lower()
    merged_profile = "；".join(
        part
        for part in (
            str(profile.profile or "").strip(),
            str(profile.base_prompt or "").strip(),
            str(profile.image_prompt or "").strip(),
        )
        if part
    )
    return EntityProfileCardRead(
        name=str(profile.name).strip(),
        entity_type=entity_type,
        source=source,  # type: ignore[arg-type]
        profile=_clip(merged_profile, MAX_PROFILE_CHARS),
        canonical_subject=profile_canonical_subject(
            name=str(profile.name).strip(),
            entity_type=entity_type,
            profile=_clip(merged_profile, MAX_PROFILE_CHARS),
        ),
    )


def build_profile_cards(
    profiles: list[EntityProfileInput],
    *,
    source: str = "request",
) -> list[EntityProfileCardRead]:
    """批量生成画像卡，按名称去重（先到先得）。"""
    cards: list[EntityProfileCardRead] = []
    seen: set[str] = set()
    for profile in profiles:
        key = str(profile.name or "").strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        cards.append(build_profile_card(profile, source=source))
    return cards


def render_profile_cards(cards: list[EntityProfileCardRead]) -> str:
    """渲染成提示词里的画像卡段落。"""
    if not cards:
        return "（本次未提供实体画像卡；请只依据镜头文本推断主体，不要编造具体人名与外观细节。）"
    lines = []
    for card in cards:
        lines.append(f"- 画像卡主体描述（必须逐字使用）：{card.canonical_subject}")
    return "\n".join(lines)


async def load_chapter_source(db: AsyncSession, chapter_id: str) -> ChapterSource:
    """读取章节原文（优先精简后的 condensed_text）。"""
    chapter = await db.get(Chapter, chapter_id)
    if chapter is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=entity_not_found("Chapter"))
    raw = str(chapter.condensed_text or "").strip() or str(chapter.raw_text or "").strip()
    return ChapterSource(
        chapter_id=chapter.id,
        project_id=chapter.project_id,
        title=chapter.title or "",
        text=_clip(raw, MAX_SOURCE_CHARS),
    )


async def load_shot_context(db: AsyncSession, shot_id: str) -> ShotContext:
    """读取镜头上下文（含所属章节与项目风格）。"""
    shot = await db.get(Shot, shot_id)
    if shot is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=entity_not_found("Shot"))
    chapter = await db.get(Chapter, shot.chapter_id)
    if chapter is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"{entity_not_found('Chapter')} for shot")
    project = await db.get(Project, chapter.project_id)
    return ShotContext(
        shot_id=shot.id,
        chapter_id=chapter.id,
        project_id=chapter.project_id,
        title=shot.title or "",
        script_excerpt=str(shot.script_excerpt or "").strip(),
        style=str(getattr(project, "style", "") or ""),
        visual_style=str(getattr(project, "visual_style", "") or ""),
        project_name=str(getattr(project, "name", "") or ""),
    )


async def resolve_project_id(
    db: AsyncSession,
    *,
    shot_id: str | None,
    chapter_id: str | None,
    project_id: str | None,
) -> str | None:
    """按 显式 project_id → shot → chapter 的顺序推断项目 ID。"""
    if project_id:
        return project_id
    if shot_id:
        shot = await db.get(Shot, shot_id)
        if shot is not None:
            chapter = await db.get(Chapter, shot.chapter_id)
            if chapter is not None:
                return chapter.project_id
    if chapter_id:
        chapter = await db.get(Chapter, chapter_id)
        if chapter is not None:
            return chapter.project_id
    return None


async def load_project_entity_profiles(
    db: AsyncSession,
    *,
    project_id: str,
    limit: int = MAX_ENTITY_PROFILES,
) -> list[EntityProfileInput]:
    """装载项目内的实体画像：角色（项目内）+ 场景/道具/服装（项目关联）。"""
    profiles: list[EntityProfileInput] = []

    character_rows = (
        (await db.execute(select(Character).where(Character.project_id == project_id).order_by(Character.id)))
        .scalars()
        .all()
    )
    for row in character_rows:
        profiles.append(
            EntityProfileInput(
                name=row.name,
                entity_type="character",
                profile=_clip(row.description, MAX_PROFILE_CHARS),
            )
        )

    scene_rows = (
        (
            await db.execute(
                select(Scene)
                .join(ProjectSceneLink, ProjectSceneLink.scene_id == Scene.id)
                .where(ProjectSceneLink.project_id == project_id)
                .order_by(Scene.id)
            )
        )
        .scalars()
        .all()
    )
    for row in scene_rows:
        profiles.append(
            EntityProfileInput(name=row.name, entity_type="scene", profile=_clip(row.description, MAX_PROFILE_CHARS))
        )

    prop_rows = (
        (
            await db.execute(
                select(Prop)
                .join(ProjectPropLink, ProjectPropLink.prop_id == Prop.id)
                .where(ProjectPropLink.project_id == project_id)
                .order_by(Prop.id)
            )
        )
        .scalars()
        .all()
    )
    for row in prop_rows:
        profiles.append(
            EntityProfileInput(name=row.name, entity_type="prop", profile=_clip(row.description, MAX_PROFILE_CHARS))
        )

    costume_rows = (
        (
            await db.execute(
                select(Costume)
                .join(ProjectCostumeLink, ProjectCostumeLink.costume_id == Costume.id)
                .where(ProjectCostumeLink.project_id == project_id)
                .order_by(Costume.id)
            )
        )
        .scalars()
        .all()
    )
    for row in costume_rows:
        profiles.append(
            EntityProfileInput(name=row.name, entity_type="costume", profile=_clip(row.description, MAX_PROFILE_CHARS))
        )

    return profiles[:limit]


def render_project_context(
    *,
    project_name: str = "",
    style: str = "",
    visual_style: str = "",
) -> str:
    """渲染项目上下文段落。"""
    lines: list[str] = []
    if project_name:
        lines.append(f"项目：{project_name}")
    if style:
        lines.append(f"题材风格：{style}")
    if visual_style:
        lines.append(f"画面表现形式：{visual_style}")
    return "\n".join(lines) if lines else "（无项目上下文）"
