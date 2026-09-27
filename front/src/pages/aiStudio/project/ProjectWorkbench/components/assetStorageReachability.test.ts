/**
 * 长期存储可达性：只在本机的图**必须**被标成「不能用于后续生成」。
 *
 * 真实演练（2026-09-27）：出图服务把图生成出来了（已计费），但它自己上传 OSS 被拒
 * （HTTP 403 AccessDenied / bucket acl）。页面当时把这张只在本机的图当普通结果展示，
 * 用户会以为它就是项目的长期资产、后续出视频能直接拿它当参考帧——实际下游取不到，
 * 真发出去就是花钱买一次注定失败的调用。
 *
 * 本文件钉死判定口径：只认后端回包，不猜、不脑补地址。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canAdoptResult,
  describeFailureReasonWithStorageNote,
  describeStorageReachability,
} from './assetProduction.ts'

test('有公网长期地址 → 既是长期资产，也能进后续生成', () => {
  const r = describeStorageReachability({
    ossUrl: 'https://ai-shortdrama-assets.oss-cn-beijing.aliyuncs.com/a.png',
    imageUrl: 'generated-images/character/a.png',
  })
  assert.equal(r.localOnly, false)
  assert.equal(r.note, '')
})

test('只有本机地址 → 标记为仅本机，并说明不能用于后续生成', () => {
  const r = describeStorageReachability({ ossUrl: '', imageUrl: 'generated-images/character/a.png' })
  assert.equal(r.localOnly, true)
  assert.match(r.note, /不能用于后续生成/)
  assert.match(r.note, /本机/)
})

test('临时地址（出图服务本机结果）同样算仅本机', () => {
  const r = describeStorageReachability({ ossUrl: '', imageUrl: '/files/tmp/a.png' })
  assert.equal(r.localOnly, true)
})

test('没有任何产物 → 不标注（没有东西可谈）', () => {
  const r = describeStorageReachability({ ossUrl: '', imageUrl: '' })
  assert.equal(r.localOnly, false)
  assert.equal(r.note, '')
})

test('只有长期地址、没有临时地址 → 不标注', () => {
  const r = describeStorageReachability({ ossUrl: 'https://cdn.example.com/a.png', imageUrl: '' })
  assert.equal(r.localOnly, false)
})

test('空白字符不算长期地址（不许因为一串空格就当成可达）', () => {
  const r = describeStorageReachability({ ossUrl: '   ', imageUrl: 'generated-images/a.png' })
  assert.equal(r.localOnly, true)
})

test('演练占位地址不贴「仅本机」标签（它不是"只在本机的图"，它压根不是图）', () => {
  const r = describeStorageReachability({
    ossUrl: '',
    imageUrl: 'https://dry-run.invalid/generated/character/a.png',
  })
  assert.equal(r.localOnly, false)
  assert.equal(r.note, '')
})

test('存储失败且拿不到本机图 → 失败原因里必须提醒"可能已经计费"', () => {
  const text = describeFailureReasonWithStorageNote({
    error_message: '出图成功但 OSS 上传失败：OSS 上传返回 HTTP 403 AccessDenied：bucket acl',
    outcome: 'failed',
  })
  assert.match(text, /长期存储环节/)
  assert.match(text, /已经计费/)
  assert.match(text, /确认/)
})

test('非存储类失败不追加这个提醒（不许到处加噪音）', () => {
  const text = describeFailureReasonWithStorageNote({ outcome: 'failed' })
  assert.doesNotMatch(text, /已经计费/)
})

// —— 采纳入口：部分成功（有图）也必须能采纳 ——

test('部分成功且图可取 → 可以采纳（这正是花了钱要救回来的那种）', () => {
  assert.equal(
    canAdoptResult({
      status: 'failed',
      outcome: 'partial_failed',
      imageUrl: '/images/乌鸦_主图_01_03.png',
      adoptedImageId: null,
    }),
    true,
  )
})

test('纯失败、没有图 → 不给采纳入口', () => {
  assert.equal(
    canAdoptResult({ status: 'failed', outcome: 'failed', imageUrl: '', adoptedImageId: null }),
    false,
  )
})

test('演练占位图 → 不给采纳入口', () => {
  assert.equal(
    canAdoptResult({
      status: 'failed',
      outcome: 'partial_failed',
      imageUrl: 'https://dry-run.invalid/x.png',
      adoptedImageId: null,
    }),
    false,
  )
})

test('已经采纳过 → 不再重复给（避免重复登记产物）', () => {
  assert.equal(
    canAdoptResult({
      status: 'done',
      outcome: 'ok',
      imageUrl: 'https://cdn.example.com/a.png',
      adoptedImageId: 46,
    }),
    false,
  )
})

test('正常成功且有图 → 可以采纳', () => {
  assert.equal(
    canAdoptResult({
      status: 'done',
      outcome: 'ok',
      imageUrl: 'https://cdn.example.com/a.png',
      adoptedImageId: null,
    }),
    true,
  )
})
