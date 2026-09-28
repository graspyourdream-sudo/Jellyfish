"""资产级声音继承（迁移 009）的清单与语句：迁移脚本、回滚脚本、回归测试**共用这一份**。

为什么除了 ``sql/009-*.sql`` 还有一份 Python
============================================

``backend/sql/*.sql`` 是 **MySQL 方言**（``information_schema`` / ``PREPARE``），
由 ``deploy/compose`` 的初始化容器逐文件执行；而开发与本地运行时是 SQLite
（``backend/jellyfish.db``，同 ``_llm_pipeline_columns.py`` 文件头写的那条约定）。
两份实现的**步骤与结论必须一致**，所以：

- ``backend/sql/009-add-asset-voice-inheritance.sql``（前滚）与
  ``backend/sql/rollback/009-add-asset-voice-inheritance.sql``（回滚）→ 部署到 MySQL；
- 本清单 + ``migrate_asset_voice_inheritance.py`` / ``rollback_asset_voice_inheritance.py``
  → 本地 SQLite，能被 ``tests/test_asset_voice_inheritance_migration.py`` 真的跑一遍
  （前滚 → 幂等重跑 → 回滚 → 再前滚的往返）。
- 两边的一致性（列名 / 回填步骤 / 回滚对称性）由那个测试静态对拍，避免"两份实现各自漂移"。

迁移做两件事（设计包 §10）
==========================

1. **新增 ``shot_details.voice_inherited_from``**：镜头级声音的**继承来源**
   （形如 ``character:char-1``）。迁移前的逐镜声音（``shot_details.audio_file_id``）
   从此只作为**只读快照**被读取 —— 第 4 步不回写，接口层也没有这一列的写入口
   （``ShotDetailUpdate`` 里没有它）。
2. **回填历史数据（不让用户以前的选择丢）**：
   - 某角色**还没有**资产声音、且它在历史镜头上的声音**唯一**时，把这条历史声音
     提升为**该角色的资产声音**（写 ``file_usages``，``usage_kind='asset_voice'``）；
   - 该角色名下这些历史镜头同时被标上继承来源；
   - 一个角色有多个不同历史声音（分叉）时**不猜**：不动资产声音，只如实标注来源。

资产声音存在 ``file_usages``（``usage_kind='asset_voice'`` + ``source_ref='<类型>:<资产ID>'``，
写入路径在 ``app/services/studio/asset_voices.py``）：本迁移**不新增**第二份存储。

范围：只处理**角色声音（人物配音）**。配乐 / 环境音 / 音效 / 最终成片音轨不在此范围内。
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

#: 新增列所在表 / 列名 / SQLite 列定义 / 为什么要它（迁移输出与文档引用同一份文案）。
TABLE = "shot_details"
COLUMN = "voice_inherited_from"
COLUMN_DDL = "VARCHAR(96)"
COLUMN_WHY = "镜头声音的继承来源（<资产类型>:<资产ID>，如 character:char-1）；只读快照，第 4 步不回写"

#: 资产声音在 ``file_usages`` 上的口径（与 ``app/models/types.py`` 的 FileUsageKind 同值）。
ASSET_VOICE_KIND = "asset_voice"
#: 角色（人物资产）的类型码（与 ``app/services/studio/asset_profiles.py`` 同值）。
CHARACTER_TYPE = "character"

#: 前滚的 DDL：SQLite 里可空列不需要默认值。
ADD_COLUMN_SQL = f"ALTER TABLE {TABLE} ADD COLUMN {COLUMN} {COLUMN_DDL}"
#: 回滚的 DDL。
DROP_COLUMN_SQL = f"ALTER TABLE {TABLE} DROP COLUMN {COLUMN}"


def source_ref_for_character(character_id: str) -> str:
    """角色资产在 ``source_ref`` 上的引用形态（与 ``asset_voices.asset_voice_source_ref`` 同口径）。"""
    return f"{CHARACTER_TYPE}:{character_id}"


def legacy_shot_voice_predicate(shot_alias: str) -> str:
    """「这一镜有历史声音」的判定（迁移只认这种行）：确实绑了音频、且没标记无需声音。"""
    return (
        f"{shot_alias}.audio_file_id IS NOT NULL AND {shot_alias}.audio_file_id <> '' "
        f"AND COALESCE({shot_alias}.audio_opt_out, 0) = 0"
    )


def attributable_legacy_voice_predicate(shot_alias: str) -> str:
    """「这条历史声音能归到某个角色头上」的判定：在上一条件之上，再要求**这一镜只有一个角色**。

    为什么必须加这一条：挂两个角色的镜头里那条音频归谁都不对。少了它，双人镜头的一条音频
    会被"提升"成两个角色各自的资产声音 —— 这属于**猜**，而猜错会把整集的声音配错人。
    判定不成立时就不提升、只在来源唯一可判定的镜头（本函数同款条件）上标注继承来源。
    """
    return (
        f"{legacy_shot_voice_predicate(shot_alias)} "
        f"AND (SELECT COUNT(*) FROM shot_character_links lx WHERE lx.shot_id = {shot_alias}.id) = 1"
    )


def _character_distinct_attributable_voices() -> str:
    """某角色名下**不同**历史音频的条数（=1 才允许提升；分叉就不猜）。"""
    return f"""
        SELECT COUNT(DISTINCT sd2.audio_file_id)
        FROM shot_details sd2
        JOIN shot_character_links l2 ON l2.shot_id = sd2.id
        WHERE l2.character_id = c.id
          AND {attributable_legacy_voice_predicate('sd2')}
    """


#: **提升候选**：该角色还没有资产声音 + 它能归属到的历史声音唯一。只读 SELECT，
#: 供 --check 预告与测试断言使用；前滚的 INSERT 直接嵌这一份（不存在"预告与执行不一致"）。
CANDIDATE_SELECT = f"""
SELECT legacy.audio_file_id AS file_id, c.id AS character_id, c.project_id AS project_id
FROM (
  SELECT DISTINCT sd.audio_file_id AS audio_file_id, l.character_id AS character_id
  FROM shot_details sd
  JOIN shot_character_links l ON l.shot_id = sd.id
  WHERE {attributable_legacy_voice_predicate("sd")}
) AS legacy
JOIN characters c ON c.id = legacy.character_id
WHERE NOT EXISTS (
        SELECT 1 FROM file_usages fu
        WHERE fu.usage_kind = '{ASSET_VOICE_KIND}'
          AND fu.source_ref = '{CHARACTER_TYPE}:' || c.id
      )
  AND ({_character_distinct_attributable_voices()}) = 1
