"""只读出口与付费出口必须严格分离（本轮适配缺口的回归测试）。

背景（实测）：查询出图任务原本与"真实出图提交"共用 ``OUTLET_IMAGE``，
于是真实模式下不打开 ``JELLYFISH_REAL_LLM_CONFIRMED=1`` 就**读不到**任何已有任务的
产物；而打开它又会同时放开真实出图提交。只读请求不可能产生费用，不该被付费确认拦住。

本文件锁定三条边界：
1. GET（读任务 / 健康探测）走 ``OUTLET_IMAGE_READ``，真实未确认模式下**放行**；
2. POST（创建任务 = 会真出图）仍走 ``OUTLET_IMAGE``，真实未确认模式下**拦住**；
3. DRY_RUN 开启时两者都被拦住（演练模式行为不变）。
"""

from __future__ import annotations

import pytest

from app.services.studio.image_pipeline import external_image_client as client
from app.services.studio.llm_orchestration import dry_run


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in (dry_run.DRY_RUN_ENV, dry_run.CONFIRM_ENV, dry_run.ALLOWED_OUTLETS_ENV):
        monkeypatch.delenv(key, raising=False)


def test_read_outlet_is_declared_and_not_a_billable_outlet() -> None:
    """只读出口存在、有中文标签，且**不在**收费出口清单里。"""
    assert dry_run.OUTLET_IMAGE_READ in dry_run.READ_ONLY_OUTLETS
    assert dry_run.outlet_label(dry_run.OUTLET_IMAGE_READ)
    assert dry_run.OUTLET_IMAGE_READ not in dry_run.OUTLETS
    assert dry_run.OUTLET_IMAGE not in dry_run.READ_ONLY_OUTLETS


def test_read_only_outlet_allowed_without_paid_confirmation(monkeypatch: pytest.MonkeyPatch) -> None:
    """真实模式 + 未确认：只读出口放行（这正是"读出图结果"能工作的前提）。"""
    monkeypatch.setenv(dry_run.DRY_RUN_ENV, "0")
    dry_run.assert_outbound_allowed("查询出图任务", outlet=dry_run.OUTLET_IMAGE_READ)


def test_read_only_outlet_ignores_billable_allowlist(monkeypatch: pytest.MonkeyPatch) -> None:
    """收费出口白名单只表达"授权哪些收费出口"，不该反过来挡住不计费的读。"""
    monkeypatch.setenv(dry_run.DRY_RUN_ENV, "0")
    monkeypatch.setenv(dry_run.CONFIRM_ENV, "1")
    monkeypatch.setenv(dry_run.ALLOWED_OUTLETS_ENV, "oss")
    dry_run.assert_outbound_allowed("查询出图任务", outlet=dry_run.OUTLET_IMAGE_READ)
    with pytest.raises(dry_run.OutletNotAllowed):
        dry_run.assert_outbound_allowed("提交出图", outlet=dry_run.OUTLET_IMAGE)


def test_billable_image_outlet_still_requires_confirmation(monkeypatch: pytest.MonkeyPatch) -> None:
    """付费出图出口在"真实未确认"下仍然被拦——本次修复没有放松收费闸门。"""
    monkeypatch.setenv(dry_run.DRY_RUN_ENV, "0")
    with pytest.raises(dry_run.RealCallNotConfirmed):
        dry_run.assert_outbound_allowed("提交出图", outlet=dry_run.OUTLET_IMAGE)


def test_dry_run_still_blocks_reads(monkeypatch: pytest.MonkeyPatch) -> None:
    """演练模式下只读请求同样被拦（行为不变：DRY_RUN 是最先生效的一层）。"""
    monkeypatch.setenv(dry_run.DRY_RUN_ENV, "1")
    with pytest.raises(dry_run.DryRunBlocked):
        dry_run.assert_outbound_allowed("查询出图任务", outlet=dry_run.OUTLET_IMAGE_READ)


def test_request_json_picks_outlet_by_http_method(monkeypatch: pytest.MonkeyPatch) -> None:
    """``_request_json`` 按方法分流：GET → 只读出口；POST → 付费出图出口。"""
    seen: list[str] = []

    def _capture(detail: str = "", *, outlet: str = "") -> None:
        seen.append(outlet)
        raise dry_run.DryRunBlocked(detail, outlet=outlet)

    monkeypatch.setattr(dry_run, "assert_outbound_allowed", _capture)
    monkeypatch.setattr(client.dry_run, "assert_outbound_allowed", _capture, raising=True)

    import asyncio

    for method in ("GET", "POST"):
        with pytest.raises(dry_run.DryRunBlocked):
            asyncio.run(client._request_json(method, "/api/service/asset-image-tasks/x"))

    assert seen[0] == dry_run.OUTLET_IMAGE_READ, "GET 必须走只读出口"
    assert seen[1] == dry_run.OUTLET_IMAGE, "POST 必须走付费出图出口"
