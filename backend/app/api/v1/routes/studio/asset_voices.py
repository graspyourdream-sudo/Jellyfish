"""资产级声音绑定接口（需求清单第 6 条：声音直接绑定资产）。

    GET    /studio/asset-voices?project_id=…                  列出项目下全部资产声音
    GET    /studio/asset-voices/{asset_type}/{asset_id}       读一个资产的声音
    PUT    /studio/asset-voices/{asset_type}/{asset_id}       绑定（同一事务内只留一个生效）
    DELETE /studio/asset-voices/{asset_type}/{asset_id}       解绑
    GET    /studio/asset-voices/shots/{shot_id}/inheritance    读某镜角色声音的继承结果（只读）

**全部免费**：只写/读 ``file_usages``，不调模型、不触图、不触视频，没有任何出口费用。

为什么单独一个模块而不是塞进 files / shots 路由：这是**资产级**的资源
（角色/场景/道具/服装 各有一个声音），既不属于某个文件、也不属于某个镜头；
放在 ``/files`` 下会被读成"文件的操作"，放在 ``/shots`` 下会重新长回逐镜口径。

为什么第 4 步的继承读也在这里（设计包 §10）：它读的是"这一镜的人物资产绑了什么声音"，
答案的唯一来源就是本模块管理的资产声音表；而且它**只有 GET**——第 4 步不许改声音，
"选择 / 更换"只在第 2 步的人物资产详情里发生。
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.utils import error_envelope
from app.dependencies import get_db
from app.schemas.common import ApiResponse, success_response
from app.schemas.studio.asset_voices import (
    AssetVoiceBindRequest,
    AssetVoiceClearRead,
    AssetVoiceRead,
    ShotVoiceInheritanceRead,
)
from app.services.studio.asset_profiles import type_label
from app.services.studio.asset_voices import (
    AssetVoiceBinding,
    ShotVoiceInheritance,
    bind_asset_voice,
    clear_asset_voice,
    list_project_asset_voices,
    read_asset_voice,
    read_shot_voice_inheritance,
)

router = APIRouter()


def _error(exc: Any) -> JSONResponse:
    """服务层的结构化拒绝 → ``meta.error``（不让全局处理器把它压成 dict 的字符串）。

    为什么必须显式转：全局 ``HTTPException`` 处理器只会把 ``detail`` 拼成一行
    ``message``，dict 会变成 ``{'code': '...', ...}`` 这种**原始 Python 字面量**上了主区 ——
    既是给用户看的乱码，也违反"主区只能是产品自己写的中文句子"。
    """
    return error_envelope(code=exc.status_code, detail=exc.detail)


def _to_read(binding: AssetVoiceBinding | None, *, asset_type: str, asset_id: str) -> AssetVoiceRead:
    """把服务层结果转成只读契约（没有绑定时给一个 ``bound=false`` 的如实结构）。"""
    if binding is None:
        return AssetVoiceRead(
            asset_type=asset_type,
            asset_id=asset_id,
            asset_label=type_label(asset_type),
            bound=False,
        )
    return AssetVoiceRead(
        asset_type=binding.asset_type,
        asset_id=binding.asset_id,
        asset_label=binding.asset_label,
        bound=True,
        file_id=binding.file_id,
        file_name=binding.file_name,
        url=binding.url,
    )


@router.get(
    "",
    response_model=ApiResponse[list[AssetVoiceRead]],
    summary="列出项目下全部资产声音绑定（只读、免费）",
)
async def list_asset_voices(
    project_id: str = Query(..., description="项目 ID"),
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[list[AssetVoiceRead]]:
    """一次取回整个项目的资产声音：资产准备页一屏几十项，逐项查会变成 N 次请求。"""
    bindings = await list_project_asset_voices(db, project_id=project_id)
    return success_response([_to_read(item, asset_type=item.asset_type, asset_id=item.asset_id) for item in bindings])


@router.get(
    "/{asset_type}/{asset_id}",
    response_model=ApiResponse[AssetVoiceRead],
    summary="读取某个资产的资产声音（只读、免费）",
)
async def get_asset_voice(
    asset_type: str,
    asset_id: str,
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[AssetVoiceRead]:
    try:
        binding = await read_asset_voice(db, asset_type=asset_type, asset_id=asset_id)
    except HTTPException as exc:
        return _error(exc)
    return success_response(_to_read(binding, asset_type=binding.asset_type if binding else asset_type, asset_id=asset_id))


@router.put(
    "/{asset_type}/{asset_id}",
    response_model=ApiResponse[AssetVoiceRead],
    summary="给资产绑定声音（免费；同一事务内保证一个资产只有一个生效声音）",
)
async def put_asset_voice(
    asset_type: str,
    asset_id: str,
    body: AssetVoiceBindRequest,
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[AssetVoiceRead]:
    """绑定资产声音。

    服务层在**同一事务**里先删该资产的旧 ``asset_voice`` 行再插新行，
    所以这里不会出现"一个资产两个生效声音"的中间态。
    """
    try:
        binding = await bind_asset_voice(db, asset_type=asset_type, asset_id=asset_id, file_id=body.file_id)
    except HTTPException as exc:
        return _error(exc)
    return success_response(_to_read(binding, asset_type=binding.asset_type, asset_id=binding.asset_id))


@router.delete(
    "/{asset_type}/{asset_id}",
    response_model=ApiResponse[AssetVoiceClearRead],
    summary="解绑资产的资产声音（免费）",
)
async def delete_asset_voice(
    asset_type: str,
    asset_id: str,
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[AssetVoiceClearRead]:
    try:
        removed = await clear_asset_voice(db, asset_type=asset_type, asset_id=asset_id)
    except HTTPException as exc:
        return _error(exc)
    return success_response(AssetVoiceClearRead(removed=removed))


def _to_shot_read(result: ShotVoiceInheritance) -> ShotVoiceInheritanceRead:
    """服务层的只读结论 → 契约（中文标签由后端给，页面不自己写映射表）。"""
    return ShotVoiceInheritanceRead(
        shot_id=result.shot_id,
        state=result.state,
        file_id=result.file_id,
        file_name=result.file_name,
        url=result.url,
        source_asset_type=result.source_asset_type,
        source_asset_id=result.source_asset_id,
        source_asset_name=result.source_asset_name,
        character_count=result.character_count,
        voice_asset_count=result.voice_asset_count,
        candidates=list(result.candidates),
        legacy_file_id=result.legacy_file_id,
        legacy_file_name=result.legacy_file_name,
        legacy_inherited_from=result.legacy_inherited_from,
    )


@router.get(
    "/shots/{shot_id}/inheritance",
    response_model=ApiResponse[ShotVoiceInheritanceRead],
    summary="读取某镜角色声音的继承结果与来源（只读、免费；第 4 步唯一读路径）",
)
async def get_shot_voice_inheritance(
    shot_id: str,
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[ShotVoiceInheritanceRead]:
    """第 4 步「资产与声音检查」的**只读**读口：这一镜的角色声音继承结果、来源、缺项原因。

    刻意**只有 GET**：第 4 步不提供第二套选择 / 更换入口，也不回写。
    要改声音请回第 2 步「人物资产详情」（``PUT /asset-voices/character/{id}``）。
    """
    try:
        result = await read_shot_voice_inheritance(db, shot_id=shot_id)
    except HTTPException as exc:
        return _error(exc)
    return success_response(_to_shot_read(result))

