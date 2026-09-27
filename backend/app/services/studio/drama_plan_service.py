"""「广告剧情流程」的服务编排层：草稿读取 / brief 保存 / 生成 / 确认落库。

为什么要有这一层（而不是把逻辑写在路由里）
==========================================

AGENTS.md 的分层约定：``api`` 层只负责收参、鉴权、响应组织；**业务逻辑、状态流转、数据编排**
放 ``service``。这条链路的编排恰好是最需要集中的一处，因为它把四件事串成一条事务边界明确的流程：

    brief 保存（免费）→ 抢租约（防重复付费）→ 编排层一次调用 → 落草稿（只落草稿）
    → 人工编辑 → confirm（一个事务落正式产物）

另外它替路由挡住两类"结构化明细"的翻译：

- 草稿忙 / 草稿缺失 / 章节非空等 **409** 明细（进 ``meta.error``）；
- 编排层的 **422**（``llm_json_parse_failed``）与 **502**（模型请求失败）。

本轮新增（实施契约 §二「剧情（分层，按阶段生成）」）
==================================================

1. ``generate`` 支持 ``stage``（一句话 / 完整剧情 / 分镜 / 一次出全部）与 ``confirm_overwrite``：
   **人工编辑晚于上次生成时必须显式确认覆盖**，否则 409 —— 不然用户刚改完的稿会被一次
   重生成静默冲掉（这是"重生成需二次确认"的落点，见 :func:`needs_overwrite_confirmation`）；
2. ``save_plan`` 重算 ``stale_flags`` 并记 ``manual_edited_at``：一句话改过 → 完整剧情标记过期，
   完整剧情改过 → 分镜标记过期（时间戳口径见 :func:`compute_stale_flags`）；
3. ``consistency``：**免费**的确定性一致性检查（不调用模型），草稿读取时也随响应下发一份摘要。

诚实边界：``generate`` 在演练模式下**返回占位说明 + 不写 plan**（``llm_called=False``），
而不是抛异常——这样演练能走通全链路，而不像"关掉闸门"那样直接把功能挡住。
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.studio import Chapter, Project, Shot
from app.schemas.studio.drama_plan import (
    DEFAULT_STAGE,
    STAGE_ALL,
    STAGE_ONE_LINER,
    STAGE_STORY,
    STAGE_STORYBOARD,
    DramaBrief,
    DramaPlanConfirmRead,
    DramaPlanConsistencyRead,
    DramaPlanDraft,
    DramaPlanRead,
    DramaPlanStaleFlags,
)
from app.services.studio import drama_consistency
from app.services.studio import drama_plan_drafts as drafts
from app.services.studio import drama_plan_materialize as materialize
from app.services.studio import product_card_service
from app.services.studio.llm_orchestration import drama_plan as orchestration
from app.services.studio.llm_orchestration import drama_story as story_stages

#: 自动建章节时的标题上限（chapter.title 是 String(255)）
MAX_TITLE_CHARS = 120

NOTE_READ = (
    "只读：返回 brief 与草稿，**永不调用模型**。草稿确认之前不会影响章节/分镜/资产的任何正式数据。"
)
NOTE_BRIEF = "brief 已保存（免费，未调用任何模型）。状态与 plan 不受影响：已生成的草稿不会被这次保存弄丢。"
NOTE_CONFIRM = (
    "已把草稿落成正式产物：章节标题/主线/**完整剧情全文**、人物、场景、商品、"
    "分镜（含时长/景别/动作/台词）与关联行。**这一步是幂等的**：再点一次只更新既有行，"
    "不新增任何镜头或资产；返回里的 next_step 就是页面上的下一个主操作。"
)
NOTE_CONSISTENCY = (
    "一致性检查（免费，**没有调用任何模型**）：只做确定性的计数与文本核对，不改动任何数据。"
)


def _iso(value: Any) -> str:
    """把 ORM 的 datetime 转成 ISO 串（页面只展示，不下发内部对象）。"""
    if value is None:
        return ""
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _now() -> datetime:
    """当前时刻（带时区）。时间戳统一用它，方便与库里的 naive datetime 比较。"""
    return datetime.now(timezone.utc)


def _as_aware(value: datetime | None) -> datetime | None:
    """SQLite 取回的 DATETIME 可能是 naive，比较前统一成带时区。"""
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def _parse_iso(value: Any) -> datetime | None:
    """ISO 串 → 带时区 datetime；读不懂一律返回 ``None``（fail-safe：不因此报错）。"""
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return _as_aware(parsed)


# ---------------------------------------------------------------------------
# 过期标记（stale_flags）：一句话 → 完整剧情 → 分镜 的"上游改了，下游过期"
#
# 为什么用"改动时间戳 + 生成时间戳"两个维度，而不是只存一个布尔：
# 布尔只能回答"现在过期没有"，时间戳还能回答"是哪一步改的、什么时候改的"，
# 并且**重生成之后布尔会自动回到 false**（生成时间晚于改动时间），
# 不需要任何"清除标记"的额外代码路径（少一条路径就少一类状态不一致）。
#
# 为什么"下游内容为空时不算过期"：用户只写了一句创意、还没生成完整剧情时，
# 提示"完整剧情可能过期"是假的（根本没有剧情）。所以派生布尔还会要求下游确实有内容。
# ---------------------------------------------------------------------------

#: ``stale_flags`` 的字段全集（库里可能有更早版本写的键，重算时只保留这些）
STALE_KEYS: tuple[str, ...] = (
    "one_liner_changed_at",
    "story_changed_at",
    "story_generated_at",
    "shots_generated_at",
    "story_stale",
    "shots_stale",
    "reasons",
)


def _plan_dict(plan: dict[str, Any] | None) -> dict[str, Any]:
    """拿到一份可安全读取的 plan dict（坏值一律当空）。"""
    return dict(plan) if isinstance(plan, dict) else {}


def _one_liner_of(plan: dict[str, Any] | None) -> str:
    """一句话核心创意的可比较文本（用于判断"这一次是不是改了它"）。"""
    return str(_plan_dict(plan).get("one_liner") or "").strip()


def _story_signature(plan: dict[str, Any] | None) -> tuple[str, ...]:
    """完整剧情的可比较签名（全文 + 五个分栏；任何一格变了都算改过剧情）。"""
    story = _plan_dict(_plan_dict(plan).get("story"))
    return tuple(
        str(story.get(key) or "").strip()
        for key in ("full_text", "hook", "conflict", "product_usage", "climax", "cta")
    )


def derive_stale(flags: dict[str, Any], plan: dict[str, Any] | None) -> dict[str, Any]:
    """由时间戳与当前草稿派生出 ``story_stale`` / ``shots_stale`` / ``reasons``。

    - ``story_stale``：一句话被改过（且改动晚于最后一次生成完整剧情）**并且**草稿里已经有剧情全文；
    - ``shots_stale``：完整剧情被改过（同上）**并且**草稿里已经有镜头。
    """
    one_liner_changed = _parse_iso(flags.get("one_liner_changed_at"))
    story_changed = _parse_iso(flags.get("story_changed_at"))
    story_generated = _parse_iso(flags.get("story_generated_at"))
    shots_generated = _parse_iso(flags.get("shots_generated_at"))
    payload = _plan_dict(plan)
    story = _plan_dict(payload.get("story"))
    has_story = bool(str(story.get("full_text") or "").strip())
    has_shots = bool(payload.get("shots"))

    story_stale = bool(
        one_liner_changed
        and has_story
        and (story_generated is None or one_liner_changed > story_generated)
    )
    shots_stale = bool(
        story_changed and has_shots and (shots_generated is None or story_changed > shots_generated)
    )
    reasons: list[str] = []
    if story_stale:
        reasons.append("一句话核心创意改过了，完整剧情可能已经过期：建议重新生成完整剧情。")
    if shots_stale:
        reasons.append("完整剧情改过了，分镜可能已经过期：建议重新生成分镜。")
    return {
        "one_liner_changed_at": _iso(_parse_iso(flags.get("one_liner_changed_at"))) or "",
        "story_changed_at": _iso(_parse_iso(flags.get("story_changed_at"))) or "",
        "story_generated_at": _iso(_parse_iso(flags.get("story_generated_at"))) or "",
        "shots_generated_at": _iso(_parse_iso(flags.get("shots_generated_at"))) or "",
        "story_stale": story_stale,
        "shots_stale": shots_stale,
        "reasons": reasons,
    }


def compute_stale_flags(
    *,
    previous_flags: dict[str, Any] | None,
    previous_plan: dict[str, Any] | None,
    new_plan: dict[str, Any] | None,
    story_generated: bool = False,
    shots_generated: bool = False,
    now: datetime | None = None,
) -> dict[str, Any]:
    """统一重算过期标记（``save_plan`` 与 ``generate`` 共用同一份口径）。

    - **改动**由内容差异判定（``previous_plan`` 为 ``None`` 表示"之前没有草稿"，
      此时不算改动：第一次写下的东西没有"过期"可言）；
    - **生成**由调用方声明（``story_generated`` / ``shots_generated``），
      重生成会把对应的时间戳推到当前时刻，于是相关的过期标记自动回到 false。
    """
    stamp = (now or _now()).isoformat()
    flags: dict[str, Any] = {
        "one_liner_changed_at": _iso(_parse_iso((previous_flags or {}).get("one_liner_changed_at"))) or "",
        "story_changed_at": _iso(_parse_iso((previous_flags or {}).get("story_changed_at"))) or "",
        "story_generated_at": _iso(_parse_iso((previous_flags or {}).get("story_generated_at"))) or "",
        "shots_generated_at": _iso(_parse_iso((previous_flags or {}).get("shots_generated_at"))) or "",
    }
    # "之前有没有草稿"以**内容**为准：库里没有 plan 时读到的是 ``{}``（不是 ``None``），
    # 那同样意味着"这是第一次写下内容"，不该被算成"改动了上游"。
    has_previous = bool(_plan_dict(previous_plan))
    if has_previous and _one_liner_of(new_plan) != _one_liner_of(previous_plan):
        flags["one_liner_changed_at"] = stamp
    if has_previous and _story_signature(new_plan) != _story_signature(previous_plan):
        flags["story_changed_at"] = stamp
    if story_generated:
        flags["story_generated_at"] = stamp
    if shots_generated:
        flags["shots_generated_at"] = stamp
    return derive_stale(flags, new_plan)


def needs_overwrite_confirmation(row: Any) -> bool:
    """这次生成会不会覆盖掉**人工编辑**？需要用户显式确认才允许。

    判定： ``manual_edited_at`` 晚于上一次成功生成的时间（``meta.generated_at``）。
    从来没有成功生成过、但草稿里已经有内容（用户手填的）同样算需要确认
    —— 覆盖手填内容与覆盖生成内容一样糟。
    """
    edited = _as_aware(getattr(row, "manual_edited_at", None))
    if edited is None:
        return False
    meta = dict(getattr(row, "meta", None) or {})
    generated = _parse_iso(meta.get("generated_at"))
    if generated is None:
        return bool(getattr(row, "plan", None))
    return edited > generated


def _overwrite_detail() -> dict[str, Any]:
    """409 明细：说清"覆盖什么、怎么继续"（用户语言，不带字段名）。"""
    return {
        "code": "drama_plan_overwrite_required",
        "message": "这一集的草稿在你上次生成之后被人工改过，重新生成会把你的修改覆盖掉。",
        "fix": "确认要覆盖就带上 confirm_overwrite=true 再点一次；想保留修改就先复制出来。",
    }


async def _load_chapter_or_404(db: AsyncSession, chapter_id: str) -> Chapter:
    chapter = await db.get(Chapter, chapter_id)
    if chapter is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail=f"章节不存在：{chapter_id}"
        )
    return chapter


def _consistency_payload(
    plan: dict[str, Any] | None, *, chapter_id: str, brief: dict[str, Any] | None = None
) -> dict[str, Any] | None:
    """给读模型用的一致性摘要（纯计算、不花钱）；没有草稿内容时返回 ``None``。"""
    payload = _plan_dict(plan)
    if not payload:
        return None
    try:
        checked = drama_consistency.check_plan_consistency(
            payload, brief_product_name=str((brief or {}).get("product_name") or "")
        )
    except Exception:  # noqa: BLE001 - 摘要不该让整个读取失败（检查器本身也不该抛，这里兜底）
        return None
    return DramaPlanConsistencyRead(chapter_id=chapter_id, **checked).model_dump()


def _read_payload(chapter: Chapter, row: Any, *, note: str) -> dict[str, Any]:
    """草稿行 → 页面读模型（无行 = 从没保存过 brief）。

    带上 ``stale_flags``（过期提示的依据）与 ``consistency`` 摘要（免费检查的结果）：
    页面据此显示"一句话改过 → 详细剧情可能过期""商品覆盖不足"这类提示，
    而这两件事都不需要再调一次模型。
    """
    if row is None:
        return DramaPlanRead(
            chapter_id=chapter.id,
            project_id=chapter.project_id,
            has_draft=False,
            status="none",
            brief=DramaBrief(),
            plan=None,
            note=note,
        ).model_dump()
    plan_payload = row.plan if isinstance(row.plan, dict) and row.plan else None
    plan: DramaPlanDraft | None = None
    if plan_payload:
        try:
            plan = DramaPlanDraft.model_validate(plan_payload)
        except Exception:  # noqa: BLE001 - 库里草稿结构坏了要如实显示为空，而不是 500
            plan = None
    brief_payload = dict(row.brief or {})
    return DramaPlanRead(
        chapter_id=chapter.id,
        project_id=chapter.project_id,
        has_draft=True,
        status=drafts.short_status(row),
        brief=DramaBrief.model_validate(brief_payload),
        plan=plan,
        stale_flags=DramaPlanStaleFlags.model_validate(dict(row.stale_flags or {})),
        consistency=_consistency_payload(
            plan_payload, chapter_id=chapter.id, brief=brief_payload
        ),
        error=str(row.error or ""),
        model=str(row.model or ""),
        meta=dict(row.meta or {}),
        claim_expires_at=_iso(row.claim_expires_at),
        updated_at=_iso(row.updated_at),
        # 确认状态与落库统计：刷新后页面靠它们认出"这一集已经确认过了"，
        # 从而把主按钮换成「继续准备资产」而不是又回到「确认策划」。
        story_status=str(row.story_status or "none"),
        confirmed_at=_iso(row.confirmed_at),
        materialized_at=_iso(row.materialized_at),
        materialize_summary=dict(row.materialize_summary or {}),
        note=note,
    ).model_dump()


async def load_plan(db: AsyncSession, *, chapter_id: str) -> dict[str, Any]:
    """读取草稿（只读，永不付费）。"""
    chapter = await _load_chapter_or_404(db, chapter_id)
    row = await drafts.get_draft(db, chapter_id)
    return _read_payload(chapter, row, note=NOTE_READ)


async def save_brief(
    db: AsyncSession,
    *,
    chapter_id: str,
    brief: dict[str, Any],
) -> dict[str, Any]:
    """保存 brief（免费，**绝不触发模型调用**）。"""
    chapter = await _load_chapter_or_404(db, chapter_id)
    row = await drafts.save_brief(
        db, chapter_id=chapter_id, project_id=chapter.project_id, brief=brief
    )
    return _read_payload(chapter, row, note=NOTE_BRIEF)


async def generate(
    db: AsyncSession,
    *,
    chapter_id: str,
    stage: str = DEFAULT_STAGE,
    confirm_overwrite: bool = False,
) -> dict[str, Any]:
    """生成剧情方案草稿（**真实付费出口**；租约防重复，演练不写 plan）。

    三个闸门都在**抢租约之前**（不合格就不该花这次钱）：

    1. ``stage`` 合法（非法 → 422）；
    2. 人工编辑晚于上次生成 → 必须 ``confirm_overwrite=true``，否则 409；
    3. 阶段前置条件（``story`` 要有已确认的一句话、``storyboard`` 要有完整剧情）→ 409。
    """
    chapter = await _load_chapter_or_404(db, chapter_id)
    resolved_stage = story_stages.parse_stage(stage)

    existing = await drafts.get_draft(db, chapter_id)
    if existing is not None:
        if needs_overwrite_confirmation(existing) and not confirm_overwrite:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail=_overwrite_detail()
            )
        current_draft, _ = story_stages.as_draft(existing.plan)
        story_stages.require_stage_prerequisites(resolved_stage, current_draft)

    row, token = await drafts.claim_for_generate(db, chapter_id=chapter_id)
    brief = dict(row.brief or {})
    # **商品卡是生成剧情的输入**（契约 §二：商品卡 → 分层剧情）。
    # brief 是在创建项目那一刻写的，那时卡还是空的；用户后来确认的商品卡必须盖上来，
    # 否则模型拿不到名称 / 卖点 / 人群，就会自己编一个商品（实测真机跑出过
    # 「花漾焕颜精华露」，而用户确认的卡里写的是「紧致焕颜精华」）。
    # 覆盖层只认**已确认**的卡、且空字段不覆盖，详见 `product_card_service.brief_overlay`。
    overlay = await product_card_service.brief_overlay(db, project_id=chapter.project_id)
    if overlay:
        merged = {**brief, **overlay}
        merged["forbidden_elements"] = list(
            dict.fromkeys(
                [*list(brief.get("forbidden_elements") or []), *list(overlay.get("forbidden_elements") or [])]
            )
        )
        brief = merged
    previous_plan = dict(row.plan or {})
    previous_flags = dict(row.stale_flags or {})
    started_at = _now()

    try:
        if resolved_stage == STAGE_ALL:
            result = await orchestration.preview_drama_plan(db, chapter_id=chapter_id, brief=brief)
        else:
            result = await orchestration.preview_drama_stage(
                db,
                chapter_id=chapter_id,
                brief=brief,
                stage=resolved_stage,
                current_plan=previous_plan,
            )
    except HTTPException as exc:
        # 解析失败(422) / 模型请求失败(502)：把失败如实写回草稿行（**不动已有 plan**），
        # 让页面能显示"上次失败原因"，而不是让状态永远停在 running。
        await drafts.mark_failed(
            db,
            chapter_id=chapter_id,
            token=token,
            error=str(exc.detail if isinstance(exc.detail, str) else exc.detail),
            meta={"status_code": exc.status_code},
        )
        raise
    except Exception as exc:  # noqa: BLE001 - 任何异常都要释放租约，否则会卡住 5 分钟
        await drafts.mark_failed(db, chapter_id=chapter_id, token=token, error=f"{type(exc).__name__}: {exc}")
        raise

    plan = result.get("plan")
    meta = result.get("meta")
    meta_dict = meta.model_dump() if hasattr(meta, "model_dump") else dict(meta or {})
    model_name = ""
    target = meta_dict.get("target") if isinstance(meta_dict, dict) else None
    if isinstance(target, dict):
        model_name = str(target.get("model_name") or "")
    warnings = list(result.get("warnings") or [])

    if plan:
        # 成功：只把归一化后的草稿写进草稿列（**正式行仍然一行都不写**）
        plan_dict = dict(plan) if isinstance(plan, dict) else {}
        plan_dict.setdefault("warnings", warnings)
        row = await drafts.mark_ok(
            db,
            chapter_id=chapter_id,
            token=token,
            plan=plan_dict,
            model=model_name,
            # generated_at：**重生成需二次确认**的判定依据（见 needs_overwrite_confirmation）；
            # stage：对账与"上次生成的是哪一段"的回显。
            meta={**meta_dict, "warnings": warnings, "stage": resolved_stage, "generated_at": started_at.isoformat()},
        )
        if row is None:  # 租约在生成期间被别人抢走（过期）→ 不覆盖别人的结果
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={
                    "code": "drama_plan_lease_lost",
                    "message": "生成本次结果时租约已失效（可能已过期或被重新抢占），结果未写入。",
                    "fix": "重新点一次生成（如果上一次的结果其实已经写进去了，页面会显示它）。",
                },
            )
        # 过期标记：本阶段生成把对应的时间戳推到当前时刻，于是相关的过期提示自动消失。
        row.stale_flags = compute_stale_flags(
            previous_flags=previous_flags,
            previous_plan=previous_plan,
            new_plan=plan_dict,
            story_generated=resolved_stage in (STAGE_STORY, STAGE_ALL),
            shots_generated=resolved_stage in (STAGE_STORYBOARD, STAGE_ALL),
            now=_now(),
        )
        await db.flush()
        await db.refresh(row)
    else:
        # 演练：不写 plan，但把"未调用模型"如实写进 meta，且**不把状态标成 ok**
        # （也**不写 generated_at**：没生成过就不能算"上次生成"，否则会误放过覆盖确认）
        current = await drafts.get_draft(db, chapter_id)
        if current is not None and str(current.claim_token or "") == token:
            current.claim_token = None
            current.claim_expires_at = None
            current.meta = {**meta_dict, "warnings": warnings, "stage": resolved_stage, "llm_called": False}
            current.status = drafts.STATUS_NONE if not current.plan else current.status
            await db.flush()
            await db.refresh(current)
            row = current

    refreshed = await drafts.get_draft(db, chapter_id)
    note = str(result.get("note") or NOTE_READ)
    if warnings and not plan:
        note = f"{note} " + "；".join(warnings)
    return _read_payload(chapter, refreshed or row, note=note)


async def save_plan(
    db: AsyncSession,
    *,
    chapter_id: str,
    plan: dict[str, Any],
) -> dict[str, Any]:
    """保存**人工编辑后**的草稿（免费，**只写草稿列**，绝不落正式行）。

    为什么需要它（需求里的一个缺口）：需求说「人工编辑直接改 plan JSON 草稿列」，
    但四件套里没有"保存编辑"的端点 —— 不补的话编辑只能活在浏览器内存里，
    刷新就丢，与"草稿刷新不丢"的验收矛盾。
    """
    chapter = await _load_chapter_or_404(db, chapter_id)
    row = await drafts.get_draft(db, chapter_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "drama_plan_brief_required",
                "message": "这一集还没有保存过商品信息（brief），没有草稿可改。",
                "fix": "先保存 brief（免费），再点生成或手工填一份草稿。",
            },
        )
    if drafts.lease_active(row):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "drama_plan_generating",
                "message": "这一集正在生成中，先等它结束再保存手改的草稿（否则会被生成结果覆盖）。",
                "fix": "等生成结束后重新保存。",
            },
        )
    # 两步走：先按 DTO 校验**结构**（类型/必填/多余字段），再跑确定性归一化。
    # 分两步的理由：结构坏掉时若直接进归一化，用户会收到"模型返回里没有可用镜头"这种
    # 与他的手改无关的报错；这里要给他"草稿结构不合法"的准确原因。
    try:
        DramaPlanDraft.model_validate(plan or {})
    except Exception as exc:  # noqa: BLE001 - 结构不合法要如实报，不能把坏草稿写进库
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "code": "drama_plan_invalid_draft",
                "message": f"草稿结构不合法，未保存：{exc}",
                "fix": "检查镜头字段的类型（shots 必须是数组、每镜要有 index 与 title 等）。",
            },
        ) from exc

    # 手改草稿走**和模型产物同一套**确定性归一化：景别/机位/运镜别名、时长档位、
    # 镜头序号连续、悬空角色引用剔除，以及一句话/完整剧情/人物关系的字段归一。
    # 理由：这些字段在 DTO 里是普通字符串，不归一的话 `shot_details.camera_shot`
    # 会把「不存在的景别」这种脏值原样落库。
    # 归一化产生的 warning 随草稿返回，页面可以显示，不会静默改掉用户输入。
    # ``allow_empty_shots=True``：分层流程允许先只写一句话/完整剧情（还没有镜头），
    # 那不该被当成"生成失败"（一次出全部时才必须有镜头，那条默认值没变）。
    plan_dto, warnings = orchestration.postprocess_plan(
        plan or {},
        shot_count=max(1, len((plan or {}).get("shots") or [])),
        allow_empty_shots=True,
    )
    plan_dto.warnings = list(dict.fromkeys([*(plan_dto.warnings or []), *warnings]))
    previous_plan = dict(row.plan or {})
    previous_flags = dict(row.stale_flags or {})
    row.plan = plan_dto.model_dump()
    # 过期标记：一句话改过 → 完整剧情过期；完整剧情改过 → 分镜过期（时间戳口径见 compute_stale_flags）
    row.stale_flags = compute_stale_flags(
        previous_flags=previous_flags,
        previous_plan=previous_plan,
        new_plan=row.plan,
        now=_now(),
    )
    # 人工编辑时间：**重生成需二次确认**的判定依据（见 needs_overwrite_confirmation）
    row.manual_edited_at = _now()
    # 策划确认状态：改过草稿之后就不再是"已确认"（确认过的正式产物已经与草稿不一致了）
    if str(row.story_status or "none") != "draft":
        row.story_status = "draft"
    # 生成状态（status）不在这里改：它表达的是「模型生成过没有」，手改草稿不改变这个事实
    await db.flush()
    await db.refresh(row)
    return _read_payload(
        chapter,
        row,
        note="草稿已保存（免费）。正式产物要等你点「确认落成正式内容」。",
    )


async def consistency(db: AsyncSession, *, chapter_id: str) -> dict[str, Any]:
    """一致性检查（**免费、不调用任何模型、不写任何行**）。

    检查项（全部是确定性的计数与文本核对，见 ``drama_consistency``）：
    商品是否在分镜出现且覆盖 ≥ 一半、主要人物是否都在人物表、
    核心冲突/结局能否在分镜里对应、分镜是否引用未知角色或未知资产、
    完整剧情是否为空或过短。

    **没有草稿时返回 200 + ``ok=false``**（而不是 409）：这是一个"免费诊断"出口，
    "还没有内容"本身就是它的诊断结果，页面照常显示"先生成一句话创意"。
    """
    chapter = await _load_chapter_or_404(db, chapter_id)
    row = await drafts.get_draft(db, chapter_id)
    plan_payload = dict(row.plan or {}) if row is not None else {}
    brief_payload = dict(row.brief or {}) if row is not None else {}
    checked = drama_consistency.check_plan_consistency(
        plan_payload, brief_product_name=str(brief_payload.get("product_name") or "")
    )
    payload = DramaPlanConsistencyRead(chapter_id=chapter.id, **checked).model_dump()
    payload["note"] = NOTE_CONSISTENCY
    return payload


async def confirm(db: AsyncSession, *, chapter_id: str) -> dict[str, Any]:
    """确认落库（materialize，一个事务；失败整体回滚）。"""
    chapter = await _load_chapter_or_404(db, chapter_id)
    row = await drafts.get_draft(db, chapter_id)
    if row is None or not row.plan:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "drama_plan_draft_missing",
                "message": "这一集还没有生成过剧情方案草稿，没有可确认的内容。",
                "fix": "先保存 brief 并点「生成剧情方案」。",
            },
        )
    counts = await materialize.materialize_drama_plan(db, chapter_id=chapter_id, plan=dict(row.plan))
    payload = DramaPlanConfirmRead(**counts).model_dump()
    payload["note"] = NOTE_CONFIRM
    return payload


async def resolve_working_chapter(
    db: AsyncSession,
    *,
    project_id: str,
    product_name: str = "",
) -> dict[str, Any]:
    """给"项目内进入剧情策划"找一个可用章节：优先**还没有分镜的空章节**，没有就建一个。

    为什么需要它：剧情策划的四个动作都是**章节级**的（``/chapters/{id}/drama-plan``），
    而入口在项目里。自动建章节的标题取商品名，这样用户在项目列表里能一眼看出
    "这一集是做这个商品的"。
    """
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"项目不存在：{project_id}")

    rows = (
        await db.execute(
            select(Chapter).where(Chapter.project_id == project_id).order_by(Chapter.index)
        )
    ).scalars().all()
    for chapter in rows:
        # 只认"没有分镜"的章节：有分镜的章节 confirm 会被拒（避免新旧分镜混在一起），
        # 所以这里先挑干净的那一个，别让用户填完 brief 才发现落不了库。
        shots = await db.scalar(
            select(func.count()).select_from(Shot).where(Shot.chapter_id == chapter.id)
        )
        if not shots:
            return {
                "chapter_id": chapter.id,
                "project_id": project_id,
                "created": False,
                "title": chapter.title,
            }

    next_index = max((int(item.index or 0) for item in rows), default=0) + 1
    title = (product_name or "").strip()[:MAX_TITLE_CHARS] or f"第 {next_index} 集 · 剧情广告"
    chapter = Chapter(
        id=f"chap-{uuid.uuid4().hex[:16]}",
        project_id=project_id,
        index=next_index,
        title=title,
    )
    db.add(chapter)
    await db.flush()
    return {"chapter_id": chapter.id, "project_id": project_id, "created": True, "title": chapter.title}


__all__ = [
    "STALE_KEYS",
    "compute_stale_flags",
    "confirm",
    "consistency",
    "derive_stale",
    "generate",
    "load_plan",
    "needs_overwrite_confirmation",
    "resolve_working_chapter",
    "save_brief",
    "save_plan",
]
