"""视频提交的**幂等保护**（同一镜头 + 同一参数 + 同一次 attempt 只创建一个上游任务）。

为什么必须有（本轮实测暴露的真实风险）
======================================

图片提交有幂等键（前端 ``attempt`` 混进键、上游按既有任务去重），**视频提交没有**：
`video_payload.build_create_task_body` 只发 prompt / model / 帧 / 音频，没有任何请求标识。
后果是：网络中断、用户刷新、或前端超时重试时，**上游会又建一个计费任务**。
本轮我自己就踩到过一次（浏览器被关闭导致请求中断，事后无法判断上游是否已建任务）——
所以先把这条路堵上，再花那 1 次真实额度。

设计（不改表结构）
==================

``generation_tasks`` 已有 JSON 列 ``payload``，本模块把幂等键写进
``payload.run_args.idempotency_key``（**不加列、不做迁移**）。

- 键 = sha256(镜头 + 本次真正会发给上游的生成参数 + attempt) 的前 16 位十六进制；
- **同参数 + 同 attempt** → 同一个键 → 命中已有任务就**直接返回它，不再调用上游**；
- 用户明确点「重新生成」→ 前端把 ``attempt`` 加 1 → 键变化 → 才会创建新任务；
- 键里**不含** api_key 等凭证，可以安全出现在日志里。

并发与刷新
==========

- 并发：调用方按 key 取一把 ``asyncio.Lock``（:func:`key_lock`），保证**同一时刻只有一个**
  请求走到上游；
- 刷新恢复：键落在任务行里，因此刷新后重新发起同一请求会命中已有任务
  （:func:`find_task_by_key`），页面据此恢复状态而**不重复计费**。

已知边界（如实记录，不假装已经解决）
====================================

``key_lock`` 是**进程内**锁：本项目的开发/演练形态是**单进程** uvicorn，因此够用。
若将来起多个 worker（或多实例），同一轮的两个请求可能落在不同进程里、各建一个上游任务——
那时需要在 ``generation_tasks`` 上给幂等键加**唯一约束**（或改用带条件的 INSERT ... ON CONFLICT），
这需要一次表结构变更，**本轮不做**（用户明确不改表结构）。已在 `payload.run_args` 里留好键，
加约束时可以直接补数据。
"""

from __future__ import annotations

import asyncio
import hashlib
from datetime import UTC, datetime
from typing import Any, Iterable
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.task import (
    GenerationDeliveryMode,
    GenerationTask,
    GenerationTaskStatus,
)

#: 幂等键在任务 payload 里的落点（``payload.run_args`` 下）。
KEY_FIELD = "idempotency_key"
VIDEO_TASK_KIND = "video_generation"

#: 「命中已有任务就直接复用」的状态白名单：失败/取消的**不**复用
#: （用户重试失败项是合理诉求；那由 attempt 控制的语义在这里不重复实现）。
REUSABLE_STATUSES: frozenset[str] = frozenset(
    {"pending", "queued", "running", "succeeded", "partial_failed", "streaming"}
)

_locks: dict[str, asyncio.Lock] = {}


def key_lock(key: str) -> asyncio.Lock:
    """取这个幂等键对应的进程内锁（保证并发只放一个人去调上游）。"""
    lock = _locks.get(key)
    if lock is None:
        lock = asyncio.Lock()
        _locks[key] = lock
    return lock


