"""P3 出图管线：定妆照 → 垫图批量 → OSS。

主流流程（对齐全链路方案 §环节 3）：
1. 先出**角色定妆照**（角色正面资产图），人工审核后在 Jellyfish 里把该图设为
   ``is_primary=True``（走既有 ``POST /studio/entities/character/{id}/images``）；
2. 批量出场景图 / 关键帧时，用定版主图做**垫图**（``asset.reference_image``）；
3. 结果由出图服务上传 OSS，回读 ``images[].oss_url`` 作为长期资产地址。

硬边界：
- 本模块**不写数据库**：只读资产/画像/定版图，提交结果由调用方走既有端点落库；
- 提交前必须过 DRY_RUN 守卫（出图服务在本机，出站兜底拦不住它，见 external_image_client 注释）；
- 默认 DRY_RUN：提交返回 `dry_run=True` 的占位结果，一个真实请求都不发。
"""

from __future__ import annotations

import asyncio
import hashlib
import re
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.studio import Character, Costume, Prop, Scene
from app.models.types import PromptCategory
from app.schemas.studio.image_pipeline import (
    ImageTaskResultRead,
    SubmissionTargetRead,
)
from app.services.studio.image_pipeline import external_image_client as client
from app.services.studio.image_pipeline import reference_preflight
from app.services.studio.image_pipeline.reference_resolver import (
    IMAGE_MODEL_BY_ASSET_TYPE,
    ReferenceImage,
    resolve_references,
)
from app.services.studio.llm_orchestration import dry_run
from app.services.studio.llm_orchestration.context import build_profile_cards
from app.services.studio.llm_orchestration.image_prompt import assemble_image_prompt
from app.services.studio.llm_orchestration.registry import (
    DEFAULT_QUALITY_WORDS,
    DEFAULT_STYLE_WORDS,
    IMAGE_PROMPT_SLOT_BY_CATEGORY,
    SLOT_STYLE_RULES,
    ImagePromptSlotSpec,
)
from app.schemas.studio.llm_orchestration import EntityProfileInput

DEFAULT_ASPECT_RATIO = "16:9"
DEFAULT_POLL_INTERVAL_SECONDS = 2.0
MAX_POLL_SECONDS = 120.0

# 资产类型 → 出图服务支持的 generation_type（单一事实来源在客户端模块）
GENERATION_TYPE_BY_ASSET_TYPE: dict[str, str] = client.DEFAULT_GENERATION_TYPE

# 资产类型 → 用于组装确定性提示词的图片槽位
SLOT_BY_ASSET_TYPE: dict[str, PromptCategory] = {
    "character": PromptCategory.character_image_front,
    "scene": PromptCategory.scene_image_front,
    "prop": PromptCategory.prop_image_front,
    "costume": PromptCategory.costume_image_front,
}

ASSET_TYPE_ZH: dict[str, str] = {
    "character": "角色",
    "scene": "场景",
    "prop": "道具",
    "costume": "服装",
}


# 提示词来源枚举（与 ``SubmissionTarget.prompt_source`` 一一对应）
PROMPT_SOURCE_REQUEST = "request"
PROMPT_SOURCE_SAVED = "saved"
PROMPT_SOURCE_TEMPLATE = "template"


def saved_image_prompt(row: Any, slot_category: PromptCategory | None) -> str:
    """取该资产**已保存**的槽位图片提示词（``{entities}.image_prompts[<category>]``）。

    这是断点①的落点：步骤 3「图片准备」里确认保存的提示词，必须真的成为生图输入。
    之前只有 legacy 的 ``build_base`` 那条路读它，本管线（plan/submit）读不到，
    表现为「保存了但生图用的是模板文本」。
    """
    if slot_category is None:
        return ""
    prompts = getattr(row, "image_prompts", None)
    if not isinstance(prompts, dict) or not prompts:
        return ""
    return str(prompts.get(str(slot_category.value)) or "").strip()


