/**
 * 结果区折叠状态机的单测（设计包 §7「结果区折叠规则」逐行对拍）。
 *
 * 这里钉住的是**行为口径**，不是实现细节：默认收起、提交即展开、正在生成保持展开、
 * 出现新结果自动展开、用户收起优先于自动展开、新一轮清掉手动收起、未读的口径。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

import type { TaskProgressSummary } from '../assetProduction.ts'
import {
  RESULT_AREA_COLLAPSED_HEIGHT,
  RESULT_AREA_CONTENT_MAX_HEIGHT,
  RESULT_AREA_EXPANDED_HEIGHT,
  countNewResults,
  describeResultAreaCollapsedLine,
  emptyResultAreaSnapshot,
  initialResultAreaState,
  isEmptyResultAreaSnapshot,
  reduceResultArea,
  resultAreaRunningCount,
  snapshotFromProgress,
  type ResultAreaState,
} from './resultAreaState.ts'

/** 汇总对象的最小构造器：只填本测试关心的字段，其余按"没有"给 0。 */
function progress(overrides: Partial<TaskProgressSummary> = {}): TaskProgressSummary {
  return {
    total: 0,
    done: 0,
    failed: 0,
    generating: 0,
    queued: 0,
    stopped: 0,
    dryRun: 0,
    finished: 0,
    percent: 0,
    hasFailure: false,
    failureReasons: [],
    ...overrides,
  }
}

const ctxOf = (overrides: Partial<TaskProgressSummary> = {}, busy = false) => ({
  snapshot: snapshotFromProgress(progress(overrides)),
  busy,
})

/* --------------------------------------------------------------- 摘要搬运 */

test('摘要只搬运真实数字：待提交与生成中一起算「还在跑」', () => {
  const snapshot = snapshotFromProgress(progress({ total: 5, done: 2, generating: 1, queued: 2, failed: 1 }))
  assert.equal(snapshot.total, 5)
  assert.equal(snapshot.done, 2)
  assert.equal(snapshot.running, 3, '生成中 1 + 待提交 2')
  assert.equal(snapshot.failed, 1)
})

test('空摘要判定与运行中计数', () => {
  assert.equal(isEmptyResultAreaSnapshot(emptyResultAreaSnapshot()), true)
  assert.equal(isEmptyResultAreaSnapshot(snapshotFromProgress(progress({ total: 1 }))), false)
  assert.equal(resultAreaRunningCount(snapshotFromProgress(progress({ generating: 2, queued: 1 }))), 3)
})

/* ------------------------------------------------------------ 收起态那一行 */

test('没有任务时收起态只说明还没有任务（不编造数量）', () => {
  assert.equal(describeResultAreaCollapsedLine(emptyResultAreaSnapshot(), 0), '本轮还没有任务')
})

test('收起态那一行保留：本轮数量 + 已完成 / 生成中 / 失败', () => {
  const snapshot = snapshotFromProgress(progress({ total: 3, done: 1, generating: 1, failed: 1 }))
  const line = describeResultAreaCollapsedLine(snapshot, 0)
  assert.equal(line, '本轮 3 项 · 已完成 1 · 生成中 1 · 失败 1')
})

test('没有失败时「失败 0」照样出现（数字位置固定，便于扫一眼）', () => {
  const snapshot = snapshotFromProgress(progress({ total: 2, done: 2 }))
  assert.equal(describeResultAreaCollapsedLine(snapshot, 0), '本轮 2 项 · 已完成 2 · 生成中 0 · 失败 0')
})

test('有未读时收起态标出「N 项新结果待处理」', () => {
  const snapshot = snapshotFromProgress(progress({ total: 2, done: 2 }))
  assert.match(describeResultAreaCollapsedLine(snapshot, 2), /2 项新结果待处理$/)
})

test('收起态摘要**不重复**标题里的「生成结果」（浏览器实测抓到过重复）', () => {
  const snapshot = snapshotFromProgress(progress({ total: 1, done: 1 }))
  const line = describeResultAreaCollapsedLine(snapshot, 0)
  assert.equal(line.includes('生成结果'), false, `摘要不该再写一遍标题：${line}`)
  // 渲染点上标题只出现一次
  const source = readFileSync(join(here, 'ResultArea.tsx'), 'utf8')
  const headings = (source.match(/>生成结果</g) ?? []).length
  assert.equal(headings, 1, `面板标题「生成结果」只允许出现一次，实际 ${headings} 次`)
})

test('收起态那一行不出现后台字段与原始状态值', () => {
  const snapshot = snapshotFromProgress(progress({ total: 3, done: 1, generating: 1, failed: 1 }))
  const line = describeResultAreaCollapsedLine(snapshot, 1)
  for (const forbidden of ['task_', 'file_id', 'asset_id', 'status', 'dry_run', 'submitting', 'generating']) {
    assert.equal(line.includes(forbidden), false, `收起态那一行不许出现 ${forbidden}`)
  }
})

/* --------------------------------------------------------------- 折叠状态机 */

test('挂载时没有任务 → 默认收起', () => {
  const state = initialResultAreaState(emptyResultAreaSnapshot())
  assert.equal(state.expanded, false)
  assert.equal(state.userCollapsed, false)
})

test('挂载时已有本轮任务（刷新后只读恢复）→ 直接展开并计成未读', () => {
  const snapshot = snapshotFromProgress(progress({ total: 2, done: 2 }))
  const state = initialResultAreaState(snapshot)
  assert.equal(state.expanded, true)
  assert.equal(countNewResults(state.seenDone, snapshot), 2, '恢复回来的结果属于"未被用户看过的结果"')
})

