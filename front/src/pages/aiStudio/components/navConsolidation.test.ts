/**
 * 左侧导航 / 页面外壳的**信息架构守卫**（本轮最终收口的验收基建）。
 *
 * ## 为什么要有这个文件
 *
 * 本轮把 8 个平级入口收敛成 5 个，并且**推翻了仓库里一条旧裁定**：
 * 曾经有多处注释与测试钉死「`LLM 调试台（开发）` 导航名不改」（审计 §9.1 第 9 项）。
 * 那种"钉住旧产品决定"的守卫，在口径反转时如果不一起改，就会变成
 * 逼着实现保留旧一级入口的枷锁 —— 所以这里把**新**口径逐条钉死：
 *
 * | 断言 | 口径 |
 * |---|---|
 * | 左侧恰好 5 项、顺序固定 | 短剧项目 → 广告视频 → 资产管理 → 提示词管理 → 设置 |
 * | `drama_ad` 不在短剧新建弹窗的起点的里 | 短剧项目页不可能误建广告项目 |
 * | 广告项目创建只有一份实现 | 列表页与剧情策划页共用同一组件 / 默认值 / 校验 / 提交 |
 * | 提示词管理两个页签 + 旧路由兼容 | `/prompts?tab=` · `/prompt-flow` |
 * | 设置三个区域 + 调试权限门 | `/settings?tab=` · 旧 `/models`、`/llm-pipeline` |
 * | 调试内容不泄漏给无权限用户 | 无权限时**不渲染**调试组件（不是渲染了再藏） |
 * | 第 3 步只有一套生成提交 | 「查看完整请求」纯只读，没有第二套 `submitVideo` |
 * | 技术详情只有一个实现、默认收起 | 全仓唯一折叠壳 |
 * | 面包屑不再出现旧一级模块名 | 旧路由打开时显示新的模块名 |
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findMainScreenLeaks } from './mainScreenCopyGuard.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `pages/aiStudio/components` → `src` */
const SRC_ROOT = resolve(HERE, '../../..')

/** 只留代码（逐行去注释；永不跨行吞代码 —— 前几批的实测教训）。 */
function stripComments(source: string): string {
  const out: string[] = []
  let inBlock = false
  source.split('\n').forEach((line) => {
    const trimmed = line.trim()
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false
      out.push('')
      return
    }
    if (trimmed.startsWith('//') || trimmed === '' || trimmed.startsWith('*')) {
      out.push('')
      return
    }
    if (trimmed.startsWith('/*') || trimmed.startsWith('{/*')) {
      if (!trimmed.includes('*/')) inBlock = true
      out.push('')
      return
    }
    const matched = /(^|[^:])\/\//.exec(line)
    out.push(matched ? line.slice(0, matched.index + matched[0].length - 2) : line)
  })
  return out.join('\n')
}

function read(relPath: string): string {
  return readFileSync(resolve(SRC_ROOT, relPath), 'utf8')
}

function readCode(relPath: string): string {
  return stripComments(read(relPath))
}

/* ============================================================ 一、左侧导航 */

const LAYOUT = 'layouts/MainLayout.tsx'

/** 五个普通用户入口（顺序即产品口径）。 */
const EXPECTED_NAV: readonly { key: string; to: string; label: string }[] = [
  { key: 'projects', to: '/projects', label: '短剧项目' },
  { key: 'ad-videos', to: '/ad-videos', label: '广告视频' },
  { key: 'assets', to: '/assets', label: '资产管理' },
  { key: 'prompts', to: '/prompts', label: '提示词管理' },
  { key: 'settings', to: '/settings', label: '设置' },
]

test('左侧导航恰好 5 个普通入口，且顺序固定', () => {
  const code = readCode(LAYOUT)
  const block = /const NAV_ITEMS[^=]*=\s*\[([\s\S]*?)\n\]/.exec(code)
  assert.ok(block, '找不到 NAV_ITEMS（导航项的唯一来源）')
  const rows = (block[1].match(/\{ key: '[^']+', to: '[^']+', label: '[^']+'/g) ?? []).map((row) => {
    const matched = /\{ key: '([^']+)', to: '([^']+)', label: '([^']+)'/.exec(row)
    return { key: matched?.[1], to: matched?.[2], label: matched?.[3] }
  })
  assert.deepEqual(
    rows,
    [...EXPECTED_NAV],
    `左侧入口必须恰好是这 5 个且顺序如下（改口径必须同批改本守卫）：${JSON.stringify(EXPECTED_NAV)}`,
  )
  /* 菜单渲染必须**只用**这一份清单：否则会出现"清单改了、菜单没改"的假绿。 */
  assert.ok(/NAV_ITEMS\.map\(/.test(code), '菜单不是从 NAV_ITEMS 渲染的（清单与菜单可能不一致）')
})

