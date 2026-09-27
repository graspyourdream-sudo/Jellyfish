---
title: "剧情广告完整闭环（实施契约）"
description: "剧情广告项目的类型、商品卡、分层剧情、确认落库与接入五步流程的接口与数据契约（实施中，供本轮实现与验收对齐）"
weight: 11
---

> 本文是**实施契约**：本轮所有实现与验收以本文为准。落地后把"已生效规则"沉淀到 `architecture`，本文收口。

## 目标流程（页面即用户流程）

```
新建剧情广告项目 → 商品卡（持久化 + 自动提取）→ 分层剧情（一句话→完整剧情→分镜）
   → 人工审核修改 → 确认策划（幂等落库）→ 一键进入第 2 步资产准备
   → 第 3 步整集视频提示词 → 第 4 步资产与声音绑定 → 第 5 步生成与交付
```

每一步页面必须给出：**当前结果是什么、下一步是什么、一键进入下一步**。

## 隔离（本轮固定）

| 项 | 值 |
|---|---|
| worktree / 分支 | `/Users/apple/Documents/jellyfish-ad-mvp` · `feat/drama-ad-mvp`（基线 `df33a33`） |
| 数据库 | `/tmp/jellyfish-ad-mvp/db/ad_mvp.db`（**临时库**，绝不动 `Jellyfish/backend/jellyfish.db`） |
| 端口 | 后端 `8123` · 前端 `5231`（⚠️ **8100 已被另一个 worktree `jellyfish-flow` 的后端占用**，不要再选它） |
| 默认模式 | `JELLYFISH_DRY_RUN=1`（真实调用需授权后显式打开） |

## 一、数据契约（迁移新增，全部带 check/backup/rollback/幂等）

### 1. `projects.kind`（新列）

`String(16) NOT NULL DEFAULT 'drama'`，取值 `drama` / `ad`。
列表与详情都下发它，页面据此显示「剧情广告」徽标并进入策划页。

### 2. `product_cards`（新表，项目级 1:1）

| 列 | 类型 | 说明 |
|---|---|---|
| `project_id` | String(64) PK, FK projects CASCADE | 一项目一张卡 |
| `name` / `category` / `brand` | String(255) | 商品名称 / 品类 / 品牌 |
| `selling_points` / `scenarios` | JSON list | 核心卖点 / 使用场景 |
| `audience` | Text | 目标人群 |
| `price_info` | Text | 价格或促销信息 |
| `compliance` | Text | 禁止表达 / 合规要求 |
| `notes` | Text | 用户补充说明 |
| `reference_files` | JSON list | 商品图片/参考资料：`[{file_id, name, kind}]` |
| `source_type` | String(16) | `manual` / `paste` / `upload` / `existing` |
| `source_summary` | JSON | **技术详情用**：来源文件名、原文字数、提取时间、使用的模型 |
| `missing_fields` | JSON list | 提取后仍缺的字段（页面显示「待补充」，**不编造**） |
| `confirmed` | Boolean | 用户是否已确认商品卡（未确认不允许生成剧情） |
| `updated_at` | DateTime | 最后更新时间（技术详情展示） |

### 3. `drama_plan_drafts`（既有表加列）

| 新列 | 说明 |
|---|---|
| `story_status` | `none` / `draft` / `confirmed`（策划确认状态；与既有 `status`（生成状态）分工不同） |
| `stale_flags` | JSON：`{one_liner_changed_at, story_changed_at, story_stale, shots_stale, reasons[]}` |
| `manual_edited_at` | 最近一次人工编辑时间（生成前若晚于上次生成时间，必须显式确认覆盖） |
| `confirmed_at` / `materialized_at` | 确认与落库时间 |
| `materialize_summary` | JSON：落库统计（镜头数/资产数/关联行/跳过项），供幂等复核与页面回显 |

### 4. `drama_plan_materials`（新表，来源关系）

