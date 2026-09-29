/**
 * 「广告项目创建失败」文案的守卫测试。
 *
 * 真机反馈的问题：点「创建并进入策划」在"后端没在运行"时只弹一句
 *
 * ```
 * 原因：Failed to fetch
 * 下一步：确认网络后直接再点一次「创建并进入策划」；如果一直失败，请稍后再试或联系管理员。
 * ```
 *
 * 用户看不懂，而且**照着做也不会好**（后端没起来时重试永远不会成功）。
 * 本测试守住四件事：
 *
 * 1. 「请求没送到服务」和「服务应答了但失败」被**分开**判定（判据是拿不到 HTTP 状态码）；
 * 2. 前者的文案点名**正在连的后端地址**（多 worktree 环境下这是第一排查信息）；
 * 3. 前者的"下一步"是**去启动服务**，而不是"再点一次"；
 * 4. 后者的原有文案与 `empty project` 内部标记的处理都不回退。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { OpenAPI } from '../../../services/generated/core/OpenAPI.ts'
import {
  backendBaseUrlLabel,
  describeAdProjectCreateFailure,
  isBackendUnreachable,
} from './adProjectCreateFailure.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `front/src` */
const SRC_ROOT = resolve(HERE, '../../..')

function readSrc(relPath: string): string {
  return readFileSync(resolve(SRC_ROOT, relPath), 'utf8')
}

/** 造一个"生成客户端在服务应答失败时抛的"错误（带 `.status`）。 */
function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number }
  error.status = status
  return error
}

/* --------------------------------------------------- ① 判据：有没有拿到状态码 */

test('① 判据：拿不到状态码才算「请求没送到」（有状态码一律不算）', () => {
  /* 浏览器原文各平台不同，都要认 */
  for (const message of [
    'Failed to fetch', // Chrome / Edge
    'Load failed', // Safari
    'NetworkError when attempting to fetch resource.', // Firefox
    'Network request failed', // polyfill / RN
  ]) {
    assert.equal(isBackendUnreachable(new TypeError(message)), true, `没认出来：${message}`)
  }
  /* 服务应答过 = 送到了：4xx / 5xx 都不属于"连不上" */
  for (const status of [400, 404, 409, 422, 500, 502]) {
    assert.equal(
      isBackendUnreachable(httpError(status, `Generic Error: status: ${status}`)),
      false,
      `HTTP ${status} 被误判成「连不上」——服务应答过就不是连不上`,
    )
  }
  /* 其它乱七八糟的输入不许抛错 */
  for (const value of [null, undefined, 'boom', 42, {}, new Error('empty project')]) {
    assert.equal(typeof isBackendUnreachable(value), 'boolean', `输入 ${String(value)} 时没有返回布尔`)
  }
})

/* ------------------------------------------- ② 连不上：点名地址 + 教怎么启动 */

test('② 连不上后端：原因里必须出现**正在连的后端地址**', () => {
  const original = OpenAPI.BASE
  try {
    OpenAPI.BASE = 'http://127.0.0.1:8010'
    assert.equal(backendBaseUrlLabel(), 'http://127.0.0.1:8010')
    const { reasonLine, nextStepLine } = describeAdProjectCreateFailure(new TypeError('Failed to fetch'))
    assert.ok(reasonLine.includes('连不上后端服务'), `原因没点明是"连不上"：${reasonLine}`)
    assert.ok(reasonLine.includes('http://127.0.0.1:8010'), `原因里没有后端地址：${reasonLine}`)
    assert.ok(!/Failed to fetch/.test(reasonLine), '不该把浏览器英文原文直接丢给用户')
    /* 下一步是"去启动服务"，而不是"再点一次" */
    assert.ok(nextStepLine.includes('启动像素小新.command'), `没告诉用户怎么把服务跑起来：${nextStepLine}`)
    assert.ok(nextStepLine.includes('模式未知'), '没给"怎么确认后端真的起来了"的可观察信号')
    assert.ok(nextStepLine.includes('创建并进入策划'), '没给重试入口')

    /* 地址末尾的斜杠不该显示成 `http://…:8010/` */
    OpenAPI.BASE = 'http://127.0.0.1:8010//'
    assert.equal(backendBaseUrlLabel(), 'http://127.0.0.1:8010')

    /* 同源部署（BASE 为空串）：不显示地址，也不许留下一对空括号 */
    OpenAPI.BASE = ''
    assert.equal(backendBaseUrlLabel(), '')
    const sameOrigin = describeAdProjectCreateFailure(new TypeError('Failed to fetch'))
    assert.ok(sameOrigin.reasonLine.includes('连不上后端服务'), '同源时也要说清是连不上')
    assert.ok(!sameOrigin.reasonLine.includes('（）'), `留了空括号：${sameOrigin.reasonLine}`)
  } finally {
    OpenAPI.BASE = original
  }
})

/* ------------------------------------------- ③ 服务应答了：原有口径不回退 */

test('③ 服务应答了但失败：保留「原因：<后端的话>」口径，且不误报连不上', () => {
  const failed = describeAdProjectCreateFailure(httpError(500, '数据库暂时不可用'))
  assert.ok(failed.reasonLine.includes('数据库暂时不可用'), '服务自己的原因没有如实显示')
  assert.ok(!failed.reasonLine.includes('连不上后端服务'), '5xx 被误报成"连不上"')
  assert.ok(failed.nextStepLine.includes('下一步：'), '没有给下一步')

  /* `empty project` 是 `createAdProject` 的内部标记：只说结论，不回显 */
  const empty = describeAdProjectCreateFailure(new Error('empty project'))
  assert.ok(!empty.reasonLine.includes('empty project'), '内部标记泄漏到了用户文案里')
  assert.ok(empty.reasonLine.includes('创建接口这次没有成功'), '内部标记时应回落到通用原因')

  /* 完全没有消息的异常也要给得出完整两行 */
  const bare = describeAdProjectCreateFailure(new Error(''))
  assert.ok(bare.reasonLine.startsWith('原因：'), '缺消息时没有给出原因行')
  assert.ok(bare.nextStepLine.startsWith('下一步：'), '缺消息时没有给出下一步行')
})

/* ------------------------------------------------- ④ 弹窗确实接上了这个判定 */

test('④ 弹窗接上了判定，并且原有三件事文案没被删掉', () => {
  const modal = readSrc('pages/aiStudio/project/AdProjectCreateModal.tsx')
  assert.ok(
    /describeAdProjectCreateFailure\(exc\)/.test(modal),
    '弹窗没有用新的失败文案判定（会退回只弹 `Failed to fetch`）',
  )
  /* 仓库既有守卫测试钉死的三条，不许因为本次改动消失 */
  assert.ok(/项目\*\*没有\*\*创建成功，也没有保存任何内容/.test(modal), '「有没有保存」那一行被删了')
  assert.ok(/data-testid="ad-create-error"/.test(modal), '创建失败的说明出口被删了')
  assert.ok(/项目已经保存/.test(modal), '「项目已经保存」的中间态被删了')
})
