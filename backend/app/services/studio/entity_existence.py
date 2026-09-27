"""实体名称存在性检测服务。"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.studio import (
    Chapter,
    Character,
    Costume,
    Product,
    ProjectCostumeLink,
    ProjectProductLink,
    ProjectPropLink,
    ProjectSceneLink,
    Prop,
    Scene,
    Shot,
    ShotCharacterLink,
)
from app.services.common import relation_mismatch


async def check_names_existence(
    db: AsyncSession,
    *,
    project_id: str,
    shot_id: str | None = None,
    character_names: list[str],
    prop_names: list[str],
    scene_names: list[str],
    costume_names: list[str],
    product_names: list[str] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """批量检测名称是否存在，并返回项目/镜头关联状态。

    ``product_names`` 默认 ``None``（按空列表处理）：商品的第 2 步页面晚于本接口上线，
    已有调用方只会发那四个名称字段，签名必须向后兼容；不传时 ``products`` 桶恒为空列表，
    与"查了但都没命中"区分不开 —— 这是刻意的：桶的语义是"本次询问的商品名字存在性"。
    """

    effective_shot_id = shot_id.strip() if shot_id and str(shot_id).strip() else None
    if effective_shot_id:
        shot_ok = (
            await db.execute(
                select(Shot.id)
                .join(Chapter, Shot.chapter_id == Chapter.id)
                .where(Shot.id == effective_shot_id, Chapter.project_id == project_id)
                .limit(1)
            )
        ).scalar_one_or_none()
        if shot_ok is None:
            raise HTTPException(status_code=404, detail=relation_mismatch("shot_id", "project_id"))

    async def _find_character_id(q: str) -> str | None:
        stmt = (
            select(Character.id)
            .where(Character.project_id == project_id, Character.name.ilike(f"%{q}%"))
            .limit(1)
        )
        row = (await db.execute(stmt)).scalar_one_or_none()
        return str(row) if row is not None else None

    async def _find_asset_id(model: type, q: str) -> str | None:
        stmt = select(getattr(model, "id")).where(getattr(model, "name").ilike(f"%{q}%")).limit(1)
        row = (await db.execute(stmt)).scalar_one_or_none()
        return str(row) if row is not None else None

    async def _find_linked_prop(q: str) -> tuple[int, str] | None:
        stmt = (
            select(ProjectPropLink.id, Prop.id)
            .join(Prop, Prop.id == ProjectPropLink.prop_id)
            .where(ProjectPropLink.project_id == project_id, Prop.name.ilike(f"%{q}%"))
            .limit(1)
        )
        row = (await db.execute(stmt)).first()
        if not row:
            return None
        link_id, prop_id = row
        return int(link_id), str(prop_id)

    async def _find_linked_scene(q: str) -> tuple[int, str] | None:
        stmt = (
            select(ProjectSceneLink.id, Scene.id)
            .join(Scene, Scene.id == ProjectSceneLink.scene_id)
            .where(ProjectSceneLink.project_id == project_id, Scene.name.ilike(f"%{q}%"))
            .limit(1)
        )
        row = (await db.execute(stmt)).first()
        if not row:
            return None
        link_id, scene_id = row
        return int(link_id), str(scene_id)

    async def _find_linked_costume(q: str) -> tuple[int, str] | None:
        stmt = (
            select(ProjectCostumeLink.id, Costume.id)
            .join(Costume, Costume.id == ProjectCostumeLink.costume_id)
            .where(ProjectCostumeLink.project_id == project_id, Costume.name.ilike(f"%{q}%"))
            .limit(1)
        )
        row = (await db.execute(stmt)).first()
        if not row:
            return None
        link_id, costume_id = row
        return int(link_id), str(costume_id)

    async def _find_linked_product(q: str) -> tuple[int, str] | None:
        """商品与场景/道具/服装同形：命中"已关联到本项目"的关联行才回 link_id。

        商品是全局资产（``products`` 没有 project_id），所以"是否已关联本项目"只能看
        ``project_product_links``；关联列的连接口径与 ``entity_specs.LINK_MODEL_BY_ENTITY``
        一致（``product_id``）。
        """
        stmt = (
            select(ProjectProductLink.id, Product.id)
            .join(Product, Product.id == ProjectProductLink.product_id)
            .where(ProjectProductLink.project_id == project_id, Product.name.ilike(f"%{q}%"))
            .limit(1)
        )
        row = (await db.execute(stmt)).first()
        if not row:
            return None
        link_id, product_id = row
        return int(link_id), str(product_id)

    def _empty_item(raw: str) -> dict[str, Any]:
        return {
            "name": raw,
            "exists": False,
            "linked_to_project": False,
            "linked_to_shot": False,
            "asset_id": None,
            "link_id": None,
        }

    characters_out: list[dict[str, Any]] = []
    for name in character_names or []:
        raw = str(name)
        q = raw.strip()
        if not q:
            characters_out.append(_empty_item(raw))
            continue
        char_id = await _find_character_id(q)
        exists = char_id is not None
        characters_out.append(
            {
                "name": raw,
                "exists": exists,
                "linked_to_project": exists,
                "linked_to_shot": False,
                "asset_id": char_id,
                "link_id": None,
            }
        )

    props_out: list[dict[str, Any]] = []
    for name in prop_names or []:
        raw = str(name)
        q = raw.strip()
        if not q:
            props_out.append(_empty_item(raw))
            continue
        linked_row = await _find_linked_prop(q)
        if linked_row is not None:
            link_id, prop_id = linked_row
            props_out.append(
                {
                    "name": raw,
                    "exists": True,
                    "linked_to_project": True,
                    "linked_to_shot": False,
                    "asset_id": prop_id,
                    "link_id": link_id,
                }
            )
            continue
        prop_id = await _find_asset_id(Prop, q)
        props_out.append(
            {
                "name": raw,
                "exists": prop_id is not None,
                "linked_to_project": False,
                "linked_to_shot": False,
                "asset_id": prop_id,
                "link_id": None,
            }
        )

    scenes_out: list[dict[str, Any]] = []
    for name in scene_names or []:
        raw = str(name)
        q = raw.strip()
        if not q:
            scenes_out.append(_empty_item(raw))
            continue
        linked_row = await _find_linked_scene(q)
        if linked_row is not None:
            link_id, scene_id = linked_row
            scenes_out.append(
                {
                    "name": raw,
                    "exists": True,
                    "linked_to_project": True,
                    "linked_to_shot": False,
                    "asset_id": scene_id,
                    "link_id": link_id,
                }
            )
            continue
        scene_id = await _find_asset_id(Scene, q)
        scenes_out.append(
            {
                "name": raw,
                "exists": scene_id is not None,
                "linked_to_project": False,
                "linked_to_shot": False,
                "asset_id": scene_id,
                "link_id": None,
            }
        )

    costumes_out: list[dict[str, Any]] = []
    for name in costume_names or []:
        raw = str(name)
        q = raw.strip()
        if not q:
            costumes_out.append(_empty_item(raw))
            continue
        linked_row = await _find_linked_costume(q)
        if linked_row is not None:
            link_id, costume_id = linked_row
            costumes_out.append(
                {
                    "name": raw,
                    "exists": True,
                    "linked_to_project": True,
                    "linked_to_shot": False,
                    "asset_id": costume_id,
                    "link_id": link_id,
                }
            )
            continue
        costume_id = await _find_asset_id(Costume, q)
        costumes_out.append(
            {
                "name": raw,
                "exists": costume_id is not None,
                "linked_to_project": False,
                "linked_to_shot": False,
                "asset_id": costume_id,
                "link_id": None,
            }
        )

    products_out: list[dict[str, Any]] = []
    for name in product_names or []:
        raw = str(name)
        q = raw.strip()
        if not q:
            products_out.append(_empty_item(raw))
            continue
        linked_row = await _find_linked_product(q)
        if linked_row is not None:
            link_id, product_id = linked_row
            products_out.append(
                {
                    "name": raw,
                    "exists": True,
                    "linked_to_project": True,
                    "linked_to_shot": False,
                    "asset_id": product_id,
                    "link_id": link_id,
                }
            )
            continue
        product_id = await _find_asset_id(Product, q)
        products_out.append(
            {
                "name": raw,
                "exists": product_id is not None,
                "linked_to_project": False,
                "linked_to_shot": False,
                "asset_id": product_id,
                "link_id": None,
            }
        )

    if effective_shot_id:
        char_ids = {r["asset_id"] for r in characters_out if r.get("asset_id")}
        if char_ids:
            stmt = select(ShotCharacterLink.character_id).where(
                ShotCharacterLink.shot_id == effective_shot_id,
                ShotCharacterLink.character_id.in_(char_ids),
            )
            linked_char_ids = {row[0] for row in (await db.execute(stmt)).all()}
            for row in characters_out:
                aid = row.get("asset_id")
                if aid and aid in linked_char_ids:
                    row["linked_to_shot"] = True

        prop_ids = {r["asset_id"] for r in props_out if r.get("asset_id")}
        if prop_ids:
            stmt = select(ProjectPropLink.prop_id).where(
                ProjectPropLink.project_id == project_id,
                ProjectPropLink.shot_id == effective_shot_id,
                ProjectPropLink.prop_id.in_(prop_ids),
            )
            linked_prop_ids = {row[0] for row in (await db.execute(stmt)).all()}
            for row in props_out:
                aid = row.get("asset_id")
                if aid and aid in linked_prop_ids:
                    row["linked_to_shot"] = True

        scene_ids = {r["asset_id"] for r in scenes_out if r.get("asset_id")}
        if scene_ids:
            stmt = select(ProjectSceneLink.scene_id).where(
                ProjectSceneLink.project_id == project_id,
                ProjectSceneLink.shot_id == effective_shot_id,
                ProjectSceneLink.scene_id.in_(scene_ids),
            )
            linked_scene_ids = {row[0] for row in (await db.execute(stmt)).all()}
            for row in scenes_out:
                aid = row.get("asset_id")
                if aid and aid in linked_scene_ids:
                    row["linked_to_shot"] = True

        costume_ids = {r["asset_id"] for r in costumes_out if r.get("asset_id")}
        if costume_ids:
            stmt = select(ProjectCostumeLink.costume_id).where(
                ProjectCostumeLink.project_id == project_id,
                ProjectCostumeLink.shot_id == effective_shot_id,
                ProjectCostumeLink.costume_id.in_(costume_ids),
            )
            linked_costume_ids = {row[0] for row in (await db.execute(stmt)).all()}
            for row in costumes_out:
                aid = row.get("asset_id")
                if aid and aid in linked_costume_ids:
                    row["linked_to_shot"] = True

        product_ids = {r["asset_id"] for r in products_out if r.get("asset_id")}
        if product_ids:
            stmt = select(ProjectProductLink.product_id).where(
                ProjectProductLink.project_id == project_id,
                ProjectProductLink.shot_id == effective_shot_id,
                ProjectProductLink.product_id.in_(product_ids),
            )
            linked_product_ids = {row[0] for row in (await db.execute(stmt)).all()}
            for row in products_out:
                aid = row.get("asset_id")
                if aid and aid in linked_product_ids:
                    row["linked_to_shot"] = True

    return {
        "characters": characters_out,
        "props": props_out,
        "scenes": scenes_out,
        "costumes": costumes_out,
        "products": products_out,
    }
