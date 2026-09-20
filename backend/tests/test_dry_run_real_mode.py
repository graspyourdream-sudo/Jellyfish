"""真实/演练模式产品化测试：模式标识、每出口放行状态、中文开启步骤、结构化拦截错误。

覆盖四条产品要求：
1. 默认仍是演练模式（未设环境变量时不会真实付费）；
2. 真实模式必须**两个**开关同时满足，缺一个仍然是「不发真实请求」；
3. 状态接口给前端足够的字段（模式、每出口放行、中文 enable_steps），且既有字段不删；
4. 被守卫拦住的错误带机器可读 code/reason + 中文 message + 中文 how_to_enable，
   并明确区分「演练模式所以不发」与「真实模式已开但没确认」两种原因。

本文件**不做任何真实网络/付费调用**：全部走守卫判定与只读状态接口。
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.services import paid_outlet_guard as guard
from app.services.studio.llm_orchestration import dry_run
from app.services.studio.llm_orchestration.dry_run import CONFIRM_ENV, DRY_RUN_ENV

STATUS_URL = "/api/v1/studio/llm/orchestration/status"
LEGACY_LLM_URL = "/api/v1/script-processing/divide"


@pytest.fixture(autouse=True)
def _default_guard_state() -> None:
    """每个用例前后都回到「默认演练」，避免相互污染。"""
    dry_run.clear_audit_log()
    yield
    dry_run.clear_audit_log()


def _force_dry_run(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(DRY_RUN_ENV, raising=False)
    monkeypatch.delenv(CONFIRM_ENV, raising=False)


# --------------------------------------------------------------------------
# 1. 模式判定（默认值不得改变）
# --------------------------------------------------------------------------


def test_default_mode_is_dry_run(monkeypatch: pytest.MonkeyPatch) -> None:
    """未显式设置环境变量时：演练模式，且四个出口一个都不放行。"""
    _force_dry_run(monkeypatch)

    assert dry_run.mode() == dry_run.MODE_DRY_RUN
    assert dry_run.mode_label() == "演练模式"
    assert dry_run.is_real_mode() is False
    assert dry_run.is_dry_run_mode() is True
    assert dry_run.blocked_reason_code() == dry_run.BLOCKED_REASON_DRY_RUN
    assert dry_run.blocked_reason_text() and "不会产生费用" in dry_run.blocked_reason_text()
    assert dry_run.state()["mode"] == dry_run.MODE_DRY_RUN


def test_unparsable_or_partial_flags_stay_safe(monkeypatch: pytest.MonkeyPatch) -> None:
    """取值读不懂 → 按开启处理；只关一个开关也不放行（fail-safe）。"""
    monkeypatch.setenv(DRY_RUN_ENV, "maybe")
    monkeypatch.setenv(CONFIRM_ENV, "1")
    assert dry_run.mode() == dry_run.MODE_DRY_RUN

    monkeypatch.setenv(DRY_RUN_ENV, "0")
    monkeypatch.delenv(CONFIRM_ENV, raising=False)
    assert dry_run.is_real_mode() is False


def test_outlets_are_blocked_in_dry_run(monkeypatch: pytest.MonkeyPatch) -> None:
    """演练模式下 llm / image / video / oss 四个出口都不放行，且各带中文原因。"""
    _force_dry_run(monkeypatch)

    states = dry_run.outlet_states()
    assert [item["outlet"] for item in states] == list(dry_run.OUTLETS)
    for item in states:
        assert item["allowed"] is False
        assert item["reason"] == dry_run.BLOCKED_REASON_DRY_RUN
        assert item["reason_text"]
        assert item["label"]


# --------------------------------------------------------------------------
# 2. 真实模式：两个开关缺一不可
# --------------------------------------------------------------------------


def test_real_mode_unconfirmed_is_still_blocked(monkeypatch: pytest.MonkeyPatch) -> None:
    """关掉 DRY_RUN 但没确认 → 仍然是「不发真实请求」，且原因与演练模式不同。"""
    monkeypatch.setenv(DRY_RUN_ENV, "0")
    monkeypatch.delenv(CONFIRM_ENV, raising=False)

    assert dry_run.mode() == dry_run.MODE_REAL_UNCONFIRMED
    assert dry_run.mode_label() == "真实模式（未确认）"
    assert dry_run.is_real_mode() is False
    assert dry_run.blocked_reason_code() == dry_run.BLOCKED_REASON_NOT_CONFIRMED
    assert CONFIRM_ENV in dry_run.blocked_reason_text()
    assert all(item["allowed"] is False for item in dry_run.outlet_states())


def test_real_mode_when_both_switches_set(monkeypatch: pytest.MonkeyPatch) -> None:
    """两个开关都设对 → 真实模式；四个出口都放行（但依然受成本确认/限额/去重约束）。"""
    monkeypatch.setenv(DRY_RUN_ENV, "0")
    monkeypatch.setenv(CONFIRM_ENV, "1")

    assert dry_run.mode() == dry_run.MODE_REAL
    assert dry_run.mode_label() == "真实模式"
    assert dry_run.is_real_mode() is True
    assert dry_run.blocked_reason_code() is None
    assert dry_run.blocked_reason_text() is None
    states = dry_run.outlet_states()
    assert all(item["allowed"] is True for item in states)
    assert all(item["reason"] is None for item in states)
    assert "真实费用" in states[0]["reason_text"]


# --------------------------------------------------------------------------
# 3. 中文「怎么开 / 怎么关」（不用翻源码猜环境变量）
# --------------------------------------------------------------------------


def test_enable_steps_are_actionable(monkeypatch: pytest.MonkeyPatch) -> None:
    """开启步骤必须写清两个变量、必须重启、怎么验证、怎么关回去。"""
    _force_dry_run(monkeypatch)

    steps = dry_run.enable_steps()
    joined = "\n".join(steps)
    assert f"{DRY_RUN_ENV}=0" in joined
    assert f"{CONFIRM_ENV}=1" in joined
    assert "重启" in joined
    assert "status" in joined  # 验证当前模式的命令
    assert "演练" in joined  # 怎么关回去
    assert ".env" in joined  # 最常见的坑显式写出来
    assert 3 <= len(steps) <= 8

    assert f"{DRY_RUN_ENV}=0" in dry_run.how_to_enable_text()
    assert f"{CONFIRM_ENV}=1" in dry_run.how_to_enable_text()
    assert "重启" in dry_run.how_to_enable_text()

    restore = "\n".join(dry_run.restore_steps())
    assert "unset" in restore
    assert "dry_run" in restore


def test_mode_details_carries_everything_frontend_needs(monkeypatch: pytest.MonkeyPatch) -> None:
    """前端角标要的字段一次给全（模式、出口、开启步骤、恢复步骤、文档路径）。"""
    _force_dry_run(monkeypatch)

    details = dry_run.mode_details()
    for key in (
        "mode",
        "mode_label",
        "mode_description",
        "is_real_mode",
        "dry_run",
        "real_call_confirmed",
        "env",
        "confirm_env",
        "restart_required_on_change",
        "outlets",
        "enable_steps",
        "how_to_enable",
        "restore_steps",
        "how_to_restore",
        "doc",
    ):
        assert key in details, key
    assert details["restart_required_on_change"] is True
    assert details["outlets"][0]["outlet"] == dry_run.OUTLET_LLM


# --------------------------------------------------------------------------
# 4. 结构化拦截错误（区分两种原因）
# --------------------------------------------------------------------------


def _payload(exc: Exception) -> dict:
    return guard.blocked_payload(exc)


def test_blocked_payload_shape_keeps_backward_compatible_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    _force_dry_run(monkeypatch)
    payload = _payload(dry_run.DryRunBlocked("测试出口", outlet=dry_run.OUTLET_OSS))

    # 既有字段（老前端在用）一个都不能少
    assert payload["code"] == guard.BLOCKED_ERROR_CODE
    assert payload["outlet"] == dry_run.OUTLET_OSS
    assert payload["outlet_label"] == "对象存储上传"
    assert payload["hint"]
    assert payload["guard"]["dry_run"] is True
    # 新增：机器可读原因 + 中文怎么开
    assert payload["reason"] == dry_run.BLOCKED_REASON_DRY_RUN
    assert "演练" in payload["reason_text"]
    assert f"{DRY_RUN_ENV}=0" in payload["how_to_enable"]
    assert isinstance(payload["enable_steps"], list) and payload["enable_steps"]
    assert payload["mode"] == dry_run.MODE_DRY_RUN
    assert payload["mode_label"] == "演练模式"
    assert "api_key" not in str(payload)


def test_blocked_payload_distinguishes_the_two_reasons(monkeypatch: pytest.MonkeyPatch) -> None:
    """演练模式 vs 真实模式已开但没确认：code 相同、reason 必须不同。"""
    _force_dry_run(monkeypatch)
    dry_payload = _payload(dry_run.DryRunBlocked("x", outlet=dry_run.OUTLET_LLM))

    monkeypatch.setenv(DRY_RUN_ENV, "0")
    monkeypatch.delenv(CONFIRM_ENV, raising=False)
    unconfirmed_payload = _payload(dry_run.RealCallNotConfirmed("x", outlet=dry_run.OUTLET_LLM))

    assert dry_payload["code"] == unconfirmed_payload["code"] == guard.BLOCKED_ERROR_CODE
    assert dry_payload["reason"] == dry_run.BLOCKED_REASON_DRY_RUN
    assert unconfirmed_payload["reason"] == dry_run.BLOCKED_REASON_NOT_CONFIRMED
    assert dry_payload["reason_text"] != unconfirmed_payload["reason_text"]
    assert "缺少付费确认" in unconfirmed_payload["reason_text"]
    assert unconfirmed_payload["mode"] == dry_run.MODE_REAL_UNCONFIRMED


def test_blocked_http_error_keeps_legacy_contract(monkeypatch: pytest.MonkeyPatch) -> None:
    """服务层/老测试按 status_code + str(detail) 消费，这里必须保持。"""
    _force_dry_run(monkeypatch)
    exc = guard.blocked_http_error(dry_run.DryRunBlocked("测试出口", outlet=dry_run.OUTLET_IMAGE))

    assert isinstance(exc, HTTPException)
    assert exc.status_code == guard.BLOCKED_STATUS_CODE == 409
    assert isinstance(exc.detail, str)
    assert "[DRY_RUN]" in str(exc.detail)
    assert "已拦截「出图」出口" in str(exc.detail)
    # 结构化明细挂在异常上，供应用级处理器还原
    assert exc.payload["reason"] == dry_run.BLOCKED_REASON_DRY_RUN
    assert exc.how_to_enable
    assert exc.enable_steps


def test_require_outlet_raises_structured_exception(monkeypatch: pytest.MonkeyPatch) -> None:
    _force_dry_run(monkeypatch)

    with pytest.raises(guard.PaidOutletBlocked) as caught:
        guard.require_outlet("测试出口", outlet=guard.OUTLET_VIDEO)

    assert caught.value.status_code == 409
    assert caught.value.error_code == guard.BLOCKED_ERROR_CODE
    assert caught.value.reason == dry_run.BLOCKED_REASON_DRY_RUN


def test_legacy_route_returns_structured_409(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """legacy 路由（依赖式守卫）的 409 也必须带 code/reason/how_to_enable，且中文可照做。"""
    _force_dry_run(monkeypatch)

    response = client.post(LEGACY_LLM_URL, json={"script_text": "第一场：夜，外景。"})

    assert response.status_code == 409
    body = response.json()
    assert body["code"] == 409
    assert body["data"] is None
    assert "[DRY_RUN]" in body["message"]
    error = body["meta"]["error"]
    assert error["code"] == guard.BLOCKED_ERROR_CODE
    assert error["reason"] == dry_run.BLOCKED_REASON_DRY_RUN
    assert "不会发起真实请求" in error["reason_text"]
    assert f"{DRY_RUN_ENV}=0" in error["how_to_enable"]
    assert f"{CONFIRM_ENV}=1" in error["how_to_enable"]
    assert any("重启" in step for step in error["enable_steps"])
    assert error["guard"]["mode"] == dry_run.MODE_DRY_RUN


def test_legacy_route_reports_unconfirmed_reason(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """真实模式已开但没确认：409 的原因必须是「未确认」，不能报成演练模式。"""
    monkeypatch.setenv(DRY_RUN_ENV, "0")
    monkeypatch.delenv(CONFIRM_ENV, raising=False)

    error = client.post(LEGACY_LLM_URL, json={"script_text": "第一场：夜，外景。"}).json()["meta"]["error"]

    assert error["reason"] == dry_run.BLOCKED_REASON_NOT_CONFIRMED
    assert error["reason_text"].startswith("真实模式开关已开")
    assert f"{CONFIRM_ENV}=1" in error["how_to_enable"]


# --------------------------------------------------------------------------
# 5. 状态接口：前端渲染所需字段 + 向后兼容
# --------------------------------------------------------------------------


def test_status_route_exposes_mode_fields_and_keeps_old_ones(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _force_dry_run(monkeypatch)

    data = client.get(STATUS_URL).json()["data"]

    # 既有字段（老前端在用）保持
    assert data["guard"]["dry_run"] is True
    assert data["guard"]["real_call_confirmed"] is False
    assert data["guard_status_text"]
    assert data["paid_outlet_guards"]["task_kinds"]
    assert isinstance(data["dry_run_audit"], list)

    # 新增：模式 + 每出口放行 + 中文步骤
    assert data["mode"] == "dry_run"
    assert data["mode_label"] == "演练模式"
    assert data["is_real_mode"] is False
    assert data["restart_required_on_change"] is True
    assert [item["outlet"] for item in data["outlet_states"]] == ["llm", "image", "video", "oss"]
    assert all(item["allowed"] is False for item in data["outlet_states"])
    assert all(item["reason"] == "dry_run" for item in data["outlet_states"])
    assert data["enable_steps"] and f"{DRY_RUN_ENV}=0" in "\n".join(data["enable_steps"])
    assert f"{CONFIRM_ENV}=1" in data["how_to_enable"]
    assert data["restore_steps"] and "unset" in "\n".join(data["restore_steps"])
    assert data["mode_doc"].endswith("real-run-mode.md")
    assert data["real_run_mode"]["mode"] == "dry_run"


def test_status_route_reports_real_mode_without_calling_anything(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """两个开关都设对时接口如实报「真实模式」——本用例只读状态，不发起任何真实请求。"""
    monkeypatch.setenv(DRY_RUN_ENV, "0")
    monkeypatch.setenv(CONFIRM_ENV, "1")

    data = client.get(STATUS_URL).json()["data"]

    assert data["mode"] == "real"
    assert data["mode_label"] == "真实模式"
    assert data["is_real_mode"] is True
    assert all(item["allowed"] is True for item in data["outlet_states"])
    assert data["guard"]["real_call_confirmed"] is True