"""


def promote_legacy_shot_voice_sql() -> str:
    """回填①：把唯一的历史逐镜声音提升为该角色的资产声音（幂等：NOT EXISTS 命中即无行可插）。"""
    return (
        "INSERT INTO file_usages (file_id, project_id, chapter_id, shot_id, usage_kind, source_ref)\n"
        f"SELECT candidate.file_id, candidate.project_id, NULL, NULL, '{ASSET_VOICE_KIND}',\n"
        f"       '{CHARACTER_TYPE}:' || candidate.character_id\n"
        f"FROM ({CANDIDATE_SELECT}) AS candidate"
    )


#: 回填②：给历史逐镜声音标上继承来源（只标「该镜只有一个角色」的可判定情形）。
MARK_LEGACY_SHOT_VOICE_SOURCE_SQL = f"""
UPDATE {TABLE} AS sd
SET {COLUMN} = '{CHARACTER_TYPE}:' || (
      SELECT l.character_id FROM shot_character_links l WHERE l.shot_id = sd.id
    )
WHERE {attributable_legacy_voice_predicate("sd")}
  AND sd.{COLUMN} IS NULL
"""

#: 回滚：删掉本迁移「提升」出来的资产声音行。
#: 判定 = 资产声音行的 source_ref 与某镜的继承来源相同，且它的文件正是该镜的历史音频。
DELETE_PROMOTED_ASSET_VOICE_SQL = f"""
DELETE FROM file_usages
WHERE usage_kind = '{ASSET_VOICE_KIND}'
  AND EXISTS (
        SELECT 1 FROM {TABLE} sd
        WHERE sd.{COLUMN} = file_usages.source_ref
          AND sd.audio_file_id IS NOT NULL
          AND sd.audio_file_id <> ''
          AND sd.audio_file_id = file_usages.file_id
      )
