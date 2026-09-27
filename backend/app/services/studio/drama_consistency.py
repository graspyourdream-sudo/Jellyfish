"""剧情方案的**一致性检查**（确定性、**不调用任何模型**、不写库）。

为什么需要它（而且必须是免费的）
================================

用户会在草稿编辑器里手改剧情/分镜。手改最容易出三类"当时看不出、确认落库时才炸"的问题：

1. 商品被改没了（确认时才会 409「商品覆盖不足一半」）；
2. 分镜里出现了人物表里没有的人（确认时才会 409「未知角色」）；
3. 剧情全文被删短 / 改得和分镜对不上（确认时会落一份"剧情与分镜不是一回事"的正式产物）。

把这三类检查做成**免费出口**，页面就能在用户点确认之前一直提示他。
检查全部是纯函数（字符串与计数），所以可以随 ``GET`` 一起下发，一分钱不花。

``ok`` 的语义
=============

``ok = 没有任何 error 级问题``。``warning`` 是"提示但不挡"：例如剧情全文偏短、
人物表里有角色没落进分镜。**没有分镜时不报错**（那只是流程还没走到分镜），
只给一条"先生成分镜"的提示 —— 否则刚生成完一句话创意的用户会看到一片红。
"""

from __future__ import annotations

import re
from typing import Any

from app.services.studio.llm_orchestration.drama_plan import MIN_STORY_CHARS
from app.services.studio.llm_orchestration.json_utils import coerce_int, coerce_str

#: 两级严重度：``error`` 会挡住"确认落库"（与 ``drama_plan_materialize`` 的 409 同源），
#: ``warning`` 只提示。
LEVEL_ERROR = "error"
LEVEL_WARNING = "warning"

#: 一致性检查的机器可读代号（前端按 code 决定跳转到哪个面板）
CODE_PLAN_EMPTY = "drama_plan_empty"
CODE_STORY_MISSING = "story_missing"
CODE_STORY_TOO_SHORT = "story_too_short"
CODE_STORY_BLOCKS_INCOMPLETE = "story_blocks_incomplete"
CODE_SHOTS_MISSING = "shots_missing"
CODE_UNKNOWN_CHARACTER = "unknown_character"
CODE_UNKNOWN_ASSET = "unknown_asset"
CODE_PRODUCT_MISSING_IN_PLAN = "product_missing_in_plan"
CODE_PRODUCT_COVERAGE_LOW = "product_coverage_low"
CODE_CHARACTER_MISSING_IN_SHOTS = "character_missing_in_shots"
CODE_STORY_SHOTS_UNRELATED = "story_shots_unrelated"
CODE_CLIMAX_MISSING_IN_SHOTS = "climax_missing_in_shots"

#: ``story`` 的分栏字段与中文名（缺栏要单独提示，用户才知道去补哪一格）
STORY_BLOCKS: tuple[tuple[str, str], ...] = (
    ("hook", "开场钩子"),
    ("conflict", "核心冲突"),
    ("product_usage", "商品介入"),
    ("climax", "高潮反转"),
    ("cta", "结尾引导"),
)

#: 判断"分镜里出现了某个人/某个场景"时用的文本字段
_SHOT_TEXT_FIELDS: tuple[str, ...] = ("title", "description", "script_excerpt")

#: 分镜里可能携带的**资产引用**字段名（编辑器给分镜挂资产时用；没有就不检查这一项）
_SHOT_ASSET_FIELDS: tuple[str, ...] = ("assets", "asset_names", "asset_refs", "asset_ids")

_CJK_RUN = re.compile(r"[\u4e00-\u9fff]+")

#: 高频虚词（做 2-gram 关键词时用来滤掉"的这"这类假重合）
_STOPWORD_CHARS = set("的了着过在是和我你他她它们与及就都也很不没一有个这那为把被从对向到而且所以因为如果虽然但是上下里中时")


