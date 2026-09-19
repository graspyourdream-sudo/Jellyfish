from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.task_manager import DeliveryMode, SqlAlchemyTaskStore, TaskManager
from app.dependencies import get_db
from app.models.task_links import GenerationTaskLink
from app.schemas.studio.shots import ShotVideoPromptPackRead
from app.services.film.generated_video import build_run_args, preview_prompt_and_images
from app.services.paid_outlet_guard import require_video_outlet
from app.services.studio.image_pipeline.video_submit import validate_legacy_video_input
from app.services.studio.video_audio_input import attach_shot_audio_to_video_input
from app.services.studio.shot_status import mark_shot_generating
from app.tasks.execute_task import enqueue_task_execution
from app.schemas.common import ApiResponse, created_response, success_response

from .common import TaskCreated, _CreateOnlyTask
from .video_request import VideoGenerationTaskRequest

logger = logging.getLogger(__name__)

router = APIRouter()


class VideoPromptPreviewResponse(BaseModel):
    prompt: str = Field(..., description="最终用于视频生成的提示词")
    images: list[str] = Field(default_factory=list, description="关联参考图 file_id 列表")
    pack: ShotVideoPromptPackRead | None = Field(None, description="视频提示词预览上下文包")



@router.post(
    "/tasks/video/preview-prompt",
    response_model=ApiResponse[VideoPromptPreviewResponse],
    status_code=200,
    summary="视频提示词预览",
)
async def preview_video_generation_prompt(
    body: VideoGenerationTaskRequest,
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[VideoPromptPreviewResponse]:
    """预览视频生成的提示词与自动关联参考图。"""
    prompt, images, pack = await preview_prompt_and_images(
        db,
        shot_id=body.shot_id,
        reference_mode=body.reference_mode,
        prompt=body.prompt,
        images=body.images,
    )
    return success_response(VideoPromptPreviewResponse(prompt=prompt, images=images, pack=pack))


@router.post(
    "/tasks/video",
    response_model=ApiResponse[TaskCreated],
    status_code=201,
    summary="视频生成（任务版）",
    dependencies=[Depends(require_video_outlet)],
)
async def create_video_generation_task(
    body: VideoGenerationTaskRequest,
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[TaskCreated]:
    """创建视频生成任务并后台执行，结果通过 /tasks/{task_id}/result 获取。

    会真实出视频（按次计费），因此先过 DRY_RUN 守卫：被拦截时返回 409，
    **不会**建任何任务行。
    """

    store = SqlAlchemyTaskStore(db)
    tm = TaskManager(store=store, strategies={})
    run_args = await build_run_args(
        db,
        shot_id=body.shot_id,
        reference_mode=body.reference_mode,
        prompt=body.prompt,
        images=body.images,
        ratio=body.ratio,
    )

    # 入参预检（建任务之前）：这条路径此前完全不做选项校验，而本项目镜头时长普遍是
    # 3–4s，低于 seedance-2.0-mini 的 min_seconds=5 —— 表现是"任务建出来、真花钱发出去、
    # 然后被供应商拒绝"。这里提前钳到最短时长/补上固定分辨率，或直接 422 拒绝。
    video_input = run_args.get("input") if isinstance(run_args.get("input"), dict) else None
    option_warnings: list[str] = []
    if video_input is None:
        # build_run_args 正常一定带 input；缺失说明上游被替换成了不完整实现，
        # 这里记一条 warning 而不是静默放过（任务执行阶段本来也会失败）。
        logger.warning("视频生成入参缺少 input 段，跳过预检：keys=%s", sorted(run_args.keys()))
    else:
        try:
            option_warnings = validate_legacy_video_input(video_input)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        for item in option_warnings:
            logger.warning("视频生成入参已自动修正：%s", item)

        # 断点④的声音侧：把镜头绑定的声音解析进生成入参。
        # 供应商支持音频输入时适配器会真的发出去；不支持时字段仍留在入参里（可追溯）
        # 并附一条明确提示，不做静默丢弃。
        try:
            audio_warnings = await attach_shot_audio_to_video_input(
                db,
                shot_id=body.shot_id,
                input_payload=video_input,
                provider=str(run_args.get("provider") or ""),
                model=str(video_input.get("model") or ""),
            )
        except Exception as exc:  # noqa: BLE001 - 声音是尽力而为的输入，绝不允许阻断出视频
            audio_warnings = [f"声音绑定解析失败（{exc}），本次生成不携带音频。"]
            logger.warning("视频生成声音入参解析失败：%s", exc)
        option_warnings.extend(audio_warnings)
        for item in audio_warnings:
            logger.info("视频生成音频入参：%s", item)

    task_record = await tm.create(
        task=_CreateOnlyTask(),
        mode=DeliveryMode.async_polling,
        task_kind="video_generation",
        run_args=run_args,
    )
    db.add(
        GenerationTaskLink(
            task_id=task_record.id,
            resource_type="video",
            relation_type="video",
            relation_entity_id=body.shot_id,
        )
    )
    await mark_shot_generating(db, shot_id=body.shot_id)

    # 确保任务记录已提交，避免后台 runner 新 session 查询不到任务行而无法更新状态。
    await db.commit()

    enqueue_task_execution(task_record.id)
    return created_response(
        TaskCreated(task_id=task_record.id),
        meta={"video_option_warnings": option_warnings} if option_warnings else None,
    )