| 列 | 说明 |
|---|---|
| `id` Integer PK | |
| `project_id` / `chapter_id` | 归属 |
| `entity_type` | `character` / `scene` / `prop` / `costume` / `product` |
| `entity_id` | 落库后的资产 ID |
| `source` | `plan`（来自策划确认）/ `manual` |
| `created_at` | |

用途：① 确认幂等（重复确认查得到既有实体，不重复创建）；② 追溯（商品/人物/场景都能回指策划与商品卡）。

### 5. `products`（既有表加列）

`provenance` JSON：`{source: "drama_plan", project_id, chapter_id, card_updated_at}` —— 商品资产可回指商品卡与策划。

## 二、接口契约

### 项目

| 方法 | 路径 | 出口 | 说明 |
|---|---|---|---|
| POST | `/studio/projects` | 免费 | 请求体新增 `kind`（`drama`/`ad`）；`kind=ad` 时**同一事务**建默认章节 + 空商品卡，响应带 `chapter_id` 与 `kind` |
| GET | `/studio/projects` | 免费 | `items[]` 新增 `kind`、`ad_phase`（见下） |

`ad_phase`（后端派生，用于"刷新回到正确阶段"与列表提示）：
`product`（商品卡未确认）→ `story`（无完整剧情或无分镜）→ `ready`（可确认策划）→ `confirmed`（已落库）→ `production`（已进入资产准备之后）。

### 商品卡

| 方法 | 路径 | 出口 | 说明 |
|---|---|---|---|
| GET | `/studio/projects/{pid}/product-card` | 免费 | 返回卡 + `missing_fields` + `source_summary` |
| PUT | `/studio/projects/{pid}/product-card` | 免费 | 保存（含 `confirmed`）；`confirmed=true` 时校验必填（名称）并清空对应 `missing_fields` |
| POST | `/studio/projects/{pid}/product-card/extract` | **付费 1 次** | 请求 `{source_type, text?, file_ids?, existing_product_id?}` → 返回结构化字段 + `missing_fields` + `source_summary`；**不落库、不生成剧情**，由用户确认后走 PUT |

### 剧情（分层，按阶段生成）

| 方法 | 路径 | 出口 | 说明 |
|---|---|---|---|
| GET | `/studio/chapters/{cid}/drama-plan` | 免费 | 草稿 + 商品卡 + 分层剧情 + 分镜 + `stale_flags` + `consistency` + `ad_phase` |
| POST | `/studio/chapters/{cid}/drama-plan/generate` | **付费 1 次** | 请求 `{stage: "one_liner"｜"story"｜"storyboard"｜"all", confirm_overwrite?: bool}`。stage 语义：`one_liner` 出核心创意+受众情绪；`story` 必须基于**已确认的一句话**出完整剧情（钩子/冲突/商品介入/高潮/结尾引导）；`storyboard` 必须基于**当前完整剧情**出分镜；`all` 一次出全部（兼容旧行为）。**人工编辑晚于上次生成时必须 `confirm_overwrite=true`，否则 409** |
| PUT | `/studio/chapters/{cid}/drama-plan/draft` | 免费 | 保存人工编辑；服务端归一化 + 重算 `stale_flags` + 记 `manual_edited_at` |
| POST | `/studio/chapters/{cid}/drama-plan/consistency` | 免费 | 一致性检查：商品是否在分镜出现且覆盖 ≥ 一半、主要人物是否都在人物表、核心冲突/结局是否与分镜对应、分镜是否引用未知资产或未知角色 |
| POST | `/studio/chapters/{cid}/drama-plan/confirm` | 免费 | 幂等落库（见下），返回统计 + `next_step`（第 2 步 URL） |

### `plan` JSON 结构（服务端事实来源）

```
{
  "one_liner": str, "audience_emotion": str,
  "characters": [{name, relation, profile{}}],
  "scenes":     [{name, profile{}}],
  "product":    {name, description, profile{}} | null,
  "story": {full_text, hook, conflict, product_usage, climax, cta},
  "shots": [...既有结构...],
  "warnings": [str]
}
```

