/**
 * 第 2 步子页签词汇的护栏：**商品编辑页返回后必须落回商品页签**。
 *
 * 缺陷形态（真实路径断了，且不报错）：
 * 第 2 步商品卡片 →「上传图片 / 设为定版」→ 跳到
 * `/assets/products/<id>/edit?returnTo=%2Fprojects%2F<id>%3Fstep%3Dextract_assets%26tab%3Dproducts`，
 * 编辑完点返回 → `?tab=products` 被 `isAssetSubTab` 判假丢掉 → 落回"人物"页签。
 * 用户刚编辑的那件商品"不见了"，而 URL 里明明写着商品。
 *
 * 正反两侧：
 * - **正**：`products` 是合法子页签，且能换算成工作台的商品页签（往返闭环）；
 * - **反**：`actors` **没有**对应的工作台页签（演员不是项目资产类型），
 *   不能被默默当成人物 —— 认不出来的值必须回落默认页签，而不是猜。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ASSET_SUB_TABS,
  ASSET_SUB_TAB_LABELS,
  ASSET_SUB_TAB_TO_WORKBENCH_TAB,
  DEFAULT_ASSET_SUB_TAB,
  LEGACY_PANEL_ASSET_SUB_TABS,
  WORKBENCH_TAB_TO_ASSET_SUB_TAB,
  assetSubTabToWorkbenchTab,
  isAssetSubTab,
  resolveLegacyPanelSubTab,
} from './assetSubTab.ts'

test('正：products 是合法子页签，且有标签与对应的工作台页签', () => {
  assert.ok(isAssetSubTab('products'), '?tab=products 必须被认（否则商品编辑返回会掉页签）')
  assert.equal(ASSET_SUB_TAB_LABELS.products, '商品')
  assert.equal(ASSET_SUB_TAB_TO_WORKBENCH_TAB.products, 'product')
})

test('正：从商品编辑页返回的 URL 参数确实解析成商品页签', () => {
  assert.equal(assetSubTabToWorkbenchTab('products'), 'product')
})

test('正：五类资产在 ?tab= 词汇里都有对应项（往返闭环）', () => {
  const workbenchTabs = ['character', 'scene', 'prop', 'costume', 'product'] as const
  for (const tab of workbenchTabs) {
    const param = WORKBENCH_TAB_TO_ASSET_SUB_TAB[tab]
    assert.ok(isAssetSubTab(param), `${tab} 对应的参数 ${param} 必须是合法子页签`)
    assert.equal(
      assetSubTabToWorkbenchTab(param),
      tab,
      `${param} → ${tab} 的往返必须闭合`,
    )
  }
})

test('反：actors 没有对应的工作台页签（演员不是项目资产类型，不许默默当成人物）', () => {
  assert.ok(isAssetSubTab('actors'), 'actors 仍是合法的资产库页签')
  assert.equal(ASSET_SUB_TAB_TO_WORKBENCH_TAB.actors, undefined)
  assert.equal(assetSubTabToWorkbenchTab('actors'), 'character', '认不出来时回落默认页签，而不是把它说成某一类')
})

test('反：不认识的参数回落默认页签（不静默猜类型）', () => {
  assert.equal(isAssetSubTab('unknown-kind'), false)
  assert.equal(isAssetSubTab(null), false)
  assert.equal(assetSubTabToWorkbenchTab('unknown-kind'), 'character')
  assert.equal(assetSubTabToWorkbenchTab(null), 'character')
  assert.equal(DEFAULT_ASSET_SUB_TAB, 'roles')
})

test('反：旧提取确认页不会出现"选了却什么都没有"的商品栏', () => {
  assert.ok(!(LEGACY_PANEL_ASSET_SUB_TABS as readonly string[]).includes('products'))
  assert.equal(resolveLegacyPanelSubTab('products'), 'roles', '该页没有商品栏，必须明确回落到能渲染的页签')
  assert.equal(resolveLegacyPanelSubTab('props'), 'props', '能渲染的页签要原样保留')
})

test('护栏：ASSET_SUB_TABS 里角色与商品都必须真的在（删掉任一个这条就红）', () => {
  assert.deepEqual([...ASSET_SUB_TABS].sort(), ['actors', 'costumes', 'products', 'props', 'roles', 'scenes'])
})
