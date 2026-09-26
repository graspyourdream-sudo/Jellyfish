"""「剧情广告」流程的数据契约清单（新表 DDL + 新列清单）—— **迁移与回滚共用的唯一一份**。

为什么必须只有一份
==================

``_llm_pipeline_columns.py:3-6`` 记录过一次真实事故：迁移与回滚各维护一份清单，
漂移成「迁移 11 列 / 回滚 10 列」，于是"迁移后能跑、回滚后回不到迁移前"。
本模块把「新表」与「新列」都收在一处，``migrate_ad_flow.py`` 与 ``rollback_ad_flow.py``
都从这里读，两侧不可能再不对称。

清单内容（数量一律由 :func:`table_count` / :func:`column_count` 动态给出，不在别处写死）
=======================================================================================

**新表 2 张**（契约 §一.2 / §一.4）：

1. ``product_cards``：商品信息卡（项目级 1:1，主键 = ``projects.id``）。
   一张卡一个项目，项目删除时随外键 CASCADE 一起走。
2. ``drama_plan_materials``：策划落库的来源关系（"这行资产是哪一章的策划确认落下来的"）。
   它同时是**确认幂等**的查询依据与**追溯**链路（商品/人物/场景 → 策划 → 商品卡）。
   ``entity_id`` 是多态软引用（指向五类资产表之一），**故意不建外键**，见模型 docstring。

**新列 8 个**（契约 §一.1 / §一.3 / §一.5）：

- ``projects.kind``（项目类型 drama/ad，旧行自动回填 ``drama``）；
- ``drama_plan_drafts`` 的 6 列：``story_status`` / ``stale_flags`` / ``manual_edited_at`` /
  ``confirmed_at`` / ``materialized_at`` / ``materialize_summary``（分层剧情 + 确认策划）；
- ``products.provenance``（商品资产回指策划与商品卡）。

DDL 与 ORM 逐列一致
===================

两张新表的 DDL 由 SQLAlchemy 编译生成后粘贴
（``CreateTable(...).compile(dialect=sqlite.dialect())``，临时库口径），因此列名、顺序、
``NOT NULL``、主键、外键的 ``ON DELETE`` 动作、唯一约束名、索引名与
``app/models/studio_ad_flow.py`` 完全一致。类型按 SQLite 方言落：
``JSON → JSON``、``Boolean → BOOLEAN``、``DateTime(timezone=True) → DATETIME``、
``String(n) → VARCHAR(n)``、``Text → TEXT``、``Integer`` 主键 → ``INTEGER``
（SQLAlchemy 把 ``primary_key=True`` 写成表级 ``PRIMARY KEY (id)``，与既有
``product_images`` 的建表口径相同：SQLite 下 ``INTEGER PRIMARY KEY`` 即 rowid 别名，自增行为一致）。

**新列**这里写的是 ``ALTER TABLE ... ADD COLUMN`` 要用的列定义片段（不是整条语句），
与 ORM 声明**逐字对齐**：

- ``NOT NULL`` 的列一律带 ``DEFAULT`` —— 这是 SQLite 对 ``ALTER TABLE ADD COLUMN`` 的硬要求，
  同时让旧行自动回填成"与迁移前行为一致"的取值（``kind='drama'``、``story_status='none'``、
  JSON 空对象 / 空列表）；
- 可空的时间戳列**不写** ``DEFAULT``（ORM 侧也没有 ``server_default``）——
  于是 ``PRAGMA table_info.dflt_value`` 与 ORM 的 ``server_default`` 能逐列对上。
  （隔壁 ``_llm_pipeline_columns.py`` 给同类列写了 ``DEFAULT NULL``；那是无害的等价写法，
  但它会让"库里有默认值 / ORM 里没有"对不上，本切片不这么写。）

结构化期望值来自 DDL 本身
==========================

:func:`_self_check` 在 **import 时**就从 DDL 文本解析出列名顺序、``NOT NULL``、主键、
外键（含 ``ON DELETE``）与索引名，并把解析结果存进 :class:`NewTable` / :class:`NewColumn`
的属性里 —— 于是"清单里的结构化字段"和"清单里的 DDL"不可能各说各话，
测试拿到的期望值也不用再抄一遍。解析不出来（格式跑偏）会在 import 期直接报错。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, replace

PRODUCT_CARDS_TABLE = "product_cards"
DRAMA_PLAN_MATERIALS_TABLE = "drama_plan_materials"

#: 建表顺序**有意义**：两张新表的外键都指向 ``projects``（另一张还指向 ``chapters``），
#: 所以这里列的是"这两张表该按什么顺序建"，前置表缺失会在迁移里明确报错（见 ``PREREQ_TABLES``）。
PRODUCT_CARDS_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS product_cards (
    project_id VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    category VARCHAR(255) NOT NULL,
    brand VARCHAR(255) NOT NULL,
    selling_points JSON NOT NULL,
    scenarios JSON NOT NULL,
    audience TEXT NOT NULL,
    price_info TEXT NOT NULL,
    compliance TEXT NOT NULL,
    notes TEXT NOT NULL,
    reference_files JSON NOT NULL,
    source_type VARCHAR(16) NOT NULL,
    source_summary JSON NOT NULL,
    missing_fields JSON NOT NULL,
    confirmed BOOLEAN NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    PRIMARY KEY (project_id),
    FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE
)
""".strip()

