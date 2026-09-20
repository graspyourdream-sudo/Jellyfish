/**
 * 巨日禄失败诊断文案测试（`node --test`）。
 *
 * 锁死真实踩过的那个坑：第二步 getStoryboardPage 三个请求全 200、只是记录没解析出来，
 * 页面却报成「接口阶段 getScriptPage｜HTTP 200」——阶段报错会把人带偏到凭证排查上。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  describeStoryboardZeroRecords,
  extractJuriluDiagnostics,
  findFailedStoryboardAttempt,
  resolveJuriluFailureStage,
} from './juriluDiagnostics.ts'

function err(diagnostics: Record<string, unknown>) {
  return { diagnostics }
}

test('第一步 401 → 阶段就是 getScriptPage', () => {
  const text = extractJuriluDiagnostics(
    err({ getScriptPage_url: 'https://video.jurilu.com/api/x', script_status: 401, has_cookie: true, has_auth: false, auth_header_mode: 'none' }),
  )
  assert.match(text, /接口阶段 getScriptPage/)
  assert.match(text, /HTTP 401/)
  assert.match(text, /带 Cookie：是/)
  assert.match(text, /额外带 Authorization：否/)
})

test('第一步 200 + 第二步解析 0 条 → 阶段必须报 getStoryboardPage，不能再说 getScriptPage', () => {
  const text = extractJuriluDiagnostics(
    err({
      getScriptPage_url: 'https://video.jurilu.com/api/x',
      script_status: 200,
      script_records_count: 3,
      has_cookie: true,
      has_auth: false,
      auth_header_mode: 'none',
      storyboard_attempts: [
        { script_id: '2936083', status: 200, parsed_count: 0, payload_shape: { encodings: ['json', 'msgpack'], record_counts: { msgpack: 41 } } },
      ],
    }),
  )
  assert.match(text, /接口阶段 getStoryboardPage/)
  assert.doesNotMatch(text, /接口阶段 getScriptPage/)
  assert.match(text, /41 条/)
})

test('第二步 401 → 报第二步的 401，而不是第一步的 200', () => {
  const text = extractJuriluDiagnostics(
    err({
      script_status: 200,
      script_records_count: 1,
      storyboard_attempts: [{ script_id: '9', status: 401, error: 'HTTP 401', parsed_count: 0 }],
    }),
  )
  assert.match(text, /接口阶段 getStoryboardPage/)
  assert.match(text, /HTTP 401/)
})

test('第一步拿到 0 个 scriptId → 明确说未取到 scriptId', () => {
  const text = extractJuriluDiagnostics(err({ script_status: 200, script_records_count: 0, has_cookie: true }))
  assert.match(text, /getScriptPage（未取到 scriptId）/)
})

test('本地就被拦下（没发请求）→ 不谎报阶段与状态', () => {
  const diag = { has_cookie: false, has_auth: false, auth_header_mode: 'none' }
  assert.deepEqual(resolveJuriluFailureStage(diag), { stage: 'getScriptPage', status: null })
  const text = extractJuriluDiagnostics(err(diag))
  assert.doesNotMatch(text, /HTTP null/)
})

test('第二步载荷没解开 → 明确说是解析问题，不是接口拒绝', () => {
  const detail = describeStoryboardZeroRecords({
    status: 200,
    parsed_count: 0,
    payload_shape: { declared_encodings: ['msgpack'], decode_errors: ['msgpack'] },
  })
  assert.match(detail, /载荷没解开/)
  assert.match(detail, /我方解析问题/)
})

test('第二步用了不支持的编码 → 说清要补解析器', () => {
  const detail = describeStoryboardZeroRecords({
    status: 200,
    parsed_count: 0,
    payload_shape: { declared_encodings: ['protobuf'], unsupported_encodings: ['protobuf'] },
  })
  assert.match(detail, /暂不支持的编码 protobuf/)
})

test('第二步确实 0 条（接口给的就是空）→ 不推给凭证', () => {
  const detail = describeStoryboardZeroRecords({
    status: 200,
    parsed_count: 0,
    payload_shape: { encodings: ['json'], record_counts: {} },
  })
  assert.match(detail, /确实没有分镜记录/)
  assert.match(detail, /不是凭证问题/)
})

test('没有第二步证据时不硬编阶段说明', () => {
  assert.equal(describeStoryboardZeroRecords(null), '')
  assert.equal(findFailedStoryboardAttempt({}), null)
})

test('凭证/正文一个字都不能出现在诊断里', () => {
  const text = extractJuriluDiagnostics(
    err({
      script_status: 200,
      script_records_count: 3,
      has_cookie: true,
      has_auth: false,
      auth_header_mode: 'none',
      storyboard_attempts: [{ script_id: '1', status: 200, parsed_count: 0, error: '', payload_shape: { raw_head: '{"code":0' } }],
    }),
  )
  assert.doesNotMatch(text, /Authorization=/)
  assert.doesNotMatch(text, /eyJ/)
})
