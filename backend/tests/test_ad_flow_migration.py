"""「剧情广告」数据契约（2 张新表 + 8 个新列）的迁移 / 回滚回归测试。

全部用 ``tmp_path`` 现造的库，**绝不连正式库**：不使用 ``DATABASE_URL``、
不连 ``backend/jellyfish.db``、不用 ``with TestClient(app)``。

锁住七件事：

1. **三方对账**：清单（``scripts/_ad_flow.py``，其期望值本身由 DDL 解析而来）
   ↔ ORM（``app/models/studio_ad_flow.py`` + 三张既有表的 8 个新列）
   ↔ 真实库（``PRAGMA table_info`` / ``foreign_key_list`` / ``index_list`` /
   ``sqlite_master.sql``）：列名顺序、``NOT NULL``、主键、外键（含 ``ON DELETE``）、
   索引名、唯一约束名必须**三边一致**；
2. ``--check`` / ``--print-only`` **只读**：不建表、不加列、不改文件 mtime、不生成备份、
   不生成 ``-wal``/``-shm``；
3. **默认先备份**：备份快照是"迁移前"的状态（没有被迁移碰过的结构）；
4. **幂等**：第二次跑输出"已存在，跳过"，不重复备份，表里的行数不变；
5. **回滚**：2 张表与 8 列都消失、``--check`` 只读、回滚后能再迁移回来；
6. **往返不丢旧数据**：迁移 → 回滚 → 再迁移之后，迁移前就存在的表与行的**原有列**逐行相同
   （回滚会丢掉"迁移之后写进新表/新列"的数据 —— 这是回滚的语义，不是缺陷）；
7. **约束真的生效**：``drama_plan_materials`` 的唯一约束挡住重复登记，
   ``ON DELETE CASCADE`` 真的随项目/章节级联删除。
"""

from __future__ import annotations

import importlib.util
import sqlite3
import sys
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = BACKEND_ROOT / "scripts"

# scripts/（共享清单模块）与 backend/（app 包）都要在 sys.path 上：
# 直接跑脚本时 sys.path[0] 是 scripts/，脚本自己也会把 backend/ 兜进去。
for _entry in (SCRIPTS_DIR, BACKEND_ROOT):
    if str(_entry) not in sys.path:
        sys.path.insert(0, str(_entry))

PROJECT_ID = "proj-1"
CHAPTER_ID = "chap-1"

BACKUP_PREFIX = ".backup_before_ad_flow_"

#: 最小前置表结构：只保留本次变更真正依赖的表与列
#: （两张新表的外键目标 + 三个新列的宿主表，列名与既有库一致）。
_PREREQ_DDL: tuple[str, ...] = (
    """
    CREATE TABLE projects (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        start_mode VARCHAR(16) NOT NULL DEFAULT 'script',
        stats JSON NOT NULL DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
    )
    """,
    """
    CREATE TABLE chapters (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        project_id VARCHAR(64) NOT NULL,
        title VARCHAR(255) NOT NULL DEFAULT '',
        storyboard_count INTEGER NOT NULL DEFAULT 0
    )
    """,
    """
    CREATE TABLE drama_plan_drafts (
        chapter_id VARCHAR(64) NOT NULL PRIMARY KEY,
        project_id VARCHAR(64) NOT NULL,
        brief JSON NOT NULL,
        plan JSON NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
    )
    """,
    """
    CREATE TABLE products (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
    )
    """,
)

#: 迁移**之前**就必须存在的数据：往返验证比较的就是它们。
#: 键是表名，值是该表迁移前就有的列（用于逐行快照，不碰任何新列）。
_PRE_EXISTING_COLUMNS: dict[str, tuple[str, ...]] = {
    "projects": ("id", "name", "description", "start_mode", "stats"),
    "chapters": ("id", "project_id", "title", "storyboard_count"),
    "drama_plan_drafts": ("chapter_id", "project_id", "brief", "plan", "status", "error"),
    "products": ("id", "name", "description"),
}

_SCRIPT_CACHE: dict[str, Any] = {}


