---
title: "角色声音继承与资产声音域"
description: "当前架构：角色声音以人物资产为唯一事实来源，关联镜头动态继承；第 4 步只读；audio_opt_out 的覆盖语义、历史快照的兼容语义，以及迁移 009 的部署与安全回滚。"
weight: 10
---

> 本文属于“当前架构”文档，描述**当前真实生效**的角色声音数据模型与继承规则。
> 涉及页面职责的部分配合 [分镜页面职责边界](/docs/architecture/shot-page-boundary/) 一起读。

## 背景

角色声音（人物配音）原先落在**镜头级**的 `shot_details.audio_file_id` 上，于是同一个角色在多个镜头里可能各绑一条声音：用户在第 2 步给人物换音色时，必须逐个镜头重绑，否则不同镜头会用不同音色。

当前实现把事实来源收敛到**人物资产**，镜头级只剩一个**只读的继承快照**。

## 核心结论

```text
人物资产（character）
  = 角色声音的唯一事实来源
    （第 2 步「人物资产详情」是唯一的绑定 / 更换 / 试听入口）

关联镜头
  = 动态继承该人物**当前**绑定的声音
    （换音色不需要逐镜更新，下一次生成自动用新音色）

shot_details.audio_opt_out
  = 镜头级唯一合法的声音声明：「本镜明确无需声音」，覆盖继承

shot_details.audio_file_id
  = 迁移 009 之前的**兼容快照**，只在人物资产没有音色时兜底，永不覆盖人物声音
```

## 1. 存储与事实来源

角色声音存在**资产声音**里，不新增独立表：

- 存储位置：既有 `file_usages` 表
- 判别方式：`usage_kind = 'asset_voice'`
- 资产引用：`source_ref = '<资产类型>:<资产ID>'`（例如 `character:char-1`）

服务层保证「一个资产只有一条生效的角色声音」：写入口在同一事务里先清该资产的旧行、再插新行。

字段读写属性（`backend/app/schemas/studio/shots.py`）：

| 字段 | 读 | 写 | 说明 |
|---|---|---|---|
| `shot_details.audio_file_id` | ✅（兼容快照） | ❌ | **普通更新接口没有这个字段**，调用方无法再创建或更换镜头级角色声音 |
| `shot_details.audio_opt_out` | ✅ | ✅ | 镜头级唯一合法的声音声明 |
| `shot_details.voice_inherited_from` | ✅ | ❌（迁移 009 写入） | 继承来源标记（`character:<资产ID>`），只读快照，第 4 步不回写 |
| `file_usages(usage_kind='asset_voice')` | ✅ | ✅（仅资产级接口） | 角色声音的真正落点 |

## 2. 第 2 步：唯一绑定入口

第 2 步资产工作台的**人物资产详情抽屉**里有一个「角色声音」区块，是全站唯一的绑定入口：

- 位置：抽屉第 ⑤ 项，位于「④ 本次图片提示词」与「⑥ 用户补充」之间
- 能力：选择音色 / 试听 / 保存 / 更换（更换需要二次确认）
- 只对**人物资产**渲染；场景、道具、服装不出现这一区块
- 音色候选来自项目的音频素材库（`files.type = audio`），不新造「系统音色库」

写入口只有一处：

```text
PUT    /api/v1/studio/asset-voices/{asset_type}/{asset_id}   绑定 / 更换
DELETE /api/v1/studio/asset-voices/{asset_type}/{asset_id}   解绑
```

## 3. 生成时的声音解析优先级

计划与提交都必须经过同一个入口：`resolve_audio_admission()`（`backend/app/services/studio/video_audio_input.py`）。顺序即优先级，**不得改回“按镜头优先”**：

```text
① shot_details.audio_opt_out = true
     → 「本镜明确无需声音」，覆盖一切继承（连兼容快照也不用）

② 人物资产当前绑定的角色声音
     → 只要人物资产有音色，生成永远读它（换音色后所有关联镜头下次生成自动生效）

③ shot_details.audio_file_id（迁移 009 之前的兼容快照）
     → 只在人物资产没有音色时兜底；**永远不覆盖**人物资产的声音

④ 都没有
     → 如实判定「未绑定」，不制造噪音
```

结论里带一个**来源标记**，便于排查与技术详情展示：

| 常量 | 值 | 含义 |
|---|---|---|
| `VOICE_SOURCE_CHARACTER_ASSET` | `character_asset` | 来自人物资产（正常路径） |
| `VOICE_SOURCE_LEGACY_SNAPSHOT` | `legacy_shot_snapshot` | 来自历史逐镜声音（兼容降级） |
| `VOICE_SOURCE_NONE` | `none` | 没有声音 |

