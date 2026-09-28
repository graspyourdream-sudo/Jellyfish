#!/usr/bin/env python3
"""角色声音（人物资产唯一事实来源）的迁移 009 · SQLite 版（幂等、带备份、可回滚）。

它做的两件事（与 ``sql/009-add-asset-voice-inheritance.sql`` 完全同一步骤、同一结论）：

1. ``shot_details.voice_inherited_from``：镜头级声音的**继承来源**
   （``character:<角色ID>``）。迁移前的逐镜声音从此只作为**只读快照**被读取。
2. **回填历史数据**（不让用户以前的选择丢）：某角色还没有资产声音、且它在历史镜头上
   的声音**唯一**时，把这条历史声音提升为该角色的资产声音（``file_usages``，
   ``usage_kind='asset_voice'``）；该角色名下这些镜头同时标上继承来源。
   一个角色有多个不同历史声音（分叉）时**不猜**，只如实标注来源。

为什么 Python 与 SQL 两份：``sql/*.sql`` 是 MySQL 方言（部署用），本地运行时是 SQLite，
所以这里有一份**能真的被执行与回归**的实现，两者的一致性由
``tests/test_asset_voice_inheritance_migration.py`` 对拍。

回滚是**保守回滚**（与 ``rollback_asset_voice_inheritance.py`` 同一份结论）：只撤掉本迁移
新增的列，**一行资产声音都不删** —— 迁移提升行没有可核验的来源标记，与"迁移前就存在的、
资产 + 音频文件都一样的用户绑定"无法区分，用启发式删除会丢用户数据。

幂等与安全：
- 列已存在 → 跳过；提升语句带 ``NOT EXISTS``、标注语句带 ``IS NULL`` 守卫，重跑为空操作；
- ``--check`` 走**只读连接**：不加列、不写库、不生成备份、不动 ``-wal``；
- 默认先备份（SQLite backup API，WAL 下也一致）；
- 绝不连正式库：默认目标是 ``backend/jellyfish.db``，验证/演练请显式传 ``--db <副本或临时库>``。

用法：
    cd backend && uv run python scripts/migrate_asset_voice_inheritance.py
    cd backend && uv run python scripts/migrate_asset_voice_inheritance.py --check
    cd backend && uv run python scripts/migrate_asset_voice_inheritance.py --db /tmp/voice_copy.db
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent

# 直接跑脚本时 sys.path[0] 就是 scripts/；被测试用 spec 加载时不一定是，这里显式兜一层。
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

# pylint: disable=import-error,wrong-import-position  # 上面刚把 scripts/ 注入 sys.path
from _asset_voice_inheritance import (  # noqa: E402
    ADD_COLUMN_SQL,
    COLUMN,
    MARK_LEGACY_SHOT_VOICE_SOURCE_SQL,
    ROLLBACK_KEEPS_ASSET_VOICE_NOTE,  # 回滚脚本 / 文档 / 测试从同一份清单取用
    TABLE,
    asset_voice_row_count,
    column_exists,
    describe,
    missing_tables,
    pending_source_mark_count,
    promote_legacy_shot_voice_sql,
    promotion_candidates,
)

DB_PATH = BACKEND_ROOT / "jellyfish.db"


def _connect(db_path: Path, *, read_only: bool = False) -> sqlite3.Connection:
    """打开数据库；``read_only`` 时用 URI 只读模式。"""
    if read_only:
        return sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    return sqlite3.connect(str(db_path))


def backup_database(db_path: Path) -> Path:
    """用 SQLite 的 backup API 做一致性快照（WAL 下直接拷文件会丢未 checkpoint 的数据）。"""
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    target = db_path.with_name(f"{db_path.name}.backup_before_asset_voice_{stamp}")
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


def migrate(*, check_only: bool, db_path: Path | None = None) -> int:
    """执行迁移；``check_only=True`` 时只报告不写库。返回进程退出码。"""
    target_db = Path(db_path) if db_path is not None else DB_PATH
    if not target_db.exists():
        print(f"✗ 找不到数据库：{target_db}", file=sys.stderr)
        return 1

    # --check 走只读连接：字面意义上"不写库"（连 WAL 边车都不动）
    conn = _connect(target_db, read_only=check_only)
    try:
        print(f"清单：{describe()}")
        missing = missing_tables(conn)
        if missing:
            print(f"✗ 缺前置表：{missing}；请先建表再迁移", file=sys.stderr)
            return 1

        column_present = column_exists(conn, TABLE, COLUMN)
        if column_present:
            print(f"  = {TABLE}.{COLUMN} 已存在，跳过")
        else:
            print(f"  + {TABLE}.{COLUMN}（待新增）")

        if column_present:
            candidates = promotion_candidates(conn)
            pending_marks = pending_source_mark_count(conn)
        else:
            # 列不存在时标注步骤还没法预告（它的守卫条件用到了那一列）：如实说明，不编数字。
            candidates = promotion_candidates(conn)
            pending_marks = 0
        print(f"  提升候选（角色还没有资产声音 + 历史声音唯一）：{len(candidates)} 项")
        for item in candidates:
            print(f"    · 角色 {item.character_id} ← {item.file_id}")
        if column_present:
            print(f"  待标注继承来源的历史镜头：{pending_marks} 条")
        else:
            print("  待标注继承来源的历史镜头：先加列，--check 不做预估")

        if check_only:
            print("（--check 模式，未执行）")
            return 0

        # 幂等空操作：列已在、没有可提升的声音、也没有待标注的镜头 → 不备份、不写库。
        # （这条不只是省事：备份文件名精确到秒，同一秒内连跑两次会互相覆盖，
        #   若空操作也备份，第一次那份"迁移前"快照就会被第二次覆盖掉。）
        if column_present and not candidates and pending_marks == 0:
            print("✓ 已是迁移后的状态，无需改动（幂等空操作，不写库、不生成备份）")
            return 0

        backup_path = backup_database(target_db)
        print(f"✓ 已备份数据库 → {backup_path.name}")

        if not column_present:
            conn.execute(ADD_COLUMN_SQL)
            print(f"  ✓ ALTER TABLE {TABLE} ADD COLUMN {COLUMN}")

        promoted = conn.execute(promote_legacy_shot_voice_sql()).rowcount
        print(f"  ✓ 回填资产声音：{max(int(promoted or 0), 0)} 行")

        marked = conn.execute(MARK_LEGACY_SHOT_VOICE_SOURCE_SQL).rowcount
        print(f"  ✓ 标注继承来源：{max(int(marked or 0), 0)} 条历史镜头")
        conn.commit()

        # 迁移后校验：列必须真的存在（缺列即失败）
        if not column_exists(conn, TABLE, COLUMN):
            print(f"✗ 校验失败：{TABLE}.{COLUMN} 仍不存在", file=sys.stderr)
            return 1
        print(
            f"✓ 迁移完成并校验通过（{TABLE}.{COLUMN} 已存在；"
            f"库内资产声音行共 {asset_voice_row_count(conn)} 行）"
        )
        print(f"ℹ 回滚口径：{ROLLBACK_KEEPS_ASSET_VOICE_NOTE}")
        return 0
    except sqlite3.Error as exc:
        print(f"✗ 迁移失败：{exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="角色声音：资产级唯一事实来源 + 镜头级只读继承快照")
    parser.add_argument("--check", action="store_true", help="只检查，不修改")
    parser.add_argument(
        "--db",
        metavar="DB_PATH",
        default=None,
        help="目标数据库路径（默认 backend/jellyfish.db；验证/演练请传副本或临时库路径）",
    )
    args = parser.parse_args()
    return migrate(check_only=args.check, db_path=Path(args.db) if args.db else None)


if __name__ == "__main__":
    raise SystemExit(main())
