/**
 * `shotRailModel.ts` 的单元测试（批量下载的范围判定是第 9 条的核心口径）。
 *
 * 覆盖：
 * 1. 全选只勾**可交付**的镜头；
 * 2. 勾选不改变"当前镜头"（选择集合是独立状态）——由纯函数签名保证；
 * 3. 空选择 → 自然语言错误 + 不给下载；
 * 4. 部分缺失 → 说出「包含 N 条 + 排除 M 条」；
 * 5. 一个可交付的都没有 → 明确说清原因、不给下载；
 * 6. 被排除的镜头逐条给原因。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  blockedReasonFor,
  countRailStates,
  isAllDeliverableSelected,
  railShotCode,
  selectAllDeliverable,
  summarizeRailSelection,
  toggleShotPick,
  type RailShotView,
} from './shotRailModel.ts'

function shot(partial: Partial<RailShotView> & { id: string }): RailShotView {
  return {
    index: 1,
    code: 'S001',
    title: '镜头',
    thumbnail: '',
    statusLabel: '待生成',
    statusTone: 'neutral',
    meta: '',
    hasDeliverableVideo: false,
    blockedReason: '',
    ...partial,
  }
}

const SHOTS: RailShotView[] = [
  shot({ id: 'a', index: 1, code: 'S001', title: '便利店 · 全景推进', hasDeliverableVideo: true, statusTone: 'success' }),
  shot({ id: 'b', index: 2, code: 'S002', title: '女孩进门 · 中景', statusTone: 'info' }),
  shot({ id: 'c', index: 3, code: 'S003', title: '现榨动作 · 特写', statusTone: 'danger', blockedReason: '生成失败，本次未计费、半成品不保留，可以直接重试。' }),
  shot({ id: 'd', index: 4, code: 'S004', title: '街道 · 空镜收尾', hasDeliverableVideo: true, statusTone: 'success' }),
]

test('镜头编号口径与后端交付清单一致（S001 形式，集内顺序）', () => {
  assert.equal(railShotCode(1), 'S001')
  assert.equal(railShotCode(12), 'S012')
  assert.equal(railShotCode(0), 'S000')
  assert.equal(railShotCode(Number.NaN), 'S000')
})

test('勾选只动选择集合：同一个镜头再点一次就取消，顺序稳定', () => {
  assert.deepEqual(toggleShotPick([], 'a'), ['a'])
  assert.deepEqual(toggleShotPick(['a'], 'b'), ['a', 'b'])
  assert.deepEqual(toggleShotPick(['a', 'b'], 'a'), ['b'])
  // 空 id 不改变选择（避免出现一个空字符串被当成"选了一个镜头"）
  assert.deepEqual(toggleShotPick(['a'], '  '), ['a'])
})

test('全选只勾可交付的镜头（没成片的镜头不会给用户添麻烦）', () => {
  assert.deepEqual(selectAllDeliverable(SHOTS), ['a', 'd'])
  assert.equal(isAllDeliverableSelected(SHOTS, ['a', 'd']), true)
  assert.equal(isAllDeliverableSelected(SHOTS, ['a']), false)
  // 一个可交付的都没有时，"全选"不应显示为选中态
  assert.equal(isAllDeliverableSelected([SHOTS[1], SHOTS[2]], []), false)
})

test('空选择：自然语言错误 + 不允许下载', () => {
  const summary = summarizeRailSelection(SHOTS, [])
  assert.equal(summary.selected, 0)
  assert.equal(summary.deliverable, 0)
  assert.equal(summary.canDownload, false)
  assert.match(summary.message, /还没有勾选镜头/)
  assert.match(summary.message, /全选/)
})

test('部分缺失：说清包含几条、排除几条', () => {
  const summary = summarizeRailSelection(SHOTS, ['a', 'b', 'c', 'd'])
  assert.equal(summary.selected, 4)
  assert.equal(summary.deliverable, 2)
  assert.equal(summary.blocked, 2)
  assert.equal(summary.canDownload, true)
  assert.match(summary.message, /本次会打包 2 条成片/)
  assert.match(summary.message, /另有 2 个已勾选镜头被排除/)
  assert.deepEqual(
    summary.blockedShots.map((item) => item.id),
    ['b', 'c'],
  )
})

test('全都不可交付：不给下载，并说清"请先生成"', () => {
  const summary = summarizeRailSelection(SHOTS, ['b', 'c'])
  assert.equal(summary.canDownload, false)
  assert.match(summary.message, /都还没有可交付的成片/)
  assert.match(summary.message, /请先生成/)
})

test('勾了不存在的镜头 id 时按"选中数"如实统计，不假装有内容', () => {
  const summary = summarizeRailSelection(SHOTS, ['a', 'not-exist'])
  assert.equal(summary.selected, 2)
  assert.equal(summary.deliverable, 1)
  assert.equal(summary.canDownload, true)
})

test('被排除的镜头逐条给原因；没给原因时用统一兜底句', () => {
  assert.match(blockedReasonFor(SHOTS[2]), /生成失败/)
  const noReason = shot({ id: 'x' })
  assert.equal(blockedReasonFor(noReason), '这个镜头还没有生成成功的成片，不能进交付包。')
})

test('胶片条头部计数：可交付 / 生成中 / 待生成 / 失败 与总数自洽', () => {
  const counts = countRailStates(SHOTS)
  assert.equal(counts.total, 4)
  assert.equal(counts.deliverable, 2)
  assert.equal(counts.generating, 1)
  assert.equal(counts.failed, 1)
  assert.equal(counts.pending, 0)
  assert.equal(counts.deliverable + counts.generating + counts.pending + counts.failed, counts.total)
})
