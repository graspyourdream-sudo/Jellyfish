"""巨日禄分镜导入 —— 取数 + 落库服务。

分工
----
* 抓取与解析：复用搬运过来的 ``jurilu_agent_import``（零第三方依赖，纯 stdlib）。
* 配对判断：``jurilu_import_plan``（纯函数，可沙箱自检）。
* 本文件只负责"把计划落到 Jellyfish 库上"，以及把结果整理成前端能用的形状。

安全约定（沿用中控台口径）
--------------------------
* Cookie / Authorization **不落库、不落日志、不回显**；
* 抓取日志的脱敏由 ``jurilu_agent_import`` 内部完成（``ph_phc_xxx`` → ``<COOKIE_VAL>``）；
* 本模块不打印任何请求头。
"""

from __future__ import annotations

import uuid
from typing import Any, Dict, List, Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.studio import (
    CameraAngle,
    CameraMovement,
    CameraShotType,
    Chapter,
    Shot,
    ShotDetail,
    VFXType,
)
from app.services.common import entity_not_found, require_entity
from app.services.external import jurilu_agent_import as jurilu
from app.services.external import jurilu_import_plan as planner


class JuriluImportError(RuntimeError):
    """巨日禄抓取/解析失败（携带给前端看的诊断信息）。"""

    def __init__(self, message: str, diagnostics: Optional[Dict[str, Any]] = None,
                 warnings: Optional[List[str]] = None) -> None:
        super().__init__(message)
        self.diagnostics = diagnostics or {}
        self.warnings = warnings or []


def fetch_entries(
    *,
    url: str,
    cookie: str,
    authorization: str = "",
    auth_mode: str = "auto",
    referer: str = "",
    api_url_override: str = "",
) -> Dict[str, Any]:
    """抓取巨日禄分镜并规范化。**纯网络 + 纯计算，不碰数据库。**

    Returns:
        ``{"entries": [...], "diagnostics": {...}, "warnings": [...],
           "scripts": [...], "project_id": str, "clip_id": str}``
    """
    source_url = jurilu.resolve_agent_list_url(url)
    if not source_url:
        raise JuriluImportError("缺少巨日禄页面 URL（需带 projectId / clipId 参数）")

    resolved_cookie = jurilu.resolve_cookie(cookie)
    resolved_auth, auth_note = jurilu.resolve_authorization(authorization, auth_mode)

    result = jurilu.fetch_all_storyboards(
        source_url=source_url,
        cookie_text=resolved_cookie,
        authorization=resolved_auth,
        # 巨日禄按 Referer 判来源：留空时用页面 URL 兜底（原中控台同口径 app.py:18478）
        referer=(referer or source_url),
        api_url_override=api_url_override,
    )
    diagnostics = dict(result.get("diagnostics") or {})
    diagnostics["auth_header_mode"] = auth_note
    diagnostics["has_cookie"] = bool(resolved_cookie)
    diagnostics["has_auth"] = bool(resolved_auth)
    diagnostics["has_referer"] = bool(referer)
    # 401 排查用的**请求头形状**（只有头名与布尔值，绝不含头值）：
    # 「是否带 Cookie / Cookie 里是否有 Authorization 项 / 是否错发了 HTTP Authorization 头」
    facts = dict(diagnostics.get("script_request_facts") or {})
    diagnostics["request_header_names"] = list(facts.get("request_header_names") or [])
    diagnostics["sent_cookie_header"] = bool(facts.get("sent_cookie_header"))
    diagnostics["sent_authorization_header"] = bool(facts.get("sent_authorization_header"))
    diagnostics["cookie_has_authorization_item"] = bool(
        facts.get("cookie_has_authorization_item")
    )

    if not result.get("ok"):
        raise JuriluImportError(
            "分镜导入失败（未解析到分镜，或接口拒绝）",
            diagnostics=diagnostics,
            warnings=list(result.get("warnings") or []),
        )

    entries = jurilu.normalize_external_agent_prompts(list(result.get("storyboards") or []))
    pid, cid = jurilu.extract_project_clip_from_url(source_url)
    return {
        "entries": entries,
        "diagnostics": diagnostics,
        "warnings": list(result.get("warnings") or []),
        "scripts": list(result.get("scripts") or []),
        "project_id": pid,
        "clip_id": cid,
    }


