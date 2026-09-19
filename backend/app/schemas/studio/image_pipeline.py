"""P3 出图管线（出图服务 HTTP 对接 / 提示词包导出）的请求与响应模型。

约定：
- 所有 preview 接口**不触网**；
- 所有 submit 接口默认走 DRY_RUN，返回 ``dry_run: true`` 的占位结果；
- 任何字段都不包含 provider 的 api_key。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

AssetTypeLiteral = Literal["character", "scene", "prop", "costume"]
StageLiteral = Literal["character_sheet", "reference_batch"]
PackageFormatLiteral = Literal["json", "text", "markdown"]


# ---------------------------------------------------------------------------
# 公共
# ---------------------------------------------------------------------------


class ReferenceImageRead(BaseModel):
    """定版参考图（垫图）解析结果。"""

    asset_id: str
    asset_type: str
    file_id: str = ""
    url: str = Field("", description="对象存储公共地址（OSS URL 优先）")
    view_angle: str = ""
    quality_level: str = ""
    is_primary: bool = Field(False, description="是否为人工定版主图")
    resolved_from: str = Field("", description="is_primary / fallback")
    warnings: list[str] = Field(default_factory=list)


class SubmissionTargetRead(BaseModel):
    """一个待提交给出图服务的单资产单图任务（预览用）。"""

    source_task_id: str = Field(..., description="幂等键；同资产同提示词重复提交不会重复出图")
    source_asset_id: str
    asset_type: str
    name: str = ""
    prompt: str = ""
    stage: str = ""
    negative_prompt: str = ""
    style_tags: list[str] = Field(default_factory=list)
    reference_image: str = Field("", description="垫图地址（定版主图）")
    generation_type: str = ""
    aspect_ratio: str = ""
    image_model: str = ""
    object_key_template: str = ""
    prompt_source: str = Field(
        "template",
        description="提示词来源：request（调用方显式传）/ saved（已保存的 image_prompts）/ template（确定性模板）",
    )
    warnings: list[str] = Field(default_factory=list)


class ImageTaskResultRead(BaseModel):
    """一次出图提交的结果。"""

    source_task_id: str
    source_asset_id: str
    asset_type: str = ""
    stage: str = ""
    service_task_id: str = ""
    status: str = ""
    ok: bool = True
    dry_run: bool = False
    image_url: str = Field("", description="出图服务的本地/临时地址（非长期资产）")
    oss_url: str = Field("", description="长期资产地址；DRY_RUN 下为空")
    message: str = ""


class ImageServiceStatusRead(BaseModel):
    """出图服务对接状态。"""

    base_url: str
    configured_env: str
    guard: dict[str, Any]
    service_asset_types: list[str]
    generation_types: dict[str, str]
    probe: dict[str, Any] | None = Field(None, description="真实健康探测结果；DRY_RUN 下为 null")
    probe_skipped_reason: str = Field("", description="未探测的原因")


# ---------------------------------------------------------------------------
# 请求
# ---------------------------------------------------------------------------


class PromptOverride(BaseModel):
    """调用方用 P1 生成的逐槽位提示词覆盖确定性提示词。"""

    asset_id: str
    prompt: str


class ImagePlanPreviewRequest(BaseModel):
    """出图提交计划预览请求（不触网）。"""

    project_id: str = Field(..., min_length=1)
    asset_type: AssetTypeLiteral = Field("character", description="出图服务只支持 character/scene/prop")
    stage: StageLiteral = Field("character_sheet", description="定妆照阶段不带垫图；垫图批量阶段带定版垫图")
    asset_ids: list[str] = Field(default_factory=list, description="为空表示项目内该类型全部资产")
    prompt_overrides: list[PromptOverride] = Field(default_factory=list, description="用 P1 生成的提示词覆盖")
    use_primary_reference: bool = Field(True, description="垫图批量阶段是否使用定版主图做垫图")
    aspect_ratio: str = Field("", description="出图比例，如 16:9")
    image_model: str = Field("", description="图片模型选项（留空=默认 image2 → provider 模型 gpt-image-2）")
    negative_prompt: str = Field("", description="全局负面提示词")


class ImageSubmitRequest(ImagePlanPreviewRequest):
    """出图提交请求（受 DRY_RUN 守卫）。"""

    wait_seconds: float = Field(0.0, ge=0.0, le=120.0, description="有界等待产物秒数；0 表示不等")


class ImagePlanPreviewRead(BaseModel):
    """出图提交计划预览。"""

    project_id: str
    asset_type: str
    stage: str
    targets: list[SubmissionTargetRead] = Field(default_factory=list)
    references: list[ReferenceImageRead] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    summary: dict[str, Any] = Field(default_factory=dict)
    dry_run: bool = Field(True, description="当前守卫状态；preview 永远不触网")
    note: str = Field(
        "仅为提交计划预览，未调用出图服务；确认后走 POST /image-pipeline/submit。",
        description="边界说明",
    )


class ImageSubmitRead(BaseModel):
    """出图提交结果。"""

    project_id: str
    asset_type: str
    stage: str
    results: list[ImageTaskResultRead] = Field(default_factory=list)
    summary: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    guard_status: str = ""
    note: str = Field(
        "DRY_RUN 下为占位结果；真实模式下结果由出图服务上传 OSS，"
        "oss_url 才是长期资产地址（image_url 仅为本地/临时地址）。",
        description="边界说明",
    )


class AdoptImageRequest(BaseModel):
    """把生成出来的图片采纳进资产图片槽位（断点③：刷新后仍在）。"""

    entity_type: str = Field(..., description="资产类型：character / scene / prop / costume / actor")
    entity_id: str = Field(..., min_length=1, description="资产 ID")
    url: str = Field(..., min_length=1, description="生成图片的可访问地址（不能是 DRY_RUN 占位地址）")
    image_id: int | None = Field(None, description="目标图片槽位 ID；为空则复用该资产第一个槽位，没有就新建")
    set_primary: bool = Field(True, description="是否同时设为定版主图")
    name: str = Field("", description="入库文件名（可空）")


class AdoptImageRead(BaseModel):
    """采纳结果。"""

    entity_type: str
    entity_id: str
    image_id: int
    file_id: str
    url: str = Field(..., description="落库后可访问地址（资产页与垫图实际使用的就是这个）")
    source_url: str = Field("", description="采纳时传入的来源地址，仅供溯源")
    is_primary: bool = False
    name: str = ""
    note: str = Field(
        "已写入 files 与对应图片槽位；刷新资产页即可看到，并可作为后续垫图使用。",
        description="边界说明",
    )


class ImageTaskQueryRead(BaseModel):
    """出图任务查询结果（回读 OSS 地址）。"""

    service_task_id: str
    status: str = ""
    oss_url: str = ""
    local_path: str = ""
    images: list[dict[str, Any]] = Field(default_factory=list)
    error_message: str = ""
    dry_run: bool = False


# ---------------------------------------------------------------------------
# 提示词包导出
# ---------------------------------------------------------------------------


class PromptPackageRequest(BaseModel):
    """提示词包导出请求（只读，不落库、不出图）。"""

    project_id: str = Field(..., min_length=1)
    shot_ids: list[str] = Field(default_factory=list, description="为空表示项目内全部镜头（上限见 max_shots）")
    max_shots: int = Field(20, ge=1, le=100)
    include_image_prompts: bool = Field(True)
    include_video_prompts: bool = Field(True)
    include_bindings: bool = Field(True)
    format: PackageFormatLiteral = Field("json", description="同时返回 json；text/markdown 为附带的渲染结果")


class PromptPackageShotRead(BaseModel):
    """单个镜头的提示词包条目。"""

    shot_id: str
    index: int = 0
    title: str = ""
    script_excerpt: str = ""
    bound_assets: dict[str, list[str]] = Field(default_factory=dict, description="已绑定资产（按槽位）")
    image_prompts: list[dict[str, Any]] = Field(default_factory=list, description="逐槽位图片提示词")
    video_prompt: dict[str, Any] | None = Field(None, description="视频提示词（含首尾帧与运镜）")
    references: list[ReferenceImageRead] = Field(default_factory=list, description="可作参考图的定版资产")
    warnings: list[str] = Field(default_factory=list)


class PromptPackageRead(BaseModel):
    """提示词包导出结果。"""

    project_id: str
    shots: list[PromptPackageShotRead] = Field(default_factory=list)
    rendered_text: str = ""
    rendered_markdown: str = ""
    warnings: list[str] = Field(default_factory=list)
    meta: dict[str, Any] = Field(default_factory=dict)
    note: str = Field("仅为提示词包预览，未写入任何表、未提交任何出图/出视频任务。", description="边界说明")


# ---------------------------------------------------------------------------
# 直提出视频
# ---------------------------------------------------------------------------


class VideoSubmitPlanRequest(BaseModel):
    """直提出视频的计划预览请求（不触网、不建任务）。"""

    shot_id: str = Field(..., min_length=1)
    reference_mode: str = Field(
        "first",
        description="参考图模式，对齐既有契约：first / last / key / first_last / first_last_key / text_only",
    )
    prompt: str = Field("", description="留空则由 P1 视频提示词服务生成")
    images: list[str] = Field(default_factory=list, description="显式参考图；为空则按 mode 解析")
    ratio: str = Field("", description="视频比例")
    duration_seconds: int | None = Field(None, ge=1, le=60)
    generate_audio: bool | None = Field(
        None,
        description="是否让模型自带音频（供应商开关，seedance 默认 true）。"
        "设为 false 时模型不会自己生成音频，便于验证参考音频是否被采用。",
    )


class VideoSubmitRequest(VideoSubmitPlanRequest):
    """直提出视频（受 DRY_RUN 守卫；默认被拦截）。"""

    timeout_seconds: float = Field(120.0, ge=1.0, le=3600.0, description="同步等待的墙钟上限")


class VideoPlanFrameRead(BaseModel):
    """本次视频请求**实际使用**的一个参考帧。

    注意区分：绑定资产图片只是生成这些帧的**上游素材**，真正发给视频模型的是这里的 file_id。
    """

    role: str = Field("", description="参考模式里的位置：first / last / key")
    frame_type: str = Field("", description="shot_frame_images.frame_type")
    file_id: str = ""
    url: str = Field("", description="可用于展示/预检的地址（公网优先，其次 files 下载路由）")
    usable: bool = Field(
        False,
        description=(
            "**供应商口径**是否可用：只有能变成 http(s):// / asset:// 引用（或该供应商接受的形态）"
            "才算 true。本地相对地址只能变成本机 data URL，对 APIMart 属于不可用"
        ),
    )
    ref_kind: str = Field(
        "missing",
        description="引用形态：public（公网）/ local_data_url（本地，只能变 data URL）/ missing / not_found / unreadable",
    )
    reason: str = Field("", description="不可用时的具体原因（可直接展示给用户）")


class VideoSubmitPlanRead(BaseModel):
    """直提出视频的计划预览。"""

    shot_id: str
    provider: str = ""
    model_id: str = ""
    model_name: str = ""
    base_url: str = ""
    api_key_configured: bool = False
    reference_mode: str = ""
    reference_image_count: int = 0
    prompt: str = ""
    prompt_source: str = Field("", description="request / llm_orchestration")
    ratio: str = ""
    seconds: int | None = None
    resolution: str = Field("", description="分辨率档位；固定策略默认 480p")
    required_frame_types: list[str] = Field(
        default_factory=list, description="当前参考模式要求的帧类型（first/last/key）"
    )
    frames: list[VideoPlanFrameRead] = Field(
        default_factory=list, description="本次请求实际使用的参考帧（file_id 级）"
    )
    missing_frame_types: list[str] = Field(
        default_factory=list, description="当前模式下**槽位没有 file_id** 的帧类型；非空时不允许真实生成"
    )
    unusable_frame_types: list[str] = Field(
        default_factory=list,
        description=(
            "有 file_id 但**供应商取不到**的帧类型（例如本地地址只能变 data URL，而 APIMart 只收 "
            "http(s):// / asset://）；与 missing 一样会阻止生成，需在前端区分提示"
        ),
    )
    generation_blocked: bool = Field(
        False, description="是否被参考帧拦截（缺帧或帧供应商不可用；页面据此禁用真实生成）"
    )
    blocked_reason: str = ""
    audio_file_id: str = Field("", description="本次请求携带的音频 file_id（空表示未携带）")
    audio_url: str = Field("", description="音频地址（仅公网地址会被发送给供应商）")
    audio_opt_out: bool = Field(False, description="本镜是否明确标记无需声音")
    audio_state: str = Field("", description="bound（已绑且可用）/ bound_not_public / missing / opt_out")
    model_pinned: bool = Field(True, description="是否命中固定模型策略（seedance-2.0-mini）")
    provider_supported: bool = Field(True, description="provider 是否在既有的 openai/volcengine/apimart 白名单内")
    warnings: list[str] = Field(default_factory=list)
    guard_status: str = ""
    note: str = "仅为提交计划预览，未创建任何生成任务、未调用任何视频 provider。"


class VideoSubmitRead(BaseModel):
    """直提出视频结果。"""

    shot_id: str
    provider: str = ""
    status: str = ""
    provider_task_id: str = ""
    url: str = Field("", description="视频地址（临时地址，长期资产需落 OSS）")
    file_persisted: bool = Field(False, description="本次调用是否已把视频落库（直接提交路径不落库）")
    elapsed_ms: int = 0
    error: str = ""
    warnings: list[str] = Field(default_factory=list)
    guard_status: str = ""
    note: str = (
        "直接提交路径不写库：结果地址仅在本响应中返回。"
        "需要长期资产请把该地址接入既有落库流程（files / shot.generated_video_file_id）。"
    )


# ---------------------------------------------------------------------------
# 镜头分镜帧（关键帧 / 首帧 / 尾帧）出图 —— 同进程内联执行
# ---------------------------------------------------------------------------

FrameTypeLiteral = Literal["first", "key", "last"]


class FrameSubmitPlanRequest(BaseModel):
    """关键帧出图的计划请求（不触网、不写库）。"""

    shot_id: str = Field(..., min_length=1)
    frame_type: FrameTypeLiteral = Field(
        "key",
        description="first | key | last，与 shot_frame_images.frame_type 一致",
    )
    prompt: str = Field(
        "",
        description="留空则用镜头里**已保存**的该帧提示词（shot_details.first/key/last_frame_prompt）",
    )
    images: list[str] = Field(
        default_factory=list,
        description="显式参考图 file_id 列表；留空则用该镜头绑定资产（角色/场景/道具/服装）的定版图",
    )
    target_ratio: str = Field("", description="留空则按 镜头 override_video_ratio → 项目默认 → 16:9 解析")
    resolution_profile: Literal["standard", "high"] = "standard"
    model_id: str | None = None


class FrameSubmitRequest(FrameSubmitPlanRequest):
    """关键帧出图提交（受 DRY_RUN 守卫；同进程内联执行）。"""

    timeout_seconds: float = Field(900.0, ge=1.0, le=3600.0, description="同步等待的墙钟上限")


class FrameSubmitPlanRead(BaseModel):
    """关键帧出图计划：提示词来源、参考图、画幅、供应商，**都不触网**。"""

    shot_id: str
    frame_type: str
    prompt: str = ""
    prompt_source: str = Field(
        "", description="saved（镜头已保存的帧提示词）/ request（调用方显式传入）/ empty（两者都没有）"
    )
    reference_file_ids: list[str] = Field(default_factory=list, description="实际会送出的参考图 file_id")
    reference_count: int = 0
    target_ratio: str = ""
    target_ratio_source: str = Field("", description="shot / project / default")
    resolution_profile: str = "standard"
    provider: str = ""
    model_id: str = ""
    model_name: str = ""
    base_url: str = ""
    api_key_configured: bool = False
    image_slot_id: int | None = Field(None, description="shot_frame_images 行 ID（不存在时为空，提交时会创建）")
    warnings: list[str] = Field(default_factory=list)
    guard_status: str = ""
    dry_run: bool = True
    note: str = "仅为计划预览，未创建任何生成任务、未调用任何图片 provider。"


class FrameSubmitRead(BaseModel):
    """关键帧出图结果（同进程内联执行后的真实产物与落库情况）。"""

    shot_id: str
    frame_type: str
    status: str = Field("", description="dry_run / succeeded / failed / timeout / blocked / rejected_before_submit")
    dry_run: bool = False
    task_id: str = Field("", description="Jellyfish 内部任务 ID（任务中心可见）")
    provider: str = ""
    provider_task_id: str = ""
    image_url: str = Field("", description="本次生成的图片地址（OSS/公网优先，可能为供应商临时地址）")
    file_id: str = Field("", description="落库后的 files.id；未落库为空")
    image_slot_id: int | None = None
    prompt: str = ""
    prompt_source: str = ""
    reference_file_ids: list[str] = Field(default_factory=list)
    provider_notes: list[str] = Field(
        default_factory=list,
        description="供应商/适配层的如实说明（例如垫片回传「参考图未透传」）",
    )
    elapsed_ms: int = 0
    error: str = ""
    warnings: list[str] = Field(default_factory=list)
    guard_status: str = ""
    note: str = (
        "本接口在同进程内联执行一次图片生成（不走 Celery 队列）；"
        "成功后结果会写进 shot_frame_images.file_id + file_usages，刷新后仍在。"
    )
