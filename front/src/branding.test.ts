/**
 * 「用户可见产品品牌名」守卫测试。
 *
 * 口径文档：仓库根 `docs/architecture/product-branding.md`
 * （一句话：**用户看得见的叫「像素小新 / Pixel Xiaoxin」，内部仍叫 `jellyfish / JELLYFISH`**）。
 *
 * ============================ 本测试守的四件事 ============================
 *
 * 1. **品牌名一致**：语言包（`locales/**\/layout.json`）、首屏 `index.html`、
 *    非 i18n 出口 `src/branding.ts` 三处逐字相等 —— 防止改名只改了一半。
 * 2. **品牌不回流**：`src/**`（排除 `services/generated/**`）**去掉注释后**
 *    不许再出现旧品牌名 `Jellyfish` 这个 token —— 普通用户可见标题不允许再把旧代号当品牌。
 * 3. **兼容标识仍在**：`jellyfish_language`、`jellyfish_task_*`、`JELLYFISH_DRY_RUN`、
 *    `jellyfish:...`、包名、OpenAPI 契约名、GitHub 地址继续存在 ——
 *    防止「改名顺手把内部标识也改了」把用户设置 / 旧任务 / 外部集成一起改坏。
 * 4. **不误判、不假绿**：扫描器对内部兼容标识（`jellyfish_*` / `JELLYFISH_*` / `jellyfish:`）
 *    **不许**报错；同时做反向自检 —— 真注入一个品牌名时必须被抓到。
 *
 * ==================== 为什么有些地方**故意**不扫（诚实声明） ====================
 *
 * - `src/services/generated/**`：自动生成的 OpenAPI 客户端。它注释里的 `Jellyfish`
 *   来自后端契约 docstring，**本轮明确不重新生成**。它是生成物，不是用户可见文案；
 *   第 ⑧ 组会反过来断言它**仍然保持内部名称**（没被"顺手改名"或重新生成）。
 * - 源码注释（行注释、块注释、JSX 注释、JSDoc）：开发说明里写「本仓内部代号叫 Jellyfish」
 *   是**正确且必要**的（否则下一个人又会去全仓替换）。注释不进用户界面，所以扫描前**先剥离**。
 * - 测试文件（`*.test.ts`）：不是用户可见界面，而且**本守卫自己**必须能写下品牌名
 *   （注入样本）才能证明扫得动 —— 见第 ④ 组反向自检。
 * - 历史文档 / 历史 release note / 历史验收记录里的旧名称：记录的是当时的真实名称，按口径保留。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, relative, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LEGACY_INTERNAL_CODENAME,
  PRODUCT_BRANDING_DOC_PATH,
  PRODUCT_NAME_EN,
  PRODUCT_NAME_ZH,
  PRODUCT_TAGLINE_EN,
  PRODUCT_TAGLINE_ZH,
  productNameByLanguage,
} from './branding.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `front/src` */
const SRC_ROOT = HERE
/** `front` */
const FRONT_ROOT = resolve(HERE, '..')
/** 仓库根 */
const REPO_ROOT = resolve(FRONT_ROOT, '..')

/**
 * 唯一允许在**代码**（非注释）里出现旧品牌名 token 的文件。
 *
 * `src/branding.ts` 是 `LEGACY_INTERNAL_CODENAME` 的声明处本身 —— 它的字符串字面量
 * 就是「内部代号」这份常量，且第 ⑦ 组断言它**不被任何渲染文件引用**。
 * 除它以外，任何代码里出现 `Jellyfish` 都算品牌回流。
 */
const BRAND_TOKEN_OWNER = 'branding.ts'

/** 旧品牌名 token（**大小写敏感**：`JELLYFISH_DRY_RUN` / `jellyfish_language` 都不是它）。 */
const LEGACY_BRAND_TOKEN = LEGACY_INTERNAL_CODENAME

/** 生成物目录（相对 `src`）：不扫品牌，只反向断言它保持内部名称。 */
const GENERATED_PREFIX = 'services/generated/'

/** 源码扫描的文件后缀。 */
const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.json']

/* ------------------------------------------------------------------ 读取 */

function readSrc(relPath: string): string {
  return readFileSync(resolve(SRC_ROOT, relPath), 'utf8')
}

function readFront(relPath: string): string {
  return readFileSync(resolve(FRONT_ROOT, relPath), 'utf8')
}

function readRepo(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8')
}

