"""商品资料提取（``POST /studio/projects/{pid}/product-card/extract``）的切片测试。

覆盖用户验收口径：

- ``paste``：脏输出（Markdown 围栏 / 尾随逗号）也能解析，字段归一 + 缺项标「待补充」；
- ``upload``：TXT / DOCX 能抽出正文进提示词；**图片只归档并如实告警**（本仓库不识图）；
  一个字的正文都拿不到时**不调模型**（调了也只能编造）；
- ``existing``：从 ``products`` 表带出名称/描述，**确定性映射、不调模型**；
- 演练模式：**一次都不调模型**、字段全空、如实说明；
- 坏 JSON → 结构化 422；
- **不落库**：跑完提取后 ``product_cards`` 行未变（契约要求"提取不落库、由用户确认"）。

隔离纪律：数据库是**内存库**（不碰 ``/tmp/jellyfish-ad-mvp/db/ad_mvp.db``，更不碰正式库）；
模型一律用注入的 stub caller（零出网、零付费）；文件字节用替身注入（不读对象存储、不落盘）。
"""

from __future__ import annotations

import asyncio
import io
import json
import zipfile
from collections.abc import AsyncGenerator, Iterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api.v1.routes.studio import product_card as product_card_route
from app.dependencies import get_db
from app.main import app
from app.models.studio import FileItem, Product, ProductCard, Project
from app.schemas.studio.product_card import EDITABLE_CARD_FIELDS
from app.services.studio import product_extraction as extraction
from app.services.studio.llm_orchestration.client import TextLLMTarget
from tests.llm_orchestration_fixtures import make_recording_stub_caller

PROJECT_ID = "proj-ad"
PRODUCT_ID = "prod-1"
EXTRACT_URL = f"/api/v1/studio/projects/{PROJECT_ID}/product-card/extract"

TXT_FILE_ID = "file-txt"
DOCX_FILE_ID = "file-docx"
IMAGE_FILE_ID = "file-image"

TXT_BODY = "商品名：凝时紧致精华\n核心卖点：三秒吸收，不黏腻"
DOCX_PARAGRAPHS = ["商品资料", "品牌：凝时", "目标人群：通勤女性"]
SOURCE_TEXT = f"{TXT_BODY}\n\n" + "\n".join(DOCX_PARAGRAPHS)

DOCX_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


# ---------------------------------------------------------------------------
# 脚手架（内存库 + 建表 + 种子；与 test_drama_plan_flow.py 同一套做法）
# ---------------------------------------------------------------------------


async def _build_harness_async() -> tuple[async_sessionmaker[AsyncSession], Any]:
    """内存库 + 建表（``:memory:`` 用 StaticPool，多个会话看到同一份数据）。"""
    from app.core.db import Base
    import app.models.studio  # noqa: F401 - 导入即注册全部表

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return factory, engine


@asynccontextmanager
async def _harness() -> AsyncGenerator[async_sessionmaker[AsyncSession], None]:
    """内存库上下文（结束即释放引擎；不残留任何连接）。"""
    factory, engine = await _build_harness_async()
    try:
        yield factory
    finally:
        await engine.dispose()


async def _seed_async(
    factory: async_sessionmaker[AsyncSession],
    *,
    with_product: bool = False,
    card_fields: dict[str, Any] | None = None,
    files: list[dict[str, Any]] | None = None,
) -> None:
    """写入最小项目结构（+ 可选商品资产 / 已有商品卡 / 素材行）。"""
    async with factory() as db:
        db.add(Project(id=PROJECT_ID, name="剧情广告项目", description="", style="真人都市", visual_style="现实"))
        await db.flush()
        if with_product:
            db.add(
                Product(
                    id=PRODUCT_ID,
                    name="凝时紧致精华",
                    description="白色磨砂瓶身，金色压泵，主打三秒吸收",
                    style="真人都市",
                )
            )
        if card_fields is not None:
            db.add(ProductCard(project_id=PROJECT_ID, **card_fields))
        for item in files or []:
            db.add(FileItem(**item))
        await db.commit()


def _seed(factory: async_sessionmaker[AsyncSession], **kwargs: Any) -> None:
    asyncio.run(_seed_async(factory, **kwargs))


async def _card_rows(factory: async_sessionmaker[AsyncSession]) -> list[ProductCard]:
    """读商品卡行（用于断言"提取不落库"）。"""
    async with factory() as db:
        return list((await db.execute(select(ProductCard))).scalars().all())


