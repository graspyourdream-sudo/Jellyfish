"""剧情广告项目的**阶段判定**（服务端派生，不落库）。

为什么派生而不是存一列
======================

"当前走到哪一步"完全由既有事实决定：商品卡确认了吗 → 完整剧情有了吗 → 分镜有了吗 →
策划确认落库了吗 → 资产开始生产了吗。存一列状态早晚会和事实漂移（页面能改数据忘了改状态），
所以这里**每次读时算**，页面刷新/换设备/后端重启都会得到同一个答案 —— 这正是
"刷新或重新打开后仍回到该项目的正确阶段"的实现处。

用户语言（页面直接用）
======================

状态不对外暴露枚举原文，统一给中文说明（`AD_PHASE_LABELS`）：
待补充商品资料 / 待生成详细剧情 / 待生成分镜 / 待确认策划 / 已确认策划（可进入资产准备）。
"""

from __future__ import annotations

from typing import Iterable

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.studio import (
    Chapter,
    Character,
    CharacterImage,
    Costume,
    CostumeImage,
    Product,
    ProductImage,
    ProjectCostumeLink,
    ProjectProductLink,
    ProjectPropLink,
    ProjectSceneLink,
    Prop,
    PropImage,
    Scene,
    SceneImage,
)
from app.models.studio_ad_flow import ProductCard
from app.models.studio_drama_plan import DramaPlanDraft

PROJECT_KIND_DRAMA = "drama"
PROJECT_KIND_AD = "ad"

#: 阶段枚举（后端内部与接口字段值）
AD_PHASE_PRODUCT = "product"       # 商品卡还没确认
AD_PHASE_STORY = "story"           # 有商品卡，还没完整剧情
AD_PHASE_STORYBOARD = "storyboard"  # 有完整剧情，还没分镜
AD_PHASE_READY = "ready"           # 都齐了，等用户确认策划
AD_PHASE_CONFIRMED = "confirmed"   # 已确认落库
AD_PHASE_PRODUCTION = "production"  # 已确认且资产已开始生产（有图片）

#: 阶段 → 用户语言（页面不写第二套映射）
AD_PHASE_LABELS: dict[str, str] = {
    AD_PHASE_PRODUCT: "待补充商品资料",
    AD_PHASE_STORY: "待生成详细剧情",
    AD_PHASE_STORYBOARD: "待生成分镜",
    AD_PHASE_READY: "待确认策划",
    AD_PHASE_CONFIRMED: "已确认策划，可进入资产准备",
    AD_PHASE_PRODUCTION: "已进入生产",
}

#: 阶段顺序（页面画进度条用；只对 kind=ad 有意义）
AD_PHASE_ORDER: tuple[str, ...] = (
    AD_PHASE_PRODUCT,
    AD_PHASE_STORY,
    AD_PHASE_STORYBOARD,
    AD_PHASE_READY,
    AD_PHASE_CONFIRMED,
    AD_PHASE_PRODUCTION,
)


def phase_label(phase: str) -> str:
    """阶段的中文说明（未知值原样返回，不假装认得）。"""
    return AD_PHASE_LABELS.get(phase, phase)


async def _first_chapter(db: AsyncSession, project_id: str) -> Chapter | None:
    return (
        await db.execute(
            select(Chapter).where(Chapter.project_id == project_id).order_by(Chapter.index).limit(1)
        )
    ).scalars().first()


