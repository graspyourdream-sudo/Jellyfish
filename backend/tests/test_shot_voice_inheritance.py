"""第 4 步「资产与声音检查」：角色声音的**只读继承**读口（设计包 §10）。

用户口径（设计包 §10 逐字）
==========================

**唯一事实来源 = 人物资产。** 声音属于人物资产，不属于单个镜头。

| 环节 | 人工操作 | 数据来源 | 缺项处理 |
|---|---|---|---|
| 第 2 步 · 人物资产详情 | 选择 / 试听 / 保存 / 更换（**全站唯一入口**） | 声音素材 | 未绑定不影响其它字段保存 |
| 第 4 步 · 资产与声音检查 | **无（只读）** | 人物资产「角色声音」，按资产「出现镜头」继承 | 标为声音缺项 + 「返回人物资产补充」 |

因此本文件证明四件事
====================

1. **读得对**：恰好一个角色绑了声音 → ``inherited``（带来源人物资产）；
   多个都绑了 → ``ambiguous``（**不替用户挑**，列候选）；都没有 → ``missing``；
   本镜标记无需声音 → ``opt_out``；角色没绑但本镜还留着迁移前的逐镜声音 →
   ``legacy_snapshot``（历史记录，只读）。
2. **只读**：读一次接口，``file_usages`` 与 ``shot_details`` 逐行不变（没有任何写库副作用）。
3. **没有第二套写入口**：本模块的资产声音路由里，镜头侧只有这一个 **GET**；
   没有 ``PUT/PATCH/DELETE /shots/…``；改声音只能走
   ``PUT /asset-voices/character/{角色ID}``（第 2 步人物资产详情）。
4. **不越界**：场景 / 道具 / 服装上的声音**不**进第 4 步的角色声音检查
   （本区块只管角色声音 / 人物配音）。

全部零出网、零付费：只用内存库与 TestClient，不调模型、不触图、不触视频。
"""

from __future__ import annotations

import asyncio
from typing import Any, AsyncGenerator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.dependencies import get_db
from app.main import app
from app.models.studio_file_usages import FileUsage
from app.models.types import FileUsageKind

PROJECT_ID = "proj-shot-voice"
CHAPTER_ID = "chap-shot-voice"
SHOT_ID = "shot-voice-1"
SHOT_OPT_OUT = "shot-voice-2"
SHOT_EMPTY = "shot-voice-3"
SHOT_LEGACY = "shot-voice-4"

CHAR_A = "char-sv-a"
CHAR_B = "char-sv-b"
CHAR_C = "char-sv-c"
SCENE_ID = "scene-sv-1"

AUDIO_A = "file-sv-a"
AUDIO_B = "file-sv-b"
AUDIO_SCENE = "file-sv-scene"
AUDIO_LEGACY = "file-sv-legacy"

BASE = "/api/v1/studio/asset-voices"
INHERITANCE = f"{BASE}/shots/{{shot_id}}/inheritance"


def _build_harness() -> tuple[async_sessionmaker[AsyncSession], Any]:
    from app.core.db import Base
    from app.models.studio import Chapter, Project  # noqa: F401  (触发建表)

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async def _create() -> None:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(_create())
    return factory, engine


def _override(factory: async_sessionmaker[AsyncSession]):
    async def override_db() -> AsyncGenerator[AsyncSession, None]:
        async with factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    return override_db


