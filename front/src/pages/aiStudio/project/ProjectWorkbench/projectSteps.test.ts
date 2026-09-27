/**
 * 步骤判定的「全部资产都完成」口径（收口要求）。
 *
 * 关键：就绪判定必须覆盖范围内**每一个**资产 —— 一旦只检查前 24 个，
 * 第 25 个之后没定版的项目也会被判定为「资产准备已就绪」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PROJECT_STEP_ACTION_LABELS, buildContinueLabel, resolveProjectStep } from './projectSteps.ts'

function baseInput(assetCount: number, primaryCount: number | null) {
  return {
    chapterCount: 1,
    chaptersWithTextCount: 1,
    shotCount: 3,
    assetCounts: { characters: assetCount, scenes: 0, props: 0 },
    assetImageCount: assetCount,
    assetsWithImagePromptCount: assetCount,
    assetsWithPrimaryCount: primaryCount,
    shotsWithVideoPromptCount: 3,
    shotsWithAssetLinkCount: 3,
  }
}

test('第 25 个资产没定版 → 仍停在「资产准备」', () => {
  const resolution = resolveProjectStep(baseInput(30, 24))
  assert.equal(resolution.step, 'image_prep')
  assert.match(resolution.missing.join('；'), /6 个资产没有设定版图/)
})

test('全部 30 个都定版 → 越过资产准备', () => {
  const resolution = resolveProjectStep(baseInput(30, 30))
  assert.notEqual(resolution.step, 'image_prep')
})

test('恰好差一个（第 25 个）也要拦住', () => {
  const resolution = resolveProjectStep(baseInput(25, 24))
  assert.equal(resolution.step, 'image_prep')
  assert.match(resolution.missing.join('；'), /1 个资产没有设定版图/)
})

test('定版状态无法判定时不阻塞（避免项目被永久钉住）', () => {
  const resolution = resolveProjectStep(baseInput(30, null))
  assert.notEqual(resolution.step, 'image_prep')
})

test('提示词起步的项目：不要求剧本/分镜，先落整集提示词', () => {
  const resolution = resolveProjectStep({
    startMode: 'prompts',
    chapterCount: 1,
    chaptersWithTextCount: 0,
    shotCount: 0,
    shotsWithVideoPromptCount: 0,
    assetCounts: { characters: 0, scenes: 0, props: 0 },
  })
  assert.equal(resolution.step, 'video_prompt')
})

/* ----------------------------------------------- 「继续」按钮文案护栏（真实走查发现） */

test('「继续」按钮文案不许出现叠加的「继续」（真实浏览器走查：曾渲染成「继续：继续资产准备」）', () => {
  /*
   背景：动作名表 PROJECT_STEP_ACTION_LABELS 与「继续：」前缀是两个来源，
   主按钮又有两个渲染点（index.tsx / ProjectStepSummaryStrip.tsx）。
   只要动作名自带「继续」，就会渲染成「继续：继续资产准备」——
   这条护栏逐条拼一遍，保证任何时候都不会再叠加。
  */
  const keys = Object.keys(PROJECT_STEP_ACTION_LABELS) as (keyof typeof PROJECT_STEP_ACTION_LABELS)[]
  assert.ok(keys.length >= 6, '动作名表应覆盖全部步骤')
  for (const key of keys) {
    const label = buildContinueLabel(PROJECT_STEP_ACTION_LABELS[key])
    assert.equal(
      label.split('继续').length - 1,
      1,
      `步骤 ${String(key)} 的按钮文案「${label}」里「继续」出现了多次`,
    )
    assert.ok(label.startsWith('继续：'), `步骤 ${String(key)} 的按钮应带「继续：」前缀`)
    assert.ok(label.length > '继续：'.length, `步骤 ${String(key)} 的动作名不能是空的`)
  }
})

test('buildContinueLabel：空动作名时只给「继续」，不产生「继续：」这种半截文案', () => {
  assert.equal(buildContinueLabel(''), '继续')
  assert.equal(buildContinueLabel('   '), '继续')
  assert.equal(buildContinueLabel('资产准备'), '继续：资产准备')
  // 前后空白被去掉（动作名来自表，不该带空白进 UI）
  assert.equal(buildContinueLabel(' 资产准备 '), '继续：资产准备')
})
