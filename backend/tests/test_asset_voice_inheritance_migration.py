"""角色声音继承迁移（009）的**前滚 / 幂等 / 回滚 / 往返**回归测试。

背景（设计包 §10「角色声音规则」）
================================

声音的唯一事实来源是**人物资产**，不是单个镜头。迁移前的声音只存在于镜头级
（``shot_details.audio_file_id``），所以 009 补两件事：

1. ``shot_details.voice_inherited_from``：镜头声音的继承来源（只读快照）；
2. 回填：角色还没有资产声音、且它在历史镜头上的声音唯一时，把这条历史声音提升为
   该角色的资产声音；分叉（多个不同历史声音）**不猜**，只标注来源。

本文件锁住七件事
================

1. **前滚**：列真的加上了；唯一的历史声音被提升成 ``file_usages`` 的
   ``usage_kind='asset_voice'`` 行；已有资产声音的角色**不被覆盖**；
2. **不猜**：历史声音分叉的角色不提升；标记无需声音（``audio_opt_out``）的镜头不算历史声音；
   挂了多个角色的镜头来源不唯一 → 留空；
3. **不丢旧数据**：``shot_details.audio_file_id`` 与 ``shot_character_links`` 逐行不变；
4. **幂等**：连跑两次，资产声音行数 / 已标注行数 / 列数都不变，不报错；
5. **``--check`` 只读**：文件 mtime 不变、不生成备份、不加列；
6. **保守回滚**：只删掉新增列；**一行资产声音都不删** —— 迁移提升行与"迁移前就存在的、
   内容相同的用户绑定"在库里无法区分，用启发式删除会丢用户数据（这是刻意的取舍，
   代价是回滚只回到迁移前的**结构**、不回到迁移前的**数据**）。
   重复回滚是空操作；回滚后能再前滚（往返可重复、不叠加）；
7. **两份实现一致**：``sql/009-*.sql``（MySQL，部署用）与 Python 版（SQLite，本地）
   列名 / 回填步骤 / 回滚对称性对拍；回滚脚本不在 ``sql/`` 顶层（否则会被
   deploy/compose 的初始化容器自动执行），且回滚 SQL 里**没有任何 DELETE**。

**绝不连正式库**：所有库都在 ``tmp_path`` 下现造，不使用 ``DATABASE_URL``、
不连 ``backend/jellyfish.db``、不用 ``with TestClient(app)``。
"""

from __future__ import annotations

import importlib.util
import sqlite3
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = BACKEND_ROOT / "scripts"
SQL_DIR = BACKEND_ROOT / "sql"

# scripts/ 入 sys.path：脚本本身也这么做（`from _asset_voice_inheritance import ...`），
# 这样测试里拿到的共享清单与两个脚本加载到的是**同一个模块对象**。
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))