/**
 * 递归收集 `src/**` 下的源码文件（相对 `src` 的 POSIX 路径）。
 *
 * 排除：`node_modules`、`services/generated/**`（见文件头「故意不扫」）。
 */
function listSourceFiles(dir: string = SRC_ROOT): string[] {
  const out: string[] = []
  readdirSync(dir).forEach((entry) => {
    const abs = join(dir, entry)
    if (entry === 'node_modules') return
    if (statSync(abs).isDirectory()) {
      out.push(...listSourceFiles(abs))
      return
    }
    if (!SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) return
    const rel = relative(SRC_ROOT, abs).split('\\').join('/')
    if (rel.startsWith(GENERATED_PREFIX)) return
    out.push(rel)
  })
  return out.sort()
}

/**
 * 「会进用户界面」的源码 = 全量扫描面去掉测试文件。
 *
 * 测试文件不是用户可见界面，而且**本守卫自己**必须能写下品牌名（注入样本、
 * 文档断言）才能证明扫得动 —— 见第 ④ 组反向自检。所以品牌回流扫描只覆盖
 * 非测试源码；测试文件里的品牌名不会上屏。
 */
function listRenderableSourceFiles(): string[] {
  return listSourceFiles().filter((rel) => !rel.endsWith('.test.ts') && !rel.endsWith('.test.tsx'))
}

/* ------------------------------------------------------- 注释剥离 + 检测器 */

/**
 * 只保留代码（去注释）。
 *
 * ⚠️ 逐行处理，**永不跨行吞代码**（与 `modelsCopy.test.ts` 同款；前几批实测过：
 * 「先正则去块注释」的朴素实现会被字符串里的块注释起止符骗到，吞掉几百行造成假绿）。
 */
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

/** 去掉 HTML 注释（`index.html` 的静态兜底说明里会提到旧代号，那不是用户可见文字）。 */
function stripHtmlComments(source: string): string {
  return source.replace(/<!--[\s\S]*?-->/g, '')
}

export type LegacyBrandHit = { readonly line: number; readonly text: string }

/**
 * 品牌回流检测器：在**去注释后的代码**里找旧品牌名 token。
 *
 * 大小写敏感 —— `jellyfish_language`（存储键）、`JELLYFISH_DRY_RUN`（环境变量）、
 * `jellyfish:...`（幂等前缀）都**不是**这个 token，所以内部兼容标识不会被误判。
 */
export function findLegacyBrandHits(source: string): LegacyBrandHit[] {
  return stripComments(source)
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    .filter((entry) => entry.text.includes(LEGACY_BRAND_TOKEN))
    .map((entry) => ({ line: entry.line, text: entry.text.trim() }))
}

/** 格式化命中，失败信息里直接给出「文件:行:内容」。 */
function formatHits(relPath: string, hits: readonly LegacyBrandHit[]): string {
  return hits.map((hit) => `  ${relPath}:${hit.line}: ${hit.text}`).join('\n')
}

/** 解析语言包（JSON）。 */
function readLayoutJson(locale: 'zh-CN' | 'en-US'): Record<string, string> {
  return JSON.parse(readSrc(`locales/${locale}/layout.json`)) as Record<string, string>
}

/* ------------------------------------------------------------------ 工具 */

function assertContains(source: string, needle: string, message: string): void {
  assert.ok(source.includes(needle), `${message}（找不到：${needle}）`)
}

/* ============================ ① 品牌名单一来源 ============================ */

test('① 中文语言包：产品标题 / 欢迎语 / 副标题都是新品牌口径', () => {
  const zh = readLayoutJson('zh-CN')
  assert.equal(zh.title, PRODUCT_NAME_ZH, '中文产品标题必须是「像素小新」')
  assert.equal(zh.welcome, `欢迎使用${PRODUCT_NAME_ZH}`, '中文欢迎语必须是「欢迎使用像素小新」')
  assert.equal(zh.subtitle, PRODUCT_TAGLINE_ZH, '副标题继续用「AI 短剧工作台」')
  assert.ok(!zh.title.includes(LEGACY_BRAND_TOKEN), '中文标题不许再出现旧品牌名')
  assert.ok(!zh.welcome.includes(LEGACY_BRAND_TOKEN), '中文欢迎语不许再出现旧品牌名')
})

