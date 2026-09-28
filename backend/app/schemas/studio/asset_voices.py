"""资产级声音绑定的读写契约（需求清单第 6 条）。

字段口径（都进主区，因此**不含** file_id 这类内部标识的必要性说明见下）：

- ``asset_type`` / ``asset_id``：这一条绑定属于哪个资产（机器可读，页面用它定位卡片）；
- ``asset_label``：资产类型的中文名（页面直接显示，不让页面自己写映射）；
- ``bound``：这一项**有没有**绑定声音（``false`` 时下面几个字段全是空串，
  页面据此显示"还没绑定声音"，而不是显示一个空文件名）；
- ``file_id`` / ``file_name``：声音文件。``file_id`` 是内部标识，
  **只允许落在技术详情层**（前端按既有审计口径处理，不在主区直渲）。
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class AssetVoiceBindRequest(BaseModel):
    """绑定请求：把一个音频文件绑成某个资产的声音。"""

    file_id: str = Field(..., description="要绑定的音频文件 ID（files.type 必须是 audio）")


class AssetVoiceRead(BaseModel):
    """一条资产级声音绑定（只读）。"""

    asset_type: str = Field(..., description="资产类型：character / scene / prop / costume")
    asset_id: str = Field(..., description="资产 ID")
    asset_label: str = Field("", description="资产类型的中文名（页面直接显示）")
    bound: bool = Field(False, description="这一项是否已绑定声音")
    file_id: str = Field("", description="声音文件 ID（内部标识，只进技术详情层）")
    file_name: str = Field("", description="声音文件名")
    url: str = Field("", description="声音文件地址（是否可进供应商请求由生成前的准入判定负责）")


class AssetVoiceClearRead(BaseModel):
    """解绑结果。"""

    removed: int = Field(0, description="被清掉的绑定行数（0 = 本来就没绑）")


class ShotVoiceInheritanceRead(BaseModel):
    """**第 4 步「资产与声音检查」**里某镜「角色声音」的只读结论。

    为什么是只读契约、而且没有对应的写接口（设计包 §10）：
    声音的唯一事实来源是**人物资产**（第 2 步人物资产详情是全站唯一绑定入口），
    第 4 步只做检查 —— 显示继承结果与来源、缺项时提示回人物资产补充。
    "第 4 步能改声音"这件事在结构上就不该存在：这里没有 PUT / PATCH，
    字段也不足以驱动一次写入。

    ``state`` 是**机器可读**结论（页面负责翻成中文；主区不出现原值）：

    - ``inherited``：恰好一个角色绑了声音，这一镜继承它；
    - ``ambiguous``：多个角色都绑了声音，系统**不替用户挑**，``candidates`` 列出候选；
    - ``legacy_snapshot``：角色没绑，但这一镜还留着迁移前的逐镜声音（只读快照）；
    - ``opt_out``：本镜已明确标记「无需声音」；
    - ``missing``：角色没绑、也没有历史声音 → 缺项，应提示「返回人物资产补充」。
    """

    shot_id: str = Field(..., description="镜头 ID")
    state: str = Field(..., description="只读结论（inherited / ambiguous / legacy_snapshot / opt_out / missing）")
    file_id: str = Field("", description="生效的声音文件 ID（内部标识，只进技术详情层）")
    file_name: str = Field("", description="生效的声音文件名（页面直接显示）")
    url: str = Field("", description="生效的声音地址（试听用；能否进供应商请求由生成前准入判定）")
    source_asset_type: str = Field("", description="来源人物资产类型（character）")
    source_asset_id: str = Field("", description="来源人物资产 ID（内部标识，只进技术详情层）")
    source_asset_name: str = Field("", description="来源人物资产名称（页面显示「继承自……」）")
    character_count: int = Field(0, description="这一镜关联的人物资产数量")
    voice_asset_count: int = Field(0, description="其中已经绑定声音的数量")
    candidates: list[str] = Field(default_factory=list, description="ambiguous 时的候选人物资产名称")
    legacy_file_id: str = Field("", description="迁移前的逐镜声音文件 ID（只读快照）")
    legacy_file_name: str = Field("", description="迁移前的逐镜声音文件名（只读快照）")
    legacy_inherited_from: str = Field("", description="快照记录的继承来源（<资产类型>:<资产ID>）")
