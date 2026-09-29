# 产品命名与品牌口径（品牌名 vs 内部代号）

> 本文是**当前真实生效**的命名口径，属于 `architecture` 范畴（只记录现状，不写未来计划）。
>
> 一句话结论：**用户看得见的地方叫「像素小新 / Pixel Xiaoxin」；内部代码、环境变量、存储键、
> 数据库、API 和兼容前缀继续叫 `jellyfish / JELLYFISH`。两者不是同一个东西，不要互相改。**

---

## 1. 名称对照表

| 用途 | 当前名称 | 出现在哪里 |
|---|---|---|
| 中文用户可见产品名称 | **像素小新** | 左侧导航左上角、浏览器标签、欢迎语、分享卡片、官网首页 |
| 英文用户可见产品名称 | **Pixel Xiaoxin** | 英文语言下的同一批位置 |
| 产品说明（副标题） | **AI 短剧工作台** / `AI Short-form Studio` | 产品名下方那行说明；改名不影响它 |
| 历史内部代号（兼容标识） | **Jellyfish / jellyfish** | 目录名、包名、环境变量、存储键、API 路径、数据库、幂等前缀、历史文档 |
| 上级系统中控台（另一项目） | AI 短剧中控台 | 与本次改名无关，不要混改 |

命名关系："**像素小新**（原内部代号 **Jellyfish**）"。

---

## 2. 用户界面一律使用「像素小新」

用户可见的当前品牌文字只有一处来源，改的时候只改这里：

| 位置 | 文件 | 键 / 位置 |
|---|---|---|
| 中文产品名 | `front/src/locales/zh-CN/layout.json` | `layout.title` = `像素小新` |
| 中文欢迎语 | 同上 | `layout.welcome` = `欢迎使用像素小新` |
| 中文副标题 | 同上 | `layout.subtitle` = `AI 短剧工作台` |
| 英文产品名 | `front/src/locales/en-US/layout.json` | `layout.title` = `Pixel Xiaoxin` |
| 英文欢迎语 | 同上 | `layout.welcome` = `Welcome to Pixel Xiaoxin` |
| 浏览器标签（首屏静态兜底） | `front/index.html` | `<title>像素小新</title>` |
| 浏览器标签（运行时跟随语言） | `front/src/layouts/MainLayout.tsx` | `document.title = t('title')` |
| Logo 替代文本 | `front/src/layouts/MainLayout.tsx` | `alt={t('title')}`（跟随当前语言） |

### 品牌名的单一来源

品牌名**只有一处权威来源**：

- **主来源（React / i18n 运行时）**：`layout` 命名空间的 `title` / `welcome` / `subtitle`。
  界面组件一律走 `t('title')`，**不许在组件里手写品牌名**。
- **镜像出口（非 React / 非 i18n 环境）**：`front/src/branding.ts` 导出
  `PRODUCT_NAME_ZH` / `PRODUCT_NAME_EN` / `PRODUCT_TAGLINE_ZH` / `PRODUCT_TAGLINE_EN` /
  `LEGACY_INTERNAL_CODENAME`。用于首屏静态 HTML、工具脚本与守卫测试。

镜像出口**不是**第二套独立来源：`front/src/branding.test.ts` 会把两边逐字比对，
不一致直接判失败（防漂移）。`LEGACY_INTERNAL_CODENAME` 只允许出现在文档、守卫测试和
内部说明里，**绝不允许渲染到普通用户主页面**。

---

## 3. 内部标识继续使用 `jellyfish / JELLYFISH`（明确保留，不要改名）

下面这些标识**已经参与数据恢复、任务去重、接口兼容和历史记录**，所以**保持原样**。
改动它们可能导致用户设置丢失、缓存失效、旧任务无法识别或外部集成中断。

| 类别 | 保留的标识（示例，非穷举） | 为什么不能改 |
|---|---|---|
| 仓库目录 / worktree 路径 | `jellyfish-ui-redesign-deepseek` 等 | 本地路径、脚本、IDE 配置全指向它 |
| Git 分支名 / 远端名 | `feat/ui-redesign-deepseek`、`fork`、`origin` | 改写历史与协作关系 |
| GitHub 仓库地址 | `github.com/Forget-C/Jellyfish` | 改地址等于换仓库，外部集成会断 |
| npm / pnpm 包名 | `jellyfish-frontend`（`front/package.json`） | 锁文件与依赖解析 |
| Python 包名 / 模块名 | `backend/app/**` 下的既有模块 | 导入路径 |
| API 路径 | `/api/v1/...`、`/image-pipeline/...`、`/llm-orchestration/...` | 外部集成契约 |
| 数据库表 / 字段 / 迁移 | 既有 schema 与迁移文件 | 直接关系历史数据 |
| OpenAPI 契约内部名称 | `front/openapi.json` 的 `info.title` = `Jellyfish API` | 契约变更需走 openapi 同步流程，不属品牌改名 |
| 自动生成的 OpenAPI 客户端 | `front/src/services/generated/**`（注释里的 `Jellyfish`） | **本轮不得重新生成**；它是生成物，不是用户可见文案 |
| Docker 镜像 / 部署标识 | `deploy/**` 既有镜像与容器名 | 部署流水线 |
| 环境变量 | `JELLYFISH_DRY_RUN`、`JELLYFISH_REAL_LLM_CONFIRMED`、`JELLYFISH_DRY_RUN_ALLOW_HOSTS` 等 `JELLYFISH_*` | 演练模式守卫与真实付费门禁靠它们判定 |
| localStorage / 事件键 | `jellyfish_language`、`jellyfish_task_*`、`jellyfish_chapter_*`、`jellyfish.asset-production.round`、`jellyfish:orchestration-status-refresh` 等 | 改了等于清空用户设置与任务已读状态 |
| 幂等键 / 任务来源前缀 | `jellyfish:...` | 改了会让旧任务无法去重与识别 |
| 其它持久化命名空间 | 既有缓存 / 存储键 | 同上 |

