"""本章资产资料（overlay）：**全局资产的章节隔离层**。

用户口径（2026-09 补充，优先级高于原任务书）
============================================

- **角色**归属项目（``characters.project_id``），可以存在项目内；
- **场景 / 道具 / 服装是全局资产**（``scenes`` / ``props`` / ``costumes`` 三张表
  的名称约束是全局唯一的）。所以：本章提取出的
  **剧情身份**、**出场依据**、**临时补充** 必须**按项目/章节隔离保存**；
  **不得静默覆盖全局资产的通用资料或图片提示词**；
- 确实要更新全局资产时，必须**明确展示差异 + 由用户显式确认**才写回。

存储位置（**零数据库结构改动**）
================================

三张 ``project_*_links`` 表只有 ``project_id / chapter_id / shot_id / <asset>_id``，
**没有可放文本的列**；角色也没有链接表。四类资产唯一**天然按章节隔离**、
且**已有 JSON 列**的地方是 ``shot_extracted_candidates``：

- ``shot_id`` → ``shots.chapter_id`` → 章节（隔离维度）；
- ``payload``（既有 JSON 列）→ 放 ``chapter_overlay``。

所以本章资料以"**该资产在本章出场的那几个镜头上**的候选行"为载体落库：

- 一个资产在本章出场 k 个镜头 → 在这些行上写同一份 overlay（这是它"出场依据"的自然形态）；
- 一个镜头**都没有**提到它 → **不伪造**：overlay 只留在确认响应里并如实回报
  ``overlay_persisted=false``（"本章没有镜头提到它，无法落出场依据"）。

已知取舍（如实记录）：``/script-processing/extract`` 重跑时会
``replace_for_shot`` **删掉该镜头的全部候选再重建**，overlay 行会随之消失 ——
此时重新确认一次本章清单即可重建。这是"不加列"换来的代价，需要加持久列时另行申请。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.studio import Chapter, Shot, ShotExtractedCandidate
from app.models.types import ShotCandidateStatus
from app.services.studio.asset_profiles import (
    normalize_asset_type,
    normalize_profile,
    render_profile_text,
    type_label,
)
from app.services.studio.llm_orchestration.json_utils import normalize_name

#: overlay 写入候选 ``source`` 列时的标记（用于读回与区分于提取候选）
OVERLAY_SOURCE = "chapter_profile_overlay"

#: payload 里放本章资料的键
OVERLAY_PAYLOAD_KEY = "chapter_overlay"

#: overlay 结构版本（便于以后演进）
OVERLAY_SCHEMA = "chapter_asset_overlay/v1"

#: 出场依据的类型：``shot`` = 落在具体镜头摘录里；``chapter_only`` = 只在本章原文出现，
#: 一个镜头摘录都没提到它（此时 ``shot_refs`` 为空，overlay 挂在**章节首镜**上只作为
#: "按章节读取"的容器 —— 不伪造出场依据，字段里如实标注）。
EVIDENCE_SCOPE_SHOT = "shot"
EVIDENCE_SCOPE_CHAPTER_ONLY = "chapter_only"

#: **本章特有**的字段（时间/天气/状态/场合这一类"换个章节就不一样"的内容）。
#: 这些字段只进章节 overlay，**不进全局通用资料**；全局更新时会被刻意排除。
CHAPTER_TEMPORAL_FIELDS: dict[str, tuple[str, ...]] = {
    "character": ("related_plot",),
    "scene": ("time_weather", "light_tone", "related_events"),
    "prop": ("state", "plot_role"),
    "costume": ("occasion",),
}

#: 全局资产（需要章节隔离的三类）；角色归属项目，不属于全局资产。
GLOBAL_ASSET_TYPES: tuple[str, ...] = ("scene", "prop", "costume")


def is_global_asset(asset_type: str) -> bool:
    """这一类资产是不是**全局资产**（需要章节隔离保存）。"""
    return str(asset_type or "").strip().lower() in GLOBAL_ASSET_TYPES


def temporal_field_keys(asset_type: str) -> tuple[str, ...]:
    return CHAPTER_TEMPORAL_FIELDS.get(str(asset_type or "").strip().lower(), ())


def general_field_keys(asset_type: str) -> tuple[str, ...]:
    """**通用资料**字段（= 全部字段 - 本章特有字段）。全局更新只允许动这些。"""
    temporal = set(temporal_field_keys(asset_type))
    return tuple(key for key in normalize_profile(asset_type, {}).keys() if key not in temporal)


@dataclass(slots=True)
class ChapterAssetOverlay:
    """一章里某个资产的**章节范围资料**。"""

    chapter_id: str
    project_id: str
    asset_type: str
    name: str
    aliases: list[str] = field(default_factory=list)
    asset_id: str | None = None
    plot_identity: str = ""
    chapter_fields: dict[str, str] = field(default_factory=dict)
    temporary_notes: list[str] = field(default_factory=list)
    shot_refs: list[dict[str, Any]] = field(default_factory=list)
    evidence: list[dict[str, Any]] = field(default_factory=list)
    source_kind: str = "candidate"
    global_asset: bool = False
    evidence_scope: str = EVIDENCE_SCOPE_SHOT

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema": OVERLAY_SCHEMA,
            "chapter_id": self.chapter_id,
            "project_id": self.project_id,
            "asset_type": self.asset_type,
            "asset_id": self.asset_id,
            "name": self.name,
            "aliases": list(self.aliases),
            "global_asset": self.global_asset,
            "plot_identity": self.plot_identity,
            "chapter_fields": dict(self.chapter_fields),
            "temporary_notes": list(self.temporary_notes),
            "shot_refs": list(self.shot_refs),
            "evidence": list(self.evidence),
            "source_kind": self.source_kind,
            "evidence_scope": self.evidence_scope,
        }

    def to_read(self) -> dict[str, Any]:
        """对外的只读形态（脱敏：不含任何路径/密钥）。"""
        return {
            "chapter_id": self.chapter_id,
            "project_id": self.project_id,
            "asset_type": self.asset_type,
            "type_label": type_label(self.asset_type),
            "name": self.name,
            "aliases": list(self.aliases),
            "asset_id": self.asset_id,
            "global_asset": self.global_asset,
            "scope": "chapter",
            "scope_description": (
                "该资产是**全局资产**；这里的资料按项目/章节隔离保存，"
                "不会写回全局资产的通用资料或图片提示词。"
                if self.global_asset
                else "该资产归属项目（角色），资料保存在本项目内。"
            ),
            "plot_identity": self.plot_identity,
            "chapter_fields": dict(self.chapter_fields),
            "temporary_notes": list(self.temporary_notes),
            "shot_refs": list(self.shot_refs),
            "evidence": list(self.evidence),
            "source_kind": self.source_kind,
            "evidence_scope": self.evidence_scope,
        }


def _plot_identity_for(asset_type: str, fields: dict[str, str]) -> str:
    """从本章字段里提炼"剧情身份"（这一章里它是什么）。"""
    candidates = {
        "character": ("identity", "relations"),
        "scene": ("era_location", "indoor_outdoor"),
        "prop": ("usage", "owner"),
        "costume": ("identity_era", "wearer"),
    }.get(asset_type, ())
    parts = [str(fields.get(key) or "").strip() for key in candidates]
    return "；".join(part for part in parts if part)


def _temporary_notes_for(asset_type: str, fields: dict[str, str]) -> list[str]:
    notes: list[str] = []
    for key in temporal_field_keys(asset_type):
        value = str(fields.get(key) or "").strip()
        if value:
            notes.append(value)
    return notes


def build_overlay_from_item(
    *,
    item: dict[str, Any],
    chapter_id: str,
    project_id: str,
    asset_id: str | None = None,
) -> ChapterAssetOverlay:
    """把清单里的一项（``user_flow.items[]``）转成章节 overlay。"""
    asset_type = str(item.get("asset_type") or "")
    fields = normalize_profile(asset_type, item.get("fields") or {})
    return ChapterAssetOverlay(
        chapter_id=chapter_id,
        project_id=project_id,
        asset_type=asset_type,
        name=str(item.get("name") or ""),
        aliases=[str(alias) for alias in (item.get("aliases") or [])],
        asset_id=asset_id or (str(item["existing_asset_id"]) if item.get("existing_asset_id") else None),
        plot_identity=_plot_identity_for(asset_type, fields),
        chapter_fields=fields,
        temporary_notes=_temporary_notes_for(asset_type, fields),
        shot_refs=[
            {
                "shot_id": ref.get("shot_id"),
                "shot_index": ref.get("shot_index"),
                "title": ref.get("title"),
                "matched": ref.get("matched"),
                "script_excerpt": ref.get("script_excerpt"),
            }
            for ref in (item.get("shot_refs") or [])
        ],
        evidence=[
            {
                "snippet": entry.get("snippet"),
                "grounded": entry.get("grounded"),
                "from_name": entry.get("from_name"),
            }
            for entry in (item.get("evidence") or [])
        ],
        source_kind=str(item.get("source_kind") or "candidate"),
        global_asset=is_global_asset(asset_type),
    )


async def persist_overlay(
    db: AsyncSession,
    *,
    overlay: ChapterAssetOverlay,
) -> dict[str, Any]:
    """把 overlay 写到"该资产在本章出场的那几个镜头"的候选行上（已存在则更新）。"""
    shot_ids = [str(ref.get("shot_id") or "") for ref in overlay.shot_refs if ref.get("shot_id")]
    if not shot_ids:
        # 一个镜头摘录都没提到它 —— 但用户要求"本章提取出的资料必须按章节隔离保存"，
        # 所以挂到**章节首镜**上作为"按章节读取"的容器，并如实标注证据级别，
        # 绝不把出场依据编出来（``shot_refs`` 保持为空）。
        first_shot = (
            await db.execute(
                select(Shot.id).where(Shot.chapter_id == overlay.chapter_id).order_by(Shot.index).limit(1)
            )
        ).scalars().first()
        if not first_shot:
            return {
                "persisted": False,
                "rows": 0,
                "evidence_scope": EVIDENCE_SCOPE_CHAPTER_ONLY,
                "reason": "本章还没有分镜，无法按章节挂载 overlay；请先拆分分镜再确认。",
            }
        shot_ids = [str(first_shot)]
        overlay.evidence_scope = EVIDENCE_SCOPE_CHAPTER_ONLY

    names = {normalize_name(overlay.name), *(normalize_name(a) for a in overlay.aliases)}
    names.discard("")
    rows = (
        (
            await db.execute(
                select(ShotExtractedCandidate)
                .where(ShotExtractedCandidate.shot_id.in_(shot_ids))
                .order_by(ShotExtractedCandidate.id)
            )
        )
        .scalars()
        .all()
    )
    payload_blob = overlay.to_payload()
    touched = 0
    created = 0
    for shot_id in shot_ids:
        matched = [
            row
            for row in rows
            if str(row.shot_id) == shot_id
            and str(getattr(row.candidate_type, "value", row.candidate_type)) == overlay.asset_type
            and normalize_name(row.candidate_name) in names
        ]
        if matched:
            for row in matched:
                payload = dict(row.payload or {})
                payload[OVERLAY_PAYLOAD_KEY] = payload_blob
                if overlay.asset_id:
                    payload["linked_entity_id"] = overlay.asset_id
                row.payload = payload
                touched += 1
            continue
        # 该镜头没有对应候选行（例如资产是模型新发现、候选表里还没有）→ 补一行，
        # 这样"出场依据"才不会因为没有候选而丢失。
        db.add(
            ShotExtractedCandidate(
                shot_id=shot_id,
                candidate_type=overlay.asset_type,
                candidate_name=overlay.name,
                candidate_status=ShotCandidateStatus.linked if overlay.asset_id else ShotCandidateStatus.pending,
                linked_entity_id=overlay.asset_id,
                source=OVERLAY_SOURCE,
                payload={
                    OVERLAY_PAYLOAD_KEY: payload_blob,
                    **({"linked_entity_id": overlay.asset_id} if overlay.asset_id else {}),
                },
            )
        )
        created += 1
    await db.flush()
    return {
        "persisted": True,
        "rows": touched,
        "created_rows": created,
        "evidence_scope": overlay.evidence_scope,
        "reason": (
            ""
            if overlay.evidence_scope == EVIDENCE_SCOPE_SHOT
            else "该资产只在本章原文出现、没有任何镜头摘录提到它："
            "overlay 挂在章节首镜上以便按章节读取，shot_refs 如实留空（不伪造出场依据）。"
        ),
    }


async def load_chapter_overlays(
    db: AsyncSession,
    *,
    chapter_id: str,
) -> list[dict[str, Any]]:
    """读回本章范围资料（按资产去重；同一资产在多个镜头上只返回一份）。"""
    rows = (
        (
            await db.execute(
                select(ShotExtractedCandidate)
                .join(Shot, Shot.id == ShotExtractedCandidate.shot_id)
                .where(Shot.chapter_id == chapter_id)
                .order_by(ShotExtractedCandidate.id)
            )
        )
        .scalars()
        .all()
    )
    collected: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        payload = row.payload if isinstance(row.payload, dict) else {}
        raw = payload.get(OVERLAY_PAYLOAD_KEY)
        if not isinstance(raw, dict):
            continue
        asset_type = normalize_asset_type(raw.get("asset_type")) or ""
        name = str(raw.get("name") or "")
        key = (asset_type, normalize_name(name))
        if key in collected or not key[1]:
            continue
        collected[key] = {
            **raw,
            "asset_type": asset_type,
            "type_label": type_label(asset_type),
            "global_asset": is_global_asset(asset_type),
            "scope": "chapter",
            "overlay_source": str(getattr(row, "source", "") or ""),
            "linked_entity_id": payload.get("linked_entity_id") or row.linked_entity_id,
            "candidate_status": str(getattr(row.candidate_status, "value", row.candidate_status)),
            "shot_id": str(row.shot_id),
        }
    return list(collected.values())


async def load_chapter_overlay_map(
    db: AsyncSession,
    *,
    chapter_id: str,
) -> dict[tuple[str, str], dict[str, Any]]:
    """``{(资产类型, 归一化名称): overlay}``，供富化与全局差异计算使用。"""
    overlays = await load_chapter_overlays(db, chapter_id=chapter_id)
    return {(str(item["asset_type"]), normalize_name(item.get("name"))): item for item in overlays}


def overlay_to_profile_text(overlay: dict[str, Any], *, include_temporal: bool = True) -> str:
    """把 overlay 渲染成"给图片提示词用"的一段文本。

    - ``include_temporal=True``（默认）：本章字段全带上（含时间/天气/状态/场合），
      因为图片提示词本来就是**这一章、这些镜头**的；
    - ``include_temporal=False``：只保留**通用资料**字段，用于计算"要不要更新全局资产"。
    """
    asset_type = normalize_asset_type(overlay.get("asset_type")) or ""
    fields = normalize_profile(asset_type, overlay.get("chapter_fields") or {})
    # 出场镜头由结构化的 ``shot_refs`` 单独给（页面「生成依据」用它），
    # 不重复塞进画像文本，也不让它有机会进全局提议。
    fields["shot_refs"] = ""
    if not include_temporal:
        for key in temporal_field_keys(asset_type):
            fields[key] = ""
    # ``include_evidence_fields=True``：把「相关事件 / 剧情作用 / 相关剧情」这类
    # **剧情向字段**一起渲染出来 —— 用户明确要求场景要含剧本里的"事件"、
    # 道具要含"剧情用途"，它们不能因为"属于追溯依据"就被丢掉。
    return render_profile_text(asset_type, fields, include_evidence_fields=True)


def diff_segments(before: str, after: str) -> dict[str, Any]:
    """按「；」分段做**可读差异**（新增 / 删除 / 未变）。"""
    before_parts = [part.strip() for part in str(before or "").split("；") if part.strip()]
    after_parts = [part.strip() for part in str(after or "").split("；") if part.strip()]
    before_set = set(before_parts)
    after_set = set(after_parts)
    return {
        "added": [part for part in after_parts if part not in before_set],
        "removed": [part for part in before_parts if part not in after_set],
        "unchanged": [part for part in before_parts if part in after_set],
        "changed": bool(after_set - before_set or before_set - after_set),
    }


__all__ = [
    "CHAPTER_TEMPORAL_FIELDS",
    "EVIDENCE_SCOPE_CHAPTER_ONLY",
    "EVIDENCE_SCOPE_SHOT",
    "GLOBAL_ASSET_TYPES",
    "OVERLAY_PAYLOAD_KEY",
    "OVERLAY_SCHEMA",
    "OVERLAY_SOURCE",
    "ChapterAssetOverlay",
    "build_overlay_from_item",
    "diff_segments",
    "general_field_keys",
    "is_global_asset",
    "load_chapter_overlay_map",
    "load_chapter_overlays",
    "overlay_to_profile_text",
    "persist_overlay",
    "temporal_field_keys",
]
