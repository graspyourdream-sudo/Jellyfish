#!/usr/bin/env python3
"""极简 CDP 浏览器驱动：真实点击 + 1440×900 截图（零新依赖）。

为什么自己写
============

这个仓库里**没有任何**浏览器自动化依赖（无 playwright / puppeteer / cypress，
历史那批 `/tmp/dsh_ui/*.py` 脚本已经不存在）。而验收明确要求"真实浏览器点击 + 1440×900 截图，
不能用直接调接口代替"。本机有 Chrome 153，venv 里恰好有 `websockets`（uvicorn 的传递依赖），
所以这里用 **Chrome DevTools Protocol + 标准库 + websockets** 自建驱动，不装任何东西。

两条刻意的做法
==============

1. **点击用真实输入事件**（`Input.dispatchMouseEvent`），不是 `element.click()` —— 后者会绕过
   命中测试与事件冒泡，点得到"看不见的元素"，验收证据会失真。先用
   `getBoundingClientRect` 算出元素中心，再派发 mousePressed / mouseReleased。
2. **截图走 CDP**（`Page.captureScreenshot`），视口固定 1440×900（`Emulation.setDeviceMetricsOverride`），
   这样"1440×900 截图"是浏览器真实渲染尺寸，而不是截完再缩放。

用法（脚本内 import）：
    from cdp import Browser
    with Browser(width=1440, height=900) as page:
        page.goto("http://127.0.0.1:5199/projects")
        page.click("button:has-text('新建项目')")
        page.screenshot("docs/acceptance/drama-ad/01_lobby.png")
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
DEFAULT_WIDTH = 1440
DEFAULT_HEIGHT = 900

#: 单条 CDP 命令的等待上限。
#:
#: 为什么要 90 秒（实测依据）：本机同时跑着多个后端测试与前端构建时，**负载可以到 25~35**，
#: 此时 Chrome 虽然已经把调试端口开出来了，但回一条 `Page.navigate` 可能要几十秒
#: （第一版用 30 秒，于是报的是"CDP 调用超时"，看起来像浏览器坏了，其实是机器被占满了）。
#: 把上限放宽只是"愿意等"，不改变任何浏览器行为与验收口径。
DEFAULT_CALL_TIMEOUT = 90.0


class CDPError(RuntimeError):
    """CDP 调用失败（含超时与浏览器侧异常）。"""


def _http_json(url: str, *, timeout: float = 10.0) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=timeout) as response:  # noqa: S310 - 只连本机调试端口
        return json.loads(response.read().decode("utf-8"))


def _wait_debug_port(port: int, *, timeout: float = 90.0) -> str:
    """等 Chrome 的调试端口起来，返回 webSocketDebuggerUrl（要那个"新建的空白标签页"）。

    ``timeout`` 给到 90 秒是有实测依据的：**首次**用一个全新的 ``--user-data-dir``
    启动 Chrome 153（headless）时，进程会先做一遍 profile 初始化，
    调试端口在 20 秒内**还没监听**（实测第一次跑就是被 20 秒超时挡掉的，
    而在同一台机器上用已有 profile 再启是秒起）。宁可等久一点，也不要"看起来像浏览器坏了"。
    """
    deadline = time.time() + timeout
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            targets = _http_json(f"http://127.0.0.1:{port}/json/list")
            for target in targets:
                if target.get("type") == "page" and target.get("webSocketDebuggerUrl"):
                    return str(target["webSocketDebuggerUrl"])
        except (urllib.error.URLError, OSError, ValueError) as exc:  # 端口还没监听
            last_error = exc
        time.sleep(0.25)
    raise CDPError(f"Chrome 调试端口没就绪（{port}）：{last_error}")


def free_debug_port() -> int:
    """挑一个空闲的本地端口给 CDP 用。

    为什么不让 9222 当唯一选择：上一轮异常退出时留下的 Chrome 会继续占着 9222，
    下一次运行就会连到**那个旧浏览器**（页面状态是别人的），这类"看不见的串台"
    比直接报端口占用更难查。所以默认每次先要一个空端口。
    """
    import socket

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])



class Browser:
    """一个 Chrome 页面（真实浏览器 + 真实输入事件）。"""

    def __init__(
        self,
        *,
        width: int = DEFAULT_WIDTH,
        height: int = DEFAULT_HEIGHT,
        headless: bool = True,
        debug_port: int | None = None,
        user_data_dir: str | None = None,
    ) -> None:
        self.width = width
        self.height = height
        # 默认每次挑空端口（见 `free_debug_port` 的解释）；显式传值时才复用固定端口。
        self.debug_port = debug_port if debug_port is not None else free_debug_port()
        self._user_data_dir = user_data_dir or tempfile.mkdtemp(prefix="drama-ad-chrome-")
        self._owns_profile = user_data_dir is None
        self._proc: subprocess.Popen[bytes] | None = None
        self._ws: Any = None
        self._msg_id = 0
        self._console: list[str] = []
        self._page_errors: list[str] = []
        #: 被自动确认掉的浏览器对话框（`beforeunload` 这类），报告里会列出来
        self._dialogs: list[str] = []
        self.headless = headless

    # ---- 生命周期 ----

    def __enter__(self) -> "Browser":
        self.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def start(self) -> None:
        args = [
            CHROME,
            f"--remote-debugging-port={self.debug_port}",
            f"--user-data-dir={self._user_data_dir}",
            f"--window-size={self.width},{self.height}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--disable-background-networking",
            "about:blank",
        ]
        if self.headless:
            args.insert(1, "--headless=new")
        if not Path(CHROME).exists():
            raise CDPError(f"找不到 Chrome：{CHROME}")
        # `start_new_session=True`：让 Chrome 自成进程组，关闭时按**进程组**杀，
        # 而不是只 terminate 主进程 —— Chrome 会派生一堆 Helper 子进程，
        # 只杀父进程会在反复跑验收时把机器内存耗光（实测跑到第 5 步就开始 CDP 超时，
        # 一次残留 29 个 Chrome 进程、空闲内存只剩 56MB）。
        self._proc = subprocess.Popen(
            args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True
        )

        try:
            ws_url = _wait_debug_port(self.debug_port)
        except CDPError:
            # 起不来就把半成品 Chrome 收掉：否则它会一直占着调试端口与 profile 目录，
            # 下一次运行可能连到"上一次那个浏览器"（页面状态是旧的，排查起来极其费时）。
            self.close()
            raise
        from websockets.sync.client import connect  # 本机 venv 自带（uvicorn 的传递依赖）

        self._ws = connect(ws_url, max_size=64 * 1024 * 1024, open_timeout=20)
        self._call("Page.enable")
        self._call("Runtime.enable")
        self._call("Log.enable")
        # 固定视口：截图与布局都按 1440×900（验收要求）
        self._call(
            "Emulation.setDeviceMetricsOverride",
            {"width": self.width, "height": self.height, "deviceScaleFactor": 1, "mobile": False},
        )

    def close(self) -> None:
        try:
            if self._ws is not None:
                self._ws.close()
        finally:
            self._ws = None
            if self._proc is not None:
                self._kill_process_group()
            if self._owns_profile:
                shutil.rmtree(self._user_data_dir, ignore_errors=True)

    def _kill_process_group(self) -> None:
        """把整个 Chrome 进程组收掉（父进程 + 所有 Helper）。

        先 SIGTERM 给一次正常退出的机会，再 SIGKILL 兜底；进程组已经没了就什么都不做。
        """
        assert self._proc is not None
        try:
            os.killpg(os.getpgid(self._proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            self._proc = None
            return
        try:
            self._proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(os.getpgid(self._proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        self._proc = None

    # ---- CDP 基础 ----

    def _call(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float = DEFAULT_CALL_TIMEOUT,
    ) -> dict[str, Any]:
        if self._ws is None:
            raise CDPError("浏览器没启动（先 with Browser(...)）")
        message_id = self._next_id()
        self._ws.send(json.dumps({"id": message_id, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise CDPError(f"CDP 调用超时：{method}")
            raw = self._ws.recv(timeout=remaining)
            payload = json.loads(raw)
            if payload.get("id") != message_id:
                self._collect_event(payload)
                continue
            if "error" in payload:
                raise CDPError(f"{method} 失败：{payload['error']}")
            return payload.get("result", {})

    def _collect_event(self, payload: dict[str, Any]) -> None:
        """收控制台与页面错误（验收要求"0 个 JS 错误"这类可核证据）。"""
        method = payload.get("method")
        params = payload.get("params") or {}
        if method == "Page.javascriptDialogOpening":
            # **必须立刻处理**：浏览器弹出 `beforeunload` 确认框时，CDP 的导航/执行调用会一直
            # 卡住等它（实测表现是"跑几分钟后每一步都 90 秒超时"）。页面上有未保存改动时
            # 点任何跳转都会弹这个框，真人会点"离开"，脚本也要做同样的事。
            self._dialogs.append(str(params.get("message") or "")[:120])
            self._dismiss_dialog()
            return
        if method == "Runtime.consoleAPICalled":
            args = [str(item.get("value", item.get("description", ""))) for item in params.get("args") or []]
            self._console.append(f"{params.get('type')}: {' '.join(args)}")
        elif method == "Runtime.exceptionThrown":
            detail = params.get("exceptionDetails") or {}
            self._page_errors.append(str(detail.get("text") or detail.get("exception", {}).get("description", "")))

    def _next_id(self) -> int:
        self._msg_id += 1
        return self._msg_id

    def _dismiss_dialog(self) -> None:
        """接受当前的 JS 对话框（发出去就走，不等回复：这里可能正处在别的调用的事件循环里）。"""
        if self._ws is None:
            return
        try:
            self._ws.send(
                json.dumps(
                    {"id": self._next_id(), "method": "Page.handleJavaScriptDialog", "params": {"accept": True}}
                )
            )
        except Exception:  # noqa: BLE001 - 处理不了也不该让整轮验收挂掉
            pass

    def _drain_events(self, *, seconds: float = 0.0) -> None:
        """把待处理的 CDP 事件读干净（可选等待若干秒）。"""
        if self._ws is None:
            return
        deadline = time.time() + seconds
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                return
            try:
                raw = self._ws.recv(timeout=remaining)
            except TimeoutError:
                return
            except Exception:  # noqa: BLE001 - 连接被关掉就结束
                return
            self._collect_event(json.loads(raw))

    # ---- 页面动作 ----

    def set_runtime_env(self, backend_url: str) -> None:
        """在页面脚本跑起来**之前**注入 ``window.__ENV``（把前端指到指定的后端）。

        为什么必须有这个口子（实测踩到的坑）：
        ``front/index.html`` 会先加载 ``public/env.js``，它写的是
        ``window.__ENV = window.__ENV || { BACKEND_URL: 'http://localhost:8000' }``，
        而 ``src/services/openapi.ts`` 取基址的顺序是
        ``window.__ENV.BACKEND_URL ?? import.meta.env.VITE_BACKEND_URL ?? 默认``
        —— **运行时值优先于 ``VITE_BACKEND_URL``**。所以在隔离端口（8123）上跑验收时，
        光设 ``VITE_BACKEND_URL`` 不管用：页面仍然会把请求发到 ``localhost:8000``
        （那是另一个 worktree 的后端，而且它是**真实模式**）。这里用一个
        "比 env.js 更早执行"的脚本把 ``window.__ENV`` 先占住，env.js 的 ``||`` 就不会覆盖它。

        ``Page.addScriptToEvaluateOnNewDocument`` 只影响**之后**的导航，所以要在 ``goto`` 之前调。
        """
        self._call(
            "Page.addScriptToEvaluateOnNewDocument",
            {"source": f"window.__ENV = {{ BACKEND_URL: {json.dumps(backend_url)} }};"},
        )

    def goto(self, url: str, *, settle: float = 1.5) -> None:
        self._call("Page.navigate", {"url": url})
        self.wait_for_ready(settle=settle)

    def wait_for_ready(self, *, settle: float = 1.5, timeout: float = 30.0) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            state = self.evaluate("document.readyState")
            if state == "complete":
                break
            time.sleep(0.2)
        self._drain_events(seconds=settle)

    def evaluate(self, expression: str) -> Any:
        result = self._call(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": True},
        )
        if result.get("exceptionDetails"):
            raise CDPError(f"页面 JS 抛错：{result['exceptionDetails'].get('text')}")
        return (result.get("result") or {}).get("value")

    def wait_for_selector(self, selector: str, *, timeout: float = 20.0) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.evaluate(f"!!document.querySelector({json.dumps(selector)})"):
                return
            time.sleep(0.2)
        raise CDPError(f"等不到元素：{selector}")

    def click(self, selector: str, *, timeout: float = 20.0) -> None:
        """真实鼠标点击（CDP 输入事件），先等元素出现并滚到可见。"""
        self.wait_for_selector(selector, timeout=timeout)
        rect = self.evaluate(
            "(() => { const el = document.querySelector(%s); if (!el) return null;"
            " el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect();"
            " return [r.left + r.width/2, r.top + r.height/2, r.width, r.height]; })()" % json.dumps(selector)
        )
        if not rect:
            raise CDPError(f"点不到（元素不存在）：{selector}")
        x, y, width, height = float(rect[0]), float(rect[1]), float(rect[2]), float(rect[3])
        if width <= 0 or height <= 0:
            raise CDPError(f"点不到（元素不可见）：{selector}")
        self._dispatch_click(x, y)

    def click_text(
        self,
        text: str,
        *,
        selector: str = "button, a, [role=button], .ant-btn",
        timeout: float = 20.0,
        exact: bool = False,
    ) -> None:
        """按**可见文本**点击（页面里按钮文案是中文时最稳的定位方式）。

        两条实测踩出来的规则：

        1. **必须筛"真的可见"**：antd 的 Tabs 会把未激活的面板留在 DOM 里，同一文案可能
           同时命中"隐藏的那一份"与"真正那一份"；只取第一个匹配就会点到隐藏元素 ——
           事件派发出去了、页面毫无反应，脚本只能报"点了没动静"。
           所以遍历所有匹配，取第一个 `offsetParent` 非空、未禁用、尺寸大于 0 的。
        2. **`exact=True` 要能选**：页面上的「重新确认策划」里也含"确认策划"，
           模糊匹配会点到错的按钮（实测就点错了，于是那一步整段被跳过）。
           需要点"那个按钮本身"时用精确匹配。
        """
        script = (
            "(() => { const els = [...document.querySelectorAll(%s)]; const want = %s;"
            " const matched = els.filter((el) => { const t = (el.innerText || el.textContent || '').trim();"
            " return %s ? t === want : t.includes(want); });"
            " const target = matched.find((el) => el.offsetParent !== null && !el.disabled);"
            " if (!target) return { seen: matched.length };"
            " target.scrollIntoView({block:'center'});"
            " const r = target.getBoundingClientRect();"
            " return { seen: matched.length, rect: [r.left + r.width/2, r.top + r.height/2, r.width, r.height] }; })()"
        ) % (json.dumps(selector), json.dumps(text), "true" if exact else "false")
        deadline = time.time() + timeout
        last_seen = 0
        while time.time() < deadline:
            hit = self.evaluate(script) or {}
            last_seen = int(hit.get("seen") or 0)
            rect = hit.get("rect")
            if rect and float(rect[2]) > 0 and float(rect[3]) > 0:
                self._dispatch_click(float(rect[0]), float(rect[1]))
                return
            time.sleep(0.25)
        raise CDPError(f"点不到含文本的元素：「{text}」（匹配到 {last_seen} 个，但没有一个可见且可点）")

    def _dispatch_click(self, x: float, y: float) -> None:
        """派发一对真实鼠标事件（按下 + 抬起）并等待页面响应。"""
        for event_type in ("mousePressed", "mouseReleased"):
            self._call(
                "Input.dispatchMouseEvent",
                {
                    "type": event_type,
                    "x": x,
                    "y": y,
                    "button": "left",
                    "clickCount": 1,
                    "buttons": 1 if event_type == "mousePressed" else 0,
                },
            )
        self._drain_events(seconds=0.6)


    def fill(self, selector: str, text: str) -> None:
        """真实键盘输入：先聚焦并**用 JS 选中全部**，再逐字输入（触发 React 的 onChange）。

        为什么选全用 JS 的 ``el.select()`` 而不是 Ctrl+A 键事件：``Input.dispatchKeyEvent``
        带上 ``modifiers`` 时，焦点/选中行为依赖浏览器对快捷键的处理，实测**不可靠** ——
        真机验收里出现过"没选上就直接输"，于是字段变成
        ``紧致焕颜精华紧致焕颜精华``（值被追加而不是替换），而断言照样能过。
        选中是"输入框状态"而不是"页面交互"，用 JS 定死它，点击与输入仍然走真实事件。
        """
        self.wait_for_selector(selector)
        self.click(selector)
        ok = self.evaluate(
            "(() => { const el = document.querySelector(%s); if (!el) return false;"
            " el.focus(); if (el.setSelectionRange) { el.setSelectionRange(0, (el.value || '').length); }"
            " else if (el.select) { el.select(); }"
            " return true; })()" % json.dumps(selector)
        )
        if not ok:
            raise CDPError(f"输入前选不中元素：{selector}")
        for char in text:
            self._call("Input.insertText", {"text": char})
        self._drain_events(seconds=0.3)

    def press_enter(self) -> None:
        """按一次回车（真实键盘事件）。

        用途：antd 的 ``Modal.confirm`` 默认把焦点放在确认按钮上，回车就是"确认"。
        这比按文本找按钮更稳 —— 弹窗里的按钮文本与页面上的按钮文本往往一模一样
        （`弹窗是追加在 body 末尾的，全页找文本会先命中被遮住的那个`）。
        """
        for event_type in ("keyDown", "keyUp"):
            self._call(
                "Input.dispatchKeyEvent",
                {
                    "type": event_type,
                    "key": "Enter",
                    "code": "Enter",
                    "windowsVirtualKeyCode": 13,
                    "nativeVirtualKeyCode": 13,
                },
            )
        self._drain_events(seconds=0.6)

    def text_of(self, selector: str) -> str:
        value = self.evaluate(
            "(() => { const el = document.querySelector(%s); return el ? (el.innerText || el.textContent || '') : ''; })()"
            % json.dumps(selector)
        )
        return str(value or "")

    def body_text(self) -> str:
        return str(self.evaluate("document.body ? document.body.innerText : ''") or "")

    def screenshot(self, path: str | Path) -> Path:
        """全视口截图（1440×900）。"""
        result = self._call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
        data = base64.b64decode(result["data"])
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return target

    # ---- 证据 ----

    @property
    def console_messages(self) -> list[str]:
        return list(self._console)

    @property
    def page_errors(self) -> list[str]:
        return list(self._page_errors)

    @property
    def dialogs(self) -> list[str]:
        """被自动确认的浏览器对话框（例如"离开页面会丢失未保存的修改"）。"""
        return list(self._dialogs)