def _load_script(name: str) -> Any:
    """按文件路径加载 scripts/ 下的脚本（只加载一次）。

    加载前先登记进 ``sys.modules``：脚本里有 ``from __future__ import annotations`` +
    ``@dataclass``，dataclasses 判断字符串注解时要查 ``sys.modules[cls.__module__]``，
    不登记就会拿到 ``None`` 而在装饰时炸掉。
    """
    if name not in _SCRIPT_CACHE:
        spec = importlib.util.spec_from_file_location(
            f"_jf_script_{name}", SCRIPTS_DIR / f"{name}.py"
        )
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules[module.__name__] = module
        spec.loader.exec_module(module)
        _SCRIPT_CACHE[name] = module
    return _SCRIPT_CACHE[name]


def _connect(path: Path, *, read_only: bool = False) -> sqlite3.Connection:
    if read_only:
        return sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    return sqlite3.connect(str(path))


def _tables(path: Path) -> set[str]:
    conn = _connect(path, read_only=True)
    try:
        rows = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    finally:
        conn.close()
    return {str(row[0]) for row in rows}


def _table_info(path: Path, table: str) -> list[tuple[str, str, int, Any, int]]:
    """``[(列名, 声明类型, NOT NULL, 默认值, 主键序号), ...]``（表不存在时为空列表）。"""
    conn = _connect(path, read_only=True)
    try:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    finally:
        conn.close()
    return [(str(row[1]), str(row[2]), int(row[3]), row[4], int(row[5])) for row in rows]


def _columns(path: Path, table: str) -> list[str]:
    return [name for name, _type, _notnull, _default, _pk in _table_info(path, table)]


def _table_sql(path: Path, table: str) -> str:
    conn = _connect(path, read_only=True)
    try:
        row = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
        ).fetchone()
    finally:
        conn.close()
    return str(row[0] or "") if row else ""


def _fk_list(path: Path, table: str) -> list[tuple[str, str, str, str]]:
    conn = _connect(path, read_only=True)
    try:
        rows = conn.execute(f"PRAGMA foreign_key_list({table})").fetchall()
    finally:
        conn.close()
    return sorted(
        (str(row[3]), str(row[2]), str(row[4]), str(row[6] or "").upper()) for row in rows
    )


def _index_names(path: Path, table: str) -> set[str]:
    conn = _connect(path, read_only=True)
    try:
        rows = conn.execute(f"PRAGMA index_list({table})").fetchall()
    finally:
        conn.close()
    return {str(row[1]) for row in rows}


def _rows(path: Path, table: str, columns: tuple[str, ...]) -> list[tuple[Any, ...]]:
    """按给定列取全表快照（用于往返比较"原样不丢"）。"""
    conn = _connect(path, read_only=True)
    try:
        rows = conn.execute(
            f"SELECT {', '.join(columns)} FROM {table} ORDER BY {columns[0]}"
        ).fetchall()
    finally:
        conn.close()
    return [tuple(row) for row in rows]


def _prereq_db(path: Path) -> Path:
    """只有前置表 + 一点旧数据的库（迁移、回滚、往返验证都用它）。"""
    conn = _connect(path)
    try:
        for ddl in _PREREQ_DDL:
            conn.execute(ddl)
        conn.execute(
            "INSERT INTO projects (id, name, description, start_mode, stats) "
            "VALUES (?, '旧项目', '迁移前就存在', 'script', '{\"shots\": 3}')",
            (PROJECT_ID,),
        )
        conn.execute(
            "INSERT INTO chapters (id, project_id, title, storyboard_count) "
            "VALUES (?, ?, '第一集', 3)",
            (CHAPTER_ID, PROJECT_ID),
        )
        conn.execute(
            "INSERT INTO drama_plan_drafts (chapter_id, project_id, brief, plan, status, error) "
            "VALUES (?, ?, '{\"product\": \"面膜\"}', '{\"one_liner\": \"熬夜救星\"}', 'ok', '')",
            (CHAPTER_ID, PROJECT_ID),
        )
        conn.execute(
            "INSERT INTO products (id, name, description) VALUES ('prod-1', '旧商品', '迁移前就存在')"
        )
        conn.commit()
    finally:
        conn.close()
    return path


def _backups(tmp_path: Path) -> list[Path]:
    return sorted(tmp_path.glob(f"*{BACKUP_PREFIX}*"))


