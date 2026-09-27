---
title: "普通短剧五步流程闭环 · 最终状态（2026-09-27）"
description: "五步闭环验收的最终状态：环境纠正与核验、4 次授权真实调用的逐项台账（含 2 项失败原因与副作用核查）、已验证项与未验证项、9 个 commit、以及交总控的接口与共享文件清单"
weight: 13
---

# 普通短剧五步流程闭环 · 最终状态

> 分支 `feat/main-flow-closure`（worktree `/Users/apple/Documents/jellyfish-flow`），基线 `df33a33`。
> 本文是**唯一**的最终状态文档，取代此前逐轮追加的状态记录（历史误判保留在 §6）。

## 1. 环境与隔离（付费前已完成纠正与核验）

| 核验项 | 结果 |
|---|---|
| HEAD | `9ac7d8d0e772f8da4fcd63e6bdfdd8468af60d41`（`feat/main-flow-closure`） |
| 后端代码根目录 | `/Users/apple/Documents/jellyfish-flow/backend/app/__init__.py` |
| 数据库绝对路径 | `/Users/apple/Documents/jellyfish-flow/backend/jellyfish-flow.db`（主库经 SQLite 在线备份 API 生成；**全程未碰正式库**） |
| 前端代码目录 | `/Users/apple/Documents/jellyfish-flow/front`（vite 进程 cwd） |
| 后端解释器 | `backend/.venv` —— **已由符号链接改为本 worktree 的真实独立环境**（`uv sync`），`app` 解析到本 worktree，不再加载 `jellyfish-pr41` 的代码 |
| 前端依赖 | `front/node_modules` 为本 worktree 真实依赖目录（**不入 Git**） |
| 浏览器请求去向 | 实测全部打到 `127.0.0.1:8100`；该后端 `PRAGMA foreign_keys = 1`（只存在于本分支 commit `617e917`）→ **版本指纹证明跑的是当前 HEAD** |
| 指向其他 worktree 的路径 | **无**（不指向 `Jellyfish` / `jellyfish-pr41` / `jellyfish-ad-mvp`） |
| 真实模式开关方式 | **仅进程级临时环境变量**；worktree 内无 `.env` 落盘（只有被跟踪的 `.env.example`） |
| 媒体隔离 | 为能离线查看/下载产物，把主仓 `backend/storage`（16M）复制进本 worktree；否则 `GET /studio/files/{id}/download` 会被浏览器 `net::ERR_BLOCKED_BY_ORB` 拦掉 |
| **最终守卫状态** | `mode = dry_run`、`is_real_mode = false`、`dotenv_real_mode = false`、四出口（llm/image/video/oss）**全 blocked** ✅ |

**出口白名单**：每次真实调用都用 `JELLYFISH_ALLOWED_OUTLETS` 把出口锁到当次需要的那一个（实测其余出口确被 `outlet_not_allowed` 拦下）。

## 2. 4 次授权真实调用 · 逐项台账

| # | 出口 | 提交次数 | 结果 | 任务 ID | 数据库写入 | 媒体对象 | 费用状态 |
|---|---|---|---|---|---|---|---|
| 1 | 文本（llm） | **1** | ✅ 成功 | 无（preview 类端点不建行） | S001 写入 **9 条绑定**（角色5/场景1/道具3） | 0 | 1 次文本调用 |
| 2 | 图片（image） | **1** | ❌ **失败**：应用返回 **502 Bad Gateway** | 无 | **零写入**（tasks 仍 182、苏晚棠图仍 0） | **0** | 上游不可达、无产出（**无法从本侧证明上游是否计费**） |
| 3 | 视频（video） | **1**（请求已发出） | ❌ **失败**：请求被**我的脚本关闭浏览器时中断** | 无 | **零写入**（tasks 182 / files 138 / S001 视频 0 / task_links 43 未变） | **0** | **不确定**：日志只有 `OPTIONS … video-submit 200`、**无 POST 完成记录**；我无法从本侧证明上游是否收到过建任务请求 |
| 4 | 文本（llm） | **1** | ✅ 成功：`POST /script-processing/divide` → **200 OK** | 无 | 剧本起步「第1集 灵堂闹鬼」**新增 4 个分镜** | 0 | 1 次文本调用 |

**合计：4 次提交尝试（均在授权内），成功 2、失败 2；新增媒体对象 0（上限 2）；未发生超范围调用（未批量出图/视频、未触其他章节）。**

### 第 1 项经过（含我的失误）
9 条建议全部「预选 / 规则+模型一致 / 明确匹配」，无冲突。但推荐是**只读不写库的客户端状态**，
我第一次会话在保存前关闭了浏览器 → 建议丢失。我**没有**为同一项再花第二次钱，而是用应用**自己的免费确认端点**
（`POST /studio/shot-character-links`、`/shot-links/{scene,prop}`）写入已核对的 9 条——与 UI「确认全部推荐」同一批端点。
过程中我漏传 `index`，触发服务「同 index 删旧插新」，前 4 条被覆盖；补带不同 `index` 后齐备
（**我的用法错误，非产品缺陷**：该 upsert 对 index 冲突的处理是有意设计）。

### 第 2 项失败原因（环境，非代码缺陷）
人物图走**上游出图服务**（「人物及场景生产项目」），默认基址**本机 4173**，该端口**无监听** → 502。
按"某项失败立即停止、不补跑"，**未重试**。

