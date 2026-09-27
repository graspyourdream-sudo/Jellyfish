"""快捷能力的镜头上下文必须看得见**商品**（第五类资产）—— 含正反两侧与防回退护栏。

背景（缺陷来源，不是推测）：`quick_skill_service._linked_asset_names()` 的资产桶
写死成 ``{"character","scene","prop","costume"}``，而 ``project_product_links.shot_id``
是「这一镜里出现了商品」的**唯一表达**（`Product` / `ProjectProductLink` 的模型口径）。
结果：剧情广告这条链上，快捷能力拿到的镜头上下文里商品被**静默丢掉** ——
不报错、不缺页，只是模型在"不知道有商品"的前提下写提示词。

本文件的五条断言（前三条是正反两侧，后两条是护栏，删掉 product 分支即变红）：

1. **正**：shot 档商品关联存在 → 结构化数据里有商品、文本里有「商品资产：<名>」；
2. **正**：人物与商品同时关联 → 两行都在（不是互相覆盖，也不是只出人物）；
3. **反**：没有商品关联 → ``product`` 桶**存在且为空**（证明"查过了"，不是"漏查"），
   且文本里**不出现**「商品资产」；
4. **反**：商品只挂在 chapter 档（``shot_id`` 为空）→ 不算"这一镜出现商品"
   （与 ``list_shot_linked_assets`` 同口径，不能靠更宽的作用域混进来）；
5. **护栏**：桶键集合恰好是五类；再对源码做一次定点扫描，
   确保 ``("product", ProjectProductLink, "product_id", Product)`` 这一行真的在。

零出网、零付费：内存库（``sqlite+aiosqlite:///:memory:``），不调用任何模型、不出图、不碰正式库。
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models.studio import (
    Chapter,
    Character,
    Product,
    Project,
    ProjectProductLink,
    Shot,
    ShotCharacterLink,
)
from app.services.skills.quick_skill_service import _linked_asset_names, build_shot_context

PROJECT_ID = "proj-quick"
CHAPTER_ID = "chap-quick"
SHOT_ID = "shot-quick"
OTHER_SHOT_ID = "shot-quick-2"
CHARACTER_ID = "char-quick"
PRODUCT_ID = "prod-quick"
PRODUCT_NAME = "焕颜精华"
CHARACTER_NAME = "林小满"

Factory = async_sessionmaker[AsyncSession]

#: 五类资产的桶键（少一个都算回归）。
EXPECTED_BUCKETS = {"character", "scene", "prop", "costume", "product"}


def _build() -> tuple[Factory, Any]:
    from app.core.db import Base
    import app.models  # noqa: F401  导入即注册全部表

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    factory: Factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def _create() -> None:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(_create())
    return factory, engine


def _seed(factory: Factory) -> None:
    """项目 + 章节 + 两个镜头 + 一个人物 + 一个商品（商品先不关联）。"""

    async def run() -> None:
        async with factory() as db:
            db.add(
                Project(
                    id=PROJECT_ID,
                    name="快捷能力测试项目",
                    description="",
                    style="真人都市",
                    visual_style="现实",
                )
            )
            await db.flush()
            db.add(
                Chapter(
                    id=CHAPTER_ID,
                    project_id=PROJECT_ID,
                    index=1,
                    title="第 1 集",
                    raw_text="她拿起焕颜精华。",
                    condensed_text="她拿起焕颜精华。",
                    storyboard_count=2,
                )
            )
            await db.flush()
            db.add(
                Shot(
                    id=SHOT_ID,
                    chapter_id=CHAPTER_ID,
                    index=1,
                    title="镜头 1",
                    script_excerpt="她拿起焕颜精华，对着镜头说话。",
                )
            )
            db.add(
                Shot(
                    id=OTHER_SHOT_ID,
                    chapter_id=CHAPTER_ID,
                    index=2,
                    title="镜头 2",
                    script_excerpt="她把精华放回桌上。",
                )
            )
            await db.flush()
            db.add(
                Character(
                    id=CHARACTER_ID,
                    project_id=PROJECT_ID,
                    name=CHARACTER_NAME,
                    description="",
                    style="真人都市",
                    visual_style="现实",
                )
            )
            db.add(
                Product(
                    id=PRODUCT_ID,
                    name=PRODUCT_NAME,
                    description="白色磨砂瓶身，金色压泵",
                    style="真人都市",
                    visual_style="现实",
                )
            )
            await db.commit()

    asyncio.run(run())


def _link_character(factory: Factory) -> None:
    async def run() -> None:
        async with factory() as db:
            db.add(ShotCharacterLink(shot_id=SHOT_ID, character_id=CHARACTER_ID))
            await db.commit()

    asyncio.run(run())


def _link_product(factory: Factory, *, shot_id: str | None) -> None:
    """挂一条商品关联；``shot_id=None`` 表示只挂在章节档（更宽的作用域）。

    ``project_product_links.id`` 是自增整型主键，不手工指定。
    """

    async def run() -> None:
        async with factory() as db:
            db.add(
                ProjectProductLink(
                    project_id=PROJECT_ID,
                    chapter_id=CHAPTER_ID,
                    shot_id=shot_id,
                    product_id=PRODUCT_ID,
                )
            )
            await db.commit()

    asyncio.run(run())


def _context(factory: Factory, *, shot_id: str = SHOT_ID) -> tuple[str, dict[str, Any]]:
    async def run() -> tuple[str, dict[str, Any]]:
        async with factory() as db:
            return await build_shot_context(db, chapter_id=CHAPTER_ID, shot_id=shot_id)

    return asyncio.run(run())


# ---------------------------------------------------------------------------
# 正：商品必须出现在镜头上下文里
# ---------------------------------------------------------------------------


def test_shot_linked_product_reaches_quick_skill_context() -> None:
    """正：shot 档商品关联 → 结构化数据与可读文本里都要有商品。"""
    factory, engine = _build()
    _seed(factory)
    _link_product(factory, shot_id=SHOT_ID)
    try:
        text, data = _context(factory)
        assets = (data.get("shot") or {}).get("assets") or {}
        assert assets.get("product") == [PRODUCT_NAME], assets
        assert f"商品资产：{PRODUCT_NAME}" in text, text
    finally:
        asyncio.run(engine.dispose())


def test_character_and_product_are_reported_together() -> None:
    """正：人物与商品同时关联 → 两行都出现（不是互相覆盖）。"""
    factory, engine = _build()
    _seed(factory)
    _link_character(factory)
    _link_product(factory, shot_id=SHOT_ID)
    try:
        text, data = _context(factory)
        assets = (data.get("shot") or {}).get("assets") or {}
        assert assets.get("character") == [CHARACTER_NAME], assets
        assert assets.get("product") == [PRODUCT_NAME], assets
        assert f"人物资产：{CHARACTER_NAME}" in text, text
        assert f"商品资产：{PRODUCT_NAME}" in text, text
    finally:
        asyncio.run(engine.dispose())


# ---------------------------------------------------------------------------
# 反：没有商品时要说清"查过了但没有"，并且不能凭空多出来
# ---------------------------------------------------------------------------


def test_product_bucket_exists_and_is_empty_without_link() -> None:
    """反：没有商品关联 → 桶存在且为空（漏查与查空必须能区分开）。"""
    factory, engine = _build()
    _seed(factory)
    try:
        text, data = _context(factory)
        assets = (data.get("shot") or {}).get("assets") or {}
        assert "product" in assets, assets
        assert assets["product"] == [], assets
        assert "商品资产" not in text, text
    finally:
        asyncio.run(engine.dispose())


def test_chapter_scoped_product_link_does_not_leak_into_shot_context() -> None:
    """反：商品只挂章节档（``shot_id`` 为空）→ 不算"这一镜出现商品"。

    口径与 ``list_shot_linked_assets`` 一致：只有 shot 档才表达"这一镜里有商品"，
    否则"商品至少出现在一半镜头"这条校验就会失去依据。
    """
    factory, engine = _build()
    _seed(factory)
    _link_product(factory, shot_id=None)
    try:
        text, data = _context(factory)
        assets = (data.get("shot") or {}).get("assets") or {}
        assert assets.get("product") == [], assets
        assert "商品资产" not in text, text
        # 同一项目里另一个镜头也不该看到它
        other_text, other_data = _context(factory, shot_id=OTHER_SHOT_ID)
        assert ((other_data.get("shot") or {}).get("assets") or {}).get("product") == []
        assert "商品资产" not in other_text, other_text
    finally:
        asyncio.run(engine.dispose())


# ---------------------------------------------------------------------------
# 护栏：删掉 product 分支就变红
# ---------------------------------------------------------------------------


def test_asset_buckets_are_exactly_the_five_types() -> None:
    """护栏：桶键集合恰好五类 —— 把 product 从源码里删掉，这条立刻失败。"""
    factory, engine = _build()
    _seed(factory)
    try:
        async def run() -> set[str]:
            async with factory() as db:
                return set(await _linked_asset_names(db, shot_id=SHOT_ID))

        assert asyncio.run(run()) == EXPECTED_BUCKETS
    finally:
        asyncio.run(engine.dispose())


def test_product_branch_is_present_in_source() -> None:
    """护栏（源码定点扫描）：商品那一支必须真的在 —— 防止将来被"顺手简化"掉。"""
    source = Path(__file__).resolve().parent.parent / "app/services/skills/quick_skill_service.py"
    code = source.read_text("utf-8")
    assert '("product", ProjectProductLink, "product_id", Product)' in code
    assert '"product": [],' in code
    assert '("product", "商品")' in code