**多个角色各自有音色时**（`ambiguous`）：不替用户挑一个，**也不退回历史快照** —— 退回快照等于用一条历史逐镜声音冒充角色声音，会与用户刚在第 2 步改过的音色互相矛盾。此时如实给出候选与原因。

## 4. 第 4 步「资产与声音检查」：只读

第 4 步只展示继承**结论**，没有任何选择 / 更换 / 保存入口：

```text
GET /api/v1/studio/asset-voices/shots/{shot_id}/inheritance
```

读口返回五种结论之一（`backend/app/services/studio/asset_voices.py`）：

| 状态 | 含义 | 界面 |
|---|---|---|
| `inherited` | 恰好一个角色绑了声音 → 这一镜继承它 | 显示音色名 +「继承自人物资产」 |
| `ambiguous` | 多个角色各自有音色 → 不替用户挑 | 列出候选，不提供第二套绑定入口 |
| `legacy_snapshot` | 角色都没绑，但这一镜还有迁移前的历史声音 | 明确标注为历史兼容快照 |
| `opt_out` | 本镜已明确标记无需声音 | 如实说明 |
| `missing` | 没有声音 | 标为缺项 +「返回人物资产补充」 |

镜头侧的服务方法集合被测试钉住为**只有 `GET`**；对该路径发 `PUT` / `DELETE` 得到 `405`。

## 5. `audio_opt_out` 的覆盖语义

- 含义：**本镜明确无需声音**，不是“漏绑”。它是镜头级唯一的合法声音声明。
- 与继承的关系：`true` 时不继承人物声音（优先级最高）。
- 入口位置：**分镜准备页**（`ChapterShotEditPage` 的基础信息页签）的「本镜无需声音」开关。
- 语义边界：开关只决定**这一镜用不用**人物资产的声音，**不会改到人物资产**；关闭时这一镜照常继承。
- 「标记过的镜头不会被当成漏绑声音」——就绪判定与导出据此区分「已表态」与「未绑定」。

## 6. 历史镜头声音快照的兼容语义

`shot_details.audio_file_id` 是迁移 009 之前留下的用户数据，**保留不删**：

- 只作为**兼容快照**被读取；
- 只在**人物资产没有音色**时兜底，并带 `legacy_shot_snapshot` 来源标记与说明；
- **不得**覆盖人物资产的当前声音；
- 它**不是**第二套编辑能力：普通更新接口已移除该字段，前端没有写入点。

## 7. 非人物声音不参与角色音色继承

角色音色**只能**来自 `character`（人物）资产：

- 继承解析只查询 `character`（`CHARACTER_VOICE_ASSET_TYPE = "character"`）；
- 生成准入里的人物音色解析同样只处理人物；
- 场景 / 道具 / 服装的声音记录、配乐 / 环境音 / 音效 / 最终成片音轨**都不是**角色音色候选，也不会造成「多个候选」或阻塞；
- 历史数据不删除：非人物声音可以继续作为兼容数据存在，但不参与角色声音继承。

## 8. 迁移 009

### 前滚做了什么

`backend/sql/009-add-asset-voice-inheritance.sql`（MySQL，部署用）：

1. 新增 `shot_details.voice_inherited_from`（镜头声音的继承来源，只读快照）；
2. **回填**：把可归属的历史逐镜声音提升为角色资产声音（写 `file_usages`）；
   - 只处理「这一镜只有**一个**角色」的历史声音 —— 双人镜头里的一条音频归谁都不对，**不猜**；
   - 该角色已有资产声音时跳过，**绝不覆盖**用户后来的显式绑定；
3. 给可判定的历史逐镜声音标上继承来源。

### 部署顺序

`deploy/compose/docker-compose.yml` 里的 `mysql-init-sql` 服务会执行：

```bash
find /sql -maxdepth 1 -type f -name '*.sql' | sort   # 逐个应用
```

因此：

- `backend/sql/*.sql` 顶层文件会在全新安装时**按文件名顺序自动执行** → 前滚脚本放这里；
- `backend/sql/rollback/*.sql` 在**子目录**里，**不会**被自动执行 → 回滚脚本必须放这里（否则全新安装会被自动回滚）；
- SQLite / 本地开发走 `init_db.py`（SQLAlchemy `create_all`）+ `backend/scripts/` 下的 Python 版脚本；
- `backend/sql/*.sql` 是 **MySQL 方言**，`backend/scripts/*.py` 是 **SQLite 版**，两者语义必须一致。

