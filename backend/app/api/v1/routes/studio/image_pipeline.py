"""P3 出图管线路由：出图服务对接 / 定妆照垫图 / 提示词包 / 直提出视频。

挂载：``/api/v1/studio/image-pipeline``（见 ``app/api/v1/routes/studio/__init__.py``）。

约定：
- preview / plan 接口**永不触网**；
- submit 接口默认被 DRY_RUN 拦截，返回 ``dry_run: true`` 的占位结果；
- 失败沿用项目统一 ``ApiResponse`` 信封，结构化明细放 ``meta.error``；
- 全部为同步请求-响应，不排队、不建后台任务。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db
from app.schemas.common import ApiResponse, success_response
from app.schemas.studio.image_pipeline import (
    AdoptImageRead,
    AdoptImageRequest,
    FrameSubmitPlanRead,
    FrameSubmitPlanRequest,
    FrameSubmitRead,
    FrameSubmitRequest,
    ImagePlanPreviewRead,
    ImagePlanPreviewRequest,
    ImageServiceStatusRead,
    ImageSubmitRead,
    ImageSubmitRequest,
    ImageTaskQueryRead,
    PromptPackageRead,
    PromptPackageRequest,
    ReferenceImageRead,
    VideoSubmitPlanRead,
    VideoSubmitPlanRequest,
    VideoSubmitRead,
    VideoSubmitRequest,
)
from app.services import paid_outlet_guard
from app.services.studio.image_pipeline import external_image_client as image_client
from app.services.studio.image_pipeline import reference_preflight
from app.services.studio.image_pipeline.frame_submit import (
    build_frame_submit_plan,
    submit_frame,
)
from app.services.studio.image_pipeline.image_pipeline import (
    build_targets,
    submit_targets,
    summarize_results,
    summary_outcome,
)
from app.services.studio.image_pipeline.adopt import adopt_generated_image
from app.services.studio.image_pipeline.prompt_package import build_prompt_package
from app.services.studio.image_pipeline.reference_resolver import resolve_references
from app.services.studio.image_pipeline.video_submit import (
    build_video_submit_plan,
    submit_video,
)
from app.services.studio.llm_orchestration import dry_run

router = APIRouter()

_STRUCTURED_ERROR_CODE = "image_pipeline_error"


def _error_envelope(*, code: int, detail: Any) -> JSONResponse:
    """把服务层的结构化错误塞进统一 ApiResponse 信封的 meta.error 里。"""
    if isinstance(detail, dict):
        message = str(detail.get("message") or detail.get("code") or "error")
        error = detail
    else:
        message = str(detail)
        error = {"code": _STRUCTURED_ERROR_CODE, "message": message}
    body = ApiResponse[None](code=code, message=message, data=None, meta={"error": error}).model_dump()
    return JSONResponse(status_code=code, content=body)


def _guard_blocked_envelope(exc: Exception) -> JSONResponse:
    """守卫拦截 → 409 + 明确的放开方式（不泄露任何密钥）。

    明细统一由 ``paid_outlet_guard.blocked_payload`` 生产，避免这里另写一套：
    ``code`` / ``reason``（区分演练模式 vs 未确认真实模式）/ 中文 ``message`` /
    中文 ``how_to_enable`` / ``enable_steps`` / ``guard``。
    """
    return paid_outlet_guard.blocked_envelope(exc)


async def preflight_guard(candidates: Any, *, hint: str = "") -> Any:
    """提交前的参考图可达性预检（**每个真实提交端点都接这一个入口**）。

    真实故障 A：传给上游的参考图地址只在本机可读（匿名访问 404），上游取不到图 →
    任务 failed（原文「无法获取输入媒体 URL（404/410）」）。所以在**真正提交之前**
    逐张做匿名 HTTP 探活；不通过的**不提交**，返回结构化中文错误（哪个资产/哪张图、
    实际状态码、怎么修），并明确「没有产生任何付费调用」。

    演练模式（DRY_RUN）下由服务层短路（`dry_run_enabled()` 时不会有真实提交），
    这里再兜一层：**演练模式一次都不探活**，与守卫同口径。
    """
    if dry_run.dry_run_enabled():
        return None
    return await reference_preflight.preflight_or_raise(candidates, hint=hint)


# ---------- 状态 ----------


@router.get(
    "/status",
    response_model=ApiResponse[ImageServiceStatusRead],
    summary="出图服务对接状态（DRY_RUN 下不探测）",
)
async def get_image_pipeline_status() -> ApiResponse[ImageServiceStatusRead]:
    """返回出图服务基址、守卫状态与契约能力；DRY_RUN 下**不发起健康探测**。"""
    probe: dict[str, Any] | None = None
    skipped = ""
    if dry_run.dry_run_enabled():
        skipped = f"DRY_RUN 开启（{dry_run.DRY_RUN_ENV}），未探测出图服务。"
    elif not dry_run.real_call_confirmed():
        skipped = f"未确认真实调用（需要 {dry_run.CONFIRM_ENV}=1），未探测出图服务。"
    else:
        try:
            probe = await image_client.probe_health()
        except image_client.ImageServiceError as exc:
            skipped = f"探测失败：{exc}"
        except dry_run.DryRunBlocked as exc:  # pragma: no cover - 上面已分支
            skipped = str(exc)

    return success_response(
        ImageServiceStatusRead(
            base_url=image_client.service_base_url(),
            configured_env=image_client.SERVICE_URL_ENV,
            guard=dry_run.state(),
            service_asset_types=list(image_client.SERVICE_ASSET_TYPES),
            generation_types=dict(image_client.DEFAULT_GENERATION_TYPE),
            probe=probe,
            probe_skipped_reason=skipped,
        )
    )


# ---------- 出图提交计划 ----------


@router.post(
    "/plan/preview",
    response_model=ApiResponse[ImagePlanPreviewRead],
    summary="出图提交计划预览（定妆照 / 垫图批量，不触网）",
)
async def preview_image_plan(
    body: ImagePlanPreviewRequest,
    db: AsyncSession = Depends(get_db),
) -> Any:
    """组装提交给出图服务的计划：幂等键、垫图来源、OSS 对象键模板，全部只读。"""
    try:
        targets, warnings = await build_targets(
            db,
            project_id=body.project_id,
            asset_type=body.asset_type,
            stage=body.stage,
            asset_ids=body.asset_ids,
            prompt_overrides={item.asset_id: item.prompt for item in body.prompt_overrides},
            use_primary_reference=body.use_primary_reference,
            aspect_ratio=body.aspect_ratio,
            image_model=body.image_model,
            negative_prompt=body.negative_prompt,
        )
        references: dict[str, ReferenceImageRead] = {}
        if body.stage == "reference_batch" and body.use_primary_reference:
            asset_ids = [target.source_asset_id for target in targets]
            resolved = await resolve_references(db, asset_type=body.asset_type, asset_ids=asset_ids)
            references = {
                asset_id: ReferenceImageRead(
                    asset_id=item.asset_id,
                    asset_type=item.asset_type,
                    file_id=item.file_id,
                    url=item.url,
                    view_angle=item.view_angle,
                    quality_level=item.quality_level,
                    is_primary=item.is_primary,
                    resolved_from=item.resolved_from,
                    warnings=list(item.warnings),
                )
                for asset_id, item in resolved.items()
            }
    except ValueError as exc:
        return _error_envelope(code=400, detail=str(exc))
    except HTTPException as exc:
        return _error_envelope(code=exc.status_code, detail=exc.detail)

    plan_warnings = list(warnings)
    for reference in references.values():
        plan_warnings.extend(reference.warnings)

    data = ImagePlanPreviewRead(
        project_id=body.project_id,
        asset_type=body.asset_type,
        stage=body.stage,
        targets=[target.to_read() for target in targets],
        references=list(references.values()),
        warnings=plan_warnings,
        summary={
            "target_count": len(targets),
            "with_reference": len([target for target in targets if target.reference_image]),
            "without_reference": len([target for target in targets if not target.reference_image]),
        },
        dry_run=dry_run.dry_run_enabled(),
    )
    return success_response(data)


@router.post(
    "/submit",
    response_model=ApiResponse[ImageSubmitRead],
    summary="提交出图任务（DRY_RUN 下返回占位结果，不触网）",
)
async def submit_image_plan(
    body: ImageSubmitRequest,
    db: AsyncSession = Depends(get_db),
) -> Any:
    """受守卫的出图提交。默认 DRY_RUN：返回占位 task_id 与不可达占位地址。

    提交前会逐张探活每一条垫图 URL（``preflight_guard``）：不可达就**一个请求都不提交**，
    返回结构化中文错误（哪张图 / 哪个资产 / 实际状态码 / 怎么修），且不产生任何付费调用。
    """
    try:
        targets, warnings = await build_targets(
            db,
            project_id=body.project_id,
            asset_type=body.asset_type,
            stage=body.stage,
            asset_ids=body.asset_ids,
            prompt_overrides={item.asset_id: item.prompt for item in body.prompt_overrides},
            use_primary_reference=body.use_primary_reference,
            aspect_ratio=body.aspect_ratio,
            image_model=body.image_model,
            negative_prompt=body.negative_prompt,
        )
        results = await submit_targets(
            targets,
            wait_seconds=body.wait_seconds,
            preflight=preflight_guard,
        )
    except ValueError as exc:
        return _error_envelope(code=400, detail=str(exc))
    except paid_outlet_guard.PaidOutletBlocked as exc:
        # 依赖式守卫（服务层 require_outlet）抛的是 HTTPException 子类，
        # 必须排在下面那条 HTTPException 之前，否则结构化明细会被压成一行字符串。
        return _guard_blocked_envelope(exc)
    except HTTPException as exc:
        return _error_envelope(code=exc.status_code, detail=exc.detail)
    except dry_run.DryRunBlocked as exc:
        return _guard_blocked_envelope(exc)
    except image_client.ImageServiceError as exc:
        return _error_envelope(
            code=502,
            detail={"code": "image_service_failed", "message": str(exc), "provider_status_code": exc.status_code},
        )

    if not targets:
        warnings.append("没有可提交的目标，未发起任何请求。")
    summary = summarize_results(results)
    return success_response(
        ImageSubmitRead(
            project_id=body.project_id,
            asset_type=body.asset_type,
            stage=body.stage,
            results=results,
            summary=summary,
            outcome=str(summary.get("outcome") or summary_outcome(results)),
            warnings=warnings,
            guard_status=dry_run.short_status(),
        )
    )


@router.get(
    "/task/{service_task_id}",
    response_model=ApiResponse[ImageTaskQueryRead],
    summary="查询出图任务（回读 OSS 地址）",
)
async def query_image_task(service_task_id: str) -> Any:
    """查询出图任务状态与产物地址。DRY_RUN 下不触网，直接返回未创建说明。"""
    if dry_run.dry_run_enabled():
        return success_response(
            ImageTaskQueryRead(
                service_task_id=service_task_id,
                status="dry_run",
                dry_run=True,
                error_message="[DRY_RUN] 未创建任何出图任务，因此没有可查询的真实任务。",
            )
        )
    try:
        detail = await image_client.get_asset_image_task(service_task_id)
    except dry_run.DryRunBlocked as exc:
        return _guard_blocked_envelope(exc)
    except image_client.ImageServiceError as exc:
        return _error_envelope(
            code=502,
            detail={"code": "image_service_failed", "message": str(exc), "provider_status_code": exc.status_code},
        )
    return success_response(
        ImageTaskQueryRead(
            service_task_id=detail.service_task_id,
            status=detail.status,
            oss_url=detail.oss_url,
            local_path=detail.local_path,
            images=detail.images,
            error_message=detail.error_message,
        )
    )


# ---------- 直提出视频 ----------


@router.post(
    "/video-plan/preview",
    response_model=ApiResponse[VideoSubmitPlanRead],
    summary="直提出视频的计划预览（不建任务、不触网）",
)
async def preview_video_submit_plan(
    body: VideoSubmitPlanRequest,
    db: AsyncSession = Depends(get_db),
) -> Any:
    """解析供应商/模型/参考图/提示词，如实标注会踩的坑，但不提交任何任务。"""
    try:
        data = await build_video_submit_plan(db, body=body)
    except HTTPException as exc:
        return _error_envelope(code=exc.status_code, detail=exc.detail)
    return success_response(data)


@router.post(
    "/video-submit",
    response_model=ApiResponse[VideoSubmitRead],
    summary="直提出视频（默认被 DRY_RUN 拦截，不产生费用）",
)
async def submit_video_route(
    body: VideoSubmitRequest,
    db: AsyncSession = Depends(get_db),
) -> Any:
    """同步提交一次视频生成；DRY_RUN 开启时返回 dry_run 占位结果，不发任何请求。

    真实提交前会做**第二层可达性复核**（``preflight_guard``）：本次真正发往供应商的
    首/尾/关键帧参考图与参考音频地址，逐张匿名探活；不可达就不发请求、不产生费用
    （真实故障 A 就是这里把只在本机可读的地址交给了上游）。
    """
    try:
        data = await submit_video(
            db,
            body=body,
            timeout_seconds=body.timeout_seconds,
            preflight=preflight_guard,
        )
    except paid_outlet_guard.PaidOutletBlocked as exc:
        return _guard_blocked_envelope(exc)
    except HTTPException as exc:
        return _error_envelope(code=exc.status_code, detail=exc.detail)
    except dry_run.DryRunBlocked as exc:
        return _guard_blocked_envelope(exc)
    except dry_run.RealCallNotConfirmed as exc:
        return _guard_blocked_envelope(exc)
    return success_response(data)


# ---------- 关键帧出图（同进程内联） ----------


@router.post(
    "/frame-plan/preview",
    response_model=ApiResponse[FrameSubmitPlanRead],
    summary="关键帧出图计划预览（不触网、不建任务、不写库）",
)
async def preview_frame_plan(
    body: FrameSubmitPlanRequest,
    db: AsyncSession = Depends(get_db),
) -> Any:
    """如实展示「这一帧会用什么提示词、带哪些参考图、什么画幅」——全部只读。"""
    try:
        plan = await build_frame_submit_plan(db, body=body)
    except HTTPException as exc:
        return _error_envelope(code=exc.status_code, detail=exc.detail)
    return success_response(plan.to_read())


@router.post(
    "/frame-submit",
    response_model=ApiResponse[FrameSubmitRead],
    summary="关键帧出图（同进程内联执行；DRY_RUN 下只回计划不写库）",
)
async def submit_frame_route(
    body: FrameSubmitRequest,
    db: AsyncSession = Depends(get_db),
) -> Any:
    """在**同一个进程内**跑完一次关键帧出图，并把结果写进 ``shot_frame_images.file_id``。

    为什么不用队列：本机没有 broker/worker，队列路径只会留下一条永远不执行的「排队中」，
    用户看到的就是「点了生成什么也没发生」。同进程内联执行是 P3 直提端点既有的做法。

    提交前会逐张探活参考图（``preflight_guard``）：不可达就在**写库/建任务之前**拒绝，
    返回结构化中文错误，一次付费调用都不产生。
    """
    try:
        data = await submit_frame(db, body=body, preflight=preflight_guard)
    except paid_outlet_guard.PaidOutletBlocked as exc:
        return _guard_blocked_envelope(exc)
    except HTTPException as exc:
        return _error_envelope(code=exc.status_code, detail=exc.detail)
    except dry_run.DryRunBlocked as exc:
        return _guard_blocked_envelope(exc)
    except dry_run.RealCallNotConfirmed as exc:
        return _guard_blocked_envelope(exc)
    except image_client.ImageServiceError as exc:
        return _error_envelope(
            code=502,
            detail={"code": "image_service_failed", "message": str(exc), "provider_status_code": exc.status_code},
        )
    return success_response(data)


# ---------- 采纳 / 提示词包 ----------


@router.post(
    "/adopt",
    response_model=ApiResponse[AdoptImageRead],
    summary="采纳生成的图片到资产图片槽位（落库，刷新后仍在）",
)
async def adopt_generated_image_route(
    body: AdoptImageRequest,
    db: AsyncSession = Depends(get_db),
) -> Any:
    """把出图结果（oss_url / local_path）下载入库并写回图片槽位。

    这是断点③的落点：出图提交本身不写库，必须由用户显式"采纳"才落正式产物。
    DRY_RUN 占位地址会被拒绝。
    """
    try:
        adopted = await adopt_generated_image(
            db,
            entity_type=body.entity_type,
            entity_id=body.entity_id,
            url=body.url,
            image_id=body.image_id,
            set_primary=body.set_primary,
            name=body.name or None,
        )
    except HTTPException as exc:
        return _error_envelope(code=exc.status_code, detail=exc.detail)
    except ValueError as exc:
        return _error_envelope(code=400, detail=str(exc))
    return success_response(AdoptImageRead(**adopted.to_read()))


@router.post(
    "/prompt-package",
    response_model=ApiResponse[PromptPackageRead],
    summary="提示词包导出（图片 + 视频 + 绑定资产 + 参考图，只读）",
)
async def export_prompt_package(
    body: PromptPackageRequest,
    db: AsyncSession = Depends(get_db),
) -> Any:
    """把一个项目/一批镜头打成提示词包（json + text + markdown），不写库、不出图。"""
    try:
        data = await build_prompt_package(db, body=body)
    except HTTPException as exc:
        return _error_envelope(code=exc.status_code, detail=exc.detail)
    return success_response(data)