## 三、确认落库（幂等）

1. 章节：写入 `chapters.title/summary/raw_text`（`raw_text` = 完整剧情全文）与 `storyboard_count`；
2. 镜头：章节**已有镜头**时不再新建，改为按 `drama_plan_materials` 里记录的镜头更新（幂等：重复确认不重复建）；
3. 资产：角色/场景/道具/服装/**商品**都落成正式资产，并写 `drama_plan_materials` 行；商品额外写 `products.provenance`；
4. 关联：商品按 `product_present` 建 shot 档 `project_product_links`；角色建 `shot_character_links`；
5. 返回：`{shots_created, shots_updated, assets_created, materials_linked, shot_product_links, skipped[], warnings[], next_step:{label:"继续准备资产", url:"/projects/{pid}?step=extract_assets"}}`；
6. 幂等：第二次确认不得新增任何镜头/资产（测试断言行数不变）。

## 四、页面结构（剧情策划页）

1. **商品信息卡**（顶部）：字段表单 + 「从资料提取」入口（粘贴/上传/选已有）+ 缺项标「待补充」+ 「确认商品卡」；
2. **剧情策划**：一句话核心创意 + 受众情绪 → 完整剧情全文（大文本框，可读可编辑）+ 钩子/冲突/商品介入/高潮/结尾引导分栏；
3. **资产预览**：人物（含关系）/场景/道具/商品，卡片式；
4. **分镜卡片**：每镜一张卡（标题/出场角色/时长/景别/机位/运镜/动作/台词/是否出现商品），枚举显示中文；
5. **底部唯一主要操作**：`确认策划` → 确认后变为 `继续准备资产`（跳第 2 步）。

其它：未保存改动提示（脏标记 + 离开拦截）；过期提示（一句话改过 → 详细剧情可能过期；完整剧情改过 → 分镜可能过期）；重生成需二次确认；技术详情默认收起（ID/枚举原文/接口名/数据库字段/来源与更新时间）。

## 六、S5 必改清单（只读勘察所得，含两个**会崩**的缺口）

商品在「第 2–5 步」的接入面不是均匀的：读取侧大体已通，但下面这些点必须改，否则验收第 10/11 步过不去。

**会崩（优先级最高）**

1. `services/studio/chapter_asset_profile_confirm.py:73-77` `LINK_MODEL_BY_TYPE` 与 `:89-95` `_link_model_for` **都没有 product**，
   而 `:375` 的类型闸用的是含 product 的 `ASSET_TYPES` → 商品确认项走到 `:641-650` 会 **`KeyError: 'product'`**。
2. `services/studio/entity_crud.py:217-228` 带 `shot_id` 新建资产会调 `mark_linked_by_name(candidate_type='product')`，
   而 `models/types.py` 的 `ShotCandidateType` 没有 product、`shot_extracted_candidates.py` 直接用它构造 → **`ValueError`**（已实机验证枚举行为）。

**不崩但会让验收第 11 步失败**

3. `services/studio/project_asset_readiness.py:57` 的 `ASSET_TYPES` **只有四类**、`:79-83` `link_models` 也没有 product
   → 商品**不进第 2 步的 readiness 清单**（而 `schemas/studio/assets.py:150` 的 Literal 已放宽到五类，service 没跟上）。
4. `services/studio/shot_assets.py:156-280` `list_shot_linked_assets` 不读 `ProjectProductLink`
   → 连带 `shot_assets_overview.py:49` 与 `shot_video_prompt_pack.py:404+` 都看不到已绑定的商品。
5. `services/studio/prompt_delivery.py:154-160/186-189` 的绑定槽位与名字段是四类硬编码（**同文件的实际文件段已含商品**，两段口径不一致）。
6. `services/studio/llm_orchestration/asset_binding.py` 全篇四槽范式 → **LLM 自动绑定永远看不到商品**。

**明确"刻意拒绝"、按契约**不改**的**

- `services/studio/external_image_client.py:35` 上游出图服务只接受 character/scene/prop（另一个项目，只读）；
- `services/studio/asset_voices.py:64-67` 与 `video_audio_input.py:355-363`：商品**没有**资产级声音绑定（代码注释写明是刻意的）。
  出图侧（`asset_strategies` / `asset_prompt_batch` / `image_tasks` / `task_manager.stores`）按本批边界**保持不动**，
  商品图在 MVP 里由用户手动上传 + 手动定版（`/studio/entities/product/{id}/images` 这条已通）。

**测试红线（改类型时会被钉住）**：`test_project_asset_readiness.py:281-292`（断言四类与四桶）、
`test_asset_type_dispatch.py:233`、`test_prop_image_prompt_slots.py:119`、`test_costume_production_chain.py:428/694`、
`test_llm_orchestration_asset_binding.py:448`、`test_image_task_services.py:127`（字符串精确相等）、
`test_asset_voice_binding.py:211-216`（**商品必须被拒**）、`test_asset_workbench.py:314-323`。
`tests/test_drama_plan_product_read_side.py:358` 那条"商品不进文本提示词"的源码断言**继续保持**（本批不改成进文本）。

## 七、浏览器验收工具（已建立并验证）

仓库里没有任何浏览器自动化依赖，历史脚本也已丢失。验收用自建 CDP 驱动：`tools/cdp.py`
（Chrome 153 + venv 自带 `websockets`，**零新依赖**）：

- 视口固定 **1440×900**（`Emulation.setDeviceMetricsOverride`），截图为浏览器真实渲染尺寸；
- 点击用**真实输入事件** `Input.dispatchMouseEvent`（不是 `element.click()`，避免绕过命中测试）；
- 记录控制台与页面异常，可核"0 个 JS 错误"；
- 已实测：打开 `/projects` → 截图 → 真实点击「新建项目」→ 弹窗出现 → 截图，视口 `[1440, 900, 1]`、**0 JS 错误**。

隔离端口：后端 **8123**、前端 **5231**（`CORS_ORIGINS` 与 `VITE_BACKEND_URL` 已按此配置）。
⚠️ 端口纪律：本机 **8100 已被另一个 worktree（`jellyfish-flow`）的后端占用**，不要再选它。

| 切片 | 归属 | 文件范围 |
|---|---|---|
| S1 模型+迁移+项目类型+商品卡 CRUD | 主线 | `backend/app/models/*`、`backend/scripts/*`、`backend/tests/test_*product_card*`、`schemas/studio/product_card.py`、`routes/studio/product_card*.py`、`schemas/studio/projects.py`、`routes/studio/projects.py` |
| S2 商品资料提取 + 文件解析 | 子线 A | `backend/app/services/studio/product_extraction.py`、`backend/app/services/studio/doc_text.py`、对应测试 |
| S3 分层剧情 + 过期 + 一致性 | 子线 B | `backend/app/services/studio/llm_orchestration/drama_story.py`、`drama_plan.py`（只加不改语义）、`prompt_templates.py`、对应测试 |
| S4 幂等落库 + materials | 主线 | `backend/app/services/studio/drama_plan_materialize.py`、`drama_plan_service.py` |
| S5 第 2-5 步识别商品 | 子线 C | `asset_workbench.py`、`project_asset_readiness.py`、`prompt_board.py`、`shot_video_prompt_pack.py`、`bound_asset_files.py`、`image_pipeline/*` 读取侧 |
| S6 策划页重建 | 子线 D | `front/src/pages/aiStudio/dramaPlan/**`、`front/src/services/dramaPlanApi.ts` |
| S7 项目类型/向导/列表/入口 | 子线 E | `front/src/pages/aiStudio/project/ProjectLobby.tsx`、`ProjectWorkbench/**`、`front/src/services/*project*` |
| S8 浏览器验收（CDP 真实点击 + 截图） | 主线 | `tools/browser_acceptance*.py`、`docs/acceptance/drama-ad/*.png` |
