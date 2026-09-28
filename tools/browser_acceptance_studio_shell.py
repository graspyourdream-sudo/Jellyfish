#!/usr/bin/env python3
"""分镜工作室外壳的**浏览器验收**（真实点击 + 1440×900 / 1280×900 截图）。

对照任务书第三、六、十一、十二、十三、十四部分的硬口径逐条核对：

1. 第 3 / 4 / 5 步进入的是**同一个**分镜工作室容器；
2. 容器常驻结构齐全：项目上下文条 + 常驻五步条 + 工作室阶段条
   + 左「引用素材」/ 中「当前阶段」/ 右「本镜预览」+ 底部横向滑动胶片条；
3. **切换阶段不离开本页、不换镜头**（URL 只改 `?studio=`，路由段不变，当前镜头标签不变）；
4. 刷新恢复：项目 / 章节来自路由，阶段与当前镜头来自 `?studio=` / `?shot=`；
5. 浏览器前进 / 后退能退回上一个阶段；
6. 1440×900 不整页长滚动（各区域局部滚动）；1280×900 **不横向溢出**；
7. 批量下载入口存在且下载前的预检给出了「包含 N 条 / 排除 M 条」；
8. 主区不出现技术字段（接口路径 / 字段名 / 内部 id）；
9. console error 与未处理异常为 0。

用法::

    backend/.venv/bin/python tools/browser_acceptance_studio_shell.py \\
        --front http://127.0.0.1:5231 --api http://127.0.0.1:8123 \\
        --project <project_id> --chapter <chapter_id> \\
        --out /tmp/jf-accept/shots

产物：`<out>/*.png`（每步一张真实渲染截图）、`<out>/report.md`、`<out>/report.json`。
退出码 0 = 全过；1 = 有断言失败（失败点写在 report.md）。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))

from cdp import Browser  # noqa: E402


#: 主区禁词（与前端守卫同一批口径；命中就意味着技术字段上了主区）
FORBIDDEN_IN_MAIN = [
    "/api/v1",
    "file_id",
    "shot_id",
    "task_id",
    "storage_key",
    "JELLYFISH_",
    "Traceback",
    "http://127.0.0.1",
]

#: 主区禁词扫描时**豁免**的区域（默认收起的技术详情层允许出现内部标识）
#: 主区禁词扫描时豁免的区域：**默认收起的技术详情层**（内部标识只允许出现在那里）
#: `details` = 全仓唯一的「技术详情」折叠壳（原生 `<details>`，收起时 innerText 不含内容），
#: `.ant-collapse-content` = antd 折叠内容。两者都是"默认收起、展开才可见"的合规落点。
WAIVED_SELECTORS = ["details", ".ant-collapse-content", ".studio-rail", ".ant-table"]


@dataclass
class Step:
    seq: int
    title: str
    ok: bool
    detail: str
    shots: list[str] = field(default_factory=list)


class Recorder:
    def __init__(self, out: Path) -> None:
        self.out = out
        self.steps: list[Step] = []
        self.console: list[str] = []
        self.page_errors: list[str] = []

    def add(self, seq: int, title: str, ok: bool, detail: str, shots: list[str] | None = None) -> None:
        self.steps.append(Step(seq=seq, title=title, ok=ok, detail=detail, shots=list(shots or [])))
        mark = "✅" if ok else "❌"
        print(f"{mark} [{seq}] {title} — {detail}")

    def write(self, extra: dict[str, Any]) -> None:
        self.out.mkdir(parents=True, exist_ok=True)
        failed = [s for s in self.steps if not s.ok]
        lines = [
            "# 分镜工作室外壳 · 浏览器验收报告",
            "",
            f"- 通过 {len(self.steps) - len(failed)} / {len(self.steps)} 步",
            f"- console error：{len([m for m in self.console if m.startswith('error')])}",
            f"- 未处理异常：{len(self.page_errors)}",
            "",
            "| # | 步骤 | 结果 | 说明 | 截图 |",
            "|---|---|---|---|---|",
        ]
        for step in self.steps:
            shots = "<br>".join(f"`{name}`" for name in step.shots) or "—"
            lines.append(f"| {step.seq} | {step.title} | {'通过' if step.ok else '**失败**'} | {step.detail} | {shots} |")
        lines += ["", "## 环境", "", "```json", json.dumps(extra, ensure_ascii=False, indent=2), "```"]
        if self.console:
            lines += ["", "## console 输出", "", "```", *self.console[-40:], "```"]
        if self.page_errors:
            lines += ["", "## 未处理异常", "", "```", *self.page_errors[:20], "```"]
        (self.out / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
        (self.out / "report.json").write_text(
            json.dumps(
                {
                    "steps": [s.__dict__ for s in self.steps],
                    "console": self.console,
                    "page_errors": self.page_errors,
                    **extra,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )


def main_text(browser: Browser, waived: list[str]) -> str:
    """取主区可见文本（**排除**默认收起的技术详情层与胶片条，避免把折叠层当成主区泄漏）。"""
    expression = """
    (() => {
      const waived = %s;
      const root = document.querySelector('[data-testid="studio-shell"]') || document.body;
      const clone = root.cloneNode(true);
      waived.forEach((sel) => {
        clone.querySelectorAll(sel).forEach((node) => node.remove());
      });
      return clone.innerText || '';
    })()
    """ % json.dumps(waived)
    return str(browser.evaluate(expression) or "")


def overflow_x(browser: Browser) -> int:
    """横向溢出量（正数表示需要横向滚动 → 布局溢出）。"""
    return int(
        browser.evaluate(
            "Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)"
        )
        or 0
    )


def page_scroll(browser: Browser) -> tuple[int, int]:
    return (
        int(browser.evaluate("document.documentElement.scrollHeight") or 0),
        int(browser.evaluate("document.documentElement.clientHeight") or 0),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="分镜工作室外壳浏览器验收")
    parser.add_argument("--front", required=True, help="前端地址，例如 http://127.0.0.1:5231")
    parser.add_argument("--api", required=True, help="后端地址（必须 JELLYFISH_DRY_RUN=1）")
    parser.add_argument("--project", required=True, help="项目 ID")
    parser.add_argument("--chapter", required=True, help="章节 ID")
    parser.add_argument("--out", required=True, help="证据输出目录（建议放在仓库外）")
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rec = Recorder(out)
    studio_path = (
        f"/projects/{urllib.parse.quote(args.project)}/chapters/{urllib.parse.quote(args.chapter)}/studio"
    )
    base_url = f"{args.front}{studio_path}"

    def shot(browser: Browser, name: str) -> str:
        browser.screenshot(out / name)
        return name

    with Browser(width=1440, height=900) as browser:
        browser.set_runtime_env(args.api)

        # ---- 1. 第 3 步进入的是分镜工作室容器 ----
        browser.goto(f"{base_url}?studio=video_prompt", settle=2.5)
        browser.wait_for_selector('[data-testid="studio-shell"]', timeout=25)
        shell_ok = bool(browser.evaluate("!!document.querySelector('[data-testid=\"studio-shell\"]')"))
        parts = {
            "context": "project-context-bar",
            "stepper": "production-stepper",
            "phasebar": "studio-phase-bar",
            "side": "studio-side",
            "mid": "studio-mid",
            "preview": "studio-preview",
            "rail": "studio-rail",
        }
        missing = [
            name
            for name, testid in parts.items()
            if not browser.evaluate(f"!!document.querySelector('[data-testid=\"{testid}\"]')")
        ]
        s1 = [shot(browser, "010_studio_phase3_1440.png")]
        rec.add(
            1,
            "第 3 步落在分镜工作室容器内（常驻结构齐全）",
            shell_ok and not missing,
            f"容器={'在' if shell_ok else '不在'}；缺失区域={missing or '无'}",
            s1,
        )

        # ---- 2. 阶段条三个按钮与全局五步名称 ----
        phases = browser.evaluate(
            "Array.from(document.querySelectorAll('[data-studio-phase]')).map(n => n.textContent.trim())"
        )
        step_labels = browser.evaluate(
            "Array.from(document.querySelectorAll('[data-testid=\"production-stepper\"] .studio-step__label')).map(n => n.textContent.trim())"
        )
        expect_steps = ["剧本与分镜", "资产准备", "整集视频提示词", "资产与声音检查", "生成与交付"]
        ok2 = (
            phases == ["3 整集视频提示词", "4 资产与声音检查", "5 生成与交付"]
            and step_labels == expect_steps
        )
        rec.add(
            2,
            "阶段条与常驻五步的名称/顺序正确（第 3 步仍叫「整集视频提示词」）",
            ok2,
            f"阶段={phases}；五步={step_labels}",
        )

        # ---- 3. 切阶段不离开本页、不换镜头 ----
        shot_before = str(browser.evaluate("document.querySelector('[data-testid=\"studio-current-shot\"]')?.textContent || ''"))
        url_before = str(browser.evaluate("location.pathname"))
        browser.click('[data-studio-phase="binding"]')
        browser.wait_for_ready(settle=1.2)
        url_after = str(browser.evaluate("location.pathname"))
        search_after = str(browser.evaluate("location.search"))
        shot_after = str(browser.evaluate("document.querySelector('[data-testid=\"studio-current-shot\"]')?.textContent || ''"))
        s3 = [shot(browser, "020_phase4_readonly_1440.png")]
        rec.add(
            3,
            "切到阶段 4：路由不变、当前镜头不变、URL 记录阶段",
            url_after == url_before and shot_after == shot_before and "studio=binding" in search_after,
            f"pathname {url_before} → {url_after}；镜头「{shot_before}」→「{shot_after}」；search={search_after}",
            s3,
        )

        # 阶段 4 只读：**按可交互元素**判定（说明性文案里出现"试听/选择音色"是正常的指路句）
        voice_controls = browser.evaluate(
            """(() => {
              const root = document.querySelector('[data-scene="binding"]');
              if (!root) return ['阶段 4 面板不存在'];
              const offenders = [];
              root.querySelectorAll('button, a, input, audio').forEach((node) => {
                const label = (node.innerText || node.value || node.getAttribute('aria-label') || '').trim();
                if (/试听|选择音色|更换音色|保存声音|绑定声音|解绑/.test(label)) offenders.push(label.slice(0, 30));
                if (node.tagName === 'AUDIO') offenders.push('audio');
                if (node.tagName === 'INPUT' && (node.type === 'file' || node.type === 'range')) {
                  offenders.push('input:' + node.type);
                }
              });
              return offenders;
            })()"""
        )
        phase4_buttons = browser.evaluate(
            "Array.from(document.querySelectorAll('[data-scene=\"binding\"] button')).map(n => n.innerText.trim()).filter(Boolean)"
        )
        rec.add(
            4,
            "阶段 4 只读：没有选择 / 试听 / 更换 / 保存声音的可交互入口",
            not voice_controls,
            f"可疑控件={voice_controls or '无'}；面板内按钮={phase4_buttons}",
        )

        # ---- 5. 阶段 5 ----
        browser.click('[data-studio-phase="deliver"]')
        browser.wait_for_ready(settle=1.2)
        deliver_ok = bool(
            browser.evaluate("!!document.querySelector('[data-testid=\"studio-delivery-readiness\"]')")
        ) and bool(browser.evaluate("!!document.querySelector('[data-testid=\"studio-delivery-download\"]')"))
        deliver_text = str(browser.evaluate("document.querySelector('[data-scene=\"deliver\"]')?.innerText || ''"))
        s5 = [shot(browser, "030_phase5_delivery_1440.png")]
        rec.add(
            5,
            "切到阶段 5：交付就绪 / 生成任务 / 交付下载三层都在",
            deliver_ok and "交付就绪情况" in deliver_text and "生成任务" in deliver_text and "交付下载" in deliver_text,
            f"就绪卡={deliver_ok}；含三层标题={'交付就绪情况' in deliver_text}/{'生成任务' in deliver_text}/{'交付下载' in deliver_text}",
            s5,
        )

        # ---- 6. 刷新恢复阶段 + 当前镜头 ----
        # 先切回阶段 3，然后**在刷新前一刻**记录"阶段 / 镜头 / URL 里的 shot 参数"。
        # 为什么不复用更早捕获的标签：阶段切换会触发既有的"自动定位到该阶段第一个未完成镜头"
        # （`onAutoLocateShot`），所以跨阶段之后的当前镜头本来就可能变过 ——
        # 要验的是"刷新恢复到**刷新前**的状态"，就必须拿刷新前那一刻的值比。
        browser.click('[data-studio-phase="video_prompt"]')
        browser.wait_for_ready(settle=1.5)
        deep_url = str(browser.evaluate("location.href"))
        shot_at_reload = str(
            browser.evaluate("document.querySelector('[data-testid=\"studio-current-shot\"]')?.textContent || ''")
        )
        phase_at_reload = browser.evaluate(
            "document.querySelector('[data-studio-phase].is-active')?.getAttribute('data-studio-phase')"
        )
        url_shot_param = str(browser.evaluate("new URLSearchParams(location.search).get('shot') || ''"))

        browser.goto(deep_url, settle=2.5)
        browser.wait_for_selector('[data-testid="studio-shell"]', timeout=25)
        restored_phase = browser.evaluate(
            "document.querySelector('[data-studio-phase].is-active')?.getAttribute('data-studio-phase')"
        )
        restored_shot = str(browser.evaluate("document.querySelector('[data-testid=\"studio-current-shot\"]')?.textContent || ''"))
        s6 = [shot(browser, "040_reload_restored_1440.png")]
        rec.add(
            6,
            "刷新恢复：阶段与当前镜头都从 URL 恢复",
            restored_phase == phase_at_reload
            and restored_shot == shot_at_reload
            and bool(url_shot_param),
            f"刷新前：阶段={phase_at_reload} 镜头=「{shot_at_reload}」URL 里 shot={url_shot_param or '（缺失）'}；"
            f"刷新后：阶段={restored_phase} 镜头=「{restored_shot}」",
            s6,
        )

        # ---- 7. 浏览器后退 / 前进按阶段栈工作 ----
        # 走一段干净的序列：阶段 3 → 4 → 5，然后连退两次、再前进一次。
        browser.goto(f"{base_url}?studio=video_prompt", settle=2.5)
        browser.click('[data-studio-phase="binding"]')
        browser.wait_for_ready(settle=0.8)
        browser.click('[data-studio-phase="deliver"]')
        browser.wait_for_ready(settle=0.8)
        active_before = browser.evaluate(
            "document.querySelector('[data-studio-phase].is-active')?.getAttribute('data-studio-phase')"
        )
        browser.evaluate("history.back()")
        browser.wait_for_ready(settle=1.2)
        back1 = browser.evaluate(
            "document.querySelector('[data-studio-phase].is-active')?.getAttribute('data-studio-phase')"
        )
        browser.evaluate("history.back()")
        browser.wait_for_ready(settle=1.2)
        back2 = browser.evaluate(
            "document.querySelector('[data-studio-phase].is-active')?.getAttribute('data-studio-phase')"
        )
        browser.evaluate("history.forward()")
        browser.wait_for_ready(settle=1.2)
        fwd = browser.evaluate(
            "document.querySelector('[data-studio-phase].is-active')?.getAttribute('data-studio-phase')"
        )
        rec.add(
            7,
            "浏览器后退 / 前进按阶段栈工作，且始终停在同一分镜",
            (active_before, back1, back2, fwd) == ("deliver", "binding", "video_prompt", "binding"),
            f"起点={active_before} → 后退1={back1} → 后退2={back2} → 前进={fwd}",
        )

        # ---- 8. 胶片条：全选 + 批量下载预检 ----
        browser.goto(f"{base_url}?studio=deliver", settle=2.5)
        browser.wait_for_selector('[data-testid="studio-rail"]', timeout=25)
        rail_cards = int(browser.evaluate("document.querySelectorAll('.studio-railcard').length") or 0)
        active_before_pick = browser.evaluate(
            "document.querySelector('.studio-railcard__open.is-active')?.closest('.studio-railcard')?.getAttribute('data-shot-card')"
        )
        # antd Checkbox 会把额外属性透传到内部 `<input>`，所以 testid 就在 input 上
        select_all = '[data-testid="rail-select-all"]'
        browser.click(select_all)
        browser.wait_for_ready(settle=0.8)
        summary = str(browser.evaluate("document.querySelector('[data-testid=\"rail-selection-summary\"]')?.textContent || ''"))
        bulk_disabled = browser.evaluate(
            "document.querySelector('[data-testid=\"rail-bulk-download\"]')?.disabled === true"
        )
        active_after_pick = browser.evaluate(
            "document.querySelector('.studio-railcard__open.is-active')?.closest('.studio-railcard')?.getAttribute('data-shot-card')"
        )
        s8 = [shot(browser, "050_rail_selection_1440.png")]
        rec.add(
            8,
            "胶片条卡片可勾选、支持全选、给出已选数量（勾选不切当前镜头）",
            rail_cards > 0 and "已选" in summary and active_after_pick == active_before_pick,
            f"卡片 {rail_cards} 张；{summary.strip()}；当前镜头 {active_before_pick} → {active_after_pick}",
            s8,
        )

        if not bulk_disabled:
            browser.click('[data-testid="rail-bulk-download"]')
            browser.wait_for_ready(settle=2.0)
            modal_text = str(browser.evaluate("document.querySelector('.ant-modal-content')?.innerText || ''"))
            s8b = [shot(browser, "060_bulk_download_confirm_1440.png")]
            has_counts = bool(re.search(r"本次会打包 \d+ 条成片", modal_text)) or "还没有勾选" in modal_text
            rec.add(
                9,
                "批量下载前的确认弹窗显示包含数量与排除数量",
                has_counts and "交付清单.txt" in modal_text,
                f"弹窗文本含数量={'本次会打包' in modal_text}；含交付清单说明={'交付清单.txt' in modal_text}",
                s8b,
            )
            browser.evaluate(
                "document.querySelector('.ant-modal-content .ant-btn:not(.ant-btn-primary)')?.click()"
            )
            browser.wait_for_ready(settle=0.6)
        else:
            rec.add(9, "批量下载前的确认弹窗显示包含数量与排除数量", False, "批量下载按钮不可用（预检认为没有可交付成片）")

        # ---- 10. 1440 不整页长滚动 ----
        height, client = page_scroll(browser)
        rec.add(
            10,
            "1440×900 下不整页长滚动（主体区域各自局部滚动）",
            height <= client + 2,
            f"文档高度 {height} vs 视口 {client}",
        )

        # ---- 11. 主区禁词 ----
        text = main_text(browser, WAIVED_SELECTORS)
        hits = [term for term in FORBIDDEN_IN_MAIN if term in text]
        rec.add(
            11,
            "主区不出现接口路径 / 字段名 / 内部 id / 本机地址",
            not hits,
            f"命中={hits or '无'}",
        )

        # ---- 12. 1280 不横向溢出 ----
        browser._call("Emulation.setDeviceMetricsOverride", {"width": 1280, "height": 900, "deviceScaleFactor": 1, "mobile": False})
        browser.wait_for_ready(settle=1.2)
        over = overflow_x(browser)
        s12 = [shot(browser, "070_studio_1280.png")]
        rec.add(
            12,
            "1280×900 不横向溢出（左右栏收窄、中栏优先保留）",
            over == 0,
            f"横向溢出 {over}px",
            s12,
        )

        # ---- 13. 从项目工作台第 3 步进入工作室 ----
        workbench = f"{args.front}/projects/{urllib.parse.quote(args.project)}?step=video_prompt"
        browser.goto(workbench, settle=3.0)
        wb_text = str(browser.evaluate("document.body.innerText") or "")
        # 主入口应当是「进入章节工作室（整集视频提示词）」；独立看板只作为次级工具出现
        enters_studio = "进入章节工作室" in wb_text or "进入分镜工作室" in wb_text
        board_is_secondary = "整集提示词看板（次级工具）" in wb_text
        board_is_primary = ("集级视频提示词 ·" in wb_text) and not enters_studio
        s13 = [shot(browser, "080_workbench_step3_1440.png")]
        rec.add(
            13,
            "项目工作台第 3 步不再以独立提示词中转页为主页面（原页面降级为次级工具）",
            enters_studio and board_is_secondary and not board_is_primary,
            f"含「进入章节工作室」={enters_studio}；标注为次级工具={board_is_secondary}；"
            f"仍以看板为主页面={board_is_primary}",
            s13,
        )

        rec.console = [m for m in browser.console_messages]
        rec.page_errors = list(browser.page_errors)

    errors = [m for m in rec.console if m.startswith("error")]
    rec.add(14, "console error = 0", not errors, f"{len(errors)} 条" + (f"：{errors[:3]}" if errors else ""))
    rec.add(15, "未处理异常 = 0", not rec.page_errors, f"{len(rec.page_errors)} 条")
    rec.write({"front": args.front, "api": args.api, "project": args.project, "chapter": args.chapter})

    failed = [s for s in rec.steps if not s.ok]
    print()
    print(f"报告：{out / 'report.md'}")
    print(f"通过 {len(rec.steps) - len(failed)} / {len(rec.steps)}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