def _load_script(name: str):
    """按文件路径加载 scripts/ 下的脚本（不污染 sys.modules 包结构）。"""
    if str(SCRIPTS_DIR) not in sys.path:
        sys.path.insert(0, str(SCRIPTS_DIR))
    spec = importlib.util.spec_from_file_location(f"_jf_script_{name}", SCRIPTS_DIR / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# 临时库：迁移前的结构 + 覆盖全部分支的数据
# ---------------------------------------------------------------------------

#: 迁移前的最小结构（只含本迁移依赖的表与列，**故意不含**新增列）。
_PRE_MIGRATION_DDL: tuple[str, ...] = (
    "CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_id TEXT NOT NULL)",
    "CREATE TABLE shot_details (id TEXT PRIMARY KEY, audio_file_id TEXT, audio_opt_out INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE shot_character_links (id INTEGER PRIMARY KEY AUTOINCREMENT, shot_id TEXT NOT NULL, character_id TEXT NOT NULL)",
    (
        "CREATE TABLE file_usages ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "file_id TEXT NOT NULL, "
        "project_id TEXT NOT NULL, "
        "chapter_id TEXT, "
        "shot_id TEXT, "
        "usage_kind TEXT NOT NULL, "
        "source_ref TEXT NOT NULL DEFAULT '')"
    ),
)

#: 数据布局（每个注释对应一条断言分支）：
#:   char-1 苏晚棠：shot-1 / shot-2 都用 a1 → 唯一 → 提升
#:   char-2 叶老夫人：shot-3 用 a2、shot-4 用 a3 → 分叉 → 不提升（只标注来源）
#:   char-3 已有资产声音 a9：shot-5 用 a4 → 不覆盖
#:   char-4：shot-6 用 a5 但标记了「无需声音」 → 不算历史声音
#:   shot-7 有声音 a6 但没有角色 → 来源不唯一（没有）→ 不标注
#:   shot-8 有声音 a7、挂了两个角色 → 来源不唯一 → 不标注
#:   shot-9 有角色、没有声音 → 什么都不做
#:   char-7 王妈：**迁移前就有**资产声音 a10，且与 shot-10 的历史声音 a10 **是同一个文件**
#:              → 不许重复插入，回滚也绝不许删掉它（旧启发式会误删）
#:   char-8 李婶：**迁移前就有**资产声音 a12，shot-11 的历史声音是 a11（**不同**）
#:              → 不许被覆盖成 a11，回滚也绝不许动它
_SEED_SQL: tuple[str, ...] = (
    "INSERT INTO characters (id, name, project_id) VALUES ('char-1', '苏晚棠', 'proj-1')",
    "INSERT INTO characters (id, name, project_id) VALUES ('char-2', '叶老夫人', 'proj-1')",
    "INSERT INTO characters (id, name, project_id) VALUES ('char-3', '阿福', 'proj-1')",
    "INSERT INTO characters (id, name, project_id) VALUES ('char-4', '路人甲', 'proj-1')",
    "INSERT INTO characters (id, name, project_id) VALUES ('char-5', '双人甲', 'proj-1')",
    "INSERT INTO characters (id, name, project_id) VALUES ('char-6', '双人乙', 'proj-1')",
    "INSERT INTO characters (id, name, project_id) VALUES ('char-7', '王妈', 'proj-1')",
    "INSERT INTO characters (id, name, project_id) VALUES ('char-8', '李婶', 'proj-1')",
    "INSERT INTO shot_details (id, audio_file_id, audio_opt_out) VALUES ('shot-1', 'a1', 0)",
    "INSERT INTO shot_details (id, audio_file_id, audio_opt_out) VALUES ('shot-2', 'a1', 0)",
    "INSERT INTO shot_details (id, audio_file_id, audio_opt_out) VALUES ('shot-3', 'a2', 0)",
    "INSERT INTO shot_details (id, audio_file_id, audio_opt_out) VALUES ('shot-4', 'a3', 0)",
    "INSERT INTO shot_details (id, audio_file_id, audio_opt_out) VALUES ('shot-5', 'a4', 0)",
    "INSERT INTO shot_details (id, audio_file_id, audio_opt_out) VALUES ('shot-6', 'a5', 1)",
    "INSERT INTO shot_details (id, audio_file_id, audio_opt_out) VALUES ('shot-7', 'a6', 0)",
    "INSERT INTO shot_details (id, audio_file_id, audio_opt_out) VALUES ('shot-8', 'a7', 0)",
    "INSERT INTO shot_details (id, audio_file_id, audio_opt_out) VALUES ('shot-9', NULL, 0)",
    "INSERT INTO shot_details (id, audio_file_id, audio_opt_out) VALUES ('shot-10', 'a10', 0)",
    "INSERT INTO shot_details (id, audio_file_id, audio_opt_out) VALUES ('shot-11', 'a11', 0)",
    "INSERT INTO shot_character_links (shot_id, character_id) VALUES ('shot-1', 'char-1')",
    "INSERT INTO shot_character_links (shot_id, character_id) VALUES ('shot-2', 'char-1')",
    "INSERT INTO shot_character_links (shot_id, character_id) VALUES ('shot-3', 'char-2')",
    "INSERT INTO shot_character_links (shot_id, character_id) VALUES ('shot-4', 'char-2')",
    "INSERT INTO shot_character_links (shot_id, character_id) VALUES ('shot-5', 'char-3')",
    "INSERT INTO shot_character_links (shot_id, character_id) VALUES ('shot-6', 'char-4')",
    "INSERT INTO shot_character_links (shot_id, character_id) VALUES ('shot-8', 'char-5')",
    "INSERT INTO shot_character_links (shot_id, character_id) VALUES ('shot-8', 'char-6')",
    "INSERT INTO shot_character_links (shot_id, character_id) VALUES ('shot-9', 'char-1')",
    "INSERT INTO shot_character_links (shot_id, character_id) VALUES ('shot-10', 'char-7')",
    "INSERT INTO shot_character_links (shot_id, character_id) VALUES ('shot-11', 'char-8')",
    # char-3 迁移前就有的资产声音（回滚必须保留它）
    (
        "INSERT INTO file_usages (file_id, project_id, chapter_id, shot_id, usage_kind, source_ref) "
        "VALUES ('a9', 'proj-1', NULL, NULL, 'asset_voice', 'character:char-3')"
    ),
    # char-7 迁移前就有资产声音，且与 shot-10 的历史声音**是同一个文件**
    (
        "INSERT INTO file_usages (file_id, project_id, chapter_id, shot_id, usage_kind, source_ref) "
        "VALUES ('a10', 'proj-1', NULL, NULL, 'asset_voice', 'character:char-7')"
    ),
    # char-8 迁移前就有资产声音，与 shot-11 的历史声音**不同**
    (
        "INSERT INTO file_usages (file_id, project_id, chapter_id, shot_id, usage_kind, source_ref) "
        "VALUES ('a12', 'proj-1', NULL, NULL, 'asset_voice', 'character:char-8')"
    ),
)

#: 前滚**之后**应有的资产声音行（含迁移提升的 char-1 与三条迁移前就存在的行）。
_EXPECTED_VOICES_AFTER_FORWARD: list[tuple] = [
    ("character:char-1", "a1", "proj-1"),
    ("character:char-3", "a9", "proj-1"),
    ("character:char-7", "a10", "proj-1"),
    ("character:char-8", "a12", "proj-1"),
]

#: 前滚**之后**应有的继承来源标注（镜头 id 是 TEXT 列，按字典序排：
#: ``shot-1`` < ``shot-10`` < ``shot-11`` < ``shot-2`` …）。
_EXPECTED_SOURCES_AFTER_FORWARD: list[tuple] = [
    ("shot-1", "character:char-1"),
    ("shot-10", "character:char-7"),
    ("shot-11", "character:char-8"),
    ("shot-2", "character:char-1"),
    ("shot-3", "character:char-2"),
    ("shot-4", "character:char-2"),
    ("shot-5", "character:char-3"),
]


def _make_pre_migration_db(path: Path) -> None:
    """造一个「迁移前」的临时库（结构旧、数据全）。"""
    conn = sqlite3.connect(str(path))
    try:
        for ddl in _PRE_MIGRATION_DDL:
            conn.execute(ddl)
        for sql in _SEED_SQL:
            conn.execute(sql)
        conn.commit()
    finally:
        conn.close()


def _columns(path: Path, table: str) -> list[str]:
    conn = sqlite3.connect(str(path))
    try:
        return [str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})")]
    finally:
        conn.close()