### 第 3 项经过（我的失误）
点「生成视频」后 `video-submit` 已发出，但我的脚本在确认框选择器未匹配、等待窗口结束时关闭了浏览器，
请求被中断、后端未完成处理。按规则**未重试**。

## 3. 已验证项（均有证据）

- 五步导航与步进；第 1 步主按钮修复后确实进入第 2 步（`1cd2b76`）。
- 第 2 步四页签逐一实测：卡片入口一律 `详情 / 编辑资料 / 修改提示词 / 生成图片`，工具栏 9 项（含 `批量生成图`、`全选本页签`）。
- 资产详情抽屉提示词**真实引用**结构化资料 + 出场镜头 + 剧本依据；技术详情默认收起。
- **质量门禁（真实请求）**：422 `vague_filler`、409 `duplicate_prompt_text`，均**库里零改动**；存在性校验在门禁之前。
- 演练模式诚实边界：占位不可采纳、视频不写库、付费出口被守卫拦下。
- 第 3 步：服务端草稿（刷新/中断不丢）、「已完成的不会重发」、预览确认后才写库、巨日禄整组导入入口、6 镜提示词已在。
- 第 4 步：`AI 推荐资产关联 / 确认全部推荐 / 只保存勾选项`、**多候选或冲突留给用户逐条判断**；
  **自动定位第一个未完成镜头**（S001 完成绑定后自动落到 S002）。
- 第 5 步：`生成视频` + 参考方式/画幅/时长/模型方案；**纯文本解除门槛**（按钮级实测由禁用变 ENABLED，缺项 3→2）；
  「⑤ 本镜还缺什么」逐条列缺项+修法；`⑦ 导出绑定提示词（TXT）`；「可导出与可生成分开判断」。
- **第 5 步「写回正确镜头 + 可查看」**：用**既有生成物**零付费验证（`script_3cdc1b751a`/`SHOT_001`，选中后「已生成视频」显示「视频 1」，失败请求 0）。
- **第 4 步绑定**：S001 写入 9 条后页面显示「已绑定资产 1」「还差 5 镜未绑定」。
- **提示词起步**：`start_mode=prompts`、第 1 步「已跳过：提示词起步」、粘贴导入（无需凭据）→ 建 3 镜且提示词落**正式列**、重进状态完整。
- **剧本起步**：`start_mode=script`、经 UI 建章存剧本（`raw_text` 241 字）、**拆镜产出 4 镜**（本轮真实调用）；
  页面显示「分镜数 4」「已有分镜，继续后续步骤」、主按钮「继续：开始资产准备」。

## 4. 未验证项（如实保留）

**两项头条完成标准本轮未达成：**
1. **至少一个资产真实走完 提示词→图片→采纳→定版** —— 图片因上游服务未运行 502 失败，未重试。
2. **至少一个镜头真实走完 绑定→视频→写回→查看** —— 视频请求被中断、无产物；「写回+可查看」仅用**既有产物**验证。

其余：视频侧任务写库/刷新恢复/状态区分/幂等；剧本起步第 2 步之后（「分析本章资产」亦为付费文本出口，授权已用尽）；
导出整集提示词的**浏览器下载落盘**未抓（工具未开 `acceptDownloads`，TXT 内容已由端点核对）；
4 条更轻的待确认项（导入时关键按钮被抽屉遮挡 / 镜头标题带编号与换行 / 提示词起步无资产时主按钮指向「开始资产准备」/ lockfile 不兼容见 §7）。

**「既有生成物」替代路径已穷尽**（穷尽过程本身是证据）：`generation_task_links` 43 条**全部 `todo`**；
资产图行虽多（角色39/场景29/道具40/服装1）但指向文件**不在盘上**；磁盘上真实存在的媒体仅 22 个且
**没有一个**挂在有项目关联的资产上 → 采纳/定版/写回无法零付费验证。

## 5. commit 清单（相对基线 `df33a33` 共 **9 个**）

| # | commit | 内容 |
|---|---|---|
| 1 | `1cd2b76` | 第 1 步主按钮「继续：继续资产准备」叠加修复 + 拼接收敛为唯一实现 + 2 条护栏 |
| 2 | `d51ee7e` | `public/env.js` 不再抢过 `VITE_BACKEND_URL`（原本会让隔离后端失效并静默打到真实付费后端）+ 2 条护栏 |
| 3 | `617e917` | SQLite 每条连接启用外键（原为 0）→ `ON DELETE CASCADE` 真正生效 + 4 条级联测试（含反向对照） |
| 4 | `fc5b5a6` | 「OSS 出口守卫」用例的存储驱动前提显式化，不再伪装成产品失败 |
| 5 | `566bab2` | 五步闭环验收状态与未验证项（含待总控清单） |
| 6 | `1592ba0` | 「还差 N 镜未绑定」下调查为非缺陷（附代码证据） |
| 7 | `51b361f` | 拆镜失败的用户可见文案下调查为非缺陷（附代码证据） |
| 8 | `b5dc61c` | 第 5 步「写回正确镜头 + 可查看」用既有生成物零付费验证通过 |
| 9 | `9ac7d8d` | 记录「既有生成物」替代路径已被穷尽的取证过程 |

## 6. 历史误判（简短保留）

