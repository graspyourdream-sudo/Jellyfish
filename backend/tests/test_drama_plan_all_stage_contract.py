"""「一次生成完整策划」（`stage="all"`）的字段契约与三层连贯性（确定性，不调模型）。

为什么会单独有这个文件：真机验收里 `stage="all"` 返回了 6 个分镜、人物场景商品齐全，
**但 `one_liner` 与 `story` 全空** —— 因为那条路径用的是旧的 `DRAMA_PLAN_TEMPLATE`，
那份模板压根没要求这两层。页面看不出问题、草稿却不完整，最后会把"没有故事的方案"
落成一串镜头。所以这里钉住三件事：

1. 一次响应必须同时产出**一句话 / 完整剧情（六个字段）/ 分镜**三层；
2. 三层必须引用**同一个故事、同一个商品**（人物名、商品名、顺序都对得上）；
3. 缺任何一层都不算生成完成（生成侧 422、确认侧 409，同一套判据）。

零出网、零付费：模型调用一律用注入的替身；库是内存库。
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models.studio import Chapter, Product, Project, ProjectProductLink, Shot
from app.schemas.studio.drama_plan import DramaPlanDraft
from app.services.studio import drama_plan_materialize as materialize
from app.services.studio.llm_orchestration import drama_plan as module

PROJECT_ID, CHAPTER_ID = "proj-all", "chap-all"
BRIEF = {
    "product_name": "紧致焕颜精华",
    "selling_points": ["三秒吸收不粘腻"],
    "target_audience": "25-35 岁通勤女性",
    "tone": "一本正经地荒诞",
    "shot_count": 4,
    "director_notes": "不要旁白",
}


def _complete_raw() -> dict[str, Any]:
    """一次调用的**完整**返回（脱敏、结构照抄真实响应）。"""
    return {
        "title": "电梯那一拍",
        "logline": "她在早高峰电梯里被质疑脸垮，掏出精华当场自证",
        "one_liner": "通勤女魔头在电梯里被当众质疑脸垮，她掏出紧致焕颜精华拍在对方文件上自证，三秒吸收不粘腻让全电梯倒戈",
        "audience_emotion": "替她捏一把汗之后被治愈",
        "story": {
            "full_text": (
                "早高峰的写字楼电梯里挤满了人。林小满抱着文件站在角落，实习生忽然指着她的脸："
                "“姐，你气色好像不太行。”\n她没说话，从包里掏出那瓶白色磨砂的紧致焕颜精华，"
                "抹开，又顺手把瓶子按在对方的文件上。\n三秒后，纸面干爽如初。\n"
                "“三秒吸收，不粘腻。”她说。电梯里所有人看着她，忽然都不说话了。"
            ),
            "hook": "实习生当众指着她的脸说气色不行",
            "conflict": "职场里对女性外貌的当众评判",
            "product_usage": "她抹开精华、又把瓶子按在对方文件上自证不粘腻",
            "climax": "文件上一点印子都没有，全电梯的人集体改口",
            "cta": "到站时三个同事默默加了她的微信问链接",
        },
        "characters": [
            {"name": "林小满", "relation": "被当众质疑的主角", "profile": {"identity": "通勤女魔头"}},
            {"name": "实习生", "relation": "当众质疑她的人", "profile": {"identity": "实习生"}},
        ],
        "scenes": [{"name": "早高峰写字楼电梯", "profile": {"spatial_structure": "狭小密闭"}}],
        "product": {
            "name": "紧致焕颜精华",
            "description": "白色磨砂瓶身，按压泵头",
            "profile": {"package": "白色磨砂瓶身", "selling_points": "三秒吸收不粘腻"},
        },
        "shots": [
            {
                "index": 1, "title": "电梯门开，文件拍脸", "characters": ["林小满", "实习生"],
                "script_excerpt": "实习生忽然指着她的脸", "description": "电梯内中景",
                "duration": 5, "camera_shot": "MS", "angle": "EYE_LEVEL", "movement": "STATIC",
                "action_beats": ["挤进电梯", "被指脸"],
                "dialogue": [{"speaker": "实习生", "text": "姐，你气色好像不太行。", "mode": "DIALOGUE"}],
                "product_present": True,
            },
            {
                "index": 2, "title": "抹开自证", "characters": ["林小满"],
                "script_excerpt": "从包里掏出那瓶白色磨砂的紧致焕颜精华", "description": "过肩特写",
                "duration": 8, "camera_shot": "CU", "angle": "OVER_SHOULDER", "movement": "DOLLY_IN",
                "action_beats": ["掏瓶", "抹开"],
                "dialogue": [], "product_present": True,
            },
            {
                "index": 3, "title": "按在文件上", "characters": ["林小满", "实习生"],
                "script_excerpt": "把瓶子按在对方的文件上", "description": "极特写",
                "duration": 5, "camera_shot": "ECU", "angle": "HIGH_ANGLE", "movement": "STATIC",
                "action_beats": ["按瓶"], "dialogue": [], "product_present": True,
            },
            {
                "index": 4, "title": "到站加微信", "characters": ["林小满"],
                "script_excerpt": "电梯里所有人看着她，忽然都不说话了", "description": "电梯门外全景",
                "duration": 6, "camera_shot": "MLS", "angle": "EYE_LEVEL", "movement": "PAN",
                "action_beats": ["开门", "加微信"], "dialogue": [], "product_present": False,
            },
        ],
    }


async def _build_async() -> tuple[async_sessionmaker[AsyncSession], Any]:
    from app.core.db import Base
    import app.models.studio  # noqa: F401  （导入即注册进 Base.metadata）

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with factory() as session:
        session.add(Project(id=PROJECT_ID, name="广告项目", description="", style="真人都市", visual_style="现实"))
        await session.flush()
        session.add(Chapter(id=CHAPTER_ID, project_id=PROJECT_ID, index=1, title="第 1 集"))
        await session.commit()
    return factory, engine


def _build_sync() -> tuple[async_sessionmaker[AsyncSession], Any]:
    """同步包装：`asyncio.run` 只能在最外层调一次，测试里不重复进事件循环。"""
    return asyncio.run(_build_async())


def _preview(factory, raw: dict[str, Any]) -> dict[str, Any]:
    async def _run() -> dict[str, Any]:
        async with factory() as session:

            async def caller(_prompt: str) -> str:
                import json
                return json.dumps(raw, ensure_ascii=False)

            return await module.preview_drama_plan(session, chapter_id=CHAPTER_ID, brief=BRIEF, llm_caller=caller)

    return asyncio.run(_run())


# ---------------------------------------------------------------------------
# 1) 三层齐全
# ---------------------------------------------------------------------------


def test_single_call_produces_all_three_layers() -> None:
    factory, engine = _build_sync()
    result = _preview(factory, _complete_raw())
    asyncio.run(engine.dispose())

    plan = DramaPlanDraft.model_validate(result["plan"])
    assert plan.one_liner.strip(), "一次调用必须产出一句话核心创意"
    assert plan.audience_emotion.strip(), "一次调用必须产出目标受众情绪"
    story = plan.story
    for field in ("full_text", "hook", "conflict", "product_usage", "climax", "cta"):
        assert str(getattr(story, field)).strip(), f"完整剧情的 {field} 不能为空"
    assert plan.shots, "一次调用必须产出分镜"
    assert plan.logline.strip(), "logline 由 one_liner 兜底映射，不应为空"


# ---------------------------------------------------------------------------
# 2) 三层引用同一个故事、同一个商品（确定性断言）
# ---------------------------------------------------------------------------


def test_three_layers_reference_same_story_and_product() -> None:
    factory, engine = _build_sync()
    result = _preview(factory, _complete_raw())
    asyncio.run(engine.dispose())
    plan = DramaPlanDraft.model_validate(result["plan"])

    product_name = plan.product.name
    hero = plan.characters[0].name
    selling_point = BRIEF["selling_points"][0]

    # 一句话：必须用上商品卖点（不许只写商品名而没有卖点）
    assert product_name in plan.one_liner, "一句话必须点名商品"
    assert selling_point in plan.one_liner, "一句话必须用上商品卖点"

    # 详细剧情：承接一句话的主角与商品
    full_text = plan.story.full_text
    assert hero in full_text, "完整剧情必须出现一句话里的主角"
    assert product_name in full_text, "完整剧情必须出现同一个商品"
    assert plan.story.product_usage.strip(), "product_usage 必须写明商品如何介入"

    # 分镜：人物只能来自人物表、顺序连续、商品覆盖达标
    character_names = {item.name for item in plan.characters}
    for shot in plan.shots:
        assert set(shot.characters) <= character_names, f"镜头 {shot.index} 出场角色不在人物表里"
        for line in shot.dialogue:
            assert (not line.speaker) or line.speaker in character_names
    assert [shot.index for shot in plan.shots] == list(range(1, len(plan.shots) + 1))
    present = sum(1 for shot in plan.shots if shot.product_present)
    assert present * 2 >= len(plan.shots), "商品至少出现在一半镜头里"

    # 分镜的剧本摘录要能在完整剧情里找到出处（"不另起一套故事"的可判定形式）
    for shot in plan.shots:
        if shot.script_excerpt.strip():
            head = shot.script_excerpt.strip()[:6]
            assert head in full_text, f"镜头 {shot.index} 的摘录在完整剧情里找不到出处"


# ---------------------------------------------------------------------------
# 3) 缺层拦截 + 落库一致性
# ---------------------------------------------------------------------------


def test_missing_story_layer_is_rejected_before_persisting() -> None:
    factory, engine = _build_sync()
    raw = _complete_raw()
    raw.pop("one_liner")
    raw["story"] = {**raw["story"], "full_text": ""}

    async def _run() -> None:
        async with factory() as session:

            async def caller(_prompt: str) -> str:
                import json
                return json.dumps(raw, ensure_ascii=False)

            with pytest.raises(HTTPException) as excinfo:
                await module.preview_drama_plan(session, chapter_id=CHAPTER_ID, brief=BRIEF, llm_caller=caller)
            assert excinfo.value.status_code == 422
            assert excinfo.value.detail["missing_layers"] == ["一句话核心创意", "完整剧情全文"]

    asyncio.run(_run())
    asyncio.run(engine.dispose())


def test_confirm_materializes_what_the_plan_declares() -> None:
    """确认落库后：镜头数、镜头顺序、商品关联行都与草稿**逐项对得上**。"""
    factory, engine = _build_sync()
    result = _preview(factory, _complete_raw())

    async def _confirm() -> dict[str, Any]:
        async with factory() as session:
            counts = await materialize.materialize_drama_plan(
                session, chapter_id=CHAPTER_ID, plan=result["plan"]
            )
            await session.commit()  # 不 commit 的话下面另开 session 查不到（测试脚手架的坑）
            return counts

    counts = asyncio.run(_confirm())

    async def _check() -> tuple[int, list[int], int, int, int]:
        async with factory() as session:
            shots = int(await session.scalar(select(func.count()).select_from(Shot)) or 0)
            order = list((await session.execute(select(Shot.index).order_by(Shot.index))).scalars().all())
            product = int(await session.scalar(select(func.count()).select_from(Product)) or 0)
            links = int(
                await session.scalar(
                    select(func.count()).select_from(ProjectProductLink).where(
                        ProjectProductLink.shot_id.is_not(None)
                    )
                )
                or 0
            )
            materials = int(await session.scalar(select(func.count()).select_from(Shot)) or 0)
            return shots, [int(item) for item in order], product, links, materials

    shots, order, product, links, _materials = asyncio.run(_check())
    asyncio.run(engine.dispose())

    plan = DramaPlanDraft.model_validate(result["plan"])
    notes = f"（materialize 返回：{counts}）"
    assert shots == len(plan.shots), f"落库镜头数必须等于草稿镜头数 {notes}"
    assert order == list(range(1, len(plan.shots) + 1)), f"镜头序号必须连续 {notes}"
    assert product == 1, "商品落成正式资产且只有一份"
    expected_present = sum(1 for shot in plan.shots if shot.product_present)
    assert links == expected_present, "商品镜头关联行数必须等于草稿里 product_present 的镜头数"