@dataclass(slots=True)
class SubmissionTarget:
    """一个待提交给出图服务的单资产单图任务。"""

    source_task_id: str
    source_asset_id: str
    asset_type: str
    name: str
    prompt: str
    stage: str = "reference_batch"
    negative_prompt: str = ""
    style_tags: list[str] = field(default_factory=list)
    reference_image: str = ""
    generation_type: str = ""
    aspect_ratio: str = DEFAULT_ASPECT_RATIO
    image_model: str = ""
    object_key_template: str = ""
    profile_card: str = ""
    # 提示词实际来自哪里：request（调用方显式传）/ saved（步骤 3 已保存的 image_prompts）/
    # template（确定性模板 + 资产描述）。用户要求「验收必须能证明保存内容被下一步实际使用」，
    # 所以这个来源必须显式带出来，不能只靠肉眼比对文本。
    prompt_source: str = PROMPT_SOURCE_TEMPLATE
    warnings: list[str] = field(default_factory=list)

    def to_read(self) -> SubmissionTargetRead:
        return SubmissionTargetRead(
            source_task_id=self.source_task_id,
            source_asset_id=self.source_asset_id,
            asset_type=self.asset_type,
            name=self.name,
            prompt=self.prompt,
            stage=self.stage,
            negative_prompt=self.negative_prompt,
            style_tags=list(self.style_tags),
            reference_image=self.reference_image,
            generation_type=self.generation_type,
            aspect_ratio=self.aspect_ratio,
            image_model=self.image_model,
            object_key_template=self.object_key_template,
            prompt_source=self.prompt_source,
            warnings=list(self.warnings),
        )

    def to_asset_payload(self) -> dict[str, Any]:
        """转成出图服务 ``asset`` 字段。"""
        payload: dict[str, Any] = {
            "asset_type": self.asset_type,
            "name": self.name,
            "prompt": self.prompt,
            "description": self.profile_card,
        }
        if self.negative_prompt:
            payload["negative_prompt"] = self.negative_prompt
        if self.style_tags:
            payload["style_tags"] = list(self.style_tags)
        if self.reference_image:
            payload["reference_image"] = self.reference_image
        return payload

    def to_generation_payload(self) -> dict[str, Any]:
        """转成出图服务 ``generation`` 字段（V0 只支持单资产单图）。"""
        payload: dict[str, Any] = {
            "requested_count": 1,
            "generation_type": self.generation_type or GENERATION_TYPE_BY_ASSET_TYPE.get(self.asset_type, ""),
        }
        if self.image_model:
            payload["image_model"] = self.image_model
        if self.aspect_ratio:
            payload["aspect_ratio"] = self.aspect_ratio
        return payload


# ---------------------------------------------------------------------------
# 幂等键与确定性提示词
# ---------------------------------------------------------------------------


def build_source_task_id(*, project_id: str, asset_type: str, asset_id: str, prompt: str) -> str:
    """稳定幂等键：同一项目+资产+提示词重复提交会被出图服务识别为同一任务。"""
    digest = hashlib.sha1(str(prompt or "").encode("utf-8")).hexdigest()[:8]
    return f"jellyfish:{project_id or 'unknown'}:{asset_type}:{asset_id}:{digest}"


def build_object_key_template(*, project_id: str, asset_type: str) -> str:
    """OSS 对象键模板，交给出图服务落长期资产。"""
    return f"jellyfish/{project_id or 'unknown'}/{asset_type}/{{asset_id}}_{{index}}.png"


def build_deterministic_prompt(*, name: str, asset_type: str, description: str, view_hint: str = "") -> str:
    """用画像卡 + 槽位默认值拼一条确定性提示词（不调模型）。

    调用方可以用 ``prompt_overrides`` 覆盖成 P1 逐槽位生成的提示词。
    """
    slot_category = SLOT_BY_ASSET_TYPE.get(asset_type)
    slot_spec: ImagePromptSlotSpec | None = IMAGE_PROMPT_SLOT_BY_CATEGORY.get(str(slot_category.value)) if slot_category else None
    card = build_profile_cards(
        [EntityProfileInput(name=name, entity_type=asset_type, profile=description)],
        source="project",
    )
    layers = {
        "subject": card[0].canonical_subject if card else f"{name}（{ASSET_TYPE_ZH.get(asset_type, asset_type)}）",
        "action_pose": view_hint or (slot_spec.view_hint if slot_spec else "自然展示"),
        "environment": "干净背景",
        "camera_language": "中景平视，柔和主光",
        "style": ", ".join(
            [DEFAULT_STYLE_WORDS, *(SLOT_STYLE_RULES.get(str(slot_category.value), ()) if slot_category else ())]
        ),
        "quality": DEFAULT_QUALITY_WORDS,
    }
    return assemble_image_prompt(layers)


