"""商品卡 → 剧情生成的**输入接线**（契约 §二：商品卡 → 分层剧情）。

为什么单独一个测试文件：这条接线是需求的**主链路**（"商品卖点 → 一次模型调用出剧情方案"），
却在真机验收里暴露过一次真实事故 —— 用户确认的商品卡**一个字都没进模型输入**，
模型自己编了一个商品名（跑出来的 `plan.product.name` 是「花漾焕颜精华露」，
而卡里写的是「紧致焕颜精华」）。那个 bug 不会让任何既有测试变红：
brief 本来就有一份（创建项目时写的）空壳，生成也"成功"了，只是输入是错的。

所以这里从两个层次把它钉住：

1. :func:`brief_overlay` 的映射与"空字段不覆盖 / 未确认不生效"；
2. **真的经过 `service.generate`**：拦住模型调用，断言交给模型的那份 brief 里
   有卡里的名称 / 卖点 / 人群，且 brief 自己的导演要求没被冲掉、合规要求是**追加**进去的。

零出网、零付费：模型调用一律用注入的替身；库是内存库。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models.studio import Chapter, Project
from app.models.studio_ad_flow import ProductCard
from app.services.studio import drama_plan_drafts as drafts
from app.services.studio import drama_plan_service as service
from app.services.studio import product_card_service

PROJECT_ID = "proj-card-input"
CHAPTER_ID = "chap-card-input"

BRIEF = {
    "product_name": "",
    "product_description": "",
    "selling_points": [],
    "target_audience": "",
    "tone": "一本正经地荒诞",
    "shot_count": 3,
    "director_notes": "不要旁白",
    "forbidden_elements": ["不要出现价格"],
}

CARD = {
    "name": "紧致焕颜精华",
    "selling_points": ["三秒吸收", "不粘腻"],
    "audience": "25-35 岁通勤女性",
    "notes": "白色磨砂瓶身，金色压泵",
    "compliance": "不得宣称医疗功效\n不得出现「根治」",
}


async def _harness(*, confirmed: bool = True, card: dict[str, Any] | None = None) -> tuple[
    async_sessionmaker[AsyncSession], Any
]:
    from app.core.db import Base
    import app.models.studio  # noqa: F401  （导入即注册进 Base.metadata）

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with factory() as session:
        session.add(
            Project(id=PROJECT_ID, name="广告项目", description="", style="真人都市", visual_style="现实")
        )
        await session.flush()
        session.add(Chapter(id=CHAPTER_ID, project_id=PROJECT_ID, index=1, title="第 1 集"))
        if card is not None:
            session.add(
                ProductCard(project_id=PROJECT_ID, confirmed=confirmed, **card)
            )
        await drafts.save_brief(
            session, chapter_id=CHAPTER_ID, project_id=PROJECT_ID, brief=dict(BRIEF)
        )
        await session.commit()
    return factory, engine


def _run(*, confirmed: bool = True, card: dict[str, Any] | None = None):
    return asyncio.run(_harness(confirmed=confirmed, card=card))


# ---------------------------------------------------------------------------
# 1) 覆盖层本身
# ---------------------------------------------------------------------------


def test_overlay_maps_confirmed_card_fields() -> None:
    factory, engine = _run(card=CARD)

    async def _load() -> dict[str, Any]:
        async with factory() as session:
            return await product_card_service.brief_overlay(session, project_id=PROJECT_ID)

    overlay = asyncio.run(_load())
    asyncio.run(engine.dispose())

    assert overlay["product_name"] == "紧致焕颜精华"
    assert overlay["selling_points"] == ["三秒吸收", "不粘腻"]
    assert overlay["target_audience"] == "25-35 岁通勤女性"
    assert overlay["product_description"] == "白色磨砂瓶身，金色压泵"
    assert overlay["forbidden_elements"] == ["不得宣称医疗功效", "不得出现「根治」"]


def test_overlay_ignores_unconfirmed_card() -> None:
    """未确认的卡是"还在改的草稿"，不能当生成输入（否则等于拿未定稿当事实）。"""
    factory, engine = _run(card=CARD, confirmed=False)

    async def _load() -> dict[str, Any]:
        async with factory() as session:
            return await product_card_service.brief_overlay(session, project_id=PROJECT_ID)

    overlay = asyncio.run(_load())
    asyncio.run(engine.dispose())
    assert overlay == {}


def test_overlay_does_not_wipe_with_empty_card_fields() -> None:
    """卡里没填的字段不覆盖 brief（用户可能只在 brief 里写过商品名）。"""
    factory, engine = _run(card={"name": "只有名字的商品"})

    async def _load() -> dict[str, Any]:
        async with factory() as session:
            return await product_card_service.brief_overlay(session, project_id=PROJECT_ID)

    overlay = asyncio.run(_load())
    asyncio.run(engine.dispose())
    assert overlay == {"product_name": "只有名字的商品"}


# ---------------------------------------------------------------------------
# 2) 真的经过 generate：交给模型的那份 brief
# ---------------------------------------------------------------------------


def test_generate_sends_confirmed_card_to_model(monkeypatch: pytest.MonkeyPatch) -> None:
    factory, engine = _run(card=CARD)
    captured: dict[str, Any] = {}

    async def _fake_preview(_db: Any, *, chapter_id: str, brief: dict[str, Any], llm_caller: Any = None) -> dict[str, Any]:
        captured.update(brief)
        return {
            "plan": {"title": "面试那天", "shots": [{"index": 1, "title": "镜头 1"}]},
            "warnings": [],
            "meta": {"llm_called": True, "dry_run": False},
            "note": "替身（未调用模型）",
        }

    monkeypatch.setattr(service.orchestration, "preview_drama_plan", _fake_preview)

    async def _run_generate() -> None:
        async with factory() as session:
            await service.generate(session, chapter_id=CHAPTER_ID, stage="all")
            await session.commit()

    asyncio.run(_run_generate())
    asyncio.run(engine.dispose())

    assert captured, "模型调用没有被拦住（测试替身没被调用）"
    assert captured["product_name"] == "紧致焕颜精华", captured
    assert captured["selling_points"] == ["三秒吸收", "不粘腻"], captured
    assert captured["target_audience"] == "25-35 岁通勤女性", captured
    # brief 自己的导演要求不能被冲掉
    assert captured["tone"] == "一本正经地荒诞"
    assert captured["director_notes"] == "不要旁白"
    # 合规要求是**追加**，不是覆盖用户自己写的禁止项
    assert captured["forbidden_elements"] == ["不要出现价格", "不得宣称医疗功效", "不得出现「根治」"]


def test_generate_without_card_keeps_brief_as_is(monkeypatch: pytest.MonkeyPatch) -> None:
    """没有商品卡（普通短剧项目）时行为与加这一层之前完全一致。"""
    factory, engine = _run(card=None)
    captured: dict[str, Any] = {}

    async def _fake_preview(_db: Any, *, chapter_id: str, brief: dict[str, Any], llm_caller: Any = None) -> dict[str, Any]:
        captured.update(brief)
        return {"plan": {"shots": [{"index": 1, "title": "镜头 1"}]}, "warnings": [], "meta": {}, "note": ""}

    monkeypatch.setattr(service.orchestration, "preview_drama_plan", _fake_preview)

    async def _run_generate() -> None:
        async with factory() as session:
            await service.generate(session, chapter_id=CHAPTER_ID, stage="all")
            await session.commit()

    asyncio.run(_run_generate())
    asyncio.run(engine.dispose())

    assert captured["product_name"] == ""
    assert captured["forbidden_elements"] == ["不要出现价格"]