async def _has_any_asset_image(db: AsyncSession, project_id: str) -> bool:
    """项目里是否已经有任意一张资产图（**深判**：只给项目详情用，列表不用它）。

    用"有没有图"当"进入生产"的判据：确认落库只是把资料写进库，真正的生产动作是出图/定版。
    图片表按资产类型分开，归属表达也不同（角色直接带 project_id，其余靠 project_*_links），
    所以这里按各自的归属方式各数一次（五类，含商品）。任一类有图即视为已进入生产。
    """
    # 1) 角色：`characters.project_id` 直接归属
    character_images = await db.scalar(
        select(func.count())
        .select_from(CharacterImage)
        .join(Character, Character.id == CharacterImage.character_id)
        .where(Character.project_id == project_id, CharacterImage.file_id.is_not(None))
    )
    if int(character_images or 0) > 0:
        return True

    # 2) 场景 / 道具 / 服装：全库资产，归属靠 `project_*_links`
    for link_model, image_model, asset_model, asset_field in (
        (ProjectSceneLink, SceneImage, Scene, "scene_id"),
        (ProjectPropLink, PropImage, Prop, "prop_id"),
        (ProjectCostumeLink, CostumeImage, Costume, "costume_id"),
    ):
        count = await db.scalar(
            select(func.count())
            .select_from(image_model)
            .join(asset_model, asset_model.id == getattr(image_model, asset_field))
            .join(link_model, getattr(link_model, asset_field) == asset_model.id)
            .where(link_model.project_id == project_id, image_model.file_id.is_not(None))
        )
        if int(count or 0) > 0:
            return True

    # 3) 商品：同样是全局资产，归属靠 `project_product_links`（三档作用域）
    product_images = await db.scalar(
        select(func.count())
        .select_from(ProductImage)
        .join(ProjectProductLink, ProjectProductLink.product_id == ProductImage.product_id)
        .where(ProjectProductLink.project_id == project_id, ProductImage.file_id.is_not(None))
    )
    return int(product_images or 0) > 0


async def resolve_ad_phase(db: AsyncSession, *, project_id: str, deep: bool = False) -> str:
    """算出剧情广告项目当前阶段；非广告项目由调用方跳过（返回空串）。

    ``deep=False``（列表用）只看卡/草稿/分镜三类事实；
    ``deep=True``（项目详情用）再加一次"有没有资产图"的判定，用来区分"已确认"与"已进入生产"。
    """
    card = await db.get(ProductCard, project_id)
    if card is None or not card.confirmed:
        return AD_PHASE_PRODUCT

    chapter = await _first_chapter(db, project_id)
    if chapter is None:
        # 创建时就建了默认章节；真丢了章节说明数据异常，按资料阶段处理并让页面提示重建
        return AD_PHASE_PRODUCT

    draft = await db.get(DramaPlanDraft, chapter.id)
    plan = dict(draft.plan or {}) if draft is not None else {}
    story = dict(plan.get("story") or {})
    if not str(story.get("full_text") or "").strip():
        return AD_PHASE_STORY
    if not list(plan.get("shots") or []):
        return AD_PHASE_STORYBOARD

    confirmed = str(getattr(draft, "story_status", "") or "") == "confirmed" or getattr(draft, "materialized_at", None) is not None
    if not confirmed:
        return AD_PHASE_READY
    if deep and await _has_any_asset_image(db, project_id):
        return AD_PHASE_PRODUCTION
    return AD_PHASE_CONFIRMED


async def ad_phase_map(db: AsyncSession, project_ids: Iterable[str]) -> dict[str, str]:
    """批量算阶段（列表用）：只对**广告项目**的 id 调用，避免给普通项目白跑查询。"""
    result: dict[str, str] = {}
    for project_id in project_ids:
        result[project_id] = await resolve_ad_phase(db, project_id=project_id, deep=False)
    return result


__all__ = [
    "AD_PHASE_CONFIRMED",
    "AD_PHASE_LABELS",
    "AD_PHASE_ORDER",
    "AD_PHASE_PRODUCTION",
    "AD_PHASE_PRODUCT",
    "AD_PHASE_READY",
    "AD_PHASE_STORY",
    "AD_PHASE_STORYBOARD",
    "PROJECT_KIND_AD",
    "PROJECT_KIND_DRAMA",
    "ad_phase_map",
    "phase_label",
    "resolve_ad_phase",
]
