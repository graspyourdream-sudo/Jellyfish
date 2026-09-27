from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class EntityNameExistenceCheckRequest(BaseModel):
    """批量检测项目内/全局资产名称是否存在（模糊匹配）。"""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(..., description="项目 ID（必填）", min_length=1)
    shot_id: str | None = Field(None, description="镜头 ID（可选；不传则 linked_to_shot 恒为 false）")
    character_names: list[str] = Field(default_factory=list, description="角色名称列表")
    prop_names: list[str] = Field(default_factory=list, description="道具名称列表")
    scene_names: list[str] = Field(default_factory=list, description="场景名称列表")
    costume_names: list[str] = Field(default_factory=list, description="服装名称列表")
    # 商品是第五类资产：字段**必须可省略**（默认空列表）。调用方（第 2 步页面）目前仍
    # 只发上面四个名称字段，把商品做成必填会让那条既有请求整条 422。
    product_names: list[str] = Field(default_factory=list, description="商品名称列表（可省略）")


class EntityNameExistenceItem(BaseModel):
    """单个名称的存在性结果。"""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., description="输入名称（原样回传）")
    exists: bool = Field(..., description="数据库中是否存在（模糊命中）")
    linked_to_project: bool = Field(..., description="是否已关联到该项目（角色等同于 exists）")
    linked_to_shot: bool = Field(False, description="是否已关联到请求中的 shot（未传 shot_id 时为 false）")
    asset_id: str | None = Field(
        None, description="命中的资产 ID（如 prop_id/scene_id/costume_id/product_id/character_id）"
    )
    link_id: int | None = Field(None, description="若已关联到项目，对应 Project*Link 的 id；否则为空")


class EntityNameExistenceCheckResponse(BaseModel):
    """批量存在性检测结果（按资产类型分组）。

    ``products`` 与其余四桶同形；响应模型是 ``extra="forbid"``，所以服务端多返回一个桶
    就必须在这里声明，否则整条响应校验失败（而不是多出一个字段）。
    """

    model_config = ConfigDict(extra="forbid")

    characters: list[EntityNameExistenceItem] = Field(default_factory=list)
    props: list[EntityNameExistenceItem] = Field(default_factory=list)
    scenes: list[EntityNameExistenceItem] = Field(default_factory=list)
    costumes: list[EntityNameExistenceItem] = Field(default_factory=list)
    products: list[EntityNameExistenceItem] = Field(default_factory=list)