def _seed(factory: async_sessionmaker[AsyncSession]) -> None:
    """项目 + 章节 + 4 个镜头 + 2 个角色 + 3 条音频，覆盖全部只读结论。"""
    from app.models.studio import (
        Chapter,
        Character,
        FileItem,
        Project,
        Scene,
        Shot,
        ShotCharacterLink,
        ShotDetail,
    )
    from app.models.types import FileType

    async def run() -> None:
        async with factory() as db:
            db.add(Project(id=PROJECT_ID, name="声音继承测试", description="", style="真人古装", visual_style="现实"))
            db.add(
                Chapter(
                    id=CHAPTER_ID,
                    project_id=PROJECT_ID,
                    index=1,
                    title="第一集",
                    raw_text="丫鬟端茶。",
                    condensed_text="丫鬟端茶。",
                )
            )
            await db.flush()
            # 四个镜头分别对应：继承 / 无需声音 / 缺项 / 历史快照
            db.add(Shot(id=SHOT_ID, chapter_id=CHAPTER_ID, index=1, title="端茶", script_excerpt="丫鬟甲端茶。"))
            db.add(Shot(id=SHOT_OPT_OUT, chapter_id=CHAPTER_ID, index=2, title="空镜", script_excerpt="庭院无人。"))
            db.add(Shot(id=SHOT_EMPTY, chapter_id=CHAPTER_ID, index=3, title="路人", script_excerpt="路人经过。"))
            db.add(Shot(id=SHOT_LEGACY, chapter_id=CHAPTER_ID, index=4, title="旧镜", script_excerpt="旧素材。"))
            db.add(ShotDetail(id=SHOT_ID, camera_shot="中景", angle="平视", movement="固定", description=""))
            db.add(
                ShotDetail(
                    id=SHOT_OPT_OUT,
                    camera_shot="中景",
                    angle="平视",
                    movement="固定",
                    description="",
                    audio_opt_out=True,
                )
            )
            db.add(ShotDetail(id=SHOT_EMPTY, camera_shot="中景", angle="平视", movement="固定", description=""))
            db.add(
                ShotDetail(
                    id=SHOT_LEGACY,
                    camera_shot="中景",
                    angle="平视",
                    movement="固定",
                    description="",
                    audio_file_id=AUDIO_LEGACY,
                    voice_inherited_from=f"character:{CHAR_A}",
                )
            )
            db.add(
                Character(
                    id=CHAR_A,
                    project_id=PROJECT_ID,
                    name="苏晚棠",
                    description="素白襦裙",
                    style="真人古装",
                    visual_style="现实",
                )
            )
            db.add(
                Character(
                    id=CHAR_B,
                    project_id=PROJECT_ID,
                    name="叶老夫人",
                    description="银灰高髻",
                    style="真人古装",
                    visual_style="现实",
                )
            )
            # 第三个角色：**没有**绑声音（用来证明"有角色但没声音 = 缺项"）
            db.add(
                Character(
                    id=CHAR_C,
                    project_id=PROJECT_ID,
                    name="小厮",
                    description="青布短打",
                    style="真人古装",
                    visual_style="现实",
                )
            )
            # 场景（全局资产）：它绑的声音**不该**出现在第 4 步的角色声音检查里
            db.add(Scene(id=SCENE_ID, name="侯府大堂", description="青砖地面", style="真人古装", view_count=1, tags=[]))
            db.add(FileItem(id=AUDIO_A, type=FileType.audio, name="晚棠配音.mp3", storage_key="files/sv-a.mp3"))
            db.add(FileItem(id=AUDIO_B, type=FileType.audio, name="老夫人配音.mp3", storage_key="files/sv-b.mp3"))
            db.add(FileItem(id=AUDIO_SCENE, type=FileType.audio, name="大堂环境.mp3", storage_key="files/sv-scene.mp3"))
            db.add(FileItem(id=AUDIO_LEGACY, type=FileType.audio, name="旧逐镜配音.mp3", storage_key="files/sv-legacy.mp3"))
            await db.flush()

            # 镜头↔角色：SHOT_ID 只挂 1 个角色（继承 CHAR_A 的声音）；
            # SHOT_EMPTY 挂 2 个角色，但这两个都没绑声音 → 缺项；
            # SHOT_LEGACY 挂一个没绑声音的角色 + 自己还留着迁移前的逐镜声音 → 历史快照
            db.add(ShotCharacterLink(shot_id=SHOT_ID, character_id=CHAR_A, index=1))
            db.add(ShotCharacterLink(shot_id=SHOT_EMPTY, character_id=CHAR_B, index=1))
            db.add(ShotCharacterLink(shot_id=SHOT_EMPTY, character_id=CHAR_C, index=2))
            db.add(ShotCharacterLink(shot_id=SHOT_LEGACY, character_id=CHAR_B, index=1))
            # 场景声音：走同一个绑定接口，但不属于角色声音
            from app.models.studio import ProjectSceneLink

            db.add(ProjectSceneLink(project_id=PROJECT_ID, chapter_id=CHAPTER_ID, shot_id=SHOT_ID, scene_id=SCENE_ID))
            from app.services.studio.asset_voices import bind_asset_voice

            await db.flush()
            await bind_asset_voice(db, asset_type="character", asset_id=CHAR_A, file_id=AUDIO_A)
            await bind_asset_voice(db, asset_type="scene", asset_id=SCENE_ID, file_id=AUDIO_SCENE)
            await db.commit()

    asyncio.run(run())


