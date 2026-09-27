"""分层剧情（一句话 → 完整剧情 → 分镜）的确定性测试。

覆盖的实施契约（``site/content/docs/plans/drama-ad-full-loop.md`` §二「剧情（分层，按阶段生成）」）：

1. **一句话**先出：``one_liner`` + ``audience_emotion``（顺带人物关系与场景），此时**没有镜头**；
2. **完整剧情**必须基于已确认的一句话：没有一句话 → 409「先确认一句话创意」，**且一次模型都不调**；
   有了一句话 → 提示词里带着它，产出的剧情合并进同一份草稿（一句话不被冲掉）；
3. **分镜**必须基于当前完整剧情：没有剧情全文 → 409「先有完整剧情」；
   有剧情 → 提示词里带着剧情全文与人物表，镜头归一**沿用既有 postprocess_plan 规则**；
4. ``stage=all`` 兼容旧行为（一次出全部，不合并）；
5. 人工编辑晚于上次生成 → 重新生成不带 ``confirm_overwrite`` **必须 409**（且不花钱、不覆盖）；
6. ``save_plan`` 后 ``stale_flags`` 正确：一句话改过 → 完整剧情过期；完整剧情改过 → 分镜过期；
7. 一致性检查（**免费**）能报出「商品覆盖不足 / 未知角色 / 剧情过短」；
8. 演练模式：分段生成同样**不调模型、不写半成品**。

零出网、零付费：模型调用一律用桩替换（编排层注入了 stub caller；路由层替换
``run_plan_completion`` 这一个"唯一碰模型"的函数，其余链路真实执行）；库是内存库。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator, Iterator
from typing import Any

import pytest
from fastapi import HTTPException, status
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.dependencies import get_db
from app.main import app
from app.models.studio import Chapter, DramaPlanDraft, Project, Shot
from app.schemas.studio.drama_plan import DramaPlanDraft as DramaPlanDraftDTO
from app.services.studio import drama_plan_service as service
from app.services.studio.llm_orchestration import drama_plan as plan_module
from app.services.studio.llm_orchestration import drama_story
from app.services.studio.llm_orchestration.support import build_run_meta
from tests.llm_orchestration_fixtures import build_session, seed_project_chapter_shot

PROJECT_ID = "proj-drama"
CHAPTER_ID = "chap-drama"
BASE = f"/api/v1/studio/chapters/{CHAPTER_ID}/drama-plan"

BRIEF: dict[str, Any] = {
    "product_name": "紧致焕颜精华",
    "product_description": "白色磨砂瓶身，金色压泵",
    "selling_points": ["三秒吸收"],
    "target_audience": "25-35 岁通勤女性",
    "genre": "真人都市",
    "tone": "一本正经地荒诞",
    "shot_count": 3,
    "director_notes": "不要旁白",
}

ONE_LINER_TEXT = "林小满带着一瓶紧致焕颜精华去面试，面试官却是刚分手的前任周砚。"

ONE_LINER_JSON: dict[str, Any] = {
    "one_liner": ONE_LINER_TEXT,
    "audience_emotion": "替她攥紧拳头之后又被将了一军",
    "characters": [
        {"name": "林小满", "relation": "女主，与周砚刚分手", "profile": {"identity": "应届生"}},
        {"name": "周砚", "relation": "面试官，林小满的前任", "profile": {"identity": "部门主管"}},
    ],
    "scenes": [{"name": "写字楼会议室", "profile": {"spatial_structure": "长桌"}}],
    "product": {
        "name": "紧致焕颜精华",
        "description": "白色磨砂瓶身，金色压泵",
        "profile": {"package": "方形瓶身"},
    },
}

#: 完整剧情全文（必须长于 ``plan_module.MIN_STORY_CHARS``，否则会带"过短"告警）
STORY_FULL_TEXT = (
    "会议室里，林小满推门进来，把一瓶紧致焕颜精华拍在长桌上，瓶底磕出一声脆响。\n"
    "周砚坐在长桌另一头翻她的简历，指尖停了两秒，抬头问她最近是不是还在用那瓶精华。\n"
    "旁听的面试官互相看了一眼，林小满没有坐下，拧开瓶口在手心按了一泵，慢慢抹开。\n"
    "她说这三秒就吸收完了，没时间补妆的人只能靠这一下撑住体面，说完把瓶子推回桌子中间。\n"
    "周砚沉默很久，从公文包里掏出一只同款空瓶放在桌上，说这瓶其实是他买的。\n"
    "会议室安静了几秒，林小满笑了一下，把空瓶收进包里，转身推门出去，脚步比进来时更快。"
)

STORY_JSON: dict[str, Any] = {
    "story": {
        "full_text": STORY_FULL_TEXT,
        "hook": "林小满推门进来，把精华拍在会议桌上。",
        "conflict": "周砚翻着她的简历，问她是不是还在用那瓶精华。",
        "product_usage": "她当众拧开瓶口按了一泵，掌心抹开。",
        "climax": "周砚掏出同款空瓶，说这瓶是他买的。",
        "cta": "她出门给闺蜜发消息：我再买两瓶。",
    },
    "characters": ONE_LINER_JSON["characters"],
    "scenes": ONE_LINER_JSON["scenes"],
}

#: 三个镜头（覆盖 3/3 ≥ 一半），故意带中文景别、"slow push in"、6 秒——验证沿用既有归一规则
SHOTS_JSON: dict[str, Any] = {
    "shots": [
        {
            "index": 1,
            "title": "拍瓶",
            "characters": ["林小满"],
            "script_excerpt": "她把瓶子拍在桌上",
            "description": "会议室全景",
            "duration": 8,
            "camera_shot": "中景",
            "angle": "平视",
            "movement": "固定",
            "action_beats": ["推门", "拍瓶"],
            "dialogue": [{"speaker": "林小满", "text": "我不用补妆。", "mode": "DIALOGUE"}],
            "product_present": True,
        },
        {
            "index": 2,
            "title": "抬头",
            "characters": ["林小满", "周砚"],
            "description": "过肩特写",
            "duration": 6,
            "camera_shot": "CU",
            "angle": "LOW_ANGLE",
            "movement": "slow push in",
            "action_beats": ["抬头", "抹开精华"],
            "dialogue": [{"speaker": "周砚", "text": "好久不见。", "mode": "DIALOGUE"}],
            "product_present": True,
        },
        {
            "index": 3,
            "title": "空瓶",
            "characters": ["林小满", "周砚"],
            "description": "长桌两端",
            "duration": 4,
            "camera_shot": "LS",
            "angle": "EYE_LEVEL",
            "movement": "PAN",
            "action_beats": ["掏出空瓶", "推门离开"],
            "dialogue": [],
            "product_present": True,
        },
    ]
}

#: ``stage=all`` 的完整回包（兼容旧行为：一次出全部）
FULL_PLAN_JSON: dict[str, Any] = {
    **ONE_LINER_JSON,
    "story": STORY_JSON["story"],
    "title": "面试那天",
    "logline": "她带着一瓶精华去面试，面试官是前任",
    "sellingPoints": ["三秒吸收 → 她当众拍在桌上"],
    "climax": "周砚掏出同款空瓶",
    "shots": SHOTS_JSON["shots"],
}


def _manual_plan(
    *,
    one_liner: str = ONE_LINER_TEXT,
    story_text: str = STORY_FULL_TEXT,
    product_present: tuple[bool, bool, bool] = (True, True, False),
) -> dict[str, Any]:
    """一份"人工编辑后"的合法草稿（3 镜，默认 2/3 出现商品 = 恰好满足一半）。"""
    return {
        "title": "面试那天",
        "logline": "她带着一瓶精华去面试，面试官是前任",
        "one_liner": one_liner,
        "audience_emotion": "替她攥紧拳头之后又被将了一军",
        "story": {
            "full_text": story_text,
            "hook": "她把精华拍在会议桌上。",
            "conflict": "面试官是刚分手的前任。",
            "product_usage": "她当众按了一泵抹开。",
            "climax": "前任掏出同款空瓶。",
            "cta": "她给闺蜜发消息要再买两瓶。",
        },
        "characters": [
            {"name": "林小满", "relation": "女主，与周砚刚分手", "profile": {"identity": "应届生"}, "shot_indexes": [1, 2, 3]},
            {"name": "周砚", "relation": "面试官，林小满的前任", "profile": {"identity": "部门主管"}, "shot_indexes": [2, 3]},
        ],
        "scenes": [
            {"name": "写字楼会议室", "profile": {"spatial_structure": "长桌"}, "shot_indexes": [1]}
        ],
        "product": {
            "name": "紧致焕颜精华",
            "description": "白色磨砂瓶身，金色压泵",
            "profile": {"package": "方形瓶身"},
            "shot_indexes": [1, 2],
        },
        "shots": [
            dict(SHOTS_JSON["shots"][0], product_present=product_present[0]),
            dict(SHOTS_JSON["shots"][1], product_present=product_present[1]),
            dict(SHOTS_JSON["shots"][2], product_present=product_present[2]),
        ],
        "climax": "前任掏出同款空瓶",
        "warnings": [],
    }


# ---------------------------------------------------------------------------
# 脚手架
# ---------------------------------------------------------------------------


async def _build_harness_async() -> tuple[async_sessionmaker[AsyncSession], Any]:
    """内存库 + 建表（不碰任何真实库）。"""
    from app.core.db import Base
    import app.models.studio  # noqa: F401

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return factory, engine


def _build_harness() -> tuple[async_sessionmaker[AsyncSession], Any]:
    return asyncio.run(_build_harness_async())


async def _seed_async(factory: async_sessionmaker[AsyncSession]) -> None:
    async with factory() as session:
        session.add(Project(id=PROJECT_ID, name="广告项目", description="", style="真人都市", visual_style="现实"))
        await session.flush()
        session.add(
            Chapter(id=CHAPTER_ID, project_id=PROJECT_ID, index=1, title="第 1 集", raw_text="会议室里，她推门进来。")
        )
        await session.commit()


def _seed(factory: async_sessionmaker[AsyncSession]) -> None:
    asyncio.run(_seed_async(factory))


@pytest.fixture()
def routed_client() -> Iterator[tuple[TestClient, async_sessionmaker[AsyncSession]]]:
    """走真实路由 + 内存库（每个用例一套，互不干扰）。"""
    factory, engine = _build_harness()
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
        yield TestClient(app), factory
    finally:
        app.dependency_overrides.clear()
        asyncio.run(engine.dispose())


@pytest.fixture()
def llm_queue(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """把"模型调用"这一层换成**按顺序回放的桩**，其余链路（提示词/合并/归一化/过期标记）真实执行。

    为什么打在 ``run_plan_completion``：它是整条链路上唯一碰模型的地方（见 ``drama_plan``），
    替换它之后一次网络都不出，但仍然走真实的"提示词构建 → 结果合并 → 确定性归一化"。
    用例用 ``llm_queue["queue"].append(payload)`` 排下一次调用该返回什么，
    用 ``llm_queue["prompts"]`` 断言提示词里带了什么。
    """
    queue: list[dict[str, Any]] = []
    prompts: list[str] = []

    async def _stub(_db: Any, *, prompt: str, llm_caller: Any = None) -> dict[str, Any]:
        prompts.append(prompt)
        payload = queue.pop(0) if queue else {}
        text = json.dumps(payload, ensure_ascii=False)
        return {
            "dry_run": False,
            "target": None,
            "raw_text": text,
            "parsed": payload,
            "repairs": [],
            "latency_ms": None,
            "meta": build_run_meta(target=None, llm_called=True, raw_output_chars=len(text)),
        }

    monkeypatch.setattr(plan_module, "run_plan_completion", _stub)
    return {"queue": queue, "prompts": prompts}


async def _fetch_one(factory: async_sessionmaker[AsyncSession], model: Any, **filters: Any) -> Any:
    async with factory() as session:
        stmt = select(model)
        for key, value in filters.items():
            stmt = stmt.where(getattr(model, key) == value)
        return (await session.execute(stmt)).scalars().first()


def _stub_caller(payload: dict[str, Any]):
    """编排层用的 stub caller（返回固定 JSON，零出网）。"""

    async def _caller(_prompt: str) -> str:
        return json.dumps(payload, ensure_ascii=False)

    return _caller


# ---------------------------------------------------------------------------
# 1) 三段提示词的口径（写死在模板里，改模板不许悄悄丢掉）
# ---------------------------------------------------------------------------


def test_prompts_hardcode_the_layered_rules() -> None:
    """详细剧情必须围绕已确认的一句话、分镜必须来自完整剧情、商品自然介入、不要硬 CTA。"""
    assert len(STORY_FULL_TEXT) >= plan_module.MIN_STORY_CHARS, "测试用的剧情全文必须够长"

    story_prompt = drama_story.build_story_prompt(
        brief=BRIEF,
        chapter_title="第 1 集",
        chapter_text="会议室里，她推门进来。",
        one_liner=ONE_LINER_TEXT,
        audience_emotion="又爽又暖",
        style_hint="真人都市 / 一本正经地荒诞",
    )
    assert ONE_LINER_TEXT in story_prompt                      # 已确认的一句话是提示词的输入
    assert "必须围绕上面那句已确认的一句话" in story_prompt
    assert "绝对不许另起一个故事" in story_prompt
    assert "围绕人物关系展开" in story_prompt
    assert "自然介入" in story_prompt
    assert "不要硬 CTA" in story_prompt
    assert "紧致焕颜精华" in story_prompt                       # brief 的商品信息也带着

    board_prompt = drama_story.build_storyboard_prompt(
        brief=BRIEF,
        chapter_title="第 1 集",
        story_full_text=STORY_FULL_TEXT,
        shot_count=3,
        duration_hint=24,
        style_hint="真人都市",
        characters_text="- 林小满（关系：女主）",
        product_text="紧致焕颜精华｜白色磨砂瓶身",
        allowed_durations="4/5/8/10/12/15",
    )
    assert STORY_FULL_TEXT[:60] in board_prompt                # 完整剧情是提示词的输入
    assert "分镜必须来自上面的完整剧情" in board_prompt
    assert "不许新增剧情线" in board_prompt
    assert "至少 2 镜" in board_prompt                          # 3 镜 → 一半是 2
    assert "- 林小满（关系：女主）" in board_prompt

    one_prompt = drama_story.build_one_liner_prompt(
        brief=BRIEF, chapter_title="第 1 集", chapter_text="会议室里，她推门进来。", style_hint="真人都市"
    )
    assert "一句话说得完" in one_prompt
    assert "relation" in one_prompt


# ---------------------------------------------------------------------------
# 2) 阶段前置条件：不合格就别花钱（且一次模型都不调）
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_story_stage_rejected_without_confirmed_one_liner() -> None:
    """没有已确认的一句话时 ``story`` 阶段被拒（409），并且**不调用模型**。"""
    db, engine = await build_session()
    calls: list[str] = []

    async def caller(prompt: str) -> str:  # pragma: no cover - 被调用即失败
        calls.append(prompt)
        raise AssertionError("前置条件不满足时不该调用模型")

    try:
        async with db:
            await seed_project_chapter_shot(db)
            with pytest.raises(HTTPException) as info:
                await drama_story.preview_drama_stage(
                    db, chapter_id="chap-1", brief=BRIEF, stage="story", current_plan={}, llm_caller=caller
                )
    finally:
        await engine.dispose()

    assert info.value.status_code == 409
    assert info.value.detail["code"] == "drama_plan_one_liner_required"
    assert "先确认一句话创意" in info.value.detail["message"]
    assert calls == [], "拒绝必须发生在调用模型之前"


@pytest.mark.asyncio
async def test_storyboard_stage_rejected_without_story_text() -> None:
    """没有完整剧情全文时 ``storyboard`` 阶段被拒（409），同样不调用模型。"""
    db, engine = await build_session()
    plan = {"one_liner": ONE_LINER_TEXT, "story": {"full_text": "   "}}
    try:
        async with db:
            await seed_project_chapter_shot(db)
            with pytest.raises(HTTPException) as info:
                await drama_story.preview_drama_stage(
                    db, chapter_id="chap-1", brief=BRIEF, stage="storyboard", current_plan=plan
                )
    finally:
        await engine.dispose()

    assert info.value.status_code == 409
    assert info.value.detail["code"] == "drama_plan_story_required"
    assert "先有完整剧情" in info.value.detail["message"]


def test_invalid_stage_is_422() -> None:
    """阶段取值非法 → 422（不猜用户想生成哪一段）。"""
    with pytest.raises(HTTPException) as info:
        drama_story.parse_stage("全部")
    assert info.value.status_code == status.HTTP_422_UNPROCESSABLE_CONTENT
    assert info.value.detail["code"] == "drama_plan_invalid_stage"


# ---------------------------------------------------------------------------
# 3) 三个阶段依次生成：合并、带上一步、沿用既有镜头归一规则
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_layered_stages_merge_on_top_of_each_other() -> None:
    """一句话 → 完整剧情 → 分镜：每一段都基于上一段，且不冲掉别的字段。"""
    db, engine = await build_session()
    prompts: list[str] = []
    queue: list[dict[str, Any]] = [ONE_LINER_JSON, STORY_JSON, SHOTS_JSON]

    async def caller(prompt: str) -> str:
        prompts.append(prompt)
        return json.dumps(queue.pop(0), ensure_ascii=False)

    try:
        async with db:
            await seed_project_chapter_shot(db)

            # --- 第 1 段：一句话 ---
            first = await drama_story.preview_drama_stage(
                db, chapter_id="chap-1", brief=BRIEF, stage="one_liner", current_plan={}, llm_caller=caller
            )
            plan1 = first["plan"]
            assert plan1["one_liner"] == ONE_LINER_TEXT
            assert plan1["audience_emotion"]
            assert plan1["characters"][0]["relation"] == "女主，与周砚刚分手"   # 人物关系
            assert plan1["product"]["name"] == "紧致焕颜精华"                  # 商品段沿用商品信息
            assert plan1["shots"] == [] and plan1["story"]["full_text"] == ""   # 这一步没有剧情与分镜

            # --- 第 2 段：完整剧情（必须基于已确认的一句话） ---
            second = await drama_story.preview_drama_stage(
                db, chapter_id="chap-1", brief=BRIEF, stage="story", current_plan=plan1, llm_caller=caller
            )
            plan2 = second["plan"]
            assert ONE_LINER_TEXT in prompts[1], "完整剧情的提示词必须带上已确认的一句话"
            assert plan2["story"]["full_text"] == STORY_FULL_TEXT
            assert plan2["story"]["hook"] and plan2["story"]["cta"]
            assert plan2["one_liner"] == ONE_LINER_TEXT, "生成完整剧情不许把一句话冲掉"
            assert plan2["characters"][1]["relation"], "人物关系要保留"
            assert plan2["shots"] == [], "这一步还不该有分镜"
            assert not any("短于" in item for item in second["warnings"]), "够长的全文不该报过短"

            # --- 第 3 段：分镜（必须来自完整剧情） ---
            third = await drama_story.preview_drama_stage(
                db, chapter_id="chap-1", brief=BRIEF, stage="storyboard", current_plan=plan2, llm_caller=caller
            )
            plan3 = third["plan"]
            assert STORY_FULL_TEXT[:60] in prompts[2], "分镜的提示词必须带上完整剧情全文"
            assert "林小满" in prompts[2], "分镜的提示词必须带上人物表（白名单）"
            assert len(plan3["shots"]) == 3
            assert plan3["story"]["full_text"] == STORY_FULL_TEXT, "生成分镜不许把完整剧情冲掉"
            assert plan3["one_liner"] == ONE_LINER_TEXT
            # 镜头归一沿用既有 postprocess_plan 规则
            assert plan3["shots"][0]["camera_shot"] == "MS"          # 「中景」
            assert plan3["shots"][0]["movement"] == "STATIC"         # 「固定」
            assert plan3["shots"][1]["movement"] == "DOLLY_IN"       # 「slow push in」包含匹配
            assert plan3["shots"][1]["duration"] == 5                # 6 秒 → 最近档位 5
            assert [shot["index"] for shot in plan3["shots"]] == [1, 2, 3]
            # 合并后的草稿结构合法（写回库的一定是合法草稿）
            DramaPlanDraftDTO.model_validate(plan3)
    finally:
        await engine.dispose()


def test_storyboard_merge_reuses_postprocess_rules_for_dangling_names() -> None:
    """分镜里的悬空角色/说话人沿用既有规则：剔除并如实告警（不另写一套归一）。"""
    current = DramaPlanDraftDTO.model_validate(
        {"one_liner": ONE_LINER_TEXT, "story": {"full_text": STORY_FULL_TEXT}, "characters": ONE_LINER_JSON["characters"]}
    )
    raw = {
        "shots": [
            {
                "index": 1,
                "title": "拍瓶",
                "characters": ["林小满", "不存在的黑衣人"],
                "action_beats": ["拍瓶"],
                "dialogue": [{"speaker": "查无此人", "text": "你是谁？"}],
                "product_present": True,
            }
        ]
    }
    merged, warnings = drama_story.merge_stage_output("storyboard", current=current, raw=raw, shot_count=1)

    assert merged["shots"][0]["characters"] == ["林小满"]
    assert merged["shots"][0]["dialogue"][0]["speaker"] == ""
    assert merged["shots"][0]["dialogue"][0]["text"] == "你是谁？"
    assert any("出场角色" in item for item in warnings)
    # 没有商品信息 → 模型标的「出现商品」被置为 False（不信模型自述）
    assert merged["shots"][0]["product_present"] is False


@pytest.mark.asyncio
async def test_stage_all_keeps_single_call_behaviour() -> None:
    """``stage=all`` 兼容旧行为：一次出全部（不合并、整体替换）。"""
    db, engine = await build_session()
    try:
        async with db:
            await seed_project_chapter_shot(db)
            result = await drama_story.preview_drama_stage(
                db,
                chapter_id="chap-1",
                brief=BRIEF,
                stage="all",
                current_plan={"one_liner": "旧的一句话，应该被整体替换掉。"},
                llm_caller=_stub_caller(FULL_PLAN_JSON),
            )
    finally:
        await engine.dispose()

    plan = DramaPlanDraftDTO.model_validate(result["plan"])
    assert plan.one_liner == ONE_LINER_TEXT          # 被替换，而不是与旧值合并
    assert plan.story.full_text == STORY_FULL_TEXT
    assert len(plan.shots) == 3
    assert plan.title == "面试那天"
    assert result["meta"].llm_called is True


# ---------------------------------------------------------------------------
# 4) 演练：分段生成也不调模型、不写半成品
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stage_dry_run_calls_no_model_and_returns_no_plan() -> None:
    """DRY_RUN 下分段生成：一次模型都不调，且**不给假草稿**（假 JSON 会污染草稿列）。"""
    db, engine = await build_session()
    try:
        async with db:
            await seed_project_chapter_shot(db)
            result = await drama_story.preview_drama_stage(
                db, chapter_id="chap-1", brief=BRIEF, stage="one_liner", current_plan={}
            )
    finally:
        await engine.dispose()

    assert result["plan"] is None, "演练模式下不许给出假草稿"
    assert result["meta"].llm_called is False
    assert result["meta"].dry_run is True
    assert any("DRY_RUN" in item for item in result["warnings"])
    assert "未生成草稿" in result["note"]


# ---------------------------------------------------------------------------
# 5) 路由：分层生成 + 过期标记
# ---------------------------------------------------------------------------


def test_layered_generate_via_routes_then_consistent(
    routed_client: tuple[TestClient, async_sessionmaker[AsyncSession]], llm_queue: dict[str, Any]
) -> None:
    """走真实路由跑完三步：每步只更新这一段，最后一致性检查通过。"""
    client, _factory = routed_client
    assert client.put(f"{BASE}/brief", json=BRIEF).status_code == 200

    llm_queue["queue"].append(ONE_LINER_JSON)
    first = client.post(f"{BASE}/generate", json={"stage": "one_liner"})
    assert first.status_code == 200, first.text
    data1 = first.json()["data"]
    assert data1["plan"]["one_liner"] == ONE_LINER_TEXT
    assert data1["plan"]["shots"] == []
    assert data1["meta"]["stage"] == "one_liner"
    assert data1["meta"]["generated_at"]
    # 一句话有了、剧情还没有 → 谈不上"剧情过期"
    assert data1["stale_flags"]["story_stale"] is False

    llm_queue["queue"].append(STORY_JSON)
    second = client.post(f"{BASE}/generate", json={"stage": "story"})
    assert second.status_code == 200, second.text
    data2 = second.json()["data"]
    assert data2["plan"]["story"]["full_text"] == STORY_FULL_TEXT
    assert data2["plan"]["one_liner"] == ONE_LINER_TEXT
    assert data2["stale_flags"]["story_stale"] is False
    assert ONE_LINER_TEXT in llm_queue["prompts"][1]

    llm_queue["queue"].append(SHOTS_JSON)
    third = client.post(f"{BASE}/generate", json={"stage": "storyboard"})
    assert third.status_code == 200, third.text
    data3 = third.json()["data"]
    assert len(data3["plan"]["shots"]) == 3
    assert data3["plan"]["story"]["full_text"] == STORY_FULL_TEXT
    assert data3["stale_flags"]["shots_stale"] is False
    assert STORY_FULL_TEXT[:60] in llm_queue["prompts"][2]

    # 免费一致性检查：商品覆盖 3/3、没有未知角色、剧情够长 → 无问题
    checked = client.post(f"{BASE}/consistency")
    assert checked.status_code == 200, checked.text
    body = checked.json()["data"]
    assert body["ok"] is True
    assert body["issues"] == []
    assert body["summary"]["product_shots"] == 3
    assert body["summary"]["shots"] == 3
    assert "一致性检查通过" in body["summary"]["text"]


def test_generate_stage_all_is_backwards_compatible(
    routed_client: tuple[TestClient, async_sessionmaker[AsyncSession]], llm_queue: dict[str, Any]
) -> None:
    """显式 ``stage="all"``：与不带 stage 的旧行为一致。"""
    client, _factory = routed_client
    assert client.put(f"{BASE}/brief", json=BRIEF).status_code == 200
    llm_queue["queue"].append(FULL_PLAN_JSON)

    resp = client.post(f"{BASE}/generate", json={"stage": "all"})
    assert resp.status_code == 200, resp.text
    plan = resp.json()["data"]["plan"]
    assert plan["title"] == "面试那天"
    assert len(plan["shots"]) == 3
    assert plan["story"]["full_text"] == STORY_FULL_TEXT
    assert resp.json()["data"]["meta"]["stage"] == "all"


# ---------------------------------------------------------------------------
# 6) 人工编辑 → 重新生成必须显式确认覆盖
# ---------------------------------------------------------------------------


def test_regenerate_after_manual_edit_requires_confirm_overwrite(
    routed_client: tuple[TestClient, async_sessionmaker[AsyncSession]], llm_queue: dict[str, Any]
) -> None:
    """人工编辑晚于上次生成 → 不加 confirm_overwrite 必须 409（且不花钱、不覆盖）。"""
    client, _factory = routed_client
    assert client.put(f"{BASE}/brief", json=BRIEF).status_code == 200

    llm_queue["queue"].append(ONE_LINER_JSON)
    assert client.post(f"{BASE}/generate", json={"stage": "one_liner"}).status_code == 200

    # 连续两次生成之间没有人工编辑 → 不需要确认
    llm_queue["queue"].append(ONE_LINER_JSON)
    assert client.post(f"{BASE}/generate", json={"stage": "one_liner"}).status_code == 200

    # 人工改一句话
    edited = dict(ONE_LINER_JSON)
    edited["one_liner"] = "手改后的一句话：她把精华拍在面试官面前。"
    assert client.put(f"{BASE}/draft", json=edited).status_code == 200

    calls_before = len(llm_queue["prompts"])
    blocked = client.post(f"{BASE}/generate", json={"stage": "one_liner"})
    assert blocked.status_code == 409, blocked.text
    error = blocked.json()["meta"]["error"]
    assert error["code"] == "drama_plan_overwrite_required"
    assert "覆盖" in error["message"]
    assert len(llm_queue["prompts"]) == calls_before, "被拒绝时不许发生任何模型调用"
    assert client.get(BASE).json()["data"]["plan"]["one_liner"].startswith("手改后的一句话")

    # 显式确认 → 覆盖成功
    llm_queue["queue"].append(ONE_LINER_JSON)
    overwritten = client.post(
        f"{BASE}/generate", json={"stage": "one_liner", "confirm_overwrite": True}
    )
    assert overwritten.status_code == 200, overwritten.text
    assert overwritten.json()["data"]["plan"]["one_liner"] == ONE_LINER_TEXT


# ---------------------------------------------------------------------------
# 7) save_plan：重算 stale_flags + 记 manual_edited_at
# ---------------------------------------------------------------------------


def test_save_plan_recomputes_stale_flags(
    routed_client: tuple[TestClient, async_sessionmaker[AsyncSession]]
) -> None:
    """一句话改过 → 完整剧情过期；完整剧情改过 → 分镜过期；两次都记人工编辑时间。"""
    client, factory = routed_client
    assert client.put(f"{BASE}/brief", json=BRIEF).status_code == 200

    saved = client.put(f"{BASE}/draft", json=_manual_plan())
    assert saved.status_code == 200, saved.text
    flags = saved.json()["data"]["stale_flags"]
    assert flags["story_stale"] is False and flags["shots_stale"] is False
    assert flags["reasons"] == []
    row = asyncio.run(_fetch_one(factory, DramaPlanDraft, chapter_id=CHAPTER_ID))
    assert row is not None and row.manual_edited_at is not None
    assert row.story_status == "draft", "人工改过之后不再算已确认"

    # 只改一句话 → 完整剧情过期，分镜不过期
    changed_one_liner = "改过的一句话：她带着精华去面试。"
    second = client.put(f"{BASE}/draft", json=_manual_plan(one_liner=changed_one_liner))
    assert second.status_code == 200, second.text
    flags2 = second.json()["data"]["stale_flags"]
    assert flags2["story_stale"] is True
    assert flags2["shots_stale"] is False
    assert flags2["one_liner_changed_at"]
    assert any("完整剧情" in item for item in flags2["reasons"])
    # 刷新（GET）后过期标记还在
    assert client.get(BASE).json()["data"]["stale_flags"]["story_stale"] is True

    # 再改完整剧情 → 分镜也过期
    third = client.put(
        f"{BASE}/draft",
        json=_manual_plan(one_liner=changed_one_liner, story_text="改过之后的剧情全文。" * 30),
    )
    assert third.status_code == 200, third.text
    flags3 = third.json()["data"]["stale_flags"]
    assert flags3["shots_stale"] is True
    assert flags3["story_changed_at"]
    assert any("分镜" in item for item in flags3["reasons"])

    # 重新生成分镜之后，分镜过期的标记自动消失（生成时间晚于改动时间）
    # —— 这里用桩替身直接调服务层，验证时间戳口径本身
    same = service.compute_stale_flags(
        previous_flags=flags3,
        previous_plan=_manual_plan(one_liner=changed_one_liner, story_text="改过之后的剧情全文。" * 30),
        new_plan=_manual_plan(one_liner=changed_one_liner, story_text="改过之后的剧情全文。" * 30),
        story_generated=True,
        shots_generated=True,
    )
    assert same["story_stale"] is False and same["shots_stale"] is False


def test_save_plan_accepts_a_draft_without_shots(
    routed_client: tuple[TestClient, async_sessionmaker[AsyncSession]]
) -> None:
    """分层流程允许先只存一句话/完整剧情（还没有镜头），不该被当成"生成失败"。"""
    client, _factory = routed_client
    assert client.put(f"{BASE}/brief", json=BRIEF).status_code == 200
    partial = {"one_liner": ONE_LINER_TEXT, "audience_emotion": "又爽又暖"}
    resp = client.put(f"{BASE}/draft", json=partial)
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["plan"]["one_liner"] == ONE_LINER_TEXT
    assert resp.json()["data"]["plan"]["shots"] == []


# ---------------------------------------------------------------------------
# 8) 一致性检查：三类问题都要报出来（且不调模型）
# ---------------------------------------------------------------------------


def test_consistency_reports_product_coverage_unknown_character_and_short_story(
    routed_client: tuple[TestClient, async_sessionmaker[AsyncSession]]
) -> None:
    """商品覆盖不足 / 未知角色 / 剧情过短三类问题都能报出来（含 fix）。"""
    client, factory = routed_client
    assert client.put(f"{BASE}/brief", json=BRIEF).status_code == 200

    bad = _manual_plan(story_text="太短了。", product_present=(True, False, False))
    bad["shots"][0]["characters"] = ["林小满", "神秘人"]   # 人物表里没有的人

    async def _write_bad_plan() -> None:
        async with factory() as session:
            row = await session.get(DramaPlanDraft, CHAPTER_ID)
            assert row is not None
            row.plan = bad
            await session.commit()

    asyncio.run(_write_bad_plan())

    resp = client.post(f"{BASE}/consistency")
    assert resp.status_code == 200, resp.text
    body = resp.json()["data"]
    codes = {issue["code"] for issue in body["issues"]}
    assert {"product_coverage_low", "unknown_character", "story_too_short"} <= codes
    assert body["ok"] is False
    assert body["summary"]["errors"] >= 2 and body["summary"]["warnings"] >= 1
    for issue in body["issues"]:
        assert issue["message"] and issue["fix"], "每条问题都要有用户语言的说明与可做的动作"
        assert issue["level"] in {"error", "warning"}
    # GET 也带上同一份摘要（免费，页面不必额外请求）
    summary = client.get(BASE).json()["data"]["consistency"]
    assert summary is not None and summary["ok"] is False
    assert summary["summary"]["product_shots"] == 1


def test_consistency_endpoint_never_calls_a_model(
    routed_client: tuple[TestClient, async_sessionmaker[AsyncSession]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """一致性检查是免费出口：把两个生成入口都换成"一调就炸"，检查照样通过。"""
    client, _factory = routed_client
    assert client.put(f"{BASE}/brief", json=BRIEF).status_code == 200

    async def forbidden(*_args: Any, **_kwargs: Any) -> Any:  # pragma: no cover - 被调用即失败
        raise AssertionError("一致性检查绝不允许调用模型")

    monkeypatch.setattr(service.orchestration, "preview_drama_plan", forbidden)
    monkeypatch.setattr(service.orchestration, "preview_drama_stage", forbidden)

    # 还没有草稿内容：200 + ok=false（"还没有内容"本身就是诊断结果）
    empty = client.post(f"{BASE}/consistency")
    assert empty.status_code == 200, empty.text
    assert empty.json()["data"]["ok"] is False
    assert client.get(BASE).json()["data"]["consistency"] is None

    # 有一份草稿之后：照常检查
    assert client.put(f"{BASE}/draft", json=_manual_plan()).status_code == 200
    checked = client.post(f"{BASE}/consistency")
    assert checked.status_code == 200
    assert checked.json()["data"]["summary"]["shots"] == 3
    assert "没有调用任何模型" in checked.json()["meta"]["note"]


# ---------------------------------------------------------------------------
# 9) 演练模式（路由）：不调模型、不写半成品、前置条件照常拒绝
# ---------------------------------------------------------------------------


def test_generate_in_dry_run_writes_no_partial_plan(
    routed_client: tuple[TestClient, async_sessionmaker[AsyncSession]]
) -> None:
    """演练模式：分段生成不写半成品；前置条件不满足仍然是 409；非法阶段是 422。"""
    client, factory = routed_client
    assert client.put(f"{BASE}/brief", json=BRIEF).status_code == 200

    resp = client.post(f"{BASE}/generate", json={"stage": "one_liner"})
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["plan"] is None, "演练模式不许给假草稿"
    assert "未生成草稿" in data["note"]

    row = asyncio.run(_fetch_one(factory, DramaPlanDraft, chapter_id=CHAPTER_ID))
    assert row is not None
    assert row.plan == {}, "演练模式绝不允许写半成品草稿"
    assert row.status == ""
    assert row.meta.get("llm_called") is False
    assert not row.meta.get("generated_at"), "没生成过就不能算「上次生成」"
    assert row.manual_edited_at is None
    assert asyncio.run(_fetch_all_shots(factory)) == []

    # 一句话还没有 → story 阶段 409（不是空跑一次模型）
    blocked = client.post(f"{BASE}/generate", json={"stage": "story"})
    assert blocked.status_code == 409
    assert blocked.json()["meta"]["error"]["code"] == "drama_plan_one_liner_required"

    # 非法阶段 → 422（请求体的 stage 是字面量，FastAPI 在入口就挡住；服务层的
    # 同一拒绝口径由 test_invalid_stage_is_422 直接覆盖），且同样不写任何东西
    bad = client.post(f"{BASE}/generate", json={"stage": "全都要"})
    assert bad.status_code == 422
    assert client.get(BASE).json()["data"]["plan"] is None

    # 陌生字段 → 422（请求体是 extra=forbid，不许静默忽略）
    unknown = client.post(f"{BASE}/generate", json={"stage": "one_liner", "重来": True})
    assert unknown.status_code == 422


async def _fetch_all_shots(factory: async_sessionmaker[AsyncSession]) -> list[Any]:
    async with factory() as session:
        return list((await session.execute(select(Shot).where(Shot.chapter_id == CHAPTER_ID))).scalars().all())
