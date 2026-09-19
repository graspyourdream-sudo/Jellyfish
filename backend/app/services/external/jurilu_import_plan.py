"""巨日禄分镜导入 —— 匹配计划（纯函数，零依赖）。

为什么单独拆出来
----------------
本模块**不 import 任何第三方库**（不碰 sqlalchemy / fastapi），因此可以在
受限沙箱里用任意 Python 直接跑断言。库里那一层（``jurilu_import_service``）
负责取数与写库，落库前的"哪一条写到哪个镜头"的判断全部收在这里。

口径来源
--------
对齐中控台 ``app.py`` 的导入保存段（约 18030-18070 行）：

  * 一条分镜 = 一个镜头的一条提示词（一个镜头最多一条，这是既有约定）；
  * 写库字段 = ``final_prompt``（正文） + ``source``（来源标记）；
  * 巨日禄来源标记固定为 ``jurilu`` —— 出口 A「仅提示词」正是按它筛选。

与中控台的一处**有意偏离**
--------------------------
中控台按 ``shot_label``（巨日禄的 agent_name）去匹配已有镜头，匹配不上就新建。
Jellyfish 迁移过来的镜头 id 是重新生成的，跟巨日禄的 agent_name 不同源，
按 label 匹配必然全落空。因此这里改为**按顺序匹配**：第 i 条分镜 → 章节内第 i 个镜头。
这是迁移后唯一还成立的对应关系（分镜顺序 = 镜头 index 顺序）。
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Sequence

# 与中控台 app.py:18378 保持一致的来源标记；出口 A 依赖这个值。
JURILU_SOURCE = "jurilu"

# 计划行可能出现的动作
ACTION_UPDATE = "update"          # 写入既有镜头（该镜头当前无提示词）
ACTION_OVERWRITE = "overwrite"    # 覆盖既有镜头已有的提示词（需显式开 overwrite）
ACTION_UNCHANGED = "unchanged"    # 既有镜头已是同一文本，无需写
ACTION_CONFLICT = "conflict"      # 既有镜头已有**不同**提示词，且未开 overwrite
ACTION_CREATE = "create"          # 章节镜头不够，需要新建镜头
ACTION_SKIP_EMPTY = "skip_empty"  # 条目没有提示词正文
ACTION_SKIP_NO_SHOT = "skip_no_shot"  # 章节镜头不够且不允许新建


def build_import_plan(
    entries: Sequence[Dict[str, Any]],
    shots: Sequence[Dict[str, Any]],
    *,
    create_missing: bool = True,
    overwrite: bool = False,
    source: str = JURILU_SOURCE,
) -> Dict[str, Any]:
    """把规范化后的分镜条目配对到章节镜头，产出可执行计划（不写库）。

    Args:
        entries: ``normalize_external_agent_prompts`` 的输出，已按分镜顺序排列。
        shots: 目标章节已有镜头，元素形如
            ``{"id": str, "index": int, "title": str, "video_prompt": str}``；
            顺序无所谓，这里会按 index 重排。
        create_missing: 条目多于镜头时，是否新建镜头补齐。
        overwrite: 目标镜头已有不同提示词时，是否覆盖。
        source: 写入 ``video_prompt_source`` 的值。

    Returns:
        ``{"rows": [...], "counts": {...}, "next_index": int}``
    """
    ordered = sorted(shots, key=lambda s: _int(s.get("index")))
    top_index = max((_int(s.get("index")) for s in ordered), default=0)

    rows: List[Dict[str, Any]] = []
    for position, entry in enumerate(entries):
        order = position + 1
        text = str(entry.get("final_prompt") or "").strip()
        label = str(entry.get("shot_label") or "").strip() or f"镜头 {order}"
        summary = str(entry.get("description") or "").strip()

        if not text:
            # 空正文条目**仍占它那一格**：巨日禄一条分镜对应一个镜头，
            # 分镜序号即镜头序号，空分镜的镜头依然存在。这里只记录它对应
            # 哪个镜头以便排查，不产生写入。
            target = ordered[position] if position < len(ordered) else None
            rows.append(
                _row(
                    ACTION_SKIP_EMPTY,
                    order=order,
                    label=label,
                    summary=summary,
                    prompt="",
                    source=source,
                    reason="分镜条目没有提示词正文",
                    shot_id=str((target or {}).get("id") or ""),
                    index=_int((target or {}).get("index")) or order,
                    title=str((target or {}).get("title") or "").strip(),
                )
            )
            continue

        if position < len(ordered):
            target = ordered[position]
            current = str(target.get("video_prompt") or "").strip()
            shot_id = str(target.get("id") or "")
            index = _int(target.get("index")) or order
            title = str(target.get("title") or "").strip()
            if current == text:
                action, reason = ACTION_UNCHANGED, "目标镜头已是同一提示词"
            elif current and not overwrite:
                action, reason = ACTION_CONFLICT, "目标镜头已有不同提示词（未开覆盖）"
            elif current:
                action, reason = ACTION_OVERWRITE, "覆盖目标镜头已有提示词"
            else:
                action, reason = ACTION_UPDATE, "写入目标镜头"
            rows.append(
                _row(
                    action,
                    order=order,
                    label=label,
                    summary=summary,
                    prompt=text,
                    source=source,
                    reason=reason,
                    shot_id=shot_id,
                    index=index,
                    title=title,
                )
            )
            continue

        top_index += 1
        if create_missing:
            rows.append(
                _row(
                    ACTION_CREATE,
                    order=order,
                    label=label,
                    summary=summary,
                    prompt=text,
                    source=source,
                    reason="章节镜头不足，新建镜头",
                    index=top_index,
                    title=label,
                )
            )
        else:
            rows.append(
                _row(
                    ACTION_SKIP_NO_SHOT,
                    order=order,
                    label=label,
                    summary=summary,
                    prompt=text,
                    source=source,
                    reason="章节镜头不足且未允许新建",
                    index=top_index,
                )
            )

    counts: Dict[str, int] = {}
    for row in rows:
        counts[row["action"]] = counts.get(row["action"], 0) + 1

    return {"rows": rows, "counts": counts, "next_index": top_index}


def _row(
    action: str,
    *,
    order: int,
    label: str,
    summary: str,
    prompt: str,
    source: str,
    reason: str = "",
    shot_id: str = "",
    index: int = 0,
    title: str = "",
) -> Dict[str, Any]:
    return {
        "action": action,
        "order": order,
        "label": label,
        "summary": summary,
        "prompt": prompt,
        "source": source,
        "reason": reason,
        "shot_id": shot_id,
        "index": index,
        "title": title,
    }


def _int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def writable_rows(plan: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """从计划里筛出真正要落库的行（update / overwrite / create）。"""
    return [
        row
        for row in plan
        if row["action"] in (ACTION_UPDATE, ACTION_OVERWRITE, ACTION_CREATE)
    ]


def plan_summary(plan: Dict[str, Any]) -> str:
    """给前端用的一句话摘要。"""
    counts = plan.get("counts", {})
    will_write = sum(
        counts.get(a, 0)
        for a in (ACTION_UPDATE, ACTION_OVERWRITE, ACTION_CREATE)
    )
    return (
        f"共 {len(plan.get('rows', []))} 条：将写入 {will_write} 条"
        f"（新建 {counts.get(ACTION_CREATE, 0)}），"
        f"跳过 {counts.get(ACTION_SKIP_EMPTY, 0) + counts.get(ACTION_SKIP_NO_SHOT, 0)}，"
        f"冲突 {counts.get(ACTION_CONFLICT, 0)}，无变化 {counts.get(ACTION_UNCHANGED, 0)}"
    )


__all__ = [
    "JURILU_SOURCE",
    "ACTION_UPDATE",
    "ACTION_OVERWRITE",
    "ACTION_UNCHANGED",
    "ACTION_CONFLICT",
    "ACTION_CREATE",
    "ACTION_SKIP_EMPTY",
    "ACTION_SKIP_NO_SHOT",
    "build_import_plan",
    "writable_rows",
    "plan_summary",
]