async def _load_asset_rows(
    db: AsyncSession,
    *,
    project_id: str,
    asset_type: str,
) -> list[Any]:
    """按类型装载项目内资产（角色按 project_id，其余按项目关联表）。"""
    from app.models.studio import ProjectCostumeLink, ProjectPropLink, ProjectSceneLink

    if asset_type == "character":
        stmt = select(Character).where(Character.project_id == project_id).order_by(Character.id)
    elif asset_type == "scene":
        stmt = (
            select(Scene)
            .join(ProjectSceneLink, ProjectSceneLink.scene_id == Scene.id)
            .where(ProjectSceneLink.project_id == project_id)
            .order_by(Scene.id)
        )
    elif asset_type == "prop":
        stmt = (
            select(Prop)
            .join(ProjectPropLink, ProjectPropLink.prop_id == Prop.id)
            .where(ProjectPropLink.project_id == project_id)
            .order_by(Prop.id)
        )
    elif asset_type == "costume":
        stmt = (
            select(Costume)
            .join(ProjectCostumeLink, ProjectCostumeLink.costume_id == Costume.id)
            .where(ProjectCostumeLink.project_id == project_id)
            .order_by(Costume.id)
        )
    else:
        return []
    return list((await db.execute(stmt)).scalars().all())


async def build_targets(
    db: AsyncSession,
    *,
    project_id: str,
    asset_type: str,
    stage: str,
    asset_ids: list[str] | None = None,
    prompt_overrides: dict[str, str] | None = None,
    use_primary_reference: bool = True,
    aspect_ratio: str = DEFAULT_ASPECT_RATIO,
    image_model: str = "",
    negative_prompt: str = "",
) -> tuple[list[SubmissionTarget], list[str]]:
    """组装提交目标。``stage=character_sheet`` 时不带垫图，``stage=reference_batch`` 时带定版垫图。"""
    warnings: list[str] = []
    overrides = {str(k): str(v) for k, v in (prompt_overrides or {}).items() if str(v).strip()}

    if asset_type not in client.SERVICE_ASSET_TYPES:
        raise ValueError(
            f"出图服务 V0 只支持 asset_type ∈ {list(client.SERVICE_ASSET_TYPES)}；"
            f"当前 {asset_type or '空'} 不在其契约内，无法提交。"
        )

    # 图片模型固定策略：请求里可以写标签（image2），这里统一解析成 provider 实际模型。
    resolved_image_model, model_source = client.resolve_image_provider_model(image_model)
    if model_source == "passthrough":
        warnings.append(
            f"图片模型「{image_model}」不在出图服务的选项表 {sorted(set(client.IMAGE_MODEL_CHOICES))} 内，"
            f"已原样透传给对端，对端可能报错。"
        )
    else:
        warnings.append(
            f"图片模型：{image_model or client.image_model_choice()} → provider 模型 {resolved_image_model}。"
        )

    rows = await _load_asset_rows(db, project_id=project_id, asset_type=asset_type)
    wanted = {str(x) for x in asset_ids or [] if str(x).strip()}
    if wanted:
        rows = [row for row in rows if row.id in wanted]
        missing = wanted - {row.id for row in rows}
        if missing:
            warnings.append(f"以下资产 ID 不在项目 {project_id} 内，已忽略：{sorted(missing)}。")
    if not rows:
        return [], [*warnings, f"项目 {project_id} 内没有可提交的 {ASSET_TYPE_ZH.get(asset_type, asset_type)}。"]
    if stage == "reference_batch" and len(rows) > 1:
        warnings.append(f"本批共 {len(rows)} 个{ASSET_TYPE_ZH.get(asset_type, asset_type)}，出图服务 V0 为单资产单图，将逐个提交。")

    references: dict[str, ReferenceImage] = {}
    if stage == "reference_batch" and use_primary_reference:
        references = await resolve_references(db, asset_type=asset_type, asset_ids=[row.id for row in rows])

    targets: list[SubmissionTarget] = []
    for row in rows:
        description = str(getattr(row, "description", "") or "")
        slot_category = SLOT_BY_ASSET_TYPE.get(asset_type)
        slot_spec = IMAGE_PROMPT_SLOT_BY_CATEGORY.get(str(slot_category.value)) if slot_category else None
        override = overrides.get(row.id) or ""
        saved = saved_image_prompt(row, slot_category)
        if override:
            prompt, prompt_source = override, PROMPT_SOURCE_REQUEST
        elif saved:
            # 断点①：上一环确认保存的提示词直接作为生图输入，不被模板覆盖
            prompt, prompt_source = saved, PROMPT_SOURCE_SAVED
        else:
            prompt, prompt_source = (
                build_deterministic_prompt(
                    name=str(row.name or row.id),
                    asset_type=asset_type,
                    description=description,
                    view_hint=slot_spec.view_hint if slot_spec else "",
                ),
                PROMPT_SOURCE_TEMPLATE,
            )
        target_warnings: list[str] = []
        reference = references.get(row.id)
        reference_url = ""
        if reference is not None:
            target_warnings.extend(reference.warnings)
            reference_url = reference.url if use_primary_reference else ""
            if use_primary_reference and not reference_url:
                target_warnings.append("没有可用垫图：本次会以纯文本提示词出图，一致性可能下降。")
        targets.append(
            SubmissionTarget(
                source_task_id=build_source_task_id(
                    project_id=project_id, asset_type=asset_type, asset_id=row.id, prompt=prompt
                ),
                source_asset_id=row.id,
                asset_type=asset_type,
                name=str(row.name or row.id),
                prompt=prompt,
                stage=stage,
                negative_prompt=negative_prompt,
                style_tags=[str(t) for t in (getattr(row, "tags", None) or [])],
                reference_image=reference_url,
                generation_type=GENERATION_TYPE_BY_ASSET_TYPE.get(asset_type, ""),
                aspect_ratio=aspect_ratio or DEFAULT_ASPECT_RATIO,
                prompt_source=prompt_source,
                image_model=resolved_image_model,
                object_key_template=build_object_key_template(project_id=project_id, asset_type=asset_type),
                profile_card=description,
                warnings=target_warnings,
            )
        )
    return targets, warnings