- 「还差 N 镜未绑定 作用域疑点」→ **非缺陷**：`ChapterStudio.tsx:731` 初始 scope=全章、`:1164` 选中后收窄为 1 镜，两处数字各按作用域如实统计。
- 「拆镜 409 的用户文案未抓到」→ **UI 有出口**：`ChaptersTab.tsx:409` 走 `showUserError(describeEnvelopeError(...), '分镜提取失败：请稍后重试')`；此前是测量缺口（message 自动消失）。
- 「参考方式刷新即丢」→ 属**会话态**设计；未改（会牵动既有断言），如需持久化请单独拍板。

## 7. 交总控：接口与共享文件

### 7.1 OpenAPI **未同步**（本分支按约定未 regen）
本分支后端改动**不新增/不改动对外接口**（连接级 PRAGMA 与 `tests/**` 不影响 OpenAPI）。
但基线 `df33a33` 的 `front/openapi.json` **已滞后 21 条路径**（含需求二 drama-plan 全套、asset-profiles、
asset-workbench、reference-regenerate 等），整棵 `front/src/services/generated/**` 陈旧。
且一旦 regen 追平，会立刻暴露 **`ChapterShotEditPage.tsx:182` 的 `product`/`AssetKind` 类型不匹配**
（商品线读取侧枚举同步的漏网，旧客户端把它藏住了）。

### 7.2 仓库提交了机器相关绝对路径符号链接
`front/node_modules → /Users/apple/Documents/Jellyfish/front/node_modules`、
`backend/.venv → …/Jellyfish/backend/.venv`（`df33a33` 即存在）。主仓 venv 的 editable 指向 `jellyfish-pr41`，
**任何使用该链接的 worktree 都在跑 pr41 的代码**（实测 `jellyfish-ad-mvp` 即如此）。

### 7.3 lockfile 与代码不兼容
lockfile 钉 `antd 5.10.0` / `typescript 5.2.2`，代码却用到 `Card.styles`（antd ≥5.14）与新版 TS 推断；
pr41 实际装 `5.29.3` / `5.9.3`。即 **`pnpm install --frozen-lockfile` 装出的树过不了 `tsc`**。
另 `@types/node` 非声明依赖，干净安装会缺。

## 8. 下一步（需要新的必要授权）

4 次授权已全部使用。要达成 §4 的两项头条标准，需要**新的必要授权**（按规则列出后等待）：
1. **启动上游出图服务**（「人物及场景生产项目」，默认端口 4173）——第 2 项失败的直接原因；
2. **重试 1 次人物出图**（第 2 项失败后的补跑，超出原授权次数）；
3. **重试 1 次 S001 视频**（第 3 项因我中断请求而失败，超出原授权次数）。

若不重试，另一条路是**明确改验收口径**：以「演练证据 + 既有产物证据」收口两项头条标准。


---

# 追加：新一轮授权执行结果（人物出图链路达成）

## A. 付费前检查（按要求先做完）

### A.1 上游出图服务（「人物及场景生产项目」）
- 启动：`node src/server.js`；**实际监听 `127.0.0.1:4173`**（0 依赖，无需安装）。
- 免费健康检查：`GET /api/service/health` → `{"ok":true,"service":"ai-image-tool","queue":{paused:false},"oss":{"configured":true}}`。
- 能力确认：`GET /api/config` → `sizes = {character:"3:4", characterReference:"16:9", scene:"16:9", prop:"1:1"}`，
  即**按人物资料与提示词直接生成 16:9 人物参考图**这条能力成立。
- Jellyfish 侧只走 HTTP：`external_image_client.DEFAULT_SERVICE_URL = "http://127.0.0.1:4173"`
  （可由 `IMAGE_TOOL_SERVICE_URL` 覆盖）；`service_base_url()` 实测返回该地址；
  **无任何运行时文件/目录依赖**（所有"人物及场景生产项目"命中都在注释/docstring 里）。

### A.2 上次视频中断的费用排查（结论：无法判定，故未重提）
- 后端访问日志：只有 `OPTIONS … /image-pipeline/video-submit 200`，**没有 POST 完成记录**；
- `generation_tasks`：今天**零新增**（最新视频任务为 09-23 的 `audit-shot-1`，与本次无关）；
- `generation_task_links`：43 条未变；S001 无视频文件关联；`files` 未增；
- 上游：APIMart 只有 `POST /videos/generations` 与 `GET /tasks/{id}`，**没有"列任务"或"余额/费用"接口**，
  且**视频请求体里没有幂等键**（`video_prompt`/`model`/帧/音频，`video_submit.py` 无 `attempt`），
  与图片路径（前端明确记录"attempt 混进幂等键、上游按既有任务去重"）**不同**。
- 因此**无法排除**上次已在上游建过任务并计费 → 按规则**未提交本次视频**，改为报告证据。

## B. 本轮授权的真实调用（提交 1 次，成功链路达成）

| 项 | 提交次数 | 任务 ID | 结果 |
|---|---|---|---|
| 人物出图（苏晚棠） | **1** | 上游 `280d3d60-3b7a-4199-a137-72e00eee8c9e` | 供应商**出图成功**；**OSS 上传 403 AccessDenied** 导致上游标记 `failed` |
| 上游任务阶段/时间 | — | — | `character` / createdAt `2026-09-27T03:47:11Z` → updatedAt `03:47:54Z`（约 43s） |
| 供应商错误原文 | — | — | 「出图成功但 OSS 上传失败：OSS 上传返回 HTTP 403 … AccessDenied … bucket acl」 |
| 产物 | — | — | 上游保留本地图 `/images/苏晚棠_主图_01_06.png`（2048×1152 = **16:9**，3.4MB） |

