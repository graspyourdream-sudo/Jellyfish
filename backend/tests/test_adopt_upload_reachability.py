"""采纳（上传进对象存储）之后的**匿名可达性验证**（故障 A 的收尾动作）。

为什么需要它：对象存储写入成功 ≠ 这个对象**匿名可读**。真实验收里，
本机可读、匿名访问 404 的地址被当成公网地址交给了上游 → 上游任务 failed
（原文「无法获取输入媒体 URL（404/410）」）。把验证放在**上传之后**，
用户当场就能看到「已入库，但这个地址匿名取不到」以及怎么修。

边界（本文件同样锁住）：

- 验证只报告、不阻断（图已经存好了）；
- DRY_RUN 下**一个字节都不出站**（与守卫同口径）；
- 全部不联网：探活一律注入 stub 或 MockTransport。
"""

from __future__ import annotations

import httpx
import pytest

from app.models.studio import Character, CharacterImage, FileItem, Prop
from app.services.studio.image_pipeline import adopt as adopt_module
from app.services.studio.image_pipeline import reference_preflight
from app.services.studio.image_pipeline.adopt import (
    adopt_generated_image,
    verify_uploaded_url_reachable,
)
from app.services.studio.llm_orchestration.dry_run import CONFIRM_ENV, DRY_RUN_ENV
from tests.llm_orchestration_fixtures import build_session

OSS_URL = "https://ai-shortdrama-assets.oss-cn-beijing.aliyuncs.com/jellyfish/acceptance/generated-images/character/x.png"


async def _fake_probe(url: str, *, label: str, **_kwargs) -> reference_preflight.ReferenceProbeResult:  # type: ignore[no-untyped-def]
    """stub 探活：返回"匿名 404"（真实故障里那个对象就是这个状态）。"""
    return await reference_preflight.probe_reference_url(
        url,
        label=label,
        transport=httpx.MockTransport(lambda _request: httpx.Response(404)),
    )


@pytest.fixture(autouse=True)
def _fake_upload(monkeypatch: pytest.MonkeyPatch) -> None:
    """把「下载远端图片 + 上传存储」替换掉：测试不依赖网络与对象存储。

    与既有 ``test_adopt_generated_image.py`` 同款做法，但这里返回的 FileItem 带
    ``thumbnail``（= 上传后的地址），因为本文件要验证的正是这个地址。
    """
    import uuid

    async def _fake(session, *, url=None, b64_data=None, name=None, prefix="files", **kwargs):  # type: ignore[no-untyped-def]
        item = FileItem(
            id=str(uuid.uuid4()),
            type="image",
            name=name or "generated",
            thumbnail=OSS_URL,
            storage_key=f"{prefix}/{uuid.uuid4()}.png",
        )
        session.add(item)
        await session.flush()
        return item

    monkeypatch.setattr(adopt_module, "create_file_from_url_or_b64", _fake)


# ---------------------------------------------------------------------------
# 1) verify_uploaded_url_reachable 的三种结论
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unreachable_upload_is_reported_with_fix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(DRY_RUN_ENV, "0")
    monkeypatch.setenv(CONFIRM_ENV, "1")

    reachable, probe_read, warnings = await verify_uploaded_url_reachable(
        OSS_URL,
        label="角色「林晓」的采纳图片",
        probe=_fake_probe,
    )

    assert reachable is False
    assert probe_read["http_status"] == 404
    assert warnings and "匿名公网访问不可达" in warnings[0]
    assert "重新上传" in warnings[0]
    # 不泄漏内部标识
    assert "file_id" not in warnings[0]


@pytest.mark.asyncio
async def test_reachable_upload_produces_no_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(DRY_RUN_ENV, "0")
    monkeypatch.setenv(CONFIRM_ENV, "1")

    async def _ok_probe(url: str, *, label: str, **_kwargs):  # type: ignore[no-untyped-def]
        return await reference_preflight.probe_reference_url(
            url,
            label=label,
            transport=httpx.MockTransport(lambda _request: httpx.Response(200)),
        )

    reachable, probe_read, warnings = await verify_uploaded_url_reachable(
        OSS_URL, label="角色「林晓」的采纳图片", probe=_ok_probe
    )

    assert reachable is True
    assert probe_read["result"] == "reachable"
    assert warnings == []


@pytest.mark.asyncio
async def test_dry_run_does_not_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    """演练模式：不触网，如实标注「未验证」（不是失败）。"""
    monkeypatch.setenv(DRY_RUN_ENV, "1")
    monkeypatch.delenv(CONFIRM_ENV, raising=False)
    called: list[str] = []

    async def _boom(url: str, *, label: str, **_kwargs):  # type: ignore[no-untyped-def]
        called.append(url)
        raise AssertionError("DRY_RUN 下不应探活")

    reachable, probe_read, warnings = await verify_uploaded_url_reachable(
        OSS_URL, label="角色「林晓」的采纳图片", probe=_boom
    )

    assert called == []
    assert reachable is None
    assert probe_read["result"] == "skipped"
    assert warnings == []


@pytest.mark.asyncio
async def test_empty_url_is_not_verified(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(DRY_RUN_ENV, "0")
    monkeypatch.setenv(CONFIRM_ENV, "1")

    reachable, probe_read, warnings = await verify_uploaded_url_reachable(
        "   ", label="角色「林晓」的采纳图片", probe=_fake_probe
    )

    assert reachable is None and probe_read == {} and warnings == []


# ---------------------------------------------------------------------------
# 2) 采纳端点：验证结果进响应（只报告，不阻断）
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_adopt_reports_unreachable_url_without_blocking(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(DRY_RUN_ENV, "0")
    monkeypatch.setenv(CONFIRM_ENV, "1")

    db, engine = await build_session()
    try:
        db.add(Character(id="char-1", project_id="proj-1", name="林晓", description="女主", style="真人都市"))
        await db.flush()
        adopted = await adopt_generated_image(
            db,
            entity_type="character",
            entity_id="char-1",
            url="https://cdn.example.com/generated.png",
            probe=_fake_probe,
        )
        row = await db.get(CharacterImage, adopted.image_id)
    finally:
        await engine.dispose()

    # 采纳本身照旧成功（图已经落库了），但如实报告地址不可达
    assert adopted.file_id
    assert row is not None and row.file_id == adopted.file_id
    assert adopted.url_reachable is False
    assert adopted.url_probe["http_status"] == 404
    assert adopted.warnings and "匿名公网访问不可达" in adopted.warnings[0]

    read = adopted.to_read()
    assert read["url_reachable"] is False
    assert read["url_probe"]["result"] == "unreachable"
    assert read["warnings"]


@pytest.mark.asyncio
async def test_adopt_dry_run_marks_reachability_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(DRY_RUN_ENV, "1")
    monkeypatch.delenv(CONFIRM_ENV, raising=False)

    db, engine = await build_session()
    try:
        db.add(Prop(id="prop-1", name="玉佩", description="x", style="真人都市"))
        await db.flush()
        adopted = await adopt_generated_image(
            db,
            entity_type="prop",
            entity_id="prop-1",
            url="https://cdn.example.com/generated.png",
        )
    finally:
        await engine.dispose()

    assert adopted.url_reachable is None
    assert adopted.url_probe["result"] == "skipped"
    assert adopted.warnings == []