@pytest.fixture
def voice_client() -> Any:
    factory, engine = _build_harness()
    _seed(factory)
    app.dependency_overrides[get_db] = _override(factory)
    try:
        yield TestClient(app), factory
    finally:
        app.dependency_overrides.pop(get_db, None)
        asyncio.run(engine.dispose())


def _rows(factory: async_sessionmaker[AsyncSession], sql: Any) -> list[tuple]:
    """只读地把库里某些行取出来（用于断言"读接口没有写库副作用"）。"""

    async def run() -> list[tuple]:
        async with factory() as db:
            result = await db.execute(sql)
            return [tuple(row) for row in result.fetchall()]

    return asyncio.run(run())


def _snapshot(factory: async_sessionmaker[AsyncSession]) -> dict[str, list[tuple]]:
    """资产声音行 + 镜头声音相关列的完整快照。"""
    from app.models.studio import ShotDetail

    return {
        "file_usages": _rows(
            factory,
            select(FileUsage.source_ref, FileUsage.file_id, FileUsage.usage_kind).order_by(
                FileUsage.source_ref, FileUsage.file_id
            ),
        ),
        "shot_details": _rows(
            factory,
            select(
                ShotDetail.id,
                ShotDetail.audio_file_id,
                ShotDetail.audio_opt_out,
                ShotDetail.voice_inherited_from,
            ).order_by(ShotDetail.id),
        ),
    }


# ---------------------------------------------------------------------------
# 1) 只读结论：五种状态
# ---------------------------------------------------------------------------


def test_inherited_voice_reports_source_asset(voice_client: Any) -> None:
    """恰好一个角色绑了声音 → 继承它，并说清来源人物资产（「音色名 · 继承自人物资产」）。"""
    client, _factory = voice_client
    response = client.get(INHERITANCE.format(shot_id=SHOT_ID))
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["state"] == "inherited"
    assert data["file_name"] == "晚棠配音.mp3"
    assert data["source_asset_name"] == "苏晚棠"
    assert data["source_asset_type"] == "character"
    assert data["voice_asset_count"] == 1
    assert data["character_count"] == 1


def test_shot_opt_out_beats_inheritance(voice_client: Any) -> None:
    """本镜明确标记「无需声音」→ 生效结论就是没有声音（角色侧已绑的声音仍如实带回）。"""
    client, _factory = voice_client
    data = client.get(INHERITANCE.format(shot_id=SHOT_OPT_OUT)).json()["data"]
    assert data["state"] == "opt_out"
    assert data["file_id"] == ""
    assert data["voice_asset_count"] == 0


def test_missing_voice_reports_zero_and_no_legacy(voice_client: Any) -> None:
    """角色一个都没绑、也没有历史声音 → ``missing``（页面据此给「返回人物资产补充」）。"""
    client, _factory = voice_client
    data = client.get(INHERITANCE.format(shot_id=SHOT_EMPTY)).json()["data"]
    assert data["state"] == "missing"
    assert data["file_id"] == ""
    assert data["legacy_file_id"] == ""
    assert data["character_count"] == 2, "有两个角色但都没绑声音 → 仍然是缺项"


def test_legacy_shot_voice_is_reported_as_readonly_snapshot(voice_client: Any) -> None:
    """角色没绑、但本镜还留着迁移前的逐镜声音 → 如实报为历史快照（只读）。"""
    client, _factory = voice_client
    data = client.get(INHERITANCE.format(shot_id=SHOT_LEGACY)).json()["data"]
    assert data["state"] == "legacy_snapshot"
    assert data["file_id"] == "", "历史快照不是『继承来的声音』，不许冒充资产声音"
    assert data["legacy_file_id"] == AUDIO_LEGACY
    assert data["legacy_file_name"] == "旧逐镜配音.mp3"
    assert data["legacy_inherited_from"] == f"character:{CHAR_A}"