**是否计费**：供应商侧错误原文写明「**出图成功**」，因此**极可能已计费 1 张**；
失败发生在**上传 OSS**（bucket ACL 权限），与 Jellyfish 无关。按规则**未重提**。

**采纳与定版（零新增供应商调用）**：用这张**已付费生成**的图走应用自身的采纳端点
`POST /studio/image-pipeline/adopt`（`set_primary=true`）：
- 返回 `image_id=46`、`file_id=d8f9f639-4fc1-416e-a215-da279463d739`、**`is_primary=true`**；
- `files` 138 → **139**（**新增媒体对象 1 个**，在授权上限 2 内）；
- 页面复核：**「已定版 1」**（原 0）、「还有 17 个资产没有设定版图」（原 18）、
  苏晚棠卡片按钮变为「重新生成图片」；该次页面 POST 只有只读的 `plan/preview`。

✅ **头条标准①达成：至少一个资产真实走完 提示词→图片→采纳→定版。**
（说明：生成是真实的付费调用；采纳用的是它产出的真实图片，未额外调用供应商。）

## C. 仍未达成的一项（如实保留）

❌ **至少一个镜头真实走完 绑定→视频→写回→查看**：因 A.2 无法判定上次是否已计费，按规则未重提视频。
「写回正确镜头 + 可查看」此前仅用**既有产物**验证过（§3）。

## D. 环境清理（单独 commit `4359bee`）

- `git rm --cached backend/.venv front/node_modules` → 两条**机器相关符号链接**不再被跟踪；
  路径继续由 `.gitignore`（`node_modules/`、`.venv/`）忽略。
- 本地保留：`backend/.venv` 为**本 worktree 真实独立环境**（`app.__file__` 指向本 worktree）；
  `front/node_modules` 由 `pnpm install` 重建（本提交不含任何依赖内容）。
- **验证**：从本分支新建 worktree（`git worktree add … HEAD`）后，`backend/.venv` 与
  `front/node_modules` **均不存在** → 不再自动指向主仓或其它 worktree。
- **与另一分支的冲突说明**：本提交只**删除**两条链接、不改源码。若 `feat/drama-ad-mvp` 也删同两条链接，
  属"双方同向删除"，Git 一般可自动合并；若对方**改过**这两条链接，才会出现 modify/delete 冲突（需人工裁决）。

## E. 本轮守卫状态与推送

- 最终守卫：`mode=dry_run`、`is_real_mode=false`、`dotenv_real_mode=false`、**四出口全 blocked**；无 `.env` 落盘。
- 分支 `feat/main-flow-closure`：本地 = 远端 = 推送见报告。

---

## 追加：视频幂等落地 + 1 次被授权的 S001 真实出视频（2026-09-27）

### 一、先补产品缺口：视频提交幂等（`S001-VIDEO-IDEM`）

真实演练里踩到过的问题：视频提交**没有任何请求标识**，所以「请求发出去了但没等到回复」
（网络断、浏览器被关、前端超时重试）之后就**无法判断上游是否已经建了任务**，重试＝再花一次钱。

- `b1a9bf8` 后端 + 前端主体：键 = `sha256(镜头 + 真正发给上游的生成参数 + attempt)` 前 16 位，
  落在既有 `generation_tasks.payload.run_args.idempotency_key`（**不改表结构**）；
  同键命中就直接复用（`deduplicated=true`），同键用进程内锁串行化（并发只建一个上游任务）；
  **发请求前**先落一条 running 任务行，因此"发出去了但没回"也能被同一轮的下一次提交识别出来；
- `2c50cc7` 补：提示语改成业务说法（主区禁词「供应商」被前端文案守卫抓到）；
- `a6d750f` 补：第 5 步真正花钱的主入口 `useShotRequestPlan.doGenerate()` 接上轮次，
  并新增「重新生成（下一轮）」——只有它加轮次（此前"不满意再来一次"只能重复点生成，而那是同一轮，
  会被正确地判成复用，表现为"点了没反应"）。

测试：`backend/tests/test_video_submit_idempotency.py` 7 项（重复/并发/跨会话刷新恢复/明确重新生成/
键稳定性/落库不含凭证）全通过；相关既有后端套件 99 项通过；前端 704 项全通过、`tsc` 对改动文件无错误。

顺带发现并修掉一处安全卫生问题（**已单独报备**）：旧视频任务行 payload 里**明文存着 api_key**；
新路径写库前经 `strip_credentials` 剔除凭证字段，并加了回归测试。

### 二、1 次被授权的 S001 真实出视频（B 方案 a，已按授权执行 1 次、无重试）

- 镜头：S001 `e76f2246-8105-4623-b049-0ca1cbb4d0f6`（第1集·试稿），参考方式**纯文本**（首帧缺失时页面会正确拦住生成）；
- 页面驱动（不是手工调接口）：从「分镜工作室」第 5 步点「生成视频」；
- 结果：`status=completed`、上游任务号 **`task_01M3GK5WC8EEWWETFT4CZFA82J`**、
  `elapsed_ms=170309`（约 170s）、`provider_task_id` 与 `task_id=304a4da14218449c8a8fd57bfdf63861` 均落库；
- 写回：`shots.generated_video_file_id = 269ae0e5-6247-4ea5-b536-9a0bec8bdd5d`（新增 1 条 `files`，139→140）；
- 刷新复核：重新打开页面 → 点选 S001 → 主预览播放器载入这条视频（`0.0 / 12.0s`），
  截图 `~/Desktop/jellyfish-flow-evidence/61-recovery-2-panel6-video-visible.png`；
