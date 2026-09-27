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

import { describeStorageReachability } from './assetProduction.ts'

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
