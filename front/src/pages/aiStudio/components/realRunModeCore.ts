/**
 * 「演练模式 / 真实模式」的纯逻辑（不依赖 React，可直接跑 node --test）。
 *
 * 本文件回答三个问题，供角标组件与错误展示复用：
 *   1. 后台现在是演练还是真实模式？（含「真实模式已开但没确认」这一中间态）
 *   2. 四个付费出口（llm / image / video / oss）各自放不放行、为什么？
 *   3. 一次失败是不是被守卫拦住的？是的话**原因**是什么、**怎么开真实模式**？
 *
 * 硬约束：
 *   - 后端是唯一权威：模式与出口放行一律以后端字段为准，前端不自己猜；
 *   - 后端字段缺失（旧版本接口）时退回本地默认文案，但**不能**默认显示「真实模式」；
 *   - 「演练模式所以不发真实请求」与「真实模式已开但没确认」必须分开说，否则用户
 *     会以为改一个环境变量就够了。
 */

export type RealRunMode = 'dry_run' | 'real_unconfirmed' | 'real' | 'unknown'

export type RealRunOutlet = 'llm' | 'image' | 'video' | 'oss'

export type OutletAllowState = {
  outlet: string
  /** 中文出口名（大模型 / 出图 / 出视频 / 对象存储上传） */
  label: string
  /** 当前是否允许真实调用 */
  allowed: boolean
  /** 机器可读原因：dry_run | real_call_not_confirmed | ''（放行时为空） */
  reason: string
  /** 中文原因说明 */
  reasonText: string
}

export type RealRunModeView = {
  mode: RealRunMode
  /** 中文模式名：演练模式 / 真实模式（未确认） / 真实模式 / 模式未知 */
  label: string
  /** 一句话说明：会不会发真实请求、会不会花钱 */
  description: string
  isRealMode: boolean
  /** 后端 guard.dry_run（null = 还没取到 / 字段缺失） */
  dryRun: boolean | null
  realCallConfirmed: boolean | null
  /** 后端原文，例如「DRY_RUN=开（JELLYFISH_DRY_RUN，未发起真实调用）」 */
  guardText: string
  env: string
  confirmEnv: string
  /**
   * 开关来源：`env`（进程环境变量）/ `dotenv`（backend/.env）/ `default`（两处都没配）。
   *
   * 页面只**显示**来源，绝不提供「点一下就切真实模式」的开关：
   * 切模式必须改配置 + 重启进程（见 enableSteps），这是有意的权限边界。
   */
  switchSource: string
  /** 中文来源标签，例如「进程环境变量」「backend/.env」「默认（未显式配置）」 */
  switchSourceLabel: string
  /** 真实模式是不是由 backend/.env 打开的（后端会就此打启动告警） */
  dotenvRealMode: boolean
  /** 后端给的真实付费启动告警原文（只有 dotenv 打开真实模式时才有） */
  startupWarning: string
  /** 改完环境变量是否需要重启后端进程 */
  restartRequired: boolean
  outlets: OutletAllowState[]
  /** 中文开启步骤（优先用后端给的，缺失时本地生成） */
  enableSteps: string[]
  howToEnable: string
  restoreSteps: string[]
  howToRestore: string
  doc: string
  /** 最近被拦截的记录（后端 dry_run_audit 里的 blocked* 事件） */
  blockedEvents: BlockedAuditEvent[]
}

export type BlockedAuditEvent = {
  action: string
  /** 中文动作名 */
  actionLabel: string
  detail: string
  target: string
  reason: string
  reasonText: string
}

/** 后端门禁的机器可读错误码（paid_outlet_guard.BLOCKED_ERROR_CODE）。 */
export const PAID_OUTLET_BLOCKED_CODE = 'paid_outlet_blocked'

export const BLOCKED_REASON_DRY_RUN = 'dry_run'
export const BLOCKED_REASON_NOT_CONFIRMED = 'real_call_not_confirmed'

