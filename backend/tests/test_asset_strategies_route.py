"""「按资产类型下发的出图口径」读口测试（需求清单第 2 条第 3 项）。

为什么需要这个读口（以及为什么必须测它）
=====================================

「人物 16:9 / 场景 16:9 / 道具 1:1」的真实口径只允许有一处实现：
``asset_strategies.ASSET_TYPE_ASPECT_RATIOS``（人物的 16:9 还额外是**写死**的）。
提交出图时由 ``resolve_aspect_ratio`` 按同一张表解析。

页面（第 2 步卡片与详情抽屉、分镜工作室左栏素材卡）如果自己再写一份比例表，
就会出现「卡片上写 1:1、实际请求发 16:9」这种用户无法察觉的漂移 —— 本测试正是钉住这一点：

1. 读口下发的 ``ratio_map`` 与出图管线用的那张表**逐值相同**（不是拷贝一份手写常量）；
2. 人物的比例是**写死**的（``aspect_ratio_fixed=True``），显式传入别的值也不会被采纳；
3. 服装**没有**本清单给出的比例口径（不出现在 ``ratio_map`` 里），不许替它套人物/场景比例；
4. **商品不参与自动出图**（``auto_generate=False``），页面据此不给生成按钮；
5. 纯读：不写库、不触网、不产生任何付费调用。
"""

from __future__ import annotations

from typing import Any

import pytest

from app.services.studio.image_pipeline import asset_strategies
from app.services.studio.image_pipeline.asset_strategies import (
    ASSET_ASPECT_RATIO_ALLOWED,
    ASSET_TYPE_ASPECT_RATIOS,
    CHARACTER_REFERENCE_RATIO,
    AssetAspectRatioRejected,
    resolve_aspect_ratio,
)

URL = "/api/v1/studio/image-pipeline/asset-strategies"


def test_ratio_map_is_the_same_table_the_submit_path_uses() -> None:
    """读口下发的比例表与出图提交用的表是同一份（防"页面看到的值 ≠ 实际请求的值"）。"""
    # 这条断言看着"同义反复"，但它钉住的是**唯一事实来源**这个结构约束：
    # 一旦有人把读口改成自己写一张表，这条就会和他自己那份对不上。
    assert ASSET_TYPE_ASPECT_RATIOS == {"character": "16:9", "scene": "16:9", "prop": "1:1"}
    assert CHARACTER_REFERENCE_RATIO == "16:9"


def test_character_ratio_is_fixed_and_ignores_explicit_value() -> None:
    """人物的 16:9 是**写死**的：显式传 9:16 也不采纳，并且如实回报被忽略的原值。"""
    resolved = resolve_aspect_ratio("character", "9:16")
    assert resolved.ratio == "16:9"
    assert resolved.source == asset_strategies.RATIO_SOURCE_CHARACTER_FIXED
    assert "9:16" in resolved.warning


def test_scene_and_prop_fall_back_to_their_own_type_default() -> None:
    """场景不传比例 → 16:9（类型默认）；道具不传比例 → 1:1（**不是**共用一个值）。"""
    scene = resolve_aspect_ratio("scene", "")
    prop = resolve_aspect_ratio("prop", "")
    assert (scene.ratio, scene.source) == ("16:9", asset_strategies.RATIO_SOURCE_ASSET_TYPE_DEFAULT)
    assert (prop.ratio, prop.source) == ("1:1", asset_strategies.RATIO_SOURCE_ASSET_TYPE_DEFAULT)


def test_costume_has_no_business_ratio_of_its_own() -> None:
    """服装不在本清单的比例口径里：调用方给了就用，没给就用管线默认，不套用别的类型。"""
    assert "costume" not in ASSET_TYPE_ASPECT_RATIOS
    explicit = resolve_aspect_ratio("costume", "4:3")
    assert (explicit.ratio, explicit.source) == ("4:3", asset_strategies.RATIO_SOURCE_REQUEST)
    fallback = resolve_aspect_ratio("costume", "")
    assert fallback.source == asset_strategies.RATIO_SOURCE_DEFAULT


def test_unknown_asset_type_is_rejected_instead_of_guessing() -> None:
    """不认识的类型明确报错（绝不按人物处理）。"""
    with pytest.raises(ValueError):
        asset_strategies.strategy_for("unknown-type")


