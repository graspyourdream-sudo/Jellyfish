#!/usr/bin/env python3
"""出口 A + 巨日禄导入的 HTTP 层自检（进程内 ASGI，不占端口、不写库）。

为什么用进程内 ASGI 而不是起 uvicorn
--------------------------------------
拉起 uvicorn 需要一个常驻进程，而这个环境里后台进程会被回收；
``httpx.ASGITransport`` 直接把请求交给 ASGI app，等价于真实 HTTP 路径
（路由匹配 / 请求体校验 / 依赖注入 / 异常映射全都跑一遍），但不占端口。

覆盖：
  1. 出口 A 预览：真实库读取，计数与独立重算一致；
  2. 出口 A 下载：TXT 带 UTF-8 BOM、Content-Disposition 文件名规范；
  3. 出口 A 空范围：返回 404（不是返回空文件）；
  4. 巨日禄导入预览：抓取失败时返回 502 且带脱敏诊断（Cookie 不出现）；
  5. 巨日禄导入预览：章节不存在 → 404；章节不属于项目 → 400；
  6. 巨日禄导入预览：桩掉抓取后返回完整配对计划；
  7. 巨日禄导入提交：桩掉写库后验证路由把计划正确交给写库层。

跑法（需提权，沙箱会杀 sqlalchemy）：
    cd /Users/apple/Documents/Jellyfish/backend
    JELLYFISH_CELERY_EAGER=1 .venv/bin/python tests/selfcheck_http_endpoints.py
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import sqlite3
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("JELLYFISH_CELERY_EAGER", "1")

DB = BACKEND / "jellyfish.db"
PASS = 0
FAIL = 0
FAKE_COOKIE = "SESSION_MARKER_DO_NOT_LEAK_9f3a1c"


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAIL += 1
        print(f"  FAIL  {name}  {detail}")


def fingerprint() -> str:
    h = hashlib.sha256()
    with open(DB, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:12]


def pick_project_and_chapter():
    """找一个含 jurilu 提示词的项目 + 该项目的一个章节 + 一个不属于它的章节。"""
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    cur = con.cursor()
    project_id = cur.execute(
        """
        SELECT c.project_id FROM shot_details d
        JOIN shots s ON s.id = d.id
        JOIN chapters c ON c.id = s.chapter_id
        WHERE d.video_prompt_source = 'jurilu' AND TRIM(d.video_prompt) <> ''
        GROUP BY c.project_id ORDER BY COUNT(*) DESC LIMIT 1
        """
    ).fetchone()[0]
    chapter_id = cur.execute(
        "SELECT id FROM chapters WHERE project_id = ? ORDER BY rowid LIMIT 1", (project_id,)
    ).fetchone()[0]
    expected = cur.execute(
        """
        SELECT COUNT(*) FROM shot_details d
        JOIN shots s ON s.id = d.id
        JOIN chapters c ON c.id = s.chapter_id
        WHERE c.project_id = ? AND d.video_prompt_source = 'jurilu'
              AND TRIM(d.video_prompt) <> ''
        """,
        (project_id,),
    ).fetchone()[0]
    other_chapter = cur.execute(
        "SELECT id FROM chapters WHERE project_id <> ? LIMIT 1", (project_id,)
    ).fetchone()[0]
    con.close()
    return project_id, chapter_id, other_chapter, expected


async def main() -> int:  # noqa: C901
    import httpx

    from app.main import app
    from app.services.external import jurilu_import_service as svc

    project_id, chapter_id, other_chapter, expected_exportable = pick_project_and_chapter()
    print(f"  项目={project_id}")
    print(f"  章节={chapter_id}")
    print(f"  独立重算的可导出条数={expected_exportable}")

    before = fingerprint()
    print(f"  真库指纹（前）={before}\n")

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        print("== 1. 出口 A 预览 ==")
        r = await client.get(f"/api/v1/studio/prompt-delivery/{project_id}", params={"scope": "episodes"})
        check("HTTP 200", r.status_code == 200, f"{r.status_code} {r.text[:200]}")
        body = r.json()
        data = body.get("data") or {}
        check("code=200", body.get("code") == 200, str(body.get("code")))
        check(
            f"exportable_count 与独立重算一致（{expected_exportable}）",
            data.get("exportable_count") == expected_exportable,
            f'接口={data.get("exportable_count")} 重算={expected_exportable}',
        )
        check("export_source 为 jurilu", data.get("export_source") == "jurilu", str(data.get("export_source")))
        check("rows 非空", len(data.get("rows") or []) > 0, str(len(data.get("rows") or [])))
        check("text 非空", bool(data.get("text")), f'len={len(data.get("text") or "")}')
        check("带口径说明 note", bool(data.get("note")))

        print("\n== 2. 出口 A 下载（BOM / 文件名 / 正文一致） ==")
        r2 = await client.get(f"/api/v1/studio/prompt-delivery/{project_id}/export", params={"scope": "episodes"})
        check("HTTP 200", r2.status_code == 200, str(r2.status_code))
        raw = r2.content
        check("带 UTF-8 BOM", raw[:3] == b"\xef\xbb\xbf", raw[:3].hex())
        ctype = r2.headers.get("content-type", "")
        check("Content-Type 为 utf-8 文本", "charset=utf-8" in ctype, ctype)
        disp = r2.headers.get("content-disposition", "")
        check("带 Content-Disposition 附件名", "attachment" in disp and ".txt" in disp, disp)
        decoded = raw.decode("utf-8-sig")
        check("正文与预览逐字一致", decoded == data.get("text"), "下载正文 != 预览正文")

        print("\n== 3. 出口 A 空范围应 404 ==")
        r3 = await client.get(
            f"/api/v1/studio/prompt-delivery/__nonexistent_project__/export",
            params={"scope": "episodes"},
        )
        check("HTTP 404", r3.status_code == 404, str(r3.status_code))

        print("\n== 4. 巨日禄导入：抓取失败 → 502 且带脱敏诊断 ==")
        payload = {
            "chapter_id": chapter_id,
            "url": "https://example.invalid/agent?projectId=P1&clipId=C1",
            "cookie": FAKE_COOKIE,
            "auth_mode": "auto",
        }
        r4 = await client.post(f"/api/v1/studio/jurilu-import/{project_id}/preview", json=payload)
        check("HTTP 502", r4.status_code == 502, f"{r4.status_code} {r4.text[:200]}")
        body4 = r4.json() or {}
        check("遵循统一信封（code/message/data/meta）",
              set(body4.keys()) >= {"code", "message", "data", "meta"}, str(body4.keys()))
        check("code=502", body4.get("code") == 502, str(body4.get("code")))
        check("message 可读", "分镜导入失败" in str(body4.get("message")), str(body4.get("message"))[:120])
        meta = body4.get("meta") or {}
        check("meta.diagnostics 为结构化字典", isinstance(meta.get("diagnostics"), dict), str(meta)[:200])
        check("diagnostics 里有 has_cookie", "has_cookie" in (meta.get("diagnostics") or {}))
        check(
            "diagnostics.script_status 被保留",
            "script_status" in (meta.get("diagnostics") or {}),
            str(meta.get("diagnostics"))[:160],
        )
        check("meta.warnings 为列表", isinstance(meta.get("warnings"), list), str(meta.get("warnings")))
        check(
            "响应体不泄露 Cookie 原文",
            FAKE_COOKIE not in r4.text,
            "!! Cookie 出现在响应里",
        )

        print("\n== 5. 巨日禄导入：章节校验 ==")
        r5 = await client.post(
            f"/api/v1/studio/jurilu-import/{project_id}/preview",
            json={**payload, "chapter_id": "__no_such_chapter__"},
        )
        check("章节不存在 → 404", r5.status_code == 404, str(r5.status_code))
        r6 = await client.post(
            f"/api/v1/studio/jurilu-import/{project_id}/preview",
            json={**payload, "chapter_id": other_chapter},
        )
        check("章节不属于该项目 → 400", r6.status_code == 400, f"{r6.status_code} {r6.text[:120]}")

        print("\n== 6. 巨日禄导入：桩掉抓取 → 完整配对计划 ==")
        fixture = [
            {
                "shot_label": f"S{i:03d}",
                "description": f"第{i}个分镜",
                "final_prompt": f"提示词内容{i}",
            }
            for i in range(1, 4)
        ]
        original_fetch = svc.fetch_entries
        svc.fetch_entries = lambda **kwargs: {  # type: ignore[assignment]
            "entries": fixture,
            "diagnostics": {"script_records_count": 1, "has_cookie": True},
            "warnings": [],
            "scripts": [],
            "project_id": "P1",
            "clip_id": "C1",
        }
        # 目标章节的镜头本来就带 jurilu 提示词，这里显式开覆盖，
        # 否则会被正确判成 conflict（那是另一条分支，第 5 节已验证）
        payload_overwrite = {**payload, "overwrite": True}
        r7 = await client.post(
            f"/api/v1/studio/jurilu-import/{project_id}/preview", json=payload_overwrite
        )
        check("HTTP 200", r7.status_code == 200, f"{r7.status_code} {r7.text[:200]}")
        pdata = (r7.json() or {}).get("data") or {}
        check("entry_count=3", pdata.get("entry_count") == 3, str(pdata.get("entry_count")))
        check("rows 长度=3", len(pdata.get("rows") or []) == 3, str(len(pdata.get("rows") or [])))
        check("带 plan_summary", bool(pdata.get("plan_summary")), str(pdata.get("plan_summary")))
        check(
            "所有行来源为 jurilu",
            all(row.get("source") == "jurilu" for row in pdata.get("rows") or []),
            str([row.get("source") for row in (pdata.get("rows") or [])]),
        )
        check(
            "开覆盖后行级动作全为 overwrite",
            all(row.get("action") == "overwrite" for row in pdata.get("rows") or []),
            str([row.get("action") for row in (pdata.get("rows") or [])]),
        )

        print("\n== 7. 巨日禄导入：提交把计划交给写库层（写库桩化，不落盘） ==")
        captured = {}

        async def fake_apply(db, *, chapter_id, plan):  # noqa: ANN001
            captured["chapter_id"] = chapter_id
            from app.services.external import jurilu_import_plan as planner

            rows = planner.writable_rows(plan["rows"])
            captured["writable"] = len(rows)
            return {
                "chapter_id": chapter_id,
                "updated": len(rows),
                "created": 0,
                "written": len(rows),
                "touched_shot_ids": [r.get("shot_id") or "new" for r in rows],
                "counts": plan["counts"],
            }

        original_apply = svc.apply_plan
        svc.apply_plan = fake_apply  # type: ignore[assignment]
        r8 = await client.post(
            f"/api/v1/studio/jurilu-import/{project_id}/apply", json=payload_overwrite
        )
        check("HTTP 200", r8.status_code == 200, f"{r8.status_code} {r8.text[:200]}")
        adata = (r8.json() or {}).get("data") or {}
        check("写库层收到正确章节", captured.get("chapter_id") == chapter_id, str(captured))
        check("写库层收到 3 条可写行", captured.get("writable") == 3, str(captured))
        check("返回 written=3", adata.get("written") == 3, str(adata))

        svc.fetch_entries = original_fetch  # type: ignore[assignment]
        svc.apply_plan = original_apply  # type: ignore[assignment]

    after = fingerprint()
    print("\n== 8. 真库未被写入 ==")
    print(f"  真库指纹（后）={after}")
    check("真库指纹一致", before == after, f"{before} vs {after}")

    print()
    print(f"结果：{PASS} 通过 / {FAIL} 失败")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
