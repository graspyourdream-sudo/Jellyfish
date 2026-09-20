"""巨日禄抓取的**凭证传递口径**测试。

背景（真实踩过）：用户从浏览器复制的「完整 Cookie」**第一项就叫 `Authorization=<jwt>`**。
它是 Cookie 里的一项，只能整串放进 `Cookie:` 请求头，**不能**被拆出来当成 HTTP `Authorization:` 头。
上一轮真实验收因为把 jwt 同时填进了 Authorization 框（授权方式=自动 → 解析成 raw）而拿到上游 401。

这组用例把口径钉死：
1. 完整 Cookie 只出现在 `Cookie` 头里，且原样（分号、`Authorization=` 项都在）；
2. 授权方式 `none`（「不发送，仅 Cookie」）时不加 `Authorization` 头；
3. Authorization 框为空时**不读**任何配置兜底值（否则会凭空多一个头）；
4. 授权方式 `bearer` 时才加 `Authorization: Bearer …`；
5. 401 的错误结果里带脱敏诊断（阶段/状态/是否带 Cookie/是否带 Authorization/授权模式），不含凭证内容。
"""

from __future__ import annotations

import urllib.error
import urllib.request

from app.services.external import jurilu_agent_import as jurilu

COOKIE = "Authorization=abc.def.ghi; ph_phc_demo=1; other=2"
URL = "https://video.jurilu.com/project_management/project_page/snippets/material_list?projectId=163260&clipId=3277394"


class _Captured(Exception):
    """捕获请求头后中断真实网络调用。"""

    def __init__(self, request: urllib.request.Request) -> None:
        self.request = request
        super().__init__("captured")


def _capture(monkeypatch) -> list[urllib.request.Request]:
    seen: list[urllib.request.Request] = []

    def fake_urlopen(request, timeout=None):  # noqa: ANN001, ANN202
        seen.append(request)
        raise _Captured(request)

    monkeypatch.setattr(jurilu.urllib.request, "urlopen", fake_urlopen)
    return seen


def _headers(request: urllib.request.Request) -> dict[str, str]:
    return {str(k).lower(): str(v) for k, v in request.header_items()}


def test_full_cookie_only_goes_to_cookie_header(monkeypatch) -> None:
    """完整 Cookie（含 Authorization= 项）原样走 Cookie 头；授权方式 none 时不加 Authorization 头。"""
    seen = _capture(monkeypatch)
    # 与页面一致：先按授权方式解析（none = 不发送，仅 Cookie），再带 headers 抓取
    resolved, mode = jurilu.resolve_authorization("", "none")
    assert (resolved, mode) == ("", "none")
    result = jurilu.fetch_agent_platform_with_cookie(URL, COOKIE, authorization=resolved, referer=URL)
    assert result["ok"] is False  # 被捕获中断
    assert len(seen) == 1
    headers = _headers(seen[0])
    assert headers.get("cookie") == COOKIE, "整串 Cookie 必须原样放在 Cookie 头"
    assert "authorization" not in headers, "用户名没填 Authorization 框时不该出现 Authorization 头"
    assert "Authorization=" in headers["cookie"], "Cookie 里的 Authorization= 项必须原样保留"
    assert headers.get("referer") == URL


def test_authorization_box_is_ignored_when_mode_none(monkeypatch) -> None:
    """授权方式 = 不发送（仅 Cookie）：即使 Authorization 框里有值也不发头。"""
    seen = _capture(monkeypatch)
    resolved, mode = jurilu.resolve_authorization("abc.def", "none")
    assert (resolved, mode) == ("", "none")
    jurilu.fetch_agent_platform_with_cookie(URL, COOKIE, authorization=resolved)
    headers = _headers(seen[0])
    assert "authorization" not in headers
    assert headers["cookie"] == COOKIE


def test_mode_none_never_uses_configured_fallback(monkeypatch) -> None:
    """授权方式 = 不发送（仅 Cookie）：即使配置里有 Authorization 兜底值也不能发头。"""
    monkeypatch.setattr(jurilu, "get_configured_authorization", lambda: "configured.token.value")
    resolved, mode = jurilu.resolve_authorization("", "none")
    assert (resolved, mode) == ("", "none"), "mode=none 必须直接返回空，不读配置兜底"
    seen = _capture(monkeypatch)
    jurilu.fetch_agent_platform_with_cookie(URL, COOKIE, authorization=resolved)
    headers = _headers(seen[0])
    assert "authorization" not in headers
    assert headers["cookie"] == COOKIE


def test_bearer_mode_prefixes_authorization_header(monkeypatch) -> None:
    """只有显式选择 bearer 时才加 Authorization 头，并补 Bearer 前缀。"""
    seen = _capture(monkeypatch)
    resolved, mode = jurilu.resolve_authorization("abc.def", "bearer")
    assert mode == "bearer"
    jurilu.fetch_agent_platform_with_cookie(URL, COOKIE, authorization=resolved)
    headers = _headers(seen[0])
    assert headers.get("authorization") == "Bearer abc.def"
    assert headers["cookie"] == COOKIE


def test_cookie_like_authorization_value_is_rejected() -> None:
    """Authorization 框被粘进**整串 Cookie** 时：忽略该值，只走 Cookie 头（用户口径）。"""
    resolved, mode = jurilu.resolve_authorization("Authorization=abc.def; ph_phc_demo=1", "auto")
    assert (resolved, mode) == ("", "ignored_full_cookie")
    resolved2, mode2 = jurilu.resolve_authorization("a=1; b=2", "raw")
    assert (resolved2, mode2) == ("", "ignored_full_cookie")
    assert jurilu.looks_like_full_cookie("Authorization=abc") is True
    assert jurilu.looks_like_full_cookie("abc.def.ghi") is False


def test_unknown_auth_mode_does_not_silently_send_raw() -> None:
    """未知授权模式（含中文标签写错）不得静默按 auto 原样发送。"""
    resolved, mode = jurilu.resolve_authorization("abc.def", "仅Cookie")
    assert (resolved, mode) == ("", "none"), "中文「仅Cookie」应映射成 none"
    resolved2, mode2 = jurilu.resolve_authorization("abc.def", "whatever")
    assert resolved2 == "", "未知模式必须 fail-safe 成不发送"
    assert mode2.startswith("unknown:")


def test_401_diagnostics_are_redacted(monkeypatch) -> None:
    """401 结果带脱敏诊断：只有布尔与状态，不含 Cookie / Authorization 内容。"""

    def raise_401(request, timeout=None):  # noqa: ANN001, ANN202
        raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, None)

    monkeypatch.setattr(jurilu.urllib.request, "urlopen", raise_401)
    result = jurilu.fetch_agent_platform_with_cookie(URL, COOKIE, authorization="")
    assert result["ok"] is False
    assert result["status"] == 401
    assert result["error_type"] == "cookie 失效"
    assert result["has_cookie"] is True
    assert result["has_auth"] is False
    assert result["has_referer"] is False
    # 任何字段都不能回显凭证内容
    blob = repr(result)
    assert "abc.def.ghi" not in blob
    assert "ph_phc_demo" not in blob