test('旧的 8 个平级入口里，被合并的那三个不再作为一级入口出现', () => {
  const code = readCode(LAYOUT)
  ;['模型管理', 'LLM 调试台', '提示词模板', '提示词导入/交付', '剧情策划', '项目列表'].forEach((label) => {
    const menuItem = new RegExp(`label: <Link to="[^"]+">${label}</Link>`)
    assert.ok(!menuItem.test(code), `「${label}」仍是一级入口（本轮已合并进「设置」/「提示词管理」/「广告视频」）`)
  })
  /* ⚠️ 旧裁定已被本轮推翻：nav 里不许再出现「LLM 调试台（开发）」这个一级入口。 */
  assert.ok(
    !/label: <Link to="\/llm-pipeline">/.test(code),
    '「LLM 调试台（开发）」又回到了一级导航 —— 本轮口径是它并入「设置 · 开发调试」',
  )
})

test('五个入口各自对应的路由在 App.tsx 里真实存在（清单不许指向死地址）', () => {
  const app = readCode('App.tsx')
  EXPECTED_NAV.forEach(({ to }) => {
    const path = to.replace(/^\//, '')
    assert.ok(
      new RegExp(`path="${path}"`).test(app),
      `导航项 ${to} 在路由表里找不到`,
    )
  })
})

test('左侧始终只高亮一个入口：提示词两条路由 / 设置三条路由都收敛到同一个 key', () => {
  const code = readCode(LAYOUT)
  const fn = /function resolveSelectedKey\(pathname: string\): string\[\] \{([\s\S]*?)\n\}/.exec(code)
  assert.ok(fn, '找不到 resolveSelectedKey（高亮判据的唯一实现）')
  const body = fn[1]
  /* 旧路由必须与规范路由落到同一个 key（否则旧地址下左侧会一个都不亮） */
  assert.ok(
    /pathname\.startsWith\('\/prompts'\) \|\| pathname\.startsWith\('\/prompt-flow'\)\) return \['prompts'\]/.test(body),
    '`/prompt-flow` 没有与 `/prompts` 收敛到同一个高亮项',
  )
  assert.ok(
    /pathname\.startsWith\('\/models'\)/.test(body) && /pathname\.startsWith\('\/llm-pipeline'\)/.test(body),
    '`/models` 或 `/llm-pipeline` 没有收敛到「设置」的高亮项',
  )
  /* 五个入口的 key 都在判据里出现过 */
  EXPECTED_NAV.forEach(({ key }) => {
    assert.ok(body.includes(`'${key}'`), `高亮判据里缺少入口 ${key}`)
  })
})

/* ======================================================== 二、面包屑口径 */

test('面包屑：旧路由显示**新**的一级模块名，不再出现旧称谓', () => {
  const code = readCode(LAYOUT)
  const labels = /const PATH_LABELS[^=]*=\s*\{([\s\S]*?)\n\}/.exec(code)
  assert.ok(labels, '找不到 PATH_LABELS')
  const body = labels[1]
  const expectations: [string, string][] = [
    ['projects', '短剧项目'],
    ['ad-videos', '广告视频'],
    ['assets', '资产管理'],
    ['prompts', '提示词管理'],
    ['prompt-flow', '提示词管理'],
    ['models', '设置'],
    ['llm-pipeline', '设置'],
    ['settings', '设置'],
  ]
  expectations.forEach(([segment, label]) => {
    assert.ok(
      new RegExp(`'?${segment}'?:\\s*'${label}'`).test(body),
      `路径段 ${segment} 的面包屑名不是「${label}」`,
    )
  })
  /* 未登记段仍然必须收敛到「详情」，绝不回显 URL 段原样（审计 §4.6-R20） */
  assert.ok(/else label = '详情'/.test(code), '面包屑兜底又回落到 URL 段原样了')
  const fallback = code.match(/label = '详情'/g) ?? []
  assert.equal(fallback.length, 1, '应当只有一处「详情」兜底')
})

/* ================================ 三、短剧项目 / 广告视频 的项目类型分流 */

const LOBBY = 'pages/aiStudio/project/ProjectLobby.tsx'