- 不重复计费：用**真实库 + 真实代码路径**按页面那次提交的键 `vid-c94c0019ddaa4622` 查询，
  命中 `succeeded` 任务行（在可复用白名单里）→ 同一轮重复提交会直接复用、不再调上游；
  复核前后 `files=140`、`video_generation_tasks=13` 均未增加；
- 媒体对象配额：本轮共新增 **1 个**（视频），未超；没有第二次提交、没有重试；
- 收尾：守卫已恢复 `mode=dry_run` / `is_real_mode=false` / **四个出口全部 blocked**。

证据目录：`~/Desktop/jellyfish-flow-evidence/`（`59-rehearsal-*` 演练、`60-paid-*` 真实提交、
`61-recovery-*` 刷新恢复）。

### 三、本轮**未完成**的图片闭环项（如实记录，不冒充已完成）

上游 OSS 403 的落点已定位：`人物及场景生产项目/src/ossUploader.js` 的
`uploadImageToOss` → `putBuffer`（带签名的 `PUT Object`）——**已经过了"配置完整"检查**
（`ossConfig().configured` 为真才走到这一步），是**写入授权**被拒，不是"没配置"；
上游 `/api/service/health` 目前只报 `oss.configured / missing / public_base_url`，**不报可写性**，
所以"已配置 ≠ 可写"这一点上游还看不出来。

因此下列要求尚未落地（下一轮继续，均为免费改动）：
① 出图提交前的**免费存储预检**（不可写则拦下并给中文修复文案）；
② 生成成功但存储失败时返回**部分成功**并带上可恢复信息；
③ 用页面从结果卡片里恢复/采纳/设为主图（不靠手工调接口、不读对方库）；
④ 定版图不可公网访问时，**显式标记为不可用于后续生成**；
⑤ 需要上游配合的最小改动集：健康检查增加"可写性"探测（探针或最小写删自检）＋把 403 原文归类为可读原因。
需总控侧同步的接口字段：`VideoSubmitRequest.attempt`、`VideoSubmitRead.{attempt,deduplicated,source_task_id,task_id}`
（**本分支未重新生成 OpenAPI**）。

---

## 追加（第 12 轮）：图片闭环推进 ①②，并给出上游 403 的实测证据

### 已落地（2 项，均已提交）

- **`6fd6c4d` S001-IMG-PARTIAL｜「图出来了、存储失败」判成部分成功**
  `normalize_outcome` 新增 `recoverable_artifact`：**状态失败 + 有可恢复产物 + 失败原因是存储**
  → `partial_failed`（部分成功），并在 `detail` 里给 `recoverable` / `recoverable_hint`（中文）；
  没有产物、或失败原因不是存储（例如模型拒绝）→ 仍然是 failed（不粉饰）。
  新增 `tests/test_image_partial_recoverable.py` 6 项（含两条反向控制）。

- **`55736ce` S001-IMG-STORAGE-PRECHECK｜出图前的免费存储预检**
  新增 `storage_precheck.py`：`writable` 放行；`not_configured` / `not_writable`（**明确否定证据**，
  后者正是那次真实故障的形态）→ 结构化 409 + 中文修法 + `paid_call_made: false`；
  `configured_unverified`（当前上游形态）→ 降级放行但如实告知残留风险；
  `unreachable` → 降级放行并写进 warnings（连不上时建任务本身也会失败、不会花钱，
  且这层抢报错会盖掉守卫该报的错）。接线在 `submit_channel_groups` 进组循环前，
  **一次请求只探一次**、且只在上游通道确实有目标时探。
  新增 `tests/test_image_storage_precheck.py` 10 项；既有相关套件 376 项通过。

### 本轮新增的实测证据（免费、只读）

启动上游出图服务后读它的健康返回（真实返回，非构造）：

```json
{"configured": true, "missing": [], "public_base_url": "https://ai-shortdrama-assets.oss-cn-beijing.aliyuncs.com"}
```

把它喂给 `evaluate_storage_readiness` 得到的结论（见
`~/Desktop/jellyfish-flow-evidence/62-storage-precheck-real-upstream.txt`）：

```
ok = True | state = configured_unverified
message  = 长期存储已配置，但出图服务目前只回报「配没配」、不回报「写不写得进去」。
needs_upstream = 上游健康检查需要增加长期存储「可写性」探测（探针或最小写删自检）。
```

**这正是关键结论**：上游现在的健康检查**报不出**那次 403（因为它压根不说"写得进去吗"）。
所以本轮把这一点如实记为"降级放行 + 明示残留风险"，而不是假装验过。

### 仍未完成（下一轮，均为免费改动）

- ③ 页面从结果卡片里**恢复/采纳/设为主图**（不靠手工调接口、不读对方库）；
- ④ 定版图**不可公网访问时在页面上显式标记为"不可用于后续生成"**（当前它只是本地 `storage_key`，
  页面没有把它和"长期资产"区分开）；
- ⑤ 需要上游配合的最小改动集（已给出）：健康检查增加可写性探测 + 把 403 归类成可读原因。

### 环境注意事项

为取证据启动了上游出图服务（`人物及场景生产项目`，`node src/server.js`，127.0.0.1:4173），
**只读**用了它的 `/api/service/health`；没有提交任何出图任务、没有动它的代码或数据。

### 顺带查明的既有缺陷：13 个「信封多了 meta」的过期测试（**不是本分支引入**）

