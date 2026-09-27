"""出图前的**免费存储预检**：能不能拦下"花了钱图却取不回来"。

真实演练（2026-09-27）：出图服务把图生成出来了（**已计费**），但它自己上传 OSS 被拒
（HTTP 403 AccessDenied / bucket acl）→ 钱花了、长期资产没拿到。
而"存储接不接得住"这件事在**提交之前**就能免费问出来（``GET /api/service/health``）。

本文件钉死四条：

1. 上游说**没配置** → 拦下，错误里带缺哪些配置项 + 中文修法，且 **一个请求都没发**；
2. 上游说**配置了但写不进去**（可写性为 false）→ 同样拦下（这正是那次真实故障的形态）；
3. 上游**明确回报可写** → 放行；
4. 上游只回报"配了"、**不回报可写性**（当前上游的实际形态）→ **降级放行**，
   但必须如实告知残留风险、并明确写出"需要上游补可写性探测"——**不许假装验过**。

全部离线：健康检查注入 stub，不联网。
"""

from __future__ import annotations

import pytest

from app.services.studio.image_pipeline import storage_precheck as sp
from app.services.studio.llm_orchestration.dry_run import CONFIRM_ENV, DRY_RUN_ENV

CONFIGURED_UNVERIFIED = {
    "ok": True,
    "service": "ai-image-tool",
    # 当前上游的真实返回形态：只说配没配，不说写不写得进去
    "oss": {"configured": True, "missing": [], "public_base_url": "https://bucket.example.com"},
}
NOT_CONFIGURED = {
    "ok": True,
    "oss": {
        "configured": False,
        "missing": ["ALIYUN_OSS_ACCESS_KEY_ID", "ALIYUN_OSS_BUCKET"],
        "public_base_url": "",
    },
}
NOT_WRITABLE = {
    "ok": True,
    "oss": {
        "configured": True,
        "missing": [],
        "public_base_url": "https://bucket.example.com",
        "writable": False,
        "blocked_reason": "OSS 上传返回 HTTP 403 AccessDenied：bucket acl",
    },
}
WRITABLE = {
    "ok": True,
    "oss": {"configured": True, "missing": [], "writable": True},
}


@pytest.fixture(autouse=True)
def _real_call(monkeypatch: pytest.MonkeyPatch) -> None:
    # 预检是"花钱之前"的守卫：测试里必须让它认为现在是真实模式，否则会走演练分支直接放行
    monkeypatch.setenv(DRY_RUN_ENV, "0")
    monkeypatch.setenv(CONFIRM_ENV, "1")


# ---------------------------------------------------------------------------
# 纯函数：四档判定
# ---------------------------------------------------------------------------


def test_not_configured_blocks_and_names_missing_keys() -> None:
    r = sp.evaluate_storage_readiness(NOT_CONFIGURED)
    assert r.ok is False
    assert r.state == sp.STATE_NOT_CONFIGURED
    assert r.missing == ["ALIYUN_OSS_ACCESS_KEY_ID", "ALIYUN_OSS_BUCKET"]
    assert "ALIYUN_OSS_BUCKET" in r.fix_hint
    assert "要计费" in r.message
    assert "不会产生任何费用" in r.fix_hint


def test_configured_but_not_writable_blocks() -> None:
    """这条就是那次真实故障的形态：配置齐全、但写入被拒。"""
    r = sp.evaluate_storage_readiness(NOT_WRITABLE)
    assert r.ok is False
    assert r.state == sp.STATE_NOT_WRITABLE
    assert "写入被拒" in r.message
    assert "403 AccessDenied" in r.message
    assert "写权限" in r.fix_hint


def test_explicitly_writable_passes() -> None:
    r = sp.evaluate_storage_readiness(WRITABLE)
    assert r.ok is True
    assert r.state == sp.STATE_WRITABLE