def _query(path: Path, sql: str) -> list[tuple]:
    conn = sqlite3.connect(str(path))
    try:
        return [tuple(row) for row in conn.execute(sql).fetchall()]
    finally:
        conn.close()


def _asset_voice_rows(path: Path) -> list[tuple]:
    """库里的资产声音行（按 source_ref / file_id 排序，便于逐行比较）。"""
    return _query(
        path,
        "SELECT source_ref, file_id, project_id FROM file_usages "
        "WHERE usage_kind = 'asset_voice' ORDER BY source_ref, file_id",
    )


def _voice_sources(path: Path) -> list[tuple]:
    """镜头的继承来源（只取有值的行，逐行比较）。"""
    return _query(
        path,
        "SELECT id, voice_inherited_from FROM shot_details "
        "WHERE voice_inherited_from IS NOT NULL ORDER BY id",
    )


def _legacy_audio_rows(path: Path) -> list[tuple]:
    """镜头级旧数据（audio_file_id / audio_opt_out）——回滚与迁移都不许改它。"""
    return _query(path, "SELECT id, audio_file_id, audio_opt_out FROM shot_details ORDER BY id")


def _all_file_usage_rows(path: Path) -> list[tuple]:
    """``file_usages`` 全表（任何 kind）——用来钉"回滚一行都不删"。"""
    return _query(
        path,
        "SELECT file_id, project_id, chapter_id, shot_id, usage_kind, source_ref "
        "FROM file_usages ORDER BY source_ref, file_id",
    )


def _link_rows(path: Path) -> list[tuple]:
    """镜头-角色关联逐行（迁移与回滚都不许动）。"""
    return _query(path, "SELECT shot_id, character_id FROM shot_character_links ORDER BY shot_id, character_id")


#: 前滚**唯一**允许新增的 ``file_usages`` 行：char-1 的历史声音 a1 被提升为角色资产声音。
#: 其余行（含迁移前就存在的资产声音）都必须原样不动 —— 逐行对比时用它当白名单，
#: 避免"顺带多插一行"被漏过。
_EXPECTED_PROMOTION_ADDED_ROW: tuple = (
    "a1",
    "proj-1",
    None,
    None,
    "asset_voice",
    "character:char-1",
)


def _added_usage_rows(before: list[tuple], after: list[tuple]) -> list[tuple]:
    """前滚/回滚前后 ``file_usages`` 的**新增行**（排序便于断言）。"""
    return sorted(set(after) - set(before))


def _voice_rows_of(path: Path, source_ref: str) -> list[tuple]:
    """某个资产当前的资产声音行（用来钉"用户既有 / 重新绑定的声音还在、且就是它"）。"""
    return _query(
        path,
        "SELECT file_id, project_id, chapter_id, shot_id, usage_kind, source_ref "
        f"FROM file_usages WHERE usage_kind = 'asset_voice' AND source_ref = '{source_ref}' "
        "ORDER BY file_id",
    )