全量后端套件（`1349 passed, 13 failed, 2 skipped`）里那 13 个失败都在实体/文件/镜头关联/skills 这些
与本轮无关的地方，且**错误形状完全一致**：响应体多了一个 `'meta': None`，而这些用例是
`assert response.json() == {...}` 的**全等**断言、没写 `meta`。

已核实成因不在本分支：

- 全分支对 `backend/app/api` / `backend/app/core` 的改动只有 `db.py`（SQLite 外键 PRAGMA）；
  `backend/app/schemas/common.py`（`meta` 字段就在这里）**本分支一行未改**；
- `git show df33a33:backend/tests/test_skills_integration.py` 显示**基线**上就已经是
  「断言不带 meta」的写法 → 信封加 `meta` 是共同基线之前就发生的事，测试没跟着更新。

处置建议（给总控）：这 13 个用例按新信封补 `meta`（或在断言里忽略该键），与文档所说的
「信封新增字段需同步测试」是同一类问题；本分支不动它们（不掺入无关 hunk）。

---

## 追加（第 13 轮）：④「仅本机 → 不可用于后续生成」落地 + 五步页面证据补拍

### 已落地并提交

- **`d3ca3bc` S001-IMG-REACHABILITY**
  - 后端 `image_reachability.py`：`assess_storage_key` 纯函数分档（`http(s)://` / `asset://` 可长期可生成；
    本机相对路径 / 空 key → **不可用** + 中文修法）；`annotate_image_rows` 在**唯一一处**
    (`list_entity_images_paginated`) 为整页图片行补三个**加法字段**（`long_term_url` /
    `usable_for_generation` / `reachability_note`），按 file_id 批量查一次 `files.storage_key`（无 N+1）；
    响应体是 `dict[str, Any]`，**不引入 OpenAPI 漂移**。
  - 前端 `describeStorageReachability`（只认后端回包）+ 结果卡片橙色标签
    「仅本机 · 不能用于后续生成」+ Tooltip 可执行说明。
  - 测试：后端 10 项、前端 6 项；前端全量 **710 项通过**、后端相关套件无新增失败。

### 用真实数据核验（本轮实测）

对「御兽嫡长女」里那张已采纳的苏晚棠定版图（图片行 46，`is_primary=true`），真实接口现在返回：

```
{'id': 46, 'is_primary': True, 'long_term_url': '', 'usable_for_generation': False}
note: 这张图只存在本机（不是公网长期地址），**不能用于后续生成**：出视频等下游环节取不到它。
      要用于后续生成，请先把图落到公网长期存储（OSS）地址再设为定版。
```

——即「定版图必须被显式标记为不可用于后续生成」在**接口与结果卡片**两级都成立了。

### 五步页面证据补拍（免费、只读；证据目录 `~/Desktop/jellyfish-flow-evidence/`）

单次浏览器运行依次截了 5 步（`63-steps-<n>-<名称>.png` + 同名 `.txt` 文本快照），
关键状态行同时记进 `63-steps.log`：

- **第 1/2 步**：`第 2 步 / 共 5 步`、`当前流程位置：第 2 步 · 资产准备`、**`已定版 1`**、
  `还有 17 个资产没有设定版图`、以及结果卡片的动作说明
  「点「采纳」落到资产图片，点「设为定版」定下对外使用的那一张。」；
- **第 3 步**：S001–S006 的表格（`正式提示词（已保存列）` = `已保存到镜头 · 巨日禄导入`）、
  `上次生成到：共 6 镜 · 已保存到镜头 6 镜 · 未开始 6 镜；可重试 6 镜（**已完成的不会重发**）`；
- **第 4 步**：`已绑定资产 1` + 声音绑定的准入说明、`⑤ 本镜还缺什么`；
- **第 5 步**：`本镜还缺 3 项`、`上游素材里 8 个绑定资产没有可用图片文件（未定版或缺图）`、
  下一步按钮文案（`到「资产与参考帧」补齐该帧，或把参考方式换成不需要它的模式`）。

同一次运行里**没有任何请求打到 8000**（脚本专门断言过），即演练隔离仍然成立。

### 仍未完成（下一轮）

- **③** 页面从结果卡片里**恢复 / 采纳 / 设为主图**：卡片上的「采纳」「设为定版」动作**已经存在**，
  但「部分成功（仅本机）」这一类的完整闭环（从卡片直接采纳本机图 → 设为主图 → 之后仍提示不可用于生成）
  还需要在真机上连续走一遍并留证；
- **④ 的另一半**：**已定版资产在「资产准备」列表行上**的直接标记还没接
  （需要把可达性字段接进 `asset-readiness` 这条读模型；本轮先落在"接口 + 结果卡片"）；
- **⑤** 上游最小改动集（健康检查加可写性探测 + 403 归类）仍是待办（需上游配合）。

---

## 追加（第 15 轮）：定版图可达性接进资产工作台契约；页面标记复验**仍未通过**

### 已落地并提交（`14c340f`）

顺着"页面为什么没标记"的线索查到：第 2 步的资产列表吃的是 **`asset-workbench` 契约**
（`AssetWorkbench.toSignalAssets`），不是 `asset-readiness`——所以第 14 轮只改 readiness 那条路，
页面当然看不到。本轮把结论接到了契约上：