test('① 英文语言包：产品标题 / 欢迎语都是新品牌口径', () => {
  const en = readLayoutJson('en-US')
  assert.equal(en.title, PRODUCT_NAME_EN, '英文产品标题必须是 `Pixel Xiaoxin`')
  assert.equal(en.welcome, `Welcome to ${PRODUCT_NAME_EN}`, '英文欢迎语必须是 `Welcome to Pixel Xiaoxin`')
  assert.equal(en.subtitle, PRODUCT_TAGLINE_EN, '英文副标题保持现有口径')
  assert.ok(!en.title.includes(LEGACY_BRAND_TOKEN), '英文标题不许再出现旧品牌名')
  assert.ok(!en.welcome.includes(LEGACY_BRAND_TOKEN), '英文欢迎语不许再出现旧品牌名')
})

test('① 非 i18n 出口（branding.ts）与语言包逐字相等：不是两套独立来源', () => {
  const zh = readLayoutJson('zh-CN')
  const en = readLayoutJson('en-US')
  assert.equal(zh.title, PRODUCT_NAME_ZH, '`PRODUCT_NAME_ZH` 与中文语言包 `layout.title` 必须一致')
  assert.equal(en.title, PRODUCT_NAME_EN, '`PRODUCT_NAME_EN` 与英文语言包 `layout.title` 必须一致')
  assert.equal(zh.subtitle, PRODUCT_TAGLINE_ZH, '`PRODUCT_TAGLINE_ZH` 与中文 `layout.subtitle` 必须一致')
  assert.equal(en.subtitle, PRODUCT_TAGLINE_EN, '`PRODUCT_TAGLINE_EN` 与英文 `layout.subtitle` 必须一致')
  assert.equal(productNameByLanguage('zh-CN'), PRODUCT_NAME_ZH)
  assert.equal(productNameByLanguage('en-US'), PRODUCT_NAME_EN)
})

test('② `front/index.html` 首屏静态标题 = 中文品牌名，且不含旧品牌名', () => {
  const raw = readFront('index.html')
  const rendered = stripHtmlComments(raw)
  assertContains(rendered, `<title>${PRODUCT_NAME_ZH}</title>`, '静态 `<title>` 必须是「像素小新」')
  assert.ok(
    !rendered.includes(LEGACY_BRAND_TOKEN),
    '`index.html` 的用户可见部分（去 HTML 注释后）不许出现旧品牌名',
  )
  assert.ok(!/<title>[^<]*<\/title>/.exec(rendered)?.[0].includes(LEGACY_BRAND_TOKEN), '标签标题不许是旧品牌名')
})

/* =================== ⑦ LEGACY 常量不渲染到普通用户主页面 =================== */

/** 渲染文件所在的目录（品牌名一律走 `t('title')`，不许引用镜像常量）。 */
const RENDERING_DIRS: readonly string[] = ['layouts/', 'pages/']

test('⑦ 内部代号常量 / 镜像品牌常量不被任何渲染文件引用（主页面只走 `t(\'title\')`）', () => {
  const offenders = listSourceFiles().filter((rel) => {
    if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) return false
    if (!RENDERING_DIRS.some((prefix) => rel.startsWith(prefix))) return false
    const code = stripComments(readSrc(rel))
    return /from\s+['"][^'"]*branding(\.ts)?['"]/.test(code)
  })
  assert.deepEqual(
    offenders,
    [],
    `渲染文件必须用 \`t('title')\` 取品牌名，不许引用 branding.ts 常量：\n${offenders.join('\n')}`,
  )
  const layout = stripComments(readSrc('layouts/MainLayout.tsx'))
  assert.ok(!layout.includes(LEGACY_BRAND_TOKEN), '主页面渲染代码里不许出现内部代号')
})

/* ===================== ③ 品牌不回流（源码级扫描） ===================== */

test('③ 扫描面非空守卫：确实扫到了大量源码与关键文件（防「扫不到＝干净」）', () => {
  const files = listSourceFiles()
  assert.ok(files.length > 100, `扫描面太小（${files.length} 个文件），疑似遍历写错`)
  ;['layouts/MainLayout.tsx', 'i18n.ts', 'locales/zh-CN/layout.json', 'locales/en-US/layout.json'].forEach(
    (rel) => {
      assert.ok(files.includes(rel), `关键文件没进扫描面：${rel}`)
    },
  )
  assert.ok(
    !files.some((rel) => rel.startsWith(GENERATED_PREFIX)),
    '`services/generated/**` 必须被排除（生成物，不得重新生成）',
  )
})

