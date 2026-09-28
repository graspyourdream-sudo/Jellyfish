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
6. **回滚**：提升行被删掉、列被删掉、迁移前就存在的资产声音行**保留**、
   镜头级旧数据仍在；重复回滚是空操作；回滚后能再前滚（往返可重复）；
7. **两份实现一致**：``sql/009-*.sql``（MySQL，部署用）与 Python 版（SQLite，本地）
   列名 / 回填步骤 / 回滚对称性对拍；回滚脚本不在 ``sql/`` 顶层（否则会被
   deploy/compose 的初始化容器自动执行）。

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
_SEED_SQL: tuple[str, ...] = (
    "INSERT INTO characters (id, name, project_id) VALUES ('char-1', '苏晚棠', 'proj-1')",
    "INSERT INTO characters (id, name, project_id) VALUES ('char-2', '叶老夫人', 'proj-1')",
    "INSERT INTO characters (id, name, project_id) VALUES ('char-3', '阿福', 'proj-1')",
    "INSERT INTO characters (id, name, project_id) VALUES ('char-4', '路人甲', 'proj-1')",
    "INSERT INTO characters (id, name, project_id) VALUES ('char-5', '双人甲', 'proj-1')",
    "INSERT INTO characters (id, name, project_id) VALUES ('char-6', '双人乙', 'proj-1')",
    "INSERT INTO shot_details (id, audio_file_id, audio_opt_out) VALUES ('shot-1', 'a1', 0)",
    "INSERT INTO shot_details (id, audio_file_id, audio_opt_out) VALUES ('shot-2', 'a1', 0)",
    "INSERT INTO shot_details (id, audio_file_id, audio_opt_out) VALUES ('shot-3', 'a2', 0)",
    "INSERT INTO shot_details (id, audio_file_id, audio_opt_out) VALUES ('shot-4', 'a3', 0)",
    "INSERT INTO shot_details (id, audio_file_id, audio_opt_out) VALUES ('shot-5', 'a4', 0)",
    "INSERT INTO shot_details (id, audio_file_id, audio_opt_out) VALUES ('shot-6', 'a5', 1)",
    "INSERT INTO shot_details (id, audio_file_id, audio_opt_out) VALUES ('shot-7', 'a6', 0)",
    "INSERT INTO shot_details (id, audio_file_id, audio_opt_out) VALUES ('shot-8', 'a7', 0)",
    "INSERT INTO shot_details (id, audio_file_id, audio_opt_out) VALUES ('shot-9', NULL, 0)",
    "INSERT INTO shot_character_links (shot_id, character_id) VALUES ('shot-1', 'char-1')",
    "INSERT INTO shot_character_links (shot_id, character_id) VALUES ('shot-2', 'char-1')",
    "INSERT INTO shot_character_links (shot_id, character_id) VALUES ('shot-3', 'char-2')",
    "INSERT INTO shot_character_links (shot_id, character_id) VALUES ('shot-4', 'char-2')",
    "INSERT INTO shot_character_links (shot_id, character_id) VALUES ('shot-5', 'char-3')",
    "INSERT INTO shot_character_links (shot_id, character_id) VALUES ('shot-6', 'char-4')",
    "INSERT INTO shot_character_links (shot_id, character_id) VALUES ('shot-8', 'char-5')",
    "INSERT INTO shot_character_links (shot_id, character_id) VALUES ('shot-8', 'char-6')",
    "INSERT INTO shot_character_links (shot_id, character_id) VALUES ('shot-9', 'char-1')",
    # char-3 迁移前就有的资产声音（回滚必须保留它）
    (
        "INSERT INTO file_usages (file_id, project_id, chapter_id, shot_id, usage_kind, source_ref) "
        "VALUES ('a9', 'proj-1', NULL, NULL, 'asset_voice', 'character:char-3')"
    ),
)


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


def _backups(path: Path) -> list[Path]:
    return sorted(path.parent.glob(f"{path.name}.backup_before_asset_voice_*"))


def _executable_sql(sql: str) -> str:
    """只留可执行语句（去掉 ``--`` 注释行）：断言"语句顺序"时不能被文件头的说明文字带偏。"""
    return "\n".join(line for line in sql.splitlines() if not line.strip().startswith("--"))


# ---------------------------------------------------------------------------
# 1) 前滚：列 + 回填（提升与标注），且不覆盖已有资产声音
# ---------------------------------------------------------------------------