async def load_chapter_shots(db: AsyncSession, chapter_id: str) -> List[Dict[str, Any]]:
    """读章节内已有镜头（含当前 video_prompt），供配对使用。"""
    rows = await db.execute(
        select(Shot.id, Shot.index, Shot.title, ShotDetail.video_prompt)
        .join(ShotDetail, ShotDetail.id == Shot.id, isouter=True)
        .where(Shot.chapter_id == chapter_id)
        .order_by(Shot.index)
    )
    return [
        {
            "id": row.id,
            "index": int(row.index or 0),
            "title": row.title or "",
            "video_prompt": row.video_prompt or "",
        }
        for row in rows.all()
    ]


async def build_preview(
    db: AsyncSession,
    *,
    chapter_id: str,
    url: str,
    cookie: str,
    authorization: str = "",
    auth_mode: str = "auto",
    referer: str = "",
    api_url_override: str = "",
    create_missing: bool = True,
    overwrite: bool = False,
) -> Dict[str, Any]:
    """抓取 + 配对，产出一份"将要发生什么"的预览。**不写库。**"""
    await require_entity(
        db, Chapter, chapter_id, detail=entity_not_found("Chapter"), status_code=404
    )

    fetched = fetch_entries(
        url=url,
        cookie=cookie,
        authorization=authorization,
        auth_mode=auth_mode,
        # 巨日禄按 Referer 判来源：留空时由 fetch_entries 统一用页面 URL 兜底
        # （这里**不能**引用 source_url —— 那是 fetch_entries 里的局部变量，
        #   在 build_preview 作用域里并不存在，写了就是 NameError）
        referer=referer,
        api_url_override=api_url_override,
    )
    shots = await load_chapter_shots(db, chapter_id)
    plan = planner.build_import_plan(
        fetched["entries"], shots, create_missing=create_missing, overwrite=overwrite
    )

    return {
        "chapter_id": chapter_id,
        "chapter_shot_count": len(shots),
        "entry_count": len(fetched["entries"]),
        "plan": plan,
        "plan_summary": planner.plan_summary(plan),
        "diagnostics": fetched["diagnostics"],
        "warnings": fetched["warnings"],
        "jurilu_project_id": fetched["project_id"],
        "jurilu_clip_id": fetched["clip_id"],
        "source_url": jurilu.resolve_agent_list_url(url),
    }


async def apply_plan(
    db: AsyncSession,
    *,
    chapter_id: str,
    plan: Dict[str, Any],
) -> Dict[str, Any]:
    """执行计划。**写库。**

    只处理 ``update`` / ``overwrite`` / ``create`` 三种动作；
    其余动作仅计数，不落库。
    """
    await require_entity(
        db, Chapter, chapter_id, detail=entity_not_found("Chapter"), status_code=404
    )

    updated = 0
    created = 0
    touched_shot_ids: List[str] = []

    for row in planner.writable_rows(plan.get("rows") or []):
        action = row["action"]
        text = str(row.get("prompt") or "").strip()
        source = str(row.get("source") or planner.JURILU_SOURCE)
        if not text:
            continue

        if action in (planner.ACTION_UPDATE, planner.ACTION_OVERWRITE):
            shot_id = str(row.get("shot_id") or "")
            if not shot_id:
                continue
            await db.execute(
                update(ShotDetail)
                .where(ShotDetail.id == shot_id)
                .values(video_prompt=text, video_prompt_source=source)
            )
            updated += 1
            touched_shot_ids.append(shot_id)
            continue

        if action == planner.ACTION_CREATE:
            shot_id = str(uuid.uuid4())
            title = str(row.get("title") or "").strip() or f"镜头 {row.get('index') or 1}"
            db.add(
                Shot(
                    id=shot_id,
                    chapter_id=chapter_id,
                    index=int(row.get("index") or 1),
                    title=title[:255],
                    script_excerpt=str(row.get("summary") or "")[:2000],
                )
            )
            db.add(
                ShotDetail(
                    id=shot_id,
                    camera_shot=CameraShotType.ms,
                    angle=CameraAngle.eye_level,
                    movement=CameraMovement.static,
                    follow_atmosphere=True,
                    vfx_type=VFXType.none,
                    duration=5,
                    video_prompt=text,
                    video_prompt_source=source,
                )
            )
            created += 1
            touched_shot_ids.append(shot_id)

    await db.flush()

    return {
        "chapter_id": chapter_id,
        "updated": updated,
        "created": created,
        "written": updated + created,
        "touched_shot_ids": touched_shot_ids,
        "counts": plan.get("counts") or {},
    }


__all__ = [
    "JuriluImportError",
    "fetch_entries",
    "load_chapter_shots",
    "build_preview",
    "apply_plan",
]