def _insert_product_card(db: Path, project_id: str, **overrides: Any) -> None:
    """用**裸 SQL** 插一张商品卡。

    为什么要这个 helper：``product_cards`` 的列全部 ``NOT NULL``，而默认值只在
    SQLAlchemy（ORM / Core insert）里生效 —— SQLite 自己的 schema 里没有 ``DEFAULT``
    （新表与 ``product_images`` / ``products`` 同口径）。所以裸 SQL 必须把所有
    ``NOT NULL`` 列都给上，这里把"空卡的默认取值"集中在一处，测试读起来才不吵。
    """
    values: dict[str, Any] = {
        "project_id": project_id,
        "name": "",
        "category": "",
        "brand": "",
        "selling_points": "[]",
        "scenarios": "[]",
        "audience": "",
        "price_info": "",
        "compliance": "",
        "notes": "",
        "reference_files": "[]",
        "source_type": "",
        "source_summary": "{}",
        "missing_fields": "[]",
        "confirmed": 0,
    }
    values.update(overrides)
    conn = _connect(db)
    try:
        conn.execute(
            f"INSERT INTO product_cards ({', '.join(values)}) "
            f"VALUES ({', '.join('?' for _ in values)})",
            tuple(values.values()),
        )
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# 1) --check / --print-only 只读
# ---------------------------------------------------------------------------


def test_check_mode_does_not_write(tmp_path: Path, capsys: Any) -> None:
    """``--check`` 不得建表、不得加列、不得改文件、不得生成备份。"""
    # pylint: disable=import-error  # scripts/ 已在上文注入 sys.path
    import _ad_flow as shared

    migrate = _load_script("migrate_ad_flow")
    db = _prereq_db(tmp_path / "check_only.db")
    before_mtime = db.stat().st_mtime_ns
    before_columns = {item.table: _columns(db, item.table) for item in shared.COLUMNS}

    assert migrate.migrate(check_only=True, db_path=db) == 0
    out = capsys.readouterr().out

    assert _tables(db) & set(shared.table_names()) == set()
    for item in shared.COLUMNS:
        assert _columns(db, item.table) == before_columns[item.table], (
            f"--check 不该给 {item.table} 加列"
        )
    assert db.stat().st_mtime_ns == before_mtime
    assert not (tmp_path / "check_only.db-wal").exists()
    assert not (tmp_path / "check_only.db-shm").exists()
    assert _backups(tmp_path) == []

    assert "未执行" in out
    assert "缺 2 张表、8 列" in out
    assert "只读连接" in out


def test_print_only_cli_flag_does_not_write(tmp_path: Path, monkeypatch: Any, capsys: Any) -> None:
    """``--print-only`` 走命令行入口时也必须只读，且把将执行的 SQL 打出来。"""
    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _ad_flow as shared

    migrate = _load_script("migrate_ad_flow")
    db = _prereq_db(tmp_path / "print_only.db")
    before_mtime = db.stat().st_mtime_ns

    monkeypatch.setattr(
        sys, "argv", ["migrate_ad_flow.py", "--print-only", "--db", str(db)]
    )
    assert migrate.main() == 0
    out = capsys.readouterr().out

    assert _tables(db) & set(shared.table_names()) == set()
    assert "kind" not in _columns(db, "projects")
    assert db.stat().st_mtime_ns == before_mtime
    assert _backups(tmp_path) == []
    # 打印的是真会执行的 SQL（不是空话）
    assert "ALTER TABLE projects ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'drama'" in out
    assert "CREATE TABLE IF NOT EXISTS product_cards (" in out


# ---------------------------------------------------------------------------
# 2) 三方对账：清单 ↔ ORM ↔ 真实库
# ---------------------------------------------------------------------------