#: 商品卡没有额外索引：主键就是 ``project_id``，唯一会用到的查询（按项目取卡）走主键。
PRODUCT_CARDS_TABLE_INDEXES: tuple[str, ...] = ()

PRODUCT_CARDS_TABLE_COLUMNS: tuple[str, ...] = (
    "project_id",
    "name",
    "category",
    "brand",
    "selling_points",
    "scenarios",
    "audience",
    "price_info",
    "compliance",
    "notes",
    "reference_files",
    "source_type",
    "source_summary",
    "missing_fields",
    "confirmed",
    "created_at",
    "updated_at",
)

DRAMA_PLAN_MATERIALS_TABLE_DDL = """
CREATE TABLE IF NOT EXISTS drama_plan_materials (
    id INTEGER NOT NULL,
    project_id VARCHAR(64) NOT NULL,
    chapter_id VARCHAR(64) NOT NULL,
    entity_type VARCHAR(32) NOT NULL,
    entity_id VARCHAR(64) NOT NULL,
    source VARCHAR(16) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    PRIMARY KEY (id),
    CONSTRAINT uq_drama_plan_materials_entity_scope UNIQUE (entity_type, entity_id, project_id, chapter_id, source),
    FOREIGN KEY(project_id) REFERENCES projects (id) ON DELETE CASCADE,
    FOREIGN KEY(chapter_id) REFERENCES chapters (id) ON DELETE CASCADE
)
""".strip()

DRAMA_PLAN_MATERIALS_TABLE_INDEXES: tuple[str, ...] = (
    (
        f"CREATE INDEX IF NOT EXISTS ix_{DRAMA_PLAN_MATERIALS_TABLE}_project_id "
        f"ON {DRAMA_PLAN_MATERIALS_TABLE} (project_id)"
    ),
    (
        f"CREATE INDEX IF NOT EXISTS ix_{DRAMA_PLAN_MATERIALS_TABLE}_chapter_id "
        f"ON {DRAMA_PLAN_MATERIALS_TABLE} (chapter_id)"
    ),
    (
        f"CREATE INDEX IF NOT EXISTS ix_{DRAMA_PLAN_MATERIALS_TABLE}_entity_type "
        f"ON {DRAMA_PLAN_MATERIALS_TABLE} (entity_type)"
    ),
    (
        f"CREATE INDEX IF NOT EXISTS ix_{DRAMA_PLAN_MATERIALS_TABLE}_entity_id "
        f"ON {DRAMA_PLAN_MATERIALS_TABLE} (entity_id)"
    ),
)

DRAMA_PLAN_MATERIALS_TABLE_COLUMNS: tuple[str, ...] = (
    "id",
    "project_id",
    "chapter_id",
    "entity_type",
    "entity_id",
    "source",
    "created_at",
    "updated_at",
)

#: 唯一约束的定义片段（已写进 ``DRAMA_PLAN_MATERIALS_TABLE_DDL`` 的表级子句；这里单独留一份，
#: 供文档、迁移后校验与测试引用）。它同时是**确认幂等**的数据库级兜底：
#: 同一章里同一实体同一来源只能登记一行，重复确认即使漏了应用层查询也写不进第二行。
DRAMA_PLAN_MATERIALS_TABLE_UNIQUE_CONSTRAINT = (
    "CONSTRAINT uq_drama_plan_materials_entity_scope "
    "UNIQUE (entity_type, entity_id, project_id, chapter_id, source)"
)


