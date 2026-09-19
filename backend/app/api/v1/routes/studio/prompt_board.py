"""集级「视频提示词看板」路由（进入分镜工作台**之前**的主入口）。

流程口径见 `site/content/docs/plans/episode-video-prompt-batch-plan.md`：
一整集先在集页面批量生成或批量导入（7~20 条）→ 预览校对 → 批量确认保存 → 再进工作台。

四条端点各自只做一件事，避免"预览即落库"：
- ``GET  /{chapter_id}``        看板：本集镜头 + 当前提示词 + 来源（只读）
- ``POST /{chapter_id}/draft``      单镜生成草稿（真 LLM；**不落库**）。页面维护逐镜队列：
  一次只请求一镜，点"停止"就不再发下一镜，已完成的草稿保留、失败项单独重试。
- ``POST /{chapter_id}/import-parse`` 解析 + 匹配（**不落库**，返回逐条匹配状态与冲突）
- ``POST /{chapter_id}/save``   确认后批量保存（覆盖模式三选一，默认只补空白）
"""
from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db
from app.schemas.common import ApiResponse, success_response
from app.services.studio import prompt_board as svc
from app.services import paid_outlet_guard
from app.services.studio.llm_orchestration import dry_run

router = APIRouter()

_BLOCKED = (dry_run.DryRunBlocked, dry_run.RealCallNotConfirmed)


class BoardEntryWrite(BaseModel):
    """一条要写入镜头的提示词。

    **不接受调用方指定 source**：来源由请求级 ``origin``（流程）决定，见 `ORIGIN_TO_SOURCE`。
    ``draft_token`` 仅在 ``origin=llm_draft`` 时需要，必须是后端签发的草稿令牌。
    """

    shot_id: str = Field(..., min_length=1)
    prompt: str = Field(..., min_length=1)
    draft_token: str = Field("", description="大模型草稿令牌（origin=llm_draft 时必填）")


class BoardDraftRequest(BaseModel):
    """单镜草稿请求（页面逐镜调用，可真正停止）。"""

    shot_id: str = Field(..., min_length=1)
    mode: Literal["fill_empty", "overwrite_selected"] = "fill_empty"


class BoardImportParseRequest(BaseModel):
    """批量导入解析请求（不落库）。"""

    text: str = Field("", description="粘贴的整段提示词文本；上传文件时前端读成文本后同样走这里")


class BoardSaveRequest(BaseModel):
    """确认后批量保存请求。"""

    entries: list[BoardEntryWrite] = Field(default_factory=list)
    mode: Literal["fill_empty", "overwrite_selected"] = "fill_empty"
    origin: Literal["llm_draft", "jurilu_import", "external_import", "manual"] = Field(
        ...,
        description="本批内容的**流程来源**（由流程决定，服务端映射成真实 source）",
    )
    selected_shot_ids: list[str] = Field(
        default_factory=list,
        description="「只覆盖选中镜头」模式下的选中集合；空表示当前集内全选",
    )
    allow_partial: bool = Field(
        False,
        description=(
            "是否允许「仅保存已匹配项」。默认 false = 提交条数与本集镜头数不一致时拒绝整体保存；"
            "用户在预览页显式切换为「仅保存已匹配项」后前端才传 true。"
        ),
    )


@router.get("/{chapter_id}", response_model=ApiResponse[dict[str, Any]], summary="集级提示词看板（只读）")
async def get_board(chapter_id: str, db: AsyncSession = Depends(get_db)) -> Any:
    shots = await svc.load_board(db, chapter_id=chapter_id)
    return success_response(
        {
            "chapter_id": chapter_id,
            "shots": [shot.to_read() for shot in shots],
            "summary": {
                "total": len(shots),
                "with_prompt": len([shot for shot in shots if shot.has_prompt]),
                "missing": len([shot for shot in shots if not shot.has_prompt]),
            },
            "note": "这里读的是 shot_details.video_prompt（交付导出与视频生成用的同一列）。",
        }
    )


@router.get(
    "/{chapter_id}/readiness",
    response_model=ApiResponse[dict[str, Any]],
    summary="集级就绪批量读取（每镜提示词/绑定/参考帧，只读）",
)
async def get_board_readiness(
    chapter_id: str,
    reference_mode: str = "first",
    db: AsyncSession = Depends(get_db),
) -> Any:
    """顶部三态、未完成镜头定位、生产卡门禁共用的**同一份原始就绪数据**。"""
    return success_response(
        await svc.load_readiness(db, chapter_id=chapter_id, reference_mode=reference_mode)
    )


@router.post("/{chapter_id}/draft", response_model=ApiResponse[dict[str, Any]], summary="单镜生成视频提示词草稿（真 LLM，不落库）")
async def draft_board_shot(chapter_id: str, body: BoardDraftRequest, db: AsyncSession = Depends(get_db)) -> Any:
    """一次只为一镜生成草稿：页面据此维护逐镜队列，用户点停止即不再发下一镜。"""
    try:
        data = await svc.generate_draft(db, chapter_id=chapter_id, shot_id=body.shot_id, mode=body.mode)
    except _BLOCKED as exc:
        return paid_outlet_guard.blocked_envelope(exc)
    return success_response(data)


@router.post("/{chapter_id}/import-parse", response_model=ApiResponse[dict[str, Any]], summary="批量导入：解析并匹配（不落库）")
async def parse_board_import(chapter_id: str, body: BoardImportParseRequest, db: AsyncSession = Depends(get_db)) -> Any:
    shots = await svc.load_board(db, chapter_id=chapter_id)
    preview = svc.match_import_entries(body.text, shots)
    data = preview.to_read()
    data["shots"] = [shot.to_read() for shot in shots]
    return success_response(data)


@router.post("/{chapter_id}/save", response_model=ApiResponse[dict[str, Any]], summary="确认后批量保存（覆盖模式三选一）")
async def save_board(chapter_id: str, body: BoardSaveRequest, db: AsyncSession = Depends(get_db)) -> Any:
    data = await svc.save_entries(
        db,
        chapter_id=chapter_id,
        entries=[item.model_dump() for item in body.entries],
        mode=body.mode,
        origin=body.origin,
        selected_shot_ids=body.selected_shot_ids,
        allow_partial=body.allow_partial,
    )
    return success_response(data)
