"""剧情方案草稿 → **正式产物**的落库（materialize），且**幂等**。

为什么不能复用 ``script_division._append_division_rows``
======================================================

那支函数是给"剧本原文拆镜头"用的，它把技术参数**硬编码**掉（已核实
``app/services/studio/script_division.py:14-44``）：

- ``camera_shot=MS`` / ``angle=EYE_LEVEL`` / ``movement=STATIC``；
- ``duration=4``；
- **完全不写对白独立表** ``shot_dialog_lines``（对白只留在剧本摘录里）。

而剧情方案的每镜都带真实景别 / 机位 / 运镜 / 时长 / 动作拍点 / 台词 —— 用那支函数落库
等于把方案里最有价值的部分全丢掉。所以这里新写一支。

一条路、一个事务
===============

- 写正式产物**只有这一条路**（``POST .../drama-plan/confirm``）；
- 全部写入都在调用方给的同一个 session 里完成，路由提交；
  **任何一步抛错整体回滚**，不会留下半个章节（校验全部前置，见 :func:`_validate`）。

幂等（实施契约 §三）
====================

"第 2 次点确认"必须与"第 1 次"得到同一个库状态（契约 §三.6 明确要求
**第二次确认不得新增任何镜头/资产**）。为此：

1. 每一行正式产物（镜头、人物、场景、商品）都在 ``drama_plan_materials`` 里留一行来源关系
   （``source='plan'``），它同时是**幂等查询依据**与**追溯链路**（商品/人物/场景 → 策划 → 商品卡）；
2. 第二次确认按"名称"找回**本次方案上次落下的那一行**，改成"就地更新"而不是再建一行；
3. **同名即同一个资产**：``scenes.name`` / ``products.name`` 是**全局唯一**、
   ``characters`` 是 ``(project_id, name)`` 唯一（已核实三个模型的唯一约束）。
   所以重逢同名资产时必须复用而不是新建 —— 否则第二次确认会直接撞唯一约束报 500，
   而且"同一个商品在两个项目里落两次"本身也是错的；
4. 复用**不覆盖**用户已经填过的资产资料：草稿里的资料只在库里的资料为空时补上；
   两边都有且不同则记一条 warning（用户在第 2 步改过的资料不能被一次重新确认静默冲掉）。

为什么镜头数变了要拒绝（而不是"能对上几个算几个"）
==================================================

已落库的镜头数与草稿里的镜头数不一致时，说明**草稿在确认之后被改过**（加/删镜头）。
这时"就地更新"会面对一个二选一：留着多余的镜头（旧分镜混在新分镜里）还是删掉它们
（删掉用户可能已经做过资产准备的那几镜）。两个都不是能替用户做的决定，
所以这里明确 **409 + 清楚的修复建议**（新建一集重新确认），而不是猜一个。

诚实边界
========

草稿结构里只有**人物 / 场景 / 商品**三类资产（契约 §二 的 ``plan`` JSON 结构）；
道具与服装不在策划草稿里，它们由第 2 步「资产准备」的提取候选产生，**不由策划落库**。
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.studio import (
    CameraAngle,
    CameraMovement,
    CameraShotType,
    Chapter,
    Character,
    DialogueLineMode,
    Product,
    Project,
    ProjectProductLink,
    ProjectSceneLink,
    Scene,
    Shot,
    ShotCharacterLink,
    ShotDetail,
    ShotDialogLine,
    VFXType,
)
from app.models.studio_ad_flow import DramaPlanMaterial, ProductCard
from app.models.studio_drama_plan import DramaPlanDraft
from app.schemas.studio.drama_plan import DramaPlanDraft as DramaPlanDraftDTO
from app.services.studio.asset_profiles import render_profile_text

#: 章节标题缺省值（方案没给标题时用它，不编造内容）
FALLBACK_TITLE = "剧情广告"

#: ``drama_plan_materials.source`` 的取值：plan = 由本次策划确认写入（幂等复核查的就是它）
MATERIAL_SOURCE_PLAN = "plan"

#: 来源关系里表示"镜头"的实体类型（镜头不是资产，但同样要登记才能幂等更新）
ENTITY_SHOT = "shot"

#: ``products.provenance.source`` 与上面同口径（商品资产上的来源投影）
PROVENANCE_SOURCE_PLAN = MATERIAL_SOURCE_PLAN

#: ``DramaPlanDraft.story_status`` 的"已确认"取值（``ad_flow_service`` 据此判 ad_phase）
STORY_STATUS_CONFIRMED = "confirmed"

#: 确认之后页面上的**唯一**主操作（契约 §三.5）
NEXT_STEP_LABEL = "继续准备资产"
NEXT_STEP_QUERY = "step=extract_assets"


def next_step_url(project_id: str) -> str:
    """契约里写死的下一步 URL（不带章节参数）。"""
    return f"/projects/{project_id}?{NEXT_STEP_QUERY}"


def next_step_chapter_url(project_id: str, chapter_id: str) -> str:
    """带章节参数的下一步 URL。

    为什么额外给一份：第 2 步的工作台按**章节**取镜头资产，少了 ``chapter`` 参数它会
    自己再找一次章节（找到的可能不是刚确认的这集）。契约里的 ``url`` 保留原样不动，
    页面优先用 ``chapter_url``。
    """
    return f"/projects/{project_id}?{NEXT_STEP_QUERY}&chapter={chapter_id}"


def _conflict(code: str, message: str, *, fix: str, extra: dict[str, Any] | None = None) -> HTTPException:
    """结构化 409（路由会用 ``error_envelope`` 原样下发到 ``meta.error``）。"""
    detail: dict[str, Any] = {"code": code, "message": message, "fix": fix}
    if extra:
        detail.update(extra)
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


def _new_id(prefix: str) -> str:
    """新资产 / 镜头的 ID（仓库既有口径：本地生成的短 uuid）。"""
    return f"{prefix}-{uuid.uuid4().hex[:16]}"


def _iso(value: Any) -> str:
    """datetime → ISO 串（空值给空串；只用于 provenance 这类 JSON 投影）。"""
    if value is None:
        return ""
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


# ---------------------------------------------------------------------------
# 校验（确认时**再**做一遍的兜底，不信模型自述）
# ---------------------------------------------------------------------------


def _validate(plan: DramaPlanDraftDTO) -> list[str]:
    """落库前的确定性校验；返回 warnings，问题是抛异常而不是静默修。"""
    warnings: list[str] = []
    if not plan.shots:
        raise _conflict(
            "drama_plan_no_shots",
            "草稿里没有任何镜头，无法确认落库。",
            fix="先在草稿编辑器里补上镜头，或重新生成一次。",
        )

    character_names: dict[str, str] = {}
    for item in plan.characters:
        name = item.name.strip()
        if not name:
            raise _conflict("drama_plan_blank_character", "人物表里有名称为空的角色。", fix="删掉它或补上名字。")
        if name in character_names:
            raise _conflict(
                "drama_plan_duplicate_character",
                f"人物表里「{name}」出现了两次。",
                fix="合并成一条（同一个人只应有一条人物资料）。",
            )
        character_names[name] = name

    scene_names: set[str] = set()
    for item in plan.scenes:
        name = item.name.strip()
        if not name:
            raise _conflict("drama_plan_blank_scene", "场景表里有名称为空的场景。", fix="删掉它或补上名字。")
        if name in scene_names:
            raise _conflict(
                "drama_plan_duplicate_scene", f"场景表里「{name}」出现了两次。", fix="合并成一条。"
            )
        scene_names.add(name)

    # 悬空引用：出场角色与台词说话人都必须能解析到人物表
    for shot in plan.shots:
        unknown = [name for name in shot.characters if name not in character_names]
        if unknown:
            raise _conflict(
                "drama_plan_unknown_character",
                f"镜头 {shot.index} 的出场角色里，「{unknown[0]}」不在人物表里。",
                fix="把该角色加进人物表，或从这一镜的出场角色里去掉。",
                extra={"shot_index": shot.index, "unknown_characters": unknown},
            )
        for line in shot.dialogue:
            if line.speaker and line.speaker not in character_names:
                raise _conflict(
                    "drama_plan_unknown_speaker",
                    f"镜头 {shot.index} 的台词说话人「{line.speaker}」不在人物表里。",
                    fix="把该角色加进人物表，或清空这句台词的说话人。",
                    extra={"shot_index": shot.index},
                )

    if plan.product is not None:
        if not plan.product.name.strip():
            raise _conflict("drama_plan_blank_product", "商品没有名称。", fix="补上商品名称或删掉商品。")
        present = sum(1 for shot in plan.shots if shot.product_present)
        need = (len(plan.shots) + 1) // 2
        if present < need:
            raise _conflict(
                "drama_plan_product_coverage",
                f"商品只出现在 {present}/{len(plan.shots)} 个镜头，少于要求的一半（{need} 个）。",
                fix="在草稿里把更多镜头标成「出现商品」，或改回没有商品的方案。",
                extra={"product_shots": present, "shot_total": len(plan.shots), "required": need},
            )
    elif any(shot.product_present for shot in plan.shots):
        warnings.append("草稿里标了「出现商品」但没有商品信息，已按无商品落库。")

    return warnings


# ---------------------------------------------------------------------------
# 幂等查询与登记
# ---------------------------------------------------------------------------


async def _plan_materials(
    db: AsyncSession, *, chapter_id: str, entity_type: str
) -> list[DramaPlanMaterial]:
    """本章、本来源、某类型的所有来源关系行（幂等查询的入口）。"""
    rows = await db.execute(
        select(DramaPlanMaterial)
        .where(
            DramaPlanMaterial.chapter_id == chapter_id,
            DramaPlanMaterial.entity_type == entity_type,
            DramaPlanMaterial.source == MATERIAL_SOURCE_PLAN,
        )
        .order_by(DramaPlanMaterial.id)
    )
    return list(rows.scalars().all())


async def _plan_entity_names(
    db: AsyncSession, *, chapter_id: str, entity_type: str, model: Any
) -> dict[str, Any]:
    """上次落库的资产：``{名称: 实体}``（按来源关系里的 entity_id 反查）。

    为什么按名称做键：草稿里只有名称能当身份（模型每次生成的 ID 都是新的）。
    """
    rows = await _plan_materials(db, chapter_id=chapter_id, entity_type=entity_type)
    ids = [str(row.entity_id) for row in rows]
    if not ids:
        return {}
    entities = (
        await db.execute(select(model).where(model.id.in_(ids)))
    ).scalars().all()
    return {str(getattr(item, "name", "") or ""): item for item in entities}


async def _ensure_material(
    db: AsyncSession, *, project_id: str, chapter_id: str, entity_type: str, entity_id: str
) -> bool:
    """登记一行来源关系；**已存在则返回 False**（幂等，不写第二行）。"""
    existing = await db.scalar(
        select(DramaPlanMaterial.id).where(
            DramaPlanMaterial.entity_type == entity_type,
            DramaPlanMaterial.entity_id == entity_id,
            DramaPlanMaterial.project_id == project_id,
            DramaPlanMaterial.chapter_id == chapter_id,
            DramaPlanMaterial.source == MATERIAL_SOURCE_PLAN,
        )
    )
    if existing is not None:
        return False
    db.add(
        DramaPlanMaterial(
            project_id=project_id,
            chapter_id=chapter_id,
            entity_type=entity_type,
            entity_id=entity_id,
            source=MATERIAL_SOURCE_PLAN,
        )
    )
    return True


async def _ensure_project_scope_link(
    db: AsyncSession, *, model: Any, asset_field: str, asset_id: str, project_id: str
) -> bool:
    """确保"项目档"关联行存在（``chapter_id`` / ``shot_id`` 都为空）；已存在返回 False。

    为什么要显式查一次而不能靠唯一约束：那两条唯一约束把 ``chapter_id`` / ``shot_id``
    也算进去了，而 SQLite 视 NULL 互不相等 → 项目档（两列都是 NULL）**重复插入不会被拦**。
    所以"是否已存在"必须自己查，且必须用 ``IS NULL`` 而不是 ``== None`` 的模糊口径。
    """
    existing = await db.scalar(
        select(model.id).where(
            getattr(model, asset_field) == asset_id,
            model.project_id == project_id,
            model.chapter_id.is_(None),
            model.shot_id.is_(None),
        )
    )
    if existing is not None:
        return False
    db.add(model(id=None, project_id=project_id, **{asset_field: asset_id}))
    return True


async def _chapter_shots(db: AsyncSession, chapter_id: str) -> list[Shot]:
    """本章的镜头，按 ``index`` 升序（更新模式靠这个顺序与草稿逐位对齐）。"""
    rows = await db.execute(
        select(Shot).where(Shot.chapter_id == chapter_id).order_by(Shot.index, Shot.id)
    )
    return list(rows.scalars().all())


async def _count_chapter_shots(db: AsyncSession, chapter_id: str) -> int:
    total = await db.scalar(select(func.count()).select_from(Shot).where(Shot.chapter_id == chapter_id))
    return int(total or 0)


# ---------------------------------------------------------------------------
# 写入
# ---------------------------------------------------------------------------


def _profile_description(asset_type: str, profile: dict[str, str], fallback: str = "") -> str:
    """草稿资料 → 资产描述（与既有口径一致：``asset_profiles.render_profile_text``）。"""
    text = render_profile_text(asset_type, profile or {})
    return text or fallback


async def _materialize_characters(
    db: AsyncSession,
    *,
    dto: DramaPlanDraftDTO,
    project: Project,
    chapter_id: str,
    counts: dict[str, Any],
    warnings: list[str],
    skipped: list[str],
) -> dict[str, str]:
    """人物表 → ``characters``（唯一带 ``project_id`` 的资产）+ 项目档关联 + 来源关系。"""
    known = await _plan_entity_names(db, chapter_id=chapter_id, entity_type="character", model=Character)
    ids: dict[str, str] = {}
    for item in dto.characters:
        name = item.name.strip()
        existing = known.get(name)
        description = _profile_description("character", item.profile)
        if existing is None:
            # 同名角色可能已经在本项目里（characters 的唯一约束是 (project_id, name)），
            # 例如"这一集的策划确认"与"上一集"用了同一个角色名 → 复用，不新建。
            existing = (
                await db.execute(
                    select(Character).where(Character.project_id == project.id, Character.name == name)
                )
            ).scalars().first()
        if existing is None:
            asset_id = _new_id("char")
            db.add(
                Character(
                    id=asset_id,
                    project_id=project.id,
                    name=name,
                    description=description,
                    style=project.style,
                    visual_style=project.visual_style,
                )
            )
            counts["characters_created"] += 1
            counts["assets_created"] += 1
        else:
            asset_id = str(existing.id)
            counts["assets_reused"] += 1
            _merge_description(existing, description, name=name, warnings=warnings)
        if await _ensure_material(
            db, project_id=project.id, chapter_id=chapter_id, entity_type="character", entity_id=asset_id
        ):
            counts["materials_linked"] += 1
        ids[name] = asset_id
    if not dto.characters:
        skipped.append("草稿里没有人物表，没有落任何角色")
    return ids


def _merge_description(existing: Any, description: str, *, name: str, warnings: list[str]) -> None:
    """复用既有资产时的资料合并口径：**只在库里的资料为空时补**，不覆盖用户填过的资料。"""
    if not description:
        return
    current = str(getattr(existing, "description", "") or "").strip()
    if not current:
        existing.description = description
        return
    if current != description.strip():
        warnings.append(
            f"同名资产「{name}」已存在且资料不同：保留了它现有的资料（没有用策划草稿覆盖）。"
            "要改成草稿这一版，请在第 2 步「资产准备」里编辑该资产。"
        )


async def _materialize_scenes(
    db: AsyncSession,
    *,
    dto: DramaPlanDraftDTO,
    project: Project,
    chapter_id: str,
    counts: dict[str, Any],
    warnings: list[str],
    skipped: list[str],
) -> dict[str, str]:
    """场景表 → ``scenes``（全局资产，``name`` 全局唯一）+ 项目档关联 + 来源关系。"""
    known = await _plan_entity_names(db, chapter_id=chapter_id, entity_type="scene", model=Scene)
    ids: dict[str, str] = {}
    for item in dto.scenes:
        name = item.name.strip()
        existing = known.get(name)
        description = _profile_description("scene", item.profile)
        if existing is None:
            existing = (await db.execute(select(Scene).where(Scene.name == name))).scalars().first()
        if existing is None:
            asset_id = _new_id("scene")
            db.add(
                Scene(
                    id=asset_id,
                    name=name,
                    description=description,
                    style=project.style,
                    visual_style=project.visual_style,
                )
            )
            counts["scenes_created"] += 1
            counts["assets_created"] += 1
        else:
            asset_id = str(existing.id)
            counts["assets_reused"] += 1
            _merge_description(existing, description, name=name, warnings=warnings)
        await _ensure_project_scope_link(
            db, model=ProjectSceneLink, asset_field="scene_id", asset_id=asset_id, project_id=project.id
        )
        if await _ensure_material(
            db, project_id=project.id, chapter_id=chapter_id, entity_type="scene", entity_id=asset_id
        ):
            counts["materials_linked"] += 1
        ids[name] = asset_id
    if not dto.scenes:
        skipped.append("草稿里没有场景表，没有落任何场景")
    return ids


async def _materialize_product(
    db: AsyncSession,
    *,
    dto: DramaPlanDraftDTO,
    project: Project,
    chapter_id: str,
    counts: dict[str, Any],
    warnings: list[str],
) -> str:
    """商品 → ``products``（全局资产，``name`` 全局唯一）+ 项目档关联 + 来源关系 + ``provenance``。

    ``products.provenance`` 是"这一行商品是哪个项目的哪一章的策划确认落下来的"在**资产上**的
    投影（``drama_plan_materials`` 里那一行是同一件事在关系表里的投影）。
    """
    if dto.product is None:
        return ""
    name = dto.product.name.strip()
    existing = (
        await db.execute(select(Product).where(Product.name == name))
    ).scalars().first()
    description = _profile_description("product", dto.product.profile, fallback=dto.product.description or "")
    if existing is None:
        product_id = _new_id("prod")
        product = Product(
            id=product_id,
            name=name,
            description=description,
            style=project.style,
            visual_style=project.visual_style,
        )
        db.add(product)
        counts["product_created"] = True
        counts["assets_created"] += 1
    else:
        product_id = str(existing.id)
        product = existing
        counts["assets_reused"] += 1
        _merge_description(existing, description, name=name, warnings=warnings)

    await _ensure_project_scope_link(
        db, model=ProjectProductLink, asset_field="product_id", asset_id=product_id, project_id=project.id
    )
    if await _ensure_material(
        db, project_id=project.id, chapter_id=chapter_id, entity_type="product", entity_id=product_id
    ):
        counts["materials_linked"] += 1

    # provenance：空 {} = 非策划落库；这里既然是策划确认落下的，就写上（第二次确认只是刷新时间）
    card = await db.get(ProductCard, project.id)
    product.provenance = {
        "source": PROVENANCE_SOURCE_PLAN,
        "project_id": project.id,
        "chapter_id": chapter_id,
        "card_updated_at": _iso(getattr(card, "updated_at", None)),
    }
    return product_id


async def _sync_dialog_lines(
    db: AsyncSession,
    *,
    shot_id: str,
    lines: list[Any],
    character_ids: dict[str, str],
    warnings: list[str],
    position: int,
    counts: dict[str, Any],
) -> None:
    """把一镜的台词同步成草稿里的样子（按 ``index`` 就地更新，多删少补）。"""
    rows = list(
        (
            await db.execute(
                select(ShotDialogLine)
                .where(ShotDialogLine.shot_detail_id == shot_id)
                .order_by(ShotDialogLine.index, ShotDialogLine.id)
            )
        ).scalars().all()
    )
    for line_index, line in enumerate(lines):
        mode = str(line.mode or "DIALOGUE").upper()
        if mode not in {item.value for item in DialogueLineMode}:
            mode = DialogueLineMode.dialogue.value
            warnings.append(f"镜头 {position} 的台词模式非法，已落 DIALOGUE。")
        speaker_id = character_ids.get(line.speaker) if line.speaker else None
        if line_index < len(rows):
            row = rows[line_index]
            row.index = line_index
            row.text = line.text
            row.line_mode = mode
            row.speaker_character_id = speaker_id
            row.speaker_name = line.speaker or None
            counts["dialog_lines_updated"] += 1
        else:
            db.add(
                ShotDialogLine(
                    id=None,
                    shot_detail_id=shot_id,
                    index=line_index,
                    text=line.text,
                    line_mode=mode,
                    speaker_character_id=speaker_id,
                    speaker_name=line.speaker or None,
                )
            )
            counts["dialog_lines_created"] += 1
    for row in rows[len(lines):]:
        # 草稿里删掉的那几句要跟着走（否则"确认"之后库里还留着草稿里已经没有的台词）
        await db.delete(row)


async def _sync_shot_character_links(
    db: AsyncSession,
    *,
    shot_id: str,
    names: list[str],
    character_ids: dict[str, str],
    counts: dict[str, Any],
) -> None:
    """镜头 ↔ 角色关联：按 ``character_id`` 就地保留，多删少补。"""
    rows = list(
        (
            await db.execute(select(ShotCharacterLink).where(ShotCharacterLink.shot_id == shot_id))
        ).scalars().all()
    )
    by_character = {str(row.character_id): row for row in rows}
    keep: set[str] = set()
    for index, name in enumerate(names):
        character_id = character_ids[name]
        keep.add(character_id)
        row = by_character.get(character_id)
        if row is None:
            db.add(
                ShotCharacterLink(
                    id=None, shot_id=shot_id, character_id=character_id, index=index, note=""
                )
            )
            counts["shot_character_links"] += 1
        else:
            row.index = index
    for character_id, row in by_character.items():
        if character_id not in keep:
            await db.delete(row)


async def _sync_shot_product_link(
    db: AsyncSession,
    *,
    project_id: str,
    chapter_id: str,
    shot_id: str,
    product_id: str,
    present: bool,
    counts: dict[str, Any],
) -> None:
    """「这一镜出现了商品」的**唯一**表达：shot 档关联行（不是布尔列）。"""
    rows = list(
        (
            await db.execute(
                select(ProjectProductLink).where(
                    ProjectProductLink.shot_id == shot_id,
                    ProjectProductLink.project_id == project_id,
                )
            )
        ).scalars().all()
    )
    wanted = bool(product_id) and present
    if wanted:
        if not any(str(row.product_id) == product_id for row in rows):
            db.add(
                ProjectProductLink(
                    id=None,
                    project_id=project_id,
                    chapter_id=chapter_id,
                    shot_id=shot_id,
                    product_id=product_id,
                )
            )
        counts["shot_product_links"] += 1
    for row in rows:
        if str(row.product_id) != product_id or not wanted:
            await db.delete(row)


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------


async def materialize_drama_plan(
    db: AsyncSession,
    *,
    chapter_id: str,
    plan: dict[str, Any],
) -> dict[str, Any]:
    """把草稿落成正式产物（**同一个事务**，失败整体回滚）；第一次建、第二次更新。

    返回统计字典（也是契约 §三.5 定的响应形状），其中 ``skipped`` 是"没落的东西 + 为什么"，
    ``next_step`` 是页面上的下一个主操作。
    """
    chapter = await db.get(Chapter, chapter_id)
    if chapter is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"章节不存在：{chapter_id}")
    project = await db.get(Project, chapter.project_id)
    if project is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"项目不存在：{chapter.project_id}"
        )

    try:
        dto = DramaPlanDraftDTO.model_validate(plan or {})
    except Exception as exc:  # noqa: BLE001 - 草稿结构坏了要如实报，不能猜
        raise _conflict(
            "drama_plan_invalid_draft",
            f"草稿结构不合法，无法落库：{exc}",
            fix="重新生成一次，或把草稿里明显的字段补齐。",
        ) from exc

    warnings = _validate(dto)
    skipped: list[str] = []

    # ------------------------------------------------------------------
    # 第一次还是第二次？——用「本章的镜头是不是都由本方案落下」来判
    # ------------------------------------------------------------------
    shot_materials = await _plan_materials(db, chapter_id=chapter_id, entity_type=ENTITY_SHOT)
    recorded_shot_ids = {str(row.entity_id) for row in shot_materials}
    existing_shots = await _chapter_shots(db, chapter_id)

    if existing_shots and recorded_shot_ids:
        foreign = [shot for shot in existing_shots if str(shot.id) not in recorded_shot_ids]
        if foreign:
            raise _conflict(
                "drama_plan_chapter_not_empty",
                f"这一集已有 {len(foreign)} 个不属于本方案的镜头，拒绝把方案混进去。",
                fix="换一个空章节（例如新建一集）再确认落库。",
                extra={"existing_shots": len(existing_shots), "foreign_shots": len(foreign)},
            )
        if len(existing_shots) != len(dto.shots):
            raise _conflict(
                "drama_plan_shot_count_changed",
                f"这一集上次按 {len(existing_shots)} 个镜头落过库，草稿现在是 {len(dto.shots)} 个，"
                "无法就地更新（留着多出来的镜头会新旧分镜混在一起，删掉又可能丢了你已经准备过的内容）。",
                fix="新建一集重新确认，或把草稿的镜头数改回与已落库的一致。",
                extra={"materialized_shots": len(existing_shots), "draft_shots": len(dto.shots)},
            )
    elif existing_shots:
        # 有镜头、但一行来源关系都没有 → 不是本方案落下的，拒绝写入（既有口径）
        raise _conflict(
            "drama_plan_chapter_not_empty",
            f"这一集已有 {len(existing_shots)} 个镜头，拒绝写入方案（避免新旧分镜混在一起）。",
            fix="换一个空章节（例如新建一集）再确认落库。",
            extra={"existing_shots": len(existing_shots)},
        )

    update_mode = bool(existing_shots)

    counts: dict[str, Any] = {
        "chapter_id": chapter_id,
        "shots_created": 0,
        "shots_updated": 0,
        "dialog_lines_created": 0,
        "dialog_lines_updated": 0,
        "characters_created": 0,
        "scenes_created": 0,
        "product_created": False,
        "assets_created": 0,
        "assets_reused": 0,
        "materials_linked": 0,
        "shot_product_links": 0,
        "shot_character_links": 0,
    }

    # 1) 章节：标题 / 一句话主线 / **完整剧情全文**（契约 §三.1）
    chapter.title = (dto.title or "").strip() or chapter.title or FALLBACK_TITLE
    chapter.summary = (dto.logline or "").strip() or chapter.summary
    story_text = str(getattr(dto.story, "full_text", "") or "").strip()
    if story_text:
        chapter.raw_text = story_text
    else:
        skipped.append("草稿里没有完整剧情全文，章节正文（raw_text）保持原样")

    # 2) 资产（人物 / 场景 / 商品）
    character_ids = await _materialize_characters(
        db, dto=dto, project=project, chapter_id=chapter_id, counts=counts, warnings=warnings, skipped=skipped
    )
    await _materialize_scenes(
        db, dto=dto, project=project, chapter_id=chapter_id, counts=counts, warnings=warnings, skipped=skipped
    )
    product_id = await _materialize_product(
        db, dto=dto, project=project, chapter_id=chapter_id, counts=counts, warnings=warnings
    )

    # 3) 镜头：第一次建（Shot + ShotDetail + 关联行），第二次就地更新
    for position, shot in enumerate(dto.shots, start=1):
        if update_mode:
            row = existing_shots[position - 1]
            shot_id = str(row.id)
            row.index = position
            row.title = shot.title or f"镜头 {position}"
            row.script_excerpt = shot.script_excerpt
            detail = await db.get(ShotDetail, shot_id)
            if detail is None:
                # 数据异常（镜头没有详情行）：补一行，而不是让整次确认 500
                db.add(_new_shot_detail(shot_id, shot))
                warnings.append(f"镜头 {position} 缺少详情行，已按草稿补建。")
            else:
                _apply_shot_detail(detail, shot)
            counts["shots_updated"] += 1
        else:
            shot_id = _new_id("shot")
            db.add(
                Shot(
                    id=shot_id,
                    chapter_id=chapter_id,
                    index=position,
                    title=shot.title or f"镜头 {position}",
                    script_excerpt=shot.script_excerpt,
                )
            )
            db.add(_new_shot_detail(shot_id, shot))
            counts["shots_created"] += 1

        await _sync_shot_character_links(
            db, shot_id=shot_id, names=list(shot.characters), character_ids=character_ids, counts=counts
        )
        await _sync_dialog_lines(
            db,
            shot_id=shot_id,
            lines=list(shot.dialogue),
            character_ids=character_ids,
            warnings=warnings,
            position=position,
            counts=counts,
        )
        if product_id:
            await _sync_shot_product_link(
                db,
                project_id=project.id,
                chapter_id=chapter_id,
                shot_id=shot_id,
                product_id=product_id,
                present=bool(shot.product_present),
                counts=counts,
            )
        elif shot.product_present:
            skipped.append(f"镜头 {position} 标了「出现商品」但没有商品，未建商品关联行")

        # 镜头也要登记来源关系，否则第二次确认认不出"这些镜头是本方案落下的"
        if await _ensure_material(
            db, project_id=project.id, chapter_id=chapter_id, entity_type=ENTITY_SHOT, entity_id=shot_id
        ):
            counts["materials_linked"] += 1

    chapter.storyboard_count = await _count_chapter_shots(db, chapter_id)

    # 4) 草稿行的确认状态（``ad_flow_service.resolve_ad_phase`` 与页面都读它）
    now = datetime.now(timezone.utc)
    draft = await db.get(DramaPlanDraft, chapter_id)
    if draft is None:
        skipped.append("这一集没有草稿行（brief 从未保存），没有可写的确认状态")
    else:
        draft.story_status = STORY_STATUS_CONFIRMED
        draft.confirmed_at = now
        draft.materialized_at = now

    payload = {
        **counts,
        "warnings": warnings,
        "skipped": skipped,
        "next_step": {
            "label": NEXT_STEP_LABEL,
            "url": next_step_url(project.id),
            "chapter_url": next_step_chapter_url(project.id, chapter_id),
        },
    }

    if draft is not None:
        # 落库统计（契约 §一.3：供幂等复核与页面回显）——不含 warnings/skipped 之外的大对象
        draft.materialize_summary = {
            "shots_created": counts["shots_created"],
            "shots_updated": counts["shots_updated"],
            "assets_created": counts["assets_created"],
            "assets_reused": counts["assets_reused"],
            "materials_linked": counts["materials_linked"],
            "shot_product_links": counts["shot_product_links"],
            "skipped": skipped,
            "at": _iso(now),
        }

    await db.flush()
    return payload


def _new_shot_detail(shot_id: str, shot: Any) -> ShotDetail:
    """按草稿建一行镜头详情（景别/机位/运镜/时长/动作拍点）。"""
    return ShotDetail(
        id=shot_id,
        camera_shot=shot.camera_shot or CameraShotType.ms.value,
        angle=shot.angle or CameraAngle.eye_level.value,
        movement=shot.movement or CameraMovement.static.value,
        duration=int(shot.duration or 0),
        action_beats=list(shot.action_beats or []),
        description=shot.description,
        follow_atmosphere=True,
        vfx_type=VFXType.none,
    )


def _apply_shot_detail(detail: ShotDetail, shot: Any) -> None:
    """把草稿里的一镜写进既有详情行（更新模式）。"""
    detail.camera_shot = shot.camera_shot or CameraShotType.ms.value
    detail.angle = shot.angle or CameraAngle.eye_level.value
    detail.movement = shot.movement or CameraMovement.static.value
    detail.duration = int(shot.duration or 0)
    detail.action_beats = list(shot.action_beats or [])
    detail.description = shot.description


__all__ = [
    "FALLBACK_TITLE",
    "MATERIAL_SOURCE_PLAN",
    "NEXT_STEP_LABEL",
    "next_step_chapter_url",
    "next_step_url",
    "materialize_drama_plan",
]
