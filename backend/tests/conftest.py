"""Pytest 共享 fixture：FastAPI 应用与 TestClient。"""

from __future__ import annotations

import asyncio
import inspect

import pytest
from fastapi.testclient import TestClient

try:
    from app.main import app  # type: ignore
except Exception:  # noqa: BLE001
    # 测试环境里有些可选依赖（例如 langgraph）可能未安装。
    # 不要让整个测试套件在导入 conftest 时直接失败；仅在需要 client 的测试里跳过。
    app = None


DRY_RUN_ENV = "JELLYFISH_DRY_RUN"
CONFIRM_ENV = "JELLYFISH_REAL_LLM_CONFIRMED"


class _NoSwitchSettings:
    """``Settings`` 替身：等价于 ``backend/.env`` 里**没写**这两个开关。"""

    jellyfish_dry_run: str | None = None
    jellyfish_real_llm_confirmed: str | None = None


@pytest.fixture(autouse=True)
def _force_dry_run_in_tests(monkeypatch: pytest.MonkeyPatch) -> None:
    """测试环境一律「两处都没写开关」，保证整个测试套件默认是**演练模式**。

    为什么必须有这一条：守卫现在也认 ``backend/.env``（pydantic-settings 读进
    ``Settings``）。如果本机 / CI 缓存里正好有一份打开了真实模式的 ``.env``，
    整套测试就会在**真实模式**下跑——那是会花钱的。这里把两个来源都钉死：

    - 进程环境变量：``delenv``；
    - ``backend/.env``：把守卫读 ``Settings`` 的唯一入口 :func:`dry_run._settings`
      换成「什么都没有」的替身。

    需要测环境变量 / ``.env`` 的用例，在自己用例体内 monkeypatch 覆盖回来即可：
    用例体内的 monkeypatch 在夹具之后生效，优先级更高。
    """
    monkeypatch.delenv(DRY_RUN_ENV, raising=False)
    monkeypatch.delenv(CONFIRM_ENV, raising=False)
    try:
        from app.services.studio.llm_orchestration import dry_run
    except Exception:  # noqa: BLE001 - 可选依赖缺失时不影响不需要守卫的用例
        return
    monkeypatch.setattr(dry_run, "_settings", lambda: _NoSwitchSettings())


@pytest.fixture
def client() -> TestClient:
    """FastAPI 应用 TestClient，用于集成测试。"""
    if app is None:
        pytest.skip("FastAPI app 依赖未满足（例如缺少 langgraph），跳过需要 client 的集成测试。")
    return TestClient(app)


def pytest_configure(config: pytest.Config) -> None:
    """为轻量测试环境补齐 asyncio marker。"""
    config.addinivalue_line("markers", "asyncio: mark test as asyncio coroutine")


@pytest.hookimpl(tryfirst=True)
def pytest_pyfunc_call(pyfuncitem: pytest.Function) -> bool | None:
    """在未安装 pytest-asyncio 的环境中兜底执行 async 测试。"""

    if not inspect.iscoroutinefunction(pyfuncitem.obj):
        return None

    funcargs = {
        arg: pyfuncitem.funcargs[arg]
        for arg in pyfuncitem._fixtureinfo.argnames
        if arg in pyfuncitem.funcargs
    }
    asyncio.run(pyfuncitem.obj(**funcargs))
    return True