def test_manifest_matches_orm_and_pragma(tmp_path: Path) -> None:
    """新表：列名顺序 / NOT NULL / 主键 / 外键（含 ON DELETE）/ 索引名 / 唯一约束名三方一致。"""
    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _ad_flow as shared

    import app.models.studio  # noqa: F401 - 导入即把新表注册进 Base.metadata
    from app.core.db import Base

    migrate = _load_script("migrate_ad_flow")
    db = _prereq_db(tmp_path / "schema.db")
    assert migrate.migrate(check_only=False, db_path=db) == 0

    # 前置表清单必须覆盖"新列的宿主表"与"新表的外键目标"，否则迁移会跑出 no such table
    alter_targets = {item.table for item in shared.COLUMNS}
    fk_targets = {target for item in shared.TABLES for _c, target, _t, _a in item.foreign_keys}
    assert alter_targets | fk_targets <= set(shared.PREREQ_TABLES)

    for item in shared.TABLES:
        orm_table = Base.metadata.tables[item.table]
        actual = _table_info(db, item.table)

        # (a) 列名与顺序：清单 = ORM = 库里，三方完全相等
        assert item.columns == shared.columns_of(item.table)
        assert [name for name, _t, _n, _d, _pk in actual] == list(orm_table.columns.keys()), (
            f"{item.table} 列顺序与 ORM 不一致"
        )
        assert tuple(name for name, _t, _n, _d, _pk in actual) == item.columns, (
            f"{item.table} 列与清单不一致"
        )

        # (b) NOT NULL
        pragma_not_null = tuple(name for name, _t, n, _d, _pk in actual if n)
        orm_not_null = tuple(c.name for c in orm_table.columns if not c.nullable)
        assert pragma_not_null == orm_not_null == item.not_null, (
            f"{item.table} 的 NOT NULL 三方不一致"
        )

        # (c) 主键
        pragma_pk = tuple(name for name, _t, _n, _d, pk in actual if pk)
        orm_pk = tuple(c.name for c in orm_table.primary_key.columns)
        assert pragma_pk == orm_pk == item.primary_key, f"{item.table} 主键三方不一致"

        # (d) 外键（列 + 目标表 + 目标列 + ON DELETE 动作）
        fk_rows = _fk_list(db, item.table)
        orm_fks = sorted(
            (
                element.parent.name,
                element.column.table.name,
                element.column.name,
                str(constraint.ondelete or "").upper(),
            )
            for constraint in orm_table.foreign_key_constraints
            for element in constraint.elements
        )
        assert fk_rows == orm_fks == sorted(item.foreign_keys), (
            f"{item.table} 外键（含 ON DELETE）三方不一致"
        )

        # (e) 索引名（清单声明的索引必须都在 ORM 与库里；库里的自动索引不算问题）
        manifest_indexes = set(shared.index_names(item))
        orm_indexes = {index.name for index in orm_table.indexes}
        pragma_indexes = _index_names(db, item.table)
        assert manifest_indexes == orm_indexes, f"{item.table} 索引名与 ORM 不一致"
        assert pragma_indexes >= manifest_indexes, f"{item.table} 库里缺索引 {manifest_indexes}"

        # (f) 唯一约束名：清单 = ORM = 建表 SQL
        orm_unique = {c.name for c in orm_table.constraints if c.__class__.__name__ == "UniqueConstraint"}
        assert set(item.constraints) == orm_unique, f"{item.table} 唯一约束名与 ORM 不一致"
        sql = _table_sql(db, item.table)
        for name in item.constraints:
            assert name in sql, f"{item.table} 的建表 SQL 里找不到唯一约束 {name}"

    # 唯一约束片段也留在清单里（文档/校验引用它）
    assert (
        shared.DRAMA_PLAN_MATERIALS_TABLE_UNIQUE_CONSTRAINT
        in shared.DRAMA_PLAN_MATERIALS_TABLE_DDL
    )
    assert shared.TABLE_NAMES == (shared.PRODUCT_CARDS_TABLE, shared.DRAMA_PLAN_MATERIALS_TABLE)
    assert shared.table_names() == shared.TABLE_NAMES
    assert shared.table_count() == len(shared.TABLES) == 2
    assert shared.column_count() == len(shared.COLUMNS) == 8