@dataclass(frozen=True, slots=True)
class NewTable:
    """一张新增表。

    - ``ddl``：``CREATE TABLE IF NOT EXISTS ...`` 的完整定义（迁移用）；列名顺序与 ORM 一致；
    - ``indexes``：建表后按顺序执行的 ``CREATE INDEX IF NOT EXISTS ...``；
    - ``constraints``：命名的唯一约束（迁移后校验"约束名真的在表定义里"）；
    - ``why``：为什么要这张表（迁移输出与文档引用，避免"加了张看不懂的表"）；
    - ``columns`` / ``not_null`` / ``primary_key`` / ``foreign_keys``：**从 ``ddl`` 解析出来**的
      结构化期望值（不是手抄的第二份），迁移校验与测试三方对账都用它们；
    - 回滚只需要 ``table``（``DROP TABLE IF EXISTS`` 会连索引一起删）。
    """

    table: str
    ddl: str
    indexes: tuple[str, ...]
    constraints: tuple[str, ...]
    why: str
    columns: tuple[str, ...] = ()
    not_null: tuple[str, ...] = ()
    primary_key: tuple[str, ...] = ()
    #: ``(列名, 目标表, 目标列, ON DELETE 动作)``；动作来自 DDL 文本，空串表示没写 ON DELETE。
    foreign_keys: tuple[tuple[str, str, str, str], ...] = ()

    def index_names(self) -> tuple[str, ...]:
        """这张表的索引名（从 ``CREATE INDEX IF NOT EXISTS <名字> ON ...`` 里取）。"""
        return index_names(self)


@dataclass(frozen=True, slots=True)
class NewColumn:
    """一列新增字段（``ALTER TABLE ... ADD COLUMN`` 的列定义片段）。

    - ``ddl``：列定义片段（类型 + ``NOT NULL`` / ``DEFAULT``），迁移直接拼进 ALTER 语句；
    - ``why``：为什么要这一列（迁移输出与文档引用，避免"加了个看不懂的列"）；
    - ``type_name`` / ``not_null`` / ``has_default``：**从 ``ddl`` 解析出来**的结构化期望值
      （迁移后与 PRAGMA ``table_info`` 逐项核对）；
    - 回滚只需要 ``table`` / ``column``。
    """

    table: str
    column: str
    ddl: str
    why: str

    @property
    def type_name(self) -> str:
        """声明类型（``ddl`` 的第一个词），例如 ``VARCHAR(16)`` / ``JSON`` / ``DATETIME``。"""
        return self.ddl.strip().split()[0].upper()

    @property
    def not_null(self) -> bool:
        """是否 ``NOT NULL``。"""
        return "NOT NULL" in self.ddl.upper()

    @property
    def has_default(self) -> bool:
        """是否声明了 ``DEFAULT``（SQLite 的 ``PRAGMA table_info.dflt_value`` 据此判空）。"""
        return "DEFAULT" in self.ddl.upper()


#: 迁移前必须已存在的表：前两张是两张新表的**外键目标**，后三张是新列的**宿主表**。
#: 缺任何一张都直接报错退出（而不是让 SQLite 抛一句 "no such table" 让人猜）。
PREREQ_TABLES: tuple[str, ...] = (
    "projects",
    "chapters",
    "drama_plan_drafts",
    "products",
)