def _backups(path: Path) -> list[Path]:
    return sorted(path.parent.glob(f"{path.name}.backup_before_asset_voice_*"))


def _executable_sql(sql: str) -> str:
    """只留可执行语句（去掉 ``--`` 注释行）：断言"语句顺序"时不能被文件头的说明文字带偏。"""
    return "\n".join(line for line in sql.splitlines() if not line.strip().startswith("--"))


# ---------------------------------------------------------------------------
# 1) 前滚：列 + 回填（提升与标注），且不覆盖已有资产声音
# ---------------------------------------------------------------------------


def test_forward_adds_column_and_backfills_legacy_voice(tmp_path: Path) -> None:
    """前滚：列补上；唯一的历史声音提升为角色资产声音；已有资产声音不被覆盖、也不重复插入。"""
    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _asset_voice_inheritance as shared

    migrate = _load_script("migrate_asset_voice_inheritance")

    db = tmp_path / "forward.db"
    _make_pre_migration_db(db)
    assert shared.COLUMN not in _columns(db, shared.TABLE)
    legacy_before = _legacy_audio_rows(db)
    links_before = _link_rows(db)

    assert migrate.migrate(check_only=False, db_path=db) == 0

    # ① 列真的加上了
    assert shared.COLUMN in _columns(db, shared.TABLE)

    # ② 提升：char-1 的 a1 成为它的资产声音；char-2 分叉不提升；
    #    char-3 / char-7 / char-8 迁移前就有的行原样保留（char-7 与历史声音同文件也不重复插入）
    assert _asset_voice_rows(db) == _EXPECTED_VOICES_AFTER_FORWARD

    # ③ 标注继承来源：来源唯一的镜头都标上；不唯一 / 无角色 / 标记无需声音的留空
    assert _voice_sources(db) == _EXPECTED_SOURCES_AFTER_FORWARD

    # ④ 镜头级旧数据与关联一个字节都没动
    assert _legacy_audio_rows(db) == legacy_before
    assert _link_rows(db) == links_before
    # ⑤ 迁移会先备份
    assert len(_backups(db)) == 1


def test_forward_is_idempotent_and_check_is_read_only(tmp_path: Path) -> None:
    """幂等：第二次前滚为空操作；``--check`` 不写库、不加备份、不加列。"""
    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _asset_voice_inheritance as shared

    migrate = _load_script("migrate_asset_voice_inheritance")

    db = tmp_path / "idempotent.db"
    _make_pre_migration_db(db)

    # --check：只读。文件 mtime 不变、没有备份、列还没加
    stamp_before = db.stat().st_mtime_ns
    assert migrate.migrate(check_only=True, db_path=db) == 0
    assert db.stat().st_mtime_ns == stamp_before, "--check 不许动数据库文件"
    assert _backups(db) == [], "--check 不许生成备份"
    assert shared.COLUMN not in _columns(db, shared.TABLE)

    # 第一次前滚
    assert migrate.migrate(check_only=False, db_path=db) == 0
    voices = _asset_voice_rows(db)
    sources = _voice_sources(db)
    backups = _backups(db)

    # 第二次前滚：已是迁移后状态 → 空操作（不写行、不改标注、不重复备份）
    assert migrate.migrate(check_only=False, db_path=db) == 0
    assert _asset_voice_rows(db) == voices, "重复前滚不许再插资产声音行"
    assert _voice_sources(db) == sources, "重复前滚不许改已标注的继承来源"
    assert _columns(db, shared.TABLE).count(shared.COLUMN) == 1, "列只能有一份"
    assert _backups(db) == backups, "空操作不许再生成备份（否则同一秒内会覆盖掉迁移前的快照）"


# ---------------------------------------------------------------------------
# 2) 回滚：**保守回滚** —— 只删列，一行数据都不删；幂等；往返可重复
# ---------------------------------------------------------------------------