# ---------------------------------------------------------------------------
# 提交（受守卫）与 OSS 回读
# ---------------------------------------------------------------------------


def _dry_run_result(target: SubmissionTarget) -> ImageTaskResultRead:
    """DRY_RUN 占位结果：结构完整、地址不可达、绝不触网。"""
    return ImageTaskResultRead(
        source_task_id=target.source_task_id,
        source_asset_id=target.source_asset_id,
        asset_type=target.asset_type,
        stage=target.stage,
        service_task_id=dry_run.fake_task_id("image", target.source_asset_id),
        status="dry_run",
        outcome=OUTCOME_DRY_RUN,
        ok=True,
        dry_run=True,
        image_url=dry_run.fake_image_url(target.source_asset_id),
        oss_url="",
        oss_ready=False,
        message="[DRY_RUN] 未提交给出图服务；这是占位结果，不是真实图片地址。",
        detail={
            "error_message": "",
            "http_status": None,
            "note": "[DRY_RUN] 占位结果，未提交任何出图请求。",
        },
    )


def reference_candidates(targets: list[SubmissionTarget]) -> list[reference_preflight.ReferenceCandidate]:
    """把提交目标里的垫图抽成「提交前预检」的候选（只取真的要发出去的那些）。

    ``allow_data_url=False``：出图服务（另一个进程/服务）是**自己抓这个地址**的，
    内嵌 base64 在这里没有意义，必须是真的公网 http(s) 地址。
    """
    candidates: list[reference_preflight.ReferenceCandidate] = []
    for target in targets:
        url = str(target.reference_image or "").strip()
        if not url:
            continue
        candidates.append(
            reference_preflight.ReferenceCandidate(
                label=f"{ASSET_TYPE_ZH.get(target.asset_type, target.asset_type)}「{target.name}」的定版垫图",
                url=url,
                role="reference_image",
            )
        )
    return candidates


