"""出口 B「视频交付 · 批量下载」——把**实际生成好的成片**打成一个 ZIP。

解决的真实问题（需求清单第 9 条）
================================

工作室一次能生成一整集视频，但产出只能**一个一个点开下载**（浏览器逐个打开下载窗口），
这不是批量下载。这里给出后端正式的最小打包能力。

三条硬口径
----------

1. **只打包真实存在、真的读得出来的成片**。
   每个镜头取的就是**交付清单里用的那一份文件**（``shots.generated_video_file_id``，
   它在视频任务成功落库时写入 —— 也就是说「失败 / 半成品」根本不会出现在这里）。
   没有结果的镜头、文件记录已不在的镜头、字节读不出来的镜头，**一律不进包**，
   并且各自给出一条中文原因（页面用它显示"被排除了几项、为什么"）。

2. **打包内容与交付清单同源**。
   ZIP 里除视频外还放一份 ``交付清单.txt``，逐行写明「镜头号 / 标题 / 包内文件名」，
   外加被排除的镜头及原因。用户不需要另开一个页面核对包里到底有什么。

3. **不做"仅本机"的冒充**。
   文件在外部地址（``storage_key`` 是 http(s)）时**真的去取一次**；取不到就排除并说明，
   绝不生成一个 0 字节的同名条目让用户以为下载成功了。

为什么按范围取镜头复用 ``prompt_delivery.fetch_delivery_rows``：
那是全仓**唯一**一份「按 project / chapter / 选中镜头取交付范围」的实现，
再写一份就会出现"交付清单里有 12 镜、下载包里只有 10 镜"这种对不上的问题。
"""

from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass, field
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import storage
from app.models.studio import FileItem
from app.models.studio_shots import Shot
from app.services.studio import prompt_delivery as delivery_svc

#: 打包范围的三种口径（与出口 A 的 scope 取值一致，页面复用同一套参数）
SCOPE_EPISODE = delivery_svc.SCOPE_EPISODE
SCOPE_EPISODES = delivery_svc.SCOPE_EPISODES
SCOPE_CURRENT_SHOT = delivery_svc.SCOPE_CURRENT_SHOT

#: ZIP 里那份清单的文件名（**固定**，方便用户一眼找到、也方便脚本判断）
MANIFEST_NAME = "交付清单.txt"

#: 取外部地址的超时（秒）。视频文件可能很大，所以读超时给得比连接超时宽。
_REMOTE_CONNECT_TIMEOUT = 10.0
_REMOTE_READ_TIMEOUT = 300.0

#: 文件名里必须替换掉的字符（Windows / macOS 都不安全，且会让 ZIP 解出奇怪路径）
_UNSAFE_FILENAME_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


@dataclass(slots=True)
class BundleItem:
    """一个镜头在交付包里的状态（无论进不进包都有一条）。"""

    shot_id: str
    shot_code: str
    shot_title: str
    chapter_label: str
    #: 进包时的包内文件名；不进包为空串
    file_name: str = ""
    #: 文件记录 id（**只进技术详情**，不上主区）
    file_id: str = ""
    size_bytes: int = 0
    included: bool = False
    #: 不进包时的中文原因（进包时为空串）
    reason: str = ""
    #: 实际字节（只在服务内部用，写进 ZIP 后就被丢掉，不进任何响应模型）
    content: bytes | None = field(default=None, repr=False)

    def to_read(self) -> dict[str, Any]:
        """给页面的只读口径：**不含字节、不含内部标识以外的技术字段**。"""
        return {
            "shot_id": self.shot_id,
            "shot_code": self.shot_code,
            "shot_title": self.shot_title,
            "chapter_label": self.chapter_label,
            "file_name": self.file_name,
            "size_bytes": self.size_bytes,
            "included": self.included,
            "reason": self.reason,
        }


@dataclass(slots=True)
class VideoBundlePlan:
    """一次打包的范围结论（页面在下载前先拿它显示"包含几条 / 排除几条"）。"""

    project_id: str
    scope: str
    scope_label: str
    items: list[BundleItem] = field(default_factory=list)

    @property
    def included(self) -> list[BundleItem]:
        return [item for item in self.items if item.included]

    @property
    def excluded(self) -> list[BundleItem]:
        return [item for item in self.items if not item.included]

    @property
    def included_count(self) -> int:
        return len(self.included)

    @property
    def excluded_count(self) -> int:
        return len(self.excluded)

    @property
    def has_content(self) -> bool:
        return self.included_count > 0

    def to_read(self) -> dict[str, Any]:
        return {
            "project_id": self.project_id,
            "scope": self.scope,
            "scope_label": self.scope_label,
            "included_count": self.included_count,
            "excluded_count": self.excluded_count,
            "has_content": self.has_content,
            "items": [item.to_read() for item in self.items],
            "excluded": [item.to_read() for item in self.excluded],
        }


