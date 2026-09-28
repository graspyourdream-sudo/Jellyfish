/**
 * 底部固定操作条（`StickyActionBar`）的计数与文案单测。
 *
 * 这里钉住三件事：
 *   1. **口径复用**：就绪判定必须与结果区走同一份 `assetPrepStatus` 口径
 *      （本模块不重写公式，测试用同一对函数独立算一遍再对拍）；
 *   2. **数字全部来自真实入参**：待补资料来自同一份清单的状态计数、
 *      失败与待处理原样来自入参（不估算、不兜底成好看的数字）；
 *   3. **主区禁词**：固定条组件与其文案里不出现后台维度词
 *      （组件属于 `workbench/**` 的 `.tsx` 扫描面，连注释一起扫）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { assetPrepInputFromReadiness, resolveAssetPrepStatus } from '../../assetPrepStatus.ts'
import {
  MAIN_SCREEN_FORBIDDEN_SOURCE_TERMS,
  countByStatus,
  describePendingReview,
  type WorkbenchItemLike,
} from './workbenchState.ts'
import {
  PAYMENT_CONFIRM_NOTE,
  READINESS_LABEL,
  STICKY_ACTION_BAR_HEIGHT,
  describeActionBarPendingReview,
  describeCountValue,
  describeReadinessValue,
  isWorkbenchItemReady,
  resolveStickyActionBarCounts,
} from './stickyActionBarState.ts'

const here = dirname(fileURLToPath(import.meta.url))

/** 造一条契约项：只填本测试关心的字段，其余留空（= 后端没给）。 */
function item(patch: Partial<WorkbenchItemLike> = {}): WorkbenchItemLike {
  return { asset_type: 'character', asset_id: 'char-1', name: '苏晚棠', ...patch }
}

/** 已就绪 = 有提示词 + 有图片 + 已定版（与结果区同一口径）。 */
const doneItem = () =>
  item({
    asset_id: 'char-ready',
    prompt: { text: '正面全身，米色风衣', saved: true },
    image: { has_image: true, has_primary: true },
  })

test('就绪度：与 assetPrepStatus 的同一份口径逐项对拍（不自立公式）', () => {
  const rows: WorkbenchItemLike[] = [
    doneItem(),
    // 有提示词、没图片
    item({ asset_id: 'c2', prompt: { text: '正面全身', saved: true }, image: { has_image: false } }),
    // 有图片、没定版
    item({
      asset_id: 'c3',
      prompt: { text: '正面全身', saved: true },
      image: { has_image: true, has_primary: false },
    }),
    // 没提示词
    item({ asset_id: 'c4', image: { has_image: true, has_primary: true } }),
  ]
  const counts = resolveStickyActionBarCounts({ items: rows, failed: 0, pendingReview: 0 })

  const expected = rows.filter(
    (row) =>
      resolveAssetPrepStatus(
        assetPrepInputFromReadiness({
          has_pending_candidate: false,
          has_image_prompt: Boolean(String(row.prompt?.text ?? '').trim()),
          has_image: row.image?.has_image === true,
          has_primary: row.image?.has_primary === true,
        }),
      ).key === 'done',
  ).length

  assert.equal(expected, 1, '样例里只应有 1 项真的就绪（防样例本身失效）')
  assert.equal(counts.ready, expected)
  assert.equal(counts.total, rows.length)
})

test('就绪度：空清单不显示假进度（0 / 0 且百分比为 0）', () => {
  const counts = resolveStickyActionBarCounts({ items: [], failed: 0, pendingReview: 0 })
  assert.equal(describeReadinessValue(counts), '0 / 0')
  assert.equal(counts.readyPercent, 0)
})

test('就绪度：全部就绪时是 100%，一半就绪时是整除的百分比', () => {
  const all = resolveStickyActionBarCounts({
    items: [doneItem(), { ...doneItem(), asset_id: 'char-ready-2' }],
    failed: 0,
    pendingReview: 0,
  })
  assert.equal(describeReadinessValue(all), '2 / 2')
  assert.equal(all.readyPercent, 100)

  const half = resolveStickyActionBarCounts({
    items: [doneItem(), item({ asset_id: 'c-x' })],
    failed: 0,
    pendingReview: 0,
  })
  assert.equal(describeReadinessValue(half), '1 / 2')
  assert.equal(half.readyPercent, 50)
})

test('提示词只存了空白的项不算就绪（"存过"不等于"有内容"）', () => {
  const blank = item({
    prompt: { text: '   ', saved: true },
    image: { has_image: true, has_primary: true },
  })
  assert.equal(isWorkbenchItemReady(blank), false)
  assert.equal(isWorkbenchItemReady(doneItem()), true)
})

test('待补资料：来自同一份清单的状态计数，不是另算的一套', () => {
  const rows: WorkbenchItemLike[] = [
    item({ asset_id: 'a', status: { key: 'needs_profile', label: '待补资料' } }),
    item({ asset_id: 'b', status: { key: 'needs_profile', label: '待补资料' } }),
    item({ asset_id: 'c', status: { key: 'primary', label: '已定版' } }),
  ]
  const counts = resolveStickyActionBarCounts({ items: rows, failed: 0, pendingReview: 0 })
  assert.equal(counts.needsProfile, countByStatus(rows).needs_profile)
  assert.equal(counts.needsProfile, 2)
  assert.equal(describeCountValue(counts.needsProfile), '2 项')
})

test('失败 / 待处理：原样来自真实入参（不估算、不兜底成 0 或漂亮数字）', () => {
  const counts = resolveStickyActionBarCounts({ items: [doneItem()], failed: 3, pendingReview: 5 })
  assert.equal(describeCountValue(counts.failed), '3 项')
  assert.equal(describeActionBarPendingReview(counts.pendingReview), describePendingReview(5))
  assert.equal(describeActionBarPendingReview(counts.pendingReview), '待处理 5 项')

  // 没有待处理项时说"没有待处理项"，而不是显示一个"待处理 0 项"的假入口文案
  const none = resolveStickyActionBarCounts({ items: [doneItem()], failed: 0, pendingReview: 0 })
  assert.equal(describeActionBarPendingReview(none.pendingReview), '没有待处理项')
})

test('负数的失败 / 待处理计数不会渲染成负数（防御性收敛，不改真实数字）', () => {
  const counts = resolveStickyActionBarCounts({ items: [], failed: -2, pendingReview: -1 })
  assert.equal(counts.failed, 0)
  assert.equal(counts.pendingReview, 0)
  assert.equal(describeCountValue(-5), '0 项')
})

test('高度与付费说明是固定口径（设计包 §6：56px / 付费前会二次确认）', () => {
  assert.equal(STICKY_ACTION_BAR_HEIGHT, 56)
  assert.equal(PAYMENT_CONFIRM_NOTE, '付费前会二次确认')
  assert.equal(READINESS_LABEL, '资产就绪：')
})

test('固定条组件源码里不出现主区禁词（连注释一起扫）', () => {
  const source = readFileSync(join(here, 'StickyActionBar.tsx'), 'utf8')
  assert.ok(source.includes('data-testid="sticky-action-bar"'), '扫描目标必须是固定条组件本身')
  MAIN_SCREEN_FORBIDDEN_SOURCE_TERMS.forEach((term) => {
    assert.equal(source.includes(term), false, `固定条组件命中禁词「${term}」`)
  })
})