export const DEFAULT_GUARD_ENV = 'JELLYFISH_DRY_RUN'
export const DEFAULT_CONFIRM_ENV = 'JELLYFISH_REAL_LLM_CONFIRMED'
export const DEFAULT_MODE_DOC = 'docs/real-run-mode.md'

/** 开关来源的中文标签（后端没给标签时的兜底；只展示，不含任何密钥）。 */
export const DEFAULT_SOURCE_LABEL: Record<string, string> = {
  env: '进程环境变量',
  dotenv: 'backend/.env',
  default: '默认（未显式配置 = 演练）',
}

/** 把后端给的来源码 + 标签归一成人能读的中文（只展示，不含任何密钥）。 */
export function sourceLabelOf(rawSource: string, rawLabel: string): string {
  const label = String(rawLabel ?? '').trim()
  if (label) return label
  const code = String(rawSource ?? '').trim()
  if (DEFAULT_SOURCE_LABEL[code]) return DEFAULT_SOURCE_LABEL[code]
  return code || DEFAULT_SOURCE_LABEL.default
}

export const MODE_LABEL: Record<RealRunMode, string> = {
  dry_run: '演练模式',
  real_unconfirmed: '真实模式（未确认）',
  real: '真实模式',
  unknown: '模式未知',
}

export const OUTLET_LABELS: Record<string, string> = {
  llm: '大模型',
  image: '出图',
  video: '出视频',
  oss: '对象存储上传',
}

export const OUTLET_ORDER: string[] = ['llm', 'image', 'video', 'oss']

const OUTLET_TARGETS: Record<string, string> = {
  llm: '真实调用大模型（按 token 计费）',
  image: '真实出图（按张计费）',
  video: '真实出视频（按次计费）',
  oss: '真实上传对象存储（产生存储与流量费用）',
}

const AUDIT_LABELS: Record<string, string> = {
  blocked: '被演练模式拦截',
  blocked_unconfirmed: '真实模式未确认，被拦截',
  blocked_network: '出站兜底拦截（非本机地址）',
  allowed_real: '已放行（真实调用）',
  guard_installed: '出站兜底已安装',
}

const START_COMMAND = 'cd backend && uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000'
const VERIFY_COMMAND = 'curl -s http://localhost:8000/api/v1/studio/llm/orchestration/status'

/** 演练模式下为什么拒绝、以及这不是配额问题。 */
export function dryRunReasonText(env: string): string {
  return `当前是演练模式（${env} 未显式设为 0）：不会发起真实请求，也不会产生费用。`
}

/** 真实模式开关已开但缺少付费确认。 */
export function notConfirmedReasonText(confirmEnv: string): string {
  return `真实模式开关已开，但缺少付费确认（${confirmEnv} 不是 1）：仍然不会发起真实请求。`
}

/** 本地生成的「怎么开真实模式」步骤（后端没给时用，口径与后端一致）。 */
export function buildEnableSteps(env = DEFAULT_GUARD_ENV, confirmEnv = DEFAULT_CONFIRM_ENV): string[] {
  return [
    `第 1 步｜设置两个开关（二选一，都生效，但进程环境变量优先于 backend/.env）：` +
      `① 在启动后端的那个终端里 export ${env}=0 与 export ${confirmEnv}=1；` +
      `② 或把这两行写进 backend/.env（也生效，但后端启动时会打真实付费告警）。`,
    `第 2 步｜重启后端进程（外部改不了已启动进程的环境变量，必须重启）：${START_COMMAND}。`,
    `第 3 步｜验证当前模式：执行 ${VERIFY_COMMAND}，确认 data.mode 为 "real"、` +
      'data.guard.real_call_confirmed 为 true、data.switch_source 为 "env"/"dotenv"；' +
      '页面顶部角标应显示「真实模式」。',
    `第 4 步｜恢复演练：unset ${env} ${confirmEnv}（.env 里若也写了要一并清掉）后重启进程，` +
      `角标回到「演练模式」。完整说明见 ${DEFAULT_MODE_DOC}。`,
  ]
}

