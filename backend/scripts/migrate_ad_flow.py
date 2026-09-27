#!/usr/bin/env python3
"""迁移「剧情广告」数据契约：建 2 张新表 + 给 3 张既有表加 8 个新列（幂等、带备份、可回滚）。

为什么需要它
============

「剧情广告完整闭环」（``site/content/docs/plans/drama-ad-full-loop.md`` §一）要在
商品卡 → 分层剧情 → 确认落库这条链上用到 2 张此前不存在的表和 8 个此前不存在的列。
本仓库**不用 Alembic**，也没有版本表：改已有库靠 ``scripts/migrate_*.py`` 这类
**手写幂等脚本**，靠"表/列存在性探测"决定跳过什么（先例：``migrate_chapter_asset_records.py``、
``migrate_product_and_drama_plan.py``、``migrate_llm_pipeline_columns.py``）。

为什么不写成 ``sql/0xx-*.sql``
=============================

``backend/sql/`` 下的文件是 **MySQL 方言**（``information_schema`` / ``PREPARE`` /
``MODIFY COLUMN``），而运行时用的是 SQLite，**没有任何代码执行它们**。
所以这里给的是真能跑的 SQLite 迁移器（与既有三个迁移脚本同一判断）。

幂等
====

- 建表：``CREATE TABLE IF NOT EXISTS`` / ``CREATE INDEX IF NOT EXISTS``；
- 加列：先查 ``PRAGMA table_info``，列已存在就跳过；
- 库里已有的表和列**一个字都不动**，重复执行结果一致（第二次输出"已存在，跳过"，且不再备份）；
- 本迁移**不搬任何数据**：2 张表是全新表；8 个新列都有默认值，旧行由
  ``DEFAULT`` 自动回填（``kind='drama'`` 等），因此老数据的行为与迁移前完全一致。

备份
====

默认执行**先备份**，用 SQLite 的 ``backup`` API 做一致性快照（WAL 下直接拷文件会丢
未 checkpoint 的数据），文件名 ``{db.name}.backup_before_ad_flow_{YYYYmmdd_HHMMSS}``。
``--check`` / ``--print-only`` 全程只开**只读连接**（``file:...?mode=ro``），
不建表、不加列、不改文件 mtime、也不生成备份。

跑法：
    cd backend && uv run python scripts/migrate_ad_flow.py               # 执行
    cd backend && uv run python scripts/migrate_ad_flow.py --check       # 只检查缺什么
    cd backend && uv run python scripts/migrate_ad_flow.py --print-only  # 只打印将执行的 SQL
    cd backend && uv run python scripts/migrate_ad_flow.py --db /tmp/copy.db

同目录另有回滚脚本 ``rollback_ad_flow.py``；清单**只有一份**：``scripts/_ad_flow.py``
（迁移与回滚共用，禁止各写一份）。
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent

# 直接跑脚本时 sys.path[0] 是 scripts/（清单模块在这一层），而 cwd 不在路径上。
SCRIPT_DIR = Path(__file__).resolve().parent
for _entry in (SCRIPT_DIR, BACKEND_ROOT):
    if str(_entry) not in sys.path:
        sys.path.insert(0, str(_entry))

# pylint: disable=import-error,wrong-import-position  # 上面刚把 scripts/ 与 backend/ 注入 sys.path
from _ad_flow import (  # noqa: E402
    COLUMNS,
    PREREQ_TABLES,
    TABLES,
    column_count,
    describe,
    index_ddl_of,
    index_names,
    table_count,
)

DB_PATH = BACKEND_ROOT / "jellyfish.db"

#: 一行 ``PRAGMA table_info`` 的结构化视图：``(列名, 声明类型, NOT NULL, 默认值, 主键序号)``。
ColumnInfo = tuple[str, str, int, str | None, int]


def _connect(db_path: Path, *, read_only: bool = False) -> sqlite3.Connection:
    """打开数据库；``read_only`` 时用 URI 只读模式（连 WAL 边车都不动）。"""
    if read_only:
        return sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    return sqlite3.connect(str(db_path))


def existing_tables(conn: sqlite3.Connection) -> set[str]:
    """库里当前已有的表名集合（以 ``sqlite_master`` 为准，不猜）。"""
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    return {str(row[0]) for row in rows}


def column_info(conn: sqlite3.Connection, table: str) -> tuple[ColumnInfo, ...]:
    """表当前的结构化列信息（表不存在时返回空元组）。

    用 ``PRAGMA table_info`` 而不是猜：列名顺序、``NOT NULL``、默认值、主键序号都在这里，
    迁移后的逐列校验与测试的三方对账读的是同一份事实。
    """
    try:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    except sqlite3.Error:
        return ()
    return tuple(
        (str(row[1]), str(row[2]), int(row[3]), row[4], int(row[5])) for row in rows
    )


def existing_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    """表当前实际存在的列名集合（表不存在时返回空集）。"""
    return {name for name, _type, _notnull, _default, _pk in column_info(conn, table)}


def existing_indexes(conn: sqlite3.Connection, table: str) -> set[str]:
    """表上的索引名集合（唯一约束的自动索引也在里面）。"""
    try:
        rows = conn.execute(f"PRAGMA index_list({table})").fetchall()
    except sqlite3.Error:
        return set()
    return {str(row[1]) for row in rows}


def table_sql(conn: sqlite3.Connection, table: str) -> str:
    """表在 ``sqlite_master`` 里的原始建表 SQL（唯一约束名只能从这里读到）。"""
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone()
    return str(row[0] or "") if row else ""


def foreign_keys(conn: sqlite3.Connection, table: str) -> tuple[tuple[str, str, str, str], ...]:
    """表的实际外键 ``(列, 目标表, 目标列, ON DELETE 动作)``，与清单同口径排序。"""
    try:
        rows = conn.execute(f"PRAGMA foreign_key_list({table})").fetchall()
    except sqlite3.Error:
        return ()
    return tuple(
        sorted(
            (str(row[3]), str(row[2]), str(row[4]), str(row[6] or "").upper())
            for row in rows
        )
    )


def backup_database(db_path: Path) -> Path:
    """用 SQLite 的 backup API 做一致性快照（WAL 下直接拷文件会丢未 checkpoint 的数据）。

    文件名时间戳只精确到秒，所以同一秒里连跑两次（例如"迁移→回滚→再迁移"的演练）
    会撞名：这里发现重名就追加 ``_2`` / ``_3``，**绝不覆盖**上一份备份。
    """
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    target = db_path.with_name(f"{db_path.name}.backup_before_ad_flow_{stamp}")
    suffix = 2
    while target.exists():
        target = db_path.with_name(f"{db_path.name}.backup_before_ad_flow_{stamp}_{suffix}")
        suffix += 1
    source = sqlite3.connect(str(db_path))
    try:
        dest = sqlite3.connect(str(target))
        try:
            source.backup(dest)
        finally:
            dest.close()
    finally:
        source.close()
    return target


def pending_changes(
    conn: sqlite3.Connection,
) -> tuple[list[str], list[tuple[str, str, str]]]:
    """算出还缺什么：``(待新建的表名, [(宿主表, 列名, 列定义), ...])``。

    探测用"表/列存在性"，所以幂等性与"库里现状"绑定，与清单顺序无关。
    """
    present = existing_tables(conn)
    pending_tables = [item.table for item in TABLES if item.table not in present]
    pending_columns: list[tuple[str, str, str]] = []
    for item in COLUMNS:
        if item.table not in present:
            # 宿主表都还没有：交给前置表检查报错，这里不重复计一遍。
            continue
        if item.column not in existing_columns(conn, item.table):
            pending_columns.append((item.table, item.column, item.ddl))
    return pending_tables, pending_columns


def has_value_default(default: str | None) -> bool:
    """``PRAGMA table_info.dflt_value`` 是否代表"有意义的默认值"。

    显式的 ``DEFAULT NULL`` 与"没写 DEFAULT"对可空列是等价的（取值都是 NULL），
    所以 ``dflt_value == 'NULL'`` 归一成"没有默认值"。
    这样既不会把等价的写法误报成漂移（隔壁 ``_llm_pipeline_columns.py`` 就给同类列写过
    ``DEFAULT NULL``），又能抓住真正的漂移（例如有人给这一列塞了个 ``DEFAULT '2020-01-01'``）。
    """
    return default is not None and str(default).strip().upper() != "NULL"


def verify_schema(conn: sqlite3.Connection) -> list[str]:
    """逐列 / 逐主键 / 逐外键 / 逐索引 / 逐唯一约束校验本次变更结果；返回问题清单。

    空列表 = 通过。检查口径与 ``tests/test_ad_flow_migration.py`` 的三方对账一致：
    清单（``_ad_flow.py``，其期望值本身是从 DDL 解析出来的）↔ 真实库（PRAGMA）。
    清理之外的额外列只提示不拦（可能是别的功能线后加的）。
    """
    problems: list[str] = []

    for item in TABLES:
        info = column_info(conn, item.table)
        if not info:
            problems.append(f"{item.table} 不存在（或没有列定义）")
            continue
        actual = tuple(name for name, _type, _notnull, _default, _pk in info)
        if actual != item.columns:
            problems.append(f"{item.table} 列名/顺序与清单不一致：库={actual} 清单={item.columns}")
        for name, _type, notnull, _default, _pk in info:
            expected_not_null = name in item.not_null
            if bool(notnull) != expected_not_null:
                problems.append(
                    f"{item.table}.{name} 的 NOT NULL 与清单不一致："
                    f"库={bool(notnull)} 清单={expected_not_null}"
                )
        actual_pk = tuple(name for name, _type, _notnull, _default, pk in info if pk)
        if actual_pk != item.primary_key:
            problems.append(f"{item.table} 主键与清单不一致：库={actual_pk} 清单={item.primary_key}")
        if foreign_keys(conn, item.table) != tuple(sorted(item.foreign_keys)):
            problems.append(
                f"{item.table} 外键（含 ON DELETE）与清单不一致："
                f"库={foreign_keys(conn, item.table)} 清单={tuple(sorted(item.foreign_keys))}"
            )
        indexes = existing_indexes(conn, item.table)
        for name in index_names(item):
            if name not in indexes:
                problems.append(f"{item.table} 缺少索引 {name}")
        sql = table_sql(conn, item.table)
        for name in item.constraints:
            if name not in sql:
                problems.append(f"{item.table} 缺少唯一约束 {name}")
        extra = sorted(set(actual) - set(item.columns))
        if extra:
            print(f"  · 提示：{item.table} 另有清单外的列（不影响使用）：{extra}")

    for item in COLUMNS:
        info = column_info(conn, item.table)
        if not info:
            problems.append(f"{item.table} 不存在，无法校验新列 {item.column}")
            continue
        found = {name: (type_name, notnull, default) for name, type_name, notnull, default, _pk in info}
        if item.column not in found:
            problems.append(f"{item.table} 缺少列 {item.column}")
            continue
        type_name, notnull, default = found[item.column]
        if type_name.upper() != item.type_name:
            problems.append(
                f"{item.table}.{item.column} 类型与清单不一致：库={type_name} 清单={item.type_name}"
            )
        if bool(notnull) != item.not_null:
            problems.append(
                f"{item.table}.{item.column} 的 NOT NULL 与清单不一致："
                f"库={bool(notnull)} 清单={item.not_null}"
            )
        if has_value_default(default) != item.has_default:
            problems.append(
                f"{item.table}.{item.column} 的 DEFAULT 与清单不一致："
                f"库={default!r} 清单={'有' if item.has_default else '无'}"
            )
    return problems


def _print_sql(pending_tables: list[str], pending_columns: list[tuple[str, str, str]]) -> None:
    """打印将要执行的 SQL（``--print-only`` 用）：看得见就不用猜脚本要动什么。"""
    for name in pending_tables:
        item = next(entry for entry in TABLES if entry.table == name)
        print(f"  SQL> {item.ddl}")
        for index_name in index_names(item):
            print(f"  SQL> {index_ddl_of(item, index_name)}")
    for table, column, ddl in pending_columns:
        print(f"  SQL> ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def migrate(*, check_only: bool, db_path: Path | None = None) -> int:
    """执行建表 + 加列；``check_only=True`` 时只报告不写库。返回进程退出码。"""
    target_db = Path(db_path) if db_path is not None else DB_PATH
    if not target_db.exists():
        print(f"✗ 找不到数据库：{target_db}", file=sys.stderr)
        return 1

    total_tables = table_count()
    total_columns = column_count()
    # --check / --print-only 走只读连接：字面意义上"不写库"
    conn = _connect(target_db, read_only=check_only)
    try:
        print(f"清单：{describe()}")
        print(f"      （{total_tables} 张新表 + {total_columns} 个新列）")
        print(f"目标库：{target_db}")

        present = existing_tables(conn)
        missing_prereq = [name for name in PREREQ_TABLES if name not in present]
        if missing_prereq:
            print(
                f"✗ 前置表缺失：{missing_prereq}（两张新表的外键与新列的宿主表都依赖它们）",
                file=sys.stderr,
            )
            return 1

        pending_tables, pending_columns = pending_changes(conn)
        for item in TABLES:
            if item.table in present:
                print(f"  = {item.table} 已存在，跳过建表")
        for item in COLUMNS:
            if item.column in existing_columns(conn, item.table):
                print(f"  = {item.table}.{item.column} 已存在，跳过加列")

        if pending_tables:
            print(f"待新建 {len(pending_tables)}/{total_tables} 张表：")
            for item in TABLES:
                if item.table in pending_tables:
                    print(f"  + {item.table}（{item.why}）")
        if pending_columns:
            print(f"待新增 {len(pending_columns)}/{total_columns} 列：")
            for table, column, _ddl in pending_columns:
                print(f"  + {table}.{column}")

        if check_only:
            _print_sql(pending_tables, pending_columns)
            print(
                f"（--check 模式，未执行；缺 {len(pending_tables)} 张表、{len(pending_columns)} 列）"
            )
            print("  只读连接：没有建表、没有加列、没有生成备份。")
            return 0

        if not pending_tables and not pending_columns:
            print(f"✓ 全部 {total_tables} 张表与 {total_columns} 列都已存在，无需迁移")
            return 0

        backup_path = backup_database(target_db)
        print(f"✓ 已备份数据库 → {backup_path.name}")

        # 显式事务：SQLite 的 DDL 也能回滚，这样"建到一半失败"不会留下半拉 schema
        # （Python 的 sqlite3 只为 DML 隐式开事务，DDL 默认是 autocommit）。
        # 失败由下面的 `except sqlite3.Error` 统一回滚，所以这里不再套一层 try。
        conn.execute("BEGIN")
        for item in TABLES:
            if item.table not in pending_tables:
                continue
            conn.execute(item.ddl)
            print(f"  ✓ CREATE TABLE {item.table}")
            for index_name in index_names(item):
                conn.execute(index_ddl_of(item, index_name))
                print(f"    ✓ CREATE INDEX {index_name}")
        for table, column, ddl in pending_columns:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
            print(f"  ✓ ALTER TABLE {table} ADD COLUMN {column}")
        conn.commit()

        problems = verify_schema(conn)
        if problems:
            for problem in problems:
                print(f"✗ 迁移校验失败：{problem}", file=sys.stderr)
        else:
            print(
                f"✓ 迁移完成并逐列/逐索引/逐约束校验通过"
                f"（{total_tables} 张表 + {total_columns} 列，与 ORM 口径一致）"
            )
        return 1 if problems else 0
    except sqlite3.Error as exc:
        # 本次事务（BEGIN 之后的部分）整体回滚；没 BEGIN 时 rollback 是无害的空操作。
        conn.rollback()
        print(f"✗ 迁移失败并已回滚本次事务（库里没有留下半拉结构）：{exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="迁移剧情广告数据契约（2 张新表 + 8 个新列）")
    parser.add_argument("--check", action="store_true", help="只检查缺哪些表/列，不修改")
    parser.add_argument(
        "--print-only",
        action="store_true",
        help="只打印将执行的 SQL 与统计，不写库（等同 --check，但会打印 SQL）",
    )
    parser.add_argument(
        "--db",
        metavar="DB_PATH",
        default=None,
        help="目标数据库路径（默认 backend/jellyfish.db；验证/演练请传副本路径）",
    )
    args = parser.parse_args()
    return migrate(
        check_only=bool(args.check or args.print_only),
        db_path=Path(args.db) if args.db else None,
    )


if __name__ == "__main__":
    raise SystemExit(main())
