"""步骤 1→4 的**接口级冒烟**（免费、零出网、演练模式）。

为什么要有它（而不是只有浏览器验收）
==================================

浏览器验收（``tools/browser_acceptance_drama_ad.py``）跑一轮要几分钟，而且它失败时
报的是"某个按钮没找到"——排查起来要先猜是页面问题还是后端问题。这支脚本用同一套
真实 HTTP 调用把后端那一段先跑一遍：**每一步打印实际拿到的关键字段**，于是
"是接口没通还是页面没接"一眼可分。

它同时也是"用户流程每一步的下一步是什么"的接口侧证据：

1. 新建剧情广告项目（``kind=ad``）→ 同一事务建默认章节 + 空商品卡；
2. 保存商品资料（PUT 商品卡 + ``confirmed=true``）；
3. 自动提取商品卖点（POST extract；**演练模式下不调模型**，如实返回未调用）；
4. 生成剧情（POST generate；演练模式下不写 plan，所以这里用 PUT draft 手写一份等价草稿）；
5. 用户审核修改（PUT draft）；
6. 确认策划（POST confirm，幂等）→ 拿到 ``next_step``；
7. 建立后续章节与镜头 → GET 章节/镜头；
8. 进入资产准备 → GET project asset-readiness（商品必须在清单里）；
9. 生成视频提示词 → GET prompt-delivery；
10. 资产绑定 → GET shot linked-assets（商品必须能看到）；
11. 生成与交付 → GET shot video-readiness。

用法::

    ./backend/.venv/bin/python tools/api_smoke_ad_flow.py [--base http://127.0.0.1:8123]

退出码 0 = 全部检查通过；1 = 有检查失败（逐条打印在哪一步）。
**不写任何正式库**：只对 ``--base`` 指定的那个后端说话（本轮的隔离后端指向临时库）。
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
import uuid
from typing import Any

API = "/api/v1/studio"

#: 检查结果（(是否通过, 说明)）
RESULTS: list[tuple[bool, str]] = []


def check(ok: bool, message: str) -> bool:
    RESULTS.append((bool(ok), message))
    print(f"  {'✓' if ok else '✗'} {message}")
    return bool(ok)


def call(
    base: str,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
) -> tuple[int, dict[str, Any]]:
    """发一次真实 HTTP 请求，返回 ``(status_code, 解析后的 JSON)``。"""
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        f"{base}{path}",
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, {"raw": raw}


def payload_of(response: dict[str, Any]) -> Any:
    """取 ``ApiResponse.data``（拿不到就原样返回，方便打印真实形状）。"""
    return response.get("data") if isinstance(response, dict) and "data" in response else response


def draft(shot_count: int = 3) -> dict[str, Any]:
    """一份合法草稿（对应"用户审核修改后的剧情方案"）。"""
    return {
        "title": "面试那天",
        "logline": "她带着一瓶精华去面试，面试官是前任",
        "one_liner": "一瓶精华把前任气到破防",
        "audience_emotion": "爽",
        "story": {
            "full_text": "会议室里，她把瓶子拍在桌上。\n前任抬头说：好久不见。",
            "hook": "瓶子拍在桌上",
            "conflict": "面试官是前任",
            "product_usage": "她用精华当武器",
            "climax": "前任说这瓶是他买的",
            "cta": "她笑而不语",
        },
        "selling_points": ["三秒吸收"],
        "characters": [
            {"name": "林小满", "profile": {"appearance": "鹅蛋脸"}},
            {"name": "周砚", "profile": {"identity": "面试官"}},
        ],
        "scenes": [{"name": "写字楼会议室", "profile": {"spatial_structure": "长桌"}}],
        "product": {
            "name": "紧致焕颜精华",
            "description": "白色磨砂瓶身，金色压泵",
            "profile": {"package": "方形瓶身"},
        },
        "shots": [
            {
                "index": index + 1,
                "title": f"镜头 {index + 1}",
                "characters": ["林小满"] if index == 0 else ["林小满", "周砚"],
                "description": f"第 {index + 1} 镜描述",
                "duration": 5,
                "camera_shot": "MS",
                "angle": "EYE_LEVEL",
                "movement": "STATIC",
                "action_beats": ["拍瓶"],
                "dialogue": (
                    [{"speaker": "林小满", "text": "我不用补妆。", "mode": "DIALOGUE"}]
                    if index == 0
                    else []
                ),
                "product_present": index % 2 == 0,
            }
            for index in range(shot_count)
        ],
        "climax": "前任说这瓶是他买的",
        "warnings": [],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8123", help="隔离后端地址")
    args = parser.parse_args()
    base = args.base.rstrip("/")
    suffix = uuid.uuid4().hex[:6]

    print(f"\n=== 接口级冒烟：{base}（演练模式，零付费）===")

    # ---- 第 1 步：新建剧情广告项目 -------------------------------------
    print("\n[1] 新建剧情广告项目（kind=ad）")
    status, body = call(
        base,
        "POST",
        f"{API}/projects",
        {
            "id": f"proj-smoke-{suffix}",
            "name": f"冒烟·剧情广告 {suffix}",
            "description": "接口级冒烟",
            "style": "真人都市",
            "visual_style": "现实",
            "kind": "ad",
            # 显式传后端的 `start_mode`（只允许 script/prompts）。浏览器验收曾经栽在这里：
            # 前端把 UI 的「剧情广告」当成了 start_mode 传上去 → 422。冒烟脚本不带这个字段时
            # 靠后端默认值，测不出这类错，所以这里显式写出来。
            "start_mode": "script",
            "ad_product_source": {"type": "paste", "text": "紧致焕颜精华，三秒吸收"},
            "ad_requirements": {
                "genre": "真人都市",
                "tone": "一本正经地荒诞",
                "shot_count": 3,
                "director_notes": "不要旁白",
            },
        },
    )
    created = payload_of(body)
    if not check(status in {200, 201}, f"POST /projects → {status}（201 = 新建成功）"):
        print(json.dumps(body, ensure_ascii=False, indent=2)[:2000])
        return 1
    project_id = created["id"]
    chapter_id = created.get("chapter_id") or ""
    check(bool(chapter_id), f"同一事务建了默认章节：chapter_id={chapter_id}")
    check(created.get("kind") == "ad", f"响应带 kind={created.get('kind')}")

    # ---- 第 2 步：商品资料卡 -------------------------------------------
    print("\n[2] 商品信息卡")
    status, body = call(base, "GET", f"{API}/projects/{project_id}/product-card")
    card = payload_of(body)
    check(status == 200, f"GET product-card → {status}")
    check(bool(card.get("missing_fields")), f"缺项：{card.get('missing_fields')}")

    print("\n[3] 自动提取商品卖点（演练：不调模型）")
    status, body = call(
        base,
        "POST",
        f"{API}/projects/{project_id}/product-card/extract",
        {"source_type": "paste", "text": "紧致焕颜精华，三秒吸收，适合通勤女性"},
    )
    extract = payload_of(body)
    if status == 200:
        summary = extract.get("source_summary") or {}
        check(summary.get("llm_called") is False, f"演练未调模型：llm_called={summary.get('llm_called')}")
        check(
            summary.get("extraction_status") == "dry_run_not_called",
            f"演练状态：{summary.get('extraction_status')}",
        )
    else:
        meta_error = (body.get("meta") or {}).get("error") or {}
        print(f"  (extract 返回 {status}：{meta_error.get('code') or body})")

    status, body = call(
        base,
        "PUT",
        f"{API}/projects/{project_id}/product-card",
        {
            "name": "紧致焕颜精华",
            "category": "护肤品",
            "brand": "某品牌",
            "selling_points": ["三秒吸收", "不粘腻"],
            "scenarios": ["面试前补妆"],
            "audience": "通勤女性",
            "compliance": "不得宣称医疗功效",
            "confirmed": True,
        },
    )
    card = payload_of(body)
    check(status == 200 and card.get("confirmed") is True, f"确认商品卡 → {status}（{card.get('confirmed')}）")

    # ---- 第 4/5 步：生成剧情 + 用户审核修改 ---------------------------
    print("\n[4] 保存 brief 与生成（演练：不写 plan）")
    status, body = call(
        base,
        "PUT",
        f"{API}/chapters/{chapter_id}/drama-plan/brief",
        {
            "product_name": "紧致焕颜精华",
            "product_description": "白色磨砂瓶身",
            "selling_points": ["三秒吸收"],
            "target_audience": "通勤女性",
            "tone": "一本正经地荒诞",
            "shot_count": 3,
        },
    )
    check(status == 200, f"PUT brief → {status}")
    status, body = call(
        base,
        "POST",
        f"{API}/chapters/{chapter_id}/drama-plan/generate",
        {"stage": "all"},
    )
    check(status == 200, f"POST generate → {status}（演练下 200 且不写 plan）")

    print("\n[5] 用户审核修改（PUT /draft，服务端归一化 + 过期标记）")
    status, body = call(
        base, "PUT", f"{API}/chapters/{chapter_id}/drama-plan/draft", draft()
    )
    plan_read = payload_of(body)
    check(status == 200, f"PUT draft → {status}")
    check(
        bool((plan_read.get("plan") or {}).get("shots")),
        f"草稿镜头数：{len((plan_read.get('plan') or {}).get('shots') or [])}",
    )

    status, body = call(
        base, "POST", f"{API}/chapters/{chapter_id}/drama-plan/consistency", {}
    )
    consistency = payload_of(body)
    check(status == 200, f"POST consistency → {status}")
    check(
        consistency.get("ok") is True,
        f"一致性 ok={consistency.get('ok')}（issues={len(consistency.get('issues') or [])}）",
    )

    # ---- 第 6 步：确认策划（幂等）-------------------------------------
    print("\n[6] 确认策划（POST confirm，幂等）")
    status, body = call(base, "POST", f"{API}/chapters/{chapter_id}/drama-plan/confirm", {})
    confirm = payload_of(body)
    if not check(status == 200, f"第一次 confirm → {status}"):
        print(json.dumps(body, ensure_ascii=False, indent=2)[:3000])
        return 1
    check(confirm["shots_created"] == 3, f"建了 {confirm['shots_created']} 个镜头")
    # 场景与商品是**全局资产**（同名即复用），所以在同一个库里重复跑冒烟时
    # `assets_created` 会小于 4 —— 断言"新建 + 复用 == 4"才是真正的口径。
    check(
        confirm["assets_created"] + confirm["assets_reused"] == 4,
        f"资产：新建 {confirm['assets_created']} + 复用 {confirm['assets_reused']} = 4"
        "（2 人物 + 1 场景 + 1 商品）",
    )
    step = confirm.get("next_step") or {}
    check(step.get("label") == "继续准备资产", f"next_step.label={step.get('label')}")
    check(bool(step.get("chapter_url")), f"next_step.chapter_url={step.get('chapter_url')}")

    status, body = call(base, "POST", f"{API}/chapters/{chapter_id}/drama-plan/confirm", {})
    again = payload_of(body)
    check(
        status == 200 and again["shots_created"] == 0 and again["assets_created"] == 0,
        f"第二次 confirm 幂等：shots_created={again.get('shots_created')} assets_created={again.get('assets_created')}",
    )

    status, body = call(base, "GET", f"{API}/projects/{project_id}")
    detail = payload_of(body)
    check(
        detail.get("ad_phase") in {"confirmed", "production"},
        f"项目详情 ad_phase={detail.get('ad_phase')}（{detail.get('ad_phase_label')}）",
    )

    # ---- 第 7 步：后续章节与镜头 ---------------------------------------
    print("\n[7] 建立后续章节与镜头")
    # 仓库里镜头列表是平铺的 `GET /studio/shots?chapter_id=...`（不是章节子路径）
    status, body = call(base, "GET", f"{API}/shots?chapter_id={chapter_id}")
    shots = payload_of(body)
    shot_rows = (shots or {}).get("items") or []
    check(status == 200 and len(shot_rows) == 3, f"章节镜头数 = {len(shot_rows)}")
    shot_ids = [row.get("id") for row in shot_rows if isinstance(row, dict)]
    if shot_ids:
        status, body = call(base, "GET", f"{API}/shots/{shot_ids[0]}")
        check(status == 200, f"GET 单个镜头 → {status}")

    status, body = call(
        base, "POST", f"{API}/projects/{project_id}/drama-plan/chapter", {"product_name": "紧致焕颜精华"}
    )
    extra_chapter = payload_of(body)
    check(
        status == 200 and bool((extra_chapter or {}).get("chapter_id")),
        f"项目内取可用章节 → {status}（{((extra_chapter or {}).get('chapter_id'))}）",
    )

    # ---- 第 8 步：进入资产准备 -----------------------------------------
    print("\n[8] 第 2 步「资产准备」：商品必须在清单里")
    status, body = call(base, "GET", f"{API}/projects/{project_id}/asset-readiness")
    readiness = payload_of(body)
    items = (readiness or {}).get("items") or []
    kinds = sorted({str(item.get("asset_type")) for item in items})
    check(status == 200, f"GET asset-readiness → {status}")
    check("product" in kinds, f"清单里的资产类型：{kinds}")

    status, body = call(base, "GET", f"{API}/chapters/{chapter_id}/asset-workbench")
    workbench = payload_of(body)
    by_type = ((workbench or {}).get("summary") or {}).get("by_type") or {}
    check(status == 200, f"GET asset-workbench → {status}")
    check(
        "product" in by_type,
        f"工作台按类型统计的桶：{sorted(by_type)}（商品必须在里面）",
    )
    # 资产资料（第 2 步的"资料"读取侧）：product 的字段表由后端下发，页面据此渲染表单
    status, body = call(base, "GET", f"{API}/chapters/{chapter_id}/asset-profiles")
    profiles = payload_of(body)
    check(status == 200, f"GET asset-profiles → {status}")
    user_flow = (profiles or {}).get("user_flow") or {}
    check(bool(user_flow), f"资产资料页面的用户流程说明：{sorted(user_flow)[:4]}")

    # ---- 第 9/10/11 步：提示词 / 绑定 / 生成就绪 ------------------------
    print("\n[9] 第 3 步「整集视频提示词」")
    status, body = call(base, "GET", f"{API}/prompt-board/{chapter_id}")
    check(status == 200, f"GET prompt-board → {status}")
    status, body = call(base, "GET", f"{API}/prompt-delivery/{project_id}")
    delivery = body.get("data") if isinstance(body, dict) else None
    delivery_text = json.dumps(delivery, ensure_ascii=False) if delivery is not None else ""
    check(status == 200, f"GET prompt-delivery → {status}")
    if delivery_text:
        check(
            "紧致焕颜精华" in delivery_text,
            f"交付文本里出现商品名：{'紧致焕颜精华' in delivery_text}",
        )

    print("\n[10] 第 4 步「资产绑定」：镜头要能看到商品")
    if shot_ids:
        status, body = call(base, "GET", f"{API}/shots/{shot_ids[0]}/linked-assets")
        linked = payload_of(body)
        linked_rows = (linked or {}).get("items") or []
        # 字段名是 `type`（不是 asset_type）—— 按实际下发的形状断言，别按想象写
        linked_kinds = sorted({str(row.get("type")) for row in linked_rows if isinstance(row, dict)})
        check(status == 200, f"GET linked-assets → {status}")
        check("product" in linked_kinds, f"镜头已绑定资产类型：{linked_kinds}")

    print("\n[11] 第 5 步「生成与交付」")
    if shot_ids:
        status, body = call(base, "GET", f"{API}/shots/{shot_ids[0]}/video-readiness")
        check(status == 200, f"GET video-readiness → {status}")

    # ---- 汇总 ----------------------------------------------------------
    failed = [message for ok, message in RESULTS if not ok]
    print(f"\n=== 结果：{len(RESULTS) - len(failed)}/{len(RESULTS)} 通过 ===")
    if failed:
        print("未通过：")
        for message in failed:
            print(f"  - {message}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