def test_forward_adds_column_and_backfills_legacy_voice(tmp_path: Path) -> None:
    """前滚：列补上；唯一的历史声音提升为角色资产声音；已有资产声音不被覆盖。"""
    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _asset_voice_inheritance as shared

    migrate = _load_script("migrate_asset_voice_inheritance")

    db = tmp_path / "forward.db"
    _make_pre_migration_db(db)
    assert shared.COLUMN not in _columns(db, shared.TABLE)
    legacy_before = _legacy_audio_rows(db)

    assert migrate.migrate(check_only=False, db_path=db) == 0

    # ① 列真的加上了
    assert shared.COLUMN in _columns(db, shared.TABLE)

    # ② 提升：char-1 的 a1 成为它的资产声音；char-2 分叉不提升；char-3 的旧行保留
    assert _asset_voice_rows(db) == [
        ("character:char-1", "a1", "proj-1"),
        (shared.source_ref_for_character("char-3"), "a9", "proj-1"),
    ]

    # ③ 标注继承来源：来源唯一的镜头都标上；不唯一 / 无角色 / 标记无需声音的留空
    assert _voice_sources(db) == [
        ("shot-1", "character:char-1"),
        ("shot-2", "character:char-1"),
        ("shot-3", "character:char-2"),
        ("shot-4", "character:char-2"),
        ("shot-5", "character:char-3"),
    ]

    # ④ 镜头级旧数据一个字节都没动
    assert _legacy_audio_rows(db) == legacy_before
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
# 2) 回滚：提升行删掉、列删掉、旧行保留；重复回滚空操作；往返可重复
# ---------------------------------------------------------------------------


def test_rollback_removes_only_what_the_migration_added(tmp_path: Path) -> None:
    """回滚：删提升行 + 删列；迁移前就存在的资产声音行与镜头级旧数据全部保留。"""
    # pylint: disable=import-error  # scripts/ 已注入 sys.path
    import _asset_voice_inheritance as shared

    migrate = _load_script("migrate_asset_voice_inheritance")
    rollback = _load_script("rollback_asset_voice_inheritance")

    db = tmp_path / "rollback.db"
    _make_pre_migration_db(db)
    before_columns = _columns(db, shared.TABLE)
    legacy_before = _legacy_audio_rows(db)

    assert migrate.migrate(check_only=False, db_path=db) == 0
    assert shared.COLUMN in _columns(db, shared.TABLE)

    # 回滚 --check：不写库
    assert rollback.rollback(check_only=True, db_path=db) == 0
    assert shared.COLUMN in _columns(db, shared.TABLE)

    assert rollback.rollback(db_path=db) == 0
    # ① 列没了，列定义回到迁移前
    assert _columns(db, shared.TABLE) == before_columns
    # ② 提升行没了；用户/迁移前就有的资产声音行还在
    assert _asset_voice_rows(db) == [("character:char-3", "a9", "proj-1")]
    # ③ 镜头级旧数据没动
    assert _legacy_audio_rows(db) == legacy_before
    # ④ 重复回滚是空操作（幂等）
    assert rollback.rollback(db_path=db) == 0
    assert _asset_voice_rows(db) == [("character:char-3", "a9", "proj-1")]


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

    assert rollback.rollback(db_path=db) == 0
    assert shared.COLUMN not in _columns(db, shared.TABLE)

    assert migrate.migrate(check_only=False, db_path=db) == 0
    assert _asset_voice_rows(db) == first_voices, "第二次前滚必须得到同一份资产声音"
    assert _voice_sources(db) == first_sources, "第二次前滚必须得到同一份继承来源"
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


def test_mysql_rollback_script_is_symmetric_and_not_auto_run() -> None:
    """回滚脚本必须与迁移对称，而且**不能**待在 ``sql/`` 顶层（会被部署初始化自动执行）。"""
    rollback_file = SQL_DIR / "rollback" / "009-add-asset-voice-inheritance.sql"
    assert rollback_file.exists(), f"缺少部署用回滚脚本：{rollback_file}"
    sql = rollback_file.read_text(encoding="utf-8")
    body = _executable_sql(sql)

    # ① 对称：先删提升行（依赖那一列），再删列
    assert "DELETE" in body and "file_usages" in body, "回滚必须删掉迁移提升出来的资产声音行"
    assert "DROP COLUMN voice_inherited_from" in body, "回滚必须删掉新增列"
    assert body.index("DELETE") < body.index("DROP COLUMN"), (
        "删提升行必须在 DROP COLUMN 之前（配对条件依赖那一列）"
    )
    assert "audio_file_id" in sql, "回滚的配对条件要说明它依赖镜头级旧列，但绝不能删它"
    assert "DROP TABLE" not in sql, "回滚不许删任何表"

    # ② 顶层 sql/ 目录里不许有回滚文件（deploy/compose 会 `find /sql -maxdepth 1 -name '*.sql'` 全跑）
    top_level = sorted(path.name for path in SQL_DIR.glob("*.sql"))
    assert all("rollback" not in name for name in top_level), (
        f"sql/ 顶层出现了回滚脚本，全新安装会被自动回滚：{top_level}"
    )
    assert top_level == sorted(top_level), "前滚脚本按文件名排序执行，请确认编号顺序"
