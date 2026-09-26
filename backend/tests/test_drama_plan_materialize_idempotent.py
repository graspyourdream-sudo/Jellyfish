"""确认落库的**幂等**与来源关系（``drama_plan_materials`` / ``products.provenance``）。

覆盖实施契约 §三：
1. 第一次确认落齐（章节标题/主线/**完整剧情全文** + 人物 + 场景 + 商品 + 分镜 + 台词 + 关联行）；
2. **第二次确认不新增任何镜头/资产**（行数逐表不变，且返回值自己说清楚"这次是更新"）；
3. 草稿改过之后确认 → **就地更新**（行数仍不变，值变了）；
4. 镜头数变了 → 409（留多余镜头会新旧分镜混在一起，删掉又会丢用户准备过的内容，
   这个决定不能替用户做）；
5. 章节里有**不属于本方案**的镜头 → 409（既有口径：不与旧分镜混在一起）；
6. 同名资产**复用不新建**（``scenes.name`` / ``products.name`` 全局唯一、
   ``characters`` 是 ``(project_id, name)`` 唯一 —— 不复用就会撞唯一约束）；
7. 复用时**不覆盖**用户已经填过的资产资料；
8. ``next_step`` 指向第 2 步（契约 §三.5）。

零出网、零付费：不调模型（草稿直接写库），库是内存库。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.dependencies import get_db
from app.main import app
from app.models.studio import (
    Chapter,
    Character,
    DramaPlanDraft,
    Product,
    Project,
    ProjectProductLink,
    ProjectSceneLink,
    Scene,
    Shot,
    ShotCharacterLink,
    ShotDetail,
    ShotDialogLine,
)
from app.models.studio_ad_flow import DramaPlanMaterial, ProductCard

PROJECT_ID = "proj-mat"
CHAPTER_ID = "chap-mat"
BASE = f"/api/v1/studio/chapters/{CHAPTER_ID}/drama-plan"


def _plan_payload(*, shots: int = 3, product_present: tuple[bool, ...] | None = None,
                  line_text: str = "我不用补妆。", story_extra: bool = True) -> dict[str, Any]:
    """一份合法草稿：``shots`` 个镜头，默认按"至少一半出现商品"给。"""
    present = product_present or tuple(i % 2 == 0 for i in range(shots))
    assert sum(present) * 2 >= shots, "测试草稿必须满足「商品至少出现在一半镜头」"
    story: dict[str, Any] = {
        "full_text": "会议室里，她把瓶子拍在桌上。\n前任抬头说：好久不见。",
        "hook": "瓶子拍在桌上",
        "conflict": "面试官是前任",
        "product_usage": "她用精华当武器",
        "climax": "前任说这瓶是他买的",
        "cta": "她笑而不语",
    }
    if not story_extra:
        story["full_text"] = ""
    return {
        "title": "面试那天",
        "logline": "她带着一瓶精华去面试，面试官是前任",
        "one_liner": "一瓶精华把前任气到破防",
        "audience_emotion": "爽",
        "story": story,
        "selling_points": ["三秒吸收"],
        "characters": [
            {"name": "林小满", "profile": {"appearance": "鹅蛋脸"}},
            {"name": "周砚", "profile": {"identity": "面试官"}},
        ],
        "scenes": [{"name": "写字楼会议室", "profile": {"spatial_structure": "长桌"}}],
        "product": {
            "name": "紧致焕颜精华",
            "description": "白色磨砂瓶身，金色压泵",
            "profile": {"package": "方形瓶身"},
        },
        "shots": [
            {
                "index": i + 1,
                "title": f"镜头 {i + 1}",
                "characters": ["林小满"] if i == 0 else ["林小满", "周砚"],
                "script_excerpt": "她把瓶子拍在桌上" if i == 0 else "",
                "description": f"第 {i + 1} 镜描述",
                "duration": 5,
                "camera_shot": "MS",
                "angle": "EYE_LEVEL",
                "movement": "STATIC",
                "action_beats": ["拍瓶"],
                "dialogue": (
                    [{"speaker": "林小满", "text": line_text, "mode": "DIALOGUE"}]
                    if i == 0
                    else []
                ),
                "product_present": bool(present[i]),
            }
            for i in range(shots)
        ],
        "climax": "前任说这瓶是他买的",
        "warnings": [],
    }


# ---------------------------------------------------------------------------
# 脚手架
# ---------------------------------------------------------------------------


async def _build_harness_async() -> tuple[async_sessionmaker[AsyncSession], Any]:
    from app.core.db import Base
    import app.models.studio  # noqa: F401

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return factory, engine


def _build_harness() -> tuple[async_sessionmaker[AsyncSession], Any]:
    return asyncio.run(_build_harness_async())


async def _seed_async(
    factory: async_sessionmaker[AsyncSession],
    *,
    plan: dict[str, Any] | None,
    with_card: bool = True,
    extra_shot: bool = False,
) -> None:
    async with factory() as session:
        session.add(
            Project(id=PROJECT_ID, name="广告项目", description="", style="真人都市", visual_style="现实")
        )
        await session.flush()
        session.add(Chapter(id=CHAPTER_ID, project_id=PROJECT_ID, index=1, title="第 1 集", raw_text="旧正文"))
        if with_card:
            session.add(ProductCard(project_id=PROJECT_ID, name="紧致焕颜精华"))
        if extra_shot:
            session.add(Shot(id="shot-foreign", chapter_id=CHAPTER_ID, index=1, title="别人的镜头"))
        if plan is not None:
            session.add(
                DramaPlanDraft(
                    chapter_id=CHAPTER_ID, project_id=PROJECT_ID, brief={}, plan=plan, status="ok"
                )
            )
        await session.commit()


def _seed(factory: async_sessionmaker[AsyncSession], **kwargs: Any) -> None:
    asyncio.run(_seed_async(factory, **kwargs))


@pytest.fixture()
def client_and_db() -> Iterator[tuple[TestClient, async_sessionmaker[AsyncSession]]]:
    """已建项目 + 章节 + 商品卡（不含草稿）的客户端。"""
    factory, engine = _build_harness()
    _seed(factory, plan=None)

    async def override_db() -> AsyncGenerator[AsyncSession, None]:
        async with factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = override_db
    try:
        yield TestClient(app), factory
    finally:
        app.dependency_overrides.clear()
        asyncio.run(engine.dispose())


async def _count(factory: async_sessionmaker[AsyncSession], model: Any, **filters: Any) -> int:
    async with factory() as session:
        stmt = select(func.count()).select_from(model)
        for key, value in filters.items():
            stmt = stmt.where(getattr(model, key) == value)
        return int(await session.scalar(stmt) or 0)


def _snapshot(factory: async_sessionmaker[AsyncSession]) -> dict[str, int]:
    """所有"确认会写"的表逐表行数 —— 幂等断言就比这个快照。"""
    return {
        "shots": asyncio.run(_count(factory, Shot)),
        "shot_details": asyncio.run(_count(factory, ShotDetail)),
        "dialog_lines": asyncio.run(_count(factory, ShotDialogLine)),
        "characters": asyncio.run(_count(factory, Character)),
        "scenes": asyncio.run(_count(factory, Scene)),
        "products": asyncio.run(_count(factory, Product)),
        "shot_character_links": asyncio.run(_count(factory, ShotCharacterLink)),
        "project_product_links": asyncio.run(_count(factory, ProjectProductLink)),
        "project_scene_links": asyncio.run(_count(factory, ProjectSceneLink)),
        "materials": asyncio.run(_count(factory, DramaPlanMaterial)),
    }


async def _put_plan(factory: async_sessionmaker[AsyncSession], plan: dict[str, Any]) -> None:
    """把草稿写进草稿行（等价于 PUT /draft，但不受草稿归一化影响，测试口径更硬）。"""
    async with factory() as session:
        row = await session.get(DramaPlanDraft, CHAPTER_ID)
        if row is None:
            session.add(
                DramaPlanDraft(
                    chapter_id=CHAPTER_ID, project_id=PROJECT_ID, brief={}, plan=plan, status="ok"
                )
            )
        else:
            row.plan = plan
            row.status = "ok"
        await session.commit()


def _set_plan(factory: async_sessionmaker[AsyncSession], plan: dict[str, Any]) -> None:
    asyncio.run(_put_plan(factory, plan))


async def _get(factory: async_sessionmaker[AsyncSession], model: Any, key: Any) -> Any:
    async with factory() as session:
        return await session.get(model, key)


# ---------------------------------------------------------------------------
# 1) 第一次确认：落齐 + 来源关系 + next_step
# ---------------------------------------------------------------------------


def test_first_confirm_creates_everything(
    client_and_db: tuple[TestClient, async_sessionmaker[AsyncSession]],
) -> None:
    client, factory = client_and_db
    _set_plan(factory, _plan_payload(shots=3))

    resp = client.post(f"{BASE}/confirm")
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]

    assert data["shots_created"] == 3 and data["shots_updated"] == 0
    assert data["characters_created"] == 2 and data["scenes_created"] == 1
    assert data["product_created"] is True
    assert data["assets_created"] == 4 and data["assets_reused"] == 0
    assert data["shot_product_links"] == 2
    assert data["shot_character_links"] == 5  # 第 1 镜 1 个 + 第 2/3 镜各 2 个
    assert data["materials_linked"] == 3 + 4  # 3 个镜头 + 人物 2 + 场景 1 + 商品 1
    assert data["skipped"] == []

    # 章节：标题 / 主线 / **完整剧情全文** / 分镜数
    chapter = asyncio.run(_get(factory, Chapter, CHAPTER_ID))
    assert chapter.title == "面试那天"
    assert chapter.summary == "她带着一瓶精华去面试，面试官是前任"
    assert chapter.raw_text.startswith("会议室里，她把瓶子拍在桌上。")
    assert chapter.storyboard_count == 3

    # 商品：来源投影（source / project_id / chapter_id / card_updated_at）
    product = asyncio.run(_get(factory, Product, _product_id(factory)))
    assert product.provenance["source"] == "plan"
    assert product.provenance["project_id"] == PROJECT_ID
    assert product.provenance["chapter_id"] == CHAPTER_ID
    assert product.provenance["card_updated_at"] != ""

    # 草稿行：确认状态 + 落库时间 + 落库统计（页面回显与 ad_phase 都读它）
    draft = asyncio.run(_get(factory, DramaPlanDraft, CHAPTER_ID))
    assert draft.story_status == "confirmed"
    assert draft.confirmed_at is not None and draft.materialized_at is not None
    assert draft.materialize_summary["shots_created"] == 3

    # 下一步（契约 §三.5）：标签 + 契约口径 URL + 带章节的 URL
    step = data["next_step"]
    assert step["label"] == "继续准备资产"
    assert step["url"] == f"/projects/{PROJECT_ID}?step=extract_assets"
    assert step["chapter_url"] == f"/projects/{PROJECT_ID}?step=extract_assets&chapter={CHAPTER_ID}"


def _product_id(factory: async_sessionmaker[AsyncSession]) -> str:
    async def _load() -> str:
        async with factory() as session:
            row = (await session.execute(select(Product).limit(1))).scalars().first()
            assert row is not None
            return str(row.id)

    return asyncio.run(_load())


# ---------------------------------------------------------------------------
# 2) 第二次确认：一行都不新增
# ---------------------------------------------------------------------------


def test_second_confirm_is_idempotent(
    client_and_db: tuple[TestClient, async_sessionmaker[AsyncSession]],
) -> None:
    client, factory = client_and_db
    _set_plan(factory, _plan_payload(shots=3))

    assert client.post(f"{BASE}/confirm").status_code == 200
    before = _snapshot(factory)

    resp = client.post(f"{BASE}/confirm")
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]

    assert _snapshot(factory) == before, "第二次确认不得新增任何镜头/资产/关联行"
    assert data["shots_created"] == 0 and data["shots_updated"] == 3
    assert data["assets_created"] == 0 and data["assets_reused"] == 4
    assert data["materials_linked"] == 0, "来源关系也应幂等（已存在的登记不再重复写）"
    assert data["shot_product_links"] == 2

    # 第三次也一样（防止"第二次恰好特殊"）
    assert client.post(f"{BASE}/confirm").status_code == 200
    assert _snapshot(factory) == before


# ---------------------------------------------------------------------------
# 3) 草稿改过之后：就地更新
# ---------------------------------------------------------------------------


def test_confirm_after_edit_updates_in_place(
    client_and_db: tuple[TestClient, async_sessionmaker[AsyncSession]],
) -> None:
    client, factory = client_and_db
    _set_plan(factory, _plan_payload(shots=3))
    assert client.post(f"{BASE}/confirm").status_code == 200
    before = _snapshot(factory)

    # 改台词、改第二镜是否出现商品（仍满足"至少一半"：1、3 出现 → 2/3）
    edited = _plan_payload(shots=3, product_present=(True, False, True), line_text="我不需要补妆。")
    edited["shots"][0]["title"] = "拍瓶（改）"
    _set_plan(factory, edited)

    resp = client.post(f"{BASE}/confirm")
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["shots_created"] == 0 and data["shots_updated"] == 3
    assert data["shot_product_links"] == 2

    after = _snapshot(factory)
    assert after == before, "就地更新不应增删任何行"

    async def _check() -> tuple[Any, Any, int]:
        async with factory() as session:
            # 镜头 ID 是随机 uuid，按 id 排序不是"第 1 镜"，所以按 shots.index 取
            first_shot = (
                await session.execute(select(Shot).order_by(Shot.index).limit(1))
            ).scalars().first()
            line = (
                await session.execute(
                    select(ShotDialogLine).where(ShotDialogLine.shot_detail_id == first_shot.id)
                )
            ).scalars().first()
            detail = await session.get(ShotDetail, first_shot.id)
            total = int(
                await session.scalar(
                    select(func.count()).select_from(ProjectProductLink).where(
                        ProjectProductLink.shot_id.is_not(None)
                    )
                )
                or 0
            )
            return line, detail, total

    line, detail, shot_links = asyncio.run(_check())
    assert line.text == "我不需要补妆。"
    assert detail.description == "第 1 镜描述"
    assert shot_links == 2


# ---------------------------------------------------------------------------
# 4/5) 拒绝写入的两种情形（都是 409 + 能照做的修复建议）
# ---------------------------------------------------------------------------


def test_confirm_rejects_changed_shot_count(
    client_and_db: tuple[TestClient, async_sessionmaker[AsyncSession]],
) -> None:
    client, factory = client_and_db
    _set_plan(factory, _plan_payload(shots=3))
    assert client.post(f"{BASE}/confirm").status_code == 200
    before = _snapshot(factory)

    _set_plan(factory, _plan_payload(shots=2, product_present=(True, True)))
    resp = client.post(f"{BASE}/confirm")
    assert resp.status_code == 409, resp.text
    detail = resp.json()["meta"]["error"]
    assert detail["code"] == "drama_plan_shot_count_changed"
    assert detail["fix"]
    assert _snapshot(factory) == before, "被拒绝的确认不得改动任何行"


def test_confirm_rejects_chapter_with_foreign_shots() -> None:
    factory, engine = _build_harness()
    _seed(factory, plan=_plan_payload(shots=3), extra_shot=True)

    async def override_db() -> AsyncGenerator[AsyncSession, None]:
        async with factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = override_db
    try:
        client = TestClient(app)
        before = _snapshot(factory)
        resp = client.post(f"{BASE}/confirm")
        assert resp.status_code == 409, resp.text
        assert resp.json()["meta"]["error"]["code"] == "drama_plan_chapter_not_empty"
        assert _snapshot(factory) == before
    finally:
        app.dependency_overrides.clear()
        asyncio.run(engine.dispose())


# ---------------------------------------------------------------------------
# 6/7) 同名资产复用而不是新建（否则撞唯一约束），且不覆盖用户填过的资料
# ---------------------------------------------------------------------------


def test_same_name_assets_are_reused_not_recreated() -> None:
    factory, engine = _build_harness()
    _seed(factory, plan=None)

    async def _pre_existing() -> None:
        async with factory() as session:
            # 同名角色（本项目内）、同名场景与商品（**全局唯一**）都已经存在：
            # 分别模拟"上一集确认过"与"资产库里本来就有这个商品"。
            session.add(
                Character(
                    id="char-old",
                    project_id=PROJECT_ID,
                    name="林小满",
                    description="上一集留下的资料",
                    style="真人都市",
                    visual_style="现实",
                )
            )
            session.add(Scene(id="scene-old", name="写字楼会议室", description="", style="真人都市", visual_style="现实"))
            session.add(Product(id="prod-old", name="紧致焕颜精华", description="", style="真人都市", visual_style="现实"))
            session.add(DramaPlanDraft(chapter_id=CHAPTER_ID, project_id=PROJECT_ID, brief={}, plan=_plan_payload(shots=3), status="ok"))
            await session.commit()

    asyncio.run(_pre_existing())

    async def override_db() -> AsyncGenerator[AsyncSession, None]:
        async with factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = override_db
    try:
        client = TestClient(app)
        resp = client.post(f"{BASE}/confirm")
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]

        # 三个同名资产全部复用；只有"周砚"是新建的
        assert data["characters_created"] == 1
        assert data["scenes_created"] == 0 and data["product_created"] is False
        assert data["assets_reused"] == 3
        # 复用不覆盖：上一集填过的角色资料留着
        assert any("保留了它现有的资料" in item for item in data["warnings"]), data["warnings"]

        async def _check() -> tuple[str, int, int, int]:
            async with factory() as session:
                character = await session.get(Character, "char-old")
                scenes = int(await session.scalar(select(func.count()).select_from(Scene)) or 0)
                products = int(await session.scalar(select(func.count()).select_from(Product)) or 0)
                materials = int(
                    await session.scalar(select(func.count()).select_from(DramaPlanMaterial)) or 0
                )
                return character.description, scenes, products, materials

        description, scenes, products, materials = asyncio.run(_check())
        assert description == "上一集留下的资料"
        assert (scenes, products) == (1, 1), "同名的全局资产不得再建一份"
        assert materials == 3 + 4
    finally:
        app.dependency_overrides.clear()
        asyncio.run(engine.dispose())


# ---------------------------------------------------------------------------
# 8) 边界：没有完整剧情全文时不编造（章节正文保持原样）
# ---------------------------------------------------------------------------


def test_missing_story_text_keeps_chapter_raw_text(
    client_and_db: tuple[TestClient, async_sessionmaker[AsyncSession]],
) -> None:
    client, factory = client_and_db
    _set_plan(factory, _plan_payload(shots=3, story_extra=False))

    resp = client.post(f"{BASE}/confirm")
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert any("完整剧情全文" in item for item in data["skipped"]), data["skipped"]
    chapter = asyncio.run(_get(factory, Chapter, CHAPTER_ID))
    assert chapter.raw_text == "旧正文", "草稿没给正文时不得清空章节原有正文"