def safe_file_name(value: str, *, fallback: str = "shot") -> str:
    """把镜头标题转成安全的文件名片段（保留中文，只替换文件系统不安全的字符）。

    为什么保留中文：交付文件是给人看的，「SH-01_便利店-全景推进.mp4」比
    「SH-01_a1b2c3.mp4」有用得多；文件名稳定、可读、且不冲突（冲突由调用方补序号）。
    """
    text = _UNSAFE_FILENAME_CHARS.sub("_", str(value or "")).strip()
    text = re.sub(r"\s+", " ", text).strip(" ._")
    return text or fallback


def build_bundle_file_name(shot_code: str, shot_title: str, *, extension: str) -> str:
    """包内文件名：``SH-01_便利店-全景推进.mp4``（镜头号在最前面，按镜头排序即按名字排序）。"""
    code = safe_file_name(shot_code, fallback="SHOT")
    title = safe_file_name(shot_title, fallback="未命名")
    ext = extension if extension.startswith(".") else f".{extension}"
    return f"{code}_{title}{ext}"


def dedupe_file_name(name: str, used: set[str]) -> str:
    """重名时补 ``_2`` / ``_3``（不同镜头标题可能一模一样，包内名字不能互相覆盖）。"""
    if name not in used:
        used.add(name)
        return name
    stem, dot, ext = name.rpartition(".")
    base = stem if dot else name
    suffix = f".{ext}" if dot else ""
    index = 2
    while True:
        candidate = f"{base}_{index}{suffix}"
        if candidate not in used:
            used.add(candidate)
            return candidate
        index += 1


def _extension_for(name: str, storage_key: str) -> str:
    """从文件名 / 存储 key 里取扩展名；取不到按 mp4（成片口径）。"""
    for candidate in (name, storage_key):
        text = str(candidate or "").strip()
        if "." in text:
            ext = text.rsplit(".", 1)[-1].strip().lower()
            if ext and len(ext) <= 5 and ext.isalnum():
                return ext
    return "mp4"


async def _read_file_bytes(file_item: FileItem) -> bytes:
    """读出文件字节：外部地址真的去取一次，本地/对象存储走 storage 抽象。"""
    key = str(file_item.storage_key or "").strip()
    if not key:
        raise ValueError("这条结果没有保存到可取回的位置")
    if key.startswith(("http://", "https://")):
        timeout = httpx.Timeout(_REMOTE_READ_TIMEOUT, connect=_REMOTE_CONNECT_TIMEOUT)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.get(key)
            if response.status_code != 200:
                raise ValueError("结果只保存在外部地址，本次读取没有成功")
            return response.content
    return await storage.download_file(key=key)


