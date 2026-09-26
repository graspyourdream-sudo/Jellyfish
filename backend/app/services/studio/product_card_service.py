"""商品卡的服务端读写（`product_cards`，一项目一张）。

职责边界
========

- **本模块只做读写与确定性计算**（缺项、可确认性、来源元信息）。模型调用与文件解析在
  ``product_extraction``（"从资料提取"那一步），本模块不碰模型、不碰付费出口。
- 商品卡是**服务端事实来源**：页面刷新、切换章节、后端重启后都必须能读回同一份内容
  （契约要求"不能只存在浏览器状态"）。

确定性规则（都写在这里，避免页面各写一套）
==========================================

1. ``missing_fields`` 按 :data:`~app.schemas.studio.product_card.EDITABLE_CARD_FIELDS` 顺序算，
   空值/空列表都算缺（"待补充"），**绝不编造内容**；
2. 只有 :data:`REQUIRED_CARD_FIELDS` 全部非空才允许 ``confirmed=True``，否则 409 并列出缺哪几项；
3. 保存后记录 ``source_summary["manual_saved_at"]``（技术详情展示人工最后保存时间），
   但不覆盖 ``source_type`` —— 来源是"这份资料最初从哪来"，不会因为用户改了几个字就变成"手工"。
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.studio import Project
from app.models.studio_ad_flow import ProductCard
from app.schemas.studio.product_card import (
    CARD_FIELD_LABELS,
    EDITABLE_CARD_FIELDS,
    REQUIRED_CARD_FIELDS,
    ProductCardRead,
    ProductReferenceFile,
)

NOTE_READ = "商品卡是服务端事实来源：刷新、切换章节、重启后端后读回的是同一份内容。"


def _is_blank(value: Any) -> bool:
    """空值判定：None / 空串 / 空列表 / 全空白的列表都算空。"""
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, tuple, set)):
        return all(_is_blank(item) for item in value)
    if isinstance(value, dict):
        return not value
    return False


def compute_missing(fields: dict[str, Any]) -> tuple[list[str], list[str]]:
    """算出缺项键与中文名（顺序稳定，页面可直接渲染）。"""
    missing = [key for key in EDITABLE_CARD_FIELDS if key != "confirmed" and _is_blank(fields.get(key))]
    return missing, [CARD_FIELD_LABELS.get(key, key) for key in missing]


def card_payload(card: ProductCard | None, *, project_id: str, note: str = NOTE_READ) -> dict[str, Any]:
    """ORM 行 → 读模型 dict（没有卡时返回一张空卡的形状，而不是 null）。"""
    if card is None:
        empty = ProductCardRead(project_id=project_id)
        missing, labels = compute_missing({})
        empty.missing_fields = missing
        empty.missing_labels = labels
        return empty.model_dump()
    fields = {
        "name": card.name,
        "category": card.category,
        "brand": card.brand,
        "selling_points": list(card.selling_points or []),
        "audience": card.audience,
        "scenarios": list(card.scenarios or []),
        "price_info": card.price_info,
        "compliance": card.compliance,
        "notes": card.notes,
        "reference_files": list(card.reference_files or []),
    }
    missing, labels = compute_missing(fields)
    return ProductCardRead(
        project_id=card.project_id,
        **fields,
        source_type=card.source_type or "manual",
        confirmed=bool(card.confirmed),
        missing_fields=missing,
        missing_labels=labels,
        source_summary=dict(card.source_summary or {}),
        updated_at=card.updated_at.isoformat() if card.updated_at else "",
        note=note,
    ).model_dump()


async def get_card(db: AsyncSession, *, project_id: str) -> ProductCard | None:
    """读商品卡行（没有返回 None；调用方决定是否兜底成空卡）。"""
    return await db.get(ProductCard, project_id)


async def require_project(db: AsyncSession, project_id: str) -> Project:
    """项目不存在就 404（否则会静默建出一张挂在不存在项目上的卡）。"""
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"项目不存在：{project_id}")
    return project


async def save_card(
    db: AsyncSession,
    *,
    project_id: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """保存商品卡（免费）。``confirmed=True`` 时校验必填项。"""
    await require_project(db, project_id)
    card = await get_card(db, project_id=project_id)
    if card is None:
        card = ProductCard(project_id=project_id)
        db.add(card)

    incoming = {key: value for key, value in payload.items() if key in EDITABLE_CARD_FIELDS}
    merged = {
        "name": incoming.get("name", card.name or ""),
        "category": incoming.get("category", card.category or ""),
        "brand": incoming.get("brand", card.brand or ""),
        "selling_points": list(incoming.get("selling_points", card.selling_points or [])),
        "audience": incoming.get("audience", card.audience or ""),
        "scenarios": list(incoming.get("scenarios", card.scenarios or [])),
        "price_info": incoming.get("price_info", card.price_info or ""),
        "compliance": incoming.get("compliance", card.compliance or ""),
        "notes": incoming.get("notes", card.notes or ""),
        "reference_files": [
            dict(item) if isinstance(item, dict) else ProductReferenceFile.model_validate(item).model_dump()
            for item in incoming.get("reference_files", card.reference_files or [])
        ],
    }
    want_confirm = bool(incoming.get("confirmed", card.confirmed))

    if want_confirm:
        missing_required = [key for key in REQUIRED_CARD_FIELDS if _is_blank(merged.get(key))]
        if missing_required:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "product_card_required_missing",
                    "message": "还不能确认商品卡：" + "、".join(CARD_FIELD_LABELS[key] for key in missing_required) + " 还没填。",
                    "fix": "把必填项补齐后再确认（其余缺项会保留为「待补充」，不会被编造）。",
                    "missing_fields": missing_required,
                },
            )

    for key, value in merged.items():
        setattr(card, key, value)
    card.confirmed = want_confirm
    if incoming:  # 有人工输入才记时间，避免"点开就自动存"造成假的人工编辑痕迹
        summary = dict(card.source_summary or {})
        summary["manual_saved_at"] = datetime.now(timezone.utc).isoformat()
        card.source_summary = summary
    if card.source_type is None or not str(card.source_type).strip():
        card.source_type = "manual"

    await db.flush()
    await db.refresh(card)
    return card_payload(card, project_id=project_id)


async def apply_extraction(
    db: AsyncSession,
    *,
    project_id: str,
    fields: dict[str, Any],
    source_type: str,
    source_summary: dict[str, Any],
) -> dict[str, Any]:
    """把"提取结果"写进商品卡（**不确认**：由用户看过之后自己点确认）。

    提取与剧情生成必须分开：这一步只落商品卡，且 ``confirmed`` 保持 False，
    除非用户此前已经确认过（那时保留确认状态，但缺项会重新计算）。
    """
    await require_project(db, project_id)
    card = await get_card(db, project_id)
    if card is None:
        card = ProductCard(project_id=project_id)
        db.add(card)

    allowed = {key: value for key, value in fields.items() if key in EDITABLE_CARD_FIELDS}
    for key, value in allowed.items():
        setattr(card, key, value)
    card.source_type = source_type if source_type in {"manual", "paste", "upload", "existing"} else "manual"
    summary = dict(card.source_summary or {})
    summary.update(source_summary or {})
    summary["extracted_at"] = datetime.now(timezone.utc).isoformat()
    card.source_summary = summary
    # 提取后重新计算缺项，并把"这次提取仍没拿到的字段"如实记下
    merged = {key: (allowed.get(key, getattr(card, key, None))) for key in EDITABLE_CARD_FIELDS if key != "confirmed"}
    missing, _labels = compute_missing(merged)
    card.missing_fields = missing
    card.confirmed = bool(card.confirmed) and not missing

    await db.flush()
    await db.refresh(card)
    return card_payload(card, project_id=project_id, note="已把提取结果写入商品卡（未确认）。请核对缺项后自行确认。")


__all__ = [
    "NOTE_READ",
    "apply_extraction",
    "card_payload",
    "compute_missing",
    "get_card",
    "require_project",
    "save_card",
]