def build_docx(paragraphs: list[str]) -> bytes:
    """用标准库造一个最小 DOCX（不引入任何依赖）。"""
    body = "".join(f'<w:p><w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>' for text in paragraphs)
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{DOCX_NS}"><w:body>{body}</w:body></w:document>'
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types/>')
        archive.writestr("word/document.xml", document)
    return buffer.getvalue()


async def _boom(*_args: Any, **_kwargs: Any) -> Any:
    """被调用就炸的替身：用来证明"这条路径上确实没有发生真实调用"。"""
    raise AssertionError("不应发生真实模型调用 / 文件读取")


# ---------------------------------------------------------------------------
# 1) paste：脏输出解析 + 字段归一 + 缺项
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_paste_extraction_parses_dirty_json_and_normalizes_fields() -> None:
    """Markdown 围栏 + 尾随逗号 + 字符串列表混写：都要解析成功并归一。"""
    # 刻意写成"脏输出"：Markdown 围栏 + 尾随逗号（触发 json_utils 的抢救，并如实记一条 warning）
    dirty = (
        "```json\n"
        "{\n"
        '  "name": " 凝时紧致精华 ",\n'
        '  "category": "护肤",\n'
        '  "selling_points": ["三秒吸收", "不黏腻"],\n'
        '  "audience": "通勤女性",\n'
        '  "scenarios": "通勤, 加班",\n'
        '  "priceInfo": "199 元 / 30ml",\n'
        "}\n"
        "```"
    )

    caller, prompts = make_recording_stub_caller(dirty)
    async with _harness() as factory:
        await _seed_async(factory)
        async with factory() as db:
            result = await extraction.extract_product_card(
                db,
                project_id=PROJECT_ID,
                source_type="paste",
                text="凝时紧致精华：三秒吸收，199 元，给通勤女性用。",
                llm_caller=caller,
            )

    fields = result["fields"]
    assert fields["name"] == "凝时紧致精华"  # 首尾空白已归一
    assert fields["category"] == "护肤"
    assert fields["selling_points"] == ["三秒吸收", "不黏腻"]
    assert fields["audience"] == "通勤女性"
    # 逗号串 → 列表（coerce_str_list）
    assert fields["scenarios"] == ["通勤", "加班"]
    # camelCase 别名 priceInfo → price_info
    assert fields["price_info"] == "199 元 / 30ml"
    # 模型没给的字段一律留空，绝不编造
    assert fields["brand"] == ""
    assert fields["compliance"] == ""
    assert fields["notes"] == ""
    assert any("JSON 抢救" in warn for warn in result["warnings"])

    # source_summary：契约要求的技术详情（原文字数 / 提取时间 / 使用的模型 / 是否真的调了模型）
    summary = result["source_summary"]
    assert summary["source_type"] == "paste"
    assert summary["llm_called"] is True
    assert summary["raw_chars"] == len("凝时紧致精华：三秒吸收，199 元，给通勤女性用。")
    assert summary["raw_output_chars"] > 0
    assert summary["extracted_at"]
    assert summary["model"] is None  # 注入替身没有目标配置；真实调用时是 target.public()
    assert "api_key" not in json.dumps(summary, ensure_ascii=False)

    # 提示词：只输出 JSON + 缺就留空 + 不准编造 + 带上原文
    assert "一个合法 JSON 对象" in prompts[0]
    assert "禁止猜测" in prompts[0]
    assert "凝时紧致精华" in prompts[0]
    for key in extraction.EXTRACTABLE_CARD_FIELDS:
        assert key in prompts[0], f"提示词里应列出字段 {key}"


@pytest.mark.asyncio
async def test_missing_fields_become_todo_with_chinese_labels() -> None:
    """模型只给得出名称 → 其余字段进 missing_fields / missing_labels（页面显示「待补充」）。"""
    caller, _ = make_recording_stub_caller({"name": "真空保温杯", "category": "", "selling_points": []})
    async with _harness() as factory:
        await _seed_async(factory)
        async with factory() as db:
            result = await extraction.extract_product_card(
                db,
                project_id=PROJECT_ID,
                source_type="paste",
                text="真空保温杯，24 小时保温。",
                llm_caller=caller,
            )

    assert result["fields"]["name"] == "真空保温杯"
    for key in ("category", "brand", "selling_points", "audience", "scenarios", "price_info", "compliance", "notes"):
        assert key in result["missing_fields"], f"{key} 为空就必须标「待补充」"
    assert "品类" in result["missing_labels"]
    assert "核心卖点" in result["missing_labels"]
    # 可提取字段集合严格来自 EDITABLE_CARD_FIELDS（去掉 confirmed / reference_files 有明确理由）
    assert set(extraction.EXTRACTABLE_CARD_FIELDS) == set(EDITABLE_CARD_FIELDS) - {"confirmed", "reference_files"}
    assert "confirmed" not in extraction.EXTRACTABLE_CARD_FIELDS


