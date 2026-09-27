#!/usr/bin/env python3
"""回滚 ``migrate_ad_flow.py``：删掉 2 张新表 + 回滚 8 个新列。

**与迁移共用同一份清单**（``scripts/_ad_flow.py``）：回滚删的就是迁移建/加的那些表与列，
不会再出现"迁移建了 N 张、回滚只删 N-k 张"的不对称（``_llm_pipeline_columns.py:3-6``
记录过那次真实事故）。

新列怎么回滚：**用 ``ALTER TABLE ... DROP COLUMN``，不做整表重建**
================================================================

判断与理由（这是本文件唯一需要解释的设计选择）：

1. 前置事实：本项目实际运行的是 **SQLite ≥ 3.35**（``DROP COLUMN`` 从 3.35 起支持；
   本机 Python 自带 3.53）。仓库里 ``rollback_llm_pipeline_columns.py`` 走的就是同一条路，
   回滚脚本的口径应当一致，否则"同一件事两种做法"更容易出错。
2. 为什么**不**选"重建表"（12 步 ``CREATE new / INSERT SELECT / DROP / RENAME``）：
   重建需要把 ``projects`` / ``drama_plan_drafts`` / ``products`` 三张核心表整表抄一遍，
   连带它们的索引、唯一约束、外键、触发器、视图依赖、行顺序都变成"我来保证"的东西；
   而本次要删的 8 列都是**孤立的普通列**（无索引、非主键、不进任何约束），
   ``DROP COLUMN`` 是单语句、其余部分原样不动。为一个用不上的场景写一条危险路径
   （而且是在这个仓库里最容易写错的那张表上）不划算。
3. 什么时候 ``DROP COLUMN`` 会拒绝：SQLite < 3.35，或列被索引/主键/唯一约束/CHECK/
   外键/视图引用。这两种情况脚本都**如实报错**，并直接指向
   ``--restore <迁移时的备份>` —— 那条路能精确回到迁移前状态（连数据一起）。
4. 明确后果：``DROP COLUMN`` 只丢"迁移加的那一列"，**同行其余列的数据一字不动**；
   但**迁移之后写进这些新列/新表的数据会丢**（这就是回滚的语义）。
   新表在迁移前不存在，删掉它们不影响任何旧数据。

三种模式：

1. 默认：``DROP TABLE IF EXISTS``（索引随表一起删） + 逐个 ``DROP COLUMN``；
   执行前先留一份备份 ``{db.name}.backup_before_ad_flow_{YYYYmmdd_HHMMSS}``。
2. ``--check``：只报告"会删哪些表、哪些列、各有多少行/多少列"，只开**只读连接**，不写库、不备份。
3. ``--restore <备份名>``（推荐用于"要精确回到迁移前"）：用迁移时生成的备份
   反向覆盖当前库（SQLite ``backup`` API，比 ``cp`` 安全），覆盖前也会先留一份当前状态。

用法：
    cd backend && uv run python scripts/rollback_ad_flow.py
    cd backend && uv run python scripts/rollback_ad_flow.py --check
    cd backend && uv run python scripts/rollback_ad_flow.py --db /tmp/copy.db
    cd backend && uv run python scripts/rollback_ad_flow.py \\
        --restore jellyfish.db.backup_before_ad_flow_20260927_120000
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parent.parent

# 直接跑脚本时 sys.path[0] 就是 scripts/；被测试用 spec 加载时不一定是，这里显式兜一层。
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

# pylint: disable=import-error,wrong-import-position  # 上面刚把 scripts/ 注入 sys.path
from _ad_flow import (  # noqa: E402
    COLUMNS,
    TABLES,
    column_count,
    describe,
    table_count,
    table_names,
)

DB_PATH = BACKEND_ROOT / "jellyfish.db"

#: 支持 ``ALTER TABLE ... DROP COLUMN`` 的最低 SQLite 版本（3.35.0，2021-03-12 发布）。
DROP_COLUMN_MIN_VERSION = (3, 35, 0)


def _connect(db_path: Path, *, read_only: bool = False) -> sqlite3.Connection:
    """打开数据库；``read_only`` 时用 URI 只读模式。"""
    if read_only:
        return sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    return sqlite3.connect(str(db_path))


def existing_tables(conn: sqlite3.Connection) -> set[str]:
    """库里当前已有的表名集合。"""
    rows = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    return {str(row[0]) for row in rows}


def existing_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    """表当前实际存在的列名集合（表不存在时返回空集）。"""
    try:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    except sqlite3.Error:
        return set()
    return {str(row[1]) for row in rows}


def row_count(conn: sqlite3.Connection, table: str) -> int:
    """表里的行数（读不出来时返回 0，不影响回滚本身）。"""
    try:
        row = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
    except sqlite3.Error:
        return 0
    return int(row[0]) if row else 0


def sqlite_version_tuple() -> tuple[int, ...]:
    """当前 sqlite3 运行库版本（``DROP COLUMN`` 是否可用由它决定）。"""
    return tuple(int(part) for part in sqlite3.sqlite_version.split("."))


def backup_database(db_path: Path) -> Path:
    """用 SQLite 的 backup API 做一致性快照（与迁移同一个文件名前缀，便于对应）。

    时间戳只精确到秒，重名时追加 ``_2`` / ``_3``，**绝不覆盖**上一份备份
    （"迁移→回滚→再迁移"会在同一秒里连做三次备份，不能互相盖掉）。
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


