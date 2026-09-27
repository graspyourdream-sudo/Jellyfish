"""「图出来了、但长期存储没成功」必须判成**部分成功**，并且带上可恢复信息。

真实演练（2026-09-27，苏晚棠人物定版）：出图服务把「图已经生成、但它自己 OSS 上传 403」这件事
报成 ``status=failed``。只按状态判，结论就是"全失败"——可图明明在、而且**这一次已经计费了**。
表现上的两个坏结果：

1. 页面只剩一句失败，用户以为白花了钱，也就不会去"采纳"那张还在的图；
2. 「部分成功」这条产品口径在最有价值的那一次故障里失效。

所以本文件钉死三条：

- 状态失败 + 有可恢复产物 + 失败原因是存储 → ``partial_failed``（部分成功，可救）；
- 状态失败 + **没有**可恢复产物 → 仍然是 ``failed``（不粉饰）；
- 状态失败 + 有产物但失败原因**不是**存储（例如模型拒绝生成）→ 仍然是 ``failed``
  （不能把真失败说成"部分成功"）。
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.services.studio.image_pipeline.image_pipeline import (
    OUTCOME_FAILED,
    OUTCOME_OK,
    OUTCOME_PARTIAL_FAILED,
    OUTCOME_UNKNOWN,
    normalize_outcome,
)

#: 上游当时的原文（节选）
OSS_403 = "出图成功但 OSS 上传失败：OSS 上传返回 HTTP 403 AccessDenied：bucket acl"


def test_failed_with_recoverable_artifact_and_storage_error_is_partial() -> None:
    assert (
        normalize_outcome(
            status="failed",
            ok=False,
            error_message=OSS_403,
            recoverable_artifact=True,
        )
        == OUTCOME_PARTIAL_FAILED
    )


def test_failed_without_recoverable_artifact_stays_failed() -> None:
    """没有可恢复产物 → 就是失败，不许粉饰成"部分成功"。"""
    assert (
        normalize_outcome(
            status="failed",
            ok=False,
            error_message=OSS_403,
            recoverable_artifact=False,
        )
        == OUTCOME_FAILED
    )


def test_failed_with_recoverable_artifact_but_non_storage_error_stays_failed() -> None:
    """有产物、但失败原因是模型侧（不是存储）→ 仍然是失败。"""
    assert (
        normalize_outcome(
            status="failed",
            ok=False,
            error_message="模型拒绝生成：内容不符合安全策略",
            recoverable_artifact=True,
        )
        == OUTCOME_FAILED
    )


def test_succeeded_without_long_term_url_is_still_partial() -> None:
    """原有口径不能被改坏：状态说成功、却没有长期地址 + 存储相关错误 → 部分成功。"""
    assert (
        normalize_outcome(status="succeeded", ok=True, oss_url="", error_message=OSS_403)
        == OUTCOME_PARTIAL_FAILED
    )


def test_succeeded_with_oss_url_is_ok() -> None:
    assert (
        normalize_outcome(
            status="succeeded",
            ok=True,
            oss_url="https://bucket.example.com/a.png",
        )
        == OUTCOME_OK
    )


def test_recoverable_artifact_does_not_rescue_unknown() -> None:
    """认不出来的状态仍然是 unknown：可恢复产物不是"我猜成功了"的许可证。"""
    assert (
        normalize_outcome(
            status="something-weird",
            ok=None,
            error_message=OSS_403,
            recoverable_artifact=True,
        )
        == OUTCOME_UNKNOWN
    )


# ---------------------------------------------------------------------------
# 「不等待」也要问一次真相：批量路径不能把"图已生成"说成"生成失败"
# ---------------------------------------------------------------------------


def test_looks_like_success_only_for_clear_success() -> None:
    """只有**明确成功**才不必再查详情；失败/未知都值得查一次（只读、免费）。"""
    from app.services.studio.image_pipeline.image_pipeline import _looks_like_success

    assert _looks_like_success(SimpleNamespace(ok=True, status="done")) is True
    assert _looks_like_success(SimpleNamespace(ok=True, status="succeeded")) is True
    assert _looks_like_success(SimpleNamespace(ok=False, status="failed")) is False
    assert _looks_like_success(SimpleNamespace(ok=True, status="failed")) is False
    assert _looks_like_success(SimpleNamespace(ok=True, status="")) is False


@pytest.mark.asyncio
async def test_batch_submit_without_wait_still_fetches_detail_once() -> None:
    """`wait_seconds=0`（批量出图路径）时也要拉一次任务详情，把真相与可恢复产物拿回来。

    真实演练（2026-09-27，对象「乌鸦」）：一批出图，上游"出图成功但 OSS 上传 403"，
    上游任务里明明有 `local_path=/images/乌鸦_主图_01_03.png`，但批量路径从不查详情，
    于是页面只看到「生成失败」——既没有可恢复信息，也没有采纳这张图的入口。
    """
    from app.services.studio.image_pipeline import image_pipeline as pipe

    created: list[str] = []
    detail_calls: list[str] = []

    async def _create(**kwargs):  # type: ignore[no-untyped-def]
        created.append(kwargs["source_asset_id"])
        return pipe.client.ServiceTaskResult(
            ok=True,
            service_task_id="svc-1",
            source_task_id=kwargs["source_task_id"],
            status="failed",
            message="出图成功但 OSS 上传失败：OSS 上传返回 HTTP 403 AccessDenied",
        )

    async def _get_detail(service_task_id: str, **_kwargs):  # type: ignore[no-untyped-def]
        detail_calls.append(service_task_id)
        return pipe.client.ServiceTaskDetail(
            ok=False,
            service_task_id=service_task_id,
            source_task_id="t-1",
            status="failed",
            error_message="出图成功但 OSS 上传失败：OSS 上传返回 HTTP 403 AccessDenied：bucket acl",
            local_path="/images/乌鸦_主图_01_03.png",
            oss_url="",
        )

    import app.services.studio.llm_orchestration.dry_run as dry_run_mod

    monkey = dry_run_mod.dry_run_enabled
    dry_run_mod.dry_run_enabled = lambda: False  # type: ignore[assignment]
    try:
        old_create, old_get = pipe.client.create_asset_image_task, pipe.client.get_asset_image_task
        pipe.client.create_asset_image_task = _create  # type: ignore[assignment]
        pipe.client.get_asset_image_task = _get_detail  # type: ignore[assignment]
        try:
            target = pipe.SubmissionTarget(
                source_task_id="t-1",
                source_asset_id="asset-1",
                name="乌鸦",
                prompt="一只通体漆黑的乌鸦停在灵堂的棺木上",
                asset_type="character",
                stage="character_sheet",
                result_kind="characterReference",
                result_label="人物参考图",
            )
            results = await pipe.submit_targets([target], wait_seconds=0.0)
        finally:
            pipe.client.create_asset_image_task = old_create  # type: ignore[assignment]
            pipe.client.get_asset_image_task = old_get  # type: ignore[assignment]
    finally:
        dry_run_mod.dry_run_enabled = monkey  # type: ignore[assignment]

    assert created == ["asset-1"]
    assert detail_calls == ["svc-1"], "不等待也必须查一次详情（只读、免费）"
    assert len(results) == 1
    result = results[0]
    # 存储失败 + 有可恢复产物 → 部分成功，并且**带上可恢复信息**
    assert result.outcome == OUTCOME_PARTIAL_FAILED
    assert result.oss_ready is False
    assert result.detail["recoverable"] is True
    assert "可以直接采纳它" in result.detail["recoverable_hint"]
    assert result.detail["artifact_state"] == "recoverable"
