/**
 * 「演练 / 真实模式」纯逻辑的回归测试（Node 内置测试运行器，无需额外依赖）。
 *
 * 覆盖四条产品要求在前端的落地：
 *   1. 默认（后端 field 全在、dry_run=true）显示「演练模式」，且四个出口都是拦截；
 *   2. 「真实模式已开但没确认」必须与「演练模式」分开说，不能混成一句；
 *   3. 后端给的 enable_steps / how_to_enable 优先，缺失时本地生成可照做的中文步骤，
 *      且**不会**因为字段缺失就显示成「真实模式」；
 *   4. 被守卫拦住的错误要能解析出「原因 + 怎么开」，而普通 409 业务冲突不能被
 *      误判成门禁。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BLOCKED_REASON_DRY_RUN,
  BLOCKED_REASON_NOT_CONFIRMED,
  DEFAULT_CONFIRM_ENV,
  DEFAULT_GUARD_ENV,
  buildEnableSteps,
  buildRestoreSteps,
  deriveMode,
  describeBlockedError,
  parseRealRunMode,
  readBlockedErrorPayload,
  readModePayloadOrNull,
} from './realRunModeCore.ts'

/** 后端 `GET /orchestration/status` 的 data（演练模式）。 */
function dryRunPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guard: {
      dry_run: true,
      real_call_confirmed: false,
      env: 'JELLYFISH_DRY_RUN',
      confirm_env: 'JELLYFISH_REAL_LLM_CONFIRMED',
      mode: 'dry_run',
      mode_label: '演练模式',
      blocked_count: 2,
    },
    guard_status_text: 'DRY_RUN=开（JELLYFISH_DRY_RUN，未发起真实调用）',
    mode: 'dry_run',
    mode_label: '演练模式',
    mode_description: '当前不发任何真实请求，也不会产生费用（JELLYFISH_DRY_RUN 未显式设为 0）。',
    is_real_mode: false,
    restart_required_on_change: true,
    outlet_states: [
      { outlet: 'llm', label: '大模型', allowed: false, reason: 'dry_run', reason_text: '演练模式：不会发起真实请求。' },
      { outlet: 'image', label: '出图', allowed: false, reason: 'dry_run', reason_text: '演练模式：不会发起真实请求。' },
      { outlet: 'video', label: '出视频', allowed: false, reason: 'dry_run', reason_text: '演练模式：不会发起真实请求。' },
      { outlet: 'oss', label: '对象存储上传', allowed: false, reason: 'dry_run', reason_text: '演练模式：不会发起真实请求。' },
    ],
    enable_steps: ['第 1 步｜export JELLYFISH_DRY_RUN=0 与 export JELLYFISH_REAL_LLM_CONFIRMED=1。'],
    how_to_enable: '开启真实模式：export JELLYFISH_DRY_RUN=0 且 export JELLYFISH_REAL_LLM_CONFIRMED=1，然后重启后端进程。',
    restore_steps: ['第 1 步｜unset JELLYFISH_DRY_RUN JELLYFISH_REAL_LLM_CONFIRMED。'],
    how_to_restore: '恢复演练模式：unset 两个变量后重启后端进程。',
    mode_doc: 'docs/real-run-mode.md',
    dry_run_audit: [
      { action: 'blocked', detail: 'POST /api/v1/script-processing/divide 会真实调用大模型', target: 'llm' },
      { action: 'blocked_network', detail: 'host=api.deepseek.com', target: 'api.deepseek.com' },
      { action: 'allowed_real', detail: '不该出现在拦截列表里', target: 'llm' },
    ],
    ...overrides,
  }
}

/* ------------------------------------------------------------ 模式标识 */

test('演练模式：默认显示「演练模式」且四个出口全为拦截', () => {
  const view = parseRealRunMode(dryRunPayload())

  assert.equal(view.mode, 'dry_run')
  assert.equal(view.label, '演练模式')
  assert.equal(view.isRealMode, false)
  assert.equal(view.dryRun, true)
  assert.deepEqual(
    view.outlets.map((item) => item.outlet),
    ['llm', 'image', 'video', 'oss'],
  )
  assert.ok(view.outlets.every((item) => item.allowed === false))
  assert.ok(view.outlets.every((item) => item.reason === BLOCKED_REASON_DRY_RUN))
  assert.ok(view.description.includes('不会产生费用'))
})