def test_asset_strategies_route_shape(client: Any, session_database: Any) -> None:
    """走真实路由：形状正确，且**调用前后库里业务表行数不变**（纯读）。"""
    from tests._prod_db_snapshot import read_row_counts

    db_path = session_database.db_path
    assert db_path is not None, "会话隔离层必须给出临时库路径"

    before, error = read_row_counts(db_path)
    assert not error, f"取不到行数快照：{error}"
    response = client.get(URL)
    after, error = read_row_counts(db_path)
    assert not error, f"取不到行数快照：{error}"

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    by_type = {item["asset_type"]: item for item in data["strategies"]}

    # 五类都在（前四类可自动出图 + 商品不参与）
    assert set(by_type) == {"character", "scene", "prop", "costume", "product"}

    assert by_type["character"]["aspect_ratio"] == "16:9"
    assert by_type["character"]["aspect_ratio_fixed"] is True
    assert by_type["character"]["auto_generate"] is True

    assert by_type["scene"]["aspect_ratio"] == "16:9"
    assert by_type["scene"]["aspect_ratio_fixed"] is False
    assert by_type["prop"]["aspect_ratio"] == "1:1"
    assert by_type["prop"]["aspect_ratio_fixed"] is False

    # 商品：唯一不参与自动出图的类型，并且**没有**画面比例可展示
    assert by_type["product"]["auto_generate"] is False
    assert by_type["product"]["aspect_ratio"] == ""
    assert "不参与自动出图" in by_type["product"]["aspect_ratio_note"]

    # 比例表与出图管线同源
    assert data["ratio_map"] == dict(ASSET_TYPE_ASPECT_RATIOS)
    # 服装不在比例表里（不替它拍板）
    assert "costume" not in data["ratio_map"]

    assert before == after, "这个端点必须是纯读：库里的业务表行数不许变化"


def test_asset_strategies_route_does_not_call_any_paid_outlet(client: Any, session_database: Any) -> None:
    """只读端点不触发任何出图出站（演练模式下的守卫审计没有任何记录）。"""
    from app.services.studio.llm_orchestration import dry_run

    dry_run.clear_audit_log()
    response = client.get(URL)
    assert response.status_code == 200, response.text
    assert dry_run.audit_log() == [], "只读口径端点不该产生任何出站调用记录"


# ---------------------------------------------------------------------------
# 画幅白名单：调用方传入的比例必须落在允许集合内，否则**明确拒绝**（422），
# 既不静默忽略、也不穿透给上游（需求清单第 2 条："后端必须校验"）。
# ---------------------------------------------------------------------------


def test_aspect_ratio_whitelist_covers_the_required_set() -> None:
    """白名单至少覆盖任务书点名的五个比例，且不含图片侧没有任何通道声明支持的 21:9。"""
    assert set(ASSET_ASPECT_RATIO_ALLOWED) == {"16:9", "9:16", "1:1", "4:3", "3:4"}
    assert "21:9" not in ASSET_ASPECT_RATIO_ALLOWED, (
        "21:9 只在视频侧受支持，图片侧两个通道都没有声明支持；放行它只会换来上游 4xx"
    )
    # 上游 APIMart 图片通道实测支持的三者必须在集合内（不能让自有白名单比通道更窄）
    from app.core.integrations.apimart import images as apimart_images

    assert set(apimart_images.SUPPORTED_RATIOS) <= set(ASSET_ASPECT_RATIO_ALLOWED)


@pytest.mark.parametrize("asset_type", ["scene", "prop", "costume"])
@pytest.mark.parametrize("ratio", ["16:9", "9:16", "1:1", "4:3", "3:4"])
def test_allowed_ratios_pass_for_every_non_character_type(asset_type: str, ratio: str) -> None:
    """场景 / 道具 / 服装：白名单内的比例一律放行，并如实回报来源是「调用方传入」。"""
    resolved = resolve_aspect_ratio(asset_type, ratio)
    assert resolved.ratio == ratio
    assert resolved.source == asset_strategies.RATIO_SOURCE_REQUEST


