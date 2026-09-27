"""一个资产只能被装成**一个** target —— 同一资产在关联表里有多行时，不许变成两次上游提交。

实测背景（2026-09-27）：`scene` 的计划里出现了**两条完全相同的 target**（同一资产 + 同一幂等键），
页面点一次生成会发两次 create、结果区出现两条相同项。

根因**不是脏数据**：关联表的语义是「项目-章节-镜头-资产」，同一个场景**本来就会有多行**
（实测：id=224 是章节级 `shot_id=NULL`，id=227 是镜头级 `shot_id=e76f2246…`，两行都合法）。
问题在取数：`_load_asset_rows` 对 scene/prop/costume 都 `join` 了这张关联表却**没有 distinct()**，
于是"多行关联"被当成"多个资产"。修复是给三条 join 加 `.distinct()`。

真实上游按 `source_task_id` 幂等去重，所以没有重复计费；**但换一个不去重的上游就是双倍计费**。

为什么用源码守卫而不是行为用例：这三条查询的差别只有 `distinct()` 一个词，而行为用例要造出
"重复关联行"需要写很多与本缺陷无关的必填字段（试过，字段不全直接 IntegrityError），
信噪比太差；源码守卫能直接、稳定地钉住"三条 join 查询都必须去重"这条规则。
"""

from __future__ import annotations


from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "app/services/studio/image_pipeline/image_pipeline.py"


def _load_asset_rows_body() -> str:
    text = SOURCE.read_text(encoding="utf-8")
    start = text.index("async def _load_asset_rows(")
    end = text.index("async def build_targets(", start)
    return text[start:end]


def test_three_join_queries_all_dedupe() -> None:
    body = _load_asset_rows_body()
    # 场景 / 道具 / 服装 都是 join 项目关联表取资产，三条都必须 distinct
    for asset_type, join_model in (
        ("scene", "ProjectSceneLink"),
        ("prop", "ProjectPropLink"),
        ("costume", "ProjectCostumeLink"),
    ):
        assert join_model in body, f"{asset_type} 的取数分支不见了"
    assert body.count(".distinct()") >= 3, (
        "场景/道具/服装三条 join 查询必须都带 distinct()：关联表里的重复行会把同一个资产"
        f"装成两个 target（实测发生过）。当前 distinct 次数={body.count('.distinct()')}"
    )


def test_distinct_sits_inside_each_join_branch() -> None:
    """distinct 必须落在三条 join 分支里，而不是随便加在某处。"""
    body = _load_asset_rows_body()
    for join_model in ("ProjectSceneLink", "ProjectPropLink", "ProjectCostumeLink"):
        # 取该 join 出现处之后的一小段，确认同一分支里有 distinct()
        idx = body.index(join_model)
        window = body[idx : idx + 700]
        assert ".distinct()" in window, f"{join_model} 所在分支缺少 distinct()"


def test_character_branch_is_untouched() -> None:
    """人物不 join 关联表（按 project_id 直接取），不应被这次修复改动。"""
    body = _load_asset_rows_body()
    idx = body.index("if asset_type ==")
    window = body[idx : idx + 200]
    assert "Character" in window
    assert "distinct()" not in window
