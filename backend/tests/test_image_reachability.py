"""图片行的可达性判定：只在本机的图，必须被标成「不可用于后续生成」。

真实演练（2026-09-27）：采纳的那张「苏晚棠」定版图，`files.storage_key` 是
`generated-images/character/….png`（本机相对地址），但页面把它当普通定版图展示——
看起来像这个项目的长期资产，实际上：

1. 不是长期资产（AGENTS.md 约束 10：长期资产优先用 OSS URL，不把 `/images/...` 当长期资产）；
2. **不能用于后续生成**：视频通道只接受 `http(s)://` / `asset://`，本机地址发过去必然取不到——
   真发出去就是花钱买一次注定失败的调用。

本文件把这条口径钉死。
"""

from __future__ import annotations

import pytest

from app.services.studio.image_reachability import (
    ImageReachability,
    annotate_image_rows,
    assess_storage_key,
)


def test_public_url_is_long_term_and_usable() -> None:
    r = assess_storage_key("https://ai-shortdrama-assets.oss-cn-beijing.aliyuncs.com/x/y.png")
    assert r.usable_for_generation is True
    assert r.long_term_url.startswith("https://")
    assert r.note == ""


def test_vendor_asset_reference_is_usable() -> None:
    """供应商侧资产引用（asset://）是既有契约接受的形态，可以进后续生成。"""
    r = assess_storage_key("asset://jellyfish/abc123")
    assert r.usable_for_generation is True
    assert r.long_term_url == "asset://jellyfish/abc123"


@pytest.mark.parametrize(
    "key",
    [
        "generated-images/character/50e41ae4f67f49b1af9c1daa739e1e8a.png",
        "files/real_test_image.png",
        "/files/files/voice.mp3",
        "outputs/shot.mp4",
    ],
)
def test_local_relative_path_is_not_usable_for_generation(key: str) -> None:
    """本机相对地址：不是长期资产、不能用于后续生成，并且要给出中文修法。"""
    r = assess_storage_key(key)
    assert r.usable_for_generation is False
    assert r.long_term_url == ""
    assert "不能用于后续生成" in r.note
    assert "OSS" in r.note


def test_empty_storage_key_is_not_usable() -> None:
    r = assess_storage_key("")
    assert r.usable_for_generation is False
    assert r.long_term_url == ""
    assert "没有关联到实际文件" in r.note


def test_assessment_fields_are_additive_and_stable() -> None:
    """随列表一起返回的字段名要固定：页面按这三个键渲染，改名会静默失效。"""
    assert set(ImageReachability().as_fields()) == {
        "long_term_url",
        "usable_for_generation",
        "reachability_note",
    }


@pytest.mark.asyncio
async def test_annotate_rows_uses_files_table() -> None:
    """整行标注：按 file_id 批量查 files.storage_key，一次查询搞定（不 N+1）。"""
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

    import app.models  # noqa: F401 - 导入即注册全部表
    from app.core.db import Base
    from app.models.studio import FileItem

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with maker() as db:
        db.add(FileItem(id="f-oss", type="image", name="a", storage_key="https://cdn.example.com/a.png"))
        db.add(FileItem(id="f-local", type="image", name="b", storage_key="generated-images/character/b.png"))
        await db.commit()

        rows = [
            {"id": 1, "file_id": "f-oss", "is_primary": True},
            {"id": 2, "file_id": "f-local", "is_primary": False},
            {"id": 3, "file_id": None, "is_primary": False},
            {"id": 4, "file_id": "missing-file", "is_primary": False},
        ]
        await annotate_image_rows(db, rows)

    assert rows[0]["usable_for_generation"] is True
    assert rows[0]["long_term_url"] == "https://cdn.example.com/a.png"
    assert rows[1]["usable_for_generation"] is False
    assert rows[1]["long_term_url"] == ""
    assert rows[1]["reachability_note"]
    # 没有 file_id / file_id 指向不存在的行：都按"不可用"处理，不许乐观放行
    assert rows[2]["usable_for_generation"] is False
    assert rows[3]["usable_for_generation"] is False
    await engine.dispose()


@pytest.mark.asyncio
async def test_annotate_empty_list_is_noop() -> None:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

    import app.models  # noqa: F401
    from app.core.db import Base

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as db:
        assert await annotate_image_rows(db, []) == []
    await engine.dispose()
