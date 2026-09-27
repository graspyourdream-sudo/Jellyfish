"""第 2 步「资产准备」的商品（第五类资产）接入：读取侧 + 两个会崩的缺口。

契约：《剧情广告完整闭环（实施契约）》§六「S5 必改清单」——
第 1 条（``chapter_asset_profile_confirm`` 缺 product → ``KeyError``）、
第 2 条（``ShotCandidateType`` 缺 product → 带 shot_id 新建商品 ``ValueError``）、
第 3 条（``project_asset_readiness`` 只有四类 → 商品不进第 2 步清单）、
第 4 条（``list_shot_linked_assets`` 不读 ``ProjectProductLink`` → 第 4 步看不到商品）。

本文件证明五件事：

1. shot 档 ``ProjectProductLink`` 存在时，商品进 ``asset-readiness`` 清单且计数正确；
2. ``list_shot_linked_assets`` 能返回商品，且**只认 shot 档**（chapter 档不算"这一镜出现商品"）；
3. 第 2 步确认对 ``asset_type="product"`` 不再崩，并真的落下 ``ProjectProductLink``；
4. 带 ``shot_id`` 新建商品不再 ``ValueError``（提取候选被正确回写为 linked）；
5. 回归护栏：character/scene/prop/costume 既有行为不变，且商品**仍然不进文本提示词**。

零出网、零付费：内存库（``sqlite+aiosqlite:///:memory:``）+ 真实路由，
不调用任何模型、不出图、不碰正式库。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator, Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.dependencies import get_db
from app.main import app
from app.models.studio import (
    Chapter,
    ChapterAssetProfile,
    Product,
    Project,
    ProjectProductLink,
    Shot,
    ShotCharacterLink,
    ShotExtractedCandidate,
)
from app.services.studio.chapter_asset_profile_confirm import confirm_chapter_asset_profiles
from app.services.studio.llm_orchestration.json_utils import normalize_name
from app.services.studio.shot_assets import list_shot_linked_assets

PROJECT_ID = "proj-step2"
CHAPTER_ID = "chap-step2"
SHOT_ID = "shot-step2"
PRODUCT_ID = "prod-step2"
PRODUCT_NAME = "焕颜精华"

ENTITIES = "/api/v1/studio/entities"
SHOT_LINKS = "/api/v1/studio/shot-links"
READINESS = f"/api/v1/studio/projects/{PROJECT_ID}/asset-readiness"
SHOT_ASSETS = f"/api/v1/studio/shots/{SHOT_ID}/linked-assets"

Factory = async_sessionmaker[AsyncSession]
Harness = tuple[TestClient, Factory]


# ---------------------------------------------------------------------------
# 脚手架：内存库 + 真实路由（不碰任何正式库、不出网）
# ---------------------------------------------------------------------------


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


def _override(factory: Factory):
    async def override_db() -> AsyncGenerator[AsyncSession, None]:
        async with factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    return override_db


def _seed_structure(factory: Factory) -> None:
    """项目 + 章节 + 镜头（第 2 步清单与第 4 步镜头列表都要用到的最小结构）。"""

    async def run() -> None:
        async with factory() as db:
            db.add(
                Project(
                    id=PROJECT_ID,
                    name="广告项目",
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
                    raw_text="她在镜头前拿起焕颜精华，说这就是她的底气。",
                    condensed_text="她在镜头前拿起焕颜精华，说这就是她的底气。",
                    storyboard_count=1,
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
            await db.commit()

    asyncio.run(run())


def _seed_product(
    factory: Factory, *, product_id: str = PRODUCT_ID, name: str = PRODUCT_NAME
) -> None:
    """直接放一条商品（商品图在 MVP 里走手工上传，本文件不涉及出图）。

    ``products.name`` 是全局唯一约束，所以同一测试里放多条商品要自己给不同名字。
    """

    async def run() -> None:
        async with factory() as db:
            db.add(
                Product(
                    id=product_id,
                    name=name,
                    description="白色磨砂瓶身，金色压泵",
                    style="真人都市",
                    visual_style="现实",
                )
            )
            await db.commit()

    asyncio.run(run())


def _link_product(factory: Factory, *, shot_id: str | None, product_id: str = PRODUCT_ID) -> None:
    async def run() -> None:
        async with factory() as db:
            db.add(
                ProjectProductLink(
                    project_id=PROJECT_ID,
                    chapter_id=CHAPTER_ID,
                    shot_id=shot_id,
                    product_id=product_id,
                )
            )
            await db.commit()

    asyncio.run(run())


def _seed_product_record(factory: Factory) -> None:
    """放一行章节资料（= 第 2 步"生成过一次清单"之后的库状态；确认动作只读库、不发模型）。"""

    async def run() -> None:
        async with factory() as db:
            db.add(
                ChapterAssetProfile(
                    project_id=PROJECT_ID,
                    chapter_id=CHAPTER_ID,
                    asset_type="product",
                    name=PRODUCT_NAME,
                    name_key=normalize_name(PRODUCT_NAME),
                    aliases=[],
                    profile={"appearance": "白色磨砂瓶身，金色压泵，正面金色字标"},
                    manual_overrides={},
                    user_notes=[],
                    shot_refs=[
                        {
                            "shot_id": SHOT_ID,
                            "shot_index": 1,
                            "title": "镜头 1",
                            "script_excerpt": "她拿起焕颜精华，对着镜头说话。",
                        }
                    ],
                    evidence=[],
                    merge_sources=[],
                )
            )
            await db.commit()

    asyncio.run(run())


def _create_entity(client: TestClient, entity_type: str, entity_id: str, name: str, **extra: object) -> None:
    body: dict[str, object] = {
        "id": entity_id,
        "name": name,
        "description": "",
        "tags": [],
        "visual_style": "现实",
        "style": "真人都市",
        "view_count": 1,
    }
    body.update(extra)
    res = client.post(f"{ENTITIES}/{entity_type}", json=body)
    assert res.status_code == 201, res.text


def _readiness(client: TestClient) -> dict[str, Any]:
    res = client.get(READINESS)
    assert res.status_code == 200, res.text
    return res.json()["data"]


def _item(payload: dict[str, Any], asset_type: str, asset_id: str) -> dict[str, Any]:
    for item in payload["items"]:
        if item["asset_type"] == asset_type and item["asset_id"] == asset_id:
            return item
    raise AssertionError(f"清单里没有 {asset_type}/{asset_id}")


@pytest.fixture()
def harness() -> Iterator[Harness]:
    """真实路由 + 内存库 + 最小项目结构；同一个 factory 供测试直接读写库。"""
    factory, engine = _build()
    app.dependency_overrides[get_db] = _override(factory)
    _seed_structure(factory)
    try:
        yield TestClient(app), factory
    finally:
        app.dependency_overrides.clear()
        asyncio.run(engine.dispose())


# ---------------------------------------------------------------------------
# 1) shot 档商品关联行 → 商品进第 2 步 readiness 清单
# ---------------------------------------------------------------------------


def test_shot_scoped_product_link_enters_asset_readiness(harness: Harness) -> None:
    """``ProjectProductLink``（shot 档）存在时，商品必须在清单里，且计数与总数都对得上。

    契约 §六 第 3 条：``schemas/studio/assets.py`` 的类型 Literal 早已放宽到五类，
    而 service 只算四类 —— 那种"少一行、不报错"的缺口只能用计数钉住。
    """
    client, factory = harness
    _seed_product(factory)
    _link_product(factory, shot_id=SHOT_ID)

    payload = _readiness(client)
    item = _item(payload, "product", PRODUCT_ID)
    assert item["name"] == PRODUCT_NAME
    # 商品与其余类型**同一组字段**（同一套就绪判定，没有商品专用分支）
    assert item["has_pending_candidate"] is False
    assert item["has_image_prompt"] is False
    assert item["has_image"] is False
    assert item["has_primary"] is False
    assert payload["summary"]["asset_counts"]["product"] == 1
    assert payload["summary"]["total"] == 1


def test_unlinked_product_is_not_in_readiness(harness: Harness) -> None:
    """库里存在商品但**没有关联行** → 不进本项目清单（清单只算本项目的资产）。

    这是上一条的对照：证明商品确实是被"项目关联"带进清单的，
    而不是"只要 products 表里有行就出现"。
    """
    client, factory = harness
    _seed_product(factory)

    payload = _readiness(client)
    assert payload["items"] == []
    assert payload["summary"]["asset_counts"]["product"] == 0
    assert payload["summary"]["total"] == 0


# ---------------------------------------------------------------------------
# 2) 第 4 步镜头资产列表：商品能返回，且只认 shot 档
# ---------------------------------------------------------------------------


def test_list_shot_linked_assets_returns_shot_scoped_product(harness: Harness) -> None:
    """``list_shot_linked_assets`` 必须返回商品；chapter 档的关联行不算"这一镜出现商品"。"""
    client, factory = harness
    _seed_product(factory, product_id="prod-shot")
    _link_product(factory, shot_id=SHOT_ID, product_id="prod-shot")
    # 同项目里的另一个商品只挂到章节档（shot_id 为空）→ 不该出现在镜头列表里
    _seed_product(factory, product_id="prod-chapter", name="焕颜精华（章节档）")
    _link_product(factory, shot_id=None, product_id="prod-chapter")

    res = client.get(SHOT_ASSETS, params={"page": 1, "page_size": 10})
    assert res.status_code == 200, res.text
    items = res.json()["data"]["items"]
    assert [(row["type"], row["id"], row["name"]) for row in items] == [
        ("product", "prod-shot", PRODUCT_NAME)
    ]
    # 返回结构沿用既有字段名，没有商品专用形状
    assert set(items[0]) == {"type", "id", "file_id", "image_id", "name", "thumbnail"}


def test_shot_assets_overview_includes_product(harness: Harness) -> None:
    """总览（第 4 步页面用）与镜头资产列表同源：商品要出现在 overview.items 里。"""
    client, factory = harness
    _seed_product(factory)
    _link_product(factory, shot_id=SHOT_ID)

    res = client.get(f"/api/v1/studio/shots/{SHOT_ID}/assets-overview")
    assert res.status_code == 200, res.text
    data = res.json()["data"]
    product_rows = [row for row in data["items"] if row["type"] == "product"]
    assert len(product_rows) == 1
    assert product_rows[0]["is_linked"] is True
    assert data["summary"]["linked_count"] == 1


def test_chapter_asset_candidates_include_product(harness: Harness) -> None:
    """第 2 步的候选清单必须聚合商品（``CANDIDATE_TYPES`` 复用 ``ASSET_TYPES``）。

    这条钉的是"静默丢弃"：候选聚合入口原来按自抄的四类过滤，商品候选会被
    ``continue`` 掉 —— 页面看不到已提取的商品，接口却不报错。
    """
    client, factory = harness

    async def seed_candidate() -> None:
        async with factory() as db:
            db.add(
                ShotExtractedCandidate(
                    shot_id=SHOT_ID,
                    candidate_type="product",
                    candidate_name=PRODUCT_NAME,
                    candidate_status="pending",
                    payload={},
                )
            )
            await db.commit()

    asyncio.run(seed_candidate())

    res = client.get(f"/api/v1/studio/chapters/{CHAPTER_ID}/asset-candidates")
    assert res.status_code == 200, res.text
    data = res.json()["data"]
    assert [(item["candidate_type"], item["type_label"], item["name"]) for item in data["items"]] == [
        ("product", "商品", PRODUCT_NAME)
    ]
    assert data["summary"]["by_type"] == {"product": 1}
    # 库里还没有同名商品 → 建议新建（存在性检测同样要能查商品，否则永远建议新建）
    assert data["items"][0]["recommendation"] == "create_new"
    assert data["items"][0]["existing_asset_id"] is None


# ---------------------------------------------------------------------------
# 3) 第 2 步确认：asset_type="product" 不再 KeyError，并落下正确关联行
# ---------------------------------------------------------------------------


def test_confirm_product_profile_creates_product_and_project_link(harness: Harness) -> None:
    """确认走的是 ``_link_model_for`` + ``LINK_MODEL_BY_TYPE``；商品缺项时是 ``KeyError``。

    这里断言三件事：不再抛异常、真的建出 Product、真的落下 ``ProjectProductLink``
    （外键列 ``product_id``，与 ``entity_specs.LINK_MODEL_BY_ENTITY`` 同口径）。
    """
    _client, factory = harness
    _seed_product_record(factory)

    async def run() -> dict[str, Any]:
        async with factory() as db:
            result = await confirm_chapter_asset_profiles(db, chapter_id=CHAPTER_ID)
            await db.commit()
            return result

    result = asyncio.run(run())

    rows = [row for row in result["results"] if row["asset_type"] == "product"]
    assert len(rows) == 1, result["results"]
    row = rows[0]
    assert row["ok"] is True
    assert row["action"] == "create_new"
    asset_id = str(row["asset_id"])
    assert asset_id.startswith("product-"), asset_id

    async def read_back() -> tuple[Any, list[Any]]:
        async with factory() as db:
            product = await db.get(Product, asset_id)
            links = (
                (
                    await db.execute(
                        select(ProjectProductLink).where(
                            ProjectProductLink.product_id == asset_id,
                            ProjectProductLink.project_id == PROJECT_ID,
                        )
                    )
                )
                .scalars()
                .all()
            )
            return product, list(links)

    product, links = asyncio.run(read_back())
    assert product is not None, "确认动作必须真的建出商品行"
    assert product.name == PRODUCT_NAME
    assert len(links) == 1, "确认动作必须落下商品的项目关联行"
    # 商品是全局资产：本章资料不写全局行（写的是章节 overlay），关联行带 chapter 档
    assert str(links[0].chapter_id) == CHAPTER_ID
    assert links[0].shot_id is None
    # 确认接口回的就是第 2 步页面用的那份清单
    assert any(
        item["asset_type"] == "product" and item["asset_id"] == asset_id
        for item in result["asset_readiness"]["items"]
    )


def test_confirm_product_profile_via_http(harness: Harness) -> None:
    """走真实路由确认商品项：整条链（读库清单 → 建商品 → 落关联 → 回清单）都不崩。"""
    client, factory = harness
    _seed_product_record(factory)

    res = client.post(f"/api/v1/studio/chapters/{CHAPTER_ID}/asset-profiles/confirm", json={})
    assert res.status_code == 200, res.text
    data = res.json()["data"]
    rows = [row for row in data["results"] if row["asset_type"] == "product"]
    assert len(rows) == 1 and rows[0]["ok"] is True, rows
    assert any(
        item["asset_type"] == "product" and item["asset_id"] == rows[0]["asset_id"]
        for item in data["asset_readiness"]["items"]
    )


def test_confirm_existing_product_goes_through_link_model_for(harness: Harness) -> None:
    """**契约 §六 第 1 条的正中靶心**：`选用已有商品` 会走
    ``_link_model_for(asset_type)`` + ``LINK_MODEL_BY_TYPE[asset_type]``。

    ``create_new`` 分支的关联是由 ``entity_crud.create_entity`` 内部建的，
    **碰不到那两个映射** —— 所以只测新建分支时，缺 product 键的 ``KeyError``
    照样会漏过测试（这正是这条缺口能活到验收阶段的原因）。这里把库里的同名商品
    摆好（存在性检测会把这一项判成"选用已有"），让确认动作真的走到那个分支。
    """
    _client, factory = harness
    _seed_product(factory)
    # 商品已关联到本项目（页面上的「选用已有」正是这种前置状态）
    _link_product(factory, shot_id=None)
    _seed_product_record(factory)

    async def run() -> dict[str, Any]:
        async with factory() as db:
            result = await confirm_chapter_asset_profiles(db, chapter_id=CHAPTER_ID)
            await db.commit()
            return result

    result = asyncio.run(run())

    rows = [row for row in result["results"] if row["asset_type"] == "product"]
    assert len(rows) == 1, result["results"]
    assert rows[0]["ok"] is True
    # 库里已有同名商品 → 必须复用而不是再建一个
    assert rows[0]["action"] == "link_existing"
    assert rows[0]["asset_id"] == PRODUCT_ID

    # 关联行真的写下了（`_link_existing` 里那句 upsert_project_link）
    async def read_links() -> list[Any]:
        async with factory() as db:
            return list(
                (
                    await db.execute(
                        select(ProjectProductLink).where(
                            ProjectProductLink.product_id == PRODUCT_ID,
                            ProjectProductLink.project_id == PROJECT_ID,
                        )
                    )
                )
                .scalars()
                .all()
            )

    links = asyncio.run(read_links())
    assert links, "选用已有商品也必须落下项目关联行"
    assert any(str(link.chapter_id) == CHAPTER_ID for link in links)


# ---------------------------------------------------------------------------
# 4) 带 shot_id 新建商品不再 ValueError（枚举是回写路径的类型闸）
# ---------------------------------------------------------------------------


def test_create_product_with_shot_id_marks_candidate_linked(harness: Harness) -> None:
    """``POST /entities/product`` 带 shot_id：不得 ``ValueError``，候选要回写为 linked。

    这条钉的是 ``ShotCandidateType``：``mark_linked_by_name`` 内部做
    ``ShotCandidateType("product")``，枚举少一个成员就是 500 —— 而且只有"带 shot_id 新建"
    这条路径才会走到，普通新建看不出来。
    """
    client, factory = harness

    async def seed_candidate() -> None:
        async with factory() as db:
            # 候选列是 String(32)：这里按**库里真实的字符串值**写，不依赖枚举，
            # 才能证明是内部那次转换过去会炸、现在不炸。
            db.add(
                ShotExtractedCandidate(
                    shot_id=SHOT_ID,
                    candidate_type="product",
                    candidate_name=PRODUCT_NAME,
                    candidate_status="pending",
                    payload={},
                )
            )
            await db.commit()

    asyncio.run(seed_candidate())

    _create_entity(
        client,
        "product",
        PRODUCT_ID,
        PRODUCT_NAME,
        project_id=PROJECT_ID,
        chapter_id=CHAPTER_ID,
        shot_id=SHOT_ID,
    )

    async def read_candidate() -> ShotExtractedCandidate | None:
        async with factory() as db:
            return (
                await db.execute(
                    select(ShotExtractedCandidate).where(ShotExtractedCandidate.shot_id == SHOT_ID)
                )
            ).scalars().one_or_none()

    candidate = asyncio.run(read_candidate())
    assert candidate is not None
    assert str(candidate.candidate_status) == "linked"
    assert str(candidate.linked_entity_id) == PRODUCT_ID

    async def read_link() -> Any:
        async with factory() as db:
            return (
                await db.execute(select(ProjectProductLink).where(ProjectProductLink.shot_id == SHOT_ID))
            ).scalars().one_or_none()

    assert asyncio.run(read_link()) is not None


def test_existence_check_accepts_product_names_and_stays_backward_compatible(harness: Harness) -> None:
    """existence-check 新增商品桶，同时**老的四字段请求体仍然可用**（前端本批不改）。"""
    client, factory = harness
    _seed_product(factory)
    _link_product(factory, shot_id=None)

    with_product = client.post(
        f"{ENTITIES}/existence-check",
        json={
            "project_id": PROJECT_ID,
            "shot_id": SHOT_ID,
            "character_names": [],
            "prop_names": [],
            "scene_names": [],
            "costume_names": [],
            "product_names": [PRODUCT_NAME],
        },
    )
    assert with_product.status_code == 200, with_product.text
    products = with_product.json()["data"]["products"]
    assert [row["asset_id"] for row in products] == [PRODUCT_ID]
    assert products[0]["exists"] is True
    assert products[0]["linked_to_project"] is True

    # 向后兼容：老调用方（第 2 步页面）只发四个名称字段，不得 422
    legacy = client.post(
        f"{ENTITIES}/existence-check",
        json={
            "project_id": PROJECT_ID,
            "shot_id": SHOT_ID,
            "character_names": [],
            "prop_names": [],
            "scene_names": [],
            "costume_names": [],
        },
    )
    assert legacy.status_code == 200, legacy.text
    assert legacy.json()["data"]["products"] == []


# ---------------------------------------------------------------------------
# 5) 回归护栏：其余四类既有行为不变 + 商品仍然不进文本提示词
# ---------------------------------------------------------------------------


def test_four_classic_types_still_behave_the_same(harness: Harness) -> None:
    """既有四类的清单与镜头列表结果**一个字段都不变**（商品是纯新增的一行）。"""
    client, factory = harness
    _create_entity(client, "character", "char-1", "林小满", project_id=PROJECT_ID)
    _create_entity(client, "scene", "scene-1", "咖啡店")
    _create_entity(client, "prop", "prop-1", "热咖啡")
    _create_entity(client, "costume", "costume-1", "米色风衣")

    for entity_type, asset_id in (
        ("scene", "scene-1"),
        ("prop", "prop-1"),
        ("costume", "costume-1"),
    ):
        res = client.post(
            f"{SHOT_LINKS}/{entity_type}",
            json={
                "project_id": PROJECT_ID,
                "chapter_id": CHAPTER_ID,
                "shot_id": SHOT_ID,
                "asset_id": asset_id,
            },
        )
        assert res.status_code == 201, res.text

    async def link_character() -> None:
        async with factory() as db:
            db.add(ShotCharacterLink(shot_id=SHOT_ID, character_id="char-1", index=0))
            await db.commit()

    asyncio.run(link_character())

    payload = _readiness(client)
    assert {item["asset_type"] for item in payload["items"]} == {
        "character",
        "scene",
        "prop",
        "costume",
    }
    assert payload["summary"]["asset_counts"] == {
        "character": 1,
        "scene": 1,
        "prop": 1,
        "costume": 1,
        "product": 0,
    }
    assert payload["summary"]["total"] == 4

    res = client.get(SHOT_ASSETS, params={"page": 1, "page_size": 10})
    assert res.status_code == 200, res.text
    rows = res.json()["data"]["items"]
    assert sorted(row["type"] for row in rows) == ["character", "costume", "prop", "scene"]


@pytest.mark.asyncio
async def test_product_still_does_not_enter_text_prompt_pack() -> None:
    """行为级护栏：商品已绑到镜头，但**文本提示词包里看不到它**（商品只走帧参考图）。

    ``test_drama_plan_product_read_side.py`` 那条是源码结构断言；这条从**产物**上再钉一次：
    商品进了镜头资产列表（第 4 步要显示），却没有进 pack 的资产引用。
    """
    from app.models.studio import FileItem, ProductImage
    from app.services.studio.shot_video_prompt_pack import build_shot_video_prompt_pack
    from tests.llm_orchestration_fixtures import build_session, seed_project_chapter_shot

    db, engine = await build_session()
    try:
        async with db:
            await seed_project_chapter_shot(db)  # proj-1 / chap-1 / shot-1
            db.add(
                Product(
                    id="prod-pack",
                    name="焕颜精华",
                    description="白色磨砂瓶身，金色压泵",
                    style="真人古装",
                    visual_style="现实",
                )
            )
            db.add(
                FileItem(
                    id="file-pack",
                    type="image",
                    name="商品定版图",
                    storage_key="https://oss.example.com/products/prod-pack/front.png",
                )
            )
            await db.flush()
            db.add(
                ProductImage(
                    id=1,
                    product_id="prod-pack",
                    file_id="file-pack",
                    is_primary=True,
                    view_angle="FRONT",
                    quality_level="HIGH",
                )
            )
            db.add(ProjectProductLink(project_id="proj-1", shot_id="shot-1", product_id="prod-pack"))
            await db.flush()

            # 前提：商品确实进了镜头资产列表（否则这条护栏是空转的）
            linked = await list_shot_linked_assets(db, shot_id="shot-1")
            assert [item.type for item in linked] == ["product"]

            pack = await build_shot_video_prompt_pack(db, shot_id="shot-1")
    finally:
        await engine.dispose()

    assert pack.characters == []
    assert pack.props == []
    assert pack.costumes == []
    assert pack.scene is None
    assert "焕颜精华" not in json.dumps(pack.model_dump(), ensure_ascii=False)