test('③ 普通用户可见前端源码（去注释）不再出现旧品牌名 `Jellyfish`', () => {
  const offenders: string[] = []
  listRenderableSourceFiles().forEach((rel) => {
    if (rel === BRAND_TOKEN_OWNER) return
    const hits = findLegacyBrandHits(readSrc(rel))
    if (hits.length > 0) offenders.push(formatHits(rel, hits))
  })
  assert.deepEqual(
    offenders,
    [],
    `用户可见品牌名应统一为「${PRODUCT_NAME_ZH} / ${PRODUCT_NAME_EN}」；\n` +
      `内部兼容标识（\`jellyfish_*\` / \`JELLYFISH_*\` / \`jellyfish:\`）不在检测范围内。\n` +
      `下面这些是**渲染代码里**的旧品牌名，请改成 \`t('title')\`：\n${offenders.join('\n')}`,
  )
})

test('③ 唯一豁免文件 `branding.ts` 的命中被钉死：只有「内部代号」常量那一行', () => {
  const hits = findLegacyBrandHits(readSrc(BRAND_TOKEN_OWNER))
  assert.equal(hits.length, 1, `\`${BRAND_TOKEN_OWNER}\` 只允许有 1 处旧品牌名（内部代号常量声明）`)
  assert.equal(
    hits[0].text,
    `export const LEGACY_INTERNAL_CODENAME = '${LEGACY_BRAND_TOKEN}'`,
    '`branding.ts` 里那一处必须是内部代号常量声明，不是别处写进来的品牌文案',
  )
})

/* ===================== ④ 反向自检（防假绿 / 防误判） ===================== */

test('④ 检测器自检：注入品牌名必须被抓到；内部兼容标识不许被误判', () => {
  /* 正向：真写进渲染代码的品牌名要被抓到 */
  const brandSamples: readonly string[] = [
    '<img src="/logo.svg" alt="Jellyfish" />',
    'const WELCOME = \'欢迎使用 Jellyfish\'',
    'document.title = "Jellyfish"',
  ]
  brandSamples.forEach((sample) => {
    assert.ok(findLegacyBrandHits(sample).length > 0, `注入的品牌名没被抓到：${sample}`)
  })

  /* 反向：内部兼容标识一个都不许被判成品牌遗漏 */
  const internalSamples: readonly string[] = [
    "export const LANGUAGE_STORAGE_KEY = 'jellyfish_language'",
    "const OPEN_KEY = 'jellyfish_task_center_open_v1'",
    "const READ_KEY = 'jellyfish_task_read_state_v1'",
    "const ROUND = 'jellyfish.asset-production.round'",
    "const EVT = 'jellyfish:orchestration-status-refresh'",
    "const IDEMPOTENT = 'jellyfish:p:character:c1:abcd1234'",
    'DRY_RUN_ENV = "JELLYFISH_DRY_RUN"',
    'CONFIRM_ENV = "JELLYFISH_REAL_LLM_CONFIRMED"',
    'if (/\\bJELLYFISH_[A-Z_]+\\b/.test(value)) return true',
    '"name": "jellyfish-frontend"',
  ]
  internalSamples.forEach((sample) => {
    assert.deepEqual(
      findLegacyBrandHits(sample),
      [],
      `内部兼容标识被误判成品牌改名遗漏：${sample}`,
    )
  })

  /* 注释里的旧代号不算用户可见文案（开发说明必须能写清「内部代号」的来龙去脉） */
  assert.deepEqual(
    findLegacyBrandHits('// 本仓内部代号仍是 Jellyfish\n/* 参考项目 Jellyfish 的口径 */'),
    [],
    '源码注释不进用户界面，不应被判成品牌回流',
  )
})

/* ============== ⑤ 内部兼容标识仍然存在（防「顺手改内部标识」） ============== */

