-- =============================================================================
-- 回滚 · 009-add-asset-voice-inheritance.sql
-- =============================================================================
-- 放在 sql/rollback/ 子目录（不是 sql/ 顶层）：deploy/compose 的初始化容器会
-- `find /sql -maxdepth 1 -name '*.sql'` 逐个执行，回滚脚本待在顶层会被自动执行。
--
-- 用法（MySQL 8/9）：
--   mysql -h <host> -u <user> -p <db> < backend/sql/rollback/009-add-asset-voice-inheritance.sql
--
-- 语义：**保守回滚**（与 SQLite 版 scripts/rollback_asset_voice_inheritance.py 完全一致）
-- =============================================================================
-- 只撤掉本迁移新增的**结构**：shot_details.voice_inherited_from 列。
--
-- 本脚本 **不删任何 file_usages 行** —— 迁移提升出来的角色声音**保留**。
--
-- 为什么（这是一次明确的取舍，不是省事）：
--   迁移把「可归属的历史逐镜声音」提升成角色资产声音时，**没有、也无法**给这些行留下
--   可核验的来源标记：提升出来的行与「迁移前就存在的、source_ref 与 file_id 都一样的
--   用户绑定」在库里**无法区分**（长得完全一样）。旧回滚按「source_ref = 某镜的
--   voice_inherited_from 且 file_id = 该镜的 audio_file_id」配对删除，于是它会：
--     · 删掉迁移前就存在的**合法角色声音**（用户数据永久丢失）；
--     · 删掉用户在迁移后**重新绑定的同一个**音频文件。
--   判定分不清"这条行是谁写的"时，不许拿它驱动删除。
--
-- 代价（说清楚，不粉饰）：回滚**不能**回到迁移前的数据状态，只能回到迁移前的结构状态 ——
--   库里可能多出一条历史来源的角色声音绑定，用户可以自己解绑（多一条数据的代价
--   与"配音永久丢失"不对等）。重跑前滚不会重复插入（NOT EXISTS 守卫），
--   所以「前滚 → 回滚 → 前滚」仍然得到同一份结果，不会叠加数据。
--
-- 需要"数据也回到过去"时：用备份整体还原（sqlite 版脚本的 --restore 是同一思路），
--   而不是靠一个分不清来源的 DELETE。
--
-- 不动的东西：
--   · file_usages（一行都不删、不改）；
--   · shot_details.audio_file_id / audio_opt_out —— 迁移前就存在的用户数据。
--
-- 幂等：DROP COLUMN 带 information_schema 存在性守卫，重复执行第二次为空操作。
-- =============================================================================

SET @has_shot_details_voice_inherited_from = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shot_details'
    AND COLUMN_NAME = 'voice_inherited_from'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 去掉本迁移新增的列（唯一动作）
--
-- 刻意**没有** DELETE 语句：见上面的"保守回滚"。历史实现里那一条
-- `DELETE fu FROM file_usages fu JOIN shot_details sd ON ...`
-- 已按本口径移除，不要再加回来。
-- ─────────────────────────────────────────────────────────────────────────────
SET @drop_shot_details_voice_inherited_from = IF(
  @has_shot_details_voice_inherited_from > 0,
  "ALTER TABLE shot_details DROP COLUMN voice_inherited_from",
  'SELECT 1'
);
PREPARE stmt_drop_shot_details_voice_inherited_from FROM @drop_shot_details_voice_inherited_from;
EXECUTE stmt_drop_shot_details_voice_inherited_from;
DEALLOCATE PREPARE stmt_drop_shot_details_voice_inherited_from;