@pytest.mark.asyncio
async def test_missing_is_computed_against_existing_card() -> None:
    """缺项口径：把本次字段叠加到**当前商品卡**上再算（与 apply_extraction 同一口径）。

    这样响应里的 missing_fields 就等于"按这份结果保存后卡里还缺什么"，
    不会把用户之前已经填好的字段重新标成「待补充」。
    """
    caller, _ = make_recording_stub_caller({"category": "护肤"})
    async with _harness() as factory:
        await _seed_async(factory, card_fields={"name": "之前填好的名称"})
        async with factory() as db:
            result = await extraction.extract_product_card(
                db,
                project_id=PROJECT_ID,
                source_type="paste",
                text="只说了这是个护肤品。",
                llm_caller=caller,
            )

    assert result["fields"]["name"] == ""  # 本次没提取到名称
    assert "name" not in result["missing_fields"]  # 但卡里已经有 → 不算缺
    assert "brand" in result["missing_fields"]


# ---------------------------------------------------------------------------
# 2) 演练模式：不调模型、不编造
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dry_run_never_calls_model_and_fabricates_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(extraction, "call_text_llm", _boom)
    async with _harness() as factory:
        await _seed_async(factory)
        async with factory() as db:
            result = await extraction.extract_product_card(
                db,
                project_id=PROJECT_ID,
                source_type="paste",
                text="凝时紧致精华：三秒吸收，199 元。",
            )

    # 一个字段都没提取（也没有编造）
    for key in extraction.EXTRACTABLE_CARD_FIELDS:
        assert result["fields"][key] in ("", []), f"演练模式不得返回任何 {key} 内容"
    assert result["fields"]["reference_files"] == []
    # 如实说明：source_summary + note + warning 三处都要说清"未调用模型"
    summary = result["source_summary"]
    assert summary["llm_called"] is False
    assert summary["dry_run"] is True
    assert summary["extraction_status"] == "dry_run_not_called"
    assert summary["fields_extracted"] == []
    assert "演练模式" in result["note"] and "没有调用任何大模型" in result["note"]
    assert any("DRY_RUN" in warn for warn in result["warnings"])
    # 全字段待补充（名称也缺）→ 页面能直接显示
    assert "name" in result["missing_fields"]


# ---------------------------------------------------------------------------
# 3) existing：确定性映射，不调模型
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_existing_source_maps_name_and_description_without_model() -> None:
    caller, prompts = make_recording_stub_caller({"name": "不该出现的模型内容"})
    async with _harness() as factory:
        await _seed_async(factory, with_product=True)
        async with factory() as db:
            result = await extraction.extract_product_card(
                db,
                project_id=PROJECT_ID,
                source_type="existing",
                existing_product_id=PRODUCT_ID,
                llm_caller=caller,
            )

    assert prompts == []  # 一次模型调用都没有
    assert result["fields"]["name"] == "凝时紧致精华"
    assert result["fields"]["notes"] == "白色磨砂瓶身，金色压泵，主打三秒吸收"
    assert "不该出现的模型内容" not in json.dumps(result, ensure_ascii=False)
    summary = result["source_summary"]
    assert summary["llm_called"] is False
    assert summary["extraction_status"] == "existing_mapped_not_called"
    assert summary["existing_product_id"] == PRODUCT_ID
    assert summary["existing_description_mapped_to"] == "notes"
    # 其余字段留空 → 待补充
    assert "category" in result["missing_fields"] and "核心卖点" in result["missing_labels"]


@pytest.mark.asyncio
async def test_existing_product_not_found_is_404() -> None:
    async with _harness() as factory:
        await _seed_async(factory)
        async with factory() as db:
            with pytest.raises(HTTPException) as exc_info:
                await extraction.extract_product_card(
                    db,
                    project_id=PROJECT_ID,
                    source_type="existing",
                    existing_product_id="prod-missing",
                )
    assert exc_info.value.status_code == 404
    assert exc_info.value.detail["code"] == "product_card_existing_not_found"