test('提交生成（新一轮）→ 展开，并清掉之前的手动收起', () => {
  const ctx = ctxOf({ total: 1, queued: 1 }, true)
  const collapsed: ResultAreaState = { expanded: false, userCollapsed: true, seenDone: 0 }
  const next = reduceResultArea(collapsed, { type: 'round_started' }, ctx)
  assert.equal(next.expanded, true)
  assert.equal(next.userCollapsed, false)
})

test('正在生成时保持展开', () => {
  const ctx = ctxOf({ total: 1, generating: 1 }, true)
  const state: ResultAreaState = { expanded: true, userCollapsed: false, seenDone: 0 }
  assert.equal(reduceResultArea(state, { type: 'sync' }, ctx).expanded, true)
})

test('出现新结果且用户没手动收起过 → 自动展开', () => {
  const ctx = ctxOf({ total: 1, done: 1 }, false)
  const state: ResultAreaState = { expanded: false, userCollapsed: false, seenDone: 0 }
  assert.equal(reduceResultArea(state, { type: 'sync' }, ctx).expanded, true)
})

test('用户手动收起后，新结果不再强行弹开（手动意图优先）', () => {
  const ctx = ctxOf({ total: 3, done: 3 }, false)
  const state: ResultAreaState = { expanded: false, userCollapsed: true, seenDone: 1 }
  const next = reduceResultArea(state, { type: 'sync' }, ctx)
  assert.equal(next.expanded, false, '不能把用户正在挑卡片的面板自己弹起来')
  assert.equal(countNewResults(next.seenDone, ctx.snapshot), 2, '未读继续累计，由收起态那一行标出')
})

test('点标题可以随时收起 / 再展开', () => {
  const ctx = ctxOf({ total: 2, done: 2 }, false)
  const expanded: ResultAreaState = { expanded: true, userCollapsed: false, seenDone: 0 }
  const collapsed = reduceResultArea(expanded, { type: 'user_toggle' }, ctx)
  assert.equal(collapsed.expanded, false)
  assert.equal(collapsed.userCollapsed, true)
  assert.equal(collapsed.seenDone, 2, '收起 = 明确表示看过了，未读随之清零')

  const reopened = reduceResultArea(collapsed, { type: 'user_toggle' }, ctx)
  assert.equal(reopened.expanded, true)
  assert.equal(reopened.userCollapsed, false)
})

test('展开态下不推进未读：收起之前「N 项新结果待处理」一直挂着', () => {
  const ctx = ctxOf({ total: 2, done: 2 }, false)
  const before: ResultAreaState = { expanded: true, userCollapsed: false, seenDone: 0 }
  const after = reduceResultArea(before, { type: 'sync' }, ctx)
  assert.equal(countNewResults(after.seenDone, ctx.snapshot), 2)
})

test('任务清空（清空结果卡片）后回到默认收起，手动收起标记一并清掉', () => {
  const ctx = ctxOf({}, false)
  const state: ResultAreaState = { expanded: true, userCollapsed: true, seenDone: 3 }
  const next = reduceResultArea(state, { type: 'sync' }, ctx)
  assert.deepEqual(next, { expanded: false, userCollapsed: false, seenDone: 0 })
})

test('未读永不为负：完成条数回退（清空后重跑）不会算出负数', () => {
  const snapshot = snapshotFromProgress(progress({ total: 1, done: 1 }))
  assert.equal(countNewResults(5, snapshot), 0)
})

/* ------------------------------------------------- 引用稳定（防无限重渲染） */

test('状态没变时必须返回**同一个**引用（否则 useEffect 喂 sync 会无限重渲染）', () => {
  const ctx = ctxOf({ total: 2, generating: 1 }, true)
  const stable: ResultAreaState = { expanded: true, userCollapsed: false, seenDone: 0 }
  // 连续 5 次同样输入的 sync：引用必须一直是同一个
  let current = stable
  for (let i = 0; i < 5; i += 1) {
    const next = reduceResultArea(current, { type: 'sync' }, ctx)
    assert.equal(next, current, `第 ${i + 1} 次 sync 换了新对象`)
    current = next
  }
})

test('反复 sync 一个"已完成且已展开"的状态同样保持引用稳定', () => {
  const ctx = ctxOf({ total: 1, done: 1 }, false)
  const state: ResultAreaState = { expanded: true, userCollapsed: false, seenDone: 0 }
  assert.equal(reduceResultArea(state, { type: 'sync' }, ctx), state)
})

test('真正发生变化时当然要换新对象（否则 UI 不动）', () => {
  const ctx = ctxOf({ total: 1, generating: 1 }, true)
  const state: ResultAreaState = { expanded: false, userCollapsed: false, seenDone: 0 }
  const next = reduceResultArea(state, { type: 'sync' }, ctx)
  assert.notEqual(next, state, '从收起到展开必须换引用')
  assert.equal(next.expanded, true)
})

/* ----------------------------------------------------------- 设计包尺寸口径 */

test('设计包给的三个高度口径没有被改掉', () => {
  assert.equal(RESULT_AREA_COLLAPSED_HEIGHT, 38)
  assert.equal(RESULT_AREA_EXPANDED_HEIGHT, 210)
  assert.equal(RESULT_AREA_CONTENT_MAX_HEIGHT, 172)
  // 硬约束：展开态不得长期挤压卡片主工作区 —— 内容区必须严格小于整块高度
  assert.ok(RESULT_AREA_CONTENT_MAX_HEIGHT < RESULT_AREA_EXPANDED_HEIGHT)
  assert.ok(RESULT_AREA_COLLAPSED_HEIGHT < RESULT_AREA_EXPANDED_HEIGHT)
})