/** `rel` 相对 `front/src`。 */
const SRC_INTERNAL_IDENTIFIERS: readonly { readonly rel: string; readonly token: string; readonly note: string }[] = [
  { rel: 'i18n.ts', token: "'jellyfish_language'", note: '语言设置存储键（改了会丢用户语言选择）' },
  { rel: 'i18n.ts', token: 'LANGUAGE_STORAGE_KEY', note: '语言键常量出口' },
  { rel: 'layouts/MainLayout.tsx', token: "'jellyfish_language'", note: '语言切换下拉写入的同一个键' },
  {
    rel: 'pages/aiStudio/components/TaskCenter.tsx',
    token: "'jellyfish_task_center_open_v1'",
    note: '任务中心展开状态',
  },
  {
    rel: 'pages/aiStudio/components/TaskCenter.tsx',
    token: "'jellyfish_task_center_position_v1'",
    note: '任务中心位置',
  },
  {
    rel: 'pages/aiStudio/components/taskUnread.ts',
    token: "'jellyfish_task_read_state_v1'",
    note: '任务中心已读状态（改了用户已读会重置）',
  },
  {
    rel: 'pages/aiStudio/chapter/ChapterStudio.tsx',
    token: "'jellyfish_chapter_studio_layout_v2'",
    note: '分镜工作室布局',
  },
  {
    rel: 'pages/aiStudio/chapter/ChapterStudio.tsx',
    token: 'jellyfish_hidden_shots_',
    note: '当前镜头隐藏态',
  },
  {
    rel: 'pages/aiStudio/project/ProjectWorkbench/components/assetRoundStore.ts',
    token: "'jellyfish.asset-production.round'",
    note: '资产生产轮次',
  },
  {
    rel: 'pages/aiStudio/project/ProjectWorkbench/components/workbench/assetPromptDrafts.ts',
    token: "'jellyfish.asset-prompt.drafts'",
    note: '资产提示词草稿',
  },
  {
    rel: 'services/orchestrationStatusApi.ts',
    token: "'jellyfish:orchestration-status-refresh'",
    note: '事件键',
  },
  {
    rel: 'pages/aiStudio/models/constants.ts',
    token: 'JELLYFISH_',
    note: '内部标识掩码正则（用户可见侧本来就要屏蔽它）',
  },
  {
    rel: 'pages/aiStudio/project/ProjectWorkbench/components/userFacingStatus.ts',
    token: "'JELLYFISH_'",
    note: '用户可见文案的内部技术词黑名单',
  },
]

test('⑤ 前端内部兼容标识（存储键 / 事件键 / 环境变量掩码）全部保留', () => {
  SRC_INTERNAL_IDENTIFIERS.forEach(({ rel, token, note }) => {
    assertContains(readSrc(rel), token, `${rel} 缺少内部兼容标识（${note}）`)
  })
})

test('⑤ 环境变量 `JELLYFISH_*` 名字不变：演练模式守卫与真实付费门禁继续有效', () => {
  const dryRun = readRepo('backend/app/services/studio/llm_orchestration/dry_run.py')
  assertContains(dryRun, 'DRY_RUN_ENV = "JELLYFISH_DRY_RUN"', '演练模式环境变量名不得改')
  assertContains(dryRun, 'CONFIRM_ENV = "JELLYFISH_REAL_LLM_CONFIRMED"', '真实调用确认变量名不得改')
})

test('⑤ 包名 / GitHub 地址 / OpenAPI 契约内部名不变（仓库与契约不是品牌名）', () => {
  assertContains(readFront('package.json'), '"name": "jellyfish-frontend"', 'npm 包名不得改')
  assertContains(readRepo('site/hugo.yaml'), 'https://github.com/Forget-C/Jellyfish', 'GitHub 地址不得改')
  assertContains(
    readRepo('site/content/docs/getting-started/installation.md'),
    'git clone https://github.com/Forget-C/Jellyfish.git',
    '安装命令不得改',
  )
  const contract = JSON.parse(readFront('openapi.json')) as { info?: { title?: string } }
  assert.equal(contract.info?.title, 'Jellyfish API', 'OpenAPI 契约内部名不得改（本轮不重新生成客户端）')
})

test('⑤ 自动生成的 OpenAPI 客户端仍在原位（未被改名 / 未被重新生成）', () => {
  const generated = listGeneratedFiles()
  assert.ok(generated.length > 100, `生成的客户端文件数异常（${generated.length}）`)
  assert.ok(
    generated.includes('services/generated/index.ts'),
    '生成的客户端入口不见了（是否误删 / 重生成到了别处？）',
  )
  /* 生成物里的 `Jellyfish` 来自后端契约 docstring：它**仍然在**才是对的
     （本轮不重新生成客户端、不改契约名；反过来断言，正好堵住「顺手把生成物也改名」）。 */
  const generatedWithContractName = [
    'services/generated/models/FrameSubmitRead.ts',
    'services/generated/models/SubmissionTargetRead.ts',
    'services/generated/services/StudioImagePipelineService.ts',
  ]
  generatedWithContractName.forEach((rel) => {
    assertContains(readSrc(rel), 'Jellyfish', `${rel} 的内部契约名被改了（本轮不重新生成客户端）`)
  })
})