def restore_from_backup(name: str, *, db_path: Path | None = None) -> int:
    """用 SQLite 的 backup API 把备份文件**反向**写回目标库（比 ``cp`` 安全）。"""
    target_db = Path(db_path) if db_path is not None else DB_PATH
    source_path = target_db.with_name(name)
    if not source_path.exists():
        print(f"✗ 找不到备份文件：{source_path}", file=sys.stderr)
        return 1
    if not target_db.exists():
        print(f"✗ 找不到目标库：{target_db}", file=sys.stderr)
        return 1
    keep = backup_database(target_db)
    print(f"✓ 覆盖前先留一份当前状态 → {keep.name}")
    source = sqlite3.connect(str(source_path))
    try:
        dest = sqlite3.connect(str(target_db))
        try:
            source.backup(dest)
        finally:
            dest.close()
    finally:
        source.close()
    print(f"✓ 已从备份还原：{source_path.name}（回到该备份时刻的状态）")
    return 0


def _plan(conn: sqlite3.Connection) -> tuple[list[str], list[tuple[str, str]]]:
    """算出要删什么：``(待删表名, [(宿主表, 列名), ...])``。"""
    present = existing_tables(conn)
    # 删表顺序 = 清单的逆序（与建表顺序对称；本次两张表之间无外键依赖，但顺序仍然明确）
    doomed_tables = [item.table for item in reversed(TABLES) if item.table in present]
    doomed_columns = [
        (item.table, item.column)
        for item in COLUMNS
        if item.column in existing_columns(conn, item.table)
    ]
    return doomed_tables, doomed_columns


def _refuse_drop_column(detail: str) -> int:
    """``DROP COLUMN`` 不可用时的**如实报错**（并给出精确回到迁移前的路）。"""
    print(f"✗ 无法用 DROP COLUMN 回滚新列：{detail}", file=sys.stderr)
    print(
        "  请改用：rollback_ad_flow.py --restore <迁移时的备份文件名>\n"
        "  （备份文件能精确回到迁移前状态，连数据一起；本脚本**不会**用整表重建来绕开，"
        "理由见文件 docstring）",
        file=sys.stderr,
    )
    return 1