test('真实模式（未确认）：与演练模式分开表达，仍然全部拦截', () => {
  const view = parseRealRunMode(
    dryRunPayload({
      mode: 'real_unconfirmed',
      mode_label: '真实模式（未确认）',
      guard: { dry_run: false, real_call_confirmed: false, env: DEFAULT_GUARD_ENV, confirm_env: DEFAULT_CONFIRM_ENV },
      outlet_states: [
        {
          outlet: 'llm',
          label: '大模型',
          allowed: false,
          reason: BLOCKED_REASON_NOT_CONFIRMED,
          reason_text: `真实模式开关已开，但缺少付费确认（${DEFAULT_CONFIRM_ENV} 不是 1）：仍然不会发起真实请求。`,
        },
      ],
    }),
  )

  assert.equal(view.mode, 'real_unconfirmed')
  assert.equal(view.label, '真实模式（未确认）')
  assert.equal(view.isRealMode, false)
  assert.equal(view.outlets.length, 4)
  assert.ok(view.outlets.every((item) => item.allowed === false))
  // 后端没给的出口按模式补齐，原因必须是「未确认」而不是「演练」
  assert.equal(view.outlets[1].reason, BLOCKED_REASON_NOT_CONFIRMED)
  assert.ok(view.outlets[1].reasonText.includes('缺少付费确认'))
})

test('真实模式：四个出口放行，但不等于放开撒钱（说明里仍有成本约束）', () => {
  const view = parseRealRunMode(
    dryRunPayload({
      mode: 'real',
      mode_label: '真实模式',
      mode_description: '真实模式已开：会发起真实付费调用，仍受成本确认、批量上限与去重幂等约束。',
      is_real_mode: true,
      guard: { dry_run: false, real_call_confirmed: true, env: DEFAULT_GUARD_ENV, confirm_env: DEFAULT_CONFIRM_ENV },
      outlet_states: [
        { outlet: 'llm', label: '大模型', allowed: true, reason: '', reason_text: '允许真实调用（会产生真实费用）。' },
      ],
    }),
  )

  assert.equal(view.label, '真实模式')
  assert.equal(view.isRealMode, true)
  assert.ok(view.outlets.every((item) => item.allowed === true))
  assert.ok(view.outlets.every((item) => item.reason === ''))
  assert.ok(view.description.includes('成本确认'))
})

test('字段缺失时不得默认显示真实模式', () => {
  // 只有 guard 没有 mode / outlet_states（旧接口）
  const view = parseRealRunMode({ guard: { dry_run: true, real_call_confirmed: false } })

  assert.equal(view.mode, 'dry_run')
  assert.equal(view.isRealMode, false)
  assert.equal(view.outlets.length, 4)
  assert.ok(view.outlets.every((item) => item.allowed === false))

  // 连 guard 都没有 → 模式未知，而不是「演练模式」也不是「真实模式」
  assert.equal(parseRealRunMode({}).mode, 'unknown')
  assert.equal(parseRealRunMode({}).label, '模式未知')
  assert.equal(readModePayloadOrNull({ data: 1 }), null)
})

test('deriveMode 只由两个开关决定', () => {
  assert.equal(deriveMode(null, null), 'unknown')
  assert.equal(deriveMode(true, false), 'dry_run')
  assert.equal(deriveMode(false, false), 'real_unconfirmed')
  assert.equal(deriveMode(false, true), 'real')
})

test('开启/恢复步骤本地兜底也是可照做的中文（含两个变量与重启）', () => {
  const enable = buildEnableSteps().join('\n')
  assert.ok(enable.includes(`${DEFAULT_GUARD_ENV}=0`))
  assert.ok(enable.includes(`${DEFAULT_CONFIRM_ENV}=1`))
  assert.ok(enable.includes('重启'))
  const restore = buildRestoreSteps().join('\n')
  assert.ok(restore.includes('unset'))
  assert.ok(restore.includes('dry_run'))

  // 后端给了 steps 时必须优先用后端的
  const view = parseRealRunMode(dryRunPayload())
  assert.deepEqual(view.enableSteps, ['第 1 步｜export JELLYFISH_DRY_RUN=0 与 export JELLYFISH_REAL_LLM_CONFIRMED=1。'])
})