**升级顺序**：先跑前滚（`sql/009-*.sql` 或 Python 版），再切应用代码。未跑迁移就用新代码时，新读口会因缺少列而报错。

### 幂等

- 前滚：DDL 先查 `information_schema`，列/表已存在时只 `SELECT 1`；两条回填各自带 `NOT EXISTS` / `IS NULL` 守卫，重复执行为空操作；
- 回滚：`DROP COLUMN` 带存在性守卫，重复执行为空操作；
- `--check`：只报告将要做什么，**不写库、不生成备份**。

### 安全回滚（保守回滚）

回滚脚本 `backend/sql/rollback/009-add-asset-voice-inheritance.sql`（及 Python 版）采用**保守回滚**：

- **只撤掉本迁移新增的结构**（`shot_details.voice_inherited_from` 列）；
- **一行 `file_usages` 都不删** —— 迁移提升出来的角色声音保留。

**为什么**：迁移把历史逐镜声音提升成角色资产声音时，**没有也无法**给这些行留下可核验的来源标记 —— 提升出来的行与「迁移前就存在的、`source_ref` 与 `file_id` 都一样的用户绑定」在库里长得完全一样。

旧实现在这条无法区分来源的启发式上做配对删除，会：

- 删掉迁移前就存在的**合法角色声音**（用户数据永久丢失）；
- 删掉用户在迁移后**重新绑定的同一个**音频文件。

判定分不清“这条行是谁写的”时，不许拿它驱动删除。

**代价（明确说清）**：回滚**不能**回到迁移前的数据状态，只能回到迁移前的结构状态 —— 库里可能多出一条历史来源的角色声音绑定，用户可以自己解绑。重跑前滚不会重复插入（`NOT EXISTS` 守卫），所以「前滚 → 回滚 → 前滚」仍得到同一份结果，不会叠加数据。需要“数据也回到过去”时，用备份整体还原，而不是靠一个分不清来源的 `DELETE`。

### 回滚不动的数据

- `file_usages`（一行不删、不改）；
- `shot_details.audio_file_id` / `audio_opt_out` —— 迁移前就存在的用户数据。

## 相关文件

| 关注点 | 位置 |
|---|---|
| 资产声音存储与解析 | `backend/app/services/studio/asset_voices.py` |
| 生成侧声音优先级 | `backend/app/services/studio/video_audio_input.py` |
| 资产声音接口 | `backend/app/api/v1/routes/studio/asset_voices.py` |
| 镜头字段读写属性 | `backend/app/schemas/studio/shots.py` |
| 迁移（MySQL） | `backend/sql/009-add-asset-voice-inheritance.sql`、`backend/sql/rollback/009-add-asset-voice-inheritance.sql` |
| 迁移（SQLite 演练） | `backend/scripts/{_asset_voice_inheritance,migrate_asset_voice_inheritance,rollback_asset_voice_inheritance}.py` |
| 第 2 步绑定入口 | `front/src/pages/aiStudio/project/ProjectWorkbench/components/workbench/VoiceBindingSection.tsx` |
| 第 4 步只读面板 | `front/src/pages/aiStudio/chapter/components/ShotVoiceInheritancePanel.tsx` |
| 本镜无需声音开关 | `front/src/pages/aiStudio/shots/components/ShotAudioOptOutSwitch.tsx` |

## 验证命令

```bash
# 后端相关测试
cd backend && JELLYFISH_DRY_RUN=1 .venv/bin/python -m pytest -q \
  tests/test_shot_voice_source_of_truth.py \
  tests/test_asset_voice_carry_to_video.py \
  tests/test_audio_opt_out.py \
  tests/test_asset_voice_inheritance_migration.py \
  tests/test_shot_voice_inheritance.py

# 迁移往返与幂等（SQLite 演练版；先 --check 确认只读）
cd backend && .venv/bin/python scripts/migrate_asset_voice_inheritance.py --db <临时库> --check
cd backend && .venv/bin/python scripts/migrate_asset_voice_inheritance.py --db <临时库>
cd backend && .venv/bin/python scripts/rollback_asset_voice_inheritance.py --db <临时库> --check
cd backend && .venv/bin/python scripts/rollback_asset_voice_inheritance.py --db <临时库>

# 前端
cd front && pnpm test && pnpm typecheck && pnpm build
```

> 迁移演练只允许使用仓库外的临时库或正式库副本；不要对正式库执行迁移或回滚。