def build_video_idempotency_key(
    *,
    shot_id: str,
    prompt: str = "",
    reference_mode: str = "",
    images: Iterable[str] = (),
    ratio: str = "",
    duration_seconds: int | None = None,
    generate_audio: bool | None = None,
    attempt: int = 0,
) -> str:
    """同一镜头 + 同一生成参数 + 同一次 attempt → 稳定的幂等键。

    参数顺序固定、图片列表保持**传入顺序**（顺序不同视为不同请求），
    并把 ``attempt`` 一起哈希：因此"原样重提"命中已有任务，"明确重新生成"才会拿到新键。
    """
    parts = [
        "v1",
        str(shot_id or "").strip(),
        str(prompt or "").strip(),
        str(reference_mode or "").strip(),
        "|".join(str(item).strip() for item in images if str(item).strip()),
        str(ratio or "").strip(),
        "" if duration_seconds is None else str(int(duration_seconds)),
        "" if generate_audio is None else ("1" if generate_audio else "0"),
        str(int(attempt or 0)),
    ]
    digest = hashlib.sha256("\u0001".join(parts).encode("utf-8")).hexdigest()
    return f"vid-{digest[:16]}"


def key_of_task_payload(payload: Any) -> str:
    """从任务 payload 里读回幂等键（没有就返回空串）。"""
    if not isinstance(payload, dict):
        return ""
    run_args = payload.get("run_args")
    if not isinstance(run_args, dict):
        return ""
    return str(run_args.get(KEY_FIELD) or "")


def stamp_task_payload(payload: Any, key: str) -> dict[str, Any]:
    """把幂等键写进任务 payload（返回新 dict，不改原对象）。

    幂等键里**不含任何凭证**，因此可以安全地留在任务行里供刷新恢复使用。
    """
    data = dict(payload) if isinstance(payload, dict) else {}
    run_args = data.get("run_args")
    run_args = dict(run_args) if isinstance(run_args, dict) else {}
    run_args[KEY_FIELD] = str(key or "")
    data["run_args"] = run_args
    return data


async def find_task_by_key(
    db: AsyncSession,
    *,
    key: str,
    task_kind: str = VIDEO_TASK_KIND,
) -> GenerationTask | None:
    """按幂等键找一条**可复用**的既有任务（可复用状态见 :data:`REUSABLE_STATUSES`）。

    只按 ``payload`` 过滤（SQLite JSON 里存的是字符串，直接 LIKE 更稳、也不需要 JSON1 扩展），
    再在 Python 侧用 :func:`key_of_task_payload` 精确核对，避免子串误命中。
    """
    clean = str(key or "").strip()
    if not clean:
        return None
    stmt = (
        select(GenerationTask)
        .where(GenerationTask.task_kind == task_kind)
        .order_by(GenerationTask.updated_at.desc())
        .limit(200)
    )
    rows = (await db.execute(stmt)).scalars().all()
    for row in rows:
        if key_of_task_payload(row.payload) != clean:
            continue
        status = getattr(row.status, "value", row.status)
        if str(status) in REUSABLE_STATUSES:
            return row
    return None


__all__ = [
    "CREDENTIAL_KEYS",
    "KEY_FIELD",
    "REUSABLE_STATUSES",
    "VIDEO_TASK_KIND",
    "build_video_idempotency_key",
    "find_task_by_key",
    "key_lock",
    "key_of_task_payload",
    "open_submission",
    "finalize_submission",
    "strip_credentials",
    "stamp_task_payload",
    "read_from_task",
]


# ---------------------------------------------------------------------------
# 落库（幂等键的家）与刷新恢复
# ---------------------------------------------------------------------------

#: 绝不落库的入参键（**本轮实测发现**旧视频任务行的 payload 里明文存了供应商 api_key，
#: 属于要报备给总控的安全问题；新路径不再重蹈覆辙）。
CREDENTIAL_KEYS: frozenset[str] = frozenset(
    {"api_key", "apikey", "api_secret", "secret", "token", "access_token", "authorization"}
)


def strip_credentials(mapping: Any) -> dict[str, Any]:
    """去掉入参里的凭证字段（深一层处理嵌套 dict）。"""
    if not isinstance(mapping, dict):
        return {}
    clean: dict[str, Any] = {}
    for raw_key, value in mapping.items():
        key = str(raw_key)
        if key.strip().lower() in CREDENTIAL_KEYS:
            continue
        if isinstance(value, dict):
            clean[key] = strip_credentials(value)
        else:
            clean[key] = value
    return clean