/** 本地生成的「怎么关回演练」步骤。 */
export function buildRestoreSteps(env = DEFAULT_GUARD_ENV, confirmEnv = DEFAULT_CONFIRM_ENV): string[] {
  return [
    `第 1 步｜在启动后端的终端里 unset ${env} ${confirmEnv}（或显式 export ${env}=1）；` +
      '并检查 backend/.env 里是否写了这两个键，写了就一并删掉或把演练开关改回 1。',
    '第 2 步｜重启后端进程。',
    `第 3 步｜验证：执行 ${VERIFY_COMMAND}，确认 data.mode 为 "dry_run"、data.guard.dry_run 为 true；` +
      '页面角标应显示「演练模式」。',
  ]
}

export function buildHowToEnable(env = DEFAULT_GUARD_ENV, confirmEnv = DEFAULT_CONFIRM_ENV): string {
  return (
    `开启真实模式：export ${env}=0 且 export ${confirmEnv}=1（写进 backend/.env 同样生效，` +
    `但进程环境变量优先），然后重启后端进程；用 ${VERIFY_COMMAND} 确认 data.mode="real"。` +
    `详见 ${DEFAULT_MODE_DOC}。`
  )
}

export function buildHowToRestore(env = DEFAULT_GUARD_ENV, confirmEnv = DEFAULT_CONFIRM_ENV): string {
  return `恢复演练模式：unset ${env} ${confirmEnv}（或 ${env}=1）后重启后端进程，未设置时默认就是演练模式。`
}

/* ------------------------------------------------------------------ 解析 */

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key]
  return typeof value === 'string' ? value.trim() : ''
}

function readBool(source: Record<string, unknown>, key: string): boolean | null {
  const value = source[key]
  return typeof value === 'boolean' ? value : null
}

