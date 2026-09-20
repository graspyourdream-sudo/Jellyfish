/**
 * 「内部 ID 不进主界面」的回归测试（第三部分要求四 + 验收第 6 条）。
 *
 * 普通界面只留用户要决定的内容；供应商名、内部 ID、file_id / storage_key 归「技术详情」。
 * 后端提示里常内嵌这些标识，页面必须先把它们换成指路文案。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { containsInternalId, maskInternalIds, INTERNAL_ID_PLACEHOLDER } from './maskInternalIds.ts'

test('UUID 被替换成指路文案（主界面不再刷内部 ID）', () => {
  const raw = 'character 5ffc6a12-d91e-415d-b56e-09e86b988774：对象存储读取失败'
  const masked = maskInternalIds(raw)
  assert.equal(masked.includes('5ffc6a12-d91e-415d-b56e-09e86b988774'), false)
  assert.ok(masked.includes(INTERNAL_ID_PLACEHOLDER))
  assert.ok(masked.includes('对象存储读取失败'), '人话部分要保留')
})

test('file_id / storage_key / key= 形态都屏蔽', () => {
  const raw = '声音「test_voice」（file_id=1ebace78-b083-49fe-a86b-d17c524e501d）：storage_key=files/test.mp3'
  const masked = maskInternalIds(raw)
  assert.equal(masked.includes('1ebace78-b083-49fe-a86b-d17c524e501d'), false)
  assert.equal(masked.includes('files/test.mp3'), false)
  assert.ok(masked.includes('test_voice'), '业务名称保留')
})

test('裸字段名也换成业务说法（后端提示常见写法）', () => {
  const raw = '该帧槽位没有 file_id：请先上传或生成该帧。'
  const masked = maskInternalIds(raw)
  assert.equal(masked.includes('file_id'), false)
  assert.ok(masked.includes('文件编号'))
  assert.ok(masked.includes('请先上传或生成该帧'), '人话部分保留')
})

test('不含内部标识的文案原样返回', () => {
  const raw = '本镜已具备生成条件：提示词与参考帧齐全'
  assert.equal(maskInternalIds(raw), raw)
  assert.equal(containsInternalId(raw), false)
})

test('containsInternalId 能识别需要屏蔽的文案', () => {
  assert.equal(containsInternalId('key=files/a.png'), true)
  assert.equal(containsInternalId('shot_id=abc123'), true)
  assert.equal(containsInternalId('画幅 16:9、时长 5 秒'), false)
})
