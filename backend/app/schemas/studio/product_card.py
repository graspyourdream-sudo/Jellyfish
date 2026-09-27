"""商品卡（`product_cards`）的请求/响应 DTO。

为什么单独一套 DTO 而不是复用 `AssetCreate` 那套：商品卡是**策划期的资料**（品类/品牌/卖点/
人群/价格/合规/参考资料），而商品**资产**是落库后的生产对象（`products` 表）。两者职责不同：
- 商品卡：用户在策划页确认的**事实来源**，缺项要能标「待补充」，未确认不允许生成剧情；
- 商品资产：确认策划后由商品卡派生出来的可绑定资产。

契约见 `site/content/docs/plans/drama-ad-full-loop.md`「一、数据契约 §2」。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

#: 商品资料的来源类型（决定"未编造"的口径：每个字段要么来自这些来源，要么留空并标待补充）
ProductSourceType = Literal["manual", "paste", "upload", "existing"]

#: 商品卡的**必填**字段（缺了就不能确认；其余字段缺了只标「待补充」，绝不编造）
REQUIRED_CARD_FIELDS: tuple[str, ...] = ("name",)

#: 字段中文名（页面与接口都用它标「待补充」，避免前端各写一套）
CARD_FIELD_LABELS: dict[str, str] = {
    "name": "商品名称",
    "category": "品类",
    "brand": "品牌",
    "selling_points": "核心卖点",
    "audience": "目标人群",
    "scenarios": "使用场景",
    "price_info": "价格或促销信息",
    "compliance": "禁止表达与合规要求",
    "notes": "用户补充说明",
    "reference_files": "商品图片或参考资料",
}

#: 可编辑字段（PUT 只认这些键；`source_summary` / `missing_fields` / `updated_at` 由服务端维护）
EDITABLE_CARD_FIELDS: tuple[str, ...] = (
    "name",
    "category",
    "brand",
    "selling_points",
    "audience",
    "scenarios",
    "price_info",
    "compliance",
    "notes",
    "reference_files",
    "confirmed",
)


class ProductReferenceFile(BaseModel):
    """商品参考资料的一条（图片或文档）。"""

    model_config = ConfigDict(extra="forbid")

    file_id: str = Field("", description="files.id（可为空：只登记名称的外部资料）")
    name: str = Field("", description="文件名或说明")
    kind: str = Field("image", description="image / document / other")


class ProductCardUpdate(BaseModel):
    """保存商品卡（免费出口）。

    只允许出现 :data:`EDITABLE_CARD_FIELDS` 里的键：`extra="forbid"` 让前端写错字段时
    立刻 422，而不是静默忽略（静默忽略正是"用户改了没生效"这类问题的温床）。
    """

    model_config = ConfigDict(extra="forbid")

    name: str = ""
    category: str = ""
    brand: str = ""
    selling_points: list[str] = Field(default_factory=list)
    audience: str = ""
    scenarios: list[str] = Field(default_factory=list)
    price_info: str = ""
    compliance: str = ""
    notes: str = ""
    reference_files: list[ProductReferenceFile] = Field(default_factory=list)
    confirmed: bool = False


class ProductCardRead(BaseModel):
    """商品卡 + 服务端算出来的缺项与来源。"""

    model_config = ConfigDict(extra="forbid")

    project_id: str = ""
    name: str = ""
    category: str = ""
    brand: str = ""
    selling_points: list[str] = Field(default_factory=list)
    audience: str = ""
    scenarios: list[str] = Field(default_factory=list)
    price_info: str = ""
    compliance: str = ""
    notes: str = ""
    reference_files: list[ProductReferenceFile] = Field(default_factory=list)
    source_type: ProductSourceType = "manual"
    confirmed: bool = False
    #: 缺项字段键（页面据此显示「待补充」；**不编造**任何内容）
    missing_fields: list[str] = Field(default_factory=list)
    #: 缺项字段的中文名（页面直接用，避免前端各写一套映射）
    missing_labels: list[str] = Field(default_factory=list)
    #: 技术详情用：来源文件名、原文字数、提取时间、使用的模型
    source_summary: dict[str, Any] = Field(default_factory=dict)
    updated_at: str = Field("", description="最后更新时间（ISO 串）")
    note: str = ""


class ProductCardExtractRequest(BaseModel):
    """从资料里提取商品信息（**付费一次调用**）。

    三种来源（契约要求至少三种）：`paste`（粘贴文案）、`upload`（上传 TXT/DOCX/图片，
    传 `file_ids`）、`existing`（选已有商品资料，传 `existing_product_id`）。
    """

    model_config = ConfigDict(extra="forbid")

    source_type: ProductSourceType = "paste"
    text: str = Field("", description="source_type=paste 时的商品文案")
    file_ids: list[str] = Field(default_factory=list, description="source_type=upload 时的文件 ID 列表")
    existing_product_id: str = Field("", description="source_type=existing 时的商品资产 ID")
    extra_instructions: str = Field("", description="补充要求（参与提示词，不影响字段集合）")


class ProductCardExtractRead(BaseModel):
    """提取结果：**结构化字段 + 缺项 + 来源**，不落库，由用户确认后再 PUT。"""

    model_config = ConfigDict(extra="forbid")

    fields: ProductCardUpdate = Field(default_factory=ProductCardUpdate)
    missing_fields: list[str] = Field(default_factory=list)
    missing_labels: list[str] = Field(default_factory=list)
    source_summary: dict[str, Any] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    note: str = ""


__all__ = [
    "CARD_FIELD_LABELS",
    "EDITABLE_CARD_FIELDS",
    "REQUIRED_CARD_FIELDS",
    "ProductCardExtractRead",
    "ProductCardExtractRequest",
    "ProductCardRead",
    "ProductCardUpdate",
    "ProductReferenceFile",
    "ProductSourceType",
]