function readStringList(source: Record<string, unknown>, key: string): string[] {
  const value = source[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
}

function isRealRunMode(value: string): value is RealRunMode {
  return value === 'dry_run' || value === 'real_unconfirmed' || value === 'real'
}

/** 由两个开关推导模式（后端没给 mode 字段时的兜底，不依赖任何前端猜测）。 */
export function deriveMode(dryRun: boolean | null, realCallConfirmed: boolean | null): RealRunMode {
  if (dryRun === null) return 'unknown'
  if (dryRun) return 'dry_run'
  return realCallConfirmed ? 'real' : 'real_unconfirmed'
}

export function describeMode(
  mode: RealRunMode,
  env = DEFAULT_GUARD_ENV,
  confirmEnv = DEFAULT_CONFIRM_ENV,
): string {
  if (mode === 'dry_run') return dryRunReasonText(env)
  if (mode === 'real_unconfirmed') return notConfirmedReasonText(confirmEnv)
  if (mode === 'real') return '真实模式已开：会发起真实付费调用，仍受成本确认、批量上限与去重幂等约束。'
  return '读不到后端守卫状态，无法确认当前是演练还是真实模式；在确认之前按「不会真花钱」对待。'
}

function parseOutletStates(
  source: Record<string, unknown>,
  mode: RealRunMode,
  env: string,
  confirmEnv: string,
): OutletAllowState[] {
  const raw = Array.isArray(source.outlet_states) ? source.outlet_states : []
  const parsed = new Map<string, OutletAllowState>()
  for (const item of raw) {
    const record = asRecord(item)
    const outlet = readString(record, 'outlet')
    if (!outlet) continue
    const allowed = readBool(record, 'allowed') === true
    parsed.set(outlet, {
      outlet,
      label: readString(record, 'label') || OUTLET_LABELS[outlet] || outlet,
      allowed,
      reason: readString(record, 'reason'),
      reasonText:
        readString(record, 'reason_text') ||
        (allowed ? '允许真实调用（会产生真实费用）。' : mode === 'dry_run' ? dryRunReasonText(env) : notConfirmedReasonText(confirmEnv)),
    })
  }
  // 后端没给的出口按当前模式补齐，保证四个出口始终可见（绝不显示成「放行」）。
  return OUTLET_ORDER.map((outlet) => {
    const known = parsed.get(outlet)
    if (known) return known
    const allowed = mode === 'real'
    return {
      outlet,
      label: OUTLET_LABELS[outlet] ?? outlet,
      allowed,
      reason: allowed ? '' : mode === 'dry_run' ? BLOCKED_REASON_DRY_RUN : BLOCKED_REASON_NOT_CONFIRMED,
      reasonText: allowed
        ? '允许真实调用（会产生真实费用）。'
        : mode === 'dry_run'
          ? dryRunReasonText(env)
          : notConfirmedReasonText(confirmEnv),
    }
  })
}

function parseBlockedEvents(source: Record<string, unknown>, env: string, confirmEnv: string): BlockedAuditEvent[] {
  const raw = Array.isArray(source.dry_run_audit) ? source.dry_run_audit : []
  const events: BlockedAuditEvent[] = []
  for (const item of raw) {
    const record = asRecord(item)
    const action = readString(record, 'action')
    if (!action.startsWith('blocked')) continue
    const reason = action === 'blocked_unconfirmed' ? BLOCKED_REASON_NOT_CONFIRMED : BLOCKED_REASON_DRY_RUN
    events.push({
      action,
      actionLabel: AUDIT_LABELS[action] ?? action,
      detail: readString(record, 'detail'),
      target: readString(record, 'target'),
      reason,
      reasonText: reason === BLOCKED_REASON_DRY_RUN ? dryRunReasonText(env) : notConfirmedReasonText(confirmEnv),
    })
  }
  return events.slice(-5).reverse()
}

/** 后端 `/orchestration/status` 的 data → 角标要的视图模型。 */
export function parseRealRunMode(payload: unknown): RealRunModeView {
  const source = asRecord(payload)
  const guard = asRecord(source.guard)
  const dryRun = readBool(guard, 'dry_run')
  const realCallConfirmed = readBool(guard, 'real_call_confirmed')
  const env = readString(guard, 'env') || readString(source, 'env') || DEFAULT_GUARD_ENV
  const confirmEnv = readString(guard, 'confirm_env') || readString(source, 'confirm_env') || DEFAULT_CONFIRM_ENV
  const modeText = readString(source, 'mode')
  const mode = isRealRunMode(modeText) ? modeText : deriveMode(dryRun, realCallConfirmed)
  const enableSteps = readStringList(source, 'enable_steps')
  const restoreSteps = readStringList(source, 'restore_steps')
  // 出口状态：后端给了就用后端的；旧接口没有 outlet_states 时按模式补齐，
  // 补齐结果保守——只有确认为「真实模式」才显示放行。
  const outlets = parseOutletStates(source, mode, env, confirmEnv)
  return {
    mode,
    label: mode === 'unknown' ? MODE_LABEL.unknown : readString(source, 'mode_label') || MODE_LABEL[mode],
    description: readString(source, 'mode_description') || describeMode(mode, env, confirmEnv),
    isRealMode: readBool(source, 'is_real_mode') ?? mode === 'real',
    dryRun,
    realCallConfirmed,
    guardText: readString(source, 'guard_status_text'),
    env,
    confirmEnv,
    switchSource: readString(source, 'switch_source') || readString(guard, 'source') || 'default',
    switchSourceLabel: sourceLabelOf(
      readString(source, 'switch_source') || readString(guard, 'source'),
      readString(source, 'switch_source_label') || readString(guard, 'source_label') || readString(source, 'source_label'),
    ),
    dotenvRealMode: readBool(source, 'dotenv_real_mode') ?? readBool(guard, 'dotenv_real_mode') ?? false,
    startupWarning: readString(source, 'startup_warning') || readString(guard, 'startup_warning'),
    restartRequired: readBool(source, 'restart_required_on_change') !== false,
    outlets,
    enableSteps: enableSteps.length ? enableSteps : buildEnableSteps(env, confirmEnv),
    howToEnable: readString(source, 'how_to_enable') || buildHowToEnable(env, confirmEnv),
    restoreSteps: restoreSteps.length ? restoreSteps : buildRestoreSteps(env, confirmEnv),
    howToRestore: readString(source, 'how_to_restore') || buildHowToRestore(env, confirmEnv),
    doc: readString(source, 'mode_doc') || DEFAULT_MODE_DOC,
    blockedEvents: parseBlockedEvents(source, env, confirmEnv),
  }
}

/** 只有拿到 guard 字段才算「读到了状态」，否则角标要明确说读不到。 */
export function readModePayloadOrNull(payload: unknown): Record<string, unknown> | null {
  const source = asRecord(payload)
  return Object.keys(asRecord(source.guard)).length > 0 ? source : null
}

/* ------------------------------------------------------ 拦截错误：原因 + 怎么开 */

export type BlockedErrorDetails = {
  /** 是否被守卫拦住（不是的话只有 message） */
  isBlocked: boolean
  code: string
  /** dry_run | real_call_not_confirmed | '' */
  reason: string
  /** 中文原因 */
  reasonText: string
  /** 面向用户的标题 */
  title: string
  /** 后端/原始错误消息（清理过 body JSON 噪音） */
  message: string
  howToEnable: string
  enableSteps: string[]
  httpStatus: number | null
}

function readRawMessage(error: unknown): string {
  if (error instanceof Error) return error.message.trim()
  if (typeof error === 'string') return error.trim()
  // 非 Error 对象也常带 message（测试替身、被序列化过的异常、散装错误对象）
  const plain = asRecord(error).message
  if (typeof plain === 'string' && plain.trim()) return plain.trim()
  return ''
}

/** 从错误里找后端信封的 `meta.error`（结构化明细就在这里）。 */
export function readBlockedErrorPayload(error: unknown): Record<string, unknown> | null {
  const candidates: unknown[] = []
  const wrapped = asRecord(error)
  const response = asRecord(wrapped.response)
  const body = asRecord(response.data)
  candidates.push(asRecord(wrapped.meta).error)
  candidates.push(asRecord(asRecord(wrapped.payload).meta).error)
  candidates.push(asRecord(asRecord(wrapped.body).meta).error)
  candidates.push(asRecord(asRecord(body).meta).error)
  candidates.push(asRecord(asRecord(wrapped.data).meta).error)
  for (const candidate of candidates) {
    const record = asRecord(candidate)
    if (Object.keys(record).length > 0) return record
  }
  // 有些请求层把整个响应体塞进 message（"… body: {…}"），再从文本里捞一次。
  const parsed = parseBodyFromMessage(readRawMessage(error))
  if (parsed) {
    const envelope = asRecord(asRecord(parsed).meta).error
    const record = asRecord(envelope)
    if (Object.keys(record).length > 0) return record
    if (typeof parsed.code === 'string') return parsed
  }
  return null
}

function parseBodyFromMessage(message: string): Record<string, unknown> | null {
  const index = message.indexOf('body:')
  if (index < 0) return null
  try {
    const parsed: unknown = JSON.parse(message.slice(index + 'body:'.length).trim())
    return asRecord(parsed)
  } catch {
    return null
  }
}

function readStatus(error: unknown): number | null {
  const direct = asRecord(error).status
  if (typeof direct === 'number') return direct
  const responseStatus = asRecord(asRecord(error).response).status
  return typeof responseStatus === 'number' ? responseStatus : null
}

function sanitizeMessage(error: unknown): string {
  const text = readRawMessage(error)
  if (!text) return ''
  const parsed = parseBodyFromMessage(text)
  if (parsed) {
    const message = readString(parsed, 'message')
    if (message) return message
    const detail = readString(parsed, 'detail')
    if (detail) return detail
  }
  return text
}

function looksLikeDryRunBlock(text: string): boolean {
  if (!/DRY_RUN/i.test(text)) return false
  return /拦截|已拦截/.test(text) || text.includes(DEFAULT_GUARD_ENV)
}

function looksLikeUnconfirmedBlock(text: string): boolean {
  return /缺少用户确认|缺少付费确认|未确认真实调用|真实模式开关已开/.test(text)
}

/**
 * 一次失败 → 「是不是被守卫拦住 + 原因 + 怎么开」。
 *
 * 判定顺序：结构化信封（code/reason）→ 消息文本 → 兜底。**绝不**把所有 409 都
 * 当成门禁（409 也可能是业务冲突），只有 code 命中或文本明确命中才算。
 */
export function describeBlockedError(error: unknown, fallbackEnv = DEFAULT_GUARD_ENV, fallbackConfirmEnv = DEFAULT_CONFIRM_ENV): BlockedErrorDetails {
  const payload = readBlockedErrorPayload(error)
  const httpStatus = readStatus(error)
  const message = sanitizeMessage(error)
  const code = payload ? readString(payload, 'code') : ''
  const payloadReason = payload ? readString(payload, 'reason') : ''
  const matched = code === PAID_OUTLET_BLOCKED_CODE || Boolean(payloadReason) || looksLikeDryRunBlock(JSON.stringify(payload ?? {})) || looksLikeDryRunBlock(message) || looksLikeUnconfirmedBlock(message)

  if (!matched) {
    return {
      isBlocked: false,
      code,
      reason: '',
      reasonText: '',
      title: httpStatus === null ? '请求未送达服务' : `请求失败（HTTP ${httpStatus}）`,
      message: message || '未知错误',
      howToEnable: '',
      enableSteps: [],
      httpStatus,
    }
  }

  const reason =
    payloadReason ||
    (payload && looksLikeUnconfirmedBlock(JSON.stringify(payload)) ? BLOCKED_REASON_NOT_CONFIRMED : '') ||
    (looksLikeUnconfirmedBlock(message) ? BLOCKED_REASON_NOT_CONFIRMED : BLOCKED_REASON_DRY_RUN)
  const isUnconfirmed = reason === BLOCKED_REASON_NOT_CONFIRMED
  const payloadRecord = payload ?? {}
  const guardInfo = asRecord(payloadRecord.guard)
  const env = readString(guardInfo, 'env') || readString(payloadRecord, 'env') || fallbackEnv
  const confirmEnv =
    readString(guardInfo, 'confirm_env') || readString(payloadRecord, 'confirm_env') || fallbackConfirmEnv
  const reasonText =
    (payload ? readString(payload, 'reason_text') : '') ||
    (isUnconfirmed ? notConfirmedReasonText(confirmEnv) : dryRunReasonText(env))
  const steps = payload ? readStringList(payload, 'enable_steps') : []
  return {
    isBlocked: true,
    code: code || PAID_OUTLET_BLOCKED_CODE,
    reason,
    reasonText,
    title: isUnconfirmed ? '真实模式已开但没确认，仍未发起真实请求' : '被演练守卫拦住，未发起真实请求',
    message: message || reasonText,
    howToEnable: (payload ? readString(payload, 'how_to_enable') : '') || buildHowToEnable(env, confirmEnv),
    enableSteps: steps.length ? steps : buildEnableSteps(env, confirmEnv),
    httpStatus,
  }
}

/** 出口的中文「会花什么钱」说明（角标详情用）。 */
export function outletTargetText(outlet: string): string {
  return OUTLET_TARGETS[outlet] ?? '真实调用（会产生真实费用）'
}
