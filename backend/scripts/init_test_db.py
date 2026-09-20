#!/usr/bin/env python
"""初始化一个干净的测试数据库（本机跑全量后端测试用）。

为什么需要它：
    后端有一部分接口测试**不使用内存库**，而是直接走 `get_db` 依赖，因此需要一个
    「表结构完整、且模型/供应商配置可用」的 SQLite 库。缺表时这些用例会以
    `no such table: model_settings` 之类的错误失败，看起来像代码回归，其实是环境没初始化；
    只建表不写配置同样会失败（例如视频计划接口会因为「供应商没有 api_key」返回 503）。

本脚本做两件事（都与线上行为一致，且幂等）：
    1. 用**当前 ORM 模型**建全量表结构（`Base.metadata.create_all`）；
    2. 写入一组最小可用的配置种子：1 个供应商 + 文本/图片/视频各 1 个模型 + 默认模型设置。

用法：
    python backend/scripts/init_test_db.py /tmp/jf_test/test.db
    DATABASE_URL="sqlite+aiosqlite:////tmp/jf_test/test.db" pytest backend/tests -q

注意：种子里的 api_key 是**假值**，只用于让配置解析通过，不会发起任何真实调用。
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from sqlalchemy import select  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

import app.models  # noqa: F401,E402  —— 导入以注册全部 ORM 模型
from app.core.db import Base  # noqa: E402
from app.models.llm import Model, ModelCategoryKey, ModelSettings, Provider, ProviderStatus  # noqa: E402

FAKE_API_KEY = "test-key-not-real"

PROVIDERS = [
    {"id": "prov-apimart", "name": "apimart"},
    {"id": "prov-deepseek", "name": "deepseek"},
]

MODELS: list[tuple[str, str, ModelCategoryKey, str]] = [
    ("model-deepseek-chat", "deepseek-chat", ModelCategoryKey.text, "prov-deepseek"),
    ("model-gpt-image-2", "gpt-image-2", ModelCategoryKey.image, "prov-apimart"),
    ("model-seedance-2.0-mini", "seedance-2.0-mini", ModelCategoryKey.video, "prov-apimart"),
]


async def init(db_url: str) -> None:
    engine = create_async_engine(db_url)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with session_factory() as db:
        for spec in PROVIDERS:
            existing = (await db.execute(select(Provider).where(Provider.id == spec["id"]))).scalars().first()
            if existing is None:
                db.add(
                    Provider(
                        id=spec["id"],
                        name=spec["name"],
                        base_url="http://127.0.0.1:9/v1",
                        api_key=FAKE_API_KEY,
                        description="测试库种子（假 api_key，不会发起真实调用）",
                        status=ProviderStatus.active,
                        created_by="init_test_db",
                    )
                )
        for model_id, name, category, provider_id in MODELS:
            existing = (await db.execute(select(Model).where(Model.id == model_id))).scalars().first()
            if existing is None:
                db.add(
                    Model(
                        id=model_id,
                        name=name,
                        category=category,
                        provider_id=provider_id,
                        params={},
                        description="测试库种子",
                        created_by="init_test_db",
                    )
                )
        settings = await db.get(ModelSettings, 1)
        if settings is None:
            settings = ModelSettings(id=1)
            db.add(settings)
        settings.default_text_model_id = "model-deepseek-chat"
        settings.default_image_model_id = "model-gpt-image-2"
        settings.default_video_model_id = "model-seedance-2.0-mini"
        await db.commit()

    await engine.dispose()
    print(f"已初始化测试库：{db_url}")
    print(f"  表数量：{len(Base.metadata.tables)}；供应商 {len(PROVIDERS)}；模型 {len(MODELS)}")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    target = Path(sys.argv[1]).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    asyncio.run(init(f"sqlite+aiosqlite:///{target}"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