async def submit_targets(
    targets: list[SubmissionTarget],
    *,
    wait_seconds: float = 0.0,
    transport: Any = None,
    preflight: Any = None,
) -> list[ImageTaskResultRead]:
    """逐个提交（出图服务 V0 单资产单图），可选有界等待产物。

    DRY_RUN 开启时**不触网**，每个目标返回占位结果。

    ``preflight``：可注入的「提交前参考图可达性预检」（见
    ``reference_preflight``）。路由层会传真实实现；不传＝不预检（既有单测走这条，
    保证不触网）。预检不通过时**一个任务都不会提交**。
    """
    results: list[ImageTaskResultRead] = []
    if preflight is not None and targets and not dry_run.dry_run_enabled():
        await preflight(reference_candidates(targets))
    for target in targets:
        if dry_run.dry_run_enabled():
            results.append(_dry_run_result(target))
            continue

        task = await client.create_asset_image_task(
            source_task_id=target.source_task_id,
            source_asset_id=target.source_asset_id,
            asset=target.to_asset_payload(),
            generation=target.to_generation_payload(),
            source_project_id="",
            oss_object_key_template=target.object_key_template,
            transport=transport,
        )
        detail = None
        if wait_seconds and wait_seconds > 0 and task.service_task_id:
            detail = await poll_task(task.service_task_id, wait_seconds=wait_seconds, transport=transport)
        results.append(_result_from_submission(target, task=task, detail=detail))
    return results


def _result_from_submission(
    target: SubmissionTarget,
    *,
    task: client.ServiceTaskResult,
    detail: client.ServiceTaskDetail | None,
) -> ImageTaskResultRead:
    """把「创建响应 + 可选轮询详情」归一化成一条结果。

    故障 B 的坑在这里：出图服务在**上游图片已生成、但它自己 OSS 上传失败**时返回
    ``partial_failed``。旧代码 ``ok=task.ok``（上游 ``data.get("ok", True)``）恒为 true，
    ``message`` 又先取笼统的 ``task.message``，于是「部分失败」被当成功透传。

    现在的口径：

    - ``error_message`` 优先取 ``detail.error_message``（上游真正的失败原因）；
    - ``status`` 保留上游原文，另给归一化的 ``outcome``；
    - ``ok`` 只在 ``outcome == ok`` 时为 true（部分失败 = false）。
    """
    status = str(detail.status if detail is not None else task.status or "")
    upstream_error = str(getattr(detail, "error_message", "") or "").strip() if detail is not None else ""
    oss_url = str(getattr(detail, "oss_url", "") or "") if detail is not None else ""
    local_path = str(getattr(detail, "local_path", "") or "") if detail is not None else ""
    images = list(getattr(detail, "images", []) or []) if detail is not None else []

    outcome = normalize_outcome(
        status=status,
        ok=bool(task.ok),
        oss_url=oss_url,
        dry_run=False,
        error_message=upstream_error or str(task.message or ""),
    )
    # 失败时优先说真话：上游的 error_message 排在笼统的创建响应 message 之前
    message = upstream_error or (
        str(task.message or "") if outcome in {OUTCOME_OK, OUTCOME_RUNNING} else ""
    ) or str(task.message or "")
    return ImageTaskResultRead(
        source_task_id=target.source_task_id,
        source_asset_id=target.source_asset_id,
        asset_type=target.asset_type,
        stage=target.stage,
        service_task_id=task.service_task_id,
        status=status,
        outcome=outcome,
        ok=outcome == OUTCOME_OK,
        dry_run=False,
        image_url=local_path,
        oss_url=oss_url,
        oss_ready=bool(oss_url),
        message=message,
        error_message=upstream_error,
        http_status=_http_status_from_text(upstream_error) if upstream_error else None,
        detail={
            "error_message": upstream_error,
            "http_status": _http_status_from_text(upstream_error) if upstream_error else None,
            "oss_url": oss_url,
            "local_path": local_path,
            "images": images,
            "status": status,
            "source_message": str(task.message or ""),
        },
    )