def test_configured_without_writability_degrades_but_says_so() -> None:
    """配了但没回报可写性 → 放行，但必须写清残留风险与"上游要补什么"。"""
    r = sp.evaluate_storage_readiness(CONFIGURED_UNVERIFIED)
    assert r.ok is True
    assert r.state == sp.STATE_CONFIGURED_UNVERIFIED
    assert "不回报" in r.message
    assert "403" in r.fix_hint
    assert r.needs_upstream, "必须明确指出需要上游配合的点，不许假装验过"


def test_missing_oss_section_is_unverified_not_silently_ok() -> None:
    r = sp.evaluate_storage_readiness({"ok": True})
    assert r.ok is True
    assert r.state == sp.STATE_CONFIGURED_UNVERIFIED
    assert r.needs_upstream


def test_garbage_payload_does_not_crash() -> None:
    for payload in (None, {}, {"oss": "nonsense"}, {"oss": {}}):
        r = sp.evaluate_storage_readiness(payload)
        assert r.state in {sp.STATE_CONFIGURED_UNVERIFIED, sp.STATE_NOT_CONFIGURED}


# ---------------------------------------------------------------------------
# 异步入口：拦下时抛结构化 409，且不联网、不发任何出图请求
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_or_raise_blocks_with_structured_409(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _probe(**kwargs):  # type: ignore[no-untyped-def]
        return NOT_WRITABLE

    monkeypatch.setattr(sp.client, "probe_health", _probe)

    with pytest.raises(sp.StoragePrecheckBlocked) as exc_info:
        await sp.ensure_vendor_storage_ready_or_raise()

    detail = exc_info.value.detail
    assert exc_info.value.status_code == 409
    assert detail["code"] == sp.STORAGE_BLOCKED_CODE
    assert detail["storage_state"] == sp.STATE_NOT_WRITABLE
    assert detail["paid_call_made"] is False
    assert detail["fix_hint"]
    assert detail["needs_upstream"] == ""  # 这条不需要上游再改：上游已经如实报了不可写


@pytest.mark.asyncio
async def test_or_raise_passes_when_writable(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _probe(**kwargs):  # type: ignore[no-untyped-def]
        return WRITABLE

    monkeypatch.setattr(sp.client, "probe_health", _probe)
    r = await sp.ensure_vendor_storage_ready_or_raise()
    assert r.ok is True
    assert r.state == sp.STATE_WRITABLE


@pytest.mark.asyncio
async def test_unreachable_service_degrades_instead_of_guessing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """探不动 ≠ 不能写：如实降级放行，交给真正的提交去报真实原因。

    为什么不在这一层拦：连不上出图服务时"创建任务"本身就会失败、不会真花钱；
    而且守卫（未确认 / 出口未授权）也在这条探测路径上，抢着报错会把守卫该报的错盖成"存储问题"。
    """

    async def _probe(**kwargs):  # type: ignore[no-untyped-def]
        raise RuntimeError("connection refused")

    monkeypatch.setattr(sp.client, "probe_health", _probe)
    r = await sp.ensure_vendor_storage_ready()
    assert r.ok is True
    assert r.state == sp.STATE_UNREACHABLE
    assert "没能确认" in r.message
    assert "127.0.0.1:4173" in r.fix_hint


@pytest.mark.asyncio
async def test_dry_run_skips_precheck_without_touching_upstream(monkeypatch: pytest.MonkeyPatch) -> None:
    """演练模式：本来就不会真出图 → 不连上游、也不拦。"""
    monkeypatch.setenv(DRY_RUN_ENV, "1")
    called: list[str] = []

    async def _probe(**kwargs):  # type: ignore[no-untyped-def]
        called.append("probed")
        return NOT_WRITABLE

    monkeypatch.setattr(sp.client, "probe_health", _probe)
    r = await sp.ensure_vendor_storage_ready()
    assert r.ok is True
    assert called == [], "演练模式下不应该去连上游"
