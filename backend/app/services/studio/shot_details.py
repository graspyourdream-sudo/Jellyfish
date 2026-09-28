"""镜头细节服务：ShotDetail 的分页查询与 CRUD。"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.utils import apply_order, paginate
from app.models.studio import Scene, Shot, ShotDetail
from app.models.types import CameraAngle, CameraMovement, CameraShotType, VFXType
from app.schemas.common import ApiResponse, PaginatedData, paginated_response
from app.schemas.studio.shots import ShotDetailCreate, ShotDetailRead, ShotDetailUpdate
from app.services.studio.product_guardrails import (
    validate_product_text_fields,
    validate_video_prompt_source,
)
from app.services.common import (
    create_and_refresh,
    delete_if_exists,
    entity_already_exists,
    entity_not_found,
    ensure_not_exists,
    flush_and_refresh,
    get_or_404,
    patch_model,
    require_entity,
    require_optional_entity,
)
from app.services.studio.shot_extracted_candidates import mark_linked_by_name, mark_pending_by_linked_entity


async def list_paginated(
    db: AsyncSession,
    *,
    shot_id: str | None,
    order: str | None,
    is_desc: bool,
    page: int,
    page_size: int,
    allow_fields: set[str],
) -> ApiResponse[PaginatedData[ShotDetailRead]]:
    """分页查询镜头细节。"""
    stmt = select(ShotDetail)
    if shot_id is not None:
        stmt = stmt.where(ShotDetail.id == shot_id)
    stmt = apply_order(
        stmt,
        model=ShotDetail,
        order=order,
        is_desc=is_desc,
        allow_fields=allow_fields,
        default="id",
    )
    items, total = await paginate(db, stmt=stmt, page=page, page_size=page_size)
    return paginated_response(
        [ShotDetailRead.model_validate(x) for x in items],
        page=page,
        page_size=page_size,
        total=total,
    )


def build_default_detail(shot_id: str) -> ShotDetail:
    """给新建镜头配一份默认细节行（与「AI 拆分镜」写入时的取值保持一致）。

    为什么必须有这一步：`ShotDetail` 与 `Shot` 是 1:1 共享主键，但
    `POST /studio/shots`（页面「创建分镜」）此前**只写 Shot**，于是手工建的镜头
    永远没有细节行 —— 后续整条链路（PATCH 提示词、参考帧创建、
    就绪判定）全部 404 / 400，而页面上看不出原因。默认值与
    `script_division` 里拆分镜时的取值相同，保证两条入口产物一致。
    这里**不写** ``audio_file_id``：角色声音绑在人物资产上（第 2 步），
    本行只保留镜头级唯一的合法声明 ``audio_opt_out``。
    """
    return ShotDetail(
        id=shot_id,
        camera_shot=CameraShotType.ms,
        angle=CameraAngle.eye_level,
        movement=CameraMovement.static,
        follow_atmosphere=True,
        vfx_type=VFXType.none,
        duration=4,
    )


async def create(
    db: AsyncSession,
    *,
    body: ShotDetailCreate,
) -> ShotDetail:
    """创建镜头细节。"""
    await ensure_not_exists(db, ShotDetail, body.id, detail=entity_already_exists("ShotDetail"))
    await require_entity(db, Shot, body.id, detail=entity_not_found("Shot"), status_code=400)
    await require_optional_entity(db, Scene, body.scene_id, detail=entity_not_found("Scene"), status_code=400)
    return await create_and_refresh(db, ShotDetail(**body.model_dump()))


async def get(
    db: AsyncSession,
    *,
    shot_id: str,
) -> ShotDetail:
    """获取镜头细节。"""
    return await get_or_404(db, ShotDetail, shot_id, detail=entity_not_found("ShotDetail"))


async def update(
    db: AsyncSession,
    *,
    shot_id: str,
    body: ShotDetailUpdate,
) -> ShotDetail:
    """更新镜头细节。

    声音侧只接受 ``audio_opt_out``（本镜明确无需声音）。``audio_file_id`` 不在更新契约里，
    因此**本函数没有任何路径**能新建 / 改写一条逐镜角色声音：角色声音的唯一事实来源是
    人物资产，选择 / 更换只在第 2 步「人物资产详情」发生。
    """
    obj = await get_or_404(db, ShotDetail, shot_id, detail=entity_not_found("ShotDetail"))
    update_data = body.model_dump(exclude_unset=True)

    # 产物护栏（见 product_guardrails）：
    # 1) 来源必须是真实来源，模板拼装不得冒用 llm；
    # 2) 演练占位文本不得写入正式产物字段。
    if "video_prompt_source" in update_data:
        update_data["video_prompt_source"] = validate_video_prompt_source(update_data.get("video_prompt_source"))
    validate_product_text_fields(update_data)

    # 声音只有一个写入口：本镜的「无需声音」声明（镜头级唯一的合法字段）。
    # 角色声音属于**人物资产**（第 2 步「人物资产详情」是全站唯一绑定入口），
    # 所以这里不再有"绑定音频 → 清掉无需声音"的反向联动：更新契约里
    # 已经没有 audio_file_id，普通调用方无法再建立 / 改写一条逐镜角色声音。
    #
    # 置 true **只更新这个开关本身**，不动 ``audio_file_id``：
    # 那一列是迁移 009 之前留下的**历史兼容快照**，属于用户既有数据，不是本开关的附属物。
    # 生效结论由生成侧按优先级解析（``resolve_audio_admission``：
    # ``audio_opt_out`` → 人物资产音色 → 历史快照 → 无），
    # 所以"本镜不带声音"已经由 opt_out 这一条保证，不需要（也不应该）破坏快照。
    # 用户把开关关回去时，快照还在，解析会重新按「人物资产声音 → 历史快照」的顺序走。
    # 见 tests/test_audio_opt_out.py 的三条用例。

    old_scene_id = obj.scene_id
    scene_obj = None
    if "scene_id" in update_data:
        scene_obj = await require_optional_entity(
            db,
            Scene,
            update_data["scene_id"],
            detail=entity_not_found("Scene"),
            status_code=400,
        )
    patch_model(obj, update_data)
    obj = await flush_and_refresh(db, obj)
    if "scene_id" in update_data and old_scene_id and old_scene_id != obj.scene_id:
        await mark_pending_by_linked_entity(
            db,
            shot_id=shot_id,
            candidate_type="scene",
            linked_entity_id=old_scene_id,
        )
    if scene_obj is not None:
        await mark_linked_by_name(
            db,
            shot_id=shot_id,
            candidate_type="scene",
            candidate_name=scene_obj.name,
            linked_entity_id=scene_obj.id,
        )
    return obj


async def delete(
    db: AsyncSession,
    *,
    shot_id: str,
) -> None:
    """删除镜头细节。"""
    await delete_if_exists(db, ShotDetail, shot_id)
