"""Project/Chapter 的请求响应模型。"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.studio import ChapterStatus, ProjectStartMode, ProjectStyle, ProjectVisualStyle


PROJECT_STYLE_EXAMPLES = [x.value for x in ProjectStyle]

#: 项目类型：`drama`=普通短剧；`ad`=剧情广告（先做商品卡与剧情策划，再进五步流程）。
#: 单独一列而不是复用 `start_mode`：`start_mode` 表达"从哪开始生产"（剧本/提示词），
#: 而这里是"这是什么项目"，两者的语义与消费者都不同（列表徽标、策划入口都认这一列）。
ProjectKind = Literal["drama", "ad"]


class AdProductSource(BaseModel):
    """剧情广告项目创建时的「商品资料来源」。

    **不在创建时调用模型**：这里只把来源登记下来（原文/文件/已有商品），
    真正的"提取"是策划页上一个显式的付费动作（见 `POST .../product-card/extract`）。
    """

    model_config = ConfigDict(extra="forbid")

    type: Literal["manual", "paste", "upload", "existing"] = "manual"
    text: str = Field("", description="粘贴的商品文案（type=paste）")
    file_ids: list[str] = Field(default_factory=list, description="上传的资料文件 ID（type=upload）")
    product_id: str = Field("", description="选用的已有商品资产 ID（type=existing）")


class AdRequirements(BaseModel):
    """创建时填的「基本制作要求」（会写进该项目的策划 brief，策划页可直接看到并修改）。"""

    model_config = ConfigDict(extra="forbid")

    genre: str = Field("", description="题材（留空沿用项目 style）")
    tone: str = Field("", description="调性")
    shot_count: int = Field(6, ge=1, le=16, description="期望镜头数")
    duration_seconds: int = Field(0, ge=0, description="整片目标时长（秒），0=自动")
    director_notes: str = Field("", description="导演备注")
    mandatory_elements: list[str] = Field(default_factory=list, description="必须出现")
    forbidden_elements: list[str] = Field(default_factory=list, description="禁止出现")


class ProjectBase(BaseModel):
    name: str = Field(..., description="项目名称")
    description: str = Field("", description="项目简介")
    # style 允许自由文本（自定义风格），预设枚举值仍作为候选项下发。
    # 长度上限 32 与 projects.style 列的 String(32) 对齐，避免写入后读回不一致。
    style: str = Field(
        ...,
        max_length=32,
        description="题材/风格（可用预设值，也可自定义）",
        examples=PROJECT_STYLE_EXAMPLES,
    )
    visual_style: ProjectVisualStyle = Field(ProjectVisualStyle.live_action, description="画面表现形式")
    seed: int = Field(0, description="随机种子")
    unify_style: bool = Field(True, description="是否统一风格")
    progress: int = Field(0, description="进度百分比（0-100）")
    default_video_ratio: str | None = Field(None, description="项目级默认视频比例；分镜未覆盖时生效")
    start_mode: ProjectStartMode = Field(
        ProjectStartMode.script,
        description="项目起点：script=从剧本开始；prompts=从视频提示词开始",
    )
    kind: ProjectKind = Field(
        "drama",
        description="项目类型：drama=普通短剧；ad=剧情广告（先做商品卡与剧情策划）",
    )

    @field_validator("start_mode", mode="before")
    @classmethod
    def _default_start_mode(cls, value: object) -> object:
        """`None` 按 `script` 处理。

        覆盖两种情况：① 迁移前写入、尚未回填的历史行；② 内存中刚构造还没 flush 的
        ORM 对象（列默认值此时还没生效）。两者都不该让响应校验 500。
        """
        return ProjectStartMode.script if value is None else value

    @field_validator("kind", mode="before")
    @classmethod
    def _default_kind(cls, value: object) -> object:
        """`None` 按 `drama` 处理（**与 `start_mode` 同一个理由**）。

        迁移把 `projects.kind` 的默认值定成 `'drama'`（旧行行为不变），但 ORM 的 Python
        默认值只在 flush 时生效：内存里刚构造还没 flush 的 `Project(...)` 读出来是 `None`，
        直接撞 `Literal["drama","ad"]` 会让响应校验 500（列表排序那支测试正是这么撞的）。
        """
        return "drama" if value is None else value
    stats: dict[str, Any] = Field(default_factory=dict, description="聚合统计（JSON）")


class ProjectCreate(ProjectBase):
    id: str = Field(..., description="项目 ID")
    # 剧情广告专用（kind=ad）：创建向导把"商品资料来源 + 基本制作要求"一起带进来，
    # 后端在**同一事务**里建默认章节、登记商品卡来源、写好策划 brief。
    ad_product_source: AdProductSource | None = Field(None, description="商品资料来源（仅 kind=ad）")
    ad_requirements: AdRequirements | None = Field(None, description="基本制作要求（仅 kind=ad）")


class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    style: str | None = Field(None, max_length=32, description="题材/风格（可用预设值，也可自定义）", examples=PROJECT_STYLE_EXAMPLES)
    visual_style: ProjectVisualStyle | None = None
    seed: int | None = None
    unify_style: bool | None = None
    progress: int | None = None
    default_video_ratio: str | None = None
    start_mode: ProjectStartMode | None = None
    stats: dict[str, Any] | None = None


class ProjectRead(ProjectBase):
    model_config = ConfigDict(from_attributes=True)

    id: str
    # 时间戳下发给前端：项目列表按真实创建时间排序并在卡片上显示，
    # 而不是像以前那样用前端 `stats.updated_at`（后端从不写入）回退成「当前时间」。
    created_at: datetime | None = Field(None, description="创建时间")
    updated_at: datetime | None = Field(None, description="最后更新时间")
    #: 剧情广告项目的当前阶段（用户语言，见 `ad_flow_service.AD_PHASE_LABELS`）。
    #: 非广告项目恒为空串 —— 它只描述"剧情广告这条链走到哪了"。
    ad_phase: str = Field("", description="剧情广告阶段（仅 kind=ad）：product/story/storyboard/ready/confirmed")
    ad_phase_label: str = Field("", description="剧情广告阶段的中文说明（页面直接用）")


class ProjectCreateRead(ProjectRead):
    """创建项目后的响应：多一个 `chapter_id`。

    为什么需要它：剧情广告创建后要**直接进剧情策划页**，而策划页是章节级的；
    让创建接口把"刚建好的默认章节"回给前端，页面就不必再猜/再查一次
    （少一次往返，也避免创建成功却进不去策划页的中间态）。
    """

    chapter_id: str = Field("", description="自动建立的默认章节 ID（kind=ad 时必定有值）")


class ChapterBase(BaseModel):
    project_id: str = Field(..., description="所属项目 ID")
    index: int = Field(..., description="章节序号（项目内唯一）")
    title: str = Field(..., description="章节标题")
    summary: str = Field("", description="章节摘要")
    raw_text: str = Field("", description="章节原文")
    condensed_text: str = Field("", description="精简原文")
    storyboard_count: int = Field(0, description="分镜数量")
    status: ChapterStatus = Field(ChapterStatus.draft, description="章节状态")


class ChapterCreate(ChapterBase):
    id: str = Field(..., description="章节 ID")


class ChapterUpdate(BaseModel):
    project_id: str | None = None
    index: int | None = None
    title: str | None = None
    summary: str | None = None
    raw_text: str | None = None
    condensed_text: str | None = None
    storyboard_count: int | None = None
    status: ChapterStatus | None = None


class ChapterRead(ChapterBase):
    model_config = ConfigDict(from_attributes=True)

    id: str
    shot_count: int = Field(0, description="分镜数（shots 条数聚合）")


class StyleOption(BaseModel):
    """通用下拉选项。"""

    value: str = Field(..., description="选项值")
    label: str = Field(..., description="选项展示文案")


class ProjectStyleOptionsRead(BaseModel):
    """项目风格候选项。"""

    visual_styles: list[StyleOption] = Field(default_factory=list, description="视觉风格可选项")
    styles_by_visual_style: dict[str, list[StyleOption]] = Field(
        default_factory=dict,
        description="按视觉风格分组的视频风格选项",
    )
    default_style_by_visual_style: dict[str, str] = Field(
        default_factory=dict,
        description="各视觉风格默认视频风格",
    )
