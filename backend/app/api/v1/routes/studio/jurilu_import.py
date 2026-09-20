"""巨日禄 Cookie 导入路由（预览 + 写入）。

设计点
------
* 两个端点都**重新抓取一次**，不依赖服务端会话状态 —— 前端不需要把计划回传，
  也就无法被篡改导致写到计划外的镜头。
* **不写库的预览**与**写库的提交**分开：预览可反复调，提交才落盘。
* Cookie / Authorization 只作为请求体传入，**不回显、不落库**；失败诊断落日志时也只写
  状态码 / 请求头**名字** / 布尔值 / 已脱敏的响应片段，不含任何凭证内容。
* 抓取失败（Cookie 过期 / URL 不对）返回 502，结构化诊断放在响应的 ``meta`` 里
  —— 本项目有全局异常处理器，会把 ``HTTPException.detail`` 拍平成一行字符串，
  诊断信息若走 ``detail`` 就丢了结构。这里直接构造 JSONResponse 绕开该拍平。
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db
from app.models.studio import Chapter
from app.schemas.common import ApiResponse, success_response
from app.services.external import jurilu_import_plan as planner
from app.services.external import jurilu_import_service as svc

router = APIRouter()
logger = logging.getLogger(__name__)


class JuriluImportRequest(BaseModel):
    """导入入参。字段命名对齐中控台面板的 5 个输入 + 2 个开关。"""

    chapter_id: str = Field(description="目标章节 ID（提示词写到这个章节的镜头上）")
    url: str = Field(description="巨日禄页面 URL（需含 projectId / clipId）")
    cookie: str = Field(default="", description="整段「复制全部 Cookie」（不保存、不写日志）")
    authorization: str = Field(default="", description="Authorization 单值（可留空）")
    auth_mode: str = Field(default="auto", description="自动 / 不发送 / 原样发送 / Bearer")
    referer: str = Field(default="", description="Referer 覆盖（可留空）")
    api_url_override: str = Field(default="", description="高级：API 覆盖地址（可留空）")
    create_missing: bool = Field(default=True, description="分镜多于镜头时是否新建镜头")
    overwrite: bool = Field(default=False, description="目标镜头已有不同提示词时是否覆盖")


class JuriluPlanRowRead(BaseModel):
    """配对计划中的一行。"""

    action: str
    order: int
    label: str
    summary: str
    prompt: str
    source: str
    reason: str = ""
    shot_id: str = ""
    index: int = 0
    title: str = ""


class JuriluPreviewRead(BaseModel):
    """预览结果：将要发生什么。"""

    project_id: str
    chapter_id: str
    chapter_shot_count: int
    entry_count: int
    plan_summary: str
    counts: dict[str, int]
    rows: list[JuriluPlanRowRead]
    diagnostics: dict = Field(default_factory=dict, description="脱敏后的抓取诊断")
    warnings: list[str] = Field(default_factory=list)
    jurilu_project_id: str = ""
    jurilu_clip_id: str = ""
    source_url: str = ""


class JuriluApplyRead(BaseModel):
    """写入结果。"""

    project_id: str
    chapter_id: str
    updated: int
    created: int
    written: int
    touched_shot_ids: list[str]
    counts: dict[str, int]
    plan_summary: str


async def _require_chapter_in_project(
    db: AsyncSession, *, project_id: str, chapter_id: str
) -> Chapter:
    row = await db.execute(select(Chapter).where(Chapter.id == chapter_id))
    chapter = row.scalar_one_or_none()
    if chapter is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chapter not found")
    if str(getattr(chapter, "project_id", "")) != str(project_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="章节不属于该项目",
        )
    return chapter


def _gateway_error(exc: svc.JuriluImportError) -> JSONResponse:
    """把抓取失败整理成统一信封，诊断信息放 ``meta``（保持结构，不被拍平）。"""
    # 同时把**脱敏**诊断落一份服务端日志：页面上只有一行摘要，
    # 「第一步 200 / 第二步 0 条」这类问题没有服务端留证就只能靠猜。
    # 内容只含 状态码 / 头名 / 布尔值 / 已脱敏响应片段，绝无凭证值。
    logger.warning(
        "jurilu 导入失败：%s ｜ diagnostics=%s ｜ warnings=%s",
        exc,
        json.dumps(exc.diagnostics, ensure_ascii=False, default=str)[:2000],
        json.dumps(exc.warnings, ensure_ascii=False, default=str)[:800],
    )
    body = ApiResponse[None](
        code=status.HTTP_502_BAD_GATEWAY,
        message=str(exc),
        data=None,
        meta={
            "diagnostics": exc.diagnostics,
            "warnings": exc.warnings,
        },
    ).model_dump()
    return JSONResponse(status_code=status.HTTP_502_BAD_GATEWAY, content=body)


@router.post(
    "/{project_id}/preview",
    response_model=ApiResponse[JuriluPreviewRead],
    summary="巨日禄导入预览（抓取 + 配对，不写库）",
)
async def preview_jurilu_import(
    project_id: str,
    body: JuriluImportRequest,
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[JuriluPreviewRead] | JSONResponse:
    await _require_chapter_in_project(db, project_id=project_id, chapter_id=body.chapter_id)
    try:
        result = await svc.build_preview(
            db,
            chapter_id=body.chapter_id,
            url=body.url,
            cookie=body.cookie,
            authorization=body.authorization,
            auth_mode=body.auth_mode,
            referer=body.referer,
            api_url_override=body.api_url_override,
            create_missing=body.create_missing,
            overwrite=body.overwrite,
        )
    except svc.JuriluImportError as exc:
        return _gateway_error(exc)

    plan = result["plan"]
    return success_response(
        JuriluPreviewRead(
            project_id=project_id,
            chapter_id=result["chapter_id"],
            chapter_shot_count=result["chapter_shot_count"],
            entry_count=result["entry_count"],
            plan_summary=result["plan_summary"],
            counts=plan["counts"],
            rows=[JuriluPlanRowRead(**row) for row in plan["rows"]],
            diagnostics=result["diagnostics"],
            warnings=result["warnings"],
            jurilu_project_id=result["jurilu_project_id"],
            jurilu_clip_id=result["jurilu_clip_id"],
            source_url=result["source_url"],
        )
    )


@router.post(
    "/{project_id}/apply",
    response_model=ApiResponse[JuriluApplyRead],
    summary="巨日禄导入提交（抓取 + 配对 + 写库）",
)
async def apply_jurilu_import(
    project_id: str,
    body: JuriluImportRequest,
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[JuriluApplyRead] | JSONResponse:
    await _require_chapter_in_project(db, project_id=project_id, chapter_id=body.chapter_id)
    try:
        result = await svc.build_preview(
            db,
            chapter_id=body.chapter_id,
            url=body.url,
            cookie=body.cookie,
            authorization=body.authorization,
            auth_mode=body.auth_mode,
            referer=body.referer,
            api_url_override=body.api_url_override,
            create_missing=body.create_missing,
            overwrite=body.overwrite,
        )
    except svc.JuriluImportError as exc:
        return _gateway_error(exc)

    if not planner.writable_rows(result["plan"]["rows"]):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "没有可写入的内容：可能是全部条目为空、全部已存在，"
                "或目标镜头已有不同提示词而你没开「允许覆盖」。"
                f"（{result['plan_summary']}）"
            ),
        )

    written = await svc.apply_plan(db, chapter_id=body.chapter_id, plan=result["plan"])
    return success_response(
        JuriluApplyRead(
            project_id=project_id,
            chapter_id=written["chapter_id"],
            updated=written["updated"],
            created=written["created"],
            written=written["written"],
            touched_shot_ids=written["touched_shot_ids"],
            counts=written["counts"],
            plan_summary=result["plan_summary"],
        )
    )


__all__ = ["router"]