> **演练模式守卫不做任何改动**：`JELLYFISH_DRY_RUN` 与 `JELLYFISH_REAL_LLM_CONFIRMED`
> 的变量名、读取位置与判定语义全部保持原样（定义处：
> `backend/app/services/studio/llm_orchestration/dry_run.py`）。

### 兼容性结论（改名后实测口径）

本次改名**只**替换用户可见品牌文字，因此下面这些能力全部继续有效：

- 已保存的语言设置（`jellyfish_language`）继续生效；
- 任务中心已读状态（`jellyfish_task_read_state_v1`）继续生效；
- 分镜工作室布局与当前镜头恢复（`jellyfish_chapter_studio_layout_v2`、`jellyfish_hidden_shots_*`）继续生效；
- 资产生产轮次与草稿（`jellyfish.asset-production.round`、`jellyfish.asset-prompt.drafts`）继续生效；
- 旧项目、章节、任务照常打开；所有原 URL、API 请求、数据库、环境变量均未变化。

**不得**通过修改或清空 localStorage 来实现改名。

---

## 4. 给后续开发者与 AI 的硬性规则

1. **用户可见名称只用「像素小新 / Pixel Xiaoxin」**，取值走 `t('title')` 或
   `front/src/branding.ts`，不要在组件里手写品牌名。
2. **看到内部还有 `jellyfish / JELLYFISH` 是正常的**，它是有意保留的兼容代号。
   **不得**因为「品牌改名了」就对全仓做批量替换 —— 禁止无迁移方案的全仓替换。
3. **不得**因为品牌改名重建数据库、修改迁移、重新生成 OpenAPI 客户端，或改变已有 URL。
4. **历史内容一律保留原名称**：`site/content/blog/**` 的历史 release note、历史版本发布说明、
   历史验收报告、旧截图、历史计划与架构文档里的 `Jellyfish` 记录的是**当时的真实名称**，
   不要改写（`AGENTS.md` 也规定已固化的 release note 未被明确指定时不得修改）。
5. 新增用户可见文案时，若需要品牌名，**复用现有键**，不要新增一份品牌名来源。

### 如果将来确实要迁移内部代号

必须作为**独立迁移项目**处理，**不得**混在普通功能开发或品牌改名里顺手做，至少需要：

- 一份独立的迁移方案与影响面清单（目录 / 包名 / 环境变量 / 存储键 / API / 数据库 / 镜像）；
- **兼容层**：新旧标识同时可读（例如新旧环境变量都认、新旧存储键都读）；
- **数据迁移**：localStorage、数据库、幂等键与任务来源前缀的迁移脚本，且可回滚；
- 外部集成方的沟通与切换窗口（GitHub 仓库地址、API 路径这类不能静默改）。

在满足上述条件之前，内部代号继续是 `Jellyfish / jellyfish`。

---

## 5. 本轮改动范围登记（含官网状态）

- **已改（生产前端 `front/`，必做范围）**：语言包、首屏 `<title>`、运行时 `document.title`、
  Logo 替代文本。
- **已改（官网当前品牌面）**：Hugo 站点标题 / 导航标题、首页标题与 Hero、首页场景段一句、
  分享卡片 `og-default.svg` 的品牌文字、`产品` 栏目四页当前产品介绍，
  并在产品介绍页补一句"像素小新原内部代号为 Jellyfish；内部技术标识暂时保留以保证兼容。"
- **明确不改（历史与内部）**：`site/content/blog/**` 历史 release note、
  `site/content/docs/**`（guide / architecture / plans / reference，含安装命令与 GitHub 地址）、
  历史验收报告、旧截图、仓库地址、安装命令、技术架构中的内部代号。

---

## 6. 守卫测试

`front/src/branding.test.ts` 负责把本文的口径钉死，覆盖四类断言：

1. **品牌名一致性**：语言包 / `front/index.html` / `front/src/branding.ts` 三处逐字相等。
2. **品牌不回流**：`front/src/**`（排除 `services/generated/**`）去掉注释后，
   旧品牌名 `Jellyfish` 0 命中 —— 普通用户可见标题不允许再把它当当前品牌。
3. **兼容标识仍在**：`jellyfish_language`、`jellyfish_task_*`、`JELLYFISH_DRY_RUN`、
   `jellyfish:...` 等内部标识继续存在（防止"改名顺手把内部标识也改了"）。
4. **不误判**：扫描器对内部兼容标识不报错（防把 `jellyfish_*` 当成品牌改名遗漏），
   并做反向自检（真的注入一个品牌名时必须被抓到，防"扫不到＝干净"的假绿）。

本文档路径：`docs/architecture/product-branding.md`
