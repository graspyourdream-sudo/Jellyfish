-- =============================================================================
-- 009 · 角色声音（人物配音）：唯一事实来源是人物资产，镜头级只留「只读继承快照」
-- =============================================================================
-- 背景（设计包 §10）
--   声音属于**人物资产**，不属于单个镜头。第 2 步「人物资产详情」是全站唯一的绑定入口
--   （选择 / 试听 / 保存 / 更换），第 4 步「资产与声音检查」只读继承结果与来源，
--   不提供第二套选择 / 更换入口，也不回写。
--
-- 本迁移做两件事
--   1. 新增 shot_details.voice_inherited_from：镜头级声音的**继承来源**
--      （形如 character:char-1）。迁移前写入的逐镜声音（shot_details.audio_file_id）
--      从这一刻起只作为**只读快照**被读取：第 4 步不回写，接口层也没有这一列的写入口
--      （ShotDetailUpdate 里没有它，PATCH /studio/shot-details/{id} 永远写不进去）。
--   2. 回填历史数据（不让用户以前的选择丢）：
--      · 某角色**还没有**资产声音、且它能归属到的历史声音**唯一**时，
--        把这条历史声音提升为**该角色的资产声音**（写 file_usages）；
--      · 该角色名下这些历史镜头同时被标上继承来源。
--      · 「能归属到某个角色」= 那一镜只有**一个**角色：双人镜头里的一条音频归谁都不对，
--        猜错就是把整集的声音配错人 —— 所以这种镜头**不提升**，也不标注来源。
--      · 一个角色有多个不同历史声音（分叉）时同样**不猜**，只如实标注来源。
--
-- 资产声音存在哪：本迁移**不新增**存储
--   资产级声音复用既有 file_usages：usage_kind = 'asset_voice' +
--   source_ref = '<资产类型>:<资产ID>'（写入路径见 app/services/studio/asset_voices.py）。
--   应用层在同一条事务里保证「一个资产只有一个生效声音」，因此这里只补
--   「镜头级怎么继承人物资产的声音」这一半，不另立第二份事实来源。
--
-- 幂等
--   每条 DDL 都先查 information_schema：列 / 表已存在时只执行 SELECT 1，重复跑不报错；
--   两条回填语句各自带 NOT EXISTS / IS NULL 守卫，重复执行为空操作，不会写第二行。
--
-- 回滚
--   backend/sql/rollback/009-add-asset-voice-inheritance.sql
--   刻意放在 rollback/ 子目录：deploy/compose 的初始化容器用
--   `find /sql -maxdepth 1 -name '*.sql'` 逐个执行，回滚脚本不能待在 sql/ 顶层，
--   否则全新安装会被自动回滚。
--
-- 范围
--   只处理**角色声音（人物配音）**。配乐 / 环境音 / 音效 / 最终成片音轨不属于人物资产，
--   本迁移一个字都不碰。
--
-- 前置
--   shot_details / shot_character_links / characters / file_usages 均已存在
--   （分别来自 002 及更早的基线结构、以及既有建表脚本）。
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- ① 镜头级声音的继承来源（新增列）
-- ─────────────────────────────────────────────────────────────────────────────
SET @has_shot_details_voice_inherited_from = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'shot_details'
    AND COLUMN_NAME = 'voice_inherited_from'
);

SET @add_shot_details_voice_inherited_from = IF(
  @has_shot_details_voice_inherited_from = 0,
  "ALTER TABLE shot_details ADD COLUMN voice_inherited_from VARCHAR(96) NULL COMMENT '镜头声音的继承来源（<资产类型>:<资产ID>，如 character:char-1）；只读快照，第 4 步不回写'",
  'SELECT 1'
);
PREPARE stmt_add_shot_details_voice_inherited_from FROM @add_shot_details_voice_inherited_from;
EXECUTE stmt_add_shot_details_voice_inherited_from;
DEALLOCATE PREPARE stmt_add_shot_details_voice_inherited_from;

-- ─────────────────────────────────────────────────────────────────────────────
-- ② 回填：把可归属的唯一历史逐镜声音提升为角色资产声音
--    · 只处理「这一镜只有一个角色」的历史声音（判定写在 attributable 子查询里）：双人镜头里的音频归谁都不对；
--    · 该角色在**可归属**的历史镜头里只有一个不同音频（分叉就不猜）；
--    · 该角色已经有资产声音（任何来源）时跳过，绝不覆盖用户后来的显式绑定；
--    · 重复执行为空操作（NOT EXISTS 命中后没有行可插）。
-- ─────────────────────────────────────────────────────────────────────────────
SET @promote_legacy_shot_voice_to_character = "
INSERT INTO file_usages (file_id, project_id, chapter_id, shot_id, usage_kind, source_ref)
SELECT attributable.audio_file_id,
       c.project_id,
       NULL,
       NULL,
       'asset_voice',
       CONCAT('character:', c.id)
FROM (
  SELECT DISTINCT sd.audio_file_id, l.character_id
  FROM shot_details sd
  JOIN shot_character_links l ON l.shot_id = sd.id
  WHERE sd.audio_file_id IS NOT NULL
    AND sd.audio_file_id <> ''
    AND COALESCE(sd.audio_opt_out, 0) = 0
    AND (SELECT COUNT(*) FROM shot_character_links lx WHERE lx.shot_id = sd.id) = 1
) AS attributable
JOIN characters c ON c.id = attributable.character_id
WHERE NOT EXISTS (
        SELECT 1
        FROM (SELECT source_ref FROM file_usages WHERE usage_kind = 'asset_voice') AS already_bound
        WHERE already_bound.source_ref = CONCAT('character:', c.id)
      )
  AND (
        SELECT COUNT(DISTINCT sd2.audio_file_id)
        FROM shot_details sd2
        JOIN shot_character_links l2 ON l2.shot_id = sd2.id
        WHERE l2.character_id = c.id
          AND sd2.audio_file_id IS NOT NULL
          AND sd2.audio_file_id <> ''
          AND COALESCE(sd2.audio_opt_out, 0) = 0
          AND (SELECT COUNT(*) FROM shot_character_links lx2 WHERE lx2.shot_id = sd2.id) = 1
      ) = 1";
PREPARE stmt_promote_legacy_shot_voice_to_character FROM @promote_legacy_shot_voice_to_character;
EXECUTE stmt_promote_legacy_shot_voice_to_character;
DEALLOCATE PREPARE stmt_promote_legacy_shot_voice_to_character;

-- ─────────────────────────────────────────────────────────────────────────────
-- ③ 回填：给历史逐镜声音标上继承来源（只标「该镜只有一个角色」的可判定情形）
--    · voice_inherited_from IS NULL 守卫保证重复执行不改已标注的行；
--    · 镜头上挂了多个角色时来源不唯一，留空比猜一个更诚实（读取侧如实显示为缺项）。
-- ─────────────────────────────────────────────────────────────────────────────
SET @mark_legacy_shot_voice_source = "
UPDATE shot_details sd
JOIN shot_character_links l ON l.shot_id = sd.id
SET sd.voice_inherited_from = CONCAT('character:', l.character_id)
WHERE sd.audio_file_id IS NOT NULL
  AND sd.audio_file_id <> ''
  AND sd.voice_inherited_from IS NULL
  AND (SELECT COUNT(*) FROM shot_character_links l2 WHERE l2.shot_id = sd.id) = 1";
PREPARE stmt_mark_legacy_shot_voice_source FROM @mark_legacy_shot_voice_source;
EXECUTE stmt_mark_legacy_shot_voice_source;
DEALLOCATE PREPARE stmt_mark_legacy_shot_voice_source;
