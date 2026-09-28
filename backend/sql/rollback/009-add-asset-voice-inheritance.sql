-- =============================================================================
-- 回滚 · 009-add-asset-voice-inheritance.sql
-- =============================================================================
-- 放在 sql/rollback/ 子目录（不是 sql/ 顶层）：deploy/compose 的初始化容器会
-- `find /sql -maxdepth 1 -name '*.sql'` 逐个执行，回滚脚本待在顶层会被自动执行。
--
-- 用法（MySQL 8/9）：
--   mysql -h <host> -u <user> -p <db> < backend/sql/rollback/009-add-asset-voice-inheritance.sql
--
-- 语义（与 migrate_ad_flow / rollback_ad_flow 同一条口径）：
--   · 回滚**只**撤掉本迁移加的东西：它提升出来的资产声音行 + 新增的列；
--   · 迁移**之后**用户在第 2 步重新绑定过的资产声音**保留**（除非它与某个历史快照
--     「同一资产 + 同一个音频文件」完全一致 —— 那种行无法与迁移提升的行区分，
--     按回滚语义一并撤掉）；
--   · shot_details.audio_file_id 一个字节都不动：它是迁移前就存在的用户数据。
--
-- 幂等：先删提升行（要求那一列还在），列已不存在时整段跳过；DROP COLUMN 同样带存在性守卫，
--       重复执行第二次为空操作。
-- 顺序：删提升行必须在 DROP COLUMN **之前**（配对条件依赖 voice_inherited_from）。
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- ① 删掉本迁移从历史逐镜声音「提升」出来的资产声音行
--    判定：资产声音行的 source_ref 与某个镜头的 voice_inherited_from 相同，
--          且它的 file_id 正是该镜头的 audio_file_id —— 即这条绑定来自历史快照。
-- ─────────────────────────────────────────────────────────────────────────────
SET @has_shot_details_voice_inherited_from = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shot_details'
    AND COLUMN_NAME = 'voice_inherited_from'
);

SET @remove_promoted_asset_voice = IF(
  @has_shot_details_voice_inherited_from > 0,
  "DELETE fu FROM file_usages fu JOIN shot_details sd ON fu.source_ref = sd.voice_inherited_from AND fu.file_id = sd.audio_file_id WHERE fu.usage_kind = 'asset_voice' AND sd.voice_inherited_from IS NOT NULL AND sd.audio_file_id IS NOT NULL AND sd.audio_file_id <> ''",
  'SELECT 1'
);
PREPARE stmt_remove_promoted_asset_voice FROM @remove_promoted_asset_voice;
EXECUTE stmt_remove_promoted_asset_voice;
DEALLOCATE PREPARE stmt_remove_promoted_asset_voice;

-- ─────────────────────────────────────────────────────────────────────────────
-- ② 去掉本迁移新增的列
-- ─────────────────────────────────────────────────────────────────────────────
SET @drop_shot_details_voice_inherited_from = IF(
  @has_shot_details_voice_inherited_from > 0,
  "ALTER TABLE shot_details DROP COLUMN voice_inherited_from",
  'SELECT 1'
);
PREPARE stmt_drop_shot_details_voice_inherited_from FROM @drop_shot_details_voice_inherited_from;
EXECUTE stmt_drop_shot_details_voice_inherited_from;
DEALLOCATE PREPARE stmt_drop_shot_details_voice_inherited_from;
