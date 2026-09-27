"""分镜准备页聚合状态服务。"""

from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.studio.cast import ShotCharacterLinkCreate
from app.schemas.studio.shots import ProjectAssetLinkCreate
from app.schemas.studio.shots import (
    ActionBeatPhaseRead,
    ShotDialogLineRead,
    ShotExtractedDialogueCandidateRead,
    ShotPreparationLinkEntityType,
    ShotPreparationStateRead,
)
from app.services.common import invalid_choice
from app.services.studio.action_beats import infer_action_beat_sequence
from app.services.studio.shot_assets import create_project_asset_link
from app.services.studio.shot_details import get as get_shot_detail
from app.services.studio.shot_character_links import list_by_shot as list_shot_character_links, upsert as upsert_shot_character_link
from app.services.studio.shot_assets_overview import get_shot_assets_overview
from app.services.studio.shot_dialogs import list_by_shot as list_saved_dialog_lines_by_shot
from app.services.studio.shot_extracted_dialogue_candidates import list_by_shot as list_dialogue_candidates_by_shot
from app.services.studio.shots import build_shot_read, get as get_shot

#: 准备页里"走项目-章节-镜头资产关联表"的实体类型 → ``create_project_asset_link`` 的 entity_type。
#:
#: 为什么显式列出、而不是"不是角色就走资产关联"的兜底：兜底会把**未知类型**原样透传给
#: ``shot_assets._link_spec``，那边只能回一句 invalid_choice，出错点离调用处很远。
#: 显式表还有个好处：新增类型漏登记时，这里第一时间报出具体是哪个类型没接。
#: 商品（product）落 ``project_product_links``，与场景/道具/服装同一条路径。
_ASSET_LINK_ENTITY_TYPES: dict[ShotPreparationLinkEntityType, str] = {
    ShotPreparationLinkEntityType.scene: "scene",
    ShotPreparationLinkEntityType.prop: "prop",
    ShotPreparationLinkEntityType.costume: "costume",
    ShotPreparationLinkEntityType.product: "product",
}


async def build_shot_preparation_state(
    db: AsyncSession,
    *,
    shot_id: str,
) -> ShotPreparationStateRead:
    """组装分镜准备页所需的统一聚合状态。"""
    shot = await get_shot(db, shot_id=shot_id)
    shot_read = await build_shot_read(db, shot=shot)
    detail = await get_shot_detail(db, shot_id=shot_id)
    assets_overview = await get_shot_assets_overview(db, shot_id=shot_id)
    dialogue_candidates = [
        ShotExtractedDialogueCandidateRead.model_validate(row)
        for row in await list_dialogue_candidates_by_shot(db, shot_id=shot_id)
    ]
    saved_dialogue_lines = [
        ShotDialogLineRead.model_validate(row)
        for row in await list_saved_dialog_lines_by_shot(db, shot_id=shot_id)
    ]
    pending_confirm_count = (
        int(assets_overview.summary.pending_count or 0)
        + int(shot_read.extraction.pending_dialogue_count or 0)
    )
    basic_info_ready = bool((shot_read.title or "").strip()) and bool((shot_read.script_excerpt or "").strip())
    semantic_defaults_ready = bool(detail.camera_shot) and bool(detail.angle) and bool(detail.movement) and int(detail.duration or 0) > 0
    action_beats_count = len([item for item in (detail.action_beats or []) if (item or "").strip()])
    action_beats_ready = action_beats_count > 0
    action_beat_phases = [
        ActionBeatPhaseRead(text=item.text, phase=item.phase)
        for item in infer_action_beat_sequence(detail.action_beats)
    ]
    ready_for_generation = (
        shot_read.status.value == "ready"
        and basic_info_ready
        and semantic_defaults_ready
        and action_beats_ready
    )
    return ShotPreparationStateRead(
        shot=shot_read,
        assets_overview=assets_overview,
        dialogue_candidates=dialogue_candidates,
        saved_dialogue_lines=saved_dialogue_lines,
        pending_confirm_count=pending_confirm_count,
        basic_info_ready=basic_info_ready,
        semantic_defaults_ready=semantic_defaults_ready,
        action_beats_ready=action_beats_ready,
        action_beats_count=action_beats_count,
        action_beat_phases=action_beat_phases,
        ready_for_generation=ready_for_generation,
    )


async def link_existing_asset_for_preparation(
    db: AsyncSession,
    *,
    project_id: str,
    chapter_id: str,
    shot_id: str,
    entity_type: ShotPreparationLinkEntityType | str,
    linked_entity_id: str,
) -> ShotPreparationStateRead:
    """在准备页内关联现有实体，并返回最新准备态。"""
    entity_type_value = (
        entity_type
        if isinstance(entity_type, ShotPreparationLinkEntityType)
        else ShotPreparationLinkEntityType(entity_type)
    )
    if entity_type_value == ShotPreparationLinkEntityType.character:
        links = await list_shot_character_links(db, shot_id=shot_id)
        max_index = max((int(link.index or 0) for link in links), default=-1)
        await upsert_shot_character_link(
            db,
            body=ShotCharacterLinkCreate(
                shot_id=shot_id,
                character_id=linked_entity_id,
                index=max_index + 1,
            ),
        )
    else:
        link_entity_type = _ASSET_LINK_ENTITY_TYPES.get(entity_type_value)
        if link_entity_type is None:  # pragma: no cover - 枚举已收口，这里只防新增成员漏登记
            # 出错信息列的是**接口整体接受的取值**（含 character），而不是本表缺的那一项：
            # 调用方要的是"能用什么"，不是"内部哪张表没登记"。
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=invalid_choice("entity_type", [item.value for item in ShotPreparationLinkEntityType]),
            )
        await create_project_asset_link(
            db,
            entity_type=link_entity_type,
            body=ProjectAssetLinkCreate(
                project_id=project_id,
                chapter_id=chapter_id,
                shot_id=shot_id,
                asset_id=linked_entity_id,
            ),
        )
    return await build_shot_preparation_state(db, shot_id=shot_id)
