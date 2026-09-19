"""LLM 编排层的 DRY_RUN 守卫（轻量版）。

背景：
- Jellyfish 后端此前没有任何一处真实调用大模型；本模块引入的 LLM 调用是第一条
  会产生**真实费用**的出口，必须默认关闸。
- 参照中控台 ``web/api/services/dry_run.py`` 的思路，但只保留本项目需要的最小面：
  一个 llm 出口 + 一层 httpx 出站兜底。

两层防护（与中控台一致的设计意图）：
  A. 显式守卫：``assert_llm_outbound_allowed()`` 在真正发 HTTP 之前调用。
     DRY_RUN 开启 → 抛 ``DryRunBlocked``，一行网络请求都不会发出去。
  B. 出站兜底：``install_network_guard()`` 给 ``httpx`` 的 send 打补丁，
     把非本机出站全部掐断。防的是"后来新写的路径忘了调 A"。

放行条件（必须同时满足，缺一不可）：
  1. ``JELLYFISH_DRY_RUN`` 被**显式**设为假值（0/false/no/off）；
  2. ``JELLYFISH_REAL_LLM_CONFIRMED=1``，即用户明确确认过要真实付费。

未设置 ``JELLYFISH_DRY_RUN`` 时按**开启**处理（默认安全）。
"""

from __future__ import annotations

import os
import threading
from typing import Any

DRY_RUN_ENV = "JELLYFISH_DRY_RUN"
CONFIRM_ENV = "JELLYFISH_REAL_LLM_CONFIRMED"

_TRUTHY = {"1", "true", "yes", "on", "y", "enable", "enabled"}
_FALSEY = {"0", "false", "no", "off", "n", "disable", "disabled"}

# LLM 结果只用于预览，绝不落库；这里显式声明出口清单，便于以后扩展时对账。
LLM_OUTLET = "llm"

_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "0.0.0.0", "testserver"}

# 付费/有外部副作用的出口清单（P1 只用 llm；P3 补齐 image / video / oss）。
OUTLET_LLM = "llm"
OUTLET_IMAGE = "image"
OUTLET_VIDEO = "video"
OUTLET_OSS = "oss"
OUTLETS: tuple[str, ...] = (OUTLET_LLM, OUTLET_IMAGE, OUTLET_VIDEO, OUTLET_OSS)

# DRY_RUN 占位产物：用不可达的 .invalid 域名，绝不做真实请求。
FAKE_IMAGE_BASE_URL = "https://dry-run.invalid/assets"
FAKE_OSS_BASE_URL = "https://dry-run.invalid/oss"
FAKE_VIDEO_URL = "https://dry-run.invalid/videos/dry_run.mp4"

_OUTLET_LABELS: dict[str, str] = {
    OUTLET_LLM: "大模型",
    OUTLET_IMAGE: "出图",
    OUTLET_VIDEO: "出视频",
    OUTLET_OSS: "对象存储上传",
}


def outlet_label(outlet: str) -> str:
    """出口的中文名，用于给用户看的提示语。"""
    return _OUTLET_LABELS.get(outlet, outlet)


class DryRunBlocked(RuntimeError):
    """DRY_RUN 拦截到付费出口。"""

    def __init__(self, detail: str = "", outlet: str = OUTLET_LLM) -> None:
        label = _OUTLET_LABELS.get(outlet, outlet)
        message = f"[DRY_RUN] 已拦截「{label}」出口，未发起任何真实请求"
        if detail:
            message += f"：{detail}"
        message += f"。要放开请显式设置 {DRY_RUN_ENV}=0 且 {CONFIRM_ENV}=1。"
        self.detail = detail
        self.outlet = outlet
        super().__init__(message)


class RealCallNotConfirmed(RuntimeError):
    """DRY_RUN 已被关闭，但没有拿到用户确认，仍然拒绝真实调用。"""

    def __init__(self, detail: str = "", outlet: str = OUTLET_LLM) -> None:
        label = _OUTLET_LABELS.get(outlet, outlet)
        message = (
            f"已关闭 {DRY_RUN_ENV} 但缺少用户确认：真实「{label}」调用会产生费用，"
            f"请显式设置 {CONFIRM_ENV}=1 后再试"
        )
        if detail:
            message += f"（{detail}）"
        self.detail = detail
        self.outlet = outlet
        super().__init__(message)