#: 新列清单（8 列）。``NOT NULL`` 的列必须带 ``DEFAULT``（SQLite 的 ALTER 硬要求），
#: 旧行因此自动回填成"与迁移前行为一致"的取值（kind='drama'、story_status='none'、JSON 空对象）。
COLUMNS: tuple[NewColumn, ...] = (
    NewColumn(
        "projects",
        "kind",
        "VARCHAR(16) NOT NULL DEFAULT 'drama'",
        "项目类型（drama=普通剧情项目 / ad=剧情广告项目）；旧行自动回填 drama，行为不变",
    ),
    NewColumn(
        "drama_plan_drafts",
        "story_status",
        "VARCHAR(16) NOT NULL DEFAULT 'none'",
        "策划确认状态（none/draft/confirmed），与既有 status（生成状态）分工不同",
    ),
    NewColumn(
        "drama_plan_drafts",
        "stale_flags",
        "JSON NOT NULL DEFAULT '{}'",
        "过期标记（一句话/完整剧情/分镜谁改了、谁过期了），页面据此提示需要重新生成",
    ),
    NewColumn(
        "drama_plan_drafts",
        "manual_edited_at",
        "DATETIME",
        "最近一次人工编辑时间：生成前晚于上次生成时必须显式确认覆盖，否则 409",
    ),
    NewColumn(
        "drama_plan_drafts",
        "confirmed_at",
        "DATETIME",
        "策划确认时间",
    ),
    NewColumn(
        "drama_plan_drafts",
        "materialized_at",
        "DATETIME",
        "落库时间（确认后写正式章节/分镜/资产，幂等）",
    ),
    NewColumn(
        "drama_plan_drafts",
        "materialize_summary",
        "JSON NOT NULL DEFAULT '{}'",
        "落库统计（镜头数/资产数/关联行/跳过项），供幂等复核与页面回显",
    ),
    NewColumn(
        "products",
        "provenance",
        "JSON NOT NULL DEFAULT '{}'",
        "商品资产来源投影（source=plan / project_id / chapter_id / card_updated_at）；{} = 非策划落库",
    ),
)

TABLES: tuple[NewTable, ...] = (
    NewTable(
        PRODUCT_CARDS_TABLE,
        PRODUCT_CARDS_TABLE_DDL,
        PRODUCT_CARDS_TABLE_INDEXES,
        (),
        "商品信息卡（项目级 1:1）：生成剧情的输入，未确认不允许生成；刷新不丢",
        columns=PRODUCT_CARDS_TABLE_COLUMNS,
    ),
    NewTable(
        DRAMA_PLAN_MATERIALS_TABLE,
        DRAMA_PLAN_MATERIALS_TABLE_DDL,
        DRAMA_PLAN_MATERIALS_TABLE_INDEXES,
        ("uq_drama_plan_materials_entity_scope",),
        "策划落库的来源关系：确认幂等的查询依据 + 商品/人物/场景回指策划的追溯链路",
        columns=DRAMA_PLAN_MATERIALS_TABLE_COLUMNS,
    ),
)

TABLE_NAMES: tuple[str, ...] = (PRODUCT_CARDS_TABLE, DRAMA_PLAN_MATERIALS_TABLE)


def table_count() -> int:
    """清单里的表数（输出文案一律用它，不在别处写死数字）。"""
    return len(TABLES)


def table_names() -> tuple[str, ...]:
    """清单里的表名（建表顺序）—— 回滚与校验用。"""
    return TABLE_NAMES


def column_count() -> int:
    """清单里的列数（输出文案一律用它，不在别处写死数字）。"""
    return len(COLUMNS)


def column_pairs() -> tuple[tuple[str, str], ...]:
    """``(表名, 列名)`` 列表 —— 回滚与校验用。"""
    return tuple((item.table, item.column) for item in COLUMNS)


def columns_of(table: str) -> tuple[str, ...]:
    """某张**新表**期望的列名（按 DDL 顺序）；表不在清单里时抛 ``KeyError``。"""
    for item in TABLES:
        if item.table == table:
            return item.columns
    raise KeyError(f"清单里没有这张表：{table}")


def new_columns_of(table: str) -> tuple[NewColumn, ...]:
    """某张**既有表**要新增的列（按清单顺序）；该表这次没有新列时返回空元组。"""
    return tuple(item for item in COLUMNS if item.table == table)


def index_names(item: NewTable) -> tuple[str, ...]:
    """从 ``CREATE INDEX IF NOT EXISTS <名字> ON ...`` 里取出索引名（校验用）。"""
    names: list[str] = []
    for ddl in item.indexes:
        parts = ddl.replace("IF NOT EXISTS", " ").split()
        names.append(parts[2])
    return tuple(names)


def index_ddl_of(item: NewTable, name: str) -> str:
    """按索引名取回那条 ``CREATE INDEX`` 语句（自检与输出用）；找不到时返回空串。"""
    for ddl in item.indexes:
        if name in ddl:
            return ddl
    return ""


def _index_columns(index_ddl: str) -> tuple[str, ...]:
    """从 ``CREATE INDEX ... ON table (a, b)`` 里取出索引列名（自检用）。"""
    _head, _, tail = index_ddl.partition("(")
    return tuple(part.strip() for part in tail.rstrip(")").split(",") if part.strip())


