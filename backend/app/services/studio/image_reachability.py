"""图片行的**可达性/长期资产**判定：别把「只在本机」的图当成长期资产。

要解决的问题（真实演练）
========================

2026-09-27 采纳的那张「苏晚棠」定版图，`files.storage_key` 是
``generated-images/character/….png`` —— **本机相对地址**，不是公网地址。
而页面把它当成一个正常的定版图展示，用户自然以为"这张图就是项目的长期资产、
后续出视频可以直接拿它当参考帧"。

实际上两条都不成立：

1. 它不是长期资产（AGENTS.md 约束 10：出图结果长期资产优先用 OSS URL，
   不把 ``/images/...`` 当长期资产）；
2. **不能用于后续生成**：视频通道（APIMart）只接受 ``http(s)://`` / ``asset://``，
   本机相对地址发给它必然是"取不到"。真发出去就是花钱买一次注定失败的调用。

所以本模块给每条图片行算三件事，随列表一起返回（**加法字段**，不新增依赖）：

- ``long_term_url``：公网长期地址（取不到就是空串，不猜、不拼）；
- ``usable_for_generation``：这张图能不能作为参考图进入后续生成；
- ``reachability_note``：中文说明（直接可展示，页面用来标"不可用于生成"）。

口径
====

- ``http(s)://`` → 公网可达，可长期、可用于生成；
- ``asset://`` → 供应商侧的资产引用，同样可用于生成（这是既有契约接受的形态）；
- 其它（``generated-images/…`` / ``files/…`` / ``/files/…`` 这类本机相对路径）→
  **不是长期资产、不可用于生成**；
- 空 ``storage_key`` → 这条记录还没落到文件上，同样不可用。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.studio import FileItem

_PUBLIC_PREFIXES = ("http://", "https://")
_VENDOR_PREFIXES = ("asset://",)


@dataclass(frozen=True)
class ImageReachability:
    long_term_url: str = ""
    usable_for_generation: bool = False
    note: str = ""

    def as_fields(self) -> dict[str, Any]:
        return {
            "long_term_url": self.long_term_url,
            "usable_for_generation": self.usable_for_generation,
            "reachability_note": self.note,
        }


_LOCAL_NOTE = (
    "这张图只存在本机（不是公网长期地址），**不能用于后续生成**："
    "出视频等下游环节取不到它。要用于后续生成，请先把图落到公网长期存储（OSS）地址再设为定版。"
)


def assess_storage_key(storage_key: str) -> ImageReachability:
    """按 ``files.storage_key`` 判定可达性（纯函数，便于逐档钉测试）。"""
    key = str(storage_key or "").strip()
    if not key:
        return ImageReachability(
            note="这条图片记录还没有关联到实际文件，暂时不能用于后续生成。"
        )
    lowered = key.lower()
    if lowered.startswith(_PUBLIC_PREFIXES):
        return ImageReachability(long_term_url=key, usable_for_generation=True)
    if lowered.startswith(_VENDOR_PREFIXES):
        # 供应商侧资产引用：既有契约接受这个形态，可进后续生成，但它不是"我们的公网地址"
        return ImageReachability(long_term_url=key, usable_for_generation=True)
    return ImageReachability(note=_LOCAL_NOTE)


async def storage_keys_by_file_id(db: AsyncSession, file_ids: list[str]) -> dict[str, str]:
    """file_id → ``files.storage_key``（一次查询；两个读模型共用这一处，避免各写一份）。"""
    ids = [str(fid) for fid in file_ids if str(fid or "").strip()]
    if not ids:
        return {}
    stmt = select(FileItem.id, FileItem.storage_key).where(FileItem.id.in_(ids))
    return {str(fid): str(key or "") for fid, key in (await db.execute(stmt)).all()}


async def annotate_image_rows(
    db: AsyncSession,
    rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """给已经序列化好的图片行补上可达性字段（一次查询批量取 ``storage_key``）。

    为什么在这里补而不是在模型层算：``asset_*`` 的读模型是 ``from_attributes`` 直接吃 ORM 行，
    ORM 行上没有"文件地址"（要 join ``files``）。在服务层补最省、也最不容易漏。
    """
    if not rows:
        return rows
    file_ids = [str(row.get("file_id") or "") for row in rows]
    file_ids = [fid for fid in file_ids if fid]
    key_by_id: dict[str, str] = {}
    if file_ids:
        stmt = select(FileItem.id, FileItem.storage_key).where(FileItem.id.in_(file_ids))
        for fid, storage_key in (await db.execute(stmt)).all():
            key_by_id[str(fid)] = str(storage_key or "")

    for row in rows:
        fid = str(row.get("file_id") or "")
        row.update(assess_storage_key(key_by_id.get(fid, "")).as_fields())
    return rows


__all__ = [
    "ImageReachability",
    "annotate_image_rows",
    "assess_storage_key",
    "storage_keys_by_file_id",
]