def test_rollback_drops_only_the_column_and_keeps_every_voice_row(tmp_path: Path) -> None:
    """回滚：只删掉新增列；**一行资产声音都不删**（含迁移提升出来的那行）。

    这是刻意的取舍：迁移提升行与"迁移前就存在的、内容相同的用户绑定"在库里无法区分，
    用启发式删除会丢用户数据；代价是回滚只回到迁移前的**结构**。
    """
    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _asset_voice_inheritance as shared

    migrate = _load_script("migrate_asset_voice_inheritance")
    rollback = _load_script("rollback_asset_voice_inheritance")

    db = tmp_path / "rollback.db"
    _make_pre_migration_db(db)
    before_columns = _columns(db, shared.TABLE)
    legacy_before = _legacy_audio_rows(db)
    links_before = _link_rows(db)

    assert migrate.migrate(check_only=False, db_path=db) == 0
    assert shared.COLUMN in _columns(db, shared.TABLE)
    usages_after_forward = _all_file_usage_rows(db)

    # 回滚 --check：不写库
    assert rollback.rollback(check_only=True, db_path=db) == 0
    assert shared.COLUMN in _columns(db, shared.TABLE)
    assert _all_file_usage_rows(db) == usages_after_forward

    assert rollback.rollback(db_path=db) == 0
    # ① 列没了，列定义回到迁移前
    assert _columns(db, shared.TABLE) == before_columns
    # ② 资产声音行**一行都没少**（含迁移提升的 char-1 / a1）
    assert _asset_voice_rows(db) == _EXPECTED_VOICES_AFTER_FORWARD
    # ③ file_usages 全表逐行不变（任何 kind 都不许被回滚删掉）
    assert _all_file_usage_rows(db) == usages_after_forward
    # ④ 镜头级旧数据与关联没动
    assert _legacy_audio_rows(db) == legacy_before
    assert _link_rows(db) == links_before
    # ⑤ 重复回滚是空操作（幂等）
    assert rollback.rollback(db_path=db) == 0
    assert _all_file_usage_rows(db) == usages_after_forward


def test_preexisting_voice_with_the_same_file_as_the_history_survives(tmp_path: Path) -> None:
    """场景 1：角色**迁移前就有**资产声音，且与历史逐镜声音**是同一个文件**。

    前滚不许重复插入（同一条行）；回滚更不许把它删掉 —— 旧启发式（source_ref 与
    voice_inherited_from 配对 + file_id 相同）正是在这种数据上误删用户声音。
    """
    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _asset_voice_inheritance as shared

    migrate = _load_script("migrate_asset_voice_inheritance")
    rollback = _load_script("rollback_asset_voice_inheritance")

    db = tmp_path / "same_file.db"
    _make_pre_migration_db(db)
    before = _all_file_usage_rows(db)
    assert ("a10", "proj-1", None, None, "asset_voice", "character:char-7") in before, "前置：char-7 迁移前已有 a10"
    # 前置：shot-10 的历史声音就是 a10（同一个文件）
    assert _query(db, "SELECT audio_file_id FROM shot_details WHERE id = 'shot-10'") == [("a10",)]

    assert migrate.migrate(check_only=False, db_path=db) == 0
    after_forward = _all_file_usage_rows(db)
    assert _added_usage_rows(before, after_forward) == [_EXPECTED_PROMOTION_ADDED_ROW], (
        "同文件既有声音不许被重复插入（只允许提升 char-1 那一行）"
    )
    assert _voice_rows_of(db, "character:char-7") == [
        ("a10", "proj-1", None, None, "asset_voice", "character:char-7")
    ]
    assert shared.COLUMN in _columns(db, shared.TABLE)

    assert rollback.rollback(db_path=db) == 0
    assert _all_file_usage_rows(db) == after_forward, "回滚绝不许删掉迁移前就存在的同文件角色声音"
    assert _voice_rows_of(db, "character:char-7") == [
        ("a10", "proj-1", None, None, "asset_voice", "character:char-7")
    ]


def test_preexisting_voice_with_a_different_file_is_not_overwritten_or_deleted(tmp_path: Path) -> None:
    """场景 2：角色**迁移前就有**资产声音，且与历史逐镜声音**不同**（a12 vs a11）。

    前滚不许把用户既有的声音改成历史镜头的声音；回滚也不许动它。
    """
    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _asset_voice_inheritance as shared

    migrate = _load_script("migrate_asset_voice_inheritance")
    rollback = _load_script("rollback_asset_voice_inheritance")

    db = tmp_path / "diff_file.db"
    _make_pre_migration_db(db)
    before = _all_file_usage_rows(db)
    assert _query(db, "SELECT audio_file_id FROM shot_details WHERE id = 'shot-11'") == [("a11",)]

    assert migrate.migrate(check_only=False, db_path=db) == 0
    after_forward = _all_file_usage_rows(db)
    assert _added_usage_rows(before, after_forward) == [_EXPECTED_PROMOTION_ADDED_ROW], (
        "用户既有的角色声音不许被历史逐镜声音覆盖，也不许多插一行"
    )
    assert _voice_rows_of(db, "character:char-8") == [
        ("a12", "proj-1", None, None, "asset_voice", "character:char-8")
    ], "char-8 迁移前绑的是 a12，不许被改成历史镜头里的 a11"
    assert shared.COLUMN in _columns(db, shared.TABLE)

    assert rollback.rollback(db_path=db) == 0
    assert _all_file_usage_rows(db) == after_forward, "回滚也不许动用户既有的角色声音"
    assert _voice_rows_of(db, "character:char-8") == [
        ("a12", "proj-1", None, None, "asset_voice", "character:char-8")
    ]