async def build_video_bundle_plan(
    db: AsyncSession,
    *,
    project_id: str,
    chapter_id: str | None = None,
    shot_id: str | None = None,
    shot_ids: list[str] | None = None,
    scope: str = SCOPE_EPISODES,
    read_bytes: bool = True,
) -> VideoBundlePlan:
    """算出这次打包会包含哪些镜头、排除哪些镜头以及原因。

    ``read_bytes=False`` 时只做**清单预检**（不把视频读进内存）：页面在下载前的
    「包含 N 条 / 排除 M 条」读它；真正的下载再带着 ``read_bytes=True`` 走一遍。
    """
    rows = await delivery_svc.fetch_delivery_rows(
        db,
        project_id=project_id,
        chapter_id=chapter_id,
        shot_id=shot_id,
        shot_ids=shot_ids,
    )
    scope_label = delivery_svc.SCOPE_LABELS.get(scope, delivery_svc.SCOPE_LABELS[SCOPE_EPISODES])

    plan = VideoBundlePlan(project_id=project_id, scope=scope, scope_label=scope_label)
    if not rows:
        return plan

    shot_id_list = [row["shot_id"] for row in rows]
    stmt = select(Shot.id, Shot.generated_video_file_id).where(Shot.id.in_(shot_id_list))
    video_file_by_shot: dict[str, str] = {}
    for sid, file_id in (await db.execute(stmt)).all():
        if file_id:
            video_file_by_shot[str(sid)] = str(file_id)

    wanted_file_ids = sorted(set(video_file_by_shot.values()))
    file_by_id: dict[str, FileItem] = {}
    if wanted_file_ids:
        file_stmt = select(FileItem).where(FileItem.id.in_(wanted_file_ids))
        for item in (await db.execute(file_stmt)).scalars().all():
            file_by_id[str(item.id)] = item

    used_names: set[str] = set()
    for row in rows:
        sid = str(row["shot_id"])
        code = delivery_svc.shot_code(row["shot_index"])
        item = BundleItem(
            shot_id=sid,
            shot_code=code,
            shot_title=str(row["shot_title"] or ""),
            chapter_label=delivery_svc.chapter_label(row["chapter_id"], row["chapter_title"]),
        )
        file_id = video_file_by_shot.get(sid, "")
        if not file_id:
            item.reason = "该镜头还没有生成结果（生成成功后才会有可交付的成片）"
            plan.items.append(item)
            continue
        file_item = file_by_id.get(file_id)
        if file_item is None:
            item.reason = "这条成片的文件记录已经不存在，请重新生成后再下载"
            plan.items.append(item)
            continue
        item.file_id = file_id
        if read_bytes:
            try:
                content = await _read_file_bytes(file_item)
            except Exception:  # noqa: BLE001 - 任何读取失败都只影响这一条，不影响整包
                item.reason = "这条成片当前读不出来（可能只存在于本机或外部地址已失效），请重新生成或重新上传"
                plan.items.append(item)
                continue
            if not content:
                item.reason = "这条成片的文件内容是空的，不能交付"
                plan.items.append(item)
                continue
            item.content = content
            item.size_bytes = len(content)
        else:
            item.size_bytes = 0
        extension = _extension_for(file_item.name, file_item.storage_key)
        item.file_name = dedupe_file_name(build_bundle_file_name(code, item.shot_title, extension=extension), used_names)
        item.included = True
        plan.items.append(item)
    return plan


def build_manifest_text(plan: VideoBundlePlan, *, project_label: str = "") -> str:
    """ZIP 内的 ``交付清单.txt``：与包内容**同源**，逐行说明包含什么、排除了什么。"""
    lines: list[str] = []
    title = f"交付清单{(' · ' + project_label) if project_label else ''}"
    lines.append(title)
    lines.append("=" * 8)
    lines.append(f"范围：{plan.scope_label}")
    lines.append(f"包含 {plan.included_count} 条成片；排除 {plan.excluded_count} 条。")
    lines.append("")
    lines.append("【包含的成片】")
    if plan.included:
        for item in plan.included:
            lines.append(f"{item.shot_code} | {item.chapter_label} | {item.shot_title} | {item.file_name}")
    else:
        lines.append("（本次没有可交付的成片）")
    lines.append("")
    lines.append("【排除的镜头及原因】")
    if plan.excluded:
        for item in plan.excluded:
            lines.append(f"{item.shot_code} | {item.chapter_label} | {item.shot_title} | {item.reason}")
    else:
        lines.append("（没有排除项）")
    lines.append("")
    lines.append("说明：包内只包含**生成成功并已落库**的成片；失败与半成品不会进包，也不会重复计费。")
    return "\n".join(lines) + "\n"


def write_bundle_zip(plan: VideoBundlePlan, *, project_label: str = "") -> io.BytesIO:
    """把清单与成片写成一个 ZIP（``ZIP_STORED``：视频本身已压缩，再压只浪费 CPU）。

    返回的 ``BytesIO`` 由调用方负责按块流式回给浏览器，
    这样大文件不会在内存里再复制一份。
    """
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, mode="w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr(MANIFEST_NAME, build_manifest_text(plan, project_label=project_label))
        for item in plan.included:
            archive.writestr(item.file_name, item.content or b"")
    buffer.seek(0)
    return buffer


def bundle_filename(plan: VideoBundlePlan) -> str:
    """整包下载的文件名（稳定、可读、不含内部标识）。"""
    return f"成片交付_{safe_file_name(plan.scope_label, fallback='本集')}_{plan.included_count}条.zip"


__all__ = [
    "MANIFEST_NAME",
    "SCOPE_CURRENT_SHOT",
    "SCOPE_EPISODE",
    "SCOPE_EPISODES",
    "BundleItem",
    "VideoBundlePlan",
    "build_bundle_file_name",
    "build_manifest_text",
    "build_video_bundle_plan",
    "bundle_filename",
    "dedupe_file_name",
    "safe_file_name",
    "write_bundle_zip",
]
