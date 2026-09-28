"""直提出视频的四项生成设置（画幅 / 模型档位 / 分辨率 / 时长）必须**真的进请求契约**。

设计稿要求工作室生成区给出四个可选项；本测试钉住的是"它们不是前端控件"：

1. 允许范围来自**供应商能力表**（同一个模型的不同档位允许值不同）；
2. 用户选的值被采纳时进请求；不被采纳时**如实回报**（不静默换档）；
3. 不在能力表内的取值一律拒绝并说明原因；
4. 模型档位必须命中模型表里的视频模型；
5. 时长按模型上下限钳制（mini 是 5–15 秒，页面给 4 秒会被抬到 5 秒并说明）；
6. 幂等键含模型与分辨率 —— 改了这两项就是另一轮请求，不会复用上一轮结果。

全程只用会话临时库；不触发任何真实调用（DRY_RUN 开启）。
"""

from __future__ import annotations

from typing import Any

import pytest

from app.models.llm import Model, ModelCategoryKey, Provider
from app.models.studio import ShotDetail
from app.services.studio.image_pipeline import video_submit
from tests.llm_orchestration_fixtures import build_session, seed_project_chapter_shot


async def _seed_shot_detail(db: Any) -> None:
    """计划预览会读 ShotDetail（提示词/对白等）：补一条最小行，避免 404 干扰本测试。"""
    db.add(
        ShotDetail(
            id="shot-1",
            camera_shot="中景",
            angle="平视",
            movement="固定",
            duration=5,
            video_prompt="测试提示词",
            video_prompt_source="manual",
        )
    )
    await db.flush()


async def _seed_models(db: Any) -> None:
    """两个视频模型：mini（480p/720p、5–15s）与完整版（480p/720p/1080p/4k）。"""
    # api_key 只为让 provider 解析通过（**不会发起任何真实请求**：DRY_RUN 全程开启）
    db.add(
        Provider(
            id="p-apimart",
            name="apimart",
            base_url="https://example.invalid",
            api_key="test-key-not-used",
        )
    )
    await db.flush()
    db.add(
        Model(id="m-mini", name="seedance-2.0-mini", category=ModelCategoryKey.video, provider_id="p-apimart")
    )
    db.add(Model(id="m-full", name="seedance-2.0", category=ModelCategoryKey.video, provider_id="p-apimart"))
    db.add(Model(id="m-text", name="gpt-4o", category=ModelCategoryKey.text, provider_id="p-apimart"))
    await db.flush()


@pytest.mark.asyncio
async def test_options_come_from_the_capability_table() -> None:
    db, engine = await build_session()
    try:
        async with db:
            await seed_project_chapter_shot(db)
            await _seed_shot_detail(db)
            await _seed_models(db)
            plan = await video_submit.build_video_submit_plan(
                db,
                body=video_submit.VideoSubmitPlanRequest(
                    shot_id="shot-1", reference_mode="text_only", prompt="测试提示词"
                ),
            )
    finally:
        await engine.dispose()

    # 画幅 / 分辨率 / 时长都来自能力表，不是前端常量
    assert "16:9" in plan.ratio_options and "9:16" in plan.ratio_options
    assert plan.resolution_options == ["480p", "720p"]
    assert plan.duration_options == [5, 8, 10, 12, 15]
    # 模型档位来自模型表（只列视频模型，不列文本模型）
    assert plan.model_options == ["seedance-2.0", "seedance-2.0-mini"]
    assert plan.settings_notes, "四项设置必须给出中文结论"