def test_user_rebound_voice_after_migration_survives_rollback(tmp_path: Path) -> None:
    """场景 4：迁移**之后**用户在第 2 步换了音色 → 回滚必须保留新音色。

    两类都要测：(a) 换成**另一个**文件；(b) 换回**与迁移提升的同一个**文件
    （后者是旧启发式一定会误删的那种）。
    """
    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _asset_voice_inheritance as shared

    migrate = _load_script("migrate_asset_voice_inheritance")
    rollback = _load_script("rollback_asset_voice_inheritance")

    for label, rebound_file in (("different_file", "a13"), ("same_file", "a1")):
        db = tmp_path / f"rebound_{label}.db"
        _make_pre_migration_db(db)
        assert migrate.migrate(check_only=False, db_path=db) == 0
        assert shared.COLUMN in _columns(db, shared.TABLE)

        # 模拟第 2 步的重新绑定（asset_voices.bind_asset_voice：先删该资产旧行 → 再插新行）
        conn = sqlite3.connect(str(db))
        try:
            conn.execute(
                "DELETE FROM file_usages WHERE usage_kind = 'asset_voice' AND source_ref = 'character:char-1'"
            )
            conn.execute(
                "INSERT INTO file_usages (file_id, project_id, chapter_id, shot_id, usage_kind, source_ref) "
                f"VALUES ('{rebound_file}', 'proj-1', NULL, NULL, 'asset_voice', 'character:char-1')"
            )
            conn.commit()
        finally:
            conn.close()
        after_rebind = _all_file_usage_rows(db)
        assert _voice_rows_of(db, "character:char-1") == [
            (rebound_file, "proj-1", None, None, "asset_voice", "character:char-1")
        ], f"前置：第 2 步重新绑定后只剩新音色（{label}）"

        assert rollback.rollback(db_path=db) == 0
        assert _all_file_usage_rows(db) == after_rebind, f"回滚删掉了用户重新绑定的声音（{label}）"
        assert _voice_rows_of(db, "character:char-1") == [
            (rebound_file, "proj-1", None, None, "asset_voice", "character:char-1")
        ], f"回滚后用户重新绑定的音色必须还在（{label}）"


def test_two_forwards_two_rollbacks_and_round_trip_lose_nothing(tmp_path: Path) -> None:
    """场景 5：两次前滚、两次回滚、以及「前滚 → 回滚 → 前滚」全程零数据丢失、零叠加。"""
    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _asset_voice_inheritance as shared

    migrate = _load_script("migrate_asset_voice_inheritance")
    rollback = _load_script("rollback_asset_voice_inheritance")

    db = tmp_path / "double_round_trip.db"
    _make_pre_migration_db(db)
    legacy_before = _legacy_audio_rows(db)
    links_before = _link_rows(db)

    # 前滚 ①
    assert migrate.migrate(check_only=False, db_path=db) == 0
    usages_after_first = _all_file_usage_rows(db)
    sources_after_first = _voice_sources(db)
    assert _asset_voice_rows(db) == _EXPECTED_VOICES_AFTER_FORWARD

    # 前滚 ②（第二次前滚必须是空操作：不插行、不改标注、不重复备份）
    backups_after_first = _backups(db)
    assert migrate.migrate(check_only=False, db_path=db) == 0
    assert _all_file_usage_rows(db) == usages_after_first, "第二次前滚不许再插资产声音行"
    assert _voice_sources(db) == sources_after_first
    assert _backups(db) == backups_after_first, "空操作不许再生成备份"

    # 回滚 ①
    assert rollback.rollback(db_path=db) == 0
    assert shared.COLUMN not in _columns(db, shared.TABLE)
    assert _all_file_usage_rows(db) == usages_after_first, "回滚一行都不许删"

    # 回滚 ②（空操作）
    assert rollback.rollback(db_path=db) == 0
    assert _all_file_usage_rows(db) == usages_after_first

    # 前滚 ③：回到同一份结果（提升行还在 → NOT EXISTS 守卫使其不重复；标注重新算一遍）
    assert migrate.migrate(check_only=False, db_path=db) == 0
    assert _all_file_usage_rows(db) == usages_after_first, "第二次前滚必须得到同一份资产声音（不叠加）"
    assert _voice_sources(db) == sources_after_first, "第二次前滚必须得到同一份继承来源"
    assert shared.COLUMN in _columns(db, shared.TABLE)
    assert _legacy_audio_rows(db) == legacy_before, "镜头级旧数据全程不变"
    assert _link_rows(db) == links_before