test('短剧项目与广告视频共用同一份列表实现，靠明确的项目类型参数分流', () => {
  const code = readCode(LOBBY)
  assert.ok(/scope\?: ProjectLobbyScope/.test(code), 'ProjectLobby 没有接收项目类型参数')
  assert.ok(/export type ProjectLobbyScope = 'drama' \| 'ad'/.test(code), '项目类型参数的类型不对')
  assert.ok(/isAdScope \? value === 'ad' : value !== 'ad'/.test(code), '两类列表的判据不是同一处实现')
  /* 筛选必须发生在**数据层**（否则"看不见的项目"也会替它白跑一轮阶段/流转统计） */
  assert.ok(
    /\.filter\(\(p\) => inScope\(p\.kind \?\? 'drama'\)\)/.test(code),
    '列表没有在数据层按项目类型过滤（会在渲染层现算，副作用照发）',
  )
  const app = readCode('App.tsx')
  assert.ok(/<ProjectLobby scope="drama" \/>/.test(app), '/projects 没有显式声明成短剧项目列表')
  assert.ok(/<ProjectLobby scope="ad" \/>/.test(app), '/ad-videos 没有显式声明成广告项目列表')
})

test('短剧项目页的新建只提供普通短剧的两种起步路径（不可能误建广告）', () => {
  const code = readCode(LOBBY)
  /* 起点选项必须来自"去掉广告那一种"的清单，而不是页面自己 filter 一份 */
  assert.ok(
    /DRAMA_START_MODE_OPTIONS\.map\(/.test(code),
    '短剧新建弹窗没有用 DRAMA_START_MODE_OPTIONS（页面自己筛一遍会与预设表漂移）',
  )
  assert.ok(
    !/\bSTART_MODE_OPTIONS\b/.test(code),
    '短剧页仍然引用三种起点的全集（弹窗会把「剧情广告」摆回短剧入口）',
  )
  const presets = readCode('pages/aiStudio/project/projectStartPresets.ts')
  assert.ok(
    /DRAMA_START_MODE_OPTIONS = START_MODE_OPTIONS\.filter\(\s*\(option\) => option\.key !== 'drama_ad',?\s*\)/.test(presets),
    'DRAMA_START_MODE_OPTIONS 不是从全集里排除广告起点得到的',
  )
  /* 三种起点的真实业务能力一个都没删：全集仍在，广告起点只是换了入口 */
  assert.ok(/export const START_MODE_OPTIONS/.test(presets), '三种起点的全集被删掉了')
  ;['script', 'prompts', 'drama_ad'].forEach((key) => {
    assert.ok(presets.includes(`key: '${key}'`), `起点 ${key} 的真实能力丢了`)
  })
})

/* ============================ 四、广告项目创建：唯一实现 + 固定 kind=ad */

const AD_CREATE = 'pages/aiStudio/project/adProjectCreate.ts'
const AD_MODAL = 'pages/aiStudio/project/AdProjectCreateModal.tsx'
/* 创建失败的「原因 / 下一步」两行文案的单一来源（真机反馈收口新增）。 */
const AD_FAILURE = 'pages/aiStudio/project/adProjectCreateFailure.ts'
const DRAMA_PLAN = 'pages/aiStudio/dramaPlan/DramaPlanPage.tsx'

test('广告项目的创建只有一份实现：默认值 / 校验 / 请求体 / 提交都在同一个模块', () => {
  ;[AD_CREATE, AD_MODAL].forEach((relPath) => {
    assert.ok(existsSync(resolve(SRC_ROOT, relPath)), `${relPath} 不存在（唯一实现被删了？）`)
  })
  const create = readCode(AD_CREATE)
  assert.ok(/export function emptyAdProjectDraft/.test(create), '缺少统一的默认值')
  assert.ok(/export function validateAdProjectDraft/.test(create), '缺少统一的校验判据')
  assert.ok(/export function buildAdProjectCreateBody/.test(create), '缺少统一的请求体构造')
  assert.ok(/export async function createAdProject/.test(create), '缺少统一的提交逻辑')
  /* 提交仍然打在既有接口上，**没有**第二套创建接口 */
  assert.ok(
    /StudioProjectsService\.createProjectApiV1StudioProjectsPost\(/.test(create),
    '广告项目没有复用既有的创建接口',
  )
  /* 剧情策划页**一条都不能有**：它建广告项目必须走唯一实现。 */
  assert.equal(
    (readCode(DRAMA_PLAN).match(/createProjectApiV1StudioProjectsPost/g) ?? []).length,
    0,
    '剧情策划页自己又写了一份创建调用（必须是唯一实现）',
  )
  /* 列表页只允许**普通短剧**那一处（广告那一路必须走唯一实现）。 */
  assert.equal(
    (readCode(LOBBY).match(/createProjectApiV1StudioProjectsPost/g) ?? []).length,
    1,
    '项目大厅出现了两处创建调用（广告那一路应当走唯一实现）',
  )
  assert.ok(
    !/scope === 'ad'[\s\S]{0,2000}?createProjectApiV1StudioProjectsPost/.test(readCode(LOBBY)),
    '广告分支里出现了就地创建调用',
  )
})

test('广告项目固定创建 kind=ad：起点硬编，页面里没有生产方式三选一', () => {
  const create = readCode(AD_CREATE)
  assert.ok(/startMode: 'drama_ad'/.test(create), '广告项目的起点不是硬编的（可能被调用方传别的值）')
  assert.ok(
    /start_mode: toBackendStartMode\('drama_ad'\)/.test(create),
    'start_mode 没走唯一换算处（真实事故的形态）',
  )
  const modal = readCode(AD_MODAL)
  assert.ok(!/START_MODE_OPTIONS/.test(modal), '广告新建弹窗里出现了「生产方式」选择（不得误建普通短剧）')
  assert.ok(!/从剧本开始/.test(modal) && !/从视频提示词开始/.test(modal), '广告新建弹窗里出现了短剧起点')
})

test('两个入口复用同一个组件：列表页与剧情策划页都挂 AdProjectCreateModal', () => {
  ;[LOBBY, DRAMA_PLAN].forEach((relPath) => {
    const code = readCode(relPath)
    assert.ok(
      /<AdProjectCreateModal/.test(code),
      `${relPath} 没有挂共享的广告项目创建组件`,
    )
    assert.ok(
      /from '\.\.\/project\/AdProjectCreateModal'/.test(code) || /from '\.\/AdProjectCreateModal'/.test(code),
      `${relPath} 的 AdProjectCreateModal 不是从唯一实现里 import 的`,
    )
  })
})

test('剧情策划页在没有项目时给出唯一明确主操作（不必离开本页）', () => {
  const code = readCode(DRAMA_PLAN)
  assert.ok(/data-testid="drama-plan-empty-create"/.test(code), '空态里没有「新建广告视频」主操作')
  assert.ok(/data-testid="drama-plan-create-ad-project"/.test(code), '项目选择卡里没有「新建广告视频」入口')
  assert.ok(/setAdCreateOpen\(true\)/.test(code), '新建入口没有真的打开创建弹窗')
  /* 空态不再只有一句空话 */
  assert.ok(
    !/<Empty description="先选一个项目/.test(code),
    '空态又退回成一句空话了（用户必须离开本页才能建项目）',
  )
})

test('广告项目创建的防重复与失败恢复（源码级）', () => {
  const modal = readCode(AD_MODAL)
  /* ① 同步提交锁：state 是异步的，连点会漏过去 */
  assert.ok(/submittingRef\.current/.test(modal), '没有同步提交锁（同一帧连点会建出两个项目）')
  assert.ok(/if \(submittingRef\.current\) return/.test(modal), '提交入口没有先查提交锁')
  /* ② 项目 ID 只生成一次并复用：即使锁被绕过，后端也只会看到同一个 ID */
  assert.ok(/projectIdRef\.current = newProjectId\(\)/.test(modal), '项目 ID 不是"打开表单时只生成一次"')
  assert.ok(/createAdProject\(pending, projectIdRef\.current\)/.test(modal), '提交没有复用同一个项目 ID')
  /* ③ 加载态 + 失败态 */
  assert.ok(/loading=\{submitting\}/.test(modal), '创建过程中按钮没有加载状态')
  assert.ok(/data-testid="ad-create-error"/.test(modal), '缺少创建失败的说明出口')
  assert.ok(/data-testid="ad-create-saved"/.test(modal), '缺少"项目已经保存"的中间态出口')
  assert.ok(/项目已经保存/.test(modal), '跳转失败时没有明确说「项目已经保存」')
  assert.ok(/项目\*\*没有\*\*创建成功，也没有保存任何内容/.test(modal), '创建失败时没有说清"有没有保存"')
  /* 「原因 / 下一步」两行搬到了 `adProjectCreateFailure.ts`（单一来源）：真机反馈是
     「后端没在跑」时只弹一句 `Failed to fetch`，用户看不懂、照着"再点一次"也不会好。
     所以这两句的**内容**断言落在那个模块，弹窗只断言"确实接上了、确实上屏了"。 */
  assert.ok(existsSync(resolve(SRC_ROOT, AD_FAILURE)), `${AD_FAILURE} 不存在（失败文案的单一来源被删了？）`)
  assert.ok(
    /describeAdProjectCreateFailure\(exc\)/.test(modal),
    '创建失败时没有接上失败文案判定（会退回只弹 Failed to fetch）',
  )
  assert.ok(/nextStepLine/.test(modal), '创建失败时没有把"下一步怎么办"上屏')
  const failure = readCode(AD_FAILURE)
  assert.ok(/下一步：/.test(failure), '创建失败时没有给"下一步怎么办"')
  assert.ok(/连不上后端服务/.test(failure), '请求没送到服务时没有点明"连不上后端"')
  assert.ok(/进入策划/.test(modal), '没有提供「进入策划」的重试入口')
  /* 已经保存过时再点主按钮**不再创建**，只重试跳转 */
  assert.ok(/if \(saved\) \{/.test(modal), '已保存的中间态下没有拦住重复创建')
})

test('广告项目创建后：URL 带上真实 projectId / chapterId，且刷新能恢复', () => {
  const create = readCode(AD_CREATE)
  assert.ok(/chapter_id/.test(create), '没有用响应里的默认章节编号（会退化成再建一集）')
  const modal = readCode(AD_MODAL)
  assert.ok(/dramaPlanPath\(created\.projectId, created\.chapterId \|\| null\)/.test(modal), '落点不是带 projectId+chapterId 的策划页')
  /* 策划页必须把 URL 当唯一真相，否则"本页新建"这一跳（组件不卸载）不会更新状态 */
  const plan = readCode(DRAMA_PLAN)
  assert.ok(/lastUrlKeyRef/.test(plan), '策划页没有把 URL 变化同步进状态（刷新/跳转后回不到新建的项目）')
})

/* ============================== 五、提示词管理：两个页签 + 旧路由兼容 */

const PROMPT_CENTER = 'pages/aiStudio/prompts/PromptCenter.tsx'

test('提示词管理：两个页签 + 规范路由 + 旧 /prompt-flow 兼容', () => {
  const center = readCode(PROMPT_CENTER)
  assert.ok(/PromptTemplateManager/.test(center), '模板管理没有复用既有实现')
  assert.ok(/PromptFlowPage/.test(center), '导入与交付没有复用既有实现')
  assert.ok(/key: 'templates', label: '模板管理'/.test(center), '缺少「模板管理」页签')
  assert.ok(/key: 'delivery', label: '导入与交付'/.test(center), '缺少「导入与交付」页签')
  /* 页签写进 URL：刷新 / 前进后退靠它恢复 */
  assert.ok(/setSearchParams\(\{ tab: key \}/.test(center), '页签没有写进 URL（刷新会丢）')
  assert.ok(/useSearchParams\(\)/.test(center), '页签没有从 URL 读（前进后退会失效）')
  /* 旧路由 → 导入与交付页签（不是 404，也不落到错误的页签） */
  assert.ok(
    /<Navigate to="\/prompts\?tab=delivery" replace \/>/.test(center),
    '旧 /prompt-flow 没有兼容重定向到「导入与交付」',
  )
  assert.ok(/export function resolvePromptTab/.test(center), '缺少页签解析的单一实现')
  assert.ok(
    /=== 'delivery' \? 'delivery' : PROMPT_DEFAULT_TAB/.test(center),
    '未登记的 tab 值没有回落到默认页签',
  )
})

test('提示词管理的两类能力一个都没删（数据模型不混淆）', () => {
  /* 模板管理：查询 / 创建 / 编辑 / 删除仍在既有页面里 */
  const templates = readCode('pages/aiStudio/prompts/PromptTemplateManager.tsx')
  ;['listPromptTemplates', 'createPromptTemplate', 'updatePromptTemplate', 'deletePromptTemplate'].forEach((fn) => {
    assert.ok(templates.includes(fn), `模板管理能力缺失：${fn}`)
  })
  /* 导入 / 交付 / 一键技能：仍在既有页面里 */
  const flow = readCode('pages/aiStudio/promptFlow/PromptFlowPage.tsx')
  ;['JuriluImportPanel', 'PromptDeliveryPanel', 'QuickSkillPanel'].forEach((name) => {
    assert.ok(flow.includes(name), `导入与交付能力缺失：${name}`)
  })
})

/* ================================= 六、设置：三个区域 + 开发调试权限门 */

const SETTINGS_CENTER = 'pages/settings/SettingsCenter.tsx'
const DEBUG_ACCESS = 'pages/settings/debugAccess.ts'

test('设置：三个区域（模型与服务 / 系统设置 / 开发调试），且各自复用既有实现', () => {
  const center = readCode(SETTINGS_CENTER)
  assert.ok(/key: 'models', label: '模型与服务'/.test(center), '缺少「模型与服务」区域')
  assert.ok(/key: 'system', label: '系统设置'/.test(center), '缺少「系统设置」区域')
  assert.ok(/key: 'debug', label: '开发调试'/.test(center), '缺少「开发调试」区域')
  assert.ok(/<ModelManagement \/>/.test(center), '模型与服务没有复用既有模型管理')
  assert.ok(/<Settings \/>/.test(center), '系统设置没有复用既有设置页')
  assert.ok(/<LlmPipelinePage \/>/.test(center), '开发调试没有复用既有调试台')
  /* 页签写进 URL */
  assert.ok(/setSearchParams\(\{ tab: key \}/.test(center))
})

test('设置：普通用户 / 普通生产环境看不到「开发调试」页签', () => {
  const center = readCode(SETTINGS_CENTER)
  assert.ok(
    /if \(debugAccess\.visible\) list\.push\(\{ key: 'debug', label: '开发调试' \}\)/.test(center),
    '「开发调试」不是按权限条件进页签的（普通用户的 DOM 里不该有它）',
  )
  const access = readCode(DEBUG_ACCESS)
  assert.ok(/debugAccessFromEnv/.test(access), '缺少环境 + 权限的唯一判定入口')
  assert.ok(
    /devMode: resolveDevModeFromEnv\(import\.meta\.env as unknown as Record<string, unknown>\)/.test(access),
    '开发模式没有从构建期环境读取（生产构建必须恒为 false）',
  )
})

test('设置：无权限用户直达调试路由会安全跳到默认页签，且不渲染调试内容', () => {
  const center = readCode(SETTINGS_CENTER)
  /* 旧 /llm-pipeline 是**声明式**入口：先判权限，再决定去哪 —— 不会先渲染调试组件 */
  assert.ok(
    /export function DebugTabRoute\(\)[\s\S]{0,400}?const target = debugAccess\.allowed \? 'debug' : SETTINGS_DEFAULT_TAB/.test(center),
    '旧 /llm-pipeline 没有按权限决定目标页签',
  )
  assert.ok(
    /<Navigate to=\{`\/settings\?tab=\$\{target\}`\} replace \/>/.test(center),
    '旧 /llm-pipeline 没有安全重定向到设置',
  )
  /* 调试组件必须**只有**在允许时才渲染（不是渲染了再藏起来） */
  assert.ok(
    /activeTab === 'debug' && debugAccess\.allowed && <LlmPipelinePage \/>/.test(center),
    '调试组件不是按权限条件渲染的',
  )
  const app = readCode('App.tsx')
  assert.ok(/<DebugTabRoute \/>/.test(app), '/llm-pipeline 没有接上兼容路由')
  assert.ok(
    /<Navigate to="\/settings\?tab=models" replace \/>/.test(app),
    '旧 /models 没有兼容进「模型与服务」页签',
  )
})

test('开发调试的准入判定：权限 + 开关 + 开发模式，三条规则都在唯一实现里', () => {
  const access = readCode(DEBUG_ACCESS)
  assert.ok(/DEBUG_TOOLS_ADMIN_ROLE = 'admin'/.test(access), '管理员判据不是稳定角色码')
  assert.ok(
    /value === 'true' \|\| value === '1' \|\| value === 'yes'/.test(access),
    '显式调试开关的解析口径不对（必须只有显式真值才算开启）',
  )
  /* 环境门（开发模式 或 显式开关）**且** 权限门（管理员）—— 两道门缺一不可。 */
  assert.ok(
    /const environmentOpen = input\.devMode \|\| parseExplicitDebugFlag\(input\.explicitDebugFlag\)/.test(access),
    '环境门不是「开发模式 或 显式开关」',
  )
  assert.ok(
    /if \(environmentOpen && isAdmin\)/.test(access),
    '环境门与权限门必须是**与**的关系（写成"或"会让开发模式下的访客也看见调试页签）',
  )
  /* 页签可见性与路由准入用同一份结论（否则会出现"看不见页签但能直达"） */
  assert.ok(
    /visible: false,[\s\S]{0,80}?allowed: false,/.test(access),
    '不可见与不可进必须同时成立',
  )
})

/* ======================= 七、第 3 步：唯一一套视频生成提交链路（无第二入口） */

const CHAPTER_STUDIO = 'pages/aiStudio/chapter/ChapterStudio.tsx'
const REQUEST_PLAN_HOOK = 'pages/aiStudio/chapter/components/useShotRequestPlan.ts'

test('第 3 步只有一套出视频的提交：submitVideo 只在唯一 hook 里调用', () => {
  const studio = readCode(CHAPTER_STUDIO)
  const hook = readCode(REQUEST_PLAN_HOOK)
  assert.ok(/submitVideo\(\{/.test(hook), '正门（useShotRequestPlan）里找不到提交调用')
  assert.ok(
    !/submitVideo\(\{/.test(studio),
    'ChapterStudio 里又出现了第二处 submitVideo 调用 —— 那就是第二套出视频链路',
  )
  /* 旧的第二套提交函数必须已被安全删除 */
  ;['submitVideoGeneration', 'regenerateVideoGeneration', 'saveVideoPromptToShot', 'applyVideoLlmDerivedPrompt'].forEach(
    (name) => {
      assert.ok(!new RegExp(`const ${name}\\s*=`).test(studio), `旧的第二套写操作 ${name} 还在（应已删除）`)
    },
  )
  /* 重新生成只能走正式的 requestPlan.doRegenerate */
  assert.ok(/requestPlan\.doRegenerate\(\)/.test(studio), '「重新生成（下一轮）」没有走正式入口')
  assert.ok(/requestPlan\.doGenerate\(\)/.test(studio), '「生成视频」没有走正式入口')
})

test('「查看完整请求」是纯只读详情：没有生成 / 重新生成 / 保存等写操作', () => {
  const studio = readCode(CHAPTER_STUDIO)
  const modal = /<Modal\s+title="本次生成请求（只读）"([\s\S]*?)<\/Modal>/.exec(studio)
  assert.ok(modal, '找不到「本次生成请求（只读）」弹窗')
  const body = modal[1]
  /*
   * 判据落在**标记**上而不是词面上：正文里出现「要出视频请点『生成视频』」这类
   * 指路句是好事（它把用户送回唯一入口），但**不许真的渲染出**那些按钮。
   */
  const writeButtons = /<Button[^>]*>\s*(生成|生成视频|重新生成[^<]*|保存提示词|保存到镜头)\s*<\/Button>/.test(body)
  assert.ok(!writeButtons, '只读详情里渲染出了生成 / 重新生成 / 保存之类的写操作按钮')
  ;['doGenerate', 'doRegenerate', 'submitVideo', 'saveShotVideoPrompt'].forEach((fn) => {
    assert.ok(!body.includes(fn), `只读详情里出现了写操作调用 ${fn}()`)
  })
  assert.ok(/footer=\{\[/.test(body) && /关闭/.test(body), '只读详情应当只有一个「关闭」页脚')
  /* 但该展示的都要展示（只读 ≠ 内容缩水） */
  ;['画幅', '视频模型', '分辨率', '时长', '提示词', '参考方式', '声音'].forEach((field) => {
    assert.ok(body.includes(field), `只读详情里缺少「${field}」`)
  })
  /* 原始请求与内部参数放进默认收起的「技术详情」 */
  assert.ok(
    /<TechnicalDetailSection[\s\S]{0,200}?testId="video-request-technical-detail"/.test(body),
    '原始请求没有放进默认收起的「技术详情」',
  )
})

test('打开只读详情不再产生任何调用（原来的拼装调用已搬进提示词编辑区）', () => {
  const studio = readCode(CHAPTER_STUDIO)
  const openFn = /const openVideoPromptPreview = \(\) => \{([\s\S]*?)\n  \}/.exec(studio)
  assert.ok(openFn, 'openVideoPromptPreview 不是无副作用函数（可能又被写回成 async）')
  assert.ok(
    !/previewVideoSubmitPlan|deriveNow|previewVideoGenerationPrompt/.test(openFn[1]),
    '打开只读详情时又发起了请求（用户"看一眼请求"不该产生调用）',
  )
  assert.ok(
    /const deriveVideoPromptForEditor = async/.test(studio),
    '拼装提示词的能力被删了（应搬到提示词编辑区，不是删除）',
  )
  /* 提示词编辑区必须挂上这个显式动作 */
  assert.ok(/void deriveVideoPromptForEditor\(\)/.test(studio), '编辑区没有挂上「拼装一版提示词」')
})

test('视频任务轮询那套死代码已删除（正门是同进程内联执行，没有可轮询的任务号）', () => {
  const studio = readCode(CHAPTER_STUDIO)
  ;['videoTaskPolling', 'videoTaskStatus', 'videoTaskId', 'videoSettledTask'].forEach((name) => {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(studio), `死代码 ${name} 还在（旧提交链路的残留）`)
  })
})

/* ==================================================== 八、跨页面的收口约束 */

test('技术详情仍然只有一份实现，且默认收起', () => {
  const waiver = 'pages/aiStudio/project/ProjectWorkbench/components/workbench/TechnicalDetailCollapse.tsx'
  const impl = read(waiver)
  assert.ok(impl.includes('export function TechnicalDetailSection'), '共享折叠壳被改了')
  /* `<details>` 不带 `open` 属性 = 浏览器默认收起，这正是全仓口径 */
  const detailsTag = /<details([^>]*)>/.exec(impl)
  assert.ok(detailsTag, '折叠壳不是 <details> 形态的')
  assert.ok(!/\bopen\b/.test(detailsTag[1]), '折叠壳带上了 open 属性（默认就展开了）')
  assert.ok(
    /<summary[^>]*>技术详情（默认收起）<\/summary>/.test(impl.replace(/\s+/g, ' ')),
    '收起态可见的标题必须写死成「技术详情（默认收起）」',
  )
  ;[CHAPTER_STUDIO, DRAMA_PLAN, SETTINGS_CENTER, LOBBY, PROMPT_CENTER].forEach((relPath) => {
    const code = readCode(relPath)
    assert.ok(!/<details/.test(code), `${relPath} 自建了 <details> 形态的技术详情`)
    assert.ok(!/<summary/.test(code), `${relPath} 自建了 <summary> 形态的技术详情`)
  })
})

test('已删除的 ShotProductionWorkspace 没有被重新引入', () => {
  const offenders: string[] = []
  const walk = (dir: string): void => {
    // 只扫源码目录里的 ts/tsx（测试文件允许提到这个名字用来钉住"不许回来"）
    readdirSync(resolve(SRC_ROOT, dir)).forEach((name) => {
      const rel = `${dir}/${name}`
      const abs = resolve(SRC_ROOT, rel)
      const stat = statSync(abs)
      if (stat.isDirectory()) {
        walk(rel)
        return
      }
      if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) return
      /* 只看**代码**：注释里提到"那个组件已经删了"是必要的说明，不算重新引入。 */
      if (readCode(rel).includes('ShotProductionWorkspace')) offenders.push(rel)
    })
  }
  walk('pages')
  assert.deepEqual(offenders, [], `ShotProductionWorkspace 又被引用了：${offenders.join('、')}`)
})

test('主页面不得出现接口路径 / 内部 ID / 原始枚举 / HTTP 状态 / 环境变量（模型原名除外）', () => {
  /* 模型原名**允许**；下面这些**仍然禁止**。用真实源码做底，避免空跑。 */
  const probe = `
const __probe__ = () => (
  <div title="供应商 file_id 9f3c1a2b-0000-4000-8000-000000000001">
    候选 12 条 partial_failed POST /api/v1/studio/x JELLYFISH_DRY_RUN
  </div>
)
`
  const terms = new Set(findMainScreenLeaks(probe).map((hit) => hit.term))
  ;['供应商', '模式1 UUID', '模式2 内部字段名', '模式4 接口路径/URL/本机地址', '模式4 环境变量名', 'partial_failed'].forEach(
    (term) => {
      assert.ok(terms.has(term), `禁词「${term}」没被抓到（扫描器或词表失效）`)
    },
  )
  /* 反证：真实模型名不再命中 */
  assert.deepEqual(
    findMainScreenLeaks(`const __probe__ = () => <div>模型：seedance-2.0-mini</div>`),
    [],
    '模型原名仍被判成泄漏 —— 本轮口径明确允许展示',
  )
})