def test_new_columns_match_orm_and_pragma(tmp_path: Path) -> None:
    """8 个新列：类型 / NOT NULL / DEFAULT 三方一致（迁移后的库 vs ORM vs 清单）。"""
    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _ad_flow as shared

    import app.models.studio  # noqa: F401
    from app.core.db import Base
    from sqlalchemy.dialects import sqlite as sqlite_dialect

    dialect = sqlite_dialect.dialect()

    migrate = _load_script("migrate_ad_flow")
    db = _prereq_db(tmp_path / "columns.db")
    assert migrate.migrate(check_only=False, db_path=db) == 0

    for item in shared.COLUMNS:
        orm_column = Base.metadata.tables[item.table].columns[item.column]
        found = {
            name: (type_name, notnull, default)
            for name, type_name, notnull, default, _pk in _table_info(db, item.table)
        }
        assert item.column in found, f"{item.table} 缺列 {item.column}"
        type_name, notnull, default = found[item.column]

        # (a) 类型
        assert type_name.upper() == item.type_name, f"{item.table}.{item.column} 类型不一致"
        assert type_name.upper() == orm_column.type.compile(dialect=dialect).upper(), (
            f"{item.table}.{item.column} 类型与 ORM 不一致"
        )
        # (b) NOT NULL
        assert bool(notnull) == item.not_null == (not orm_column.nullable), (
            f"{item.table}.{item.column} 的 NOT NULL 三方不一致"
        )
        # (c) DEFAULT 有无（新列在 SQLite 里必须带默认值才能是 NOT NULL；
        #     可空列不写 DEFAULT，与 ORM 的 server_default 对齐。
        #     显式 `DEFAULT NULL` 与"没写 DEFAULT"对可空列等价，两边都按"有意义的默认值"归一）
        assert migrate.has_value_default(default) == item.has_default, (
            f"{item.table}.{item.column} 默认值不一致"
        )
        orm_default = (
            str(orm_column.server_default.arg)
            if orm_column.server_default is not None
            else None
        )
        assert migrate.has_value_default(default) == migrate.has_value_default(orm_default), (
            f"{item.table}.{item.column} 的 DEFAULT 与 ORM 不一致"
        )


def test_new_column_hosts_and_prereq_are_all_declared() -> None:
    """清单自洽：新列宿主表都在 PREREQ_TABLES 里；新列不会落在本次新建的表中。"""
    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _ad_flow as shared

    for item in shared.COLUMNS:
        assert item.table in shared.PREREQ_TABLES
        assert item.table not in shared.TABLE_NAMES
    assert shared.column_pairs() == (
        ("projects", "kind"),
        ("drama_plan_drafts", "story_status"),
        ("drama_plan_drafts", "stale_flags"),
        ("drama_plan_drafts", "manual_edited_at"),
        ("drama_plan_drafts", "confirmed_at"),
        ("drama_plan_drafts", "materialized_at"),
        ("drama_plan_drafts", "materialize_summary"),
        ("products", "provenance"),
    )
    assert shared.new_columns_of("drama_plan_drafts") == shared.COLUMNS[1:7]


# ---------------------------------------------------------------------------
# 3) 默认先备份 + 4) 幂等
# ---------------------------------------------------------------------------


def test_default_run_creates_backup_of_pre_migration_state(tmp_path: Path) -> None:
    """默认执行必须在建表/加列的**之前**先留一份一致性快照。"""
    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _ad_flow as shared

    migrate = _load_script("migrate_ad_flow")
    db = _prereq_db(tmp_path / "backup.db")

    assert migrate.migrate(check_only=False, db_path=db) == 0

    backups = _backups(tmp_path)
    assert len(backups) == 1
    # 备份是"迁移前"的状态：新表不在、新列不在，但前置表与旧数据在
    assert _tables(backups[0]) & set(shared.table_names()) == set()
    assert "kind" not in _columns(backups[0], "projects")
    assert "projects" in _tables(backups[0])
    assert _rows(backups[0], "projects", ("id", "name")) == [(PROJECT_ID, "旧项目")]


def test_second_run_skips_existing_and_does_not_backup_again(tmp_path: Path, capsys: Any) -> None:
    """连续跑两次：第二次报告"已存在，跳过"，不再生成第二份备份，数据行数不变。"""
    migrate = _load_script("migrate_ad_flow")
    db = _prereq_db(tmp_path / "idempotent.db")

    assert migrate.migrate(check_only=False, db_path=db) == 0
    first_backups = _backups(tmp_path)
    assert len(first_backups) == 1
    # 顺手写点数据进新表：幂等重跑不该动它们
    _insert_product_card(db, PROJECT_ID, name="面膜")
    conn = _connect(db)
    try:
        conn.execute(
            "INSERT INTO drama_plan_materials (project_id, chapter_id, entity_type, entity_id, source) "
            "VALUES (?, ?, 'product', 'prod-1', 'plan')",
            (PROJECT_ID, CHAPTER_ID),
        )
        conn.commit()
    finally:
        conn.close()
    capsys.readouterr()

    assert migrate.migrate(check_only=False, db_path=db) == 0
    out = capsys.readouterr().out

    assert "已存在，跳过建表" in out
    assert "已存在，跳过加列" in out
    assert "都已存在，无需迁移" in out
    assert _backups(tmp_path) == first_backups
    assert _rows(db, "product_cards", ("name",)) == [("面膜",)]
    assert _rows(db, "drama_plan_materials", ("entity_id",)) == [("prod-1",)]