@pytest.mark.parametrize("asset_type", ["scene", "prop", "costume"])
@pytest.mark.parametrize("ratio", ["7:3", "abc", "1:1; DROP", "169", "0:0", "16：9"])
def test_disallowed_ratios_are_rejected_with_a_chinese_message(asset_type: str, ratio: str) -> None:
    """非法比例必须**抛错**（不是静默忽略）：中文说明里要列出支持的比例。"""
    with pytest.raises(AssetAspectRatioRejected) as excinfo:
        resolve_aspect_ratio(asset_type, ratio)
    message = str(excinfo.value)
    assert "不在支持的范围内" in message
    for allowed in ASSET_ASPECT_RATIO_ALLOWED:
        assert allowed in message, f"错误说明里没有列出支持的比例 {allowed}"


def test_character_ratio_is_still_fixed_even_when_a_disallowed_value_is_passed() -> None:
    """人物：传非法值**仍然**固定 16:9（写死口径不变），并如实回报被忽略的原值。"""
    resolved = resolve_aspect_ratio("character", "7:3")
    assert resolved.ratio == CHARACTER_REFERENCE_RATIO == "16:9"
    assert resolved.source == asset_strategies.RATIO_SOURCE_CHARACTER_FIXED
    assert "7:3" in resolved.warning


def test_surrounding_whitespace_is_tolerated_not_treated_as_an_invalid_value() -> None:
    """前后空白是**输入噪声**，不是非法比例：`" 16:9 "` 按 16:9 处理（既有 strip 口径）。"""
    assert resolve_aspect_ratio("scene", " 16:9 ").ratio == "16:9"


def test_blank_ratio_still_falls_back_to_the_type_default() -> None:
    """不传比例是**正常**路径（用类型默认），不属于"非法值"，不许被白名单拦掉。"""
    assert resolve_aspect_ratio("scene", "").ratio == "16:9"
    assert resolve_aspect_ratio("prop", "").ratio == "1:1"
    assert resolve_aspect_ratio("costume", "   ").source == asset_strategies.RATIO_SOURCE_DEFAULT


def test_whitelist_route_returns_422_with_structured_detail(client: Any, session_database: Any) -> None:
    """走真实路由：非法画幅 → 422 + 结构化中文说明（含支持列表），而不是穿透给上游。"""
    import asyncio as _asyncio

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

    from app.models.studio import Chapter, Project, Shot

    project_id = "proj-ratio-check"
    chapter_id = f"{project_id}::EP01"

    async def _seed() -> None:
        engine = create_async_engine(str(session_database.url), future=True)
        maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        async with maker() as db:
            if await db.get(Project, project_id) is None:
                db.add(Project(id=project_id, name="画幅校验用例", description="", style="真人都市", visual_style="现实"))
                await db.flush()
                db.add(
                    Chapter(
                        id=chapter_id,
                        project_id=project_id,
                        index=1,
                        title="第一集",
                        raw_text="文本",
                        condensed_text="文本",
                    )
                )
                db.add(Shot(id="ratio-shot-1", chapter_id=chapter_id, index=1, title="镜头一", status="ready"))
                await db.commit()
        await engine.dispose()

    _asyncio.run(_seed())

    # 非法画幅：422 + 结构化说明
    response = client.post(
        "/api/v1/studio/image-pipeline/plan/preview",
        json={
            "project_id": project_id,
            "asset_type": "prop",
            "stage": "character_sheet",
            "aspect_ratio": "7:3",
        },
    )
    assert response.status_code == 422, response.text
    body = response.json()
    assert body["code"] == 422
    error = (body.get("meta") or {}).get("error") or {}
    assert error.get("code") == "aspect_ratio_not_allowed"
    assert "不在支持的范围内" in str(error.get("message") or "")
    assert set(error.get("supported_aspect_ratios") or []) == set(ASSET_ASPECT_RATIO_ALLOWED)

    # 合法画幅：不因为这一项而被拒（后续按业务规则判定，与本次校验无关）
    ok = client.post(
        "/api/v1/studio/image-pipeline/plan/preview",
        json={
            "project_id": project_id,
            "asset_type": "prop",
            "stage": "character_sheet",
            "aspect_ratio": "1:1",
        },
    )
    assert ok.status_code != 422, ok.text