def new_task_id() -> str:
    return uuid4().hex


def _utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


async def open_submission(
    db: AsyncSession,
    *,
    key: str,
    shot_id: str,
    attempt: int = 0,
    provider: str = "",
    base_url: str = "",
    input_payload: Any = None,
) -> GenerationTask:
    """在**调用供应商之前**落一条 running 任务行，并把幂等键写进它的 payload。

    为什么必须先落库：这一步之后任何中断（网络断、进程被杀、浏览器关掉）都能靠
    "同一轮重复提交"命中这一行 → 页面知道「已经提交过了」，**不会**再花一次钱。
    """
    payload = stamp_task_payload(
        {
            "task_class": "video_submit_inline",
            "task_kind": VIDEO_TASK_KIND,
            "shot_id": str(shot_id or ""),
            "attempt": int(attempt or 0),
            "run_args": {
                "shot_id": str(shot_id or ""),
                "attempt": int(attempt or 0),
                "provider": str(provider or ""),
                "base_url": str(base_url or ""),
                # 凭证已在 strip_credentials 里去掉了
                "input": strip_credentials(input_payload),
            },
        },
        key,
    )
    task = GenerationTask(
        id=new_task_id(),
        mode=GenerationDeliveryMode.async_polling,
        task_kind=VIDEO_TASK_KIND,
        status=GenerationTaskStatus.running,
        progress=5,
        payload=payload,
        result=None,
        error="",
        started_at=_utcnow(),
        # 标明"已在本请求内内联执行"，避免被外部执行器当成待跑任务再跑一次
        executor_type="inline",
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return task


async def finalize_submission(
    db: AsyncSession,
    task: GenerationTask,
    *,
    status: str,
    provider_task_id: str = "",
    url: str = "",
    error: str = "",
    elapsed_ms: int = 0,
    warnings: list[str] | None = None,
) -> GenerationTask:
    """把结果写回任务行（页面刷新后据此恢复：状态 / 上游任务号 / 视频地址 / 失败原因）。"""
    raw_status = str(status or "").strip()
    succeeded = raw_status in {"succeeded", "success", "completed", "finished"}
    task.status = GenerationTaskStatus.succeeded if succeeded else GenerationTaskStatus.failed
    task.progress = 100 if succeeded else 0
    task.error = str(error or "")
    task.finished_at = _utcnow()
    task.executor_task_id = (str(provider_task_id or "") or None)
    task.result = {
        "provider_status": raw_status,
        "provider_task_id": str(provider_task_id or ""),
        "url": str(url or ""),
        "elapsed_ms": int(elapsed_ms or 0),
        "warnings": list(warnings or []),
    }
    await db.commit()
    await db.refresh(task)
    return task


def read_from_task(task: GenerationTask) -> dict[str, Any]:
    """从任务行恢复出可以塞进 ``VideoSubmitRead`` 的字段（刷新恢复用）。"""
    result = task.result if isinstance(task.result, dict) else {}
    status = getattr(task.status, "value", task.status)
    provider_status = str(result.get("provider_status") or "")
    if not provider_status:
        provider_status = {
            "succeeded": "succeeded",
            "running": "running",
            "pending": "pending",
            "failed": "failed",
            "cancelled": "cancelled",
        }.get(str(status), str(status))
    run_args = (task.payload or {}).get("run_args") if isinstance(task.payload, dict) else {}
    run_args = run_args if isinstance(run_args, dict) else {}
    return {
        "status": provider_status,
        "provider": str(result.get("provider") or run_args.get("provider") or ""),
        "provider_task_id": str(
            result.get("provider_task_id") or task.executor_task_id or ""
        ),
        "url": str(result.get("url") or ""),
        "elapsed_ms": int(result.get("elapsed_ms") or 0),
        "error": str(task.error or ""),
        "task_id": str(task.id or ""),
        "attempt": int(run_args.get("attempt") or 0),
    }