def describe() -> str:
    """一行人类可读概览，例如 ``2 张表：product_cards（17 列） / ... ＋ 8 列``。"""
    parts = " / ".join(f"{item.table}（{len(item.columns)} 列）" for item in TABLES)
    hosts = " / ".join(sorted({item.table for item in COLUMNS}))
    return (
        f"{table_count()} 张表：{parts} ＋ {column_count()} 个新列（宿主表：{hosts}）"
    )


_DDL_CLAUSE_PREFIXES = (
    "PRIMARY KEY",
    "FOREIGN KEY",
    "UNIQUE",
    "CONSTRAINT",
    "CHECK",
    ")",
)

#: `FOREIGN KEY(col) REFERENCES table (col) [ON DELETE ACTION]`
_FOREIGN_KEY_RE = re.compile(
    r"FOREIGN KEY\s*\((?P<column>[^)]+)\)\s*REFERENCES\s+(?P<table>\w+)\s*"
    r"\((?P<target>[^)]+)\)(?:\s+ON DELETE\s+(?P<action>\w+))?",
    re.IGNORECASE,
)

#: `PRIMARY KEY (a, b)`
_PRIMARY_KEY_RE = re.compile(r"PRIMARY KEY\s*\((?P<columns>[^)]+)\)", re.IGNORECASE)


def _ddl_column_defs(ddl: str) -> tuple[tuple[str, str], ...]:
    """从 ``CREATE TABLE`` DDL 里解析 ``(列名, 该行剩余文本)``，跳过表级子句。"""
    defs: list[tuple[str, str]] = []
    for raw_line in ddl.splitlines()[1:]:
        line = raw_line.strip().rstrip(",")
        if not line or line.startswith(_DDL_CLAUSE_PREFIXES):
            continue
        name, _, rest = line.partition(" ")
        defs.append((name, rest))
    return tuple(defs)


def _ddl_column_names(ddl: str) -> tuple[str, ...]:
    """从 ``CREATE TABLE`` DDL 里解析出列名（跳过主键/外键/唯一约束等表级子句）。"""
    return tuple(name for name, _rest in _ddl_column_defs(ddl))


def _ddl_primary_key(ddl: str, defs: tuple[tuple[str, str], ...]) -> tuple[str, ...]:
    """主键列：既支持表级 ``PRIMARY KEY (a, b)``，也支持列内联 ``PRIMARY KEY``。"""
    match = _PRIMARY_KEY_RE.search(ddl)
    if match:
        return tuple(part.strip() for part in match.group("columns").split(","))
    return tuple(name for name, rest in defs if "PRIMARY KEY" in rest.upper())


def _ddl_foreign_keys(ddl: str) -> tuple[tuple[str, str, str, str], ...]:
    """外键 ``(列, 目标表, 目标列, ON DELETE 动作)``；没写 ``ON DELETE`` 时动作为空串。"""
    found: list[tuple[str, str, str, str]] = []
    for match in _FOREIGN_KEY_RE.finditer(ddl):
        found.append(
            (
                match.group("column").strip(),
                match.group("table").strip(),
                match.group("target").strip(),
                (match.group("action") or "").strip().upper(),
            )
        )
    return tuple(found)