async def poll_task(
    service_task_id: str,
    *,
    wait_seconds: float = MAX_POLL_SECONDS,
    interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    transport: Any = None,
) -> client.ServiceTaskDetail:
    """有界轮询出图任务直到完成/超时（同步请求-响应，不建后台队列）。"""
    bounded = max(0.0, min(float(wait_seconds or 0), MAX_POLL_SECONDS))
    interval = max(0.5, float(interval_seconds or DEFAULT_POLL_INTERVAL_SECONDS))
    elapsed = 0.0
    detail = await client.get_asset_image_task(service_task_id, transport=transport)
    while not detail.completed and elapsed < bounded:
        await asyncio.sleep(interval)
        elapsed += interval
        detail = await client.get_asset_image_task(service_task_id, transport=transport)
    return detail


def summarize_results(results: list[ImageTaskResultRead]) -> dict[str, Any]:
    """汇总提交结果：**整数**成功/失败计数 + 归一化 outcome（故障 B 的落地修复）。

    旧形状只给 ``{"total":1,"by_status":{"partial_failed":1},"oss_ready":0}``：
    ``ok`` 恒 true、没有成功/失败条数、``oss_ready`` 是个一眼看不出含义的 0，
    页面因此把「部分失败」渲染成绿色成功。

    新形状**只增不删**：``total`` / ``by_status`` / ``oss_ready`` / ``dry_run``
    全部保留（旧调用方照旧可读），新增的整数计数与 ``outcome`` 让调用方一眼看懂。
    """
    by_status: dict[str, int] = {}
    by_outcome: dict[str, int] = {}
    outcomes: list[str] = []
    for item in results:
        by_status[item.status] = by_status.get(item.status, 0) + 1
        outcome = str(item.outcome or "") or normalize_outcome(
            status=item.status,
            ok=item.ok,
            oss_url=item.oss_url,
            dry_run=item.dry_run,
            error_message=item.error_message or item.message,
        )
        outcomes.append(outcome)
        by_outcome[outcome] = by_outcome.get(outcome, 0) + 1

    ok_count = len([item for item in outcomes if item == OUTCOME_OK])
    failed_count = len([item for item in outcomes if item == OUTCOME_FAILED])
    partial_count = len([item for item in outcomes if item == OUTCOME_PARTIAL_FAILED])
    running_count = len([item for item in outcomes if item == OUTCOME_RUNNING])
    dry_run_count = len([item for item in outcomes if item == OUTCOME_DRY_RUN])
    unknown_count = len([item for item in outcomes if item == OUTCOME_UNKNOWN])
    oss_ready_count = len([item for item in results if item.oss_url])
    real_failed = failed_count + partial_count
    error_messages = list(
        dict.fromkeys(
            [
                str(item.error_message or "").strip()
                for item in results
                if str(item.error_message or "").strip()
            ]
        )
    )

    return {
        # —— 旧字段（一个都没删）
        "total": len(results),
        "by_status": by_status,
        "oss_ready": oss_ready_count,
        "dry_run": all(item.dry_run for item in results) if results else dry_run.dry_run_enabled(),
        # —— 新字段：整数计数 + 归一化口径
        "outcome": summary_outcome(results),
        "by_outcome": by_outcome,
        "ok_count": ok_count,
        "failed_count": real_failed,
        "partial_failed_count": partial_count,
        "running_count": running_count,
        "dry_run_count": dry_run_count,
        "unknown_count": unknown_count,
        "oss_ready_count": oss_ready_count,
        "ok": bool(results) and ok_count == len(results),
        "has_failure": real_failed > 0,
        "has_partial_failure": partial_count > 0 or (ok_count > 0 and real_failed > 0),
        "message": "；".join(error_messages[:3]),
    }


