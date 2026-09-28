/**
 * 步骤判定的「全部资产都完成」口径（收口要求）。
 *
 * 关键：就绪判定必须覆盖范围内**每一个**资产 —— 一旦只检查前 24 个，
 * 第 25 个之后没定版的项目也会被判定为「资产准备已就绪」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DISPLAY_STEPS, PROJECT_STEPS, PROJECT_STEP_ACTION_LABELS, buildContinueLabel, resolveProjectStep } from './projectSteps.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

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

/* ------------------------------------------- 第 4 步的用户口径 + 唯一主入口 */

/**
 * 第 4 步的用户可见名字只有**一个**：**资产与声音检查**。
 *
 * 为什么钉住：这一步**不给**第二个声音入口（角色声音的唯一选择 / 更换入口在第 2 步的人物
 * 资产详情里，见 `VoiceBindingSection`），所以名字与说明都不许写成"在这一步绑定声音"。
 * 旧的「资产与声音绑定」「关联绑定」已经全部换掉，不许回来。
 */
test('第 4 步的用户口径是「资产与声音检查」（导航 / 步骤名 / 继续按钮三处同源）', () => {
  const display = DISPLAY_STEPS.find((step) => step.key === 'asset_binding')
  assert.ok(display, '五步里必须有第 4 步')
  assert.equal(display.label, '资产与声音检查')

  const internal = PROJECT_STEPS.find((step) => step.key === 'binding')
  assert.ok(internal, '内部步骤表里必须有 binding')
  assert.equal(internal.label, '资产与声音检查')

  assert.equal(PROJECT_STEP_ACTION_LABELS.binding, '资产与声音检查')
  assert.equal(buildContinueLabel(PROJECT_STEP_ACTION_LABELS.binding), '继续：资产与声音检查')
})

test('第 4 步的文案里不许出现「绑定」：这一步只核对，不在这里绑定声音', () => {
  /*
    口径来源：`shotVoiceInheritance.test.ts` 已钉住这一步的界面文案只指路回人物资产，
    不给「绑定 / 解绑 / 更换声音」这类动作词。这里把同一条不变式抬到步骤模型层 ——
    步骤名与说明会被导航、悬停提示、无章节时的入口面板原样渲染出去。
  */
  const step4Texts = [
    DISPLAY_STEPS.find((step) => step.key === 'asset_binding')?.label ?? '',
    DISPLAY_STEPS.find((step) => step.key === 'asset_binding')?.description ?? '',
    PROJECT_STEPS.find((step) => step.key === 'binding')?.label ?? '',
    PROJECT_STEPS.find((step) => step.key === 'binding')?.description ?? '',
    PROJECT_STEP_ACTION_LABELS.binding,
  ]
  step4Texts.forEach((text) => {
    assert.equal(text.includes('绑定'), false, `第 4 步的文案不许出现「绑定」：${text}`)
  })

  const oldNames = ['资产与声音绑定', '把声音绑定到镜头', '把资产与声音绑定到镜头', '关联绑定']
  const allStepTexts = [
    ...DISPLAY_STEPS.flatMap((step) => [step.label, step.description]),
    ...PROJECT_STEPS.flatMap((step) => [step.label, step.description]),
    ...Object.values(PROJECT_STEP_ACTION_LABELS),
  ]
  oldNames.forEach((old) => {
    const hits = allStepTexts.filter((text) => text.includes(old))
    assert.deepEqual(hits, [], `旧名「${old}」不许回到步骤文案里：${hits.join(' / ')}`)
  })
})

/**
 * 同屏只能有**一个**推荐下一步的主入口（真实 1440×900 走查：曾经同一屏渲染出三个
 * 蓝色实心的「继续：资产准备」）。
 *
 * 收口后的分工：
 *   - 第 2 步（资产工作台）→ 底部固定操作条上的那颗按钮；
 *   - 其余步骤 → 步骤摘要条上的那颗按钮（没有固定条，它就是唯一入口）；
 *   - 顶部项目上下文条 → 只做导航，一律默认样式。
 *
 * 三处**共用同一份** `continueLabel` / `continueDisabledReason` / `onContinue`
 * （见 `index.tsx`），所以这里只钉"样式权重"，不新建第二套文案来源。
 */
test('「继续」主按钮全屏只有一个：第 2 步归底部固定条，摘要条与顶部上下文降级', () => {
  const indexSource = readFileSync(join(HERE, 'index.tsx'), 'utf8')
  const stripSource = readFileSync(join(HERE, 'components/ProjectStepSummaryStrip.tsx'), 'utf8')
  const barSource = readFileSync(join(HERE, 'components/workbench/StickyActionBar.tsx'), 'utf8')

  // 顶部项目上下文条（项目 / 当前集 / 步骤状态）里不许再有同权重的主按钮。
  assert.equal(
    (indexSource.match(/type="primary"/g) ?? []).length,
    0,
    '顶部项目上下文区不许出现主要样式按钮：推荐下一步的主入口在步骤内容区',
  )
  // 摘要条的主按钮权重由调用方决定，且第 2 步必须降级。
  assert.match(stripSource, /continuePrimary\?: boolean/, '摘要条要接受调用方给的权重开关')
  assert.equal(
    (stripSource.match(/type="primary"/g) ?? []).length,
    0,
    '摘要条必须通过开关给权重，不许写死主要样式',
  )
  assert.match(indexSource, /continuePrimary=\{!workbenchOwnsContinuePrimary\}/, '第 2 步必须把摘要条降级')
  // 底部固定条是第 2 步唯一的主入口：整个文件只许有一个主要样式按钮。
  assert.equal(
    (barSource.match(/type="primary"/g) ?? []).length,
    1,
    '底部固定条上只许有一个主要样式按钮（步骤主按钮）',
  )
  assert.match(barSource, /data-testid="sticky-action-bar-continue"/, '固定条的主按钮要有稳定 testid')
})
