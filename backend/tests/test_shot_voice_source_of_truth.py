"""角色声音的**唯一事实来源**：人物资产（第 2 步），不是镜头（设计包 §10）。

产品口径（本文件逐条钉住）
==========================

1. 第 2 步「人物资产详情」是**唯一**绑定角色声音的地方；
2. 角色声音属于**人物资产**，不属于某一个镜头；
3. 改人物资产的音色 → **所有关联镜头下次生成自动用新音色**，不需要逐镜批量更新；
4. 第 4 步「资产与声音检查」**只读**：既不能选择、也不能更换、更不能保存声音；
5. ``audio_opt_out`` = "本镜明确无需声音"，**覆盖**角色声音继承；
6. ``shot_details.audio_file_id``（迁移 009 之前的逐镜声音）只能当**兼容快照 / 迁移依据**，
   **永远不得优先于**人物资产当前的音色；
7. 不许存在第二套"逐镜角色声音"编辑源。

生成侧的解析顺序（唯一实现：``video_audio_input.resolve_audio_admission``）：
``opt_out`` → **人物资产音色** → 兼容快照 → 无。

零出网、零付费：只跑内存库 + TestClient，不调任何供应商。
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
from app.models.studio import ShotDetail
from app.services.studio.video_audio_input import (
    VOICE_SOURCE_CHARACTER_ASSET,
    VOICE_SOURCE_LEGACY_SNAPSHOT,
    VOICE_SOURCE_NONE,
    resolve_audio_admission,
)

PROJECT_ID = "proj-sot"
CHAPTER_ID = "chap-sot"

#: 每个镜头覆盖一条口径分支
SHOT_MIGRATED = "shot-sot-migrated"  # 迁移把它的逐镜声音提升成了角色声音（同一条音频）
SHOT_SNAPSHOT = "shot-sot-snapshot"  # 角色有音色 + 本镜还留着**另一条**旧快照
SHOT_OPT_OUT = "shot-sot-optout"  # 本镜明确无需声音
SHOT_TWO_CHARS = "shot-sot-two"  # 两个人物各有音色 → 不挑
SHOT_PLAIN = "shot-sot-plain"  # 人物没有音色 + 本镜有旧快照 → 兼容兜底

CHAR_MIGRATED = "char-sot-migrated"
CHAR_SNAPSHOT = "char-sot-snapshot"
CHAR_OPT_OUT = "char-sot-optout"
CHAR_TWO_A = "char-sot-two-a"
CHAR_TWO_B = "char-sot-two-b"
CHAR_PLAIN = "char-sot-plain"

AUDIO_MIGRATED = "file-sot-migrated"  # 迁移提升出来的角色声音
AUDIO_MIGRATED_NEW = "file-sot-migrated-new"  # 用户在第 2 步换成的**新**音色
AUDIO_SNAPSHOT_ROLE = "file-sot-snapshot-role"  # char-snapshot 的角色声音
AUDIO_OLD_SNAPSHOT = "file-sot-old-snapshot"  # 该镜留下的**另一条**历史快照
AUDIO_OPT_OUT_ROLE = "file-sot-optout-role"
AUDIO_TWO_A = "file-sot-two-a"
AUDIO_TWO_B = "file-sot-two-b"
AUDIO_PLAIN_SNAPSHOT = "file-sot-plain-snapshot"

URL_MIGRATED = "https://cdn.example.test/voice-migrated.mp3"
URL_MIGRATED_NEW = "https://cdn.example.test/voice-migrated-new.mp3"
URL_SNAPSHOT_ROLE = "https://cdn.example.test/voice-snapshot-role.mp3"
URL_OLD_SNAPSHOT = "https://cdn.example.test/voice-old-snapshot.mp3"
URL_OPT_OUT_ROLE = "https://cdn.example.test/voice-optout-role.mp3"
URL_TWO_A = "https://cdn.example.test/voice-two-a.mp3"
URL_TWO_B = "https://cdn.example.test/voice-two-b.mp3"
URL_PLAIN_SNAPSHOT = "https://cdn.example.test/voice-plain-snapshot.mp3"

PROVIDER = "apimart"
SHOT_DETAILS = "/api/v1/studio/shot-details"
INHERITANCE = "/api/v1/studio/asset-voices/shots/{shot_id}/inheritance"


# ---------------------------------------------------------------------------
# 夹具：内存库 + 与迁移后一致的初始数据
# ---------------------------------------------------------------------------


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
    """项目 + 章节 + 5 个镜头 + 5 个角色 + 8 条音频，覆盖全部口径分支。

    数据形态刻意做成"迁移刚跑完"的样子：``shot-sot-migrated`` 的历史逐镜声音
    （``audio_file_id``）与它的人物资产音色**是同一条音频** —— 这正是迁移 009
    提升出来的那一行，也是旧回滚会误删的那种数据。
    """
    from app.models.studio import (
        Chapter,
        Character,
        FileItem,
        Project,
        Shot,
        ShotCharacterLink,
    )
    from app.models.types import FileType
    from app.services.studio.asset_voices import bind_asset_voice

    async def run() -> None:
        async with factory() as db:
            db.add(Project(id=PROJECT_ID, name="声音口径测试", description="", style="真人古装", visual_style="现实"))
            db.add(
                Chapter(
                    id=CHAPTER_ID,
                    project_id=PROJECT_ID,
                    index=1,
                    title="第一集",
                    raw_text="苏晚棠与沈砚对坐。",
                    condensed_text="苏晚棠与沈砚对坐。",
                )
            )
            await db.flush()

            shots = {
                SHOT_MIGRATED: "端茶",
                SHOT_SNAPSHOT: "对坐",
                SHOT_OPT_OUT: "空镜",
                SHOT_TWO_CHARS: "争执",
                SHOT_PLAIN: "过场",
            }
            for index, (shot_id, title) in enumerate(shots.items(), start=1):
                db.add(
                    Shot(
                        id=shot_id,
                        chapter_id=CHAPTER_ID,
                        index=index,
                        title=title,
                        script_excerpt=f"{title}。",
                    )
                )
            # 镜头级只写「迁移前的逐镜声音快照」与「本镜无需声音」
            db.add(
                ShotDetail(
                    id=SHOT_MIGRATED,
                    camera_shot="MS",
                    angle="EYE_LEVEL",
                    movement="STATIC",
                    audio_file_id=AUDIO_MIGRATED,
                    voice_inherited_from=f"character:{CHAR_MIGRATED}",
                )
            )
            db.add(
                ShotDetail(
                    id=SHOT_SNAPSHOT,
                    camera_shot="MS",
                    angle="EYE_LEVEL",
                    movement="STATIC",
                    audio_file_id=AUDIO_OLD_SNAPSHOT,
                    voice_inherited_from=f"character:{CHAR_SNAPSHOT}",
                )
            )
            db.add(
                ShotDetail(
                    id=SHOT_OPT_OUT,
                    camera_shot="LS",
                    angle="EYE_LEVEL",
                    movement="STATIC",
                    audio_opt_out=True,
                )
            )
            db.add(ShotDetail(id=SHOT_TWO_CHARS, camera_shot="MCU", angle="EYE_LEVEL", movement="STATIC"))
            db.add(
                ShotDetail(
                    id=SHOT_PLAIN,
                    camera_shot="MS",
                    angle="EYE_LEVEL",
                    movement="STATIC",
                    audio_file_id=AUDIO_PLAIN_SNAPSHOT,
                )
            )

            characters = {
                CHAR_MIGRATED: "苏晚棠",
                CHAR_SNAPSHOT: "沈砚",
                CHAR_OPT_OUT: "空镜人物",
                CHAR_TWO_A: "争执甲",
                CHAR_TWO_B: "争执乙",
                CHAR_PLAIN: "过场人物",
            }
            for char_id, name in characters.items():
                db.add(
                    Character(
                        id=char_id,
                        project_id=PROJECT_ID,
                        name=name,
                        description="素白襦裙",
                        style="真人古装",
                        visual_style="现实",
                    )
                )

            audios = {
                AUDIO_MIGRATED: ("迁移提升配音.mp3", URL_MIGRATED),
                AUDIO_MIGRATED_NEW: ("新音色.mp3", URL_MIGRATED_NEW),
                AUDIO_SNAPSHOT_ROLE: ("沈砚配音.mp3", URL_SNAPSHOT_ROLE),
                AUDIO_OLD_SNAPSHOT: ("旧逐镜配音.mp3", URL_OLD_SNAPSHOT),
                AUDIO_OPT_OUT_ROLE: ("空镜人物配音.mp3", URL_OPT_OUT_ROLE),
                AUDIO_TWO_A: ("争执甲配音.mp3", URL_TWO_A),
                AUDIO_TWO_B: ("争执乙配音.mp3", URL_TWO_B),
                AUDIO_PLAIN_SNAPSHOT: ("过场旧配音.mp3", URL_PLAIN_SNAPSHOT),
            }
            for file_id, (name, url) in audios.items():
                db.add(FileItem(id=file_id, type=FileType.audio, name=name, storage_key=url))

            links = (
                (SHOT_MIGRATED, CHAR_MIGRATED),
                (SHOT_SNAPSHOT, CHAR_SNAPSHOT),
                (SHOT_OPT_OUT, CHAR_OPT_OUT),
                (SHOT_TWO_CHARS, CHAR_TWO_A),
                (SHOT_TWO_CHARS, CHAR_TWO_B),
                (SHOT_PLAIN, CHAR_PLAIN),
            )
            for index, (shot_id, char_id) in enumerate(links, start=1):
                db.add(ShotCharacterLink(shot_id=shot_id, character_id=char_id, index=index))
            await db.flush()

            # 第 2 步（唯一入口）绑出来的角色声音
            for char_id, file_id in (
                (CHAR_MIGRATED, AUDIO_MIGRATED),
                (CHAR_SNAPSHOT, AUDIO_SNAPSHOT_ROLE),
                (CHAR_OPT_OUT, AUDIO_OPT_OUT_ROLE),
                (CHAR_TWO_A, AUDIO_TWO_A),
                (CHAR_TWO_B, AUDIO_TWO_B),
                # CHAR_PLAIN 刻意**没有**音色：用来验证"兼容快照兜底"
            ):
                await bind_asset_voice(db, asset_type="character", asset_id=char_id, file_id=file_id)
            await db.commit()

    asyncio.run(run())


@pytest.fixture
def sot_client() -> Any:
    factory, engine = _build_harness()
    _seed(factory)
    app.dependency_overrides[get_db] = _override(factory)
    try:
        yield TestClient(app), factory
    finally:
        app.dependency_overrides.pop(get_db, None)
        asyncio.run(engine.dispose())


def _admission(factory: async_sessionmaker[AsyncSession], shot_id: str) -> Any:
    """在**新会话**里跑一次生成侧的解析（模拟"下次生成"）。"""

    async def run() -> Any:
        async with factory() as db:
            return await resolve_audio_admission(
                db, shot_id=shot_id, provider=PROVIDER, model=None
            )

    return asyncio.run(run())


def _rebind_character_voice(
    factory: async_sessionmaker[AsyncSession], *, character_id: str, file_id: str
) -> None:
    """在第 2 步「人物资产详情」里把角色的音色换掉（走唯一写入口）。"""
    from app.services.studio.asset_voices import bind_asset_voice

    async def run() -> None:
        async with factory() as db:
            await bind_asset_voice(db, asset_type="character", asset_id=character_id, file_id=file_id)
            await db.commit()

    asyncio.run(run())


def _shot_snapshot(factory: async_sessionmaker[AsyncSession], shot_id: str) -> tuple[str | None, bool]:
    """读回镜头级的兼容快照与「无需声音」标记（证明它们没被偷偷改写）。"""

    async def run() -> tuple[str | None, bool]:
        async with factory() as db:
            row = await db.get(ShotDetail, shot_id)
            assert row is not None
            return row.audio_file_id, bool(row.audio_opt_out)

    return asyncio.run(run())


# ---------------------------------------------------------------------------
# 口径 3：改人物资产的音色 → 关联镜头下次生成自动用新音色
# ---------------------------------------------------------------------------


def test_changing_character_voice_after_migration_is_picked_up_by_the_shot(
    sot_client: Any,
) -> None:
    """迁移把历史逐镜声音提升成角色声音后，用户在第 2 步换音色 → 生成立刻用新音色。

    不需要（也不允许）逐镜批量更新：镜头自己那条历史快照**一个字节都不动**，
    生成侧读的是人物资产的当前音色。
    """
    _client, factory = sot_client

    before = _admission(factory, SHOT_MIGRATED)
    assert before.file_id == AUDIO_MIGRATED
    assert before.url == URL_MIGRATED
    assert before.source == VOICE_SOURCE_CHARACTER_ASSET

    _rebind_character_voice(factory, character_id=CHAR_MIGRATED, file_id=AUDIO_MIGRATED_NEW)

    after = _admission(factory, SHOT_MIGRATED)
    assert after.file_id == AUDIO_MIGRATED_NEW, "改人物资产的音色后必须自动生效"
    assert after.url == URL_MIGRATED_NEW, "进请求的地址也要是新音色的"
    assert after.source == VOICE_SOURCE_CHARACTER_ASSET
    # 镜头级旧快照没被"顺手更新"，也没参与投票
    assert _shot_snapshot(factory, SHOT_MIGRATED) == (AUDIO_MIGRATED, False)


# ---------------------------------------------------------------------------
# 口径 6：兼容快照永远不覆盖人物资产当前的音色
# ---------------------------------------------------------------------------


def test_character_voice_outranks_the_legacy_shot_snapshot(sot_client: Any) -> None:
    """人物资产有音色 + 本镜还留着**另一条**旧快照 → 人物资产的音色赢。"""
    _client, factory = sot_client

    admission = _admission(factory, SHOT_SNAPSHOT)

    assert _shot_snapshot(factory, SHOT_SNAPSHOT)[0] == AUDIO_OLD_SNAPSHOT, "前置：本镜确有旧快照"
    assert admission.file_id == AUDIO_SNAPSHOT_ROLE, "快照不许压过人物资产的音色"
    assert admission.url == URL_SNAPSHOT_ROLE
    assert admission.source == VOICE_SOURCE_CHARACTER_ASSET
    assert not any("兼容口" in item for item in admission.extra_warnings)


def test_legacy_snapshot_only_fills_in_when_the_character_has_no_voice(sot_client: Any) -> None:
    """人物资产没有音色时，才允许用兼容快照兜底 —— 而且必须**显式标注**。"""
    _client, factory = sot_client

    admission = _admission(factory, SHOT_PLAIN)

    assert admission.file_id == AUDIO_PLAIN_SNAPSHOT
    assert admission.source == VOICE_SOURCE_LEGACY_SNAPSHOT
    assert any("兼容口" in item for item in admission.extra_warnings)
    # 文案要把用户引到第 2 步（唯一入口），不许指向任何"逐镜绑定声音"的入口
    assert any("第 2 步" in item and "人物资产" in item for item in admission.extra_warnings)
    assert not any("声音绑定」里" in item for item in admission.extra_warnings)


# ---------------------------------------------------------------------------
# 口径 5：audio_opt_out 覆盖角色声音继承
# ---------------------------------------------------------------------------


def test_audio_opt_out_overrides_the_character_voice(sot_client: Any) -> None:
    """本镜明确无需声音 → 人物资产的音色**不被继承**（本镜的生效结论就是没有声音）。"""
    _client, factory = sot_client

    admission = _admission(factory, SHOT_OPT_OUT)

    assert admission.state == "opt_out"
    assert admission.file_id == ""
    assert admission.included is False
    assert admission.opt_out is True
    assert admission.source == VOICE_SOURCE_NONE
    assert "无需声音" in admission.excluded_reason


# ---------------------------------------------------------------------------
# 口径 7：普通镜头更新接口不能再建立逐镜角色声音
# ---------------------------------------------------------------------------


def test_ordinary_shot_update_api_cannot_create_a_voice_binding(sot_client: Any) -> None:
    """``PATCH /studio/shot-details/{id}`` 传 ``audio_file_id`` 也写不进去（字段已不在契约里）。"""
    from app.schemas.studio.shots import ShotDetailCreate, ShotDetailUpdate

    client, factory = sot_client
    assert "audio_file_id" not in ShotDetailUpdate.model_fields, "更新契约里不许有逐镜声音字段"
    assert "audio_file_id" not in ShotDetailCreate.model_fields, "创建契约里也不许有（否则又是第二个写入口）"
    assert "audio_opt_out" in ShotDetailUpdate.model_fields, "镜头级唯一的合法声明必须保留"

    before = _shot_snapshot(factory, SHOT_PLAIN)
    response = client.patch(
        f"{SHOT_DETAILS}/{SHOT_PLAIN}",
        json={"audio_file_id": AUDIO_MIGRATED_NEW, "duration": 6},
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"]["audio_file_id"] == before[0], "响应里如实回的是历史快照，不是新塞的值"
    assert _shot_snapshot(factory, SHOT_PLAIN) == before, "库里也不许被改写"

    # 造一条"原来没有声音"的镜头，同样塞不进去（这才是"新建绑定"的真实验径）
    response = client.patch(f"{SHOT_DETAILS}/{SHOT_TWO_CHARS}", json={"audio_file_id": AUDIO_MIGRATED})
    assert response.status_code == 200
    assert _shot_snapshot(factory, SHOT_TWO_CHARS)[0] is None
    assert _admission(factory, SHOT_TWO_CHARS).file_id == "", "两个人物各有音色时仍然不挑"


def test_opt_out_is_the_only_shot_level_voice_declaration(sot_client: Any) -> None:
    """置 ``audio_opt_out=true`` → **只更新开关、保留历史快照**；并且**不再**被任何音频绑定翻回 false。

    开关只影响生效优先级（``resolve_audio_admission``：opt_out → 人物资产音色 → 历史快照 → 无），
    不删除用户既有数据 —— 那一列是迁移 009 之前的兼容快照，关掉开关后还要靠它重新解析
    （见 ``tests/test_audio_opt_out.py`` 的三条用例）。
    """
    client, factory = sot_client

    before = _shot_snapshot(factory, SHOT_SNAPSHOT)
    assert before[0] == AUDIO_OLD_SNAPSHOT, "本用例前提：这一镜确实有一条历史快照"

    response = client.patch(f"{SHOT_DETAILS}/{SHOT_SNAPSHOT}", json={"audio_opt_out": True})
    assert response.status_code == 200, response.text
    assert _shot_snapshot(factory, SHOT_SNAPSHOT) == (AUDIO_OLD_SNAPSHOT, True), (
        "开启无需声音只改开关，不许清空历史快照"
    )
    assert _admission(factory, SHOT_SNAPSHOT).state == "opt_out"

    # 旧客户端硬塞 audio_file_id：既写不进去，也不许把 opt_out 翻成 false
    response = client.patch(f"{SHOT_DETAILS}/{SHOT_SNAPSHOT}", json={"audio_file_id": AUDIO_OLD_SNAPSHOT})
    assert response.status_code == 200
    assert _shot_snapshot(factory, SHOT_SNAPSHOT) == (AUDIO_OLD_SNAPSHOT, True), "音频绑定不许翻掉无需声音"
    assert _admission(factory, SHOT_SNAPSHOT).state == "opt_out"

    # 关回去：人物有音色 → 仍按优先级用人物当前音色（历史快照不参与）
    response = client.patch(f"{SHOT_DETAILS}/{SHOT_SNAPSHOT}", json={"audio_opt_out": False})
    assert response.status_code == 200
    assert _shot_snapshot(factory, SHOT_SNAPSHOT) == (AUDIO_OLD_SNAPSHOT, False), "快照仍在库里"
    reopened = _admission(factory, SHOT_SNAPSHOT)
    assert reopened.state != "opt_out"
    assert reopened.source == VOICE_SOURCE_CHARACTER_ASSET, "人物资产声音优先于历史快照"
    assert reopened.file_id == AUDIO_SNAPSHOT_ROLE

    # 人物**没有**音色的镜头：关回去后重新用上历史兼容快照（同一套规则的另一半）
    response = client.patch(f"{SHOT_DETAILS}/{SHOT_PLAIN}", json={"audio_opt_out": True})
    assert response.status_code == 200
    assert _shot_snapshot(factory, SHOT_PLAIN) == (AUDIO_PLAIN_SNAPSHOT, True), "开关不许清空快照"
    assert _admission(factory, SHOT_PLAIN).state == "opt_out"
    response = client.patch(f"{SHOT_DETAILS}/{SHOT_PLAIN}", json={"audio_opt_out": False})
    assert response.status_code == 200
    fallback = _admission(factory, SHOT_PLAIN)
    assert fallback.source == VOICE_SOURCE_LEGACY_SNAPSHOT
    assert fallback.file_id == AUDIO_PLAIN_SNAPSHOT


# ---------------------------------------------------------------------------
# 口径 1/2：值从人物资产**现读**，不依赖任何瞬时状态（刷新 / 重进同一结论）
# ---------------------------------------------------------------------------


def test_refresh_and_re_entry_read_the_voice_from_the_asset(sot_client: Any) -> None:
    """刷新 / 重新进入页面读到的是**人物资产的当前值**，不是某次请求留下的状态。"""
    from app.services.studio.asset_voices import read_shot_voice_inheritance

    _client, factory = sot_client

    async def read_twice_in_one_session() -> tuple[Any, Any]:
        """同一会话里读两次（第二次前把身份映射全部过期，模拟"重新查库"）。"""
        async with factory() as db:
            first = await resolve_audio_admission(db, shot_id=SHOT_MIGRATED, provider=PROVIDER, model=None)
            db.expire_all()
            second = await resolve_audio_admission(db, shot_id=SHOT_MIGRATED, provider=PROVIDER, model=None)
            return first, second

    first, second = asyncio.run(read_twice_in_one_session())
    assert first.file_id == second.file_id == AUDIO_MIGRATED

    _rebind_character_voice(factory, character_id=CHAR_MIGRATED, file_id=AUDIO_MIGRATED_NEW)

    # 新会话（= 用户刷新页面）读到新音色；第 4 步的只读结论也同步到新音色
    async def read_after_refresh() -> tuple[Any, Any]:
        async with factory() as db:
            admission = await resolve_audio_admission(
                db, shot_id=SHOT_MIGRATED, provider=PROVIDER, model=None
            )
            inheritance = await read_shot_voice_inheritance(db, shot_id=SHOT_MIGRATED)
            return admission, inheritance

    admission, inheritance = asyncio.run(read_after_refresh())
    assert admission.file_id == AUDIO_MIGRATED_NEW
    assert inheritance.state == "inherited"
    assert inheritance.file_id == AUDIO_MIGRATED_NEW, "第 4 步与实际生成读的是同一份事实来源"
    assert inheritance.source_asset_id == CHAR_MIGRATED


# ---------------------------------------------------------------------------
# 口径 4：第 4 步仍然没有选择 / 更换 / 保存声音的入口
# ---------------------------------------------------------------------------


def _openapi_body_properties(path: str, method: str) -> set[str]:
    """取某接口的请求体字段名（顺着 ``$ref`` 展开到 ``components.schemas``）。"""
    schema = app.openapi()
    operation = schema["paths"][path][method]
    body_ref = operation["requestBody"]["content"]["application/json"]["schema"]
    resolved: dict[str, Any] = body_ref
    while "$ref" in resolved:
        name = resolved["$ref"].rsplit("/", 1)[-1]
        resolved = schema["components"]["schemas"][name]
    return set((resolved.get("properties") or {}).keys())


def test_step_four_has_no_voice_write_surface(sot_client: Any) -> None:
    """第 4 步只有**读**口：镜头侧没有 PUT / PATCH / POST / DELETE 声音的路由。"""
    client, _factory = sot_client

    shot_voice_routes: list[tuple[str, str]] = []
    for route in app.routes:
        path = str(getattr(route, "path", ""))
        if "/asset-voices/shots/" not in path:
            continue
        for method in getattr(route, "methods", set()) or set():
            shot_voice_routes.append((method, path))
    assert sorted({method for method, _ in shot_voice_routes}) == ["GET"], (
        f"第 4 步出现了写入口：{shot_voice_routes}"
    )

    # 路由级：写方法直接被拒（405），且响应契约里没有可写的"保存/更换"字段
    assert client.put(INHERITANCE.format(shot_id=SHOT_MIGRATED), json={"file_id": AUDIO_TWO_A}).status_code == 405
    assert client.patch(INHERITANCE.format(shot_id=SHOT_MIGRATED), json={"file_id": AUDIO_TWO_A}).status_code == 405
    assert client.post(INHERITANCE.format(shot_id=SHOT_MIGRATED), json={"file_id": AUDIO_TWO_A}).status_code == 405
    assert client.delete(INHERITANCE.format(shot_id=SHOT_MIGRATED)).status_code == 405

    # 契约级：第 4 步的读契约里没有"目标声音"这类可提交字段；镜头 PATCH 也写不了声音
    read_props = set(app.openapi()["components"]["schemas"]["ShotVoiceInheritanceRead"]["properties"])
    assert not (read_props & {"target_file_id", "voice_file_id", "audio_file_id"}), (
        f"第 4 步的读契约里出现了可写的声音字段：{sorted(read_props)}"
    )
    assert "audio_file_id" not in _openapi_body_properties(
        "/api/v1/studio/shot-details/{shot_id}", "patch"
    ), "PATCH 契约里出现了逐镜声音字段 = 第二套编辑源"
    assert "audio_opt_out" in _openapi_body_properties(
        "/api/v1/studio/shot-details/{shot_id}", "patch"
    ), "镜头级唯一的合法声明必须保留"

    # 唯一写入口仍然是资产级（第 2 步）
    assert "/api/v1/studio/asset-voices/{asset_type}/{asset_id}" in app.openapi()["paths"]
    assert client.put(
        f"/api/v1/studio/asset-voices/character/{CHAR_MIGRATED}", json={"file_id": AUDIO_TWO_A}
    ).status_code == 200


def test_step_four_read_is_still_pure_read(sot_client: Any) -> None:
    """第 4 步的读口没有写库副作用（``file_usages`` / 镜头级字段逐行不变）。"""
    from app.models.studio import ShotCharacterLink
    from app.models.studio_file_usages import FileUsage

    client, factory = sot_client

    async def snapshot() -> list[tuple]:
        async with factory() as db:
            usages = [
                tuple(row)
                for row in (
                    await db.execute(
                        select(
                            FileUsage.source_ref,
                            FileUsage.file_id,
                            FileUsage.usage_kind,
                        ).order_by(FileUsage.source_ref, FileUsage.file_id)
                    )
                ).all()
            ]
            links = [
                tuple(row)
                for row in (
                    await db.execute(
                        select(ShotCharacterLink.shot_id, ShotCharacterLink.character_id).order_by(
                            ShotCharacterLink.shot_id, ShotCharacterLink.character_id
                        )
                    )
                ).all()
            ]
        return usages + links

    before = asyncio.run(snapshot())
    for shot_id in (SHOT_MIGRATED, SHOT_SNAPSHOT, SHOT_OPT_OUT, SHOT_TWO_CHARS, SHOT_PLAIN):
        assert client.get(INHERITANCE.format(shot_id=shot_id)).status_code == 200
    assert asyncio.run(snapshot()) == before