# ---------------------------------------------------------------------------
# outcome 归一化（故障 B：partial_failed 语义混乱）
# ---------------------------------------------------------------------------
#
# 真实验收暴露的问题：出图服务在「上游图片已生成、但它自己 OSS 上传失败」时返回
# ``partial_failed``。旧实现把它当成功透传（``ok`` 恒 true、页面用绿色成功 Alert 渲染、
# 真正的错误消息被笼统的 ``task.message`` 盖掉），用户完全看不出「成功几条 / 失败几条」。
#
# 归一化口径只有一组取值，调用方（含页面）只需认这一组：
#   ok             图片已生成且拿到长期地址（或明确成功）
#   partial_failed 图片已生成，但 OSS 上传 / 落库等后续步骤没完成 → **绝不能当成功**
#   running        还在排队/执行中
#   failed         失败
#   dry_run        演练占位（既不算成功也不算失败）
#   unknown        认不出来的状态（不猜、不冒充成功）

OUTCOME_OK = "ok"
OUTCOME_PARTIAL_FAILED = "partial_failed"
OUTCOME_RUNNING = "running"
OUTCOME_FAILED = "failed"
OUTCOME_DRY_RUN = "dry_run"
OUTCOME_UNKNOWN = "unknown"

# 上游状态 token → 归一化口径。token 规则：小写 + 空白/连字符 → 下划线。
_STATUS_TOKENS: dict[str, str] = {}
for _token in ("succeeded", "success", "ok", "done", "completed", "complete", "finished", "passed"):
    _STATUS_TOKENS[_token] = OUTCOME_OK
for _token in (
    "partial",
    "partial_failed",
    "partial_fail",
    "partialfailure",
    "partially_failed",
    "partial_error",
    "partial_success",
    "partial_succeeded",
    "oss_failed",
    "oss_fail",
    "oss_upload_failed",
    "oss_upload_error",
    "oss_error",
    "upload_failed",
    "storage_failed",
    "storage_error",
    "persist_failed",
):
    _STATUS_TOKENS[_token] = OUTCOME_PARTIAL_FAILED
for _token in (
    "failed",
    "fail",
    "failure",
    "error",
    "errored",
    "rejected",
    "blocked",
    "timeout",
    "timed_out",
    "cancelled",
    "canceled",
    "aborted",
    "exception",
):
    _STATUS_TOKENS[_token] = OUTCOME_FAILED
for _token in (
    "pending",
    "queued",
    "queueing",
    "queuing",
    "running",
    "processing",
    "submitted",
    "in_progress",
    "created",
    "waiting",
    "accepted",
    "started",
):
    _STATUS_TOKENS[_token] = OUTCOME_RUNNING
for _token in ("dry_run", "dryrun", "dry", "simulated", "mock", "placeholder"):
    _STATUS_TOKENS[_token] = OUTCOME_DRY_RUN


def classify_status_token(raw: str) -> str | None:
    """状态字符串 → 归一化口径；认不出来返回 ``None``（调用方再决定怎么兜底）。"""
    token = str(raw or "").strip().lower().replace("-", "_")
    token = "_".join(token.split())
    if not token:
        return None
    exact = _STATUS_TOKENS.get(token)
    if exact is not None:
        return exact
    # 包含式兜底：``partial_failed_by_oss`` / ``oss_upload_error_403`` 这类复合状态。
    # 顺序刻意：「部分失败」必须排在通用 failed/error 之前，否则会丢掉
    # 「图片已生成、只是 OSS 没传上去」这句关键信息。
    looks_partial = "partial" in token or "oss" in token or "upload" in token
    looks_bad = any(word in token for word in ("fail", "error", "denied"))
    if looks_partial and looks_bad:
        outcome: str | None = OUTCOME_PARTIAL_FAILED
    elif looks_bad:
        outcome = OUTCOME_FAILED
    elif "success" in token or "succeed" in token:
        outcome = OUTCOME_OK
    elif any(word in token for word in ("pending", "queue", "running", "process")):
        outcome = OUTCOME_RUNNING
    elif "dry" in token:
        outcome = OUTCOME_DRY_RUN
    else:
        outcome = None
    return outcome


