/**
 * 商品（第五类资产）的状态词与卡片动作口径 —— 设计包 §9「商品『待上传商品图』规则」。
 *
 * 为什么单独钉一测：商品是**唯一不参与自动出图**的一类（图由人工上传 + 手动「设为定版」），
 * 但它又和其他四类共用同一套状态推导与卡片渲染。一旦有人把商品并回通用推导链，
 * 它就会被标成「可以生成」或「待生成提示词」—— 那等于把用户指到一条对商品不存在的路上。
 * 这类回归在行为上很难发现（页面看起来很"正常"），所以用纯函数断言 + 源码守卫一起钉住。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  MAIN_SCREEN_FORBIDDEN_SOURCE_TERMS,
  WORKBENCH_STATUS_LABEL,
  WORKBENCH_STATUS_ORDER,
  cardActionAvailability,
  countByStatus,
  deriveCardAction,
  deriveWorkbenchCommand,
  emptyStatusCounts,
  isWorkbenchSubmittable,
  workbenchStatusKey,
  workbenchStatusLabel,
  type WorkbenchItemLike,
} from './workbenchState.ts'

const here = dirname(fileURLToPath(import.meta.url))

/** 逐行剥注释（块注释 + 行注释）：扫「按钮文案」时注释里的说明不算命中。 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

/** 一个商品项：默认「还没有图」（= 待上传商品图）。 */
function product(overrides: Partial<WorkbenchItemLike> = {}): WorkbenchItemLike {
  return {
    asset_type: 'product',
    asset_id: 'p-1',
    name: '便携榨汁杯',
    status: null,
    prompt: { text: '', quality: null, saved: false },
    image: { has_image: false, has_primary: false },
    batch_eligible: false,
    ...overrides,
  }
}

/* --------------------------------------------------- 状态词：待上传商品图 */

test('商品没有图 → 状态词是「待上传商品图」（不是待补资料 / 可以生成）', () => {
  assert.equal(workbenchStatusKey(product()), 'needs_product_image')
  assert.equal(workbenchStatusLabel(product()), '待上传商品图')
})

test('商品的「待上传商品图」与「待补资料」是两个词，不许混用', () => {
  assert.equal(WORKBENCH_STATUS_LABEL.needs_product_image, '待上传商品图')
  assert.notEqual(WORKBENCH_STATUS_LABEL.needs_product_image, WORKBENCH_STATUS_LABEL.needs_profile)
  // 设计包 §9 明确不使用「待上传图片」这个说法
  assert.equal(WORKBENCH_STATUS_LABEL.needs_product_image.includes('待上传图片'), false)
})

test('商品上传完图 → 走「已有图片待选择」，定完版 → 走「已定版」', () => {
  assert.equal(workbenchStatusKey(product({ image: { has_image: true, has_primary: false } })), 'has_image')
  assert.equal(workbenchStatusKey(product({ image: { has_image: true, has_primary: true } })), 'primary')
})

test('商品即使有提示词也不许被标成“可以生成”（它没有出图通道）', () => {
  const withPrompt = product({ prompt: { text: '一杯鲜榨果汁', quality: null, saved: true } })
  assert.equal(workbenchStatusKey(withPrompt), 'needs_product_image')
})

test('商品即使被后端标成可以进批量，也不许进可出图计数', () => {
  assert.equal(isWorkbenchSubmittable('product'), false, '商品不在可提交类型里')
  const item = product({ image: { has_image: false }, batch_eligible: true })
  const command = deriveWorkbenchCommand({ items: [item], selectedKeys: ['product:p-1'] })
  assert.equal(command.counts.generatable, 0, '商品不能算进「可生成图片」')
  assert.equal(command.counts.products, 1)
  assert.equal(command.generateImagesCount, 0, '商品不能算进批量出图张数')
})

test('商品专用状态是一格独立计数，不与七个业务状态混在一起', () => {
  assert.equal(emptyStatusCounts().needs_product_image, 0)
  const counts = countByStatus([product(), product({ asset_id: 'p-2' })])
  assert.equal(counts.needs_product_image, 2)
  assert.equal(counts.needs_profile, 0, '商品不许被计进「待补资料」')
  assert.equal(counts.ready, 0, '商品不许被计进「可以生成」')
})

test('商品专用状态排在状态计数顺序的最后（前七个仍是业务状态）', () => {
  assert.equal(WORKBENCH_STATUS_ORDER[WORKBENCH_STATUS_ORDER.length - 1], 'needs_product_image')
  assert.deepEqual(WORKBENCH_STATUS_ORDER.slice(0, 7), [
    'needs_profile',
    'needs_prompt',
    'ready',
    'generating',
    'failed',
    'has_image',
    'primary',
  ])
})

/* ------------------------------------------- 混选口径：主区那一句必须逐字对 */

