"""视频提交的**幂等保护**（同一镜头＋同一参数＋同一 attempt 只花一次钱）。

为什么这个测试必须存在
======================

视频提交以前**没有**任何请求标识：``build_create_task_body`` 只发 prompt / model / 帧 / 音频。
于是"请求发出去了、但没等到回复"（网络断、进程被杀、浏览器关掉、前端超时重试）之后，
**无法判断上游是否已经建了任务**，重试就是再花一次钱。本轮真实演练里我就踩到过这一幕。

本文件锁住四条语义（对应用户要求的四个场景）：

1. **重复提交**：同镜头＋同参数＋同 attempt → 第二次**不再调供应商**，直接复用既有任务；
2. **并发重复**：同一时刻两个相同请求 → 上游只被调用**一次**；
3. **刷新恢复**：换一个**新的数据库会话**（模拟刷新/重进）重新提交 → 仍然命中同一个任务，
   并且能读出上游任务号与视频地址；
4. **明确重新生成**：attempt +1（页面上的「重新生成」）→ 才会真的创建新任务。

另外锁住：幂等键**不含任何凭证**，且新写出的任务行 payload 里**不再出现 api_key**。

全部离线：任务工厂与 run_args 都注入 stub，不联网、不产生任何费用。
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any, AsyncIterator

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import app.models  # noqa: F401 - 导入即注册全部表
from app.core.db import Base
from app.models.task import GenerationTask
from app.schemas.studio.image_pipeline import (
    VideoSubmitPlanRead,
    VideoSubmitRequest,
)
from app.services.studio.image_pipeline import video_idempotency as video_idem
from app.services.studio.image_pipeline import video_submit as video_submit_module
from app.services.studio.image_pipeline.video_submit import (
    MIN_VIDEO_SECONDS,
    PINNED_VIDEO_MODEL,
    PINNED_VIDEO_RESOLUTION,
    submit_video,
)
from app.services.studio.llm_orchestration.dry_run import CONFIRM_ENV, DRY_RUN_ENV

SHOT_ID = "shot-idem-1"
UPSTREAM_TASK_ID = "apimart-video-task-0001"
VIDEO_URL = "https://cdn.example.com/generated/shot-idem-1.mp4"


async def _plan(_db, *, body):  # type: ignore[no-untyped-def]
    return VideoSubmitPlanRead(
        shot_id=body.shot_id,
        provider="apimart",
        model_name=PINNED_VIDEO_MODEL,
        resolution=PINNED_VIDEO_RESOLUTION,
        seconds=MIN_VIDEO_SECONDS,
        ratio="16:9",
    )


def _run_args_builder(api_key: str = "sk-test-must-not-be-stored"):  # type: ignore[no-untyped-def]
    async def _build(_db, **_kwargs):  # type: ignore[no-untyped-def]
        return {
            "provider": "apimart",
            "api_key": api_key,
            "base_url": "https://api.apimart.test",
            "input": {
                "prompt": "苏晚棠推门而入，镜头缓慢前推",
                "ratio": "16:9",
                "model": PINNED_VIDEO_MODEL,
                "seconds": MIN_VIDEO_SECONDS,
                "first_frame_base64": "https://cdn.example.com/frame.png",
            },
        }

    return _build


class _StubVideoTask:
    """假的视频任务：不联网，只记录"上游被创建了几次"。"""

    def __init__(self, *, runs: list[str], delay: float = 0.0) -> None:
        self._runs = runs
        self._delay = delay
        self._provider_task_id = ""

    async def run(self) -> None:
        self._runs.append(UPSTREAM_TASK_ID)
        if self._delay:
            await asyncio.sleep(self._delay)
        self._provider_task_id = UPSTREAM_TASK_ID

    async def get_result(self) -> Any:
        return SimpleNamespace(
            provider="apimart",
            status="succeeded",
            provider_task_id=UPSTREAM_TASK_ID,
            url=VIDEO_URL,
        )

    async def status(self) -> dict[str, Any]:
        return {"error": ""}


def _factory(runs: list[str], *, delay: float = 0.0):  # type: ignore[no-untyped-def]
    def _make(**_kwargs: Any) -> _StubVideoTask:
        return _StubVideoTask(runs=runs, delay=delay)

    return _make


@pytest.fixture(autouse=True)
def _real_call(monkeypatch: pytest.MonkeyPatch) -> None:
    """把守卫放开（真实提交路径），但**不联网**：plan / run_args / task 全部 stub。"""
    monkeypatch.setenv(DRY_RUN_ENV, "0")
    monkeypatch.setenv(CONFIRM_ENV, "1")
    monkeypatch.setattr(video_submit_module, "build_video_submit_plan", _plan)


@asynccontextmanager
async def _file_db(tmp_path) -> AsyncIterator[Any]:  # type: ignore[no-untyped-def]
    """**文件库**（不是 :memory:）：这样"每次请求一个新会话"是真的新连接，能验证跨会话恢复。"""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'idem.db'}", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    try:
        yield maker
    finally:
        await engine.dispose()


def _body(**overrides: Any) -> VideoSubmitRequest:
    data: dict[str, Any] = {
        "shot_id": SHOT_ID,
        "reference_mode": "first",
        "prompt": "苏晚棠推门而入，镜头缓慢前推",
    }
    data.update(overrides)
    return VideoSubmitRequest(**data)


async def _submit(maker, *, body=None, runs, delay: float = 0.0):  # type: ignore[no-untyped-def]
    async with maker() as db:
        return await submit_video(
            db,
            body=body or _body(),
            run_args_builder=_run_args_builder(),
            task_factory=_factory(runs, delay=delay),
            preflight=None,
        )


# ---------------------------------------------------------------------------
# ① 重复提交：第二次不再调供应商
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_duplicate_submit_reuses_task_without_calling_vendor(tmp_path) -> None:  # type: ignore[no-untyped-def]
    runs: list[str] = []
    async with _file_db(tmp_path) as maker:
        first = await _submit(maker, runs=runs)
        second = await _submit(maker, runs=runs)

    assert runs == [UPSTREAM_TASK_ID], "上游只应被调用一次"
    assert first.deduplicated is False
    assert first.status == "succeeded"
    assert first.provider_task_id == UPSTREAM_TASK_ID
    assert first.url == VIDEO_URL

    assert second.deduplicated is True, "同一轮重复提交必须命中既有任务"
    assert second.provider_task_id == UPSTREAM_TASK_ID
    assert second.url == VIDEO_URL
    assert second.task_id == first.task_id and second.task_id
    assert second.source_task_id == first.source_task_id
    assert second.attempt == 0
    assert any("没有再次计费" in item for item in second.warnings)


# ---------------------------------------------------------------------------
# ② 并发重复：上游只被调用一次
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_concurrent_duplicates_create_one_upstream_task(tmp_path) -> None:  # type: ignore[no-untyped-def]
    runs: list[str] = []
    async with _file_db(tmp_path) as maker:
        # 两个"同时到达"的相同请求，各自独立会话/连接；上游故意慢一点，制造真实竞争窗口。
        first, second = await asyncio.gather(
            _submit(maker, runs=runs, delay=0.2),
            _submit(maker, runs=runs, delay=0.2),
        )

    assert runs == [UPSTREAM_TASK_ID], f"并发重复只能建一个上游任务，实际 {len(runs)} 个"
    dedup_flags = sorted([first.deduplicated, second.deduplicated])
    assert dedup_flags == [False, True], "一个真提交、一个复用"
    assert first.task_id == second.task_id
    assert {first.url, second.url} == {VIDEO_URL}


# ---------------------------------------------------------------------------
# ③ 刷新恢复：换新会话仍然命中同一个任务
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_refresh_recovers_same_task_from_database(tmp_path) -> None:  # type: ignore[no-untyped-def]
    runs: list[str] = []
    async with _file_db(tmp_path) as maker:
        first = await _submit(maker, runs=runs)

        # 模拟"刷新页面 / 重新进入"：全新会话，且**不传**任何登录态缓存。
        async with maker() as fresh:
            key = video_idem.build_video_idempotency_key(
                shot_id=SHOT_ID,
                prompt="苏晚棠推门而入，镜头缓慢前推",
                reference_mode="first",
                images=[],
                ratio="",
                duration_seconds=None,
                generate_audio=None,
                attempt=0,
            )
            row = await video_idem.find_task_by_key(fresh, key=key)
            assert row is not None, "刷新后必须能按幂等键找回任务行"
            restored = video_idem.read_from_task(row)

        again = await _submit(maker, runs=runs)

    assert runs == [UPSTREAM_TASK_ID]
    assert restored["task_id"] == first.task_id
    assert restored["provider_task_id"] == UPSTREAM_TASK_ID
    assert restored["url"] == VIDEO_URL
    assert restored["status"] == "succeeded"
    assert again.deduplicated is True


# ---------------------------------------------------------------------------
# ④ 明确「重新生成」：attempt +1 才会创建新任务
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_explicit_regenerate_increments_attempt_and_creates_new_task(tmp_path) -> None:  # type: ignore[no-untyped-def]
    runs: list[str] = []
    async with _file_db(tmp_path) as maker:
        first = await _submit(maker, runs=runs)
        regenerate = await _submit(maker, body=_body(attempt=1), runs=runs)
        # 回到第 0 轮再提交：仍然复用第 0 轮那个任务，不会串到 attempt=1 上
        back_to_first = await _submit(maker, runs=runs)

    assert len(runs) == 2, "只有明确重新生成（attempt+1）才允许再建一个上游任务"
    assert regenerate.deduplicated is False
    assert regenerate.attempt == 1
    assert regenerate.task_id and regenerate.task_id != first.task_id
    assert regenerate.source_task_id != first.source_task_id

    assert back_to_first.deduplicated is True
    assert back_to_first.task_id == first.task_id
    assert back_to_first.attempt == 0


# ---------------------------------------------------------------------------
# 键与落库的卫生
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_task_payload_never_stores_credentials(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """新写出的任务行**不得**含有 api_key（旧路径把 api_key 明文写进了 payload，已在报告里报备）。"""
    runs: list[str] = []
    async with _file_db(tmp_path) as maker:
        await _submit(maker, runs=runs)
        async with maker() as db:
            rows = (await db.execute(select(GenerationTask))).scalars().all()

    assert len(rows) == 1
    dumped = str(rows[0].payload)
    assert "sk-test-must-not-be-stored" not in dumped
    assert "api_key" not in dumped
    assert rows[0].payload["shot_id"] == SHOT_ID
    assert video_idem.key_of_task_payload(rows[0].payload) != ""


def test_key_is_stable_and_attempt_sensitive() -> None:
    base = dict(
        shot_id=SHOT_ID,
        prompt="p",
        reference_mode="first",
        images=["a.png", "b.png"],
        ratio="16:9",
        duration_seconds=5,
        generate_audio=True,
    )
    same = video_idem.build_video_idempotency_key(**base)  # type: ignore[arg-type]
    assert same == video_idem.build_video_idempotency_key(**base)  # type: ignore[arg-type]
    assert same.startswith("vid-")
    assert len(same) == len("vid-") + 16

    # 参数变了 / attempt 变了 / 图片顺序变了 → 键必须变（否则会错误复用）
    assert video_idem.build_video_idempotency_key(**{**base, "attempt": 1}) != same  # type: ignore[arg-type]
    assert video_idem.build_video_idempotency_key(**{**base, "prompt": "p2"}) != same  # type: ignore[arg-type]
    assert video_idem.build_video_idempotency_key(**{**base, "images": ["b.png", "a.png"]}) != same  # type: ignore[arg-type]


def test_strip_credentials_removes_secrets_deeply() -> None:
    cleaned = video_idem.strip_credentials(
        {"prompt": "p", "api_key": "sk-x", "Authorization": "Bearer y", "nested": {"token": "t", "keep": 1}}
    )
    assert cleaned == {"prompt": "p", "nested": {"keep": 1}}
