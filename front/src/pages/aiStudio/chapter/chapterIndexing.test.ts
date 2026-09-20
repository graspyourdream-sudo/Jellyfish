/**
 * 章节序号算法的回归测试。
 *
 * 关键用例：现有章节 index 为 1 和 3 时，新建章节必须得到 4
 * （用「数量 + 1」会算出 3，直接撞上已存在的第 3 章）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { nextChapterIndex } from './chapterIndexing.ts'

test('现有 index 为 1、3 → 新建得到 4（不是 3）', () => {
  assert.equal(nextChapterIndex([1, 3]), 4)
})

test('空项目 → 从 1 开始', () => {
  assert.equal(nextChapterIndex([]), 1)
})

test('乱序与重复 index 也按最大值推进', () => {
  assert.equal(nextChapterIndex([2, 5, 4]), 6)
  assert.equal(nextChapterIndex([3, 3, 3]), 4)
  assert.equal(nextChapterIndex([1, 2, 3, 4]), 5)
})

test('章节数量与最大 index 不一致时以最大 index 为准', () => {
  // 数量是 2，但最大 index 是 3：数量 + 1 = 3 会撞车
  assert.equal(nextChapterIndex([1, 3]), 4)
  // 数量是 3，最大 index 是 10
  assert.equal(nextChapterIndex([1, 5, 10]), 11)
})

test('脏值（null / undefined / NaN）不参与最大值计算', () => {
  assert.equal(nextChapterIndex([null, undefined]), 1)
  assert.equal(nextChapterIndex([2, Number.NaN, undefined]), 3)
})

test('只接受数字，字符串不会被误当成序号', () => {
  assert.equal(nextChapterIndex(['3' as unknown as number, 1]), 2)
})