# --------------------------------------------------------------------------
# 开关
# --------------------------------------------------------------------------


def _read_flag(name: str) -> str:
    return (os.environ.get(name) or "").strip().lower()


def dry_run_enabled() -> bool:
    """DRY_RUN 是否开启。默认开启；每次实时读环境变量，方便测试中途切换。"""
    raw = _read_flag(DRY_RUN_ENV)
    if not raw:
        return True
    if raw in _FALSEY:
        return False
    if raw in _TRUTHY:
        return True
    # 无法识别的取值一律按"开启"处理（fail-safe）。
    return True


def real_call_confirmed() -> bool:
    """用户是否明确确认过可以真实调用（默认否）。"""
    return _read_flag(CONFIRM_ENV) in _TRUTHY


def allow_real_llm_call() -> bool:
    """真实调用是否被允许：必须显式关闸 + 明确确认。"""
    return (not dry_run_enabled()) and real_call_confirmed()


# 出口无关的通用别名（P3 的 image / video / oss 出口复用同一套闸门）。
allow_real_call = allow_real_llm_call


def blocked_reason(detail: str = "") -> str | None:
    """返回被拦截的原因描述；允许真实调用时返回 None。"""
    if dry_run_enabled():
        raw = os.environ.get(DRY_RUN_ENV, "未设置/默认开启")
        return f"DRY_RUN 开启（{DRY_RUN_ENV}={raw}）：{detail}".strip("：")
    if not real_call_confirmed():
        return f"未确认真实调用（需要 {CONFIRM_ENV}=1）：{detail}".strip("：")
    return None


def assert_outbound_allowed(detail: str = "", *, outlet: str = OUTLET_LLM) -> None:
    """真实发 HTTP / 上传对象存储前的最后一道检查。"""
    if dry_run_enabled():
        _record("blocked", detail, target=outlet)
        raise DryRunBlocked(detail, outlet=outlet)
    if not real_call_confirmed():
        _record("blocked_unconfirmed", detail, target=outlet)
        raise RealCallNotConfirmed(detail, outlet=outlet)
    _record("allowed_real", detail, target=outlet)


def assert_llm_outbound_allowed(detail: str = "") -> None:
    """llm 出口的守卫（P1 兼容入口）。"""
    assert_outbound_allowed(detail, outlet=OUTLET_LLM)


def fake_task_id(prefix: str, seed: str = "") -> str:
    """DRY_RUN 占位 task_id：可复现，方便前端轮询链路测试。"""
    suffix = "".join(ch for ch in (seed or "000000")[:8] if ch.isalnum()) or "000000"
    return f"dryrun_{prefix}_{suffix}"


def fake_image_url(asset_id: str, index: int = 1) -> str:
    """DRY_RUN 占位图片地址（不可达域名，仅作占位）。"""
    return f"{FAKE_IMAGE_BASE_URL}/{asset_id or 'asset'}_{index}.png"


def fake_oss_url(object_key: str) -> str:
    """DRY_RUN 占位 OSS 地址。"""
    return f"{FAKE_OSS_BASE_URL}/{str(object_key or '').lstrip('/')}"


# --------------------------------------------------------------------------
# 审计（供测试与排查使用）
# --------------------------------------------------------------------------

_audit_lock = threading.Lock()
_audit_log: list[dict[str, Any]] = []


def _record(action: str, detail: str = "", target: str = "") -> None:
    with _audit_lock:
        _audit_log.append({"action": action, "detail": detail, "target": target})
        if len(_audit_log) > 200:
            del _audit_log[:-200]


def audit_log() -> list[dict[str, Any]]:
    """返回被记录过的事件快照（拦截 / 放行 / 兜底触发）。"""
    with _audit_lock:
        return list(_audit_log)


def clear_audit_log() -> None:
    with _audit_lock:
        _audit_log.clear()