def test_forward_rollback_forward_round_trip(tmp_path: Path) -> None:
    """往返：前滚 → 回滚 → 再前滚，两次前滚得到**同一份**结果（可重复、不叠加）。"""
    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _asset_voice_inheritance as shared

    migrate = _load_script("migrate_asset_voice_inheritance")
    rollback = _load_script("rollback_asset_voice_inheritance")

    db = tmp_path / "round_trip.db"
    _make_pre_migration_db(db)
    legacy_before = _legacy_audio_rows(db)

    assert migrate.migrate(check_only=False, db_path=db) == 0
    first_voices = _asset_voice_rows(db)
    first_sources = _voice_sources(db)
    first_usages = _all_file_usage_rows(db)

    assert rollback.rollback(db_path=db) == 0
    assert shared.COLUMN not in _columns(db, shared.TABLE)
    assert _all_file_usage_rows(db) == first_usages, "回滚不许删任何 file_usages 行"

    assert migrate.migrate(check_only=False, db_path=db) == 0
    assert _asset_voice_rows(db) == first_voices, "第二次前滚必须得到同一份资产声音"
    assert _voice_sources(db) == first_sources, "第二次前滚必须得到同一份继承来源"
    assert _all_file_usage_rows(db) == first_usages
    assert _legacy_audio_rows(db) == legacy_before


def test_scripts_share_one_manifest(tmp_path: Path) -> None:
    """共享清单：两个脚本与测试拿到的是**同一个模块对象**（防"两边各写一份"）。"""
    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _asset_voice_inheritance as shared

    migrate = _load_script("migrate_asset_voice_inheritance")
    rollback = _load_script("rollback_asset_voice_inheritance")

    assert migrate.TABLE == shared.TABLE and migrate.COLUMN == shared.COLUMN
    assert rollback.TABLE == shared.TABLE and rollback.COLUMN == shared.COLUMN
    assert migrate.ADD_COLUMN_SQL == shared.ADD_COLUMN_SQL
    assert rollback.DROP_COLUMN_SQL == shared.DROP_COLUMN_SQL


# ---------------------------------------------------------------------------
# 3) 与 ORM 模型 / 接口写入口的一致性
# ---------------------------------------------------------------------------


def test_new_column_matches_orm_and_has_no_api_write_entry() -> None:
    """新列必须在 ORM 里存在，且**不在** PATCH 的更新契约里（第 4 步不许回写）。"""
    import importlib

    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _asset_voice_inheritance as shared

    from app.core.db import Base
    from app.schemas.studio.shots import ShotDetailUpdate

    importlib.import_module("app.models.studio")  # 导入即把全部表注册进 Base.metadata

    table = Base.metadata.tables.get(shared.TABLE)
    assert table is not None, f"ORM 里没有 {shared.TABLE} 表"
    column = table.columns.get(shared.COLUMN)
    assert column is not None, f"ORM 里没有 {shared.TABLE}.{shared.COLUMN}（模型与迁移漂移了）"
    assert column.nullable is True, "继承来源列必须可空（没有历史声音的镜头就是 NULL）"

    # 写入口的唯一证明：更新契约里没有这一列 → PATCH /studio/shot-details/{id} 写不进去
    assert shared.COLUMN not in ShotDetailUpdate.model_fields, (
        "继承来源列出现在 ShotDetailUpdate 里 —— 那等于给第 4 步开了回写口子"
    )


# ---------------------------------------------------------------------------
# 4) 两份实现（MySQL 部署脚本 / SQLite 本地脚本）对拍
# ---------------------------------------------------------------------------


def test_mysql_forward_script_matches_the_python_manifest() -> None:
    """``sql/009-*.sql``（MySQL）与 Python 清单必须描述同一件事，且真的幂等。"""
    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _asset_voice_inheritance as shared

    forward = SQL_DIR / "009-add-asset-voice-inheritance.sql"
    assert forward.exists(), f"缺少部署用前滚脚本：{forward}"
    sql = forward.read_text(encoding="utf-8")
    body = _executable_sql(sql)

    # ① 列名一致，且**每次** DDL 都被 information_schema 存在性守卫包住（幂等的实现方式）
    assert shared.COLUMN in sql
    assert f"ADD COLUMN {shared.COLUMN}" in body, "前滚必须真的加这一列（注释里提一句不算）"
    assert "information_schema.COLUMNS" in sql
    assert "PREPARE" in sql and "EXECUTE" in sql and "DEALLOCATE PREPARE" in sql

    # ② 回填的判定条件必须与 Python 版同款：只提升"还没有资产声音 + 可归属的历史声音唯一"的角色
    assert shared.ASSET_VOICE_KIND in body
    assert "NOT EXISTS" in body, "缺少『该角色还没有资产声音』的守卫"
    assert "COUNT(DISTINCT" in body, "缺少『历史声音唯一（分叉就不猜）』的守卫"
    assert "shot_character_links" in body, "回填必须按镜头-角色关联来判定归属"
    assert "voice_inherited_from IS NULL" in body, "缺少『只标注未标注过的镜头』的守卫"
    assert "COUNT(*) FROM shot_character_links lx" in body, "缺少『双人镜头不猜归属』的守卫"

    # ③ 范围：只碰角色声音，不碰配乐 / 环境音 / 音效（那些不在人物资产上）
    for out_of_scope in ("bgm", "has_bgm", "audio_track", "sound_effect"):
        assert out_of_scope not in body, f"越界：{out_of_scope} 不该出现在本次迁移里"