test('拦截审计只取 blocked* 事件，并带中文原因', () => {
  const view = parseRealRunMode(dryRunPayload())

  assert.equal(view.blockedEvents.length, 2)
  // 最近的在最前面
  assert.equal(view.blockedEvents[0].action, 'blocked_network')
  assert.equal(view.blockedEvents[0].actionLabel, '出站兜底拦截（非本机地址）')
  assert.ok(view.blockedEvents.every((event) => event.reasonText.includes('演练模式')))
})

/* --------------------------------------------------- 拦截错误：原因 + 怎么开 */

test('结构化 409：能取出原因与开启步骤，并与「未确认」区分', () => {
  const dryError = {
    status: 409,
    payload: {
      meta: {
        error: {
          code: 'paid_outlet_blocked',
          reason: 'dry_run',
          reason_text: '当前是演练模式（JELLYFISH_DRY_RUN 未显式设为 0）：不会发起真实请求，也不会产生费用。',
          message: '[DRY_RUN] 已拦截「大模型」出口，未发起任何真实请求。',
          how_to_enable: '开启真实模式：export JELLYFISH_DRY_RUN=0 且 export JELLYFISH_REAL_LLM_CONFIRMED=1，然后重启后端进程。',
          enable_steps: ['第 1 步｜export JELLYFISH_DRY_RUN=0。', '第 2 步｜重启后端进程。'],
        },
      },
    },
  }

  const details = describeBlockedError(dryError)
  assert.equal(details.isBlocked, true)
  assert.equal(details.code, 'paid_outlet_blocked')
  assert.equal(details.reason, BLOCKED_REASON_DRY_RUN)
  assert.ok(details.title.includes('未发起真实请求'))
  assert.ok(details.reasonText.includes('不会产生费用'))
  assert.ok(details.howToEnable.includes('JELLYFISH_DRY_RUN=0'))
  assert.equal(details.enableSteps.length, 2)

  const unconfirmed = describeBlockedError({
    response: {
      status: 409,
      data: {
        message: '已关闭 JELLYFISH_DRY_RUN 但缺少用户确认：真实「出图」调用会产生费用，请显式设置 JELLYFISH_REAL_LLM_CONFIRMED=1 后再试',
        meta: { error: { code: 'paid_outlet_blocked', reason: 'real_call_not_confirmed' } },
      },
    },
  })
  assert.equal(unconfirmed.reason, BLOCKED_REASON_NOT_CONFIRMED)
  assert.ok(unconfirmed.title.includes('没确认'))
  assert.ok(unconfirmed.reasonText.includes('缺少付费确认'))
})

test('非门禁的 409 不能被当成演练拦截', () => {
  const details = describeBlockedError({ status: 409, message: '该镜头已存在生成任务，不能重复提交。' })

  assert.equal(details.isBlocked, false)
  assert.equal(details.reason, '')
  assert.ok(details.title.includes('409'))
  assert.equal(details.howToEnable, '')
})

test('消息里只有 DRY_RUN 字样但没有拦截语义时不算门禁', () => {
  const details = describeBlockedError({ status: 400, message: 'DRY_RUN 相关的参数不合法，请检查。' })

  assert.equal(details.isBlocked, false)
})

test('文本型错误（老请求层）也能解析出原因与开启步骤', () => {
  const details = describeBlockedError(
    new Error('[DRY_RUN] 已拦截「出图」出口，未发起任何真实请求。要放开请显式设置 JELLYFISH_DRY_RUN=0 且 JELLYFISH_REAL_LLM_CONFIRMED=1。'),
  )

  assert.equal(details.isBlocked, true)
  assert.equal(details.reason, BLOCKED_REASON_DRY_RUN)
  assert.ok(details.howToEnable.includes(`${DEFAULT_CONFIRM_ENV}=1`))
  assert.ok(details.enableSteps.join('\n').includes('重启'))
})

test('readBlockedErrorPayload 支持 message 里内嵌的 body JSON', () => {
  const payload = readBlockedErrorPayload({
    message:
      'Generic Error: status: 409; body: {"code":409,"message":"[DRY_RUN] 已拦截","meta":{"error":{"code":"paid_outlet_blocked","reason":"dry_run"}}}',
  })

  assert.equal(payload?.code, 'paid_outlet_blocked')
  assert.equal(payload?.reason, 'dry_run')
})