"""


def describe() -> str:
    """一行说明清单内容（脚本输出用；数字由代码动态给出，不在文案里写死）。"""
    return (
        f"{TABLE}.{COLUMN}（{COLUMN_DDL}）：{COLUMN_WHY}"
        f"；回填：可归属的历史逐镜声音 → 角色资产声音（{ASSET_VOICE_KIND}，"
        "仅『这一镜只有一个角色』且该角色历史声音唯一时）+ 标注继承来源"
    )


@dataclass(frozen=True, slots=True)
class Promotion:
    """一条待提升的历史声音（角色 → 它唯一的历史音频）。"""

    character_id: str
    file_id: str
    project_id: str


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    """表是否存在（迁移只依赖既有表，缺表要明确报错，不能静默跳过）。"""
    row = conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone()
    return bool(row and row[0])


def column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    """列是否存在（表不存在时返回 False）。"""
    try:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    except sqlite3.Error:
        return False
    return column in {str(row[1]) for row in rows}


def required_tables() -> tuple[str, ...]:
    """迁移依赖的全部表（缺任何一张都不该继续跑）。"""
    return (TABLE, "shot_character_links", "characters", "file_usages")


def missing_tables(conn: sqlite3.Connection) -> list[str]:
    """缺哪些前置表（空列表 = 结构满足迁移前提）。"""
    return [name for name in required_tables() if not table_exists(conn, name)]


def promotion_candidates(conn: sqlite3.Connection) -> list[Promotion]:
    """只读：本迁移会把哪些历史声音提升成资产声音。"""
    rows = conn.execute(CANDIDATE_SELECT).fetchall()
    return [Promotion(character_id=str(row[1]), file_id=str(row[0]), project_id=str(row[2])) for row in rows]


def pending_source_mark_count(conn: sqlite3.Connection) -> int:
    """只读：还有多少条历史逐镜声音会被标上继承来源（要求列已存在）。"""
    if not column_exists(conn, TABLE, COLUMN):
        return 0
    row = conn.execute(
        f"SELECT COUNT(*) FROM {TABLE} AS sd "
        f"WHERE {attributable_legacy_voice_predicate('sd')} AND sd.{COLUMN} IS NULL"
    ).fetchone()
    return int(row[0]) if row else 0


def promoted_row_count(conn: sqlite3.Connection) -> int:
    """只读：库里有几行「本迁移提升出来的」资产声音（回滚会删掉的行）。"""
    if not column_exists(conn, TABLE, COLUMN):
        return 0
    row = conn.execute(
        f"SELECT COUNT(*) FROM file_usages WHERE usage_kind = '{ASSET_VOICE_KIND}' AND EXISTS ("
        f"  SELECT 1 FROM {TABLE} sd WHERE sd.{COLUMN} = file_usages.source_ref"
        "     AND sd.audio_file_id IS NOT NULL AND sd.audio_file_id <> ''"
        "     AND sd.audio_file_id = file_usages.file_id)"
    ).fetchone()
    return int(row[0]) if row else 0


def asset_voice_row_count(conn: sqlite3.Connection) -> int:
    """只读：库里资产声音行的总数（幂等断言用）。"""
    row = conn.execute(
        f"SELECT COUNT(*) FROM file_usages WHERE usage_kind = '{ASSET_VOICE_KIND}'"
    ).fetchone()
    return int(row[0]) if row else 0


__all__ = [
    "ADD_COLUMN_SQL",
    "ASSET_VOICE_KIND",
    "CANDIDATE_SELECT",
    "CHARACTER_TYPE",
    "COLUMN",
    "COLUMN_DDL",
    "COLUMN_WHY",
    "DELETE_PROMOTED_ASSET_VOICE_SQL",
    "DROP_COLUMN_SQL",
    "MARK_LEGACY_SHOT_VOICE_SOURCE_SQL",
    "Promotion",
    "TABLE",
    "asset_voice_row_count",
    "column_exists",
    "describe",
    "missing_tables",
    "pending_source_mark_count",
    "promote_legacy_shot_voice_sql",
    "promoted_row_count",
    "promotion_candidates",
    "required_tables",
    "source_ref_for_character",
    "table_exists",
]
