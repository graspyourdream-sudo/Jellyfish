"""「剧情广告」流程的两张表：``product_cards``（商品信息卡）与 ``drama_plan_materials``（策划落库来源关系）。

为什么需要这两张表（实施契约 ``drama-ad-full-loop.md`` §一.2 / §一.4）
=====================================================================

契约定的用户流程是：新建剧情广告项目 → **商品卡**（持久化 + 自动提取）→ 分层剧情 →
人工审核修改 → **确认策划（幂等落库）** → 一键进入第 2 步资产准备。这条链上有两件事
**现有表承载不了**：

1. **商品信息卡**（``product_cards``）：名称 / 品类 / 品牌 / 卖点 / 使用场景 / 目标人群 /
   价格促销 / 合规要求 / 用户补充 / 参考资料 / 来源与提取详情。它是"生成剧情"的输入，
   既不是 ``products``（那是**落库后的商品资产**，全局可复用），也不是
   ``project_product_links``（那是镜头级三档关联）。它属于**项目级的策划输入**：
   未确认前不允许生成剧情（契约接口表里 ``PUT .../product-card`` 的 ``confirmed=true`` 才放行），
   且必须"刷新不丢"（同 ``drama_plan_drafts`` 的落库理由）。一项目一张卡
   （主键 = ``project_id``，见下）。

2. **策划落库的来源关系**（``drama_plan_materials``）：确认策划时把人物 / 场景 / 道具 /
   服装 / 商品落成正式资产，这张表记录"这一行资产是**哪一次策划确认**落下来的"。
   两个用途（契约 §一.4）：
   - **幂等**：第二次确认先查这张表就能找到既有实体，不重复创建（契约 §三.6 要求
     "第二次确认不得新增任何镜头/资产"）；
   - **追溯**：商品 / 人物 / 场景都能回指策划与商品卡（页面「技术详情」要展示来源与更新时间）。

``products.provenance`` 是同一件事在**商品资产**上的冗余投影（商品是全局资产，不带
``project_id``），列定义在 ``studio_products.py`` 里，不在本文件。

与既有表的边界（硬约束）
=======================

- ``product_cards`` **只放策划输入**，不放任何落库产物；
- ``drama_plan_materials`` **只放来源关系**，不重复存资产内容（``entity_id`` 指向正式资产行）；
- ``entity_id`` 是**多态软引用**（可能指向 ``characters`` / ``scenes`` / ``props`` /
  ``costumes`` / ``products`` 里任意一张表的主键），因此**故意不建外键**：
  SQLite 表达不了"指向多张表之一"的外键，而为它另建一张"统一实体表"等于把五类资产的
  既有结构推倒重来（本仓库四类资产表各有几十列）。代价是资产行被删后这一列可能悬空，
  读侧按 ``entity_type`` + ``entity_id`` 查不到就当作"已删除"处理，不影响任何资产语义。

为什么字段一律 NOT NULL + 空串 / 空列表默认
==========================================

商品卡是"先建后填"的（``kind=ad`` 的项目创建时同一事务落一张空卡，见契约 §二.项目），
"还没填哪些字段"由 ``missing_fields`` **显式表达**（契约要求"不填就不编造"），
所以列本身不需要 NULL 语义来兼职表达"未知"。这与仓库既有风格一致
（``products.description`` / ``drama_plan_drafts.error`` 同理），读侧不必到处判 None。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import JSON, Boolean, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base
from app.models.base import TimestampMixin
from app.models.studio_projects import Chapter, Project


class ProductCard(Base, TimestampMixin):
    """商品信息卡（项目级 1:1，主键 = ``projects.id``）。

    为什么用 ``project_id`` 当主键（而不是自增 id + 唯一约束）：
    - 契约要求"一项目一张卡"，把项目 ID 直接当主键让**重复建卡在数据库层就不可能**，
      不需要应用层再判一次"卡是否已存在"；
    - 项目删除时随 ``ON DELETE CASCADE`` 一起走，不留孤儿行。

    ``created_at`` / ``updated_at`` 来自 ``TimestampMixin``（仓库每张表都有这两列）：
    契约里只写了 ``updated_at``（技术详情展示"最后更新时间"），``created_at`` 是既有惯例的顺带，
    不额外承担语义。

    ``source_summary`` / ``reference_files`` / ``missing_fields`` 都是 JSON 列：
    前两个是"提取过程的技术详情"（来源文件名、原文字数、提取时间、使用的模型 / 商品图引用），
    ``missing_fields`` 是提取后仍缺的字段名列表 —— 三者都可能随提取流程演进，用 JSON 避免频繁加列。
    """

    __tablename__ = "product_cards"

    project_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("projects.id", ondelete="CASCADE"),
        primary_key=True,
        comment="所属项目 ID（一项目一张卡；与 projects.id 共享主键）",
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False, default="", comment="商品名称")
    category: Mapped[str] = mapped_column(String(255), nullable=False, default="", comment="商品品类")
    brand: Mapped[str] = mapped_column(String(255), nullable=False, default="", comment="商品品牌")
    selling_points: Mapped[list[Any]] = mapped_column(
        JSON,
        nullable=False,
        default=list,
        comment="核心卖点（JSON 列表；顺序即页面展示顺序）",
    )
    scenarios: Mapped[list[Any]] = mapped_column(
        JSON,
        nullable=False,
        default=list,
        comment="使用场景（JSON 列表）",
    )
    audience: Mapped[str] = mapped_column(Text, nullable=False, default="", comment="目标人群")
    price_info: Mapped[str] = mapped_column(Text, nullable=False, default="", comment="价格或促销信息")
    compliance: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        default="",
        comment="禁止表达 / 合规要求（生成剧情时必须遵守，不落进分镜的台词里）",
    )
    notes: Mapped[str] = mapped_column(Text, nullable=False, default="", comment="用户补充说明")
    reference_files: Mapped[list[Any]] = mapped_column(
        JSON,
        nullable=False,
        default=list,
        comment='商品图片 / 参考资料：[{"file_id": ..., "name": ..., "kind": ...}]',
    )
    source_type: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default="",
        comment="这张卡的来源方式：manual（手填）/ paste（粘贴文本）/ upload（上传文件）/ existing（选既有商品）",
    )
    source_summary: Mapped[dict[str, Any]] = mapped_column(
        JSON,
        nullable=False,
        default=dict,
        comment="**技术详情**：来源文件名、原文字数、提取时间、使用的模型等（页面默认收起）",
    )
    missing_fields: Mapped[list[Any]] = mapped_column(
        JSON,
        nullable=False,
        default=list,
        comment='提取后仍缺的字段名（页面显示「待补充」；**不编造**缺失内容）',
    )
    confirmed: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        comment="用户是否已确认商品卡：未确认不允许生成剧情（契约接口表 PUT 的 confirmed 入参）",
    )

    project: Mapped["Project"] = relationship()
    # 卡上引用的文件不在这里建 relationship：reference_files 是 JSON 里的 file_id 列表，
    # 不是外键列（合同允许引用被删掉的旧文件而卡片本身仍然可读）。


class DramaPlanMaterial(Base, TimestampMixin):
    """策划落库的来源关系（"这一行资产是本次策划确认落下来的"）。

    主键是自增 ``id``：同一个实体理论上可能先后由"策划确认"与"人工补充"两条来源登记
    （``source`` 不同），所以归属关系不唯一，不做成 ``(entity_type, entity_id)`` 主键。

    ``chapter_id`` 定为 NOT NULL：每一行都是**某一章的策划确认**的产物
    （确认接口是 ``POST /studio/chapters/{cid}/drama-plan/confirm``，章节 ID 必然存在）。
    这同时让唯一约束 ``uq_drama_plan_materials_entity_scope`` 真正生效 ——
    SQLite 视 NULL 互不相等，若 ``chapter_id`` 可空，同一实体的重复登记就会绕过约束。

    ``source``：``plan`` = 由策划确认写入（幂等复核查的就是它）；``manual`` = 人工补充。
    """

    __tablename__ = "drama_plan_materials"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True, comment="关系行 ID")
    project_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
        comment="所属项目 ID",
    )
    chapter_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("chapters.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
        comment="所属章节 ID（策划确认是按章发生的；章节删除时来源关系一并删除）",
    )
    entity_type: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        index=True,
        comment="实体类型：character / scene / prop / costume / product（与 asset_type 同口径）",
    )
    entity_id: Mapped[str] = mapped_column(
        String(64),
        nullable=False,
        index=True,
        comment="落库后的正式资产 ID（**多态软引用，故意不建外键**，见模块 docstring）",
    )
    source: Mapped[str] = mapped_column(
        String(16),
        nullable=False,
        default="plan",
        comment="来源：plan（策划确认落库，幂等复核依据）/ manual（人工补充）",
    )

    project: Mapped["Project"] = relationship()
    chapter: Mapped["Chapter"] = relationship()

    __table_args__ = (
        # 幂等的数据库级兜底：同一章里同一个实体由同一来源只能登记一行，
        # 于是"重复确认"即使漏了应用层查询，也不会写进第二行。
        UniqueConstraint(
            "entity_type",
            "entity_id",
            "project_id",
            "chapter_id",
            "source",
            name="uq_drama_plan_materials_entity_scope",
        ),
    )


__all__ = ["DramaPlanMaterial", "ProductCard"]
