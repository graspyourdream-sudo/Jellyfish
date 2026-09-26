"""商品卡端点（项目级）。

    GET  /studio/projects/{project_id}/product-card          读商品卡（只读，免费）
    PUT  /studio/projects/{project_id}/product-card          保存商品卡（免费）
    POST /studio/projects/{project_id}/product-card/extract   从资料提取（**付费一次调用**）

出口性质与守卫（与剧情策划那条链同一套，见 `routes/studio/drama_plan.py` 的说明）：
``extract`` 是付费出口，但**不挂** ``dependencies=[Depends(require_llm_outlet)]`` ——
服务层在演练模式下返回"未调用模型"的结构化结果，路由只捕获拦截异常做兜底
（``is_blocked_exception`` → 统一 409 结构化信封，``paid_call_made=false``）。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.utils import error_envelope
from app.dependencies import get_db
from app.schemas.common import ApiResponse, success_response
from app.schemas.studio.product_card import (
    ProductCardExtractRead,
    ProductCardExtractRequest,
    ProductCardRead,
    ProductCardUpdate,
)
from app.services import paid_outlet_guard
from app.services.studio import product_card_service as service

router = APIRouter()

OUTLET_FREE = "免费出口：不调用模型、不产生费用"
OUTLET_PAID = "付费出口：真实调用一次大模型（演练模式下不调用，返回未提取的说明）"


def _error(exc: Any) -> JSONResponse:
    """HTTPException → 结构化明细（``meta.error``），不被全局处理器压成一行字符串。"""
    return error_envelope(code=exc.status_code, detail=exc.detail)


@router.get(
    "/{project_id}/product-card",
    response_model=ApiResponse[ProductCardRead],
    summary=f"读商品卡（服务端事实来源）· {OUTLET_FREE}",
)
async def get_product_card(project_id: str, db: AsyncSession = Depends(get_db)) -> Any:
    """读商品卡；没有卡时返回一张空卡（页面不必处理 null）。"""
    try:
        card = await service.get_card(db, project_id=project_id)
        await service.require_project(db, project_id)
    except Exception as exc:  # noqa: BLE001
        if hasattr(exc, "status_code") and hasattr(exc, "detail"):
            return _error(exc)
        raise
    return success_response(ProductCardRead.model_validate(service.card_payload(card, project_id=project_id)))


@router.put(
    "/{project_id}/product-card",
    response_model=ApiResponse[ProductCardRead],
    summary=f"保存商品卡（confirmed=true 时校验必填）· {OUTLET_FREE}",
)
async def put_product_card(
    project_id: str,
    body: ProductCardUpdate,
    db: AsyncSession = Depends(get_db),
) -> Any:
    """保存商品卡；必填项缺失时确认会被 409 拒绝（其余缺项保留为「待补充」）。"""
    try:
        data = await service.save_card(db, project_id=project_id, payload=body.model_dump())
    except Exception as exc:  # noqa: BLE001
        if hasattr(exc, "status_code") and hasattr(exc, "detail"):
            return _error(exc)
        raise
    return success_response(ProductCardRead.model_validate(data))


@router.post(
    "/{project_id}/product-card/extract",
    response_model=ApiResponse[ProductCardExtractRead],
    summary=f"从资料提取商品信息（粘贴/上传/选已有）· {OUTLET_PAID}",
)
async def post_product_card_extract(
    project_id: str,
    body: ProductCardExtractRequest,
    db: AsyncSession = Depends(get_db),
) -> Any:
    """提取商品信息。**不生成剧情**：提取只写商品卡，剧情要用户确认商品卡后单独生成。"""
    try:
        from app.services.studio import product_extraction as extraction

        data = await extraction.extract_product_card(
            db,
            project_id=project_id,
            source_type=body.source_type,
            text=body.text,
            file_ids=list(body.file_ids),
            existing_product_id=body.existing_product_id,
            extra_instructions=body.extra_instructions,
        )
    except ImportError:  # pragma: no cover - 提取模块未接入时如实报，不假装成功
        return error_envelope(
            code=503,
            detail={
                "code": "product_extraction_unavailable",
                "message": "商品资料提取服务尚未接入这个环境。",
                "fix": "可以先手工填写商品卡（保存与确认都不受影响）。",
            },
        )
    except Exception as exc:  # noqa: BLE001
        if paid_outlet_guard.is_blocked_exception(exc):
            return paid_outlet_guard.blocked_envelope(exc)
        if hasattr(exc, "status_code") and hasattr(exc, "detail"):
            return _error(exc)
        raise
    return success_response(ProductCardExtractRead.model_validate(data))


__all__ = ["router"]
