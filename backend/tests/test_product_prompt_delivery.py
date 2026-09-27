"""商品（第五类资产）在「第 3 步整集提示词交付 / 第 4 步资产绑定」的接入回归。

为什么单独一个文件：这几处的失效方式**都是静默的** ——

1. 交付文本漏了商品槽位：不报错，只是"资产名段"少一行，而同一份文本的
   "实际文件段"却有商品，用户会以为商品没绑上；
2. LLM 自动绑定的候选清单漏了商品：不报错，只是**永远建议不出商品**；
3. 准备页的 ``entity_type`` 枚举漏了 ``product``：报的是 422"参数错误"，
   看不出是"类型没登记"，排查成本极高。

所以逐条钉住：交付文本两段**口径一致**、LLM 候选清单含商品且确认端点真实存在、
准备页能对商品真的落库、以及**商品的声音绑定仍然被拒**（刻意排除，不许顺手放开）。

零出网、零付费：不调模型、不出图、不触视频；库全部是内存库。
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator, Iterator
from typing import Any

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.dependencies import get_db
from app.main import app
from app.services.studio.prompt_delivery import (
    fetch_bound_asset_names,
    fetch_delivery_rows,
)
from app.services.studio.prompt_delivery_text import (
    BINDING_FILE_HEADER,
    BINDING_HEADER,
    build_jurilu_prompt_export_document,
)
from tests.llm_orchestration_fixtures import build_session, seed_project_chapter_shot

PROJECT_ID = "proj-1"
CHAPTER_ID = "chap-1"
SHOT_ID = "shot-1"
PRODUCT_ID = "prod-delivery"
PRODUCT_NAME = "焕颜精华"
PRODUCT_FILE_ID = "file-prod-front"
CHARACTER_ID = "CHAR_DELIVERY"

PREPARATION_LINK_URL = f"/api/v1/studio/shots/{SHOT_ID}/preparation-link"


# ---------------------------------------------------------------------------
# 脚手架
# ---------------------------------------------------------------------------


async def _seed_bound_assets(db: AsyncSession) -> None:
    """项目 + 章节 + 镜头 + 一条可交付提示词 + 绑定的角色与商品（含商品定版图）。"""
    from app.models.studio import (
        Character,
        FileItem,
        Product,
        ProductImage,
        ProjectProductLink,
        ShotCharacterLink,
        ShotDetail,
    )

    await seed_project_chapter_shot(
        db,
        project_id=PROJECT_ID,
        chapter_id=CHAPTER_ID,
        shot_id=SHOT_ID,
    )
    db.add(
        ShotDetail(
            id=SHOT_ID,
            camera_shot="中景",
            angle="平视",
            movement="固定",
            video_prompt="女主拿起焕颜精华对着光看瓶身。",
            video_prompt_source="manual",
        )
    )
    db.add(
        Character(
            id=CHARACTER_ID,
            project_id=PROJECT_ID,
            name="林晓",
            description="女主",
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
            tags=["精华"],
        )
    )
    db.add(
        FileItem(
            id=PRODUCT_FILE_ID,
            type="image",
            name="商品定版图",
            storage_key="https://oss.example.com/products/prod-delivery/front.png",
        )
    )
    await db.flush()
    db.add(ShotCharacterLink(id=1, shot_id=SHOT_ID, character_id=CHARACTER_ID, index=0))
    db.add(ProjectProductLink(id=1, project_id=PROJECT_ID, shot_id=SHOT_ID, product_id=PRODUCT_ID))
    db.add(
        ProductImage(
            id=1,
            product_id=PRODUCT_ID,
            file_id=PRODUCT_FILE_ID,
            is_primary=True,
            view_angle="FRONT",
            quality_level="HIGH",
        )
    )
    await db.flush()


def _binding_sections(text: str) -> tuple[str, str]:
    """把交付文本切成「绑定资产（名称段）」与「绑定素材·实际文件（文件段）」。"""
    assert BINDING_HEADER in text and BINDING_FILE_HEADER in text, text
    _, _, rest = text.partition(BINDING_HEADER)
    name_block, _, file_block = rest.partition(BINDING_FILE_HEADER)
    return name_block, file_block


def _slot_labels(block: str) -> set[str]:
    """取出一个段落里出现的槽位中文标签（``角色：…`` / ``商品：…``）。"""
    labels: set[str] = set()
    for raw_line in block.splitlines():
        line = raw_line.strip()
        if not line or "：" not in line:
            continue
        label, _, _rest = line.partition("：")
        labels.add(label.strip())
    return labels


def _build_harness() -> tuple[async_sessionmaker[AsyncSession], Any]:
    from app.core.db import Base
    import app.models.studio  # noqa: F401  导入即注册全部表

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def _create() -> None:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(_create())
    return factory, engine


def _seed_preparation_project(factory: async_sessionmaker[AsyncSession]) -> None:
    from app.models.studio import Chapter, Product, Project, Shot, ShotDetail

    async def _run() -> None:
        async with factory() as session:
            session.add(
                Project(
                    id=PROJECT_ID,
                    name="广告项目",
                    description="",
                    style="真人都市",
                    visual_style="现实",
                )
            )
            await session.flush()
            session.add(Chapter(id=CHAPTER_ID, project_id=PROJECT_ID, index=1, title="第 1 集"))
            await session.flush()
            session.add(Shot(id=SHOT_ID, chapter_id=CHAPTER_ID, index=1, title="镜头 1", status="ready"))
            session.add(
                ShotDetail(
                    id=SHOT_ID,
                    camera_shot="中景",
                    angle="平视",
                    movement="固定",
                    duration=5,
                    action_beats=["拿起精华"],
                )
            )
            session.add(
                Product(
                    id=PRODUCT_ID,
                    name=PRODUCT_NAME,
                    description="白色磨砂瓶身",
                    style="真人都市",
                    visual_style="现实",
                )
            )
            await session.commit()

    asyncio.run(_run())


@pytest.fixture()
def preparation_harness() -> Iterator[tuple[TestClient, Any]]:
    """TestClient + 内存库 + 最小项目结构（零出网）。

    同时交出 ``factory``：断言"真的落库了"必须读**同一个**内存库，
    另开一个会话工厂只会读到空表，让断言变成永远为假的假阳性。
    """
    factory, engine = _build_harness()

    async def override_db() -> AsyncGenerator[AsyncSession, None]:
        async with factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = override_db
    _seed_preparation_project(factory)
    try:
        yield TestClient(app), factory
    finally:
        app.dependency_overrides.clear()
        asyncio.run(engine.dispose())


# ---------------------------------------------------------------------------
# 1) 交付文本：商品名段与商品文件段**同口径**（契约 §六.5）
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delivery_text_has_product_in_both_name_and_file_sections() -> None:
    """五类**资产**槽位在名称段与文件段必须同口径。

    注意范围：镜头级"声音"（``bound_asset_files`` 的 ``audio`` 槽）**刻意只出现在文件段** ——
    它不是一个可绑定的资产名，而是这一镜用的音频文件。本测试种子里没有声音，
    所以断言标签集合相等成立；将来若在这里加声音绑定，应把断言改成
    ``file_labels - name_labels == {"声音"}``，而不是把声音塞进名称段。
    """
    db, engine = await build_session()
    try:
        async with db:
            await _seed_bound_assets(db)

            # 单元侧：名称桶必须真的有 products 这一桶，否则文本段无论怎么写都是空的
            names = await fetch_bound_asset_names(db, shot_ids=[SHOT_ID])
            assert names[SHOT_ID]["products"] == [PRODUCT_NAME]

            rows = await fetch_delivery_rows(db, project_id=PROJECT_ID, chapter_id=CHAPTER_ID)
            text = build_jurilu_prompt_export_document(rows, multi_episode=False, include_bindings=True)
    finally:
        await engine.dispose()

    name_block, file_block = _binding_sections(text)

    # ① 名称段有商品
    assert f"商品：{PRODUCT_NAME}" in name_block, name_block
    # ② 文件段有商品（这条在本批之前就是通的，留作"不许被改回去"的锁）
    assert f"商品：{PRODUCT_NAME}[定版] file_id={PRODUCT_FILE_ID}" in file_block, file_block

    # ③ 两段口径一致：**这是本次修复的核心断言**。
    # 修复前名称段只有 {角色}、文件段有 {角色, 商品} → 这条会红。
    assert _slot_labels(name_block) == _slot_labels(file_block), (name_block, file_block)
    assert _slot_labels(name_block) == {"角色", "商品"}, name_block


@pytest.mark.asyncio
async def test_delivery_text_omits_product_line_when_not_bound() -> None:
    """没有绑商品时不许凭空出现"商品："空行（口径一致 ≠ 永远写一行）。"""
    from app.models.studio import ProjectProductLink

    db, engine = await build_session()
    try:
        async with db:
            await _seed_bound_assets(db)
            await db.execute(delete(ProjectProductLink).where(ProjectProductLink.shot_id == SHOT_ID))
            await db.flush()

            rows = await fetch_delivery_rows(db, project_id=PROJECT_ID, chapter_id=CHAPTER_ID)
            text = build_jurilu_prompt_export_document(rows, multi_episode=False, include_bindings=True)
    finally:
        await engine.dispose()

    name_block, file_block = _binding_sections(text)
    assert "商品" not in name_block
    assert "商品" not in file_block
    assert _slot_labels(name_block) == _slot_labels(file_block) == {"角色"}


# ---------------------------------------------------------------------------
# 2) LLM 自动绑定：候选清单含商品，且确认端点是**真实存在**的端点（契约 §六.6）
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_asset_binding_catalog_includes_product_and_renders_products_slot() -> None:
    from app.services.studio.llm_orchestration.asset_binding import (
        CONFIRM_ENDPOINTS,
        SLOT_ASSET_TYPES,
        load_candidate_catalog,
    )
    from app.services.studio.llm_orchestration.prompt_templates import LLM_BINDING_TEMPLATE

    assert SLOT_ASSET_TYPES["products"] == ("product",)

    db, engine = await build_session()
    try:
        async with db:
            await _seed_bound_assets(db)
            catalog = await load_candidate_catalog(db, project_id=PROJECT_ID)
    finally:
        await engine.dispose()

    by_id = {item.asset_id: item for item in catalog}
    assert PRODUCT_ID in by_id, [item.asset_id for item in catalog]
    assert by_id[PRODUCT_ID].asset_type == "product"
    assert by_id[PRODUCT_ID].name == PRODUCT_NAME
    # 商品的 tags 与场景/道具/服装同口径地进别名（否则剧情里的"精华"永远对不上）
    assert by_id[PRODUCT_ID].aliases == ["精华"]

    assert CONFIRM_ENDPOINTS["product"] == "POST /api/v1/studio/shot-links/product"

    # 端点必须真的挂在路由表上：写错路径等于"人工确认页点了没反应"。
    assert "/api/v1/studio/shot-links/product" in app.openapi()["paths"]

    # 模板必须给出商品槽位：只把商品塞进候选清单而不给槽位，模型会把它塞进 props，
    # 然后被"槽位类型一致"规则整条丢掉 → 用户看到的是"模型没建议商品"。
    assert "products" in LLM_BINDING_TEMPLATE.template
    assert "商品" in LLM_BINDING_TEMPLATE.template


# ---------------------------------------------------------------------------
# 3) 分镜准备页：``preparation-link`` 对商品可用（枚举缺 member 会 422）
# ---------------------------------------------------------------------------


def test_preparation_link_accepts_product(preparation_harness: tuple[TestClient, Any]) -> None:
    """商品必须能走通准备页关联：枚举缺 member 时这里会 422。"""
    client, factory = preparation_harness

    response = client.post(
        PREPARATION_LINK_URL,
        json={
            "project_id": PROJECT_ID,
            "chapter_id": CHAPTER_ID,
            "entity_type": "product",
            "linked_entity_id": PRODUCT_ID,
        },
    )
    assert response.status_code == 200, response.text

    # 真的落库了：不是"只放开了枚举"，而是 project_product_links 多了一行 shot 档关联
    from app.models.studio import ProjectProductLink

    async def _read() -> list[tuple[str, str]]:
        async with factory() as session:
            rows = (
                await session.execute(
                    select(ProjectProductLink.shot_id, ProjectProductLink.product_id)
                )
            ).all()
            return [(str(shot_id or ""), str(product_id or "")) for shot_id, product_id in rows]

    assert asyncio.run(_read()) == [(SHOT_ID, PRODUCT_ID)]


def test_preparation_link_still_rejects_unknown_entity_type(
    preparation_harness: tuple[TestClient, Any],
) -> None:
    """新增 member 不许把"未知类型"变成静默接受（原来就是 422）。"""
    client, _factory = preparation_harness

    response = client.post(
        PREPARATION_LINK_URL,
        json={
            "project_id": PROJECT_ID,
            "chapter_id": CHAPTER_ID,
            "entity_type": "actor",
            "linked_entity_id": "whatever",
        },
    )
    assert response.status_code == 422, response.text


# ---------------------------------------------------------------------------
# 4) 回归：**商品的声音绑定必须继续被拒**（刻意排除，别顺手放开）
# ---------------------------------------------------------------------------


def test_product_voice_binding_is_still_rejected() -> None:
    """``asset_voices.ASSET_VOICE_TYPES`` 刻意只有四类，商品不在其中。

    这条与 ``tests/test_asset_voice_binding.py`` 的接口级断言互补：
    那边走 HTTP，这里直接钉服务层的**第一道闸**（在任何 DB 访问之前就拒绝）。
    """
    from app.services.studio.asset_voices import (
        ASSET_VOICE_TYPES,
        bind_asset_voice,
        normalize_voice_asset_type,
    )

    assert "product" not in ASSET_VOICE_TYPES

    with pytest.raises(HTTPException) as exc_info:
        normalize_voice_asset_type("product")
    assert exc_info.value.status_code == 400
    assert exc_info.value.detail["code"] == "unsupported_asset_type"

    # db=None：闸在查库之前，所以传 None 也必须先抛"类型不支持"，而不是 AttributeError
    with pytest.raises(HTTPException) as binding_exc:
        asyncio.run(
            bind_asset_voice(  # type: ignore[arg-type]
                None, asset_type="product", asset_id=PRODUCT_ID, file_id="file-1"
            )
        )
    assert binding_exc.value.detail["code"] == "unsupported_asset_type"


# ---------------------------------------------------------------------------
# 5) 回归：出图/文本提示词的**刻意口径**没被这次改动带跑
# ---------------------------------------------------------------------------


def test_shot_video_prompt_pack_still_has_no_product_branch() -> None:
    """商品外观只走帧参考图，不进文本提示词（契约红线）。

    ``tests/test_drama_plan_product_read_side.py`` 已有同款断言；这里再放一条是因为
    本批把商品接进了交付文本与绑定槽位，最容易的越界就是"顺手也塞进 shot_video_prompt_pack"。
    """
    from pathlib import Path

    source = (
        Path(__file__).resolve().parents[1]
        / "app"
        / "services"
        / "studio"
        / "shot_video_prompt_pack.py"
    ).read_text(encoding="utf-8")
    assert '"product"' not in source