# ---------------------------------------------------------------------------
# 5) 回滚（含 --check 只读）
# ---------------------------------------------------------------------------


def test_rollback_removes_tables_and_columns_then_migrate_again(
    tmp_path: Path, capsys: Any
) -> None:
    """回滚删掉 2 张表与 8 列、``--check`` 不写库、回滚后能再迁移回来。"""
    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _ad_flow as shared

    migrate = _load_script("migrate_ad_flow")
    rollback = _load_script("rollback_ad_flow")
    db = _prereq_db(tmp_path / "rollback.db")

    assert migrate.migrate(check_only=False, db_path=db) == 0
    assert set(shared.table_names()) <= _tables(db)

    # 回滚的 --check 只读：什么都不删、不改 mtime、不备份
    before_mtime = db.stat().st_mtime_ns
    before_backups = _backups(tmp_path)
    assert rollback.rollback(check_only=True, db_path=db) == 0
    out = capsys.readouterr().out
    assert "未执行" in out
    assert "只读连接" in out
    assert "DROP TABLE product_cards" in out
    assert "DROP COLUMN projects.kind" in out
    assert db.stat().st_mtime_ns == before_mtime
    assert _backups(tmp_path) == before_backups
    assert set(shared.table_names()) <= _tables(db)
    assert "kind" in _columns(db, "projects")

    # 真回滚：2 张表与 8 列都不在
    assert rollback.rollback(check_only=False, db_path=db) == 0
    assert _tables(db) & set(shared.table_names()) == set()
    for item in shared.COLUMNS:
        assert item.column not in _columns(db, item.table), f"{item.table}.{item.column} 还在"

    # 还能再迁移回来（空表重建 + 列默认值回填）
    assert migrate.migrate(check_only=False, db_path=db) == 0
    assert set(shared.table_names()) <= _tables(db)
    for item in shared.COLUMNS:
        assert item.column in _columns(db, item.table)


def test_rollback_check_cli_flag_is_read_only(tmp_path: Path, monkeypatch: Any) -> None:
    """``--check`` 走命令行入口时也必须只读（flag → check_only 的映射要锁住）。"""
    rollback = _load_script("rollback_ad_flow")
    migrate = _load_script("migrate_ad_flow")
    db = _prereq_db(tmp_path / "rollback_cli.db")
    assert migrate.migrate(check_only=False, db_path=db) == 0

    before_mtime = db.stat().st_mtime_ns
    monkeypatch.setattr(sys, "argv", ["rollback_ad_flow.py", "--check", "--db", str(db)])
    assert rollback.main() == 0

    assert db.stat().st_mtime_ns == before_mtime
    assert "product_cards" in _tables(db)
    assert "kind" in _columns(db, "projects")


# ---------------------------------------------------------------------------
# 6) 往返：迁移 → 回滚 → 再迁移，旧数据一行不少
# ---------------------------------------------------------------------------


