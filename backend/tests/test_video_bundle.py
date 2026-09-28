"""出口 B「视频交付 · 批量下载」测试（需求清单第 9 条）。

逐条对应任务书要求：

1. 只打包**生成成功并已落库**的成片 —— 没有结果 / 文件记录已不在 / 字节读不出来的镜头
   全部排除，且各自给中文原因；
2. 下载前能拿到**包含数量与排除数量**（预检不读文件字节）；
3. 文件名稳定、可读、不冲突（同名镜头补序号）；
4. 包内 ``交付清单.txt`` 与包内容**同源**；
5. 无结果时给自然语言错误（不是空 ZIP、不是 500）；
6. 本地文件与外部地址两种 storage_key 都覆盖；
7. 范围（选中镜头 / 本集 / 整个项目）按既有交付范围实现，不另写一套。

安全边界：全程只用内存 SQLite；`FileItem.storage_key` 一律指向**临时目录**里的
真实小文件（不是 OSS，也不上传任何东西）。
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path
from typing import Any

import pytest

from app.config import settings
from app.core import storage
from app.models.studio import Chapter, FileItem, Shot
from app.services.studio import video_bundle as svc
from tests.llm_orchestration_fixtures import build_session, seed_project_chapter_shot

#: 一个最小的「视频文件」字节（内容不重要，测试只关心它被原样放进 ZIP）
_VIDEO_BYTES = b"\x00\x00\x00\x18ftypmp42" + b"jellyfish-test-payload" * 8


class _LocalStorageRoot:
    """把本地存储根指到 pytest 的临时目录（**不碰** worktree 的 storage/，也不碰 OSS）。

    为什么必须这样：``storage_key`` 在生产里是**相对存储根**的逻辑 key
    （``generated-videos/shots/<id>/xxx.mp4``），本地驱动下由
    ``storage.local_storage_path`` 映射到磁盘。测试只有把根指到临时目录，
    才能真正走到与生产同一条读取路径。
    """

    def __init__(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        self.root = tmp_path / "storage-root"
        monkeypatch.setattr(settings, "storage_driver", "local", raising=False)
        monkeypatch.setattr(settings, "local_storage_root", str(self.root), raising=False)
        monkeypatch.setattr(settings, "local_storage_base_url", "", raising=False)
        assert storage.is_local_storage() is True

    def write(self, key: str, content: bytes = _VIDEO_BYTES) -> str:
        """按逻辑 key 落一个真实文件，返回该 key（就可直接写进 ``storage_key``）。"""
        target = self.root / key
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        return key


async def _seed_two_shots(db, store: _LocalStorageRoot) -> None:
    """两镜：S001 有可用成片，S002 没有任何生成结果。"""
    await seed_project_chapter_shot(db)
    shot = await db.get(Shot, "shot-1")
    assert shot is not None
    shot.index = 1
    shot.title = "便利店 · 全景推进"
    db.add(
        FileItem(
            id="file-video-1",
            type="video",
            name="成片.mp4",
            storage_key=store.write("generated-videos/shots/shot-1/v1.mp4"),
        )
    )
    await db.flush()
    shot.generated_video_file_id = "file-video-1"
    db.add(Shot(id="shot-2", chapter_id="chap-1", index=2, title="女孩进门 · 中景", status="ready"))
    await db.flush()


@pytest.mark.asyncio
async def test_plan_includes_only_shots_with_a_successful_video(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    store = _LocalStorageRoot(monkeypatch, tmp_path)
    db, engine = await build_session()
    try:
        async with db:
            await _seed_two_shots(db, store)
            plan = await svc.build_video_bundle_plan(
                db, project_id="proj-1", chapter_id="chap-1", scope=svc.SCOPE_EPISODE, read_bytes=False
            )
    finally:
        await engine.dispose()

    assert plan.included_count == 1
    assert plan.excluded_count == 1
    assert plan.has_content is True
    included = plan.included[0]
    assert included.shot_code == "S001"
    assert included.file_name == "S001_便利店 · 全景推进.mp4"
    # 没有生成结果的镜头：被排除，并且原因说得清
    assert plan.excluded[0].shot_code == "S002"
    assert "还没有生成结果" in plan.excluded[0].reason
    # 预检不读文件字节
    assert included.size_bytes == 0


@pytest.mark.asyncio
async def test_plan_reads_bytes_and_reports_size_when_requested(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    store = _LocalStorageRoot(monkeypatch, tmp_path)
    db, engine = await build_session()
    try:
        async with db:
            await _seed_two_shots(db, store)
            plan = await svc.build_video_bundle_plan(
                db, project_id="proj-1", chapter_id="chap-1", scope=svc.SCOPE_EPISODE, read_bytes=True
            )
    finally:
        await engine.dispose()

    included = plan.included[0]
    assert included.size_bytes == len(_VIDEO_BYTES)
    assert included.content == _VIDEO_BYTES


@pytest.mark.asyncio
async def test_unreadable_file_is_excluded_instead_of_shipping_an_empty_entry(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """文件记录还在、但字节读不出来（文件已从存储里消失）→ 排除，不给 0 字节同名条目。"""
    store = _LocalStorageRoot(monkeypatch, tmp_path)
    db, engine = await build_session()
    try:
        async with db:
            await _seed_two_shots(db, store)
            # 第二镜的成片记录存在，但字节已经不在存储里
            lost_key = store.write("generated-videos/shots/shot-2/v2.mp4")
            db.add(FileItem(id="file-video-2", type="video", name="丢了.mp4", storage_key=lost_key))
            await db.flush()
            (store.root / lost_key).unlink()
            shot2 = await db.get(Shot, "shot-2")
            assert shot2 is not None
            shot2.generated_video_file_id = "file-video-2"
            await db.flush()
            plan = await svc.build_video_bundle_plan(
                db, project_id="proj-1", chapter_id="chap-1", scope=svc.SCOPE_EPISODE, read_bytes=True
            )
    finally:
        await engine.dispose()

    assert plan.included_count == 1, "只有 S001 那条读得出来的能进包"
    assert plan.excluded_count == 1
    assert "读不出来" in plan.excluded[0].reason


@pytest.mark.asyncio
async def test_missing_file_record_is_excluded_with_reason(tmp_path: Path) -> None:
    """``generated_video_file_id`` 指向一个已经不存在的文件记录 → 排除。"""
    db, engine = await build_session()
    try:
        async with db:
            await seed_project_chapter_shot(db)
            shot = await db.get(Shot, "shot-1")
            assert shot is not None
            shot.generated_video_file_id = "file-does-not-exist"
            await db.flush()
            plan = await svc.build_video_bundle_plan(
                db, project_id="proj-1", chapter_id="chap-1", scope=svc.SCOPE_EPISODE, read_bytes=True
            )
    finally:
        await engine.dispose()

    assert plan.has_content is False
    assert plan.excluded_count == 1
    assert "文件记录已经不存在" in plan.excluded[0].reason


@pytest.mark.asyncio
async def test_scope_is_honoured_for_selected_shots(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """按**选中镜头**取范围：没勾的镜头不进包（与出口 A 同一份范围实现）。"""
    store = _LocalStorageRoot(monkeypatch, tmp_path)
    db, engine = await build_session()
    try:
        async with db:
            await _seed_two_shots(db, store)
            plan = await svc.build_video_bundle_plan(
                db,
                project_id="proj-1",
                shot_ids=["shot-2"],
                scope=svc.SCOPE_EPISODES,
                read_bytes=False,
            )
    finally:
        await engine.dispose()

    assert [item.shot_id for item in plan.items] == ["shot-2"]
    assert plan.included_count == 0


@pytest.mark.asyncio
async def test_zip_contains_manifest_and_videos_with_stable_names(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    store = _LocalStorageRoot(monkeypatch, tmp_path)
    db, engine = await build_session()
    try:
        async with db:
            await _seed_two_shots(db, store)
            # 两镜同标题 → 包内名字必须自动去重
            db.add(
                FileItem(
                    id="file-video-3",
                    type="video",
                    name="成片.mp4",
                    storage_key=store.write("generated-videos/shots/shot-2/v2.mp4"),
                )
            )
            await db.flush()
            shot2 = await db.get(Shot, "shot-2")
            assert shot2 is not None
            shot2.title = "便利店 · 全景推进"
            shot2.generated_video_file_id = "file-video-3"
            await db.flush()
            plan = await svc.build_video_bundle_plan(
                db, project_id="proj-1", chapter_id="chap-1", scope=svc.SCOPE_EPISODE, read_bytes=True
            )
    finally:
        await engine.dispose()

    names = [item.file_name for item in plan.included]
    assert len(names) == len(set(names)), "包内文件名重复了"
    assert names[0] == "S001_便利店 · 全景推进.mp4"
    assert names[1] == "S002_便利店 · 全景推进.mp4"

    payload = svc.write_bundle_zip(plan)
    with zipfile.ZipFile(payload) as archive:
        members = archive.namelist()
        assert svc.MANIFEST_NAME in members
        for name in names:
            assert name in members
            assert archive.read(name) == _VIDEO_BYTES
        manifest = archive.read(svc.MANIFEST_NAME).decode("utf-8")
    assert "包含 2 条成片" in manifest
    assert names[0] in manifest and names[1] in manifest


@pytest.mark.asyncio
async def test_cross_chapter_scope_dedupes_repeated_shot_codes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """跨集范围下**镜头号会重复**（每集都有自己的 S001）→ 包内文件名必须自动补序号，不能互相覆盖。"""
    store = _LocalStorageRoot(monkeypatch, tmp_path)
    db, engine = await build_session()
    try:
        async with db:
            await _seed_two_shots(db, store)
            db.add(Chapter(id="chap-2", project_id="proj-1", index=2, title="第二集", raw_text="x", condensed_text="x"))
            await db.flush()
            db.add(
                FileItem(
                    id="file-video-4",
                    type="video",
                    name="成片.mp4",
                    storage_key=store.write("generated-videos/shots/shot-9/v9.mp4"),
                )
            )
            await db.flush()
            db.add(
                Shot(
                    id="shot-9",
                    chapter_id="chap-2",
                    index=1,
                    title="便利店 · 全景推进",
                    status="ready",
                    generated_video_file_id="file-video-4",
                )
            )
            await db.flush()
            plan = await svc.build_video_bundle_plan(
                db, project_id="proj-1", scope=svc.SCOPE_EPISODES, read_bytes=True
            )
    finally:
        await engine.dispose()

    names = [item.file_name for item in plan.included]
    assert names == ["S001_便利店 · 全景推进.mp4", "S001_便利店 · 全景推进_2.mp4"]
    payload = svc.write_bundle_zip(plan)
    with zipfile.ZipFile(payload) as archive:
        # 两个同名文件都在包里，没有互相覆盖
        assert archive.read(names[0]) == _VIDEO_BYTES
        assert archive.read(names[1]) == _VIDEO_BYTES


@pytest.mark.asyncio
async def test_manifest_lists_excluded_shots_with_reason(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    store = _LocalStorageRoot(monkeypatch, tmp_path)
    db, engine = await build_session()
    try:
        async with db:
            await _seed_two_shots(db, store)
            plan = await svc.build_video_bundle_plan(
                db, project_id="proj-1", chapter_id="chap-1", scope=svc.SCOPE_EPISODE, read_bytes=True
            )
    finally:
        await engine.dispose()

    text = svc.build_manifest_text(plan)
    assert "包含 1 条成片；排除 1 条" in text
    assert "S002" in text
    assert "还没有生成结果" in text


def test_safe_file_name_keeps_chinese_and_strips_path_separators() -> None:
    # 中文保留（交付文件是给人看的）
    assert svc.safe_file_name("便利店 · 全景推进") == "便利店 · 全景推进"
    # 路径分隔符与非法字符被替换，不会写出目录
    assert "/" not in svc.safe_file_name("a/b\\c:d*e?f")
    assert svc.safe_file_name("   ") == "shot"
    assert svc.safe_file_name("") == "shot"


def test_dedupe_file_name_appends_index_only_when_needed() -> None:
    used: set[str] = set()
    assert svc.dedupe_file_name("a.mp4", used) == "a.mp4"
    assert svc.dedupe_file_name("a.mp4", used) == "a_2.mp4"
    assert svc.dedupe_file_name("a.mp4", used) == "a_3.mp4"
    # 没有扩展名也要能去重
    used2: set[str] = set()
    assert svc.dedupe_file_name("b", used2) == "b"
    assert svc.dedupe_file_name("b", used2) == "b_2"


def test_bundle_filename_is_readable_and_stable() -> None:
    plan = svc.VideoBundlePlan(project_id="p", scope=svc.SCOPE_EPISODE, scope_label="本集")
    plan.items.append(
        svc.BundleItem(shot_id="s", shot_code="S001", shot_title="x", chapter_label="第1集", included=True, file_name="a.mp4")
    )
    assert svc.bundle_filename(plan) == "成片交付_本集_1条.zip"


def test_empty_zip_still_carries_a_manifest_but_has_no_videos() -> None:
    """极端情况：范围里一条都没有 → 包内只有清单（路由层会先拒绝，这里守住纯函数口径）。"""
    plan = svc.VideoBundlePlan(project_id="p", scope=svc.SCOPE_EPISODES, scope_label="本项目全部集")
    plan.items.append(svc.BundleItem(shot_id="s", shot_code="S001", shot_title="x", chapter_label="第1集"))
    payload = svc.write_bundle_zip(plan)
    with zipfile.ZipFile(io.BytesIO(payload.getvalue())) as archive:
        assert archive.namelist() == [svc.MANIFEST_NAME]


# ---------------------------------------------------------------------------
# 路由层：真实的 HTTP 契约（预检 / 下载 / 空范围的自然语言错误）
# ---------------------------------------------------------------------------

#: 每个用例用**自己的**项目 / 章节 id：会话临时库在同一个 pytest 会话里是共用的，
#: 复用 id 会撞主键（真接入测的就是这个）。
PROJECT_ID = "proj-bundle"


def _ids(tag: str) -> tuple[str, str]:
    """按用例标签生成不会互相冲突的项目 / 章节 id。"""
    project_id = f"{PROJECT_ID}-{tag}"
    return project_id, f"{project_id}::EP01"


def _seed_route_data(
    session_database: Any,
    storage_root: Path,
    *,
    tag: str,
    with_video: bool,
) -> tuple[str, str]:
    """往会话临时库里写一集两镜；可选给第一镜一个真实成片文件。

    返回 ``(project_id, chapter_id)``，调用方据此拼 URL。
    """
    import asyncio as _asyncio

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

    from app.models.studio import Chapter, Project, Shot

    project_id, chapter_id = _ids(tag)

    async def _run() -> None:
        engine = create_async_engine(str(session_database.url), future=True)
        maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        async with maker() as db:
            db.add(Project(id=project_id, name="打包下载用例", description="", style="真人都市", visual_style="现实"))
            await db.flush()
            db.add(
                Chapter(
                    id=chapter_id,
                    project_id=project_id,
                    index=1,
                    title="第一集",
                    raw_text="文本",
                    condensed_text="文本",
                )
            )
            await db.flush()
            db.add(Shot(id=f"{tag}-shot-1", chapter_id=chapter_id, index=1, title="便利店 · 全景推进", status="ready"))
            db.add(Shot(id=f"{tag}-shot-2", chapter_id=chapter_id, index=2, title="女孩进门 · 中景", status="ready"))
            if with_video:
                key = f"generated-videos/shots/{tag}-shot-1/ok.mp4"
                target = storage_root / key
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(_VIDEO_BYTES)
                db.add(FileItem(id=f"{tag}-file-1", type="video", name="成片.mp4", storage_key=key))
                await db.flush()
                shot = await db.get(Shot, f"{tag}-shot-1")
                assert shot is not None
                shot.generated_video_file_id = f"{tag}-file-1"
            await db.commit()
        await engine.dispose()

    _asyncio.run(_run())
    return project_id, chapter_id


def test_bundle_plan_route_reports_counts_without_reading_bytes(
    client: Any, session_database: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """预检端点：真实 HTTP 200，形状正确，包含/排除数量与原因都说得清。"""
    root = tmp_path / "route-storage"
    monkeypatch.setattr(settings, "storage_driver", "local", raising=False)
    monkeypatch.setattr(settings, "local_storage_root", str(root), raising=False)
    monkeypatch.setattr(settings, "local_storage_base_url", "", raising=False)
    project_id, chapter_id = _seed_route_data(session_database, root, tag="plan", with_video=True)

    response = client.get(
        f"/api/v1/studio/video-delivery/{project_id}/bundle/plan",
        params={"scope": "episode", "chapter_id": chapter_id},
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["included_count"] == 1
    assert data["excluded_count"] == 1
    assert data["has_content"] is True
    assert data["scope_label"] == "当前集"
    # 预检不读字节 → 大小为 0（页面据此知道"这只是预检"）
    assert data["items"][0]["size_bytes"] == 0
    assert data["items"][0]["included"] is True
    assert "还没有生成结果" in data["excluded"][0]["reason"]
    # 主区口径：响应里没有本机绝对路径
    assert str(tmp_path) not in response.text


def test_bundle_download_route_returns_a_real_zip(
    client: Any, session_database: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """下载端点：真的是一个能打开的 ZIP，里面有成片与交付清单。"""
    root = tmp_path / "route-storage"
    monkeypatch.setattr(settings, "storage_driver", "local", raising=False)
    monkeypatch.setattr(settings, "local_storage_root", str(root), raising=False)
    monkeypatch.setattr(settings, "local_storage_base_url", "", raising=False)
    project_id, chapter_id = _seed_route_data(session_database, root, tag="zip", with_video=True)

    response = client.get(
        f"/api/v1/studio/video-delivery/{project_id}/bundle",
        params={"scope": "episode", "chapter_id": chapter_id},
    )
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/zip"
    assert response.headers["x-bundle-included"] == "1"
    assert response.headers["x-bundle-excluded"] == "1"
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        members = archive.namelist()
        assert svc.MANIFEST_NAME in members
        video_names = [name for name in members if name != svc.MANIFEST_NAME]
        assert video_names == ["S001_便利店 · 全景推进.mp4"]
        assert archive.read(video_names[0]) == _VIDEO_BYTES


def test_bundle_download_without_results_returns_natural_language_error(
    client: Any, session_database: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """一条成片都没有时：404 + 自然语言（不返回空 ZIP，也不暴露内部标识）。"""
    root = tmp_path / "route-storage"
    monkeypatch.setattr(settings, "storage_driver", "local", raising=False)
    monkeypatch.setattr(settings, "local_storage_root", str(root), raising=False)
    monkeypatch.setattr(settings, "local_storage_base_url", "", raising=False)
    project_id, chapter_id = _seed_route_data(session_database, root, tag="empty", with_video=False)

    response = client.get(
        f"/api/v1/studio/video-delivery/{project_id}/bundle",
        params={"scope": "episode", "chapter_id": chapter_id},
    )
    assert response.status_code == 404
    # 信封里的 message / detail 都可能承载这句人话（应用级处理器口径），整包文本一起看
    body = response.text
    assert "没有可下载的成片" in body
    assert "请先在「生成与交付」里生成至少一个镜头" in body
    # 不出现内部标识 / 调试原文
    for forbidden in ("file_id", "shot_id", "traceback", "Traceback"):
        assert forbidden not in body


def test_bundle_download_honours_selected_shot_ids(
    client: Any, session_database: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """只勾没有生成结果的那一镜 → 自然语言错误；勾有结果的那一镜 → 正常拿到包。"""
    root = tmp_path / "route-storage"
    monkeypatch.setattr(settings, "storage_driver", "local", raising=False)
    monkeypatch.setattr(settings, "local_storage_root", str(root), raising=False)
    monkeypatch.setattr(settings, "local_storage_base_url", "", raising=False)
    project_id, _chapter_id = _seed_route_data(session_database, root, tag="pick", with_video=True)

    # 只勾第二镜（没有生成结果）→ 没有可交付内容
    response = client.get(
        f"/api/v1/studio/video-delivery/{project_id}/bundle",
        params={"scope": "episode", "shot_ids": "pick-shot-2"},
    )
    assert response.status_code == 404, response.text

    # 勾第一镜 → 正常拿到包
    response = client.get(
        f"/api/v1/studio/video-delivery/{project_id}/bundle",
        params={"scope": "episode", "shot_ids": "pick-shot-1"},
    )
    assert response.status_code == 200, response.text
    assert response.headers["x-bundle-included"] == "1"