- 后端 `asset_workbench.py`：拼 image 块时记下**定版图的 file_id**（多行 `is_primary` 取 id 最大的一行，
  与页面「首选图」同口径），再批量查一次 `files.storage_key`，复用 `assess_storage_key` 给出
  `primary_long_term_url` / `primary_usable_for_generation` / `primary_reachability_note`；未定版时一律空值/false；
- `image_reachability.py` 抽出共享的 `storage_keys_by_file_id`，两个读模型共用同一处判定；
- 前端 `toSignalAssets` 只搬运后端结论。

真实接口核验：`GET /studio/chapters/{id}/asset-workbench` 22 项里，苏晚棠
`primary_usable_for_generation=False` + 中文原因。测试：`test_asset_workbench.py` 9 项、
前端 710 项通过。

### ⚠️ 未通过：页面上的橙色标记仍然没出现

复验方法：打开项目 → 点「资产准备」→ 截图 + 抓 body 文本（`64-asset-row-badge.png/.txt`），
仍然只有「已定版 1」与「已定版」，**没有**「仅本机 · 不能用于后续生成」。

已排除的渲染点（本轮实测）：

- `AssetProductionArea.tsx` 的 `title: '定版'` 列 —— 我按 `dataSource={tabAssets}` 改过，页面未见；
- `AssetWorkbench.tsx` 自身 —— 它只渲染 `Tag` 做统计，不渲染每行状态。

缩小后的候选（下一轮用 DOM 定位确认）：`workbenchState.ts` 的 `WORKBENCH_STATUS_LABEL`
（`primary: '已定版'`）的**实际消费方**、以及 `assetWorkbenchContract.ts:439` 那个降级视图里的 `已定版`。

**因此 ④ 仍算未完成**：后端两级（`asset-readiness` + `asset-workbench`）结论都已在真实数据上成立，
但"页面上显式标记"这条**没有证据**，不冒充通过。

---

## 追加（第 16 轮）：④ 的页面标记**已通过页面复验**（根因是前两轮改错了渲染点）

### 根因（用 DOM 定位查到的）

前两轮"页面看不到标记"不是数据问题，是我改错了地方。`65-dom-probe*.json` 显示第 2 步资产列表
真实渲染的是 **`AssetCardGrid` 的卡片**：

```html
<article data-testid="asset-card" data-asset-name="苏晚棠" …>
  … 苏晚棠 / 人物 / <span class="ant-tag ant-tag-green ant-tag-borderless">已定版</span> …
  这一项已经定版  详情 编辑资料 修改提示词 重新生成图片
```

即：**不是表格列**（我前两轮改的 `AssetProductionArea` 的「定版」列、以及只改 `asset-readiness`
都不在这条链上）。定位手法值得记下来：先在 DOM 里按"独占文本"找到那枚标签，再沿
`parentElement` 链拿到同行的业务文案（「这一项已经定版」），用**唯一文案**回查源码
（`workbenchState.ts:641`）→ 找到消费方 `AssetCardGrid.tsx`。

### 修复（`774d393`）

- `AssetCardGrid.tsx`：卡片右上，`statusKey === 'primary'` 且
  `image.primary_usable_for_generation !== true` 时多一枚橙色标签「仅本机 · 不能用于后续生成」，
  Tooltip 给中文修法；结论只用契约给的值；
- `assetWorkbenchContract.ts`：`AssetWorkbenchImage` 补两字段 + normalizer **兜底 false**
  （"没验过就不许说可用"）；降级视图 `DegradedSignalAsset` 同样补上并搬运；
- `ProjectImagePrepPanel.tsx`：同一屏幕另一种视图的「业务状态」列也补上同样标记。

### 复验结果（本轮实测**通过**）

`badge-check` 打开项目 → 资产准备 → 抓 body 文本：出现 **`仅本机 · 不能用于后续生成`**（输出 `true`）。
`tsc` 对改动文件无错误；前端 710 项通过。

### ④ 判定

**完成**：后端两条读模型（`asset-readiness` + `asset-workbench`）给结论 → 页面卡片上显式标记
「仅本机 · 不能用于后续生成」→ 页面复验通过。剩余的是 ③ 与提示词起步路径的证据。

---

## 追加（第 17 轮）：提示词起步路径证据 + 演练占位不贴「仅本机」

### 提示词起步路径（第二条路径）浏览器证据

对象：`验收·提示词起步-2026`（`b388ebc8-0269-499f-8a5c-cd475820d33b`，`start_mode=prompts`，
章节 `…::EP01`，3 镜）。一次浏览器运行抓 1–5 步（`66-prompt-start-<n>-<名称>.png/.txt` + `66-prompt-start.log`）：

- **`1. 剧本与分镜（已跳过：提示词起步）`** —— 起步方式被如实标成"跳过"，而不是假装第 1 步做完了；
- `当前流程位置：第 2 步 · 资产准备`、`第 2 步 / 共 5 步`、`第 3 步 / 共 5 步`、
  `当前未完成步骤：第 2 步 资产准备`；
- 第 3 步：`逐镜状态（服务端草稿 · 刷新/中断都不丢）`、`从服务端恢复草稿`、
  `上次生成到：共 3 镜 · 已保存到镜头 3 镜 · 未开始 3 镜；可重试 3 镜（已完成的不会重发）`；
- 第 4 步：`已保存` + 下一步文案；
- 同一次运行**没有请求打到 8000**。

一处如实记录的缺口：第 5 步的入口按 `text=生成与交付` 没找到（页面词汇可能是「进入后期剪辑」），
那一步的截图落在分镜工作室视图上，**没有**拿到"提示词起步路径的第 5 步"独立证据。