def test_round_trip_keeps_pre_existing_data(tmp_path: Path) -> None:
    """往返验证：迁移前的表与行**原样保留**；只有迁移后才写入的新表/新列数据会随回滚消失。"""
    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _ad_flow as shared

    migrate = _load_script("migrate_ad_flow")
    rollback = _load_script("rollback_ad_flow")
    db = _prereq_db(tmp_path / "round_trip.db")

    before = {table: _rows(db, table, columns) for table, columns in _PRE_EXISTING_COLUMNS.items()}

    # 第一次迁移：结构到位，旧行拿到默认值
    assert migrate.migrate(check_only=False, db_path=db) == 0
    assert _rows(db, "products", ("id", "name", "description", "provenance")) == [
        ("prod-1", "旧商品", "迁移前就存在", "{}")
    ]
    assert _rows(db, "projects", ("id", "name", "kind")) == [(PROJECT_ID, "旧项目", "drama")]

    # 迁移之后才产生的数据（这些就是回滚要丢的，属于回滚语义）
    _insert_product_card(
        db, PROJECT_ID, name="新面膜", category="护肤", confirmed=1, source_summary='{"model": "x"}'
    )
    conn = _connect(db)
    try:
        conn.execute(
            "UPDATE drama_plan_drafts SET story_status='confirmed', "
            "materialize_summary='{\"shots_created\": 3}' WHERE chapter_id = ?",
            (CHAPTER_ID,),
        )
        conn.commit()
    finally:
        conn.close()

    # 回滚：新表/新列消失，旧数据不受影响
    assert rollback.rollback(check_only=False, db_path=db) == 0
    assert _tables(db) & set(shared.table_names()) == set()
    for table, columns in _PRE_EXISTING_COLUMNS.items():
        assert _rows(db, table, columns) == before[table], f"{table} 的旧数据在回滚后变了"

    # 再迁移：结构回来、新表是空的、旧行的新列回到默认值、旧数据仍旧一行不少
    assert migrate.migrate(check_only=False, db_path=db) == 0
    for table, columns in _PRE_EXISTING_COLUMNS.items():
        assert _rows(db, table, columns) == before[table], f"{table} 的旧数据在再迁移后变了"
    assert _rows(db, "product_cards", ("project_id", "name")) == []
    assert _rows(db, "drama_plan_materials", ("entity_id",)) == []
    assert _rows(db, "projects", ("id", "kind")) == [(PROJECT_ID, "drama")]
    assert _rows(db, "products", ("id", "provenance")) == [("prod-1", "{}")]
    assert _rows(db, "drama_plan_drafts", ("chapter_id", "story_status", "materialize_summary")) == [
        (CHAPTER_ID, "none", "{}")
    ]


# ---------------------------------------------------------------------------
# 7) 约束真的生效（幂等的数据库级兜底 + 级联删除）
# ---------------------------------------------------------------------------


def test_unique_constraint_and_cascade_delete_are_enforced(tmp_path: Path) -> None:
    """``uq_drama_plan_materials_entity_scope`` 挡住重复登记；项目/章节删除时级联清理。"""
    migrate = _load_script("migrate_ad_flow")
    db = _prereq_db(tmp_path / "constraints.db")
    assert migrate.migrate(check_only=False, db_path=db) == 0

    conn = _connect(db)
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        insert = (
            "INSERT INTO drama_plan_materials "
            "(project_id, chapter_id, entity_type, entity_id, source) VALUES (?, ?, 'product', ?, 'plan')"
        )
        conn.execute(insert, (PROJECT_ID, CHAPTER_ID, "prod-1"))
        # 同一章同一实体同一来源 = 重复确认的那一行，必须被唯一约束挡住
        try:
            conn.execute(insert, (PROJECT_ID, CHAPTER_ID, "prod-1"))
        except sqlite3.IntegrityError:
            duplicated = True
        else:
            duplicated = False
        assert duplicated, "唯一约束没有挡住重复登记（幂等就只剩应用层保证了）"
        # 来源不同则允许各留一行（plan 与 manual 是两件事）
        conn.execute(
            "INSERT INTO drama_plan_materials "
            "(project_id, chapter_id, entity_type, entity_id, source) VALUES (?, ?, 'product', ?, 'manual')",
            (PROJECT_ID, CHAPTER_ID, "prod-1"),
        )
        conn.commit()

        # 级联：删章节 → 该章的来源关系一起走；删项目 → 商品卡与来源关系一起走
        _insert_product_card(db, PROJECT_ID, name="面膜")
        conn.execute("DELETE FROM chapters WHERE id = ?", (CHAPTER_ID,))
        conn.commit()
        assert conn.execute("SELECT COUNT(*) FROM drama_plan_materials").fetchone()[0] == 0
        conn.execute("DELETE FROM projects WHERE id = ?", (PROJECT_ID,))
        conn.commit()
        assert conn.execute("SELECT COUNT(*) FROM product_cards").fetchone()[0] == 0
    finally:
        conn.close()
    assert "product_cards" in _tables(db)
