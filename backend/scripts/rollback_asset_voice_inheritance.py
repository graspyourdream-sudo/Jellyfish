#!/usr/bin/env python3
"""回滚 ``migrate_asset_voice_inheritance.py``（迁移 009）。

**与迁移共用同一份清单**（``scripts/_asset_voice_inheritance.py``）：回滚撤的就是迁移加的东西，
两边不会漂移。

语义（**保守回滚**，与 ``rollback_ad_flow.py`` 同一条口径：只撤自己加的结构）
============================================================================

1. ``DROP COLUMN shot_details.voice_inherited_from``（+ 存在性守卫，重复执行为空操作）；
2. **一行 ``file_usages`` 都不删。** 迁移提升出来的角色声音**保留**。

为什么不再删"提升出来的行"：那条判定**无法区分来源** —— 迁移提升行与
"迁移前就存在的、资产 + 音频文件都一样的用户绑定"在库里完全一样（迁移没有、
也无法给提升行留下可核验的来源标记）。旧的"同资产 + 同音频文件"配对删除会：

- 删掉迁移前就存在的**合法角色声音**（用户数据丢失）；
- 删掉用户在迁移后**重新绑定的同一个**音频文件。

两者都是丢用户数据。判定分不清来源时不许拿它驱动删除，所以这里保留数据、只回滚结构。
代价说清楚：回滚**不能**回到迁移前的数据状态，只能回到迁移前的结构状态 ——
库里可能多出一条历史来源的角色声音，用户可在第 2 步自行解绑；
错误删除则是永久丢失。重跑前滚不会重复插入（``NOT EXISTS`` 守卫），
因此「前滚 → 回滚 → 前滚」仍然得到同一份结果。

3. ``shot_details.audio_file_id`` 一个字节都不动：那是迁移前就存在的用户数据。

两种模式：
1. ``--restore <备份文件名>``（最干净）：直接用迁移时生成的备份覆盖当前库；会连同迁移
   之后产生的新数据一起回到当时的状态 —— 需要"数据也回到过去"时用它；
2. 默认：只 DROP 那一列，保留全部数据（需要 SQLite ≥ 3.35；Django/CPython 3.12
   自带的版本满足）。DROP COLUMN 不可用时脚本会提示改用模式 1；
3. ``--check``：只报告"会删掉哪一列、会保留几行资产声音"，不写库、不加备份。

用法：
    cd backend && uv run python scripts/rollback_asset_voice_inheritance.py
    cd backend && uv run python scripts/rollback_asset_voice_inheritance.py --check
    cd backend && uv run python scripts/rollback_asset_voice_inheritance.py --db /tmp/copy.db
    cd backend && uv run python scripts/rollback_asset_voice_inheritance.py --restore <备份文件名>
"""

from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent

# 直接跑脚本时 sys.path[0] 就是 scripts/；被测试用 spec 加载时不一定是，这里显式兜一层。
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

# pylint: disable=import-error,wrong-import-position  # 上面刚把 scripts/ 注入 sys.path
from _asset_voice_inheritance import (  # noqa: E402
    COLUMN,
    DROP_COLUMN_SQL,
    ROLLBACK_KEEPS_ASSET_VOICE_NOTE,
    TABLE,
    asset_voice_row_count,
    column_exists,
    describe_rollback,
    missing_tables,
)

DB_PATH = BACKEND_ROOT / "jellyfish.db"


def _connect(db_path: Path, *, read_only: bool = False) -> sqlite3.Connection:
    """打开数据库；``read_only`` 时用 URI 只读模式。"""
    if read_only:
        return sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    return sqlite3.connect(str(db_path))


def restore_from_backup(name: str, *, db_path: Path | None = None) -> int:
    """用迁移时的备份整体覆盖数据库（含清理 -wal/-shm 边车文件）。"""
    target_db = Path(db_path) if db_path is not None else DB_PATH
    backup = Path(name)
    if not backup.is_absolute():
        backup = BACKEND_ROOT / name
    if not backup.exists():
        print(f"✗ 找不到备份文件：{backup}", file=sys.stderr)
        return 1
    for suffix in ("-wal", "-shm"):
        sidecar = target_db.with_name(target_db.name + suffix)
        if sidecar.exists():
            sidecar.unlink()
    shutil.copy2(backup, target_db)
    print(f"✓ 已用 {backup.name} 覆盖 {target_db.name}")
    return 0


def rollback(*, check_only: bool = False, db_path: Path | None = None) -> int:
    """去掉本迁移新增的列（**保守回滚**：不删任何资产声音行）；``check_only`` 只报告。

    返回进程退出码。
    """
    target_db = Path(db_path) if db_path is not None else DB_PATH
    if not target_db.exists():
        print(f"✗ 找不到数据库：{target_db}", file=sys.stderr)
        return 1

    conn = _connect(target_db, read_only=check_only)
    try:
        missing = missing_tables(conn)
        if missing:
            print(f"✗ 缺前置表：{missing}；这个库不是目标库", file=sys.stderr)
            return 1

        print(f"回滚清单：{describe_rollback()}")

        # 幂等：列已经不在了（说明从没迁移过、或已经回滚过）→ 没有可回滚的东西
        if not column_exists(conn, TABLE, COLUMN):
            print(f"✓ {TABLE}.{COLUMN} 不存在：无需回滚（重复回滚是空操作）")
            return 0

        kept = asset_voice_row_count(conn)
        print(f"将删除列：{TABLE}.{COLUMN}")
        print(f"将保留的资产声音行：{kept} 行（{ROLLBACK_KEEPS_ASSET_VOICE_NOTE}）")
        if check_only:
            print("（--check 模式，未执行）")
            return 0

        try:
            conn.execute(DROP_COLUMN_SQL)
        except sqlite3.OperationalError as exc:
            print(
                f"✗ DROP COLUMN 失败（{exc}）；请改用 --restore <迁移时的备份文件名>",
                file=sys.stderr,
            )
            return 1
        print(f"  ✓ 已删除列 {TABLE}.{COLUMN}")
        conn.commit()

        if column_exists(conn, TABLE, COLUMN):
            print(f"✗ 校验失败：{TABLE}.{COLUMN} 仍存在", file=sys.stderr)
            return 1
        after = asset_voice_row_count(conn)
        if after != kept:
            print(
                f"✗ 校验失败：资产声音行数变了（{kept} → {after}）；保守回滚不许改动任何声音数据",
                file=sys.stderr,
            )
            return 1
        print(f"✓ 回滚完成并校验通过（资产声音行仍为 {after} 行，一行未删）")
        return 0
    except sqlite3.Error as exc:
        print(f"✗ 回滚失败：{exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="回滚角色声音继承迁移（009）")
    parser.add_argument("--check", action="store_true", help="只报告，不写库")
    parser.add_argument("--restore", metavar="BACKUP", default=None, help="用迁移时的备份覆盖当前库")
    parser.add_argument("--db", metavar="DB_PATH", default=None, help="目标数据库路径（默认 backend/jellyfish.db）")
    args = parser.parse_args()
    db_path = Path(args.db) if args.db else None
    if args.restore:
        return restore_from_backup(args.restore, db_path=db_path)
    return rollback(check_only=args.check, db_path=db_path)


if __name__ == "__main__":
    raise SystemExit(main())