### 修掉一个会误标的口径（`describeStorageReachability`）

演练占位地址（`dry-run.invalid`）**不是**"只在本机的图"，它压根不是图。原实现只判
"有 imageUrl 且没有 ossUrl" → 会给演练结果贴上「仅本机 · 不能用于后续生成」，
把"演练没出图"说成"出图了但存不下来"，比不标更误导。现按既有 `isPlaceholderUrl` 排除，
并加了回归测试（该口径与后端 `adopt.PLACEHOLDER_URL_MARKERS` 同源）。

### 补充（第 18 轮）：提示词起步路径第 5 步已抓到

上一轮记的缺口已补上。根因很朴素：导航项的真实文案是 **`5. 生成与交付`（点后面有一个空格）**，
我按 `5.生成与交付` / `button,a,[role=tab]` 找都匹配不到——它是 `<span>5. 生成与交付</span>`。
按真实文案点进去后拿到该路径第 5 步证据（`66-prompt-start-5-生成与交付.png/.txt`）：

- `5. 生成与交付`、`生成与导出读的就是这一份`；
- **`可交付 1 条`**、`复制交付文本`、`范围 1 镜 · 可生成 0 · 可导出 1`；
- 仍未打任何请求到 8000。

**教训（记下来）**：找页面元素失败时，先在 DOM 里 dump"独占文本"再看真实文案/标签名，
不要凭记忆拼选择器——本轮和前两轮的 ④ 都是栽在这一点上。

---

## 追加（第 18 轮·第二次）：1 次被授权的真实出图已执行；③ **未能留证**，并发现 ② 的一个真实缺口

### 执行结果（1 次，无重试）

- 对象：`乌鸦`（人物，`asset_1790138604308_character`，有已保存提示词、未定版——刻意避开已有的苏晚棠定版）；
- 页面路径：项目 → 第 2 步 → 卡片「生成图片」→ **二次确认弹窗**（原文如实写明"当前是真实模式…按张计费"）
  → 点「确认真实生成（1 张）」→ **只发出 1 次 `POST /studio/image-pipeline/submit`**（脚本记录 submit 请求次数 = 1）；
- 结果：上游**又一次**"出图成功但 OSS 上传失败：HTTP 403 AccessDenied … bucket acl"；
- 页面结果区：`生成失败 1`、`失败 1`，提示「有 1 项生成失败，可以在结果卡片上「重试这一项」或「重新生成」」——
  **没有出现「采纳」**，因此 ③ 的"页面从结果卡片采纳 → 设为定版"**没有走通、没有留证**；
- 媒体对象：**0 新增**（`files` 仍为 140）；乌鸦也没有新增图片行。

第一次尝试（06:40）**没有花钱**：那次我点了「生成图片」但脚本被 600s 上限杀掉，
已用三重证据确认请求根本没发生——后端日志只有 `plan/preview`、上游队列 696/629/67 未变、
上游最近一条乌鸦任务仍是 03:47 那条。第二次（06:51）才真正发出并计费。

### 发现的产品缺口（② 的规则没覆盖这一种）

这一单的结果被判成 **`failed`**，而**不是**「部分成功」。原因是后端拿不到"可恢复产物"：
`normalize_outcome(recoverable_artifact=bool(local_path))` 要求 `detail.local_path` 非空，
而这一单的上游详情里**没有**返回本机图路径（上次苏晚棠那单有，所以我才能采纳它）。

也就是说：**"图已经出来了（已计费）"这个事实，上游有时报得出来、有时不报**，
而我们把"报不出来"直接呈现成"生成失败"。下一轮要做的是：在这条链路上补上
"产物是否还留着"的判定（拿不到就如实说"无法确认，图上可能有，需人工确认"），
而不是让页面只说"失败"——这正是用户要求的"部分成功 + 可恢复信息"。

### ③ 的现状

动作（采纳 / 设为定版）**存在**，但需要一张**可采纳的结果卡片**才能验；本轮这次真实出图没产出可采纳的图，
因此 ③ 仍**未完成**。要继续推进，需要 **再 1 次真实出图**（会再花 1 张的钱），
或者等上游把 OSS 写权限修好后再出图（那时一单就能拿到公网长期地址，可同时验"可采纳 + 可生成"）。

### 修掉 ② 的缺口（第 19 轮）：「存储失败但拿不到图」不再只说一句失败

第 18 轮那次授权出图暴露的缺口：上游报 `failed` 且**没有**返回本机图路径时，
后端 `recoverable_artifact` 判定不成立 → 结果只呈现为「生成失败」，
读起来像"没花钱也没图"，而事实是**图很可能已经生成并已经计费**。

- 后端：`_to_result` 的 `detail` 增加三个如实字段——
  `storage_failure`（失败是否落在存储环节）、`artifact_state`（`recoverable` / `unknown`，
  **能确认才说能救**）、`artifact_note`（拿不到图时的中文说明：
  "图很可能已经生成并已经计费…无法确认还能不能取回…重试前请先确认上游那一单"）；
- 前端：新增 `looksLikeStorageFailure` + `describeFailureReasonWithStorageNote`，
  在**三个失败映射点**（提交响应、轮询、结果卡片原因）统一走它——
  存储类失败会自动追加"可能已计费"提醒，非存储类失败**不加噪音**（有反向控制测试）。

测试：前端 713 项通过（新增 3 项，含反向控制），后端 77 项通过。
