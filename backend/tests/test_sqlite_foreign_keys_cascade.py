"""SQLite 外键约束真的生效 + 级联删除不留孤儿（需求「顺带修复的小问题」）。

现场
====

仓库模型里写了大量 ``ForeignKey(..., ondelete="CASCADE")``，但 **SQLite 默认不强制外键**
（``PRAGMA foreign_keys`` 默认 0），而且这个开关是**连接级**的。实测（修复前）：

    >>> PRAGMA foreign_keys
    0

于是 ``GenerationTaskLink.task_id → generation_tasks.id ON DELETE CASCADE``
**从未生效**：删除一条生成任务时，它的关联子行会留下，成为指向已不存在任务的孤儿记录。
其它 ``ON DELETE CASCADE`` / ``SET NULL`` 声明同样形同虚设。

本文件钉三件事
==============

1. **开关真的开了**：用应用同款构造（``app.core.db`` 的引擎）连上后
   ``PRAGMA foreign_keys`` 必须是 1 —— 而且是**每条连接**都是 1（连接池换连接后不许失效）；
2. **级联真的发生了**：删任务 → 它的 ``generation_task_links`` 子行必须一起消失；
3. **反向对照**：在**不开 FK**的同一个库上做同一件事，孤儿会留下 ——
   这条对照是"为什么必须开"的证据，也防止有人哪天把开关删了却以为测试仍然有效。

只跑内存库：不触网、不付费、不碰任何真实库。
"""

from __future__ import annotations

import asyncio
from typing import Any, AsyncIterator

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.db import enable_sqlite_foreign_keys
from app.models.task import GenerationTask
from app.models.task_links import GenerationTaskLink

TASK_ID = "task-cascade-1"


async def _fresh_engine(*, foreign_keys: bool) -> tuple[Any, async_sessionmaker[AsyncSession]]:
    """建一个内存库引擎；``foreign_keys=True`` 时走**应用同款**的开关装配。"""
    from app.core.db import Base
    import app.models.llm  # noqa: F401  （注册全部表）
    import app.models.studio  # noqa: F401
    import app.models.task  # noqa: F401
    import app.models.task_links  # noqa: F401

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    if foreign_keys:
        enable_sqlite_foreign_keys(engine)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine, async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def _seed_task_with_link(db: AsyncSession) -> None:
    """一条生成任务 + 一条挂在它上面的关联行。"""
    db.add(
        GenerationTask(
            id=TASK_ID,
            mode="async_polling",
            task_kind="image_generation",
            status="succeeded",
            progress=100,
            payload={},
        )
    )
    await db.flush()
    db.add(
        GenerationTaskLink(
            task_id=TASK_ID,
            resource_type="image",
            relation_type="prop_image",
            relation_entity_id="asset-1",
            status="todo",
        )
    )
    await db.flush()


async def _link_count_for(db: AsyncSession, task_id: str) -> int:
    rows = (
        await db.execute(select(GenerationTaskLink).where(GenerationTaskLink.task_id == task_id))
    ).scalars().all()
    return len(rows)


@pytest.mark.asyncio
async def test_every_connection_has_foreign_keys_enabled() -> None:
    """**连接级**开关：连续取多条连接，每一条的 ``PRAGMA foreign_keys`` 都必须是 1。

    为什么不能只测一次：``PRAGMA`` 是连接级设置，连接池换一条新连接就回到默认 0。
    只设一次（例如建库时执行一遍）会静默失效——这正是"看着有约束、其实没有"的来源。
    """
    engine, _maker = await _fresh_engine(foreign_keys=True)
    try:
        for index in range(3):
            async with engine.connect() as conn:
                value = (await conn.execute(text("PRAGMA foreign_keys"))).scalar()
            assert value == 1, f"第 {index + 1} 条连接的 foreign_keys 不是 1（实际 {value}）"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_helper_is_idempotent_and_takes_effect_before_first_connection() -> None:
    """装配契约：**必须在任何连接建立之前**调用（应用就是这么用的），且可重复调用。

    为什么这条契约必须钉住：``PRAGMA foreign_keys`` 是**连接级**开关，
    事件监听器只对**之后**新建的连接生效；连接池里已经躺着的连接不会被追溯修正。
    应用的 ``_build_engine()`` 是"create_async_engine → 立刻装配 → 才第一次取连接"，
    顺序是对的；把顺序调换就会静默退回"外键不生效"，
    所以这里用一个**还没开过任何连接**的引擎来测真实契约。
    """
    from app.core.db import Base

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    try:
        enable_sqlite_foreign_keys(engine)
        enable_sqlite_foreign_keys(engine)  # 再来一次不应炸（幂等）
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with engine.connect() as conn:
            assert (await conn.execute(text("PRAGMA foreign_keys"))).scalar() == 1
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_deleting_task_cascades_to_task_links() -> None:
    """**主用例**：删任务 → 关联行一起走，不留孤儿。"""
    engine, maker = await _fresh_engine(foreign_keys=True)
    try:
        async with maker() as db:
            await _seed_task_with_link(db)
            assert await _link_count_for(db, TASK_ID) == 1
            await db.commit()

        async with maker() as db:
            task = await db.get(GenerationTask, TASK_ID)
            assert task is not None
            await db.delete(task)
            await db.commit()

        async with maker() as db:
            remaining = await _link_count_for(db, TASK_ID)
            assert remaining == 0, "删除任务后仍有关联行：ON DELETE CASCADE 没有生效"
    finally:
        await engine.dispose()


@pytest.mark.asyncio
async def test_without_foreign_keys_the_orphan_remains() -> None:
    """**反向对照**：不开 FK 时孤儿会留下 —— 这就是之前"看着有约束、其实没有"的形态。

    这条用例的价值是把"为什么必须开开关"变成可执行的证据：
    哪天有人把 ``enable_sqlite_foreign_keys`` 删掉，主用例会红，
    而这条对照会告诉你**同样的代码在关掉开关时是什么后果**。
    """
    engine, maker = await _fresh_engine(foreign_keys=False)
    try:
        async with maker() as db:
            await _seed_task_with_link(db)
            await db.commit()

        async with maker() as db:
            assert (await db.execute(text("PRAGMA foreign_keys"))).scalar() == 0, "本对照要求开关是关的"
            task = await db.get(GenerationTask, TASK_ID)
            assert task is not None
            await db.delete(task)
            await db.commit()

        async with maker() as db:
            assert await _link_count_for(db, TASK_ID) == 1, "关掉 FK 时本就该留下孤儿（这正是问题）"
    finally:
        await engine.dispose()