def test_multiple_voiced_characters_are_not_guessed(voice_client: Any) -> None:
    """多个角色都绑了声音 → ``ambiguous``：**不替用户挑**，列出候选。"""
    client, factory = voice_client

    async def _add_second_voice() -> None:
        from app.services.studio.asset_voices import bind_asset_voice

        async with factory() as db:
            await bind_asset_voice(db, asset_type="character", asset_id=CHAR_B, file_id=AUDIO_B)
            from app.models.studio import ShotCharacterLink

            db.add(ShotCharacterLink(shot_id=SHOT_ID, character_id=CHAR_B, index=2))
            await db.commit()

    asyncio.run(_add_second_voice())

    data = client.get(INHERITANCE.format(shot_id=SHOT_ID)).json()["data"]
    assert data["state"] == "ambiguous"
    assert data["file_id"] == "", "多人物镜头不挑一个声音出来（挑错比没有更糟）"
    assert sorted(data["candidates"]) == ["叶老夫人", "苏晚棠"]
    assert data["voice_asset_count"] == 2


def test_unknown_shot_is_a_structured_404(voice_client: Any) -> None:
    """不存在的镜头要结构化拒绝（不返回一个"看起来很正常"的空结论）。"""
    client, _factory = voice_client
    response = client.get(INHERITANCE.format(shot_id="shot-not-there"))
    assert response.status_code == 404
    assert response.json()["meta"]["error"]["code"] == "shot_not_found"


def test_non_character_asset_voice_is_out_of_scope(voice_client: Any) -> None:
    """场景上的声音属于**另一个区块**，不进第 4 步的角色声音检查。"""
    client, _factory = voice_client
    # 场景确实绑了声音（走同一个接口）
    scene_voice = client.get(f"{BASE}/scene/{SCENE_ID}").json()["data"]
    assert scene_voice["bound"] is True
    # 但它不改变角色声音的结论：SHOT_EMPTY 仍然是缺项
    data = client.get(INHERITANCE.format(shot_id=SHOT_EMPTY)).json()["data"]
    assert data["state"] == "missing"
    assert data["voice_asset_count"] == 0


# ---------------------------------------------------------------------------
# 2) 只读：读接口没有任何写库副作用；镜头侧没有第二套写入口
# ---------------------------------------------------------------------------


def test_reading_inheritance_never_writes(voice_client: Any) -> None:
    """读一遍（含异常分支）之后，``file_usages`` 与 ``shot_details`` 逐行不变。"""
    client, factory = voice_client
    before = _snapshot(factory)

    for shot_id in (SHOT_ID, SHOT_OPT_OUT, SHOT_EMPTY, SHOT_LEGACY):
        assert client.get(INHERITANCE.format(shot_id=shot_id)).status_code == 200
    assert client.get(INHERITANCE.format(shot_id="shot-not-there")).status_code == 404

    assert _snapshot(factory) == before, "第 4 步的读接口不许写库（含 asset_voice 与镜头级字段）"


def test_shot_side_has_no_write_route() -> None:
    """镜头侧的声音路由**只有 GET**：第 4 步没有第二套选择 / 更换入口。"""
    shot_voice_routes: list[tuple[str, str]] = []
    for route in app.routes:
        path = str(getattr(route, "path", ""))
        if "/asset-voices/shots/" not in path:
            continue
        for method in getattr(route, "methods", set()) or set():
            shot_voice_routes.append((method, path))

    methods = sorted({method for method, _path in shot_voice_routes})
    assert methods == ["GET"], f"镜头侧出现了写入口：{shot_voice_routes}"
    assert len(shot_voice_routes) == 1, f"镜头侧应当只有一个读口，实际：{shot_voice_routes}"


def test_asset_voice_writes_require_the_asset_level_path(voice_client: Any) -> None:
    """改声音只能走资产级路径（第 2 步人物资产详情）；镜头级路径不接受写入。"""
    client, _factory = voice_client
    assert client.put(INHERITANCE.format(shot_id=SHOT_ID), json={"file_id": AUDIO_B}).status_code == 405
    assert client.delete(INHERITANCE.format(shot_id=SHOT_ID)).status_code == 405
    # 资产级（= 第 2 步）才是唯一写入口
    assert client.put(f"{BASE}/character/{CHAR_A}", json={"file_id": AUDIO_B}).status_code == 200


def test_usage_kind_stays_asset_voice_only(voice_client: Any) -> None:
    """读第 4 步不会顺手往 ``file_usages`` 里插新用途的行（范围不扩张）。"""
    client, factory = voice_client
    assert client.get(INHERITANCE.format(shot_id=SHOT_ID)).status_code == 200
    kinds = {
        str(row[2])
        for row in _rows(factory, select(FileUsage.source_ref, FileUsage.file_id, FileUsage.usage_kind))
    }
    assert kinds == {FileUsageKind.asset_voice.value}