/** 收集生成物文件（相对 `src`），仅供「未重新生成」断言使用。 */
function listGeneratedFiles(): string[] {
  const root = resolve(SRC_ROOT, 'services/generated')
  const out: string[] = []
  const walk = (dir: string): void => {
    readdirSync(dir).forEach((entry) => {
      const abs = join(dir, entry)
      if (statSync(abs).isDirectory()) {
        walk(abs)
        return
      }
      out.push(relative(SRC_ROOT, abs).split('\\').join('/'))
    })
  }
  walk(root)
  return out.sort()
}

/* ============================ ⑥ 品牌文档必须存在 ============================ */

test('⑥ 品牌兼容文档存在，并明确「外部品牌 ↔ 内部代号」的关系与迁移规则', () => {
  let doc = ''
  try {
    doc = readRepo(PRODUCT_BRANDING_DOC_PATH)
  } catch {
    assert.fail(`品牌文档必须存在：${PRODUCT_BRANDING_DOC_PATH}`)
  }
  /* 要求 1：两个品牌名 */
  assertContains(doc, PRODUCT_NAME_ZH, '文档必须写明中文品牌名')
  assertContains(doc, PRODUCT_NAME_EN, '文档必须写明英文品牌名')
  /* 要求 2：Jellyfish 是历史内部代号 */
  assertContains(doc, 'Jellyfish', '文档必须点名历史内部代号')
  assertContains(doc, '内部代号', '文档必须说明「Jellyfish 是内部代号」')
  /* 要求 3：内部标识继续使用 jellyfish */
  assertContains(doc, 'jellyfish_language', '文档必须举出继续保留的存储键')
  assertContains(doc, 'JELLYFISH_DRY_RUN', '文档必须举出继续保留的环境变量')
  /* 要求 4：禁止无迁移方案的全仓替换 */
  assertContains(doc, '全仓替换', '文档必须写明禁止全仓替换')
  assertContains(doc, '批量替换', '文档必须写明禁止批量替换')
  /* 要求 5：将来迁移必须作为独立项目 + 兼容层 + 数据迁移 */
  assertContains(doc, '独立迁移项目', '文档必须写明将来迁移要作为独立项目')
  assertContains(doc, '兼容层', '文档必须要求提供兼容层')
  assertContains(doc, '数据迁移', '文档必须要求提供数据迁移')
  /* 要求 6：兼容性结论 */
  assertContains(doc, 'localStorage', '文档必须写明不得通过改 / 清 localStorage 来实现改名')
})

test('⑥ `AGENTS.md` 有「产品命名」章节，且不破坏原有规则', () => {
  const agents = readRepo('AGENTS.md')
  assertContains(agents, '## 产品命名', 'AGENTS.md 必须新增「产品命名」章节')
  const section = agents.slice(agents.indexOf('## 产品命名'), agents.indexOf('## 代码规范'))
  assertContains(section, PRODUCT_NAME_ZH, '「产品命名」章节必须给出中文品牌名')
  assertContains(section, PRODUCT_NAME_EN, '「产品命名」章节必须给出英文品牌名')
  assertContains(section, 'Jellyfish', '「产品命名」章节必须点名内部兼容代号')
  assertContains(section, '全仓替换', '「产品命名」章节必须写明禁止全仓替换')
  assertContains(section, PRODUCT_BRANDING_DOC_PATH, '「产品命名」章节必须指向品牌文档')
  /* 原有规则不被破坏：章节是**新增**的，老规则仍在 */
  assertContains(agents, '## 代码规范', '原有「代码规范」章节不得被删')
  assertContains(agents, '## 前端页面职责', '原有「前端页面职责」章节不得被删')
  assertContains(agents, '## 状态语义约定', '原有「状态语义约定」章节不得被删')
  assertContains(agents, '## 标准完成状态', '原有「标准完成状态」章节不得被删')
})

/* ================= ② 运行时两个渲染点确实接上了新品牌名 ================= */

test('② 左上角名称 / Logo 替代文本 / 浏览器标签都取 i18n 品牌名，没有硬编码', () => {
  const layout = stripComments(readSrc('layouts/MainLayout.tsx'))
  assertContains(layout, "alt={t('title')}", 'Logo 替代文本必须取当前语言的品牌名')
  assertContains(layout, 'document.title = t(\'title\')', '浏览器标签必须跟随语言的品牌名')
  assertContains(layout, "t('subtitle')", '副标题继续走 i18n')
  assert.ok(!/alt="[^"]*"/.test(layout), 'Logo 的 alt 不许再写死字符串')
})