def normalize_outcome(
    *,
    status: str,
    ok: bool | None = True,
    oss_url: str = "",
    dry_run: bool = False,
    error_message: str = "",
) -> str:
    """把「上游状态 + ok 布尔 + 是否拿到长期地址」归一成一个明确的 outcome。"""
    if dry_run:
        outcome = OUTCOME_DRY_RUN
    else:
        outcome = classify_status_token(status)
        if outcome is None:
            # 认不出来时只有 ok 布尔可依据；都没有就如实 unknown（不猜、不冒充成功）
            outcome = OUTCOME_OK if ok is True else OUTCOME_FAILED if ok is False else OUTCOME_UNKNOWN
        if outcome == OUTCOME_OK and ok is False:
            # 显式 ok=False 是明确的失败证据（ok=true 不可信，false 可信），不允许渲染成成功
            outcome = OUTCOME_FAILED
        if outcome == OUTCOME_OK and not str(oss_url or "").strip() and _looks_like_oss_failure(error_message):
            # 状态说成功、却没有任何长期地址，而且错误文本是 OSS 相关 → 属于部分失败
            outcome = OUTCOME_PARTIAL_FAILED
    return outcome


_OSS_FAILURE_MARKERS: tuple[str, ...] = ("oss", "upload", "上传", "storage", "落库", "object")


def _looks_like_oss_failure(text: str) -> bool:
    lowered = str(text or "").lower()
    return any(marker in lowered for marker in _OSS_FAILURE_MARKERS)


_HTTP_STATUS_RE = re.compile(r"(?:http|status|code|错误码|状态码)\s*[:=]?\s*(\d{3})\b", re.IGNORECASE)


def _http_status_from_text(text: str) -> int | None:
    """从错误原文里抠 HTTP 状态码（``HTTP 403`` / ``status=500``）；取不到返回 None。"""
    match = _HTTP_STATUS_RE.search(str(text or ""))
    if not match:
        return None
    code = int(match.group(1))
    return code if 100 <= code <= 599 else None


def summary_outcome(results: list[ImageTaskResultRead]) -> str:
    """整批结果的整体口径。

    规则（顺序即优先级）：

    - 全是演练占位 → ``dry_run``；
    - 有部分失败 → ``partial_failed``（图片可能已生成、只是 OSS 没就绪 —— 这条信息
      比"失败"更有用，页面据此提示"可重试上传"）；
    - 既有成功又有失败 → ``partial_failed``；
    - 全失败 → ``failed``；
    - 还有没跑完的 → ``running``（此时不能报成功）；
    - 否则 → ``ok``。
    """
    if not results:
        return "empty"
    outcomes = [
        str(item.outcome or "")
        or normalize_outcome(
            status=item.status,
            ok=item.ok,
            oss_url=item.oss_url,
            dry_run=item.dry_run,
            error_message=item.error_message or item.message,
        )
        for item in results
    ]
    if all(item == OUTCOME_DRY_RUN for item in outcomes):
        return OUTCOME_DRY_RUN
    ok_count = len([item for item in outcomes if item == OUTCOME_OK])
    partial_count = len([item for item in outcomes if item == OUTCOME_PARTIAL_FAILED])
    failed_count = len([item for item in outcomes if item == OUTCOME_FAILED])
    running_count = len([item for item in outcomes if item in {OUTCOME_RUNNING, OUTCOME_UNKNOWN}])
    if partial_count or (failed_count and ok_count):
        return OUTCOME_PARTIAL_FAILED
    if failed_count:
        return OUTCOME_FAILED
    if running_count:
        return OUTCOME_RUNNING
    return OUTCOME_OK


__all__ = [
    "ASSET_TYPE_ZH",
    "DEFAULT_ASPECT_RATIO",
    "GENERATION_TYPE_BY_ASSET_TYPE",
    "IMAGE_MODEL_BY_ASSET_TYPE",
    "OUTCOME_DRY_RUN",
    "OUTCOME_FAILED",
    "OUTCOME_OK",
    "OUTCOME_PARTIAL_FAILED",
    "OUTCOME_RUNNING",
    "OUTCOME_UNKNOWN",
    "SubmissionTarget",
    "build_deterministic_prompt",
    "build_object_key_template",
    "build_source_task_id",
    "build_targets",
    "classify_status_token",
    "normalize_outcome",
    "poll_task",
    "reference_candidates",
    "submit_targets",
    "summarize_results",
    "summary_outcome",
]
