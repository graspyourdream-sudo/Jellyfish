"""SQLAlchemy 异步引擎与会话。"""

from typing import Any

from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    AsyncEngine,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.config import settings


def enable_sqlite_foreign_keys(target: AsyncEngine | Engine) -> None:
    """让这个引擎的**每一条连接**都执行 ``PRAGMA foreign_keys=ON``。

    为什么必须有这一步（不是可选优化）：
    **SQLite 默认不强制外键约束**（``PRAGMA foreign_keys`` 默认为 0）。本仓库的模型里
    写了大量 ``ForeignKey(..., ondelete="CASCADE")``，但在此以前它们**从未生效过** ——
    实测确认：连上库后 ``PRAGMA foreign_keys`` 返回 **0**。

    直接后果（需求点名的两件事都源于此）：
    - 删除一条 ``generation_tasks`` 时，它的 ``generation_task_links`` 子行**不会**跟着删，
      留下指向已不存在任务的孤儿记录；
    - 其它 ``ON DELETE CASCADE`` / ``SET NULL`` 声明同样形同虚设。

    为什么挂在 ``connect`` 事件上而不是建库时设一次：``PRAGMA foreign_keys`` 是
    **连接级**开关，连接池每新建一条连接都要重设；只设一次会在换连接后静默失效。

    只对 SQLite 生效：其它后端（Postgres 等）本来就强制外键，执行这个 PRAGMA 会报错。
    """
    sync_engine: Engine = getattr(target, "sync_engine", target)  # type: ignore[assignment]
    if sync_engine.dialect.name != "sqlite":
        return

    @event.listens_for(sync_engine, "connect")
    def _set_sqlite_pragma(dbapi_connection: Any, _connection_record: Any) -> None:
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA foreign_keys=ON")
        finally:
            cursor.close()


def _build_engine() -> AsyncEngine:
    engine = create_async_engine(
        settings.database_url,
        echo=settings.debug,
        future=True,
    )
    # 外键约束必须真的生效：否则 ondelete="CASCADE" 只是注释（见上方 docstring）
    enable_sqlite_foreign_keys(engine)
    return engine


def _build_session_maker(bind_engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(
        bind_engine,
        class_=AsyncSession,
        expire_on_commit=False,
        autocommit=False,
        autoflush=False,
    )


class _AsyncSessionMakerProxy:
    """可重绑定的 sessionmaker 代理。

    Celery prefork 模式下，worker 子进程不能继续复用父进程里初始化的
    async engine / sessionmaker。这里保持导入对象稳定，同时允许在子进程
    启动后重新绑定底层 sessionmaker。
    """

    def __init__(self, maker: async_sessionmaker[AsyncSession]) -> None:
        self._maker = maker

    def configure(self, maker: async_sessionmaker[AsyncSession]) -> None:
        self._maker = maker

    def __call__(self, *args: Any, **kwargs: Any) -> AsyncSession:
        return self._maker(*args, **kwargs)


engine = _build_engine()
async_session_maker = _AsyncSessionMakerProxy(_build_session_maker(engine))


class Base(DeclarativeBase):
    """所有 ORM 模型的基类。"""

    pass


async def init_db() -> None:
    """创建所有表（开发/迁移用）。"""
    # 确保 ORM 模型已导入，从而注册到 Base.metadata
    import app.models.llm  # noqa: F401  # pylint: disable=unused-import
    import app.models.studio  # noqa: F401
    import app.models.task  # noqa: F401
    import app.models.task_links  # noqa: F401

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def close_db() -> None:
    """关闭数据库连接。"""
    await engine.dispose()


def reset_db_runtime() -> None:
    """在 Celery worker 子进程中重建 engine 与 sessionmaker。

    这样可以避免 prefork 继承父进程中的 async engine，导致连接对象和事件循环
    绑定错乱，触发 Future attached to a different loop。
    """

    global engine

    engine = _build_engine()
    async_session_maker.configure(_build_session_maker(engine))