test('人物 + 商品混选：主区逐字给出设计包 §9 要求的那一句', () => {
  const character: WorkbenchItemLike = {
    asset_type: 'character',
    asset_id: 'c-1',
    name: '小林',
    status: null,
    prompt: { text: '正面半身', quality: null, saved: true },
    image: { has_image: false, has_primary: false },
    batch_eligible: true,
  }
  const command = deriveWorkbenchCommand({
    items: [character, product()],
    selectedKeys: ['character:c-1', 'product:p-1'],
    analysis: { generated: true, status: 'ready', hint: '' },
  })
  assert.equal(
    command.unsupportedNotice,
    '本轮有 1 项选中资产不参与出图：1 项商品：商品图不参与自动出图，由人工上传并手动「设为定版」 —— 请在商品卡片上点「上传商品图 / 设为定版」。',
  )
  // 参与出图的张数只按人物算：商品不计费、不出图
  assert.equal(command.generateImagesCount, 1)
})

test('只选商品时，主按钮不给假动作，直接说去哪做', () => {
  const command = deriveWorkbenchCommand({
    items: [product()],
    selectedKeys: ['product:p-1'],
    analysis: { generated: true, status: 'ready', hint: '' },
  })
  assert.equal(command.generateImagesCount, 0)
  assert.equal(command.primaryDisabled, true)
  assert.match(command.primaryDisabledReason, /上传商品图 \/ 设为定版/)
})

test('混选说明里的措辞不出现后台字段与原始状态值', () => {
  const command = deriveWorkbenchCommand({
    items: [product()],
    selectedKeys: ['product:p-1'],
    analysis: { generated: true, status: 'ready', hint: '' },
  })
  for (const term of MAIN_SCREEN_FORBIDDEN_SOURCE_TERMS) {
    assert.equal(command.unsupportedNotice.includes(term), false, `混选说明命中了禁词「${term}」`)
    assert.equal(command.primaryDisabledReason.includes(term), false, `禁用原因命中了禁词「${term}」`)
  }
})

/* ------------------------------------------------- 卡片动作：商品没有出图 */

test('商品卡片：只有「上传商品图 / 设为定版」，没有修改提示词、也没有生成图片', () => {
  /* 卡面的动作现在是「状态 → 唯一动作」的纯函数给的（设计包 §8 要求一张卡片只有一个主要操作）。
     所以商品的口径要在**映射函数**上断言，而不是在 JSX 分支上。 */
  const action = deriveCardAction(product())
  assert.equal(action.kind, 'upload_product_image')
  assert.equal(action.label, '上传商品图 / 设为定版')

  // 商品的动作永远不是出图（哪怕它带着提示词、甚至后端说它可进批量）
  const sneaky = product({
    prompt: { text: '一杯鲜榨果汁', quality: null, saved: true },
    batch_eligible: true,
    image: { has_image: false },
  })
  assert.equal(deriveCardAction(sneaky).kind, 'upload_product_image')
  assert.notEqual(deriveCardAction(sneaky).kind, 'generate')
  assert.notEqual(deriveCardAction(sneaky).kind, 'regenerate')
  assert.notEqual(deriveCardAction(sneaky).kind, 'generate_prompt')

  /* 源码守卫：卡面上不再自己拼动作文案，只渲染映射出来那一个按钮；
     并且卡片源码里不许出现出图 / 提示词动作的**按钮文案**（避免有人又把它们加回卡面）。
     先剥注释再扫 —— 注释里正是"这些动作已经搬到抽屉里"的说明，不能当命中。 */
  const source = stripComments(readFileSync(join(here, 'AssetCardGrid.tsx'), 'utf8'))
  assert.match(source, /deriveCardAction\(/, '卡面动作必须来自状态映射，不许自己拼')
  assert.match(source, /data-testid="asset-card-action"/, '卡面必须只有一个带标识的主要动作按钮')
  for (const forbidden of ['修改提示词', '重新生成提示词', '重新生成图片']) {
    assert.equal(source.includes(forbidden), false, `卡面上不许再出现「${forbidden}」`)
  }
  // 「生成图片」只允许作为**映射结果**的兜底文案出现在 workbenchState，不许在卡面写死
  assert.equal(source.includes('>生成图片<'), false, '卡面不许写死「生成图片」按钮')
})

test('商品动作在打不开商品资产页时如实禁用并说明（不给点了没反应的按钮）', () => {
  const blocked = cardActionAvailability(product(), { busy: false, canOpenAssetEditor: false })
  assert.equal(blocked.disabled, true)
  assert.match(blocked.reason, /商品/)
  const ok = cardActionAvailability(product(), { busy: false, canOpenAssetEditor: true })
  assert.equal(ok.disabled, false)
})

test('本轮进行中时，卡面唯一动作一律禁用并说明原因', () => {
  const result = cardActionAvailability(product(), { busy: true, canOpenAssetEditor: true })
  assert.equal(result.disabled, true)
  assert.match(result.reason, /本轮/)
})
