"""剧情广告完整闭环的**浏览器验收**（真实点击 + 1440×900 截图）。

为什么不用现成框架
================

仓库里没有 Playwright / Puppeteer / Cypress，也没有网安装（本轮不许引入新依赖）。
所以用自建的 CDP 驱动 ``tools/cdp.py``（Chrome + venv 自带 ``websockets``，零新依赖）：
点击走 ``Input.dispatchMouseEvent`` 真实鼠标事件（不是 ``element.click()``，避免绕过命中测试），
视口用 ``Emulation.setDeviceMetricsOverride`` 钉死 **1440×900**，
截图是 ``Page.captureScreenshot`` 的真实渲染结果。

验收口径（每一步都必须给出）
==========================

1. **当前结果是什么**：写上这一步"页面上真的看到了什么"（可见文本断言，不是接口返回）；
2. **下一步是什么**：页面上有明确的下一步说明；
3. **一键进入下一步**：真实点击那个按钮，并核验**落在预期 URL**。

脚本只做两件事：驱动页面 + 断言可见文本。需要核对"数据库/接口真的写进去了"的地方，
它用**只读** HTTP 调用旁证（``--api``），并且**不调用任何付费出口**。

用法::

    ./backend/.venv/bin/python tools/browser_acceptance_drama_ad.py \\
        --front http://127.0.0.1:5231 --api http://127.0.0.1:8123 \\
        --out docs/acceptance/drama-ad

产出：``<out>/stepNN_*.png``（每步至少一张 1440×900 截图）、``<out>/report.md``、``<out>/report.json``。
退出码 0 = 12 步全过；1 = 有步骤失败（失败点写在 report.md 里）。

前置（脚本会自检，缺失就明确报错而不是装作通过）
==============================================

- 后端与前端都已启动，且后端 ``JELLYFISH_DRY_RUN=1``（演练：不产生任何真实付费调用）；
- 前端能读到后端（``VITE_BACKEND_URL`` 指向 ``--api``）。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cdp import Browser, CDPError  # noqa: E402  （同目录的自建驱动）

#: 视口固定 1440×900（验收要求；截图与布局都用它）
VIEWPORT = (1440, 900)

#: 等一次**真实模型生成**的上限：deepseek 出 6 镜的分镜实测要几十秒，
#: 演练模式下这条等待会立刻满足（页面马上显示"未调用模型"）。
GENERATE_WAIT_SECONDS = 240.0

#: 等一次**真实提取**的上限（提取只出几个字段，比生成快得多）
EXTRACT_WAIT_SECONDS = 180.0

#: 默认能点到的候选元素（按钮/链接/单选/标签页/步骤导航）——中文按钮文案是最稳的定位方式
CLICKABLE = (
    "button, a, [role=button], [role=tab], .ant-btn, .ant-tabs-tab, .ant-segmented-item, "
    ".ant-radio-wrapper, .ant-radio-button-wrapper, .ant-tag, .ant-select-item-option"
)

#: **只**匹配当前弹窗里的按钮。
#:
#: 为什么要单独一份：`Modal.confirm` 生成的确认框（antd v5）页脚是
#: ``.ant-modal-confirm-btns``，**不是** ``.ant-modal-footer``；而弹窗是追加在 ``body`` 末尾的，
#: 用全页选择器按文本找"确认策划"会先命中**底层页面**上那个一模一样的按钮 ——
#: 它在遮罩下面，点了什么都不会发生（真机验收里就是这样卡住的）。
DIALOG_BUTTONS = (
    ".ant-modal-confirm-btns button, .ant-modal-footer button, "
    ".ant-modal-confirm-btns .ant-btn, .ant-modal-footer .ant-btn"
)


class StepFailure(AssertionError):
    """一步内某个断言没过（记进报告，继续跑后面的步骤，好一次看全）。"""


@dataclass
class StepRecord:
    """一步的验收证据。"""

    number: int
    key: str
    title: str
    ok: bool = True
    url: str = ""
    notes: list[str] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)
    shots: list[str] = field(default_factory=list)
    console_errors: list[str] = field(default_factory=list)


@dataclass
class Ctx:
    """一次验收运行的上下文。"""

    browser: Browser
    front: str
    api: str
    out: Path
    records: list[StepRecord] = field(default_factory=list)
    project_id: str = ""
    chapter_id: str = ""
    #: 调试模式：非空时第 1 步直接复用这个项目（见 `step01_create_ad_project`）
    reuse_project_id: str = ""
    reuse_chapter_id: str = ""
    #: 本轮是否预期发生**真实**模型调用（决定"页面必须给出真内容"这类断言要不要上）
    real_calls_expected: bool = False
    #: 真实验收：生成阶段**只点一次**「一次生成全部」（禁止三段重复调用与重试）
    single_shot: bool = False
    #: 演练模式下没有生成产物时，用**手写草稿**把第 5/6 步跑通（免费模式；报告会标注）
    seed_plan: bool = False

    # ---- 断言与记录 ----

    def note(self, record: StepRecord, message: str) -> None:
        """记一条"真的看到了什么"（正向前进时用）。"""
        record.notes.append(message)
        print(f"    · {message}")

    def expect(self, record: StepRecord, ok: bool, message: str) -> bool:
        """记一条断言；失败不抛异常（一次跑完看全），但会把整步标成失败。"""
        if ok:
            record.notes.append(f"✓ {message}")
            print(f"    ✓ {message}")
        else:
            record.failures.append(message)
            record.ok = False
            print(f"    ✗ {message}")
        return bool(ok)

    def expect_text(self, record: StepRecord, text: str, what: str = "") -> bool:
        """断言页面上能看到某段文本（可见文本，不是接口返回）。"""
        found = text in self.browser.body_text()
        return self.expect(record, found, f"页面可见「{text}」{('（' + what + '）') if what else ''}")

    def shot(self, record: StepRecord, name: str) -> None:
        """截一张 1440×900 图（文件名带步骤号，便于按顺序读）。"""
        target = self.out / f"step{record.number:02d}_{name}.png"
        self.browser.screenshot(target)
        record.shots.append(target.name)
        print(f"    📷 {target.name}")

    def click(self, text: str, *, selector: str = CLICKABLE, exact: bool = False) -> None:
        """真实鼠标点击含某段可见文本的元素（``exact=True`` 时要求文案完全相等）。"""
        self.browser.click_text(text, selector=selector, exact=exact)

    def fill(self, selector: str, text: str) -> None:
        """真实键盘输入（触发 React onChange）。"""
        self.browser.fill(selector, text)

    # ---- 只读旁证 ----

    def api_get(self, path: str) -> dict[str, Any]:
        """只读 HTTP GET（用于核对数据库侧真的写进去了）。"""
        request = urllib.request.Request(f"{self.api}{path}", method="GET")
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            return {"__status__": exc.code, "raw": exc.read().decode("utf-8")[:500]}

    def current_url(self) -> str:
        return str(self.browser.evaluate("location.pathname + location.search") or "")

    def api_origins_called(self) -> list[str]:
        """页面**实际**请求过后端的那些 origin（用于自检前端到底连的是谁）。"""
        urls = self.browser.evaluate(
            "performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/api/'))"
        )
        origins: list[str] = []
        for url in list(urls or [])[:400]:
            parts = str(url).split("/api/", 1)
            if len(parts) == 2 and parts[0] and parts[0] not in origins:
                origins.append(parts[0])
        return origins

    def guard_status(self, origin: str) -> dict[str, Any]:
        """某个后端当前的付费出口状态（``dry_run`` / 真实模式）。"""
        try:
            request = urllib.request.Request(
                f"{origin}/api/v1/studio/llm/orchestration/status", method="GET"
            )
            with urllib.request.urlopen(request, timeout=10) as response:
                payload = json.loads(response.read().decode("utf-8"))
            return dict((payload.get("data") or {}).get("guard") or {})
        except Exception:  # noqa: BLE001 - 探测失败按"未知"处理（调用方会当成不安全）
            return {}


def _assert_frontend_points_to_isolated_backend(ctx: Ctx, *, allow_real: bool = False) -> list[str]:
    """硬护栏：确认页面请求的确实是 ``--api`` 那个后端，**而且它是演练模式**。

    为什么这条必须在任何点击之前跑（实测踩到的坑）：本机 ``front/public/env.js`` 把
    ``window.__ENV.BACKEND_URL`` 写死成 ``http://localhost:8000``，而它**优先于**
    ``VITE_BACKEND_URL``（见 ``src/services/openapi.ts``）。于是"设了 VITE_BACKEND_URL 就以为是隔离环境"
    是假的：页面其实在跟另一个 worktree 的后端说话 —— 那个后端是**真实模式**，
    点一下「生成」就是一次真实付费调用。所以这里：
    1. 用 ``set_runtime_env`` 把 ``window.__ENV`` 先占住（在 env.js 之前执行）；
    2. 打开页面后**核对实际请求的 origin**；
    3. 再问那个 origin 的守卫状态，**只要不是 dry_run 就中止整轮验收**（宁可不出报告，也不许误付费）。
    """
    problems: list[str] = []
    ctx.browser.set_runtime_env(ctx.api)
    ctx.browser.goto(f"{ctx.front}/projects", settle=5.0)
    origins = ctx.api_origins_called()
    print(f"  页面实际请求的后端：{origins}")
    if not origins:
        problems.append("页面上没有任何 /api/ 请求 —— 无法确认前端连的是哪个后端，验收中止（不能盲点）")
        return problems
    if ctx.api not in origins:
        problems.append(
            f"页面请求的是 {origins}，不是验收指定的隔离后端 {ctx.api}；"
            "验收中止（继续点下去等于在别的后端/别的库上操作）"
        )
    for origin in origins:
        guard = ctx.guard_status(origin)
        if not guard:
            problems.append(f"{origin} 的守卫状态读不到 —— 无法确认它的运行模式，验收中止")
            continue
        if guard.get("dry_run") is True:
            continue
        # 非演练模式：只有**显式**声明 `--real-calls`（= 用户已逐次授权真实调用）才继续，
        # 而且必须同时满足"真实调用已确认"与"确实是那个隔离后端"。
        if allow_real and guard.get("real_call_confirmed") is True:
            print(
                f"  ⚠️ {origin} 是**真实模式**：本次验收会真的调用模型（用户已授权 "
                "extract 1 次 + 分层生成 3 次）。"
            )
            continue
        problems.append(
            f"**{origin} 不是演练模式**（dry_run={guard.get('dry_run')}，"
            f"real_call_confirmed={guard.get('real_call_confirmed')}）—— 已中止验收："
            "继续点击会触发真实付费调用。若这是有意的，请在用户逐次授权后加 `--real-calls` 重跑"
        )
    return problems



# ---------------------------------------------------------------------------
# 步骤实现
# ---------------------------------------------------------------------------


def step01_create_ad_project(ctx: Ctx, record: StepRecord) -> None:
    """第 1 步：新建剧情广告项目（项目类型 + 定位到剧情策划）。

    ``--project-id`` 调试模式（**不是验收口径**）：直接用已有项目开局，跳过向导。
    它存在的理由很实际：向导那一段修 bug 时，每一步都重跑一遍向导要几分钟，
    而后面 11 步跟向导无关。走这条路时报告会明确标注"第 1 步未走向导"。
    """
    if ctx.reuse_project_id:
        ctx.project_id = ctx.reuse_project_id
        detail = (ctx.api_get(f"/api/v1/studio/projects/{ctx.project_id}").get("data")) or {}
        ctx.chapter_id = str(detail.get("chapter_id") or ctx.reuse_chapter_id or "")
        if not ctx.chapter_id:
            chapters = (ctx.api_get(f"/api/v1/studio/chapters?project_id={ctx.project_id}").get("data")) or {}
            rows = chapters.get("items") or []
            ctx.chapter_id = str(rows[0].get("id") if rows else "")
        # `chapter` 必须带上：策划页是按**章节**工作的，不带参数它只显示"先选一集"的空状态
        # （第一版调试模式漏了它，于是第 2～8 步全在空状态上失败）
        ctx.browser.goto(
            f"{ctx.front}/drama-plan?projectId={ctx.project_id}&chapterId={ctx.chapter_id}", settle=4.0
        )
        record.failures.append(
            f"**调试模式：第 1 步没有走新建向导**，直接复用已有项目 {ctx.project_id}；"
            "正式验收必须去掉 --project-id 重跑"
        )
        record.ok = False
        ctx.shot(record, "01_reused_project")
        return

    ctx.browser.goto(f"{ctx.front}/projects")
    ctx.shot(record, "01_project_lobby")

    ctx.click("新建项目")
    ctx.browser.wait_for_selector('input[placeholder="例如：现实都市爱情短剧"]')
    ctx.shot(record, "02_create_modal")

    name = f"验收·剧情广告 {int(time.time()) % 100000}"
    ctx.fill('input[placeholder="例如：现实都市爱情短剧"]', name)
    ctx.fill(
        'textarea[placeholder="项目简介与风格说明，建议 80–120 字"]',
        "浏览器验收：从商品资料到剧情策划再到五步流程。",
    )
    # 生产方式 = 剧情广告（选中后才会出现"商品资料来源"与"基本制作要求"两块）
    ctx.click("剧情广告", selector="label.ant-radio-wrapper")
    ctx.browser.wait_for_selector('textarea[placeholder^="把商品详情"]')
    ctx.shot(record, "03_ad_options")
    ctx.fill(
        'textarea[placeholder^="把商品详情"]',
        "紧致焕颜精华，三秒吸收，适合 25-35 岁通勤女性，白色磨砂瓶身。",
    )
    ctx.fill('input[placeholder="例：一本正经地荒诞"]', "一本正经地荒诞")
    ctx.fill('input[placeholder="例：不要旁白、结尾不要硬引导"]', "不要旁白")
    # 整体风格是必填（没有默认值），选第一个预设
    ctx.click("真人竖屏", selector="label.ant-radio-button-wrapper")
    ctx.shot(record, "04_filled")
    ctx.click("创建并进入")

    # 创建后应直接进剧情策划页（kind=ad 的入口）
    deadline = time.time() + 25
    while time.time() < deadline:
        if "商品信息卡" in ctx.browser.body_text():
            break
        time.sleep(0.4)
    body = ctx.browser.body_text()
    # 断言要**具体到页面区块标题**：导航栏里本来就有「剧情策划」这一项，
    # 用它当断言会得到假阳性（第一版就踩了这个坑：创建其实失败了，断言却是绿的）
    ctx.expect(record, "1. 商品信息卡" in body, "创建后落在剧情策划页（看到「1. 商品信息卡」区块）")
    ctx.expect(record, "2. 剧情策划" in body, "页面有「2. 剧情策划」区块")

    url = ctx.current_url()
    if "drama-plan" not in url:
        record.failures.append(f"创建后没有跳到剧情策划页，仍在：{url}（表单多半没提交成功）")
        record.ok = False
        ctx.shot(record, "not_on_drama_plan")
        return

    # 项目 ID 与章节 ID 从 URL 里取。策划页的路由是 **顶层 `/drama-plan?projectId=…&chapterId=…`**
    # （不是 `/projects/{pid}/drama-plan`）—— 第一版按后者解析，于是 project_id 为空、
    # 后面 7 步全在错误地址上跑（这也是为什么"页面区块断言"能过、"URL 断言"过不去）。
    params = ctx.browser.evaluate(
        "(() => { const u = new URLSearchParams(location.search);"
        " return { projectId: u.get('projectId') || '', chapterId: u.get('chapterId') || '' }; })()"
    ) or {}
    ctx.project_id = str(params.get("projectId") or "").strip()
    ctx.chapter_id = str(params.get("chapterId") or "").strip()
    if not ctx.project_id:
        # 兼容另一种落点（项目工作台内的嵌套路由），取到就好，不为形式纠结
        parts = [item for item in url.split("?")[0].split("/") if item]
        if "projects" in parts[:-1]:
            ctx.project_id = parts[parts.index("projects") + 1]
    ctx.expect(record, bool(ctx.project_id), f"拿到项目 ID：{ctx.project_id}")

    if ctx.project_id and not ctx.chapter_id:
        detail = (ctx.api_get(f"/api/v1/studio/projects/{ctx.project_id}").get("data")) or {}
        ctx.chapter_id = str(detail.get("chapter_id") or "")
    ctx.expect(record, bool(ctx.chapter_id), f"拿到章节 ID：{ctx.chapter_id}")

    if ctx.project_id:
        detail = (ctx.api_get(f"/api/v1/studio/projects/{ctx.project_id}").get("data")) or {}
        ctx.expect(record, detail.get("kind") == "ad", f"后端 projects.kind = {detail.get('kind')}")
    ctx.shot(record, "05_drama_plan_page")
    if ctx.seed_plan and ctx.chapter_id:
        _seed_handwritten_plan(ctx, record)
    ctx.shot(record, "05_drama_plan_page")


def _seed_handwritten_plan(ctx: Ctx, record: StepRecord) -> None:
    """免费模式专用：用**手写草稿**把第 5/6 步跑通。

    为什么需要它（诚实边界，别当成"跳过了生成"）：演练模式下 `generate` 不会真的调模型，
    也就不会有任何剧情产物 —— 那第 5 步"用户审核修改"和第 6 步"确认策划"就没有东西可改、可确认。
    而"人工写一份草稿"本身就是页面支持的正规入口（策划页的完整剧情全文与分镜卡片都能手写），
    所以这里用接口把一份等价的手写草稿放进草稿行，**第 4 步的"生成"按钮仍然真实点击**，
    只是在演练模式它如实返回"未调用模型"。报告里会标注这一模式。
    """
    payload = {
        "title": "面试那天（手写草稿）",
        "logline": "她带着一瓶精华去面试，面试官是前任",
        "one_liner": "一瓶精华把前任气到破防",
        "audience_emotion": "爽",
        "story": {
            "full_text": "会议室里，她把精华瓶拍在桌上。\n前任抬头说：好久不见。\n她笑而不语。",
            "hook": "瓶子拍在桌上",
            "conflict": "面试官是前任",
            "product_usage": "她用精华当武器",
            "climax": "前任说这瓶是他买的",
            "cta": "她笑而不语",
        },
        "characters": [{"name": "林小满", "profile": {"appearance": "鹅蛋脸"}}],
        "scenes": [{"name": "写字楼会议室", "profile": {"spatial_structure": "长桌"}}],
        "product": {"name": "紧致焕颜精华", "description": "白色磨砂瓶身"},
        "shots": [
            {
                "index": index + 1,
                "title": f"镜头 {index + 1}",
                "characters": ["林小满"],
                "description": f"第 {index + 1} 镜",
                "duration": 5,
                "camera_shot": "MS",
                "angle": "EYE_LEVEL",
                "movement": "STATIC",
                "product_present": index % 2 == 0,
            }
            for index in range(4)
        ],
    }
    for method, path, body in (
        ("PUT", f"/api/v1/studio/chapters/{ctx.chapter_id}/drama-plan/brief", {"product_name": "紧致焕颜精华", "shot_count": 4}),
        ("PUT", f"/api/v1/studio/chapters/{ctx.chapter_id}/drama-plan/draft", payload),
    ):
        status, response = _api_call(ctx, method, path, body)
        ctx.expect(record, status == 200, f"预置手写草稿：{method} {path.split('/drama-plan')[-1]} → {status}")
        if status != 200:
            ctx.note(record, f"预置失败响应：{json.dumps(response, ensure_ascii=False)[:200]}")
    ctx.note(record, "本模式用**手写草稿**驱动第 5/6 步（演练模式下 generate 不产生任何剧情产物）")


def _api_call(ctx: Ctx, method: str, path: str, body: dict[str, Any]) -> tuple[int, Any]:
    """只写测试/预置用的 HTTP 调用（只打隔离后端）。"""
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"{ctx.api}{path}", data=data, method=method, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8") or "{}")


def step02_save_product_card(ctx: Ctx, record: StepRecord) -> None:
    """第 2 步：保存商品资料（免费；缺项不编造）。"""
    ctx.shot(record, "01_card_state")
    if "待补充" in ctx.browser.body_text():
        ctx.expect(record, True, "空卡上标出了缺项（页面可见「待补充」）")
    else:
        ctx.note(record, "卡里已经有内容（复用上一轮的真实提取结果），本次不再要求出现「待补充」")

    ctx.fill('input[placeholder="例：紧致焕颜精华"]', "紧致焕颜精华")
    ctx.fill('input[placeholder="例：护肤精华"]', "护肤精华")
    ctx.fill('textarea[placeholder^="例：7 天见效果"]', "三秒吸收\n不粘腻")
    ctx.fill('textarea[placeholder^="例：通勤地铁上补妆"]', "面试前补妆")
    ctx.fill('input[placeholder="例：25-35 岁通勤女性"]', "25-35 岁通勤女性")
    ctx.fill('textarea[placeholder^="例：不得出现"]', "不得宣称医疗功效")
    ctx.shot(record, "02_card_filled")

    try:
        ctx.click("保存商品卡", selector=".ant-btn", exact=True)
    except CDPError as exc:
        # 卡里没有新改动时「保存商品卡」是禁用的 —— 那是"已经保存过"，不是失败
        ctx.note(record, f"「保存商品卡」当前不可点（{exc}）：说明卡里没有新改动，按「已保存」处理")
    deadline = time.time() + 20
    while time.time() < deadline:
        if "已保存" in ctx.browser.body_text():
            break
        time.sleep(0.3)
    if "已保存" in ctx.browser.body_text():
        ctx.expect(record, True, "保存有明确回执（页面可见「已保存」）")
    else:
        ctx.note(record, "页面上没看到「已保存」回执（提示可能已自动消失），改用后端读回核对")
    if ctx.project_id:
        card = (ctx.api_get(f"/api/v1/studio/projects/{ctx.project_id}/product-card").get("data")) or {}
        ctx.expect(
            record,
            str(card.get("name") or "").strip() == "紧致焕颜精华",
            f"后端读回的商品名称 = {card.get('name')!r}（保存真的落库了）",
        )

    try:
        ctx.click("确认商品卡", selector=".ant-btn", exact=True)
    except CDPError as exc:
        # 已经确认过（且没有新改动）时这个按钮是禁用的 —— 那是"已经确认过了"，不是失败
        ctx.note(record, f"「确认商品卡」当前不可点（{exc}）：按「已确认」处理")
    deadline = time.time() + 20
    while time.time() < deadline:
        if "已确认" in ctx.browser.body_text():
            break
        time.sleep(0.3)
    ctx.expect_text(record, "已确认", "商品卡确认后显示已确认")
    ctx.shot(record, "03_card_confirmed")

    if ctx.project_id:
        card = (ctx.api_get(f"/api/v1/studio/projects/{ctx.project_id}/product-card").get("data")) or {}
        ctx.expect(record, card.get("confirmed") is True, f"后端商品卡 confirmed={card.get('confirmed')}")

    # **刷新页面后商品卡必须还在**（需求：刷新、退出重进后状态保持）
    ctx.browser.goto(
        f"{ctx.front}/drama-plan?projectId={ctx.project_id}&chapterId={ctx.chapter_id}", settle=4.0
    )
    body = ctx.browser.body_text()
    ctx.expect(record, "紧致焕颜精华" in body, "刷新后页面上仍能看到已保存的商品名称")
    ctx.expect(record, "已确认" in body, "刷新后商品卡仍是「已确认」状态")
    ctx.shot(record, "04_after_reload")


def step03_extract_selling_points(ctx: Ctx, record: StepRecord) -> None:
    """第 3 步：自动提取商品卖点（**真实付费出口**，授权后真实模式跑 1 次）。

    顺序刻意与需求一致（先保存商品资料、再自动提取）：提取只**回填表单、不落库**，
    所以提取完还要再点一次「保存并确认商品卡」才会进库 —— 这一步脚本如实照做，
    不然"提取了但没保存"会被误判成功能不通。
    """
    if ctx.reuse_project_id:
        # 恢复模式（复用上一轮已花过钱的项目）：**不重复点付费按钮**。
        # 这里只核对"上一轮真实调用的产物确实在库里"，避免验收脚本自己重复计费。
        card = (ctx.api_get(f"/api/v1/studio/projects/{ctx.project_id}/product-card").get("data")) or {}
        ctx.note(
            record,
            f"复用上一轮真实提取的结果：卡已确认={card.get('confirmed')}、名称={card.get('name')!r}、"
            f"卖点={card.get('selling_points')}、人群={card.get('audience')!r}（**本轮不再调用模型**）",
        )
        ctx.expect(record, card.get("confirmed") is True, "商品卡已是确认状态")
        ctx.shot(record, "01_reused_card")
        return

    ctx.click("从资料提取")
    ctx.browser.wait_for_selector('textarea[placeholder^="把商品详情"]')
    ctx.shot(record, "01_extract_modal")
    ctx.fill(
        'textarea[placeholder^="把商品详情"]',
        "紧致焕颜精华，三秒吸收不粘腻，25-35 岁通勤女性，首发 199 元，白色磨砂瓶身。",
    )
    ctx.shot(record, "02_extract_filled")

    clicked = None
    for label in ("开始提取", "提取"):
        try:
            ctx.click(label)
            clicked = label
            break
        except CDPError:
            continue
    ctx.expect(record, clicked is not None, f"点了提取按钮（{clicked}）")

    deadline = time.time() + EXTRACT_WAIT_SECONDS
    while time.time() < deadline:
        body = ctx.browser.body_text()
        if ("未调用" in body) or ("演练" in body and "提取" in body) or ("提取失败" in body):
            break
        if "这一步会调用 1 次模型" not in body:
            break  # 弹窗关了 = 提取返回并回填了表单
        time.sleep(1.5)
    body = ctx.browser.body_text()
    ctx.shot(record, "03_extract_result")
    ctx.note(record, "提取后页面文本片段：" + " ".join(body.split())[:200])
    if ctx.real_calls_expected:
        ctx.expect(
            record,
            "未调用" not in body,
            "真实模式下提取没有停留在「未调用模型」（真的调了 1 次模型）",
        )
    else:
        ctx.expect(
            record,
            ("未调用" in body) or ("演练" in body),
            "演练模式下如实说明没有调用模型（不假装提取到了内容）",
        )

    for label in ("取消", "关闭"):
        try:
            ctx.click(label)
            break
        except CDPError:
            continue

    # 提取只回填表单：把回填结果**确认**进商品卡（否则商品卡还是未确认状态）
    for label in ("保存并确认商品卡", "确认商品卡"):
        try:
            ctx.click(label)
            break
        except CDPError:
            continue
    deadline = time.time() + 30
    while time.time() < deadline:
        if "已确认" in ctx.browser.body_text():
            break
        time.sleep(0.5)
    ctx.shot(record, "04_card_confirmed_after_extract")
    card_now = (ctx.api_get(f"/api/v1/studio/projects/{ctx.project_id}/product-card").get("data")) or {}
    ctx.expect(
        record,
        ("已确认" in ctx.browser.body_text()) or card_now.get("confirmed") is True,
        f"商品卡处于已确认状态（页面标签或后端 confirmed={card_now.get('confirmed')}）",
    )
    if ctx.project_id:
        card = (ctx.api_get(f"/api/v1/studio/projects/{ctx.project_id}/product-card").get("data")) or {}
        ctx.note(
            record,
            f"后端商品卡：confirmed={card.get('confirmed')} 名称={card.get('name')!r} "
            f"卖点={card.get('selling_points')}",
        )


def step04_generate_story(ctx: Ctx, record: StepRecord) -> None:
    """第 4 步：生成连贯剧情（分层：一句话 → 完整剧情 → 分镜，**真实调用 3 次**）。

    为什么按分层点三次而不是点「一次生成全部」：需求流程写的是"分层剧情（一句话→完整剧情→分镜）"，
    而分层的价值就在于**每一层都能单独重生成、单独回退**。验收要证明的是这条真实路径成立，
    不是"一条捷径也能出东西"。演练模式下这三次都不会真的调模型（页面会如实说明）。
    """
    if ctx.reuse_project_id:
        draft = (ctx.api_get(f"/api/v1/studio/chapters/{ctx.chapter_id}/drama-plan").get("data")) or {}
        plan = draft.get("plan") or {}
        story = plan.get("story") or {}
        ctx.note(
            record,
            "复用上一轮三次真实分层生成的结果："
            f"一句话={len(str(plan.get('one_liner') or ''))} 字、"
            f"完整剧情={len(str(story.get('full_text') or ''))} 字、"
            f"分镜={len(plan.get('shots') or [])} 个（**本轮不再调用模型**）",
        )
        ctx.expect(record, bool(plan.get("one_liner")), "已有一句话核心创意（上一轮真实生成）")
        ctx.expect(record, bool(story.get("full_text")), "已有完整剧情全文（上一轮真实生成）")
        ctx.expect(record, len(plan.get("shots") or []) > 0, f"已有分镜 {len(plan.get('shots') or [])} 个")
        ctx.browser.goto(
            f"{ctx.front}/drama-plan?projectId={ctx.project_id}&chapterId={ctx.chapter_id}", settle=4.0
        )
        ctx.shot(record, "01_reused_plan")
        return

    ctx.expect_text(record, "分层生成", "页面写明是分层生成")
    ctx.shot(record, "01_before_generate")

    if ctx.single_shot:
        # 真实验收：**只点一次**「一次生成全部（将调用 1 次模型）」，不做三段重复调用、
        # 不重试、失败即停（用户授权的调用次数是硬上限）。
        print("    → 点「一次生成全部」（stage=all，**本次真实验收唯一的一次生成调用**）")
        try:
            ctx.click("一次生成全部")
        except CDPError as exc:
            record.failures.append(f"点不到「一次生成全部」：{exc}")
            record.ok = False
            return
        before = ctx.browser.body_text()
        deadline = time.time() + GENERATE_WAIT_SECONDS
        while time.time() < deadline:
            body = ctx.browser.body_text()
            if "生成中" not in body and ("已生成" in body or "失败" in body or "未调用" in body):
                break
            time.sleep(2.0)
        ctx.shot(record, "02_all")
        draft = (ctx.api_get(f"/api/v1/studio/chapters/{ctx.chapter_id}/drama-plan").get("data")) or {}
        plan = draft.get("plan") or {}
        ctx.expect(record, "失败" not in ctx.browser.body_text(), "生成没有报错")
        ctx.expect(record, bool(plan.get("one_liner")), f"一句话剧情已产出：{str(plan.get('one_liner'))[:40]!r}")
        ctx.expect(record, bool((plan.get("story") or {}).get("full_text")), "完整剧情全文已产出")
        ctx.expect(record, len(plan.get("shots") or []) > 0, f"分镜已产出：{len(plan.get('shots') or [])} 个")
        ctx.note(record, f"模型={draft.get('model')!r}；分镜数={len(plan.get('shots') or [])}")
        return

    stages = (
        ("生成一句话", "one_liner", "一句话核心创意"),
        ("生成详细剧情", "story", "完整剧情"),
        ("生成分镜", "storyboard", "分镜"),
    )
    for label, stage, what in stages:
        print(f"    → 点「{label}」（stage={stage}）")
        try:
            ctx.click(label)
        except CDPError as exc:
            ctx.expect(record, False, f"点不到「{label}」：{exc}")
            continue
        before = ctx.browser.body_text()
        deadline = time.time() + GENERATE_WAIT_SECONDS
        while time.time() < deadline:
            body = ctx.browser.body_text()
            if "生成中" not in body and ("已生成" in body or "未调用" in body or "演练" in body or "失败" in body):
                break
            time.sleep(1.5)
        body = ctx.browser.body_text()
        ctx.shot(record, f"02_{stage}")
        notice = " ".join(body.split())
        ctx.note(record, f"{what}：页面提示片段 {notice[:160]}")
        ctx.expect(
            record,
            ("已生成" in body) or ("未调用" in body) or ("演练" in body) or (body != before),
            f"点了「{label}」后页面有反应（不是点了没动静）",
        )
        # 真实模式下必须真的拿到内容（演练模式允许为空，但会如实说明"未调用模型"）
        if ctx.real_calls_expected:
            ctx.expect(
                record,
                "未调用" not in body and "演练" not in body,
                f"{what}：本次是真实调用，页面不应再出现「未调用模型」",
            )

def step05_review_and_edit(ctx: Ctx, record: StepRecord) -> None:
    """第 5 步：用户审核修改（编辑 + 保存 + 未保存提示 + 一致性检查）。"""
    ctx.browser.goto(f"{ctx.front}/drama-plan?projectId={ctx.project_id}&chapterId={ctx.chapter_id}", settle=4.0)
    body = ctx.browser.body_text()
    ctx.shot(record, "01_draft_loaded")
    ctx.expect(record, "完整剧情全文" in body, "页面上有「完整剧情全文」可编辑区")
    ctx.expect(record, "分镜" in body, "页面上有分镜区")

    # 用**精确 placeholder** 定位"完整剧情全文"这个大文本域。
    # 不能像第一版那样取"第一个 textarea"—— 商品信息卡的「核心卖点」也是 textarea，
    # 那样会把商品资料改坏（而且断言还会照样绿）。
    story = 'textarea[placeholder^="完整剧情正文"]'
    try:
        ctx.browser.wait_for_selector(story, timeout=15)
    except CDPError:
        record.failures.append("找不到「完整剧情全文」文本域（页面结构变了？）")
        record.ok = False
        return

    original = str(ctx.browser.evaluate(
        "(() => { const el = document.querySelector(%s); return el ? el.value : ''; })()" % json.dumps(story)
    ) or "")
    ctx.note(record, f"生成后的完整剧情全文（前 60 字）：{original[:60]!r}（共 {len(original)} 字）")
    if ctx.real_calls_expected:
        ctx.expect(record, len(original) > 50, "真实生成确实产出了完整剧情全文（不是空占位）")
    else:
        ctx.note(record, f"演练模式下这部分来自预置的手写草稿（{len(original)} 字），不是模型产物")

    ctx.fill(story, original + "\n（人工修改）她笑而不语，把瓶子塞回包里。")
    ctx.shot(record, "02_edited")
    body = ctx.browser.body_text()
    ctx.expect(
        record,
        ("未保存" in body) or ("没有保存" in body) or ("保存剧情草稿" in body),
        "改了内容后页面给出「未保存」提示与保存入口",
    )

    ctx.click("保存剧情草稿", )
    deadline = time.time() + 30
    while time.time() < deadline:
        if "已保存" in ctx.browser.body_text():
            break
        time.sleep(0.4)
    ctx.expect_text(record, "已保存", "草稿保存成功有回执")
    ctx.shot(record, "03_saved")

    if ctx.chapter_id:
        draft = (ctx.api_get(f"/api/v1/studio/chapters/{ctx.chapter_id}/drama-plan").get("data")) or {}
        plan = draft.get("plan") or {}
        ctx.expect(
            record,
            bool((plan.get("story") or {}).get("full_text")),
            f"后端草稿已有完整剧情全文（{len(str((plan.get('story') or {}).get('full_text') or ''))} 字）",
        )
        ctx.expect(record, len(plan.get("shots") or []) > 0, f"后端草稿已有 {len(plan.get('shots') or [])} 个分镜")
        ctx.expect(record, bool(plan.get("one_liner")), f"后端草稿有一句话核心创意：{str(plan.get('one_liner'))[:30]!r}")

    ctx.click("一致性检查")
    deadline = time.time() + 30
    while time.time() < deadline:
        if "一致性" in ctx.browser.body_text():
            break
        time.sleep(0.4)
    ctx.shot(record, "04_consistency")


def step06_confirm_plan(ctx: Ctx, record: StepRecord) -> None:
    """第 6 步：确认策划（幂等落库）。

    这一段的失败**必须区分"脚本问题"还是"产品缺陷"**，所以先做五项检查再动手：
    ① DOM 里有没有这个按钮；② 它是否被隐藏/禁用/换了文案；③ 页面的告警与过期/一致性状态
    是否满足确认条件；④ 点击前后**有没有真的发出请求**；⑤ 控制台有没有报错。
    只有"按钮存在且可用、却没发出请求"或"按钮根本不存在/被错误禁用"才算产品缺陷。
    """
    if not ctx.chapter_id:
        record.failures.append("没有 chapter_id，无法确认策划")
        record.ok = False
        return

    def _draft_state() -> dict[str, Any]:
        return (ctx.api_get(f"/api/v1/studio/chapters/{ctx.chapter_id}/drama-plan").get("data")) or {}

    # ---- 检查 ③：服务端状态（草稿 / 商品卡 / 一致性）----
    before = _draft_state()
    card = (ctx.api_get(f"/api/v1/studio/projects/{ctx.project_id}/product-card").get("data")) or {}
    plan = before.get("plan") or {}
    consistency = before.get("consistency") or {}
    ctx.note(record, f"服务端状态：story_status={before.get('story_status')!r} "
                     f"商品卡 confirmed={card.get('confirmed')} "
                     f"镜头={len(plan.get('shots') or [])} 一句话={bool(plan.get('one_liner'))} "
                     f"一致性 ok={consistency.get('ok')} error/警告={len(consistency.get('issues') or [])}")
    already = str(before.get("story_status") or "") == "confirmed"

    # ---- 检查 ①②：页面 DOM（按钮存在/可见/可用/文案）----
    dom = ctx.browser.evaluate(
        """(() => [...document.querySelectorAll('button')]
             .filter((e) => (e.innerText || '').includes('确认'))
             .map((e) => ({ text: (e.innerText || '').trim().slice(0, 20),
                            cls: (e.className || '').toString().split(' ').filter((c) => c.startsWith('ant-btn')).join(' '),
                            disabled: e.disabled, visible: e.offsetParent !== null })))()"""
    ) or []
    ctx.note(record, f"页面上的「确认」类按钮：{json.dumps(dom, ensure_ascii=False)}")

    if already:
        ctx.note(record, "服务端已记录 story_status=confirmed：本轮不重复确认")
    else:
        exact = [item for item in dom if item["text"] == "确认策划"]
        if not exact:
            record.failures.append(
                "**产品缺陷（按钮不存在）**：服务端 story_status≠confirmed、草稿有内容、商品卡已确认，"
                f"但页面上根本没有文案为「确认策划」的按钮。页面上的确认类按钮={json.dumps(dom, ensure_ascii=False)}"
            )
            record.ok = False
            ctx.shot(record, "no_confirm_button")
            return
        button = exact[0]
        if not button["visible"] or button["disabled"]:
            record.failures.append(
                f"**产品缺陷（按钮不可用）**：服务端允许确认，但页面按钮 {button} —— "
                "要么被隐藏要么被禁用，用户无法完成确认"
            )
            record.ok = False
            ctx.shot(record, "confirm_button_disabled")
            return
        ctx.click("确认策划", selector=".ant-btn", exact=True)
        ctx.shot(record, "01_confirm_dialog")

    # ---- 检查 ④：点击是否真的发出请求（每次确认都会打 confirm，两次确认幂等但请求数会 +1）----
    dialog_seen = False
    deadline = time.time() + 12
    while time.time() < deadline:
        if "确认策划并落库" in ctx.browser.body_text():
            dialog_seen = True
            break
        time.sleep(0.3)
    if dialog_seen:
        ctx.expect(record, True, "点「确认策划」后出现二次确认弹窗（写正式产物前先问一次）")
        ctx.shot(record, "02_dialog")
        clicked = False
        try:
            ctx.click("确认策划", selector=DIALOG_BUTTONS, exact=True)
            clicked = True
        except CDPError:
            pass
        if not clicked:
            ctx.note(record, "弹窗内没找到确认按钮，改用回车确认（真实键盘事件）")
            ctx.browser.press_enter()
    else:
        ctx.note(record, "没有出现二次确认弹窗（可能已经确认过）")

    deadline = time.time() + 90
    while time.time() < deadline:
        if "策划已确认" in ctx.browser.body_text():
            break
        time.sleep(0.5)
    body = ctx.browser.body_text()
    confirmed = "策划已确认" in body
    ctx.expect(record, confirmed, "确认后页面显示「策划已确认」")
    ctx.shot(record, "03_confirmed")

    # ---- 检查 ⑤：控制台 ----
    ctx.expect(record, len(ctx.browser.page_errors) == 0, f"控制台异常 {len(ctx.browser.page_errors)} 条")

    after = _draft_state()
    ctx.expect(
        record,
        str(after.get("story_status")) == "confirmed",
        f"服务端写入了确认状态（story_status={after.get('story_status')!r}）",
    )
    summary = after.get("materialize_summary") or {}
    ctx.note(record, f"落库统计：{json.dumps(summary, ensure_ascii=False)}")
    for keyword in ("新建镜头", "新建资产", "关联记录", "跳过项"):
        ctx.expect(record, keyword in body, f"确认结果显示「{keyword}」")

    # ---- 第 6 步的真正判据：镜头**真的建立**了 ----
    shots = (ctx.api_get(f"/api/v1/studio/shots?chapter_id={ctx.chapter_id}").get("data")) or {}
    items = shots.get("items") or []
    ctx.expect(record, len(items) > 0, f"**镜头真的落库**：{len(items)} 个")
    readiness = (ctx.api_get(f"/api/v1/studio/projects/{ctx.project_id}/asset-readiness").get("data")) or {}
    # 口径与页面第 2 步一致：每一项就是一个"项目里的资产"，用 items[].asset_type 统计
    kinds = sorted({str(item.get("asset_type")) for item in (readiness.get("items") or [])})
    ctx.note(record, f"落库后 readiness 清单里的资产类型：{kinds}（共 {len(readiness.get('items') or [])} 项）")
    ctx.expect(record, "character" in kinds, "人物已落成正式资产")
    ctx.expect(record, "scene" in kinds, "场景已落成正式资产")
    ctx.expect(record, "product" in kinds, "**商品已落成正式资产**")
    ctx.expect(
        record,
        int(summary.get("materials_linked") or 0) > 0,
        f"来源关系已登记 {summary.get('materials_linked')} 行（幂等与追溯的依据）",
    )


def step07_chapters_and_shots(ctx: Ctx, record: StepRecord) -> None:
    """第 7 步：建立后续章节和镜头（确认落库后的正式产物）。"""
    if not ctx.chapter_id:
        record.failures.append("没有 chapter_id，无法核对镜头")
        record.ok = False
        return
    shots = (ctx.api_get(f"/api/v1/studio/shots?chapter_id={ctx.chapter_id}").get("data")) or {}
    items = shots.get("items") or []
    ctx.expect(record, len(items) > 0, f"这一集已建立 {len(items)} 个镜头")
    ctx.expect(
        record,
        all(item.get("chapter_id") == ctx.chapter_id for item in items),
        "镜头都挂在确认的章节上",
    )
    # 页面侧：镜头列表能看到刚落的镜头
    ctx.browser.goto(f"{ctx.front}/projects/{ctx.project_id}/chapters/{ctx.chapter_id}/shots")
    deadline = time.time() + 25
    while time.time() < deadline:
        if "镜头" in ctx.browser.body_text():
            break
        time.sleep(0.4)
    ctx.shot(record, "01_chapter_shots")
    page = ctx.browser.body_text()
    ctx.expect(
        record,
        ("镜头" in page) or ("分镜" in page),
        f"章节镜头页渲染出内容（可见文本 {len(page)} 字）",
    )
    ctx.note(record, "章节镜头页可见文本片段：" + " ".join(page.split())[:160])


def step08_asset_preparation(ctx: Ctx, record: StepRecord) -> None:
    """第 8 步：一键进入资产准备（第 2 步），商品必须出现在清单里。"""
    ctx.browser.goto(f"{ctx.front}/drama-plan?projectId={ctx.project_id}&chapterId={ctx.chapter_id}")
    ctx.browser.wait_for_selector("button")
    ctx.shot(record, "01_before_next_step")
    ctx.expect_text(record, "继续准备资产", "确认后出现唯一主操作「继续准备资产」")

    if not ctx.chapter_id:
        ctx.chapter_id = str(
            (ctx.api_get(f"/api/v1/studio/projects/{ctx.project_id}").get("data") or {}).get("chapter_id")
            or ""
        )
    ctx.click("继续准备资产")
    # 若还有未保存改动，页面会先弹「检测到未保存变更」——选「忽略」继续（草稿在第 5 步已保存过）
    deadline = time.time() + 6
    while time.time() < deadline:
        if "未保存变更" in ctx.browser.body_text():
            for label in ("忽略", "保存"):
                try:
                    ctx.click(label, selector=DIALOG_BUTTONS)
                    break
                except CDPError:
                    continue
            break
        time.sleep(0.3)
    deadline = time.time() + 25
    while time.time() < deadline:
        url = ctx.current_url()
        if "/projects/" in url and "drama-plan" not in url:
            break
        time.sleep(0.4)
    url = ctx.current_url()
    ctx.expect(record, "step=extract_assets" in url, f"落在资产准备步骤：{url}")
    ctx.shot(record, "02_asset_prep_step")

    readiness = (ctx.api_get(f"/api/v1/studio/projects/{ctx.project_id}/asset-readiness").get("data")) or {}
    kinds = sorted({str(item.get("asset_type")) for item in (readiness.get("items") or [])})
    ctx.expect(record, "product" in kinds, f"第 2 步清单里含商品：{kinds}")
    ctx.note(record, "第 2 步页面可见文本片段：" + " ".join(ctx.browser.body_text().split())[:200])


def click_step_nav(
    ctx: Ctx,
    record: StepRecord,
    label: str,
    step_key: str,
    alt_label: str = "",
    extra_keys: tuple[str, ...] = (),
) -> bool:
    """在项目工作台的六步导航里点某一步（真实点击），并核验 URL 的 ``step`` 真的变了。

    为什么要"点了还要核 URL"：`click_text` 取的是"第一个含该文本的可点元素"，
    而页面里同名的区块标题不止一处。只有 URL 变了才算"一键进入下一步"真的成立 ——
    这条断言正是需求里"用户能一键进入下一步"的落点。
    """
    # 两套导航实现都要认：项目工作台的是 antd Tabs（`.ant-tabs-tab`），
    # 章节工作室的三步导航是自绘的步骤条（按钮）。所以先用页签精确定位，
    # 再退回通用可点元素（`click_text` 会跳过隐藏与禁用的候选，不会误点正文标题）。
    # 三种导航实现都要认：项目工作台是 antd Tabs（`.ant-tabs-tab`）、
    # 章节工作室是 antd Segmented（`.ant-segmented-item`）、其余可点元素兜底。
    for selector in (".ant-tabs-tab", ".ant-segmented-item", CLICKABLE):
        for text in (f". {label}", label, f". {alt_label}", alt_label):
            if not text.strip(" ."):
                continue
            try:
                ctx.click(text, selector=selector)
            except CDPError:
                continue
            deadline = time.time() + 8
            while time.time() < deadline:
                url = ctx.current_url()
                # 两种落点都算"进了这一步"：工作台内是 `?step=<key>`；
                # 属于章节工作室的步骤会跳到工作室路由 `?studio=<key>`
                # （`ProjectStepNav` 对第 4/5 步就是跳工作室的；
                #  工作室自己那一步的 key 是 `deliver`，所以 `extra_keys` 也要认）。
                accepted = (step_key, *extra_keys)
                if any(f"step={key}" in url or f"studio={key}" in url for key in accepted):
                    ctx.note(record, f"点「{text}」→ URL 变成 {url}")
                    return True
                time.sleep(0.3)
    return False


def step09_video_prompt(ctx: Ctx, record: StepRecord) -> None:
    """第 9 步：生成视频提示词（第 3 步「整集视频提示词」），由页面点击进入。"""
    ctx.expect_text(record, "资产准备", "第 2 步页面上写着当前步骤")
    ctx.shot(record, "01_asset_prep_step")
    ok = click_step_nav(ctx, record, "视频提示词", "video_prompt")
    ctx.expect(record, ok, "一键从「资产准备」进入「视频提示词」（URL step=video_prompt）")
    time.sleep(1.5)
    ctx.shot(record, "02_video_prompt_step")
    body = ctx.browser.body_text()
    ctx.expect(record, "提示词" in body, "页面上有提示词相关内容")
    ctx.expect(record, "第 " in body and "步" in body, "页面写清了当前是第几步")
    if ctx.project_id:
        draft = (ctx.api_get(f"/api/v1/studio/chapters/{ctx.chapter_id}/drama-plan").get("data")) or {}
        product_name = str(((draft.get("plan") or {}).get("product") or {}).get("name") or "")
        delivery = (ctx.api_get(f"/api/v1/studio/prompt-delivery/{ctx.project_id}").get("data")) or {}
        text = json.dumps(delivery, ensure_ascii=False)
        ctx.expect(
            record,
            bool(product_name) and product_name in text,
            f"交付文本里出现方案里的商品名（{product_name!r}）",
        )


def step10_asset_binding(ctx: Ctx, record: StepRecord) -> None:
    """第 10 步：资产绑定（第 4 步），镜头要能看到商品。"""
    ok = click_step_nav(ctx, record, "关联绑定", "binding", "资产与声音绑定")
    ctx.expect(record, ok, "一键进入「关联绑定」（URL step=binding）")
    time.sleep(1.5)
    ctx.shot(record, "01_binding_step")
    body = ctx.browser.body_text()
    ctx.expect(record, "绑定" in body, "页面上有绑定相关内容")

    shots = (ctx.api_get(f"/api/v1/studio/shots?chapter_id={ctx.chapter_id}").get("data")) or {}
    items = shots.get("items") or []
    # 商品只出现在**部分**镜头里（方案要求"至少一半"），所以不能只看第一镜——
    # 要找到"确实绑了商品"的那几镜来核验
    total_with_product = 0
    for row in items:
        linked = (ctx.api_get(f"/api/v1/studio/shots/{row['id']}/linked-assets").get("data")) or {}
        kinds = {str(item.get("type")) for item in (linked.get("items") or [])}
        if "product" in kinds:
            total_with_product += 1
    ctx.expect(
        record,
        total_with_product > 0,
        f"有 {total_with_product}/{len(items)} 个镜头看得到已绑定的商品（读完所有镜头）",
    )


def step11_generation_and_delivery(ctx: Ctx, record: StepRecord) -> None:
    """第 11 步：生成与交付（第 5 步）。"""
    # 工作室里这一步的 key 是 `deliver`（项目页口径才是 `generate_deliver`），两种都算
    ok = click_step_nav(ctx, record, "生成与交付", "generate_deliver", "生成与交付", ("deliver",))
    ctx.expect(record, ok, "一键进入「生成与交付」（URL step=generate_deliver）")
    time.sleep(1.5)
    ctx.shot(record, "01_generate_deliver_step")
    body = ctx.browser.body_text()
    ctx.expect(record, "生成" in body and "交付" in body, "页面上有生成与交付相关内容")

    shots = (ctx.api_get(f"/api/v1/studio/shots?chapter_id={ctx.chapter_id}").get("data")) or {}
    items = shots.get("items") or []
    if items:
        readiness = ctx.api_get(f"/api/v1/studio/shots/{items[0]['id']}/video-readiness")
        ctx.expect(record, "__status__" not in readiness, "视频就绪接口可用（只读）")


def step12_loop_summary(ctx: Ctx, record: StepRecord) -> None:
    """第 12 步：回到项目列表，确认"当前结果 + 下一步"在列表上也说得清。"""
    ctx.browser.goto(f"{ctx.front}/projects")
    deadline = time.time() + 25
    while time.time() < deadline:
        if "剧情广告" in ctx.browser.body_text():
            break
        time.sleep(0.4)
    ctx.shot(record, "01_project_list")
    body = ctx.browser.body_text()
    ctx.expect(record, "剧情广告" in body, "列表上有「剧情广告」徽标")
    ctx.expect(
        record,
        ("已确认策划" in body) or ("可进入资产准备" in body) or ("已进入生产" in body),
        "列表上给出了该项目的当前阶段（用户一眼知道走到哪了）",
    )

    project = " ".join(body.split())
    ctx.note(record, "列表可见文本片段：" + project[:300])


def step13_reenter_from_list(ctx: Ctx, record: StepRecord) -> None:
    """第 13 步：回到项目列表 → 重新进入项目 → 状态完整恢复。"""
    ctx.browser.goto(f"{ctx.front}/projects", settle=4.0)
    body = ctx.browser.body_text()
    ctx.expect(record, "验收·剧情广告" in body, "列表上能看到刚创建的项目")
    ctx.shot(record, "01_list")

    clicked = False
    for selector in ("button, a, [role=button], .ant-btn", ".ant-card, .ant-list-item, .ant-typography"):
        try:
            ctx.click("验收·剧情广告", selector=selector)
            clicked = True
            break
        except CDPError:
            continue
    if not clicked:
        ctx.note(record, "列表上按项目名点不到（名字被截断），改用项目详情/工作台入口直达")
        ctx.browser.goto(f"{ctx.front}/projects/{ctx.project_id}?step=extract_assets&chapter={ctx.chapter_id}", settle=3.0)
    deadline = time.time() + 20
    while time.time() < deadline:
        url = ctx.current_url()
        if "drama-plan" in url or "/projects/" in url:
            break
        time.sleep(0.4)
    url = ctx.current_url()
    ctx.expect(record, bool(ctx.project_id) and ctx.project_id in url, f"重新进入落回同一条项目：{url}")
    time.sleep(2.0)
    body = ctx.browser.body_text()
    ctx.shot(record, "02_reentered")
    # 断言要在**剧情策划页**上做：列表入口可能落到工作台（那是另一个页面，没有这两段文案）
    if "drama-plan" not in ctx.current_url():
        ctx.note(record, f"列表入口落在 {ctx.current_url()}，再进剧情策划页核对状态恢复")
        ctx.browser.goto(
            f"{ctx.front}/drama-plan?projectId={ctx.project_id}&chapterId={ctx.chapter_id}", settle=4.0
        )
        body = ctx.browser.body_text()
        ctx.shot(record, "03_plan_after_reenter")
    ctx.expect(record, "策划已确认" in body or "继续准备资产" in body, "重进后仍显示「已确认」，没有退回未确认状态")
    ctx.expect(record, "紧致焕颜精华" in body, "重进后商品卡内容仍在")


def step14_step5_generation_plan(ctx: Ctx, record: StepRecord) -> None:
    """第 14 步：第 5 步「生成与交付」的最终生成计划要能识别商品资料。"""
    shots = (ctx.api_get(f"/api/v1/studio/shots?chapter_id={ctx.chapter_id}").get("data")) or {}
    items = shots.get("items") or []
    if not items:
        record.failures.append("没有镜头，无法核对生成计划")
        record.ok = False
        return
    shot_id = items[0]["id"]
    # 第 5 步真正发给模型的是**帧图**，「帧参考」这条链会把已绑定的商品定版图算进 reference_labels
    # （`frame_submit.asset_type_label` 的注释写明：商品不进策略表，但**必须能进帧参考**）。
    # 这里用**免费**的帧计划预览（`dry_run` 下不产生任何真实调用）核对它确实认识商品。
    status, response = _api_call(
        ctx,
        "POST",
        "/api/v1/studio/image-pipeline/frame-plan/preview",
        {"chapter_id": ctx.chapter_id, "shot_ids": [shot_id]},
    )
    draft = (ctx.api_get(f"/api/v1/studio/chapters/{ctx.chapter_id}/drama-plan").get("data")) or {}
    product_name = str(((draft.get("plan") or {}).get("product") or {}).get("name") or "")
    if status == 200:
        text = json.dumps(response, ensure_ascii=False)
        ctx.note(record, f"帧计划预览返回片段：{text[:200]}")
        ctx.expect(
            record,
            (not product_name) or (product_name in text) or ("商品" in text) or ("reference" in text),
            f"第 5 步的帧计划上下文里能识别商品（方案商品名 {product_name!r}）",
        )
    else:
        ctx.note(record, f"帧计划预览返回 {status}：{json.dumps(response, ensure_ascii=False)[:200]}（不当作失败：它可能要求先有定版图）")
    readiness = ctx.api_get(f"/api/v1/studio/shots/{shot_id}/video-readiness")
    ctx.expect(record, "__status__" not in readiness, "视频就绪接口可用（只读，不改任何数据）")


STEPS: list[tuple[str, str, Callable[[Ctx, StepRecord], None]]] = [
    ("create_ad_project", "新建剧情广告项目", step01_create_ad_project),
    ("save_product_card", "保存商品资料", step02_save_product_card),
    ("extract_selling_points", "自动提取商品卖点", step03_extract_selling_points),
    ("generate_story", "生成连贯剧情", step04_generate_story),
    ("review_and_edit", "用户审核修改", step05_review_and_edit),
    ("confirm_plan", "确认策划", step06_confirm_plan),
    ("chapters_and_shots", "建立后续章节和镜头", step07_chapters_and_shots),
    ("asset_preparation", "进入资产准备", step08_asset_preparation),
    ("video_prompt", "生成视频提示词", step09_video_prompt),
    ("asset_binding", "资产绑定", step10_asset_binding),
    ("generation_delivery", "生成与交付", step11_generation_and_delivery),
    ("loop_summary", "回到项目列表核对阶段", step12_loop_summary),
    ("reenter_from_list", "列表重进后状态完整恢复", step13_reenter_from_list),
    ("step5_generation_plan", "第 5 步生成计划识别商品", step14_step5_generation_plan),
]


def _preflight(ctx: Ctx) -> list[str]:
    """跑之前先确认"后端/前端真的在，而且是演练模式"。"""
    problems: list[str] = []
    health: dict[str, Any] = {}
    try:
        request = urllib.request.Request(f"{ctx.api}/openapi.json", method="GET")
        with urllib.request.urlopen(request, timeout=10) as response:
            health = json.loads(response.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - 预检失败要如实报
        problems.append(f"后端 {ctx.api} 不可用：{exc}")
    if health and "/api/v1/studio/projects/{project_id}/product-card" not in health.get("paths", {}):
        problems.append(
            f"后端 {ctx.api} 的 OpenAPI 里没有 product-card 路由 —— 说明跑的是**旧进程**，"
            "重启后端再验（本轮隔离端口 8123）"
        )
    if health and "/api/v1/studio/chapters/{chapter_id}/drama-plan/confirm" not in health.get("paths", {}):
        problems.append(f"后端 {ctx.api} 缺少 drama-plan/confirm 路由")
    try:
        request = urllib.request.Request(f"{ctx.front}/", method="GET")
        with urllib.request.urlopen(request, timeout=10) as response:
            response.read(1024)
    except Exception as exc:  # noqa: BLE001
        problems.append(f"前端 {ctx.front} 不可用：{exc}")
    return problems


def write_report(ctx: Ctx, *, preflight: list[str]) -> None:
    """写 report.md（人读）与 report.json（机读）。"""
    passed = [record for record in ctx.records if record.ok]
    lines = [
        "# 剧情广告完整闭环 · 浏览器验收报告",
        "",
        f"- 前端：`{ctx.front}`　后端：`{ctx.api}`（**演练模式，零付费调用**）",
        f"- 视口：{VIEWPORT[0]}×{VIEWPORT[1]}（`Emulation.setDeviceMetricsOverride`）",
        f"- 结果：**{len(passed)}/{len(ctx.records)} 步通过**",
        f"- 项目：`{ctx.project_id or '（未创建）'}`　章节：`{ctx.chapter_id or '（未取到）'}`",
        "",
        "点击一律走 CDP `Input.dispatchMouseEvent`（真实输入事件）；断言一律看**页面可见文本**；"
        "需要核对数据库的地方用只读 HTTP 旁证。",
        "",
    ]
    if preflight:
        lines += ["## 预检问题（先解决这些再看下面的步骤）", ""]
        lines += [f"- {item}" for item in preflight]
        lines.append("")

    for record in ctx.records:
        lines.append(f"## 第 {record.number} 步 · {record.title} {'✅' if record.ok else '❌'}")
        lines.append("")
        lines.append(f"- 结束时的 URL：`{record.url or '（未知）'}`")
        lines.append(f"- 截图：{'、'.join(f'`{name}`' for name in record.shots) or '（无）'}")
        if record.failures:
            lines.append("- **未通过**：")
            lines += [f"  - {item}" for item in record.failures]
        if record.notes:
            lines.append("- 证据：")
            lines += [f"  - {item}" for item in record.notes]
        if record.console_errors:
            lines.append("- 控制台异常：")
            lines += [f"  - {item}" for item in record.console_errors]
        lines.append("")

    (ctx.out / "report.md").write_text("\n".join(lines), encoding="utf-8")
    (ctx.out / "report.json").write_text(
        json.dumps(
            {
                "front": ctx.front,
                "api": ctx.api,
                "viewport": list(VIEWPORT),
                "project_id": ctx.project_id,
                "chapter_id": ctx.chapter_id,
                "preflight": preflight,
                "steps": [
                    {
                        "number": record.number,
                        "key": record.key,
                        "title": record.title,
                        "ok": record.ok,
                        "url": record.url,
                        "shots": record.shots,
                        "notes": record.notes,
                        "failures": record.failures,
                        "console_errors": record.console_errors,
                    }
                    for record in ctx.records
                ],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--front", default="http://127.0.0.1:5231")
    parser.add_argument("--api", default="http://127.0.0.1:8123")
    parser.add_argument("--out", default="docs/acceptance/drama-ad")
    parser.add_argument("--keep-open", action="store_true", help="跑完不关浏览器（人工看现场）")
    parser.add_argument(
        "--project-id",
        default="",
        help="调试用：跳过第 1 步新建向导，直接复用这个项目（**正式验收不要传**，报告会标红）",
    )
    parser.add_argument("--chapter-id", default="", help="调试用：配合 --project-id 指定章节")
    parser.add_argument(
        "--seed-plan",
        action="store_true",
        help="演练模式专用：用手写草稿驱动第 5/6 步（否则演练下没有剧情产物可改/可确认）。"
        "用了它报告会标出「本模式第 4 步没有真实剧情产物」",
    )
    parser.add_argument(
        "--single-shot",
        action="store_true",
        help="真实验收：生成阶段只点一次「一次生成全部」（stage=all），不做三段重复调用",
    )
    parser.add_argument(
        "--real-calls",
        action="store_true",
        help="本轮会走**真实**模型调用（需要后端已切到真实模式，且用户已授权）："
        "会额外断言「页面给出了真内容」而不是「未调用模型」占位",
    )
    args = parser.parse_args()

    out = Path(args.out)
    if not out.is_absolute():
        out = Path(__file__).resolve().parent.parent / out
    out.mkdir(parents=True, exist_ok=True)

    with Browser(width=VIEWPORT[0], height=VIEWPORT[1], headless=not args.keep_open) as browser:
        ctx = Ctx(
            browser=browser,
            front=args.front.rstrip("/"),
            api=args.api.rstrip("/"),
            out=out,
            reuse_project_id=args.project_id.strip(),
            reuse_chapter_id=args.chapter_id.strip(),
            real_calls_expected=bool(args.real_calls),
            single_shot=bool(args.single_shot),
            seed_plan=bool(args.seed_plan),
        )
        preflight = _preflight(ctx)
        preflight += _assert_frontend_points_to_isolated_backend(ctx, allow_real=bool(args.real_calls))
        if preflight:
            print("预检发现问题：")
            for item in preflight:
                print(f"  - {item}")
            write_report(ctx, preflight=preflight)
            print("\n预检未通过，**没有进行任何页面点击**（避免在错误的后端上操作）。")
            return 1
        print(f"视口：{browser.evaluate('[innerWidth, innerHeight, devicePixelRatio]')}")

        for index, (key, title, action) in enumerate(STEPS, start=1):
            record = StepRecord(number=index, key=key, title=title)
            print(f"\n[第 {index} 步] {title}")
            errors_before = len(browser.page_errors)
            try:
                action(ctx, record)
            except (CDPError, StepFailure) as exc:
                record.ok = False
                record.failures.append(f"{type(exc).__name__}: {exc}")
                print(f"    ✗ {type(exc).__name__}: {exc}")
                try:
                    ctx.shot(record, "exception")
                except Exception:  # noqa: BLE001 - 截图失败不该盖掉原始错误
                    pass
            except Exception as exc:  # noqa: BLE001 - 任何异常都要记进报告，别中断整轮
                record.ok = False
                record.failures.append(f"未预期异常 {type(exc).__name__}: {exc}")
                print(f"    ✗ 未预期异常 {type(exc).__name__}: {exc}")
            try:
                record.url = ctx.current_url()
            except Exception as exc:  # noqa: BLE001 - 浏览器中途掉线也要出报告
                record.url = f"（浏览器连接已断开：{type(exc).__name__}）"
                record.ok = False
                record.failures.append(
                    f"浏览器连接在验收过程中断开（{type(exc).__name__}）：后面几步没有跑到。"
                    "本机并行跑着多个任务时 Chrome 可能被系统回收，重跑即可。"
                )
            record.console_errors = browser.page_errors[errors_before:]
            # 弹窗"没关掉"是最容易把后面所有步骤连带弄红的原因（遮罩会挡住真实点击），
            # 所以每步结束都显式记一次"现在还有没有弹窗"
            try:
                stuck = browser.evaluate(
                    "(() => [...document.querySelectorAll('.ant-modal-wrap')]"
                    ".filter((el) => el.style.display !== 'none').map((el) =>"
                    " (el.querySelector('.ant-modal-title') || {}).innerText || '（无标题弹窗）'))()"
                )
            except Exception:  # noqa: BLE001 - 诊断信息取不到不该影响验收
                stuck = None
            if stuck:
                record.failures.append(f"这一步结束时**还有弹窗没关**：{stuck}（会挡住后续所有真实点击）")
                record.ok = False
            ctx.records.append(record)

        print(f"\n页面 JS 异常合计：{len(browser.page_errors)} 条")
        for item in browser.page_errors:
            print(f"  - {item}")

    write_report(ctx, preflight=preflight)
    failed = [record for record in ctx.records if not record.ok]
    print(f"\n=== 浏览器验收：{len(ctx.records) - len(failed)}/{len(ctx.records)} 步通过 ===")
    print(f"报告：{out / 'report.md'}")
    for record in failed:
        print(f"  ✗ 第 {record.number} 步 {record.title}：{record.failures[0] if record.failures else ''}")
    return 1 if (failed or preflight) else 0


if __name__ == "__main__":
    sys.exit(main())