# ---------------------------------------------------------------------------
# 4) upload：TXT / DOCX 抽正文；图片只归档；没有文字时不调模型
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_upload_extracts_txt_and_docx_text(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """TXT 与 DOCX 都要落成文本进提示词（DOCX 走标准库解析，与 /documents/parse 同一套）。"""
    docx_file = tmp_path / "商品资料.docx"
    docx_file.write_bytes(build_docx(DOCX_PARAGRAPHS))
    payloads = {
        "files/goods.txt": TXT_BODY.encode("utf-8"),
        "files/goods.docx": docx_file.read_bytes(),
    }

    async def _fake_read(*, storage_key: str) -> bytes:
        return payloads[storage_key]

    monkeypatch.setattr(extraction, "read_reference_bytes", _fake_read)
    caller, prompts = make_recording_stub_caller({"name": "凝时紧致精华", "brand": "凝时", "audience": "通勤女性"})

    async with _harness() as factory:
        await _seed_async(
            factory,
            files=[
                {"id": TXT_FILE_ID, "type": "document", "name": "商品资料.txt", "storage_key": "files/goods.txt"},
                {"id": DOCX_FILE_ID, "type": "document", "name": "商品资料.docx", "storage_key": "files/goods.docx"},
            ],
        )
        async with factory() as db:
            result = await extraction.extract_product_card(
                db,
                project_id=PROJECT_ID,
                source_type="upload",
                file_ids=[TXT_FILE_ID, DOCX_FILE_ID],
                llm_caller=caller,
            )

    assert prompts, "有文字就必须走提取提示词"
    for fragment in ("商品名：凝时紧致精华", *DOCX_PARAGRAPHS):
        assert fragment in prompts[0], f"上传文件里的正文应进提示词：{fragment}"
    summary = result["source_summary"]
    assert summary["llm_called"] is True
    assert summary["raw_chars"] == len(SOURCE_TEXT)
    usage = {item["file_id"]: item["usage"] for item in summary["source_files"]}
    assert usage[TXT_FILE_ID] == "text_extracted"
    assert usage[DOCX_FILE_ID] == "text_extracted"
    assert result["fields"]["name"] == "凝时紧致精华"
    # 已解析的文本文件也登记进 reference_files：用户传进来的东西不会凭空消失
    assert {item["file_id"] for item in result["fields"]["reference_files"]} == {TXT_FILE_ID, DOCX_FILE_ID}
    assert all(item["kind"] == "document" for item in result["fields"]["reference_files"])


@pytest.mark.asyncio
async def test_upload_image_is_archived_with_honest_warning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """图片：不许装识图。只归档为参考图 + 如实告警，且**一次模型调用都不发生**。"""
    monkeypatch.setattr(extraction, "call_text_llm", _boom)  # 没有文字就不该调模型
    monkeypatch.setattr(extraction, "read_reference_bytes", _boom)  # 图片也不该被读字节

    async with _harness() as factory:
        await _seed_async(
            factory,
            files=[
                {"id": IMAGE_FILE_ID, "type": "image", "name": "商品主图.png", "storage_key": "files/main.png"},
            ],
        )
        async with factory() as db:
            result = await extraction.extract_product_card(
                db,
                project_id=PROJECT_ID,
                source_type="upload",
                file_ids=[IMAGE_FILE_ID],
            )

    assert result["fields"]["reference_files"] == [
        {"file_id": IMAGE_FILE_ID, "name": "商品主图.png", "kind": "image"}
    ]
    image_warnings = [warn for warn in result["warnings"] if "商品主图.png" in warn]
    assert image_warnings, "图片必须留下一条能看懂的告警"
    assert "不识图" in image_warnings[0]
    assert "已归档为商品参考图" in image_warnings[0]
    assert "TXT / DOCX" in image_warnings[0]
    summary = result["source_summary"]
    assert summary["llm_called"] is False
    assert summary["extraction_status"] == "no_text_source_not_called"
    assert "未调用模型" in result["note"]
    # 归档的参考图不算缺项
    assert "reference_files" not in result["missing_fields"]


@pytest.mark.asyncio
async def test_upload_supported_file_types_and_empty_file_ids() -> None:
    """边界：没传文件 ID → 400；`.doc` 旧格式 → 如实告警而不是静默失败。"""
    async with _harness() as factory:
        await _seed_async(
            factory,
            files=[{"id": "file-doc", "type": "document", "name": "老资料.doc", "storage_key": "files/old.doc"}],
        )
        async with factory() as db:
            with pytest.raises(HTTPException) as empty_exc:
                await extraction.extract_product_card(
                    db, project_id=PROJECT_ID, source_type="upload", file_ids=[]
                )
            assert empty_exc.value.status_code == 400

            result = await extraction.extract_product_card(
                db, project_id=PROJECT_ID, source_type="upload", file_ids=["file-doc", "file-unknown"]
            )

    assert any("老资料.doc" in warn for warn in result["warnings"])
    assert any("file-unknown" in warn for warn in result["warnings"])
    assert result["source_summary"]["llm_called"] is False
    # 两种文件都留下痕迹（登记为参考资料），不静默丢弃
    assert {item["file_id"] for item in result["fields"]["reference_files"]} == {"file-doc"}


# ---------------------------------------------------------------------------
# 5) 失败路径与输入校验
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bad_json_raises_structured_422() -> None:
    caller, _ = make_recording_stub_caller("这不是 JSON，模型跑偏了")
    async with _harness() as factory:
        await _seed_async(factory)
        async with factory() as db:
            with pytest.raises(HTTPException) as exc_info:
                await extraction.extract_product_card(
                    db,
                    project_id=PROJECT_ID,
                    source_type="paste",
                    text="随便一段商品文案。",
                    llm_caller=caller,
                )

    assert exc_info.value.status_code == 422
    detail = exc_info.value.detail
    assert detail["code"] == "llm_json_parse_failed"
    assert detail["raw_output_chars"] > 0
    assert "这不是 JSON" in detail["raw_output_preview"]


@pytest.mark.asyncio
async def test_manual_and_empty_paste_and_unknown_project_are_rejected() -> None:
    async with _harness() as factory:
        await _seed_async(factory)
        async with factory() as db:
            with pytest.raises(HTTPException) as manual_exc:
                await extraction.extract_product_card(db, project_id=PROJECT_ID, source_type="manual")
            assert manual_exc.value.status_code == 400
            assert manual_exc.value.detail["code"] == "product_card_manual_needs_no_extraction"

            with pytest.raises(HTTPException) as paste_exc:
                await extraction.extract_product_card(db, project_id=PROJECT_ID, source_type="paste", text="   ")
            assert paste_exc.value.status_code == 400
            assert paste_exc.value.detail["code"] == "product_card_paste_empty"

            with pytest.raises(HTTPException) as project_exc:
                await extraction.extract_product_card(db, project_id="proj-nope", source_type="paste", text="x")
            assert project_exc.value.status_code == 404


# ---------------------------------------------------------------------------
# 6) 不落库（服务的核心纪律）
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_extraction_does_not_write_card_rows() -> None:
    """提取成功也不得写库：契约要求"不落库、不生成剧情，由用户确认后走 PUT"。"""
    caller, _ = make_recording_stub_caller({"name": "凝时紧致精华", "category": "护肤"})
    async with _harness() as factory:
        await _seed_async(factory)
        assert await _card_rows(factory) == []

        async with factory() as db:
            result = await extraction.extract_product_card(
                db,
                project_id=PROJECT_ID,
                source_type="paste",
                text="凝时紧致精华，护肤品。",
                llm_caller=caller,
            )
            # 服务内部连 flush 都没有：即使同会话再查也是 0 行
            assert (await db.execute(select(ProductCard))).scalars().all() == []

        assert result["fields"]["name"] == "凝时紧致精华"
        assert await _card_rows(factory) == []


# ---------------------------------------------------------------------------
# 7) 路由层：接好了、演练模式如实返回、坏 JSON → 422 信封、同样不落库
# ---------------------------------------------------------------------------


@pytest.fixture()
def routed_client() -> Iterator[tuple[TestClient, async_sessionmaker[AsyncSession]]]:
    """把路由的 get_db 换成内存库（不碰任何真实库），并保证演练模式。"""
    factory, engine = asyncio.run(_build_harness_async())
    _seed(factory)

    async def override_db() -> AsyncGenerator[AsyncSession, None]:
        async with factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = override_db
    try:
        # 不用 with（不触发 lifespan 启动逻辑）：路由层的 get_db 已被换成内存库，请求只在内存库里跑。
        yield TestClient(app), factory
    finally:
        app.dependency_overrides.clear()
        asyncio.run(engine.dispose())


def test_route_extract_is_wired_and_dry_run_writes_nothing(
    routed_client: tuple[TestClient, async_sessionmaker[AsyncSession]],
) -> None:
    client, factory = routed_client
    response = client.post(
        EXTRACT_URL,
        json={"source_type": "paste", "text": "凝时紧致精华：三秒吸收。"},
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["fields"]["name"] == ""
    assert data["source_summary"]["llm_called"] is False
    assert data["source_summary"]["extraction_status"] == "dry_run_not_called"
    assert "演练模式" in data["note"]
    assert data["warnings"], "演练模式必须如实说明未调用模型"

    assert asyncio.run(_card_rows(factory)) == []


def test_route_extract_bad_json_returns_422_envelope(
    routed_client: tuple[TestClient, async_sessionmaker[AsyncSession]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """真实路径（关掉演练 + 注入不触网的替身）下坏 JSON 必须回 422 结构化错误。"""
    stub_target = TextLLMTarget(
        provider_id="provider-stub",
        provider_name="Stub",
        model_id="model-stub",
        model_name="stub-model",
        base_url="https://dry-run.invalid/v1",
        timeout_seconds=5,
    )

    async def _fake_resolve(_db: AsyncSession) -> TextLLMTarget:
        return stub_target

    async def _fake_call(_prompt: str, *, target: TextLLMTarget, **_kwargs: Any) -> Any:
        assert target.model_name == "stub-model"

        class _Completion:
            text = "模型跑偏了，这不是 JSON"
            latency_ms = 3

        return _Completion()

    monkeypatch.setattr(extraction, "resolve_text_llm_target", _fake_resolve)
    monkeypatch.setattr(extraction, "call_text_llm", _fake_call)
    monkeypatch.setattr(extraction.dry_run, "dry_run_enabled", lambda: False)

    client, factory = routed_client
    response = client.post(
        EXTRACT_URL,
        json={"source_type": "paste", "text": "凝时紧致精华：三秒吸收。"},
    )

    assert response.status_code == 422, response.text
    body = response.json()
    assert body["meta"]["error"]["code"] == "llm_json_parse_failed"
    assert body["meta"]["error"]["raw_output_chars"] > 0
    assert asyncio.run(_card_rows(factory)) == []


def test_route_extract_with_stubbed_caller_returns_fields_without_persisting(
    routed_client: tuple[TestClient, async_sessionmaker[AsyncSession]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """端到端（不触网）：字段返回给页面，但商品卡一行都不落。"""
    caller, _prompts = make_recording_stub_caller(
        {
            "name": "凝时紧致精华",
            "category": "护肤",
            "brand": "凝时",
            "selling_points": ["三秒吸收"],
            "audience": "通勤女性",
        }
    )

    original = extraction.extract_product_card

    async def _patched(db: AsyncSession, **kwargs: Any) -> dict[str, Any]:
        return await original(db, **{**kwargs, "llm_caller": caller})

    # 路由不注入 caller（生产路径也不注入），这里把 caller 接进去
    # （等价于"真实路径 + 不触网替身"）。路由在函数体内懒加载本模块并取属性，
    # 所以替换模块属性即可生效。
    monkeypatch.setattr(extraction, "extract_product_card", _patched)

    client, factory = routed_client
    response = client.post(
        EXTRACT_URL,
        json={"source_type": "paste", "text": "凝时紧致精华：三秒吸收，给通勤女性用。"},
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["fields"]["name"] == "凝时紧致精华"
    assert data["fields"]["selling_points"] == ["三秒吸收"]
    assert data["source_summary"]["llm_called"] is True
    assert "brand" not in data["missing_fields"]
    assert "price_info" in data["missing_fields"]
    assert asyncio.run(_card_rows(factory)) == []


def test_extract_endpoint_is_registered_once_with_paid_outlet_doc() -> None:
    """结构性保证：extract 只注册一次（路径参数占位），且源码里明确它是付费出口。"""
    suffix = "/product-card/extract"
    paths = [route.path for route in app.routes if getattr(route, "path", "").endswith(suffix)]
    assert paths == [f"/api/v1/studio/projects/{{project_id}}{suffix}"], paths
    source = Path(product_card_route.__file__).read_text(encoding="utf-8")
    assert "付费出口" in source
    assert "ProductCardExtractRead" in source