def _as_dict(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return list(value) if isinstance(value, (list, tuple)) else []


def _shots(plan: dict[str, Any]) -> list[dict[str, Any]]:
    return [item for item in _as_list(plan.get("shots")) if isinstance(item, dict)]


def _character_names(plan: dict[str, Any]) -> list[str]:
    names: list[str] = []
    for item in _as_list(plan.get("characters")):
        name = coerce_str(_as_dict(item).get("name"))
        if name:
            names.append(name)
    return names


def _scenes(plan: dict[str, Any]) -> list[str]:
    names: list[str] = []
    for item in _as_list(plan.get("scenes")):
        name = coerce_str(_as_dict(item).get("name"))
        if name:
            names.append(name)
    return names


def _product(plan: dict[str, Any]) -> dict[str, Any]:
    return _as_dict(plan.get("product"))


def _shot_text(shot: dict[str, Any]) -> str:
    """把一个镜头里所有能"读"的文本拼起来（用于关键词重合与人物出现判定）。"""
    parts: list[str] = []
    for field in _SHOT_TEXT_FIELDS:
        parts.append(coerce_str(shot.get(field)))
    parts.extend(coerce_str(item) for item in _as_list(shot.get("action_beats")))
    for line in _as_list(shot.get("dialogue")):
        parts.append(coerce_str(_as_dict(line).get("text")))
    return " ".join(part for part in parts if part)


def keywords(text: str) -> set[str]:
    """把中文文本切成 2-gram 关键词集合（含英文/数字原样保留）。

    为什么要 2-gram 而不是分词：环境里没有中文分词依赖，也不该为此引入新依赖；
    2-gram 对"同一段剧情换一种说法"足够宽容（人物名、场景名、关键动作用词都会重合），
    而"完全不同的两段剧情"几乎不会重合 —— 这正是这个检查要区分的两件事。
    只由虚词组成的组合（"的这"）被滤掉，避免假的"有关系"。
    """
    result: set[str] = set()
    for token in re.findall(r"[\u4e00-\u9fff]+|[A-Za-z0-9]+", str(text or "")):
        if _CJK_RUN.fullmatch(token) and len(token) > 1:
            for index in range(len(token) - 1):
                gram = token[index : index + 2]
                if all(char in _STOPWORD_CHARS for char in gram):
                    continue
                result.add(gram)
        elif len(token) > 1:
            result.add(token.lower())
    return result


def _issue(code: str, level: str, message: str, fix: str) -> dict[str, str]:
    """一条问题（结构固定四件套：代号 / 级别 / 用户语言的说明 / 能做的动作）。"""
    return {"code": code, "level": level, "message": message, "fix": fix}


def check_plan_consistency(
    plan: dict[str, Any] | None,
    *,
    brief_product_name: str = "",
) -> dict[str, Any]:
    """对一份草稿做确定性一致性检查，返回 ``{ok, issues, summary}``。

    容错：**不假设草稿结构合法**（用户手改可能把某处写坏）。所有读取都走
    "取不到就当空"的路径，坏结构由 ``PUT /draft`` 的 422 挡住，这里只做检查。
    """
    payload = _as_dict(plan)
    issues: list[dict[str, str]] = []

    story = _as_dict(payload.get("story"))
    full_text = coerce_str(story.get("full_text"))
    shots = _shots(payload)
    characters = _character_names(payload)
    scenes = _scenes(payload)
    product = _product(payload)
    product_name = coerce_str(product.get("name"))
    need = (len(shots) + 1) // 2
    product_shots = sum(1 for shot in shots if bool(shot.get("product_present")))

    # ------------------------------------------------------------------
    # 1) 有没有内容可查
    # ------------------------------------------------------------------
    if not payload or (not full_text and not shots and not coerce_str(payload.get("one_liner"))):
        issues.append(
            _issue(
                CODE_PLAN_EMPTY,
                LEVEL_ERROR,
                "还没有可检查的剧情内容：这一集还没有生成或填写过剧情方案。",
                "先生成一句话核心创意，再逐步生成完整剧情与分镜。",
            )
        )

    # ------------------------------------------------------------------
    # 2) 完整剧情：空 / 过短 / 分栏缺失
    #    这两条直接决定"分镜能不能从剧情推出来"，所以过短只提示、为空算错误。
    # ------------------------------------------------------------------
    if payload and not full_text:
        issues.append(
            _issue(
                CODE_STORY_MISSING,
                LEVEL_ERROR,
                "完整剧情全文是空的：分镜必须来自完整剧情，现在没有可拆的内容。",
                "先生成完整剧情（或手工填好剧情全文），再拆分镜。",
            )
        )
    elif full_text and len(full_text) < MIN_STORY_CHARS:
        issues.append(
            _issue(
                CODE_STORY_TOO_SHORT,
                LEVEL_WARNING,
                f"完整剧情全文只有 {len(full_text)} 字，短于 {MIN_STORY_CHARS} 字："
                "拍起来会明显不够，分镜也容易拆得空。",
                "重新生成一次，或手工把剧情补写到能读成一集戏的长度。",
            )
        )

    if full_text:
        missing_blocks = [label for key, label in STORY_BLOCKS if not coerce_str(story.get(key))]
        if missing_blocks:
            issues.append(
                _issue(
                    CODE_STORY_BLOCKS_INCOMPLETE,
                    LEVEL_WARNING,
                    "剧情分栏还缺：" + "、".join(missing_blocks) + "。页面按分栏展示，缺栏会显示为空。",
                    "补写缺的分栏（也可以重新生成完整剧情）。",
                )
            )

    # ------------------------------------------------------------------
    # 3) 分镜：没有分镜只提示（流程还没走到），有分镜才做逐项核对
    # ------------------------------------------------------------------
    if payload and not shots:
        issues.append(
            _issue(
                CODE_SHOTS_MISSING,
                LEVEL_WARNING,
                "还没有分镜：商品覆盖、人物是否落齐这些检查要等分镜生成后再看。",
                "点「生成分镜」把当前完整剧情拆成镜头。",
            )
        )

    # ------------------------------------------------------------------
    # 4) 人物：分镜/台词里出现的人必须在人物表里（悬空引用会让确认落库直接 409）
    # ------------------------------------------------------------------
    known = {name for name in characters}
    unknown: list[tuple[int, str]] = []
    for shot in shots:
        index = coerce_int(shot.get("index"), default=0) or 0
        for name in _as_list(shot.get("characters")):
            text = coerce_str(name)
            if text and text not in known:
                unknown.append((index, text))
        for line in _as_list(shot.get("dialogue")):
            speaker = coerce_str(_as_dict(line).get("speaker"))
            if speaker and speaker not in known:
                unknown.append((index, speaker))
    if unknown:
        listed = "、".join(f"「{name}」（镜头 {index}）" for index, name in unknown[:4])
        issues.append(
            _issue(
                CODE_UNKNOWN_CHARACTER,
                LEVEL_ERROR,
                f"分镜里出现了人物表里没有的人：{listed}。确认落库时会被拒绝。",
                "把这些角色补进人物表（推荐），或从分镜的出场角色/台词说话人里去掉。",
            )
        )

    # 反向：剧情里提到的人物一位都没落进分镜 → 提示（不挡）
    if shots and full_text:
        fallen = [shot for shot in shots if _as_list(shot.get("characters"))]
        appeared = {coerce_str(name) for shot in fallen for name in _as_list(shot.get("characters"))}
        missing = [name for name in characters if name in full_text and name not in appeared]
        if missing and len(missing) == len(characters):
            issues.append(
                _issue(
                    CODE_CHARACTER_MISSING_IN_SHOTS,
                    LEVEL_WARNING,
                    "剧情里的人物一位都没有出现在分镜的出场角色里：" + "、".join(missing[:4]) + "。",
                    "重新生成分镜，或在分镜卡片的「出场角色」里补上他们。",
                )
            )

    # ------------------------------------------------------------------
    # 5) 商品：在分镜里出现且覆盖 ≥ 一半（与确认落库同一口径）
    # ------------------------------------------------------------------
    if not product_name:
        if coerce_str(brief_product_name):
            issues.append(
                _issue(
                    CODE_PRODUCT_MISSING_IN_PLAN,
                    LEVEL_WARNING,
                    f"商品信息里有「{coerce_str(brief_product_name)}」，但策划里还没有商品资产："
                    "分镜里不会出现商品，确认后也建不出商品关联。",
                    "重新生成一次剧情方案，或在草稿里补上商品信息。",
                )
            )
        # 分镜标了商品但没有商品资产 = 悬空资产引用（确认落库时那些标记会被丢掉）
        dangling = [shot for shot in shots if bool(shot.get("product_present"))]
        if dangling:
            issues.append(
                _issue(
                    CODE_UNKNOWN_ASSET,
                    LEVEL_ERROR,
                    f"{len(dangling)} 个镜头标了「出现商品」，但剧情方案里没有商品资产。",
                    "补上商品信息，或把这些镜头改回「不出现商品」。",
                )
            )
    elif product_shots == 0:
        issues.append(
            _issue(
                CODE_PRODUCT_COVERAGE_LOW,
                LEVEL_ERROR,
                f"商品「{product_name}」在 {len(shots)} 个镜头里一次都没有出现。",
                "把商品自然写进剧情（被人使用/被抢/被特写），再重新生成分镜。",
            )
        )
    elif shots and product_shots < need:
        issues.append(
            _issue(
                CODE_PRODUCT_COVERAGE_LOW,
                LEVEL_ERROR,
                f"商品「{product_name}」只出现在 {product_shots}/{len(shots)} 个镜头里，"
                f"少于要求的一半（{need} 个）。",
                "在草稿里把更多镜头标成「出现商品」，或重新生成分镜让商品自然进入更多镜头。",
            )
        )

    # ------------------------------------------------------------------
    # 6) 未知资产引用：编辑器给分镜挂了资产名/ID 时，逐个核对是否在计划里
    # ------------------------------------------------------------------
    catalog: set[str] = {*characters, *scenes}
    if product_name:
        catalog.add(product_name)
    unknown_assets: list[str] = []
    for shot in shots:
        for field in _SHOT_ASSET_FIELDS:
            for value in _as_list(shot.get(field)):
                text = coerce_str(value if not isinstance(value, dict) else value.get("name"))
                if text and text not in catalog and text not in unknown_assets:
                    unknown_assets.append(text)
    if unknown_assets:
        issues.append(
            _issue(
                CODE_UNKNOWN_ASSET,
                LEVEL_ERROR,
                "分镜引用了方案里不存在的资产：" + "、".join(f"「{name}」" for name in unknown_assets[:4]) + "。",
                "把这些资产补进人物表/场景表/商品，或从分镜里去掉这个引用。",
            )
        )

    # ------------------------------------------------------------------
    # 7) 剧情与分镜是不是同一件事：关键词零重合 → 提示（多来自"改过剧情没重生成分镜"）
    # ------------------------------------------------------------------
    shots_text = " ".join(_shot_text(shot) for shot in shots)
    if full_text and shots_text.strip():
        overlap = keywords(full_text) & keywords(shots_text)
        if not overlap:
            issues.append(
                _issue(
                    CODE_STORY_SHOTS_UNRELATED,
                    LEVEL_WARNING,
                    "分镜和完整剧情读起来不是同一件事：两者几乎没有共同的人名、场景或关键动作。",
                    "用当前完整剧情重新生成一次分镜（改过剧情之后原有分镜就过期了）。",
                )
            )
        climax_text = f"{coerce_str(story.get('climax'))} {coerce_str(story.get('conflict'))}".strip()
        if (
            coerce_str(story.get("climax"))
            and climax_text
            and not (keywords(climax_text) & keywords(shots_text))
        ):
            issues.append(
                _issue(
                    CODE_CLIMAX_MISSING_IN_SHOTS,
                    LEVEL_WARNING,
                    "核心冲突与结局在分镜里找不到对应：分镜可能只拆了开头。",
                    "重新生成分镜，或在分镜里补上与高潮反转对应的镜头。",
                )
            )

    errors = sum(1 for item in issues if item["level"] == LEVEL_ERROR)
    warnings = len(issues) - errors
    summary = {
        "errors": errors,
        "warnings": warnings,
        "shots": len(shots),
        "product_shots": product_shots,
        "product_required": need,
        "story_chars": len(full_text),
        "characters": len(characters),
        "scenes": len(scenes),
        "text": _summary_text(
            errors=errors, warnings=warnings, shots=len(shots), product_shots=product_shots,
            need=need, product_name=product_name, story_chars=len(full_text),
        ),
    }
    return {"ok": errors == 0, "issues": issues, "summary": summary}


def _summary_text(
    *,
    errors: int,
    warnings: int,
    shots: int,
    product_shots: int,
    need: int,
    product_name: str,
    story_chars: int,
) -> str:
    """一句话总结（用户语言；无问题时也要说清"检查了什么"）。"""
    if errors or warnings:
        parts: list[str] = []
        if errors:
            parts.append(f"{errors} 处需要处理")
        if warnings:
            parts.append(f"{warnings} 处提醒")
        return "；".join(parts) + "（详见下面的问题列表）。"
    pieces = []
    if shots:
        pieces.append(f"{shots} 个镜头")
    if product_name:
        pieces.append(f"商品覆盖 {product_shots}/{shots or 0}（要求 ≥{need}）")
    if story_chars:
        pieces.append(f"剧情 {story_chars} 字")
    return "一致性检查通过" + ("：" + "，".join(pieces) if pieces else "。") + "。"


__all__ = [
    "LEVEL_ERROR",
    "LEVEL_WARNING",
    "STORY_BLOCKS",
    "check_plan_consistency",
    "keywords",
]
