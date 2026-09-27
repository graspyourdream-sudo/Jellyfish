"""一次真实调用的验收驱动：点一次「一次生成全部」→ 核对三层 → 确认策划 → 核对落库。

**只为这一次授权调用而写**，不参与常规回归（常规回归用 `browser_acceptance_drama_ad.py`）。
它做的事：把页面上的「一次生成全部」**真实点一次**（UI 发的就是 `{"stage":"all"}`），
然后靠**接口 + 数据库**核对结果，并把每一步截图。

用法（真实模式后端已在跑时）：
    ./backend/.venv/bin/python tools/real_acceptance_all_stage.py --project-id <pid> --chapter-id <cid> --out <dir>
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cdp import Browser  # noqa: E402


def api(base: str, method: str, path: str, body: dict[str, Any] | None = None) -> tuple[int, Any]:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(f"{base}{path}", data=data, method=method,
                                headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8") or "{}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8123")
    ap.add_argument("--front", default="http://127.0.0.1:5231")
    ap.add_argument("--project-id", required=True)
    ap.add_argument("--chapter-id", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--wait", type=float, default=300.0)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    report: dict[str, Any] = {"project_id": args.project_id, "chapter_id": args.chapter_id, "steps": []}

    def note(step: str, ok: bool, detail: Any = "") -> None:
        report["steps"].append({"step": step, "ok": bool(ok), "detail": detail})
        print(f"  {'✓' if ok else '✗'} {step}：{detail}")

    with Browser(width=1440, height=900) as browser:
        browser.set_runtime_env(args.api)
        url = f"{args.front}/drama-plan?projectId={args.project_id}&chapterId={args.chapter_id}"
        browser.goto(url, settle=5.0)
        browser.screenshot(out / "01_before_generate.png")
        body = browser.body_text()
        note("页面打开剧情策划（本集为空草稿）", "商品信息卡" in body and "一次生成全部" in body,
             f"可见 {len(body)} 字")

        before = api(args.api, "GET", f"/api/v1/studio/chapters/{args.chapter_id}/drama-plan")[1].get("data") or {}
        note("生成前草稿为空", not (before.get("plan") or {}).get("shots"),
             f"status={before.get('status')!r} shots={len(((before.get('plan') or {}).get('shots')) or [])}")

        # ---- 唯一一次真实调用：点页面上的「一次生成全部」（UI 发的就是 stage=all）----
        print("  → 点击「一次生成全部」（**本次授权唯一一次模型调用**）")
        browser.click_text("一次生成全部", selector=".ant-btn")
        started = time.time()
        draft: dict[str, Any] = {}
        structured_error: Any = None
        while time.time() - started < args.wait:
            status, resp = api(args.api, "GET", f"/api/v1/studio/chapters/{args.chapter_id}/drama-plan")
            draft = (resp.get("data") or {}) if status == 200 else {}
            plan = draft.get("plan") or {}
            story = plan.get("story") or {}
            if (str(plan.get("one_liner") or "").strip() and str(story.get("full_text") or "").strip()
                    and (plan.get("shots") or [])):
                break
            if draft.get("error"):
                structured_error = draft.get("error")
                break
            if str(draft.get("status") or "") == "failed":
                break
            time.sleep(3.0)
        elapsed = round(time.time() - started, 1)
        browser.screenshot(out / "02_after_generate.png")

        status, resp = api(args.api, "GET", f"/api/v1/studio/chapters/{args.chapter_id}/drama-plan")
        draft = (resp.get("data") or {}) if status == 200 else {}
        plan = draft.get("plan") or {}
        story = plan.get("story") or {}
        report["raw_draft"] = {k: draft.get(k) for k in ("status", "story_status", "model", "error", "meta")}
        report["plan"] = plan
        note("模型调用返回", bool(plan), f"耗时 {elapsed}s | status={draft.get('status')!r} error={draft.get('error')!r}")

        if structured_error and not plan:
            note("模型返回被判定为不完整（结构化错误）", False, str(structured_error)[:400])
            (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            return 1

        # ---- 逐项核对（页面 + 接口 + 数据库三方）----
        note("one_liner 非空", bool(str(plan.get("one_liner") or "").strip()), str(plan.get("one_liner"))[:100])
        card = api(args.api, "GET", f"/api/v1/studio/projects/{args.project_id}/product-card")[1].get("data") or {}
        points = [str(item) for item in (card.get("selling_points") or [])]
        used = [p for p in points if p and p in str(plan.get("one_liner") or "")]
        note("一句话使用真实商品卖点", bool(used), f"卡里的卖点={points}；一句话里命中={used}")
        full = str(story.get("full_text") or "")
        note("story.full_text 是完整剧情（非摘要/残句）", len(full) >= 200, f"{len(full)} 字")
        for field in ("hook", "conflict", "product_usage", "climax", "cta"):
            note(f"story.{field} 非空", bool(str(story.get(field) or "").strip()), str(story.get(field))[:60])
        hero = (plan.get("characters") or [{}])[0].get("name", "")
        product = (plan.get("product") or {}).get("name", "")
        note("详细剧情承接一句话（同一主角）", hero in full, f"主角={hero!r}")
        note("详细剧情承接一句话（同一商品）", product in full, f"商品={product!r}")
        names = {item.get("name") for item in (plan.get("characters") or [])}
        shots = plan.get("shots") or []
        note("分镜人物都在人物表里", all(set(s.get("characters") or []) <= names for s in shots),
             f"{len(shots)} 镜 / 人物表 {sorted(n for n in names if n)}")
        excerpt_ok = all(
            (not str(s.get("script_excerpt") or "").strip()) or str(s["script_excerpt"]).strip()[:6] in full
            for s in shots
        )
        note("分镜摘录能在完整剧情里找到出处（不另起故事）", excerpt_ok, f"{len(shots)} 镜")
        present = sum(1 for s in shots if s.get("product_present"))
        note("商品出现在多数镜头", present * 2 >= max(1, len(shots)), f"{present}/{len(shots)} 镜")
        note("镜头序号连续", [s.get("index") for s in shots] == list(range(1, len(shots) + 1)),
             f"{[s.get('index') for s in shots]}")

        # 页面能完整查看（全文可见，不是截断摘要）
        body = browser.body_text()
        note("页面显示完整剧情全文（不是截断摘要）", full[:40] in body, f"页面 {len(body)} 字")
        one_input = browser.evaluate(
            """(() => { const el = [...document.querySelectorAll('input,textarea')]
                 .find((e) => (e.value || '').includes(%s));
                 return el ? { tag: el.tagName, value: el.value.slice(0, 60), readonly: el.readOnly, len: el.value.length } : null; })()"""
            % json.dumps(str(plan.get("one_liner") or "")[:20])
        )
        note("一句话剧情在页面上可读可编辑", bool(one_input) and not one_input.get("readonly"), one_input)

        # ---- 确认策划（免费）+ 落库核对 ----
        browser.click_text("确认策划", selector=".ant-btn-primary, button.ant-btn-primary")
        time.sleep(2.0)
        if "确认策划并落库" in browser.body_text():
            try:
                browser.click_text("确认策划", selector=".ant-modal-confirm-btns button, .ant-modal-footer button",
                                   exact=True)
            except Exception:  # noqa: BLE001
                browser.press_enter()
        deadline = time.time() + 120
        while time.time() < deadline:
            if "策划已确认" in browser.body_text():
                break
            time.sleep(1.0)
        browser.screenshot(out / "03_confirmed.png")
        note("确认后页面显示「策划已确认」", "策划已确认" in browser.body_text(), "")

        shots_resp = api(args.api, "GET", f"/api/v1/studio/shots?chapter_id={args.chapter_id}")[1].get("data") or {}
        db_shots = shots_resp.get("items") or []
        note("正式镜头数与草稿一致", len(db_shots) == len(shots), f"落库 {len(db_shots)} / 草稿 {len(shots)}")

        readiness = api(args.api, "GET", f"/api/v1/studio/projects/{args.project_id}/asset-readiness")[1].get("data") or {}
        kinds = sorted({str(item.get("asset_type")) for item in (readiness.get("items") or [])})
        note("商品继续进入第 2 步（readiness）", "product" in kinds, f"{kinds}")

        delivery = api(args.api, "GET", f"/api/v1/studio/prompt-delivery/{args.project_id}")[1].get("data")
        note("第 3 步交付文本含商品", product in json.dumps(delivery, ensure_ascii=False), f"商品={product!r}")

        linked_any = 0
        for row in db_shots:
            linked = api(args.api, "GET", f"/api/v1/studio/shots/{row['id']}/linked-assets")[1].get("data") or {}
            if any(str(item.get("type")) == "product" for item in (linked.get("items") or [])):
                linked_any += 1
        note("第 4 步镜头看得到已绑商品", linked_any > 0, f"{linked_any}/{len(db_shots)} 镜")

        # ---- 刷新 / 重进后仍在 ----
        browser.goto(url, settle=4.0)
        body = browser.body_text()
        browser.screenshot(out / "04_after_reload.png")
        note("刷新后仍是已确认且内容在位", ("策划已确认" in body) and (full[:30] in body), f"{len(body)} 字")

    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    failed = [item for item in report["steps"] if not item["ok"]]
    print(f"\n=== 真实一次调用验收：{len(report['steps']) - len(failed)}/{len(report['steps'])} 项通过 ===")
    for item in failed:
        print("  ✗", item["step"], item["detail"])
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
