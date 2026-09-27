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