@pytest.mark.asyncio
async def test_selected_model_and_resolution_enter_the_request() -> None:
    db, engine = await build_session()
    try:
        async with db:
            await seed_project_chapter_shot(db)
            await _seed_shot_detail(db)
            await _seed_models(db)
            plan = await video_submit.build_video_submit_plan(
                db,
                body=video_submit.VideoSubmitPlanRequest(
                    shot_id="shot-1",
                    reference_mode="text_only",
                    prompt="测试提示词",
                    model="seedance-2.0",
                    resolution="1080p",
                    ratio="9:16",
                    duration_seconds=12,
                ),
            )
    finally:
        await engine.dispose()

    assert plan.model_name == "seedance-2.0"
    assert plan.resolution == "1080p"
    assert plan.ratio == "9:16"
    assert plan.seconds == 12
    # 选的是非固定档位 → 必须有一条"请确认是否刻意切换"的如实提醒
    assert any("请确认是否刻意切换" in item for item in plan.warnings)


@pytest.mark.asyncio
async def test_resolution_not_allowed_by_the_model_is_refused_with_reason() -> None:
    """mini 只有 480p/720p：选 1080p 必须**不被采纳**且说清原因（不静默换档）。"""
    db, engine = await build_session()
    try:
        async with db:
            await seed_project_chapter_shot(db)
            await _seed_shot_detail(db)
            await _seed_models(db)
            plan = await video_submit.build_video_submit_plan(
                db,
                body=video_submit.VideoSubmitPlanRequest(
                    shot_id="shot-1",
                    reference_mode="text_only",
                    prompt="测试提示词",
                    model="seedance-2.0-mini",
                    resolution="1080p",
                ),
            )
    finally:
        await engine.dispose()

    assert plan.resolution == "480p", "没被采纳时用的是该模型的默认档"
    assert any("不在该模型支持的范围内" in item for item in plan.settings_notes)


@pytest.mark.asyncio
async def test_unknown_model_is_not_adopted_and_says_so() -> None:
    db, engine = await build_session()
    try:
        async with db:
            await seed_project_chapter_shot(db)
            await _seed_shot_detail(db)
            await _seed_models(db)
            plan = await video_submit.build_video_submit_plan(
                db,
                body=video_submit.VideoSubmitPlanRequest(
                    shot_id="shot-1",
                    reference_mode="text_only",
                    prompt="测试提示词",
                    model="不存在的模型",
                ),
            )
    finally:
        await engine.dispose()

    assert plan.model_name == "seedance-2.0-mini", "退回固定策略"
    assert any("没有采纳" in item for item in plan.warnings)


@pytest.mark.asyncio
async def test_duration_is_clamped_to_the_model_range() -> None:
    """页面给 4 秒（低于 mini 的下限 5 秒）→ 抬到 5 秒并说明。"""
    db, engine = await build_session()
    try:
        async with db:
            await seed_project_chapter_shot(db)
            await _seed_shot_detail(db)
            await _seed_models(db)
            plan = await video_submit.build_video_submit_plan(
                db,
                body=video_submit.VideoSubmitPlanRequest(
                    shot_id="shot-1",
                    reference_mode="text_only",
                    prompt="测试提示词",
                    duration_seconds=4,
                ),
            )
    finally:
        await engine.dispose()

    assert plan.seconds == 5
    assert any("不在该模型允许的范围内" in item for item in plan.warnings)


def test_idempotency_key_changes_when_model_or_resolution_changes() -> None:
    """改了模型档位或分辨率就是**另一轮**请求：键必须不同，否则参数等于没生效。"""
    from app.services.studio.image_pipeline import video_idempotency as idem

    base = dict(shot_id="shot-1", prompt="p", reference_mode="text_only", ratio="16:9", duration_seconds=5)
    key_a = idem.build_video_idempotency_key(**base, model="seedance-2.0-mini", resolution="480p")
    key_b = idem.build_video_idempotency_key(**base, model="seedance-2.0-mini", resolution="720p")
    key_c = idem.build_video_idempotency_key(**base, model="seedance-2.0", resolution="480p")
    assert len({key_a, key_b, key_c}) == 3
    # 原样重提仍命中同一轮
    assert idem.build_video_idempotency_key(**base, model="seedance-2.0-mini", resolution="480p") == key_a
