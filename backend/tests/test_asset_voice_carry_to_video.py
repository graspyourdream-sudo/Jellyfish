"""角色声音进视频生成：**唯一事实来源是人物资产**（需求清单第 6 条）。

用户口径
========

声音属于**人物资产**，不属于单个镜头；第 2 步「人物资产详情」是全站唯一的绑定入口。
所以生成侧解析「这一镜该用哪条声音」的顺序是：

1. ``shot_details.audio_opt_out`` = true → 本镜明确无需声音（覆盖一切继承）；
2. **人物资产当前绑定的角色声音** → 只要人物资产有音色就**必须**用它；
3. ``shot_details.audio_file_id`` → 迁移 009 之前的逐镜声音，**只作兼容快照兜底**，
   **永不覆盖**人物资产的音色；
4. 都没有 → 未绑定。

「镜头自己的选择优先」是**已被推翻的旧口径**：改成资产级之后，镜头级不再是表达声音的地方，
旧结论（镜头绑定压住人物资产音色）会让用户在第 2 步换完音色却仍然听到旧声音。

角色声音**只认人物资产**：场景 / 道具 / 服装上的历史 ``asset_voice`` 行不参与，
也不会制造"多个候选"的歧义。

评审附带条件②：**兜底规则不许猜**。所以这里的多候选结论刻意有三态：

============  =======================================  ==================
状态          条件                                     行为
============  =======================================  ==================
``none``      绑定的**人物资产**里没有一个带声音        不带、不产生噪音
``single``    **恰好一个**人物资产带声音                带出它的声音，并说明来源
``ambiguous`` **多个**人物资产各自带声音                **不替用户选**，留空 + 明示候选
============  =======================================  ==================

「多人物镜头随便挑一个声音，比没有声音更糟糕」—— 这是这条规则的由来。

全部零出网、零付费：本文件只跑内存库与服务层，不调任何供应商。
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from app.services.studio.video_audio_input import (
    resolve_asset_voice_for_shot,
    resolve_audio_admission,
)
from tests.llm_orchestration_fixtures import build_session

PROJECT_ID = "proj-carry"
CHAPTER_ID = "chap-carry"
SHOT_ID = "shot-carry"
SHOT_NO_VOICE = "shot-carry-2"

PUBLIC_AUDIO = "https://cdn.example.test/voice-a.mp3"
PUBLIC_AUDIO_2 = "https://cdn.example.test/voice-b.mp3"
AUDIO_A = "file-voice-a"
AUDIO_B = "file-voice-b"
AUDIO_SHOT = "file-voice-shot"

PROVIDER = "apimart"


async def _seed(db: Any, *, characters: list[tuple[str, str, str | None]] | None = None) -> None:
    """项目 + 章节 + 两个镜头 + 角色（可选各自绑资产声音）。

    ``characters`` 是 ``[(character_id, name, voice_storage_key|None)]``。
    """
    from app.models.studio import (
        Chapter,
        Character,
        FileItem,
        Project,
        Shot,
        ShotCharacterLink,
        ShotDetail,
    )
    from app.models.types import FileType

    db.add(Project(id=PROJECT_ID, name="带声音测试", description="", style="真人古装", visual_style="现实"))
    db.add(
        Chapter(
            id=CHAPTER_ID,
            project_id=PROJECT_ID,
            index=1,
            title="第一集",
            raw_text="两个丫鬟端茶进来。",
            condensed_text="两个丫鬟端茶进来。",
        )
    )
    await db.flush()
    db.add(Shot(id=SHOT_ID, chapter_id=CHAPTER_ID, index=1, title="端茶", script_excerpt="丫鬟甲端茶进来。"))
    db.add(Shot(id=SHOT_NO_VOICE, chapter_id=CHAPTER_ID, index=2, title="空镜", script_excerpt="庭院空无一人。"))
    # ShotDetail 行存在但两个字段都空 = "镜头没有表态"（这正是要兜底的情形）
    db.add(
        ShotDetail(
            id=SHOT_ID,
            camera_shot="中景",
            angle="平视",
            movement="固定",
            description="",
        )
    )
    await db.flush()

    for index, (character_id, name, voice_key) in enumerate(characters or [], start=1):
        db.add(
            Character(
                id=character_id,
                project_id=PROJECT_ID,
                name=name,
                description="丫鬟装束",
                style="真人古装",
                visual_style="现实",
            )
        )
        await db.flush()
        db.add(ShotCharacterLink(shot_id=SHOT_ID, character_id=character_id, index=index))
        if voice_key:
            file_id = AUDIO_A if index == 1 else AUDIO_B
            db.add(
                FileItem(
                    id=file_id,
                    type=FileType.audio,
                    name=f"{name}的配音.mp3",
                    storage_key=voice_key,
                )
            )
            await db.flush()
            from app.services.studio.asset_voices import bind_asset_voice

            await bind_asset_voice(db, asset_type="character", asset_id=character_id, file_id=file_id)
    await db.flush()


async def _carry(db: Any) -> Any:
    return await resolve_asset_voice_for_shot(db, shot_id=SHOT_ID)


async def _bind_scene_voice(db: Any) -> None:
    """给**本镜绑定的场景**绑一条历史资产声音（配乐/环境音那类数据的化身）。

    这类行是兼容数据：接口仍可读写（不删数据），但角色声音的解析路径必须完全无视它。
    """
    from app.models.studio import FileItem, ProjectSceneLink, Scene
    from app.models.types import FileType
    from app.services.studio.asset_voices import bind_asset_voice

    db.add(Scene(id="scene-x", name="侯府大堂", description="", style="真人古装", view_count=1, tags=[]))
    db.add(
        ProjectSceneLink(
            project_id=PROJECT_ID, chapter_id=CHAPTER_ID, shot_id=SHOT_ID, scene_id="scene-x"
        )
    )
    db.add(
        FileItem(
            id="file-scene-voice",
            type=FileType.audio,
            name="大堂环境音.mp3",
            storage_key="https://cdn.example.test/scene-ambience.mp3",
        )
    )
    await db.flush()
    await bind_asset_voice(db, asset_type="scene", asset_id="scene-x", file_id="file-scene-voice")


@pytest.mark.asyncio
async def test_single_voiced_asset_is_carried() -> None:
    """恰好一个人物资产有音色 → 带出它的声音，并说明"这是从人物资产继承的"。"""
    db, engine = await build_session()
    try:
        await _seed(db, characters=[("char-a", "丫鬟甲", PUBLIC_AUDIO)])
        carry = await _carry(db)
    finally:
        await engine.dispose()

    assert carry.state == "single"
    assert carry.file_id == AUDIO_A
    assert carry.url == PUBLIC_AUDIO
    assert "丫鬟甲" in carry.asset_label
    assert "人物资产" in carry.note
    assert carry.candidates == ()


@pytest.mark.asyncio
async def test_two_voiced_assets_are_not_guessed() -> None:
    """**附带条件②**：两个人物资产各有音色 → 一个都不选，留空并把候选说清。"""
    db, engine = await build_session()
    try:
        await _seed(db, characters=[("char-a", "丫鬟甲", PUBLIC_AUDIO), ("char-b", "丫鬟乙", PUBLIC_AUDIO_2)])
        carry = await _carry(db)
    finally:
        await engine.dispose()

    assert carry.state == "ambiguous"
    assert carry.file_id == "", "多个候选时必须留空，不许替用户挑一个"
    assert carry.url == ""
    assert len(carry.candidates) == 2
    assert "丫鬟甲" in carry.note and "丫鬟乙" in carry.note
    assert "不替你" in carry.note
    assert carry.note, "多个候选时必须明示，否则用户不知道声音为什么没带"
    # 文案不许把用户指回"逐镜绑定声音"那个已经删掉的入口
    assert "本镜单独" not in carry.note and "声音绑定" not in carry.note


@pytest.mark.asyncio
async def test_non_character_asset_voice_never_participates() -> None:
    """场景上的历史 ``asset_voice`` 行**不参与**角色声音，也不制造"多个候选"。"""
    db, engine = await build_session()
    try:
        await _seed(db, characters=[("char-a", "丫鬟甲", PUBLIC_AUDIO)])
        await _bind_scene_voice(db)
        carry = await _carry(db)
    finally:
        await engine.dispose()

    assert carry.state == "single", "场景环境音不许把人物音色挤成'多个候选'"
    assert carry.file_id == AUDIO_A
    assert carry.candidates == ()


@pytest.mark.asyncio
async def test_assets_without_voice_produce_no_noise() -> None:
    """绑了资产但都没声音 → 什么都不带，也不产生噪音（与既有"未绑定"行为一致）。"""
    db, engine = await build_session()
    try:
        await _seed(db, characters=[("char-a", "丫鬟甲", None), ("char-b", "丫鬟乙", None)])
        carry = await _carry(db)
    finally:
        await engine.dispose()

    assert carry.state == "none"
    assert carry.file_id == ""
    assert carry.note == "", "没有候选时不许制造噪音"


@pytest.mark.asyncio
async def test_no_bound_assets_at_all() -> None:
    db, engine = await build_session()
    try:
        await _seed(db, characters=[])
        carry = await _carry(db)
    finally:
        await engine.dispose()
    assert carry.state == "none"
    assert carry.note == ""


# ---------------------------------------------------------------------------
# 端到端（准入结论）：三态怎么落到 audio_urls / 提示上
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_admission_carries_the_single_asset_voice_into_the_request() -> None:
    """唯一候选时，人物资产的音色真的进了准入结论（可携带），来源标注为人物资产。"""
    from app.services.studio.video_audio_input import VOICE_SOURCE_CHARACTER_ASSET

    db, engine = await build_session()
    try:
        await _seed(db, characters=[("char-a", "丫鬟甲", PUBLIC_AUDIO)])
        admission = await resolve_audio_admission(db, shot_id=SHOT_ID, provider=PROVIDER, model=None)
    finally:
        await engine.dispose()

    assert admission.file_id == AUDIO_A
    assert admission.included is True, "公网地址必须可携带"
    assert admission.url == PUBLIC_AUDIO
    assert admission.source == VOICE_SOURCE_CHARACTER_ASSET
    assert any("人物资产" in item for item in admission.extra_warnings)


@pytest.mark.asyncio
async def test_admission_leaves_audio_empty_and_explains_when_ambiguous() -> None:
    """多个候选：请求里**没有**音频，但计划/页面拿得到"为什么"（不静默）。"""
    db, engine = await build_session()
    try:
        await _seed(db, characters=[("char-a", "丫鬟甲", PUBLIC_AUDIO), ("char-b", "丫鬟乙", PUBLIC_AUDIO_2)])
        admission = await resolve_audio_admission(db, shot_id=SHOT_ID, provider=PROVIDER, model=None)
    finally:
        await engine.dispose()

    assert admission.file_id == ""
    assert admission.included is False
    notes = " ".join(admission.extra_warnings)
    assert "丫鬟甲" in notes and "丫鬟乙" in notes, "候选必须出现在说明里"
    assert "不替你" in notes


@pytest.mark.asyncio
async def test_character_asset_voice_wins_over_legacy_shot_snapshot() -> None:
    """**优先级**：人物资产有音色 → 人物资产赢，历史逐镜快照一律不参与。

    （旧口径"镜头自己的选择永远优先"已被推翻：镜头级不再是表达声音的地方。）
    """
    from app.models.studio import ShotDetail

    db, engine = await build_session()
    try:
        await _seed(db, characters=[("char-a", "丫鬟甲", PUBLIC_AUDIO)])
        detail = await db.get(ShotDetail, SHOT_ID)
        detail.audio_file_id = AUDIO_SHOT
        await db.flush()
        from app.models.studio import FileItem
        from app.models.types import FileType

        db.add(FileItem(id=AUDIO_SHOT, type=FileType.audio, name="本镜专用.mp3", storage_key="https://cdn.example.test/shot.mp3"))
        await db.flush()

        admission = await resolve_audio_admission(db, shot_id=SHOT_ID, provider=PROVIDER, model=None)
        # 人物资产的音色生效；快照那条路径的"兼容快照"标注**不应出现**
        assert admission.file_id == AUDIO_A
        assert admission.url == PUBLIC_AUDIO
        assert not any("兼容口" in item for item in admission.extra_warnings)
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_legacy_snapshot_is_used_only_as_labelled_compatibility_fallback() -> None:
    """人物资产没有音色时，才退回历史快照，并且**明确标注**它只是兼容快照。"""
    from app.models.studio import FileItem, ShotDetail
    from app.models.types import FileType
    from app.services.studio.video_audio_input import VOICE_SOURCE_LEGACY_SNAPSHOT

    db, engine = await build_session()
    try:
        await _seed(db, characters=[("char-a", "丫鬟甲", None)])
        db.add(
            FileItem(
                id=AUDIO_SHOT,
                type=FileType.audio,
                name="迁移前逐镜配音.mp3",
                storage_key="https://cdn.example.test/shot.mp3",
            )
        )
        detail = await db.get(ShotDetail, SHOT_ID)
        detail.audio_file_id = AUDIO_SHOT
        await db.flush()

        admission = await resolve_audio_admission(db, shot_id=SHOT_ID, provider=PROVIDER, model=None)
    finally:
        await engine.dispose()

    assert admission.file_id == AUDIO_SHOT
    assert admission.source == VOICE_SOURCE_LEGACY_SNAPSHOT
    assert any("兼容口" in item for item in admission.extra_warnings), "快照必须被显式标注，不许静默使用"
    assert any("第 2 步" in item for item in admission.extra_warnings), "要告诉用户以后到哪儿绑音色"


@pytest.mark.asyncio
async def test_ambiguous_character_voices_do_not_fall_back_to_the_snapshot() -> None:
    """多个人物各有音色 + 本镜还留着旧快照：既**不挑**，也**不退回快照**。"""
    from app.models.studio import FileItem, ShotDetail
    from app.models.types import FileType

    db, engine = await build_session()
    try:
        await _seed(
            db,
            characters=[("char-a", "丫鬟甲", PUBLIC_AUDIO), ("char-b", "丫鬟乙", PUBLIC_AUDIO_2)],
        )
        db.add(
            FileItem(
                id=AUDIO_SHOT,
                type=FileType.audio,
                name="迁移前逐镜配音.mp3",
                storage_key="https://cdn.example.test/shot.mp3",
            )
        )
        detail = await db.get(ShotDetail, SHOT_ID)
        detail.audio_file_id = AUDIO_SHOT
        await db.flush()

        admission = await resolve_audio_admission(db, shot_id=SHOT_ID, provider=PROVIDER, model=None)
    finally:
        await engine.dispose()

    assert admission.file_id == "", "不许用一条历史逐镜声音冒充多人物镜头的角色声音"
    assert admission.included is False
    assert "不替你" in " ".join(admission.extra_warnings)


@pytest.mark.asyncio
async def test_shot_opt_out_beats_asset_voice() -> None:
    """``audio_opt_out=true`` → 人物资产的音色**不许**被继承（本镜明确无需声音）。"""
    from app.models.studio import ShotDetail

    db, engine = await build_session()
    try:
        await _seed(db, characters=[("char-a", "丫鬟甲", PUBLIC_AUDIO)])
        detail = await db.get(ShotDetail, SHOT_ID)
        detail.audio_opt_out = True
        await db.flush()
        admission = await resolve_audio_admission(db, shot_id=SHOT_ID, provider=PROVIDER, model=None)
    finally:
        await engine.dispose()

    assert admission.file_id == "", "明确无需声音时不能被人物资产的音色顶回来"
    assert admission.included is False
    assert admission.state == "opt_out"
    assert not any("人物资产" in item for item in admission.extra_warnings)


@pytest.mark.asyncio
async def test_carry_is_stable_across_repeated_reads() -> None:
    """同一份数据重复解析结论必须一致（顺序稳定，不靠字典遍历顺序）。"""
    db, engine = await build_session()
    try:
        await _seed(db, characters=[("char-a", "丫鬟甲", PUBLIC_AUDIO), ("char-b", "丫鬟乙", PUBLIC_AUDIO_2)])
        first = await _carry(db)
        second = await _carry(db)
    finally:
        await engine.dispose()
    assert first == second
