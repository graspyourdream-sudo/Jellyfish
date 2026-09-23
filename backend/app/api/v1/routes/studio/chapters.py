"""Chapter CRUD（从 projects.py 拆分）。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.utils import apply_keyword_filter, apply_order, error_envelope, paginate
from app.dependencies import get_db
from app.models.studio import Chapter, Project, Shot
from app.schemas.common import ApiResponse, PaginatedData, created_response, empty_response, paginated_response, success_response
from app.services.common import (
    create_and_refresh,
    delete_if_exists,
    entity_already_exists,
    entity_not_found,
    ensure_not_exists,
    flush_and_refresh,
    get_or_404,
    patch_model,
    require_entity,
)
from app.schemas.studio.projects import ChapterCreate, ChapterRead, ChapterUpdate
from app.services.studio.chapter_asset_candidates import build_chapter_asset_candidates
from app.services.studio.asset_overlays import load_chapter_overlays
from app.services.studio.chapter_asset_profile_confirm import confirm_chapter_asset_profiles
from app.services.studio.chapter_asset_profiles import build_chapter_asset_profiles
from app.services.studio.global_asset_updates import apply_global_updates, preview_global_updates

router = APIRouter()

CHAPTER_ORDER_FIELDS = {"index", "title", "created_at", "updated_at", "storyboard_count", "status"}


class ChapterAssetProfileBuildRequest(BaseModel):
    """结构化资产清单的生成请求（全部可空：默认只用本章剧本 + 分镜 + 模型配置）。"""

    extra_instructions: str = Field("", description="附加要求（可选；会进提示词的「附加要求」段）")


class ChapterAssetProfileSelection(BaseModel):
    """冲突项/指定项的人工决定（只有需要人工处理时才传）。"""

    group_key: str = Field(..., description="清单返回的 group_key（格式 类型:归一化名称）")
    action: str = Field(..., description="create_new / link_existing / skip")
    asset_id: str | None = Field(None, description="action=link_existing 时要选用的已有资产 ID")
    confirm_conflict: bool = Field(False, description="该项存在冲突时，必须显式置 true 才会写入")
    reason: str = Field("", description="人工决定的说明（可选，会原样回显在结果里）")


class GlobalAssetUpdatePreviewRequest(BaseModel):
    """全局资产更新的差异预览请求（只读）。"""

    asset_types: list[str] = Field(
        default_factory=list,
        description="只看这几类全局资产（scene/prop/costume）；为空表示全部",
    )


class ChapterAssetProfileConfirmRequest(BaseModel):
    """结构化资产清单的确认落库请求。"""

    auto_confirm_unconflicted: bool = Field(
        True,
        description="无冲突项是否直接确认（true 时不需要逐个点；冲突项一律仍需人工决定）",
    )
    confirm_conflict: bool = Field(False, description="是否整体接受本次 selections 里冲突项的人工决定")
    selections: list[ChapterAssetProfileSelection] = Field(
        default_factory=list,
        description="需要人工处理时的逐项决定（无冲突项不必出现在这里）",
    )
    extra_instructions: str = Field(
        "",
        description="与生成本清单时**完全一致**的附加要求（内容签名要对得上，否则会要求重新生成）",
    )


@router.get(
    "",
    response_model=ApiResponse[PaginatedData[ChapterRead]],
    summary="章节列表（分页）",
)
async def list_chapters(
    db: AsyncSession = Depends(get_db),
    project_id: str | None = Query(None, description="按项目过滤"),
    q: str | None = Query(None, description="关键字，过滤 title/summary"),
    order: str | None = Query(None, description="排序字段"),
    is_desc: bool = Query(False, description="是否倒序"),
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=100),
) -> ApiResponse[PaginatedData[ChapterRead]]:
    stmt = select(Chapter)
    if project_id:
        stmt = stmt.where(Chapter.project_id == project_id)
    stmt = apply_keyword_filter(stmt, q=q, fields=[Chapter.title, Chapter.summary])
    stmt = apply_order(
        stmt,
        model=Chapter,
        order=order,
        is_desc=is_desc,
        allow_fields=CHAPTER_ORDER_FIELDS,
        default="index",
    )
    items, total = await paginate(db, stmt=stmt, page=page, page_size=page_size)

    chapter_ids = [c.id for c in items]
    shot_count_by_chapter: dict[str, int] = {}
    if chapter_ids:
        count_stmt = (
            select(Shot.chapter_id, func.count(Shot.id))
            .where(Shot.chapter_id.in_(chapter_ids))
            .group_by(Shot.chapter_id)
        )
        res = await db.execute(count_stmt)
        shot_count_by_chapter = {str(ch_id): int(cnt) for ch_id, cnt in res.all()}

    return paginated_response(
        [
            ChapterRead.model_validate(x).model_copy(update={"shot_count": shot_count_by_chapter.get(x.id, 0)})
            for x in items
        ],
        page=page,
        page_size=page_size,
        total=total,
    )


@router.post(
    "",
    response_model=ApiResponse[ChapterRead],
    status_code=status.HTTP_201_CREATED,
    summary="创建章节",
)
async def create_chapter(
    body: ChapterCreate,
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[ChapterRead]:
    await ensure_not_exists(
        db,
        Chapter,
        body.id,
        detail=entity_already_exists("Chapter"),
    )
    await require_entity(
        db,
        Project,
        body.project_id,
        detail=entity_not_found("Project"),
        status_code=400,
    )
    obj = await create_and_refresh(db, Chapter(**body.model_dump()))
    return created_response(ChapterRead.model_validate(obj))


@router.get(
    "/{chapter_id}",
    response_model=ApiResponse[ChapterRead],
    summary="获取章节",
)
async def get_chapter(
    chapter_id: str,
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[ChapterRead]:
    obj = await get_or_404(db, Chapter, chapter_id, detail=entity_not_found("Chapter"))
    count_stmt = select(func.count(Shot.id)).where(Shot.chapter_id == chapter_id)
    res = await db.execute(count_stmt)
    shot_count = int(res.scalar() or 0)
    return success_response(ChapterRead.model_validate(obj).model_copy(update={"shot_count": shot_count}))


@router.patch(
    "/{chapter_id}",
    response_model=ApiResponse[ChapterRead],
    summary="更新章节",
)
async def update_chapter(
    chapter_id: str,
    body: ChapterUpdate,
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[ChapterRead]:
    obj = await get_or_404(db, Chapter, chapter_id, detail=entity_not_found("Chapter"))
    update = body.model_dump(exclude_unset=True)
    if "project_id" in update:
        await require_entity(
            db,
            Project,
            update["project_id"],
            detail=entity_not_found("Project"),
            status_code=400,
        )
    patch_model(obj, update)
    await flush_and_refresh(db, obj)
    return success_response(ChapterRead.model_validate(obj))


@router.get(
    "/{chapter_id}/asset-candidates",
    response_model=ApiResponse[dict[str, Any]],
    summary="集级资产清单（六步流程·步骤2：聚合提取候选 + 是否已有同名资产）",
)
async def get_chapter_asset_candidates(
    chapter_id: str,
    include_ignored: bool = Query(False, description="是否把已忽略的候选也计入"),
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[dict[str, Any]]:
    """把一章内各镜头的提取候选按「类型 + 归一化名称」聚合成可确认的资产清单。

    只聚合与提示，**不建资产、不写库**；每条会给出 ``recommendation``：
    已有同名资产 → ``link_existing``（选用已有），否则 → ``create_new``（新建）。
    """
    return success_response(
        await build_chapter_asset_candidates(db, chapter_id=chapter_id, include_ignored=include_ignored)
    )


@router.post(
    "/{chapter_id}/asset-profiles",
    response_model=ApiResponse[dict[str, Any]],
    summary="结构化资产清单（六步流程·步骤2：基于本章完整剧本 + 分镜，复用上游整集分析能力）",
)
async def post_chapter_asset_profiles(
    chapter_id: str,
    body: ChapterAssetProfileBuildRequest | None = None,
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[dict[str, Any]]:
    """基于**本章完整剧本 + 本章分镜**生成规范化的角色/场景/道具/服装清单。

    与 ``/asset-candidates`` 的区别（也是本次修通数据链路的关键）：

    - ``/asset-candidates`` 只把**已经落库的镜头候选**按名称聚合一下，不读剧本、
      不产出资料；确认后资产描述仍是空的；
    - 本接口读**本章完整剧本**与分镜，调用既有 LLM 编排层（同一套 Provider / 守卫）
      产出每项资产的**结构化资料**（角色：外貌/发型/服装配饰/性格气质…
      场景：空间结构/陈设/光线色调… 道具：材质/颜色/形状/尺寸… 服装：款式/颜色/材质/配饰…），
      并保留"哪一段原文、哪个镜头"的依据。

    ``user_flow`` 是用户主流程要看的（一项资产一行，含资料、缺什么、出场镜头、
    建议动作、要不要人工处理）；``technical_detail`` 是默认收起的
    （原始候选 / 聚合组 / 内部匹配状态 / 别名合并过程 / 被丢弃条目 / LLM 元信息）。

    **本接口只读 + 只预览**：不建资产、不写库、不出图；确认请调用同章的
    ``POST /{chapter_id}/asset-profiles/confirm``。
    """
    try:
        data = await build_chapter_asset_profiles(
            db,
            chapter_id=chapter_id,
            extra_instructions=(body.extra_instructions if body else ""),
        )
    except HTTPException as exc:
        # 结构化明细（code / fix / issues）放进 meta.error，而不是被全局处理器压成一行字符串
        return error_envelope(code=exc.status_code, detail=exc.detail)
    return success_response(data)


@router.get(
    "/{chapter_id}/asset-profiles",
    response_model=ApiResponse[dict[str, Any]],
    summary="结构化资产清单（GET 便捷入口：与你上次 POST 的请求等价，不带附加要求）",
)
async def get_chapter_asset_profiles(
    chapter_id: str,
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[dict[str, Any]]:
    """GET 便捷入口（便于浏览器/调试直接打开）。语义与 POST 完全一致。"""
    try:
        data = await build_chapter_asset_profiles(db, chapter_id=chapter_id)
    except HTTPException as exc:
        return error_envelope(code=exc.status_code, detail=exc.detail)
    return success_response(data)


@router.post(
    "/{chapter_id}/asset-profiles/confirm",
    response_model=ApiResponse[dict[str, Any]],
    summary="确认结构化资产清单：无冲突项直接建/绑，冲突项需人工决定",
)
async def post_chapter_asset_profiles_confirm(
    chapter_id: str,
    body: ChapterAssetProfileConfirmRequest | None = None,
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[dict[str, Any]]:
    """把最新一份结构化清单确认落库（一次请求一个事务，全有或全无）。

    规则：

    - **无冲突项**（``auto_confirmable``）默认动作直接执行：库里有同名同类型且描述不矛盾
      → 选用已有（不新建重复资产）；没有 → 新建；
    - **冲突项**（``needs_review``）**不会**被自动写入：必须在 ``selections`` 里给出
      ``group_key`` + ``action``，并且带 ``confirm_conflict=true``；否则原样跳过，
      ``results`` 里如实给出冲突原因；
    - 结构化资料写进资产 ``description`` 与候选 ``payload``（既有列，未加列）；
    - **已有内容一律不覆盖**：已有描述、``image_prompts``、图片行（含定版）全部原样保留，
      本接口连图片表都不碰。

    返回里直接带 ``asset_readiness``（与 ``GET /studio/projects/{id}/asset-readiness``
    同一份口径），确认后生产区立即能读到。
    """
    payload = body or ChapterAssetProfileConfirmRequest()
    try:
        data = await confirm_chapter_asset_profiles(
            db,
            chapter_id=chapter_id,
            selections=[item.model_dump() for item in payload.selections],
            auto_confirm_unconflicted=payload.auto_confirm_unconflicted,
            confirm_conflict=payload.confirm_conflict,
            extra_instructions=payload.extra_instructions,
        )
    except HTTPException as exc:
        return error_envelope(code=exc.status_code, detail=exc.detail)
    return success_response(data)


@router.get(
    "/{chapter_id}/asset-overlays",
    response_model=ApiResponse[dict[str, Any]],
    summary="本章资产资料（章节隔离层）：全局资产的剧情身份 / 出场依据 / 临时补充",
)
async def get_chapter_asset_overlays(
    chapter_id: str,
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[dict[str, Any]]:
    """读回**本章**保存的资产资料（overlay）。

    为什么要单独一个读接口：场景 / 道具 / 服装是**全局资产**，本章提取出的
    剧情身份、出场依据、临时补充**不能**写进它们的通用资料，只能按项目/章节隔离保存。
    这个接口就是"我这一章的资料存在哪、存了什么"的唯一读入口（默认收起在技术详情里）。

    返回每项都带 ``scope: "chapter"`` 与 ``global_asset``：
    全局资产额外说明"不会写回全局资产的通用资料或图片提示词"。
    """
    overlays = await load_chapter_overlays(db, chapter_id=chapter_id)
    return success_response(
        {
            "chapter_id": chapter_id,
            "items": [
                {
                    **overlay,
                    "scope": "chapter",
                    "scope_description": (
                        "该资产是**全局资产**；这里的资料按项目/章节隔离保存，"
                        "不会写回全局资产的通用资料或图片提示词。"
                        if overlay.get("global_asset")
                        else "该资产归属项目（角色），资料保存在本项目内。"
                    ),
                }
                for overlay in overlays
            ],
            "summary": {
                "total": len(overlays),
                "global_assets": len([item for item in overlays if item.get("global_asset")]),
                "project_assets": len([item for item in overlays if not item.get("global_asset")]),
            },
            "note": (
                "本章资料（剧情身份 / 出场依据 / 临时补充）按项目+章节隔离保存；"
                "要更新全局资产的通用资料，请走 global-updates 的差异预览 + 显式确认。"
            ),
        }
    )


@router.post(
    "/{chapter_id}/asset-profiles/global-updates/preview",
    response_model=ApiResponse[dict[str, Any]],
    summary="全局资产更新差异预览（只读：不写库、不改图片提示词）",
)
async def post_global_updates_preview(
    chapter_id: str,
    body: GlobalAssetUpdatePreviewRequest | None = None,
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[dict[str, Any]]:
    """算出"要不要把本章**通用资料**合并进全局资产"，并按「；」分段给出新增/删除/未变。

    刻意排除本章特有字段（场景的时间天气/光线色调/相关事件、道具的状态/剧情作用、
    服装的使用场合、角色的相关剧情）—— 它们永远只留在章节 overlay 里。

    **本接口不写库**：``requires_confirmation`` 恒为 ``true``。
    """
    payload = body or GlobalAssetUpdatePreviewRequest()
    try:
        data = await preview_global_updates(db, chapter_id=chapter_id, asset_types=payload.asset_types)
    except HTTPException as exc:
        return error_envelope(code=exc.status_code, detail=exc.detail)
    return success_response(data)


@router.post(
    "/{chapter_id}/asset-profiles/global-updates/apply",
    response_model=ApiResponse[dict[str, Any]],
    summary="把本章通用资料写回全局资产（必须显式确认；图片提示词默认不动）",
)
async def post_global_updates_apply(
    chapter_id: str,
    body: dict[str, Any],
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[dict[str, Any]]:
    """全局资产更新（**白名单 + 显式确认**）。

    硬约束：

    - 请求体必须带 ``"confirm": true``，否则结构化 **409**（并把差异摘要一起返回）；
    - 必须逐项列出 ``asset_type`` / ``asset_id`` / ``apply[]``，``apply`` 只能含
      ``description`` / ``image_prompts`` 白名单字段；
    - ``image_prompts`` 还要额外带 ``confirm_replace_image_prompt: true``（沿用既有覆盖保护）；
    - 本章特有字段（时间天气/光线色调/状态/场合/相关剧情）**永远不写全局**。
    """
    try:
        data = await apply_global_updates(db, chapter_id=chapter_id, body=body)
    except HTTPException as exc:
        return error_envelope(code=exc.status_code, detail=exc.detail)
    return success_response(data)


@router.delete(
    "/{chapter_id}",
    response_model=ApiResponse[None],
    summary="删除章节",
)
async def delete_chapter(
    chapter_id: str,
    db: AsyncSession = Depends(get_db),
) -> ApiResponse[None]:
    await delete_if_exists(db, Chapter, chapter_id)
    return empty_response()
