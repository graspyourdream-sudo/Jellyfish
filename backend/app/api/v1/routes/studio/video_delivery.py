"""出口 B「视频交付 · 批量下载」路由。

两个端点，都是**纯读**（不写库、不触发任何付费出口、不产生新的生成调用）：

| 端点 | 用途 |
|---|---|
| ``GET /{project_id}/bundle/plan`` | 下载前的预检：包含几条、排除几条、每条的包内文件名与排除原因 |
| ``GET /{project_id}/bundle`` | 真正的 ZIP 下载（流式回给浏览器，不在内存里再复制一份） |

为什么要拆成两个：任务书要求「下载前显示包含数量和被排除数量」。
预检**不读视频字节**（只查文件记录），所以页面可以放心地在打开弹窗时就调它；
下载时再真正读字节，读取失败的镜头同样只排除自己、不影响整包。

模型就近定义在本路由文件里（沿用 ``prompt_delivery.py`` 的既定约定）。
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db
from app.schemas.common import ApiResponse, success_response
from app.services.studio import video_bundle as svc

router = APIRouter()

#: 每次回给浏览器的分块大小（1 MB）：大文件也不整包驻留内存
_CHUNK_SIZE = 1024 * 1024


class BundleItemRead(BaseModel):
    """一个镜头在交付包里的状态。"""

    shot_id: str = Field(description="镜头 ID（页面内部用；主区不展示）")
    shot_code: str = Field(description="镜头编号，例如 SH-01")
    shot_title: str = Field(description="镜头标题")
    chapter_label: str = Field(description="所属章节的展示标签")
    file_name: str = Field(default="", description="包内文件名；不进包时为空串")
    size_bytes: int = Field(0, description="文件字节数；预检时为 0（预检不读字节）")
    included: bool = Field(description="是否进包")
    reason: str = Field(default="", description="不进包时的中文原因")


class VideoBundlePlanRead(BaseModel):
    """打包预检结论。"""

    project_id: str
    scope: str = Field(description="current_shot / episode / episodes")
    scope_label: str
    included_count: int
    excluded_count: int
    has_content: bool = Field(description="有没有可交付的成片")
    items: list[BundleItemRead] = Field(default_factory=list, description="范围内全部镜头（含被排除的）")
    excluded: list[BundleItemRead] = Field(default_factory=list, description="被排除的镜头（页面据此说明原因）")
    note: str = Field(default="", description="口径说明")


_NOTE = (
    "这里只打包**生成成功并已落库**的成片：失败与半成品不会进包（失败不计费、不保留结果）。"
    "包内另有一份「交付清单.txt」，逐行写明每个镜头对应的包内文件名与不包含的镜头及原因。"
)


def _parse_ids(raw: str | None) -> list[str] | None:
    """把逗号分隔的镜头 ID 解析成列表；空值返回 None（走别的范围口径）。"""
    if not raw or not raw.strip():
        return None
    parsed = [item.strip() for item in raw.split(",") if item.strip()]
    return parsed or None


async def _build_plan(
    db: AsyncSession,
    *,
    project_id: str,
    scope: str,
    chapter_id: str | None,
    shot_id: str | None,
    shot_ids: list[str] | None,
    read_bytes: bool,
) -> svc.VideoBundlePlan:
    return await svc.build_video_bundle_plan(
        db,
        project_id=project_id,
        chapter_id=chapter_id,
        shot_id=shot_id,
        shot_ids=shot_ids,
        scope=scope,
        read_bytes=read_bytes,
    )


def _to_read(plan: svc.VideoBundlePlan) -> VideoBundlePlanRead:
    payload: dict[str, Any] = plan.to_read()
    return VideoBundlePlanRead(
        project_id=payload["project_id"],
        scope=payload["scope"],
        scope_label=payload["scope_label"],
        included_count=payload["included_count"],
        excluded_count=payload["excluded_count"],
        has_content=payload["has_content"],
        items=[BundleItemRead(**item) for item in payload["items"]],
        excluded=[BundleItemRead(**item) for item in payload["excluded"]],
        note=_NOTE,
    )


@router.get(
    "/{project_id}/bundle/plan",
    response_model=ApiResponse[VideoBundlePlanRead],
    summary="出口B 批量下载预检（包含几条 / 排除几条，不读文件字节）",
)
async def preview_video_bundle(
    project_id: str,
    scope: str = Query(svc.SCOPE_EPISODES, description="范围：current_shot / episode / episodes"),
    chapter_id: str | None = Query(None, description="当前集范围时的章节 ID"),
    shot_id: str | None = Query(None, description="当前镜头范围时的镜头 ID"),
    shot_ids: str | None = Query(None, description="选中镜头范围：逗号分隔的镜头 ID（优先于 chapter_id）"),
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[VideoBundlePlanRead]:
    plan = await _build_plan(
        db,
        project_id=project_id,
        scope=scope,
        chapter_id=chapter_id,
        shot_id=shot_id,
        shot_ids=_parse_ids(shot_ids),
        read_bytes=False,
    )
    return success_response(_to_read(plan))


@router.get(
    "/{project_id}/bundle",
    response_class=StreamingResponse,
    summary="出口B 批量下载成片 ZIP（仅含生成成功的成片 + 交付清单）",
)
async def download_video_bundle(
    project_id: str,
    scope: str = Query(svc.SCOPE_EPISODES, description="范围：current_shot / episode / episodes"),
    chapter_id: str | None = Query(None, description="当前集范围时的章节 ID"),
    shot_id: str | None = Query(None, description="当前镜头范围时的镜头 ID"),
    shot_ids: str | None = Query(None, description="选中镜头范围：逗号分隔的镜头 ID"),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    plan = await _build_plan(
        db,
        project_id=project_id,
        scope=scope,
        chapter_id=chapter_id,
        shot_id=shot_id,
        shot_ids=_parse_ids(shot_ids),
        read_bytes=True,
    )
    if not plan.has_content:
        # 自然语言错误（不暴露状态码 / 内部标识）：说清为什么、下一步怎么做
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                "这次没有可下载的成片：范围内还没有生成成功的镜头。"
                "请先在「生成与交付」里生成至少一个镜头，或把范围改到已经生成好的集。"
            ),
        )
    buffer = svc.write_bundle_zip(plan)
    filename = svc.bundle_filename(plan)

    def _iter() -> Any:
        """按块流式回浏览器；无论成功失败都要关掉底层缓冲。"""
        try:
            while True:
                chunk = buffer.read(_CHUNK_SIZE)
                if not chunk:
                    break
                yield chunk
        finally:
            buffer.close()

    headers = {
        # 文件名含中文 → 用 RFC 5987 的 filename* 让浏览器正确落盘（并保留 ASCII 兜底）
        "Content-Disposition": (
            'attachment; filename="video-bundle.zip"; '
            f"filename*=UTF-8''{quote(svc.safe_file_name(filename), safe='')}"
        ),
        "X-Bundle-Included": str(plan.included_count),
        "X-Bundle-Excluded": str(plan.excluded_count),
    }
    return StreamingResponse(_iter(), media_type="application/zip", headers=headers)


__all__ = ["router"]