def rollback(*, check_only: bool, db_path: Path | None = None) -> int:
    """执行删表 + 回滚列；``check_only=True`` 时只报告不写库。返回进程退出码。"""
    target_db = Path(db_path) if db_path is not None else DB_PATH
    if not target_db.exists():
        print(f"✗ 找不到数据库：{target_db}", file=sys.stderr)
        return 1

    total_tables = table_count()
    total_columns = column_count()
    # --check 走只读连接：字面意义上"不写库"
    conn = _connect(target_db, read_only=check_only)
    try:
        print(f"清单：{describe()}")
        print(f"      （{total_tables} 张新表 + {total_columns} 个新列）")
        print(f"目标库：{target_db}")
        doomed_tables, doomed_columns = _plan(conn)
        for name in doomed_tables:
            print(f"  - DROP TABLE {name}（{row_count(conn, name)} 行会被删）")
        for table, column in doomed_columns:
            print(f"  - DROP COLUMN {table}.{column}")
        for name in table_names():
            if name not in doomed_tables:
                print(f"  = {name} 不在库里，无需处理")

        if check_only:
            print(f"（--check 模式，未执行；将删 {len(doomed_tables)}/{total_tables} 张表、"
                  f"{len(doomed_columns)}/{total_columns} 列）")
            print("  只读连接：没有删表、没有删列、没有生成备份。")
            return 0

        if not doomed_tables and not doomed_columns:
            print(f"✓ {total_tables} 张表与 {total_columns} 列都不在库里，无需回滚")
            return 0

        if doomed_columns and sqlite_version_tuple() < DROP_COLUMN_MIN_VERSION:
            return _refuse_drop_column(
                f"当前 SQLite {sqlite3.sqlite_version} < "
                f"{'.'.join(str(part) for part in DROP_COLUMN_MIN_VERSION)}"
            )

        backup_path = backup_database(target_db)
        print(f"✓ 已备份数据库 → {backup_path.name}")

        # 显式事务：SQLite 的 DDL 也能回滚，这样"删到一半失败"不会留下半拉状态。
        # 失败由下面的 `except sqlite3.Error` 统一回滚，所以这里不再套一层 try。
        conn.execute("BEGIN")
        for name in doomed_tables:
            conn.execute(f"DROP TABLE IF EXISTS {name}")
            print(f"  ✓ DROP TABLE {name}")
        for table, column in doomed_columns:
            conn.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
            print(f"  ✓ DROP COLUMN {table}.{column}")
        conn.commit()

        left_tables = sorted(set(table_names()) & existing_tables(conn))
        left_columns = [
            f"{item.table}.{item.column}"
            for item in COLUMNS
            if item.column in existing_columns(conn, item.table)
        ]
        if left_tables or left_columns:
            print(f"✗ 回滚后仍有残留：表={left_tables} 列={left_columns}", file=sys.stderr)
        else:
            print(
                f"✓ 回滚完成：{len(doomed_tables)} 张表已删除、{len(doomed_columns)} 个新列已删除，"
                f"清单位置已回到迁移前（其余列的数据未受影响）"
            )
        return 1 if (left_tables or left_columns) else 0
    except sqlite3.Error as exc:
        # 本次事务整体回滚；没 BEGIN 时 rollback 是无害的空操作。
        conn.rollback()
        print(f"✗ 回滚失败并已回滚本次事务（库里没有留下半拉状态）：{exc}", file=sys.stderr)
        print(
            "  若失败的是 DROP COLUMN（该列被索引/主键/约束/视图引用，或 SQLite < 3.35），"
            "请改用：rollback_ad_flow.py --restore <迁移时的备份文件名>"
            "（备份能精确回到迁移前状态；本脚本**不会**用整表重建来绕开，理由见文件 docstring）",
            file=sys.stderr,
        )
        return 1
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="回滚剧情广告数据契约（2 张新表 + 8 个新列）")
    parser.add_argument("--check", action="store_true", help="只报告会删哪些表/列，不修改")
    parser.add_argument("--print-only", action="store_true", help="等同 --check")
    parser.add_argument(
        "--restore",
        metavar="BACKUP_NAME",
        default=None,
        help="用指定备份文件覆盖当前库（迁移时的备份名，例如 jellyfish.db.backup_before_ad_flow_...）",
    )
    parser.add_argument(
        "--db",
        metavar="DB_PATH",
        default=None,
        help="目标数据库路径（默认 backend/jellyfish.db；验证/演练请传副本路径）",
    )
    args: Any = parser.parse_args()
    db_path = Path(args.db) if args.db else None
    if args.restore:
        return restore_from_backup(args.restore, db_path=db_path)
    return rollback(check_only=bool(args.check or args.print_only), db_path=db_path)


if __name__ == "__main__":
    raise SystemExit(main())