def test_mysql_rollback_script_is_conservative_and_not_auto_run() -> None:
    """回滚脚本必须与保守回滚口径一致：只删列、**不删数据**，且不在 ``sql/`` 顶层。"""
    rollback_file = SQL_DIR / "rollback" / "009-add-asset-voice-inheritance.sql"
    assert rollback_file.exists(), f"缺少部署用回滚脚本：{rollback_file}"
    sql = rollback_file.read_text(encoding="utf-8")
    body = _executable_sql(sql)

    # ① 唯一动作是 DROP 新增列，并且带存在性守卫（幂等）
    assert "DROP COLUMN voice_inherited_from" in body, "回滚必须删掉新增列"
    assert "information_schema.COLUMNS" in body, "DROP COLUMN 必须带存在性守卫（幂等）"
    assert "PREPARE" in body and "EXECUTE" in body and "DEALLOCATE PREPARE" in body

    # ② **不许有任何删除数据的语句**：迁移提升行与迁移前的同内容用户绑定无法区分，
    #    用启发式删除会丢用户数据（保守回滚 = 保留数据、只撤结构）。
    assert "DELETE" not in body, "保守回滚不许出现 DELETE（会删掉无法区分来源的用户声音）"
    assert "DROP TABLE" not in sql, "回滚不许删任何表"
    assert "TRUNCATE" not in body
    # file_usages 只能出现在说明里，不许被增删改
    assert "UPDATE file_usages" not in body and "INSERT INTO file_usages" not in body

    # ③ 取舍必须在脚本里写清楚（不是默默不删）
    assert "保守回滚" in sql and "无法区分" in sql
    assert "audio_file_id" in sql, "要说明为什么不动镜头级旧列，且绝不能删它"

    # ④ 与 SQLite 版共用同一份结论文案
    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _asset_voice_inheritance as shared

    assert "保守回滚" in shared.ROLLBACK_KEEPS_ASSET_VOICE_NOTE
    assert "不删任何资产声音行" in shared.ROLLBACK_KEEPS_ASSET_VOICE_NOTE
    assert "保守回滚" in shared.describe_rollback()

    # ⑤ 顶层 sql/ 目录里不许有回滚文件（deploy/compose 会 `find /sql -maxdepth 1 -name '*.sql'` 全跑）
    top_level = sorted(path.name for path in SQL_DIR.glob("*.sql"))
    assert all("rollback" not in name for name in top_level), (
        f"sql/ 顶层出现了回滚脚本，全新安装会被自动回滚：{top_level}"
    )
    assert top_level == sorted(top_level), "前滚脚本按文件名排序执行，请确认编号顺序"


def test_legacy_heuristic_delete_is_gone_from_both_implementations() -> None:
    """旧的"配对删除"启发式必须从两份实现里都消失（防止有人再加回来）。"""
    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _asset_voice_inheritance as shared

    rollback_file = SQL_DIR / "rollback" / "009-add-asset-voice-inheritance.sql"
    sql = rollback_file.read_text(encoding="utf-8")
    assert "DELETE" not in _executable_sql(sql)

    assert not hasattr(shared, "DELETE_PROMOTED_ASSET_VOICE_SQL"), (
        "清单里不该再有删除语句常量"
    )
    assert not hasattr(shared, "promoted_row_count"), "基于启发式的『提升行计数』不该再存在"
    assert shared.LEGACY_UNSAFE_DELETE_PROMOTED_SQL_REMOVED, "要留下『该判定已移除』的可追溯说明"

    # SQLite 版脚本同样不许执行任何 DELETE
    rollback_script = (SCRIPTS_DIR / "rollback_asset_voice_inheritance.py").read_text(encoding="utf-8")
    assert "DELETE FROM" not in rollback_script, "回滚脚本里不许有 DELETE FROM"
