"""Studio 实体图片 CRUD。

写入侧**不静默替换定版**（用户明确要求）：两条写入路径（create / update）在会顶掉
既有定版图时必须由调用方显式确认（请求体里带 ``confirm_replace_primary=true``），
否则抛结构化 409。判定与摘要只有一份实现，见 ``app/services/studio/primary_protection.py``。
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.utils import apply_order, paginate
from app.services.common import entity_not_found
from app.services.studio.entity_specs import entity_spec, normalize_entity_type
from app.services.studio.primary_protection import (
    PrimaryImageSummary,
    confirm_replace_requested,
    ensure_primary_not_silently_replaced,
)

IMAGE_ORDER_FIELDS = {"id", "quality_level", "view_angle", "created_at", "updated_at"}


def _with_replaced_primary(
    payload: dict[str, Any], replaced: PrimaryImageSummary | None
) -> dict[str, Any]:
    """把「本次替换掉了哪张旧定版图」附到读模型结果上（**只增字段**，脱敏摘要）。

    与 ``/studio/image-pipeline/adopt`` 的 ``replaced_primary`` 同形，页面可以共用一套展示。
    """
    return {**payload, "replaced_primary": replaced.to_read() if replaced else None}


async def list_entity_images_paginated(
    db: AsyncSession,
    *,
    entity_type: str,
    entity_id: str,
    order: str | None,
    is_desc: bool,
    page: int,
    page_size: int,
) -> tuple[list[dict[str, Any]], int]:
    spec = entity_spec(entity_type)
    parent = await db.get(spec.model, entity_id)
    if parent is None:
        raise HTTPException(status_code=404, detail=entity_not_found(spec.model.__name__))

    id_field = getattr(spec.image_model, spec.id_field)
    stmt = select(spec.image_model).where(id_field == entity_id)
    stmt = apply_order(
        stmt,
        model=spec.image_model,
        order=order,
        is_desc=is_desc,
        allow_fields=IMAGE_ORDER_FIELDS,
        default="id",
    )
    items, total = await paginate(db, stmt=stmt, page=page, page_size=page_size)
    payload = [spec.image_read_model.model_validate(x).model_dump() for x in items]
    return payload, total


async def create_entity_image(
    db: AsyncSession,
    *,
    entity_type: str,
    entity_id: str,
    body: dict[str, Any],
) -> dict[str, Any]:
    entity_type_norm = normalize_entity_type(entity_type)
    spec = entity_spec(entity_type_norm)
    parent = await db.get(spec.model, entity_id)
    if parent is None:
        raise HTTPException(status_code=404, detail=entity_not_found(spec.model.__name__))

    parsed = spec.image_create_model.model_validate(body).model_dump()

    # 定版保护：新建的这一行若同时要设为定版，既有定版图就会被顶掉 → 必须显式确认。
    # 判定在 add/flush **之前**：未确认时库里一行都不改。
    replaced_primary = await ensure_primary_not_silently_replaced(
        db,
        image_model=spec.image_model,
        id_field=spec.id_field,
        entity_type=entity_type_norm,
        entity_id=entity_id,
        target_image_id=None,  # 本次会新建一行，不可能是既有定版那一行
        becomes_primary=parsed.get("is_primary") is True,
        replaces_target_file=False,
        confirm_replace_primary=confirm_replace_requested(body),
    )

    obj = spec.image_model(**{spec.id_field: entity_id, **parsed})
    db.add(obj)
    await db.flush()
    await db.refresh(obj)

    if getattr(obj, "is_primary", False):
        # 同一资产至多一张定版主图：把其余行清掉。对所有资产类型生效
        # （此前只对 character 生效，其他四类图片表当时还没有 is_primary 列）。
        parent_field = getattr(spec.image_model, spec.id_field)
        stmt = (
            spec.image_model.__table__.update()
            .where(parent_field == entity_id, spec.image_model.id != obj.id)
            .values(is_primary=False)
        )
        await db.execute(stmt)
        await db.refresh(obj)

    return _with_replaced_primary(
        spec.image_read_model.model_validate(obj).model_dump(), replaced_primary
    )


async def update_entity_image(
    db: AsyncSession,
    *,
    entity_type: str,
    entity_id: str,
    image_id: int,
    body: dict[str, Any],
) -> dict[str, Any]:
    entity_type_norm = normalize_entity_type(entity_type)
    spec = entity_spec(entity_type_norm)
    obj = await db.get(spec.image_model, image_id)
    if obj is None or getattr(obj, spec.id_field) != entity_id:
        raise HTTPException(status_code=404, detail=entity_not_found(spec.image_model.__name__))

    update_data = spec.image_update_model.model_validate(body).model_dump(exclude_unset=True)

    # 定版保护：两种情况会顶掉既有定版图 ——
    #   1) 把这一行设成定版（原定版被降级）；
    #   2) 直接改**定版那一行**的 file_id（把定版图换成另一张）。
    # 显式把 is_primary 关掉（不设新版）不算替换，照旧放行。
    # 判定在 setattr/flush **之前**：未确认时库里一行都不改。
    new_file_id = str(update_data.get("file_id") or "").strip()
    replaced_primary = await ensure_primary_not_silently_replaced(
        db,
        image_model=spec.image_model,
        id_field=spec.id_field,
        entity_type=entity_type_norm,
        entity_id=entity_id,
        target_image_id=obj.id,
        becomes_primary=update_data.get("is_primary") is True,
        replaces_target_file=bool(new_file_id)
        and new_file_id != str(getattr(obj, "file_id", "") or "").strip(),
        confirm_replace_primary=confirm_replace_requested(body),
    )

    for key, value in update_data.items():
        setattr(obj, key, value)
    await db.flush()
    await db.refresh(obj)

    if update_data.get("is_primary") is True:
        parent_field = getattr(spec.image_model, spec.id_field)
        stmt = (
            spec.image_model.__table__.update()
            .where(parent_field == entity_id, spec.image_model.id != obj.id)
            .values(is_primary=False)
        )
        await db.execute(stmt)
        await db.refresh(obj)
    elif update_data.get("is_primary") is False:
        await db.refresh(obj)

    return _with_replaced_primary(
        spec.image_read_model.model_validate(obj).model_dump(), replaced_primary
    )


async def delete_entity_image(
    db: AsyncSession,
    *,
    entity_type: str,
    entity_id: str,
    image_id: int,
) -> None:
    spec = entity_spec(entity_type)
    obj = await db.get(spec.image_model, image_id)
    if obj is None or getattr(obj, spec.id_field) != entity_id:
        return
    await db.delete(obj)
    await db.flush()
