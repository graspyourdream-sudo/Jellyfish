/**
 * 「文案黑名单」源码扫描测试（缺陷 D7）。
 *
 * 用户口径：**用户可见文案里不许再出现上一版的错误说法**（把已有图片当输入的那套词），
 * 也不许出现「图生图」。资产准备与资产编辑页是主要入口，所以这里做的是**源码级**扫描，
 * 而不是只检查几个常量 —— 免得以后有人再往 JSX 里写一句。
 *
 * 范围说明（诚实记录）：
 *   本任务允许改动的目录只有 `pages/aiStudio/project/ProjectWorkbench/**` 与
 *   `pages/aiStudio/assets/**`，所以：
 *     1. 这两个目录里**任何**非测试源码都不许出现黑名单词（含注释）；
 *     2. 其它目录（本次范围外）如果还有，必须逐文件登记在 `OUT_OF_SCOPE_OFFENDERS` 里 ——
 *        新冒出来的会直接让测试失败，不会悄悄溜过去。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `front/src/pages/aiStudio/project/ProjectWorkbench/components` → `front/src` */
const SRC_ROOT = resolve(HERE, '../../../../..')
const AISTUDIO_ROOT = resolve(SRC_ROOT, 'pages/aiStudio')

/** 本任务允许改动的两个目录。 */
const IN_SCOPE_DIRS = [
  resolve(AISTUDIO_ROOT, 'project/ProjectWorkbench'),
  resolve(AISTUDIO_ROOT, 'assets'),
]

/** 用户点名的两个黑名单词。 */
const BANNED_WORDS = ['垫图', '图生图']

/**
 * 本次**改动范围外**、但源码里仍有黑名单词的文件（逐个人工核对过）。
 *
 * 这些文件不在本任务允许编辑的目录里（用户明确限定只能改
 * `ProjectWorkbench/**` 与 `assets/**`），所以只能登记在这里交给后续任务清理：
 *   - `llmPipeline/LlmPipelinePage.tsx`：页面上有「垫图批量（用定版主图）」等真实文案；
 *   - `services/generated/**`：由后端 docstring 自动生成的注释（不是手写文案）。
 */
const OUT_OF_SCOPE_OFFENDERS = [
  'pages/aiStudio/llmPipeline/LlmPipelinePage.tsx',
  'services/generated/models/AdoptImageRead.ts',
  'services/generated/models/ImagePlanPreviewRequest.ts',
  'services/generated/models/ImageSubmitRequest.ts',
  'services/generated/models/ReferenceImageRead.ts',
  'services/generated/models/SubmissionTargetRead.ts',
  'services/generated/services/StudioImagePipelineService.ts',
]

function listSourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue
        walk(full)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue
      out.push(full)
    }
  }
  if (statSync(root).isDirectory()) walk(root)
  return out
}

/** 找出文件里命中黑名单词的行（可排除若干行号）。 */
function findBannedLines(file: string, skipLineNumbers: readonly number[] = []): string[] {
  const skip = new Set(skipLineNumbers)
  const hits: string[] = []
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (skip.has(index + 1)) return
      if (BANNED_WORDS.some((word) => line.includes(word))) {
        hits.push(`${relative(SRC_ROOT, file)}:${index + 1}: ${line.trim()}`)
      }
    })
  return hits
}

/**
 * `assetProduction.ts` 里黑名单正则的定义行必须写出被禁的词（否则无从检查），
 * 这几行按行号显式排除；其它任何一行都不许出现。
 */
function blacklistDefinitionLines(file: string): number[] {
  const lines = readFileSync(file, 'utf8').split('\n')
  const start = lines.findIndex((line) => line.includes('export const MISLEADING_COPY_PATTERNS'))
  assert.ok(start >= 0, 'assetProduction.ts 里应该有 MISLEADING_COPY_PATTERNS 定义')
  const out: number[] = []
  for (let index = start; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (trimmed.startsWith(']')) break
    if (/^\/.*\/,$/.test(trimmed)) out.push(index + 1)
  }
  assert.ok(out.length >= 2, '应该排除掉「垫图」「图生图」两条正则')
  return out
}

test('扫描器本身有效：黑名单词确实能在测试文件里被找出来（不是空转）', () => {
  const hits = findBannedLines(fileURLToPath(import.meta.url))
  assert.ok(hits.length >= BANNED_WORDS.length, `扫描器没找到任何命中，说明它坏了：${hits.length}`)
  // 找的是"含黑名单词的行"，不是"含黑名单词的文件"——用来证明扫描逻辑真的在跑
  const found = BANNED_WORDS.filter((word) => hits.some((hit) => hit.includes(word)))
  assert.deepEqual(found.sort(), [...BANNED_WORDS].sort())
})

test('D7：资产准备（ProjectWorkbench）与资产编辑（assets）里任何源码都不出现黑名单词', () => {
  const offenders: string[] = []
  IN_SCOPE_DIRS.forEach((dir) => {
    listSourceFiles(dir).forEach((file) => {
      // 测试文件本身需要写出被禁的词才能断言（不是用户可见文案），跳过
      if (/\.test\.tsx?$/.test(file)) return
      const skip = file.endsWith('assetProduction.ts') ? blacklistDefinitionLines(file) : []
      offenders.push(...findBannedLines(file, skip))
    })
  })
  assert.deepEqual(offenders, [])
})

test('D7：范围外仍有黑名单词的文件必须逐条登记，新冒出来的直接失败', () => {
  const inScopePrefixes = IN_SCOPE_DIRS.map((dir) => `${relative(SRC_ROOT, dir)}/`)
  const offenders = listSourceFiles(AISTUDIO_ROOT)
    .concat(listSourceFiles(resolve(SRC_ROOT, 'services')))
    .filter((file) => !inScopePrefixes.some((prefix) => relative(SRC_ROOT, file).startsWith(prefix)))
    .filter((file) => !/\.test\.tsx?$/.test(file))
    .filter((file) => findBannedLines(file).length > 0)
    .map((file) => relative(SRC_ROOT, file))
    .sort()

  const undocumented = offenders.filter((file) => !OUT_OF_SCOPE_OFFENDERS.includes(file))
  assert.deepEqual(undocumented, [], `这些文件出现了黑名单词，但没有登记在 OUT_OF_SCOPE_OFFENDERS 里：${undocumented.join(', ')}`)
  // 登记表里的文件如果已经清干净了（好事），不报错；但范围里必须一个都没有
  assert.ok(!offenders.some((file) => inScopePrefixes.some((prefix) => file.startsWith(prefix))))
})
