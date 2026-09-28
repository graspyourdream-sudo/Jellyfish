/**
 * 阶段 3「生成视频」设置行的**源码级守卫**（设计包第 11 页 `generate-block`）。
 *
 * 为什么用源码扫描而不是渲染测试：本仓库没有 jsdom / testing-library（也不许为此引入新依赖），
 * 而这几条口径恰好都能在源码上钉死，属于既有区域级守卫（`chapterStudioCopy.test.ts`）的同类做法：
 *
 * 1. **四项都在**：画幅 / 模型档位 / 分辨率 / 时长；
 * 2. **取值范围来自后端**：组件里不许出现比例、分辨率、时长的**硬编码候选清单**
 *    （写一份就会漂移：页面给 1080p、提交时被能力表拒掉）；
 * 3. **主操作唯一**：本组件里 `type="primary"` 只允许出现一次（唯一主色按钮）；
 * 4. **拿不到范围时不许假装可选**：四个下拉都有 disabled 分支；
 * 5. 四个值都真的随请求提交（`submitVideo` 里出现 ratio / duration_seconds / model / resolution）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const COMPONENT = resolve(HERE, 'StudioGenerateSettings.tsx')
const HOOK = resolve(HERE, '../useShotRequestPlan.ts')

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

/** 逐行去注释（不做跨行的朴素正则：字符串里的注释符会让整段被吞掉，变成假绿）。 */
function stripComments(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return ''
      return line
    })
    .join('\n')
}

test('阶段 3 生成设置：四项都在（画幅 / 模型档位 / 分辨率 / 时长）', () => {
  const source = stripComments(read(COMPONENT))
  for (const label of ["'画幅'", "'模型档位'", "'分辨率'", "'时长'"]) {
    assert.ok(source.includes(label), `缺少设置项 ${label}`)
  }
  for (const testid of ['generate-ratio', 'generate-model', 'generate-resolution', 'generate-duration']) {
    assert.ok(source.includes(testid), `缺少可交互项 ${testid}`)
  }
})

test('阶段 3 生成设置：取值范围来自后端，组件里不许写死候选清单', () => {
  const source = stripComments(read(COMPONENT))
  // 只允许出现「默认值」级别的字面量；不允许出现候选数组
  for (const forbidden of ["'1080p'", "'720p'", "'480p'", "'9:16'", "'4:3'", '16:9', '480p']) {
    assert.ok(!source.includes(forbidden), `组件里出现了硬编码的候选值「${forbidden}」——取值范围必须来自后端`)
  }
  // 取值一律从 options 里来
  for (const key of ['ratioOptions', 'modelOptions', 'resolutionOptions', 'durationOptions']) {
    assert.ok(source.includes(`options.${key}`), `没有使用后端下发的 ${key}`)
  }
})

test('阶段 3 生成设置：唯一主操作（本组件里 primary 只出现一次）', () => {
  const source = stripComments(read(COMPONENT))
  const primaryCount = (source.match(/type="primary"/g) ?? []).length
  assert.equal(primaryCount, 1, `主色按钮必须只有一个，实际 ${primaryCount} 个`)
  assert.ok(source.includes('data-testid="generate-video-cta"'), '缺少唯一主操作的落点标记')
})

test('阶段 3 生成设置：拿不到可选范围时下拉不可点（不假装可选）', () => {
  const source = stripComments(read(COMPONENT))
  /*
   * 改造后四项由同一段映射渲染，因此 disabled 是**按字段**算的：
   * `field.options.length === 0` → 该下拉禁用并显示「按默认」。
   * 这里钉住的仍是同一条口径：范畴为空时不许给一个假的可选列表。
   */
  assert.ok(
    /const\s+empty\s*=\s*field\.options\.length\s*===\s*0/.test(source),
    '缺少「该字段没有可选范围」的判定',
  )
  assert.ok(source.includes('disabled={empty}'), '没有把空范围接到下拉的 disabled 上')
  assert.ok(source.includes("placeholder={empty ? '按默认' : undefined}"), '空范围时没有说明"按默认"')
})

test('阶段 3 生成设置：四个值真的随请求提交（不是纯前端控件）', () => {
  const hook = stripComments(read(HOOK))
  assert.ok(/submitVideo\(\{/.test(hook), '找不到提交调用')
  const call = hook.slice(hook.indexOf('submitVideo({'), hook.indexOf('submitVideo({') + 900)
  for (const field of ['ratio:', 'duration_seconds:', 'model:', 'resolution:']) {
    assert.ok(call.includes(field), `提交请求里缺少 ${field}`)
  }
  assert.ok(call.includes('settings?.ratio'), '画幅必须取用户选的值')
  assert.ok(call.includes('settings?.resolution'), '分辨率必须取用户选的值')
  assert.ok(call.includes('settings?.model'), '模型档位必须取用户选的值')
  assert.ok(call.includes('settings?.durationSeconds'), '时长必须取用户选的值')
})

test('阶段 3 生成设置：可选范围与中文结论都来自后端计划字段', () => {
  const hook = stripComments(read(HOOK))
  for (const field of ['ratio_options', 'model_options', 'resolution_options', 'duration_options', 'settings_notes']) {
    assert.ok(hook.includes(field), `没有读取后端下发的 ${field}`)
  }
})
