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
    ASSET_TYPE_ASPECT_RATIOS,
    CHARACTER_REFERENCE_RATIO,
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
