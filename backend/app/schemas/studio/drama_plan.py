"""「广告剧情流程」的请求 / 响应 DTO。

为什么单独一个文件而不是塞进 ``schemas/studio/llm_orchestration.py``：
那条链路上的三个预览服务（实体提取 / 图片提示词 / 视频提示词）共用一套
「输入 → 预览 → meta」形状；剧情方案则是**一次调用产出一整份结构化草稿**，
字段量与嵌套层级都不同，混在一起会让两边都难读。

边界（与全量方案一致）
======================

- ``DramaBrief`` 是**用户输入**：免费保存，永不触发模型调用；
- ``DramaPlanDraft`` 是**模型产物的归一化结果**：只存 ``drama_plan_drafts.plan`` 草稿列，
  确认之前不落任何正式行；
- 落正式产物只有 ``confirm`` 一条路（见 ``drama_plan_materialize``）。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

#: 默认镜头数（与「典型 6 镜」的用户口径一致；``generate`` 会把它写进提示词）
DEFAULT_SHOT_COUNT = 6

# ---------------------------------------------------------------------------
# 分层生成的阶段（实施契约 §二「剧情（分层，按阶段生成）」）
#
# 为什么要有阶段：一次调用出全部（``all``）在"人物表与镜头对不上"这件事上最省事，
# 但用户流程是**逐步确认**的（一句话 → 完整剧情 → 分镜），每一步都要能单独重生成、
# 单独回退。阶段化之后每次调用的输入是**上一步已确认的结果**，模型不需要重新猜。
# ---------------------------------------------------------------------------

#: 生成阶段字面量（请求体与响应都复用它，避免前端与后端各写一套字符串）
DramaPlanStage = Literal["one_liner", "story", "storyboard", "all"]

#: 阶段常量（代码里比较用，别写字面量）
STAGE_ONE_LINER = "one_liner"
STAGE_STORY = "story"
STAGE_STORYBOARD = "storyboard"
STAGE_ALL = "all"

#: 全部合法阶段（校验用）
STAGES: tuple[str, ...] = (STAGE_ONE_LINER, STAGE_STORY, STAGE_STORYBOARD, STAGE_ALL)

#: 缺省阶段 = ``all``：**向后兼容**（旧请求不带 stage 时行为与以前完全一致）
DEFAULT_STAGE: str = STAGE_ALL

#: 阶段的中文名（错误明细与页面提示共用一份）
STAGE_LABELS: dict[str, str] = {
    STAGE_ONE_LINER: "一句话核心创意",
    STAGE_STORY: "完整剧情",
    STAGE_STORYBOARD: "分镜",
    STAGE_ALL: "完整剧情方案",
}


class DramaBrief(BaseModel):
    """商品与导演要求（用户填写）。"""

    model_config = ConfigDict(extra="forbid")

    product_name: str = Field("", description="商品名称（同时用作自动建章节时的标题）")
    product_description: str = Field("", description="商品外观描述（会作为商品资产的外观描述）")
    selling_points: list[str] = Field(default_factory=list, description="卖点列表")
    target_audience: str = Field("", description="目标人群")
    genre: str = Field("", description="题材（与项目 style 对齐，缺省沿用项目）")
    tone: str = Field("", description="调性（例如：一本正经地荒诞 / 温情 / 爽感）")
    duration_seconds: int = Field(0, description="整片目标时长（秒），0 = 由镜头数与档位推算")
    shot_count: int = Field(DEFAULT_SHOT_COUNT, description="期望镜头数")
    brand_voice: str = Field("", description="品牌调性 / 品牌规则")
    mandatory_elements: list[str] = Field(default_factory=list, description="必须出现的内容")
    forbidden_elements: list[str] = Field(default_factory=list, description="禁止出现的内容")
    director_notes: str = Field("", description="导演备注（本次的额外要求）")


class DramaPlanDialogueDraft(BaseModel):
    """一句台词（对应正式产物 ``shot_dialog_lines`` 的一行）。"""

    model_config = ConfigDict(extra="forbid")

    speaker: str = Field("", description="说话角色名（必须出现在 characters 里）")
    text: str = Field("", description="台词内容")
    mode: str = Field("DIALOGUE", description="DIALOGUE / VOICE_OVER / OFF_SCREEN / PHONE")


class DramaPlanShotDraft(BaseModel):
    """一个镜头（对应正式产物 ``shots`` + ``shot_details`` + ``shot_dialog_lines``）。"""

    model_config = ConfigDict(extra="forbid")

    index: int = Field(1, description="镜头序号（章节内唯一）")
    title: str = Field("", description="镜头标题")
    characters: list[str] = Field(
        default_factory=list, description="本镜出场角色名（必须出现在 characters 里；决定建哪些镜头↔角色关联）"
    )
    script_excerpt: str = Field("", description="剧本摘录（写进 shots.script_excerpt）")
    description: str = Field("", description="镜头整体描述（写进 shot_details.description）")
    duration: int = Field(0, description="时长（秒，已归一到允许档位）")
    camera_shot: str = Field("", description="景别 code（ECU/CU/MCU/MS/MLS/LS/ELS）")
    angle: str = Field("", description="机位 code（EYE_LEVEL/HIGH_ANGLE/...）")
    movement: str = Field("", description="运镜 code（STATIC/PAN/...）")
    action_beats: list[str] = Field(default_factory=list, description="动作拍点（按时间顺序）")
    dialogue: list[DramaPlanDialogueDraft] = Field(default_factory=list, description="本镜台词")
    product_present: bool = Field(False, description="本镜是否出现商品（决定是否建 shot 档关联行）")


class DramaPlanStoryDraft(BaseModel):
    """完整剧情（``plan.story``，实施契约 §二 的 ``plan`` JSON 结构）。

    为什么把"完整剧情全文"和五个结构块放在一起：页面既要一个"可读可编辑的大文本框"
    （``full_text``，确认落库时写进 ``chapters.raw_text``），也要能分栏展示钩子/冲突/
    商品介入/高潮/结尾引导。两块内容来自同一次模型调用，所以放在同一个 DTO 里归一。

    字段**缺省一律留空**（不做任何编造）：模型没给就是没给，页面据此显示"待补充"。
    """

    model_config = ConfigDict(extra="forbid")

    full_text: str = Field("", description="完整剧情全文（分段的可读文本；确认时落 chapters.raw_text）")
    hook: str = Field("", description="开场钩子（前 3 秒的动作冲突）")
    conflict: str = Field("", description="核心冲突")
    product_usage: str = Field("", description="商品如何自然介入（不要念参数）")
    climax: str = Field("", description="高潮与反转")
    cta: str = Field("", description="结尾引导（自然的购买暗示，不是硬 CTA）")


class DramaPlanNamedAssetDraft(BaseModel):
    """角色 / 场景 / 商品共用的草稿形状。"""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., description="名称（正式产物里是 name 列）")
    relation: str = Field("", description="人物关系（角色专用：与主角/其他人的关系；场景/商品留空）")
    profile: dict[str, str] = Field(default_factory=dict, description="结构化资料（键见 asset_profiles）")
    shot_indexes: list[int] = Field(default_factory=list, description="出现在哪些镜头（仅草稿信息）")


class DramaPlanProductDraft(DramaPlanNamedAssetDraft):
    """商品草稿（比角色/场景多一个外观描述，直接落 products.description）。"""

    description: str = Field("", description="商品外观描述")


class DramaPlanDraft(BaseModel):
    """模型产物归一化后的完整草稿。"""

    model_config = ConfigDict(extra="forbid")

    title: str = Field("", description="标题（落 chapters.title）")
    logline: str = Field("", description="一句话主线（落 chapters.summary）")
    one_liner: str = Field("", description="一句话核心创意（分层生成的第 1 步产物）")
    audience_emotion: str = Field("", description="想让目标受众产生的情绪（分层生成第 1 步的产物）")
    story: DramaPlanStoryDraft = Field(
        default_factory=DramaPlanStoryDraft, description="完整剧情（分层生成第 2 步产物；缺字段留空）"
    )
    selling_points: list[str] = Field(default_factory=list, description="被剧情化后的卖点")
    characters: list[DramaPlanNamedAssetDraft] = Field(default_factory=list)
    scenes: list[DramaPlanNamedAssetDraft] = Field(default_factory=list)
    product: DramaPlanProductDraft | None = Field(None, description="商品（缺省 = 本次没有商品）")
    shots: list[DramaPlanShotDraft] = Field(default_factory=list)
    climax: str = Field("", description="结尾反转 / 高潮")
    warnings: list[str] = Field(default_factory=list, description="归一化过程中的如实警告")


class DramaPlanGenerateRequest(BaseModel):
    """``POST .../drama-plan/generate`` 的请求体（两个字段都有默认值：**向后兼容**）。"""

    model_config = ConfigDict(extra="forbid")

    stage: DramaPlanStage = Field(DEFAULT_STAGE, description="生成阶段：one_liner / story / storyboard / all")
    confirm_overwrite: bool = Field(
        False,
        description="人工编辑晚于上次生成时，必须显式传 true 才允许覆盖（否则 409）",
    )


class DramaPlanStaleFlags(BaseModel):
    """过期标记（``drama_plan_drafts.stale_flags``）：改了上一步就标下一步过期。

    为什么用"时间戳 + 派生布尔"而不是只存布尔：布尔只能表达"现在过期了"，
    时间戳还能回答"过期是怎么来的"（改过一句话、还是改过完整剧情），
    重生成之后布尔会自动回到 false（生成时间晚于改动时间），不需要额外的清除逻辑。

    ``model_config.extra="ignore"``：老行里可能有别的键，读到不该炸（读模型只负责下发）。
    """

    model_config = ConfigDict(extra="ignore")

    one_liner_changed_at: str = Field("", description="一句话核心创意最后一次被改动的时间（ISO 串）")
    story_changed_at: str = Field("", description="完整剧情最后一次被改动的时间（ISO 串）")
    story_generated_at: str = Field("", description="完整剧情最后一次由模型生成的时间（ISO 串）")
    shots_generated_at: str = Field("", description="分镜最后一次由模型生成的时间（ISO 串）")
    story_stale: bool = Field(False, description="一句话改过之后没重新生成完整剧情 → true")
    shots_stale: bool = Field(False, description="完整剧情改过之后没重新生成分镜 → true")
    reasons: list[str] = Field(default_factory=list, description="给用户看的中文过期原因（空 = 没有任何过期）")


class DramaPlanConsistencyIssue(BaseModel):
    """一条一致性问题（消息用用户语言，``fix`` 是他能做的动作）。"""

    model_config = ConfigDict(extra="forbid")

    code: str = Field(..., description="机器可读代号（例如 product_coverage_low）")
    level: str = Field("warning", description="error（会挡住确认落库）/ warning（提示但不挡）")
    message: str = Field("", description="给用户看的中文说明（不带字段名与接口名）")
    fix: str = Field("", description="建议怎么改")


class DramaPlanConsistencySummary(BaseModel):
    """一致性检查的摘要（页面顶部一行提示 + 技术详情收起时用）。"""

    model_config = ConfigDict(extra="forbid")

    errors: int = Field(0, description="error 级问题数")
    warnings: int = Field(0, description="warning 级问题数")
    shots: int = Field(0, description="镜头总数")
    product_shots: int = Field(0, description="出现商品的镜头数")
    product_required: int = Field(0, description="「至少一半」要求的镜头数")
    story_chars: int = Field(0, description="完整剧情全文的字符数")
    characters: int = Field(0, description="人物表里的人物数")
    scenes: int = Field(0, description="场景表里的场景数")
    text: str = Field("", description="一句话总结（用户语言）")


class DramaPlanConsistencyRead(BaseModel):
    """一致性检查结果（**免费**出口，不调用模型）。"""

    model_config = ConfigDict(extra="forbid")

    chapter_id: str = ""
    ok: bool = Field(True, description="没有任何 error 级问题 → true")
    issues: list[DramaPlanConsistencyIssue] = Field(default_factory=list)
    summary: DramaPlanConsistencySummary = Field(default_factory=DramaPlanConsistencySummary)
    note: str = Field("", description="边界说明（由服务层填）")


class DramaPlanRead(BaseModel):
    """草稿读取（``GET`` 与 ``generate`` 共用同一形状）。"""

    model_config = ConfigDict(extra="forbid")

    chapter_id: str = ""
    project_id: str = ""
    has_draft: bool = Field(False, description="是否已保存过 brief（即草稿行是否存在）")
    status: str = Field("", description='""（未生成）/ running / ok / failed')
    brief: DramaBrief = Field(default_factory=DramaBrief)
    plan: DramaPlanDraft | None = Field(None, description="归一化后的草稿；未生成过则为 null")
    stale_flags: DramaPlanStaleFlags = Field(
        default_factory=DramaPlanStaleFlags, description="过期标记（一句话/完整剧情改过之后的提示依据）"
    )
    consistency: DramaPlanConsistencyRead | None = Field(
        None, description="一致性检查摘要（免费、确定性；空草稿时为 null）"
    )
    error: str = Field("", description="失败原因")
    model: str = Field("", description="本次生成使用的模型名")
    meta: dict[str, Any] = Field(default_factory=dict, description="运行元信息（不含任何密钥）")
    claim_expires_at: str = Field("", description="生成中租约的到期时间（ISO 串，空 = 无租约）")
    updated_at: str = Field("", description="草稿行最后更新时间（ISO 串）")
    note: str = Field("", description="边界说明")


class DramaPlanNextStep(BaseModel):
    """确认策划之后的**下一个主操作**（契约 §三.5：页面据此把按钮换成「继续准备资产」）。

    为什么给两个 URL：契约里写的 ``url`` 不带章节参数，而第 2 步的工作台按**章节**取镜头资产，
    少了参数它会自己再找一次章节（找到的可能不是刚确认的这一集）。所以 ``url`` 保持契约原文，
    ``chapter_url`` 是带上刚确认这一章的那一份，页面优先用它。
    """

    model_config = ConfigDict(extra="forbid")

    label: str = Field("", description="按钮文字（例如「继续准备资产」）")
    url: str = Field("", description="契约口径的下一步 URL（不带章节参数）")
    chapter_url: str = Field("", description="带 chapter 参数的下一步 URL（页面优先用这个）")


class DramaPlanConfirmRead(BaseModel):
    """确认落库结果（materialize；**幂等**：第二次确认不新增任何镜头/资产）。"""

    model_config = ConfigDict(extra="forbid")

    chapter_id: str = ""
    shots_created: int = Field(0, description="本次新建的镜头数（第二次确认为 0）")
    shots_updated: int = Field(0, description="就地更新的镜头数（第一次确认为 0）")
    dialog_lines_created: int = 0
    dialog_lines_updated: int = Field(0, description="就地更新的台词行数")
    characters_created: int = 0
    scenes_created: int = 0
    product_created: bool = False
    assets_created: int = Field(0, description="本次新建的资产总数（人物 + 场景 + 商品）")
    assets_reused: int = Field(0, description="复用的既有资产数（同名即同一个资产，不重复建）")
    materials_linked: int = Field(0, description="本次登记的来源关系行数（幂等复核：第二次确认应为 0）")
    shot_product_links: int = Field(0, description="带商品的镜头数（用于「至少一半镜头」核对）")
    shot_character_links: int = 0
    warnings: list[str] = Field(default_factory=list)
    skipped: list[str] = Field(default_factory=list, description="没落的东西 + 为什么（不静默）")
    next_step: DramaPlanNextStep = Field(
        default_factory=DramaPlanNextStep, description="下一步（页面据此换按钮）"
    )
    note: str = Field("", description="边界说明（由服务层填，路由同时放进 meta）")


__all__ = [
    "DEFAULT_SHOT_COUNT",
    "DEFAULT_STAGE",
    "STAGE_ALL",
    "STAGE_LABELS",
    "STAGE_ONE_LINER",
    "STAGE_STORY",
    "STAGE_STORYBOARD",
    "STAGES",
    "DramaBrief",
    "DramaPlanConfirmRead",
    "DramaPlanConsistencyIssue",
    "DramaPlanConsistencyRead",
    "DramaPlanConsistencySummary",
    "DramaPlanDialogueDraft",
    "DramaPlanDraft",
    "DramaPlanGenerateRequest",
    "DramaPlanNamedAssetDraft",
    "DramaPlanNextStep",
    "DramaPlanProductDraft",
    "DramaPlanRead",
    "DramaPlanShotDraft",
    "DramaPlanStage",
    "DramaPlanStaleFlags",
    "DramaPlanStoryDraft",
]