def _self_check() -> None:
    """模块自检：DDL 解析结果必须自洽，且前置表清单覆盖所有外键目标。

    清单只有一份，所以宁可 import 时就报错，也不让"清单说的列/约束"和"真实建出来的表"
    悄悄漂移（测试也会比对，但脚本单独跑时也要拦住）。
    """
    if table_names() != TABLE_NAMES:
        raise AssertionError("建表顺序必须由 TABLE_NAMES 唯一给出")
    if len(set(TABLE_NAMES)) != len(TABLE_NAMES):
        raise AssertionError(f"表名重复：{TABLE_NAMES}")
    for item in TABLES:
        header = f"CREATE TABLE IF NOT EXISTS {item.table} ("
        if header not in item.ddl:
            raise AssertionError(
                f"{item.table} 的 DDL 表头与表名对不上：{item.ddl.splitlines()[0]}"
            )
        parsed = _ddl_column_names(item.ddl)
        if not parsed:
            raise AssertionError(f"{item.table} 的 DDL 里解析不出任何列")
        if parsed != item.columns:
            raise AssertionError(
                f"{item.table} 的 DDL 列与清单列不一致：DDL={parsed} 清单={item.columns}"
            )
        if not item.primary_key:
            raise AssertionError(f"{item.table} 没有主键（DDL 里没解析到 PRIMARY KEY）")
        missing_pk = [name for name in item.primary_key if name not in parsed]
        if missing_pk:
            raise AssertionError(f"{item.table} 的主键列不在列清单里：{missing_pk}")
        for name in item.not_null:
            if name not in parsed:
                raise AssertionError(f"{item.table} 的 NOT NULL 列不在列清单里：{name}")
        for name in item.constraints:
            if name not in item.ddl:
                raise AssertionError(f"{item.table} 缺少唯一约束 {name}")
        for index_ddl in item.indexes:
            if f" ON {item.table} " not in index_ddl:
                raise AssertionError(f"{item.table} 的索引语句表名对不上：{index_ddl}")
            for name in _index_columns(index_ddl):
                if name not in parsed:
                    raise AssertionError(
                        f"{item.table} 的索引建在清单外的列上：{name}（{index_ddl}）"
                    )
        fk_targets = {target for _column, target, _tcolumn, _action in item.foreign_keys}
        missing = sorted(fk_targets - set(PREREQ_TABLES))
        if missing:
            raise AssertionError(
                f"{item.table} 的外键指向未声明的前置表 {missing}；请把它们加进 PREREQ_TABLES"
            )
    for item in COLUMNS:
        if item.table not in PREREQ_TABLES:
            raise AssertionError(
                f"新列 {item.table}.{item.column} 的宿主表不在 PREREQ_TABLES 里"
            )
        if item.table in TABLE_NAMES:
            raise AssertionError(
                f"{item.table} 是本次新建的表，它的列应该写在 DDL 里，不该再列一行新列"
            )
        if not item.type_name or item.type_name == "NOT":
            raise AssertionError(f"{item.table}.{item.column} 的列定义解析不出类型：{item.ddl}")
        if item.not_null and not item.has_default:
            raise AssertionError(
                f"{item.table}.{item.column} 是 NOT NULL 却没带 DEFAULT，"
                f"SQLite 的 ALTER TABLE 会直接拒绝：{item.ddl}"
            )
    if len(column_pairs()) != len(set(column_pairs())):
        raise AssertionError(f"新列清单里有重复项：{column_pairs()}")


def _with_parsed_expectations(item: NewTable) -> NewTable:
    """用 DDL 文本解析出的期望值补全一张表的 ``not_null`` / ``primary_key`` / ``foreign_keys``。

    为什么这么绕：``NewTable`` 是 frozen dataclass，而"结构化期望值"必须**从 DDL 派生**
    （否则清单里就有了两份会漂移的真相），所以先构造、再 ``dataclasses.replace`` 回填。
    回填发生在 :func:`_self_check` 之前，因此自检校验的就是最终那份清单。
    """
    defs = _ddl_column_defs(item.ddl)
    return replace(
        item,
        columns=item.columns or _ddl_column_names(item.ddl),
        not_null=tuple(name for name, rest in defs if "NOT NULL" in rest.upper()),
        primary_key=_ddl_primary_key(item.ddl, defs),
        foreign_keys=_ddl_foreign_keys(item.ddl),
    )


TABLES = tuple(_with_parsed_expectations(item) for item in TABLES)


_self_check()


__all__ = [
    "COLUMNS",
    "DRAMA_PLAN_MATERIALS_TABLE",
    "DRAMA_PLAN_MATERIALS_TABLE_COLUMNS",
    "DRAMA_PLAN_MATERIALS_TABLE_DDL",
    "DRAMA_PLAN_MATERIALS_TABLE_INDEXES",
    "DRAMA_PLAN_MATERIALS_TABLE_UNIQUE_CONSTRAINT",
    "NewColumn",
    "NewTable",
    "PREREQ_TABLES",
    "PRODUCT_CARDS_TABLE",
    "PRODUCT_CARDS_TABLE_COLUMNS",
    "PRODUCT_CARDS_TABLE_DDL",
    "PRODUCT_CARDS_TABLE_INDEXES",
    "TABLES",
    "TABLE_NAMES",
    "column_count",
    "column_pairs",
    "columns_of",
    "describe",
    "index_ddl_of",
    "index_names",
    "new_columns_of",
    "table_count",
    "table_names",
]