def state() -> dict[str, Any]:
    """守卫状态快照，便于健康检查与排查。"""
    return {
        "dry_run": dry_run_enabled(),
        "real_call_confirmed": real_call_confirmed(),
        "env": DRY_RUN_ENV,
        "confirm_env": CONFIRM_ENV,
        "network_guard": network_guard_installed(),
        "outlets": list(OUTLETS),
        "blocked_count": len([x for x in audit_log() if x["action"].startswith("blocked")]),
    }


# --------------------------------------------------------------------------
# httpx 出站兜底
# --------------------------------------------------------------------------

_guard_lock = threading.Lock()
_guard_state: dict[str, Any] = {"installed": False, "patched": {}}


def network_guard_installed() -> bool:
    return bool(_guard_state["installed"])


def extra_allowed_hosts() -> set[str]:
    """额外白名单：``JELLYFISH_DRY_RUN_ALLOW_HOSTS``，逗号分隔。"""
    raw = os.environ.get("JELLYFISH_DRY_RUN_ALLOW_HOSTS") or ""
    extra = {item.strip().lower() for item in raw.split(",") if item.strip()}
    return _LOOPBACK_HOSTS | extra


def _check_host(host: str, detail: str = "", outlet: str = OUTLET_LLM) -> None:
    if not dry_run_enabled():
        return
    normalized = (host or "").strip().strip("[]").lower()
    if not normalized or normalized in extra_allowed_hosts():
        return
    _record("blocked_network", detail or f"host={normalized}", target=normalized)
    raise DryRunBlocked(f"尝试访问外部主机 {normalized}（DRY_RUN 下禁止出站）", outlet=outlet)


def install_network_guard() -> bool:
    """给 httpx 打补丁，DRY_RUN 下掐断非本机出站。幂等。"""
    with _guard_lock:
        if _guard_state["installed"]:
            return False

        import httpx  # 主依赖已有

        patched: dict[str, Any] = {}

        original_client_send = httpx.Client.send

        def guarded_client_send(self, request, *args, **kwargs):  # type: ignore[no-untyped-def]
            url = getattr(request, "url", "")
            _check_host(getattr(getattr(request, "url", None), "host", ""), f"httpx.Client.send {url}")
            return original_client_send(self, request, *args, **kwargs)

        httpx.Client.send = guarded_client_send  # type: ignore[assignment]
        patched["httpx.Client.send"] = original_client_send

        original_async_send = httpx.AsyncClient.send

        async def guarded_async_send(self, request, *args, **kwargs):  # type: ignore[no-untyped-def]
            url = getattr(request, "url", "")
            _check_host(getattr(getattr(request, "url", None), "host", ""), f"httpx.AsyncClient.send {url}")
            return await original_async_send(self, request, *args, **kwargs)

        httpx.AsyncClient.send = guarded_async_send  # type: ignore[assignment]
        patched["httpx.AsyncClient.send"] = original_async_send

        _guard_state["patched"] = patched
        _guard_state["installed"] = True
        _record("guard_installed", "httpx")
        return True


def uninstall_network_guard() -> bool:
    """卸载出站兜底（测试用）。"""
    with _guard_lock:
        if not _guard_state["installed"]:
            return False
        import httpx

        patched = dict(_guard_state["patched"])
        if "httpx.Client.send" in patched:
            httpx.Client.send = patched["httpx.Client.send"]  # type: ignore[assignment]
        if "httpx.AsyncClient.send" in patched:
            httpx.AsyncClient.send = patched["httpx.AsyncClient.send"]  # type: ignore[assignment]
        _guard_state["patched"] = {}
        _guard_state["installed"] = False
        return True


def short_status() -> str:
    if dry_run_enabled():
        return f"DRY_RUN=开（{DRY_RUN_ENV}，未发起真实调用）"
    if not real_call_confirmed():
        return f"DRY_RUN=关但未确认（{CONFIRM_ENV} 未设置，仍会拒绝真实调用）"
    return "DRY_RUN=关且已确认（真实付费链路）"
