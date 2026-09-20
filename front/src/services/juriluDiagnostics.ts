/**
 * 巨日禄抓取失败的**脱敏诊断**文案（纯函数，可单测）。
 *
 * 为什么单独抽出来（2026-09-20 真实验收踩到）：
 *   第二步 `getStoryboardPage` 三个 scriptId 全部 **HTTP 200**，只是响应里的 records
 *   被 msgpack 编码了、旧解析器没识别 —— 但页面提示写的是
 *   「接口阶段 **getScriptPage**｜HTTP 200」，把失败阶段报错了，看起来像第一步被拒。
 *   这里按诊断里的**真实证据**判断阶段：第一步非 2xx / 没取到 scriptId → getScriptPage；
 *   第一步成功但第二步某条解析 0 条或报错 → getStoryboardPage（并带上第二步自己的状态码）。
 *
 * 铁律：只输出状态码、布尔值、阶段名、编码名与计数，**绝不回显任何凭证或正文**。
 */

type AnyRecord = Record<string, unknown>

/** 诊断里单条第二步尝试的形状（后端 `storyboard_attempts[i]`）。 */
export interface StoryboardAttemptShape {
  script_id?: unknown
  status?: unknown
  error?: unknown
  parsed_count?: unknown
  payload_shape?: AnyRecord
}

const STAGE_SCRIPT = 'getScriptPage'
const STAGE_STORYBOARD = 'getStoryboardPage'

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as AnyRecord) : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item)).filter((item) => item.trim() !== '')
}

/** 第二步有没有失败（解析 0 条，或接口直接报错）。 */
export function findFailedStoryboardAttempt(diag: AnyRecord): StoryboardAttemptShape | null {
  const attempts = Array.isArray(diag.storyboard_attempts) ? diag.storyboard_attempts : []
  for (const raw of attempts) {
    const attempt = asRecord(raw)
    if (!attempt) continue
    const parsed = asNumber(attempt.parsed_count)
    const hasError = String(attempt.error ?? '').trim() !== ''
    if (hasError || parsed === 0) return attempt as StoryboardAttemptShape
  }
  return null
}

/** 判定失败真正发生在哪一步（拿不到证据时不硬编成第一步）。 */
export function resolveJuriluFailureStage(diag: AnyRecord): { stage: string; status: unknown } {
  const scriptStatus = asNumber(diag.script_status)
  if (scriptStatus !== null && scriptStatus >= 400) {
    return { stage: STAGE_SCRIPT, status: diag.script_status }
  }
  const scriptCount = asNumber(diag.script_records_count)
  if (scriptStatus === null && scriptCount === null) {
    // 第一步根本没跑起来（例如没带凭证就在本地被拦下）
    const stage = String(diag.stage ?? '').trim()
    return { stage: stage || STAGE_SCRIPT, status: scriptStatus }
  }
  if (scriptCount === 0) {
    return { stage: `${STAGE_SCRIPT}（未取到 scriptId）`, status: diag.script_status }
  }
  const failed = findFailedStoryboardAttempt(diag)
  if (failed) return { stage: STAGE_STORYBOARD, status: failed.status }
  return { stage: String(diag.stage ?? '').trim() || STAGE_SCRIPT, status: diag.script_status ?? diag.http_status }
}

/** 第二步「0 条」时说清楚：是接口没给数据，还是给了但我们没解析出来。 */
export function describeStoryboardZeroRecords(attempt: StoryboardAttemptShape | null): string {
  if (!attempt) return ''
  const shape = asRecord(attempt.payload_shape) ?? {}
  const decodeErrors = asStringList(shape.decode_errors)
  const unsupported = asStringList(shape.unsupported_encodings)
  const counts = asRecord(shape.record_counts) ?? {}
  const parsedTotal = Object.values(counts).reduce<number>((sum, value) => sum + (asNumber(value) ?? 0), 0)
  const status = asNumber(attempt.status)

  if (decodeErrors.length) {
    return `响应声明编码 ${decodeErrors.join('/')}，但载荷没解开（我方解析问题，不是接口拒绝）`
  }
  if (unsupported.length) {
    return `响应用了暂不支持的编码 ${unsupported.join('/')}（需要补解析器）`
  }
  if (parsedTotal > 0) {
    return `响应里其实有 ${parsedTotal} 条记录，但一条也没落成分镜（解析问题）`
  }
  if (status !== null && status < 300) {
    return '接口返回 2xx 但确实没有分镜记录（不是凭证问题）'
  }
  return ''
}

/** 兼容旧调用名的别名。 */
export const extractJuriluDiagnosticsFromError = (error: unknown): string =>
  extractJuriluDiagnostics(error)

/**
 * 从巨日禄抓取失败里提取**脱敏诊断**。
 * 后端把诊断放在统一信封的 `meta.diagnostics`（不含任何凭证）。
 */
export function extractJuriluDiagnostics(error: unknown): string {
  const diag = asRecord((error as { diagnostics?: unknown } | undefined)?.diagnostics)
  if (!diag) return ''
  const { stage, status } = resolveJuriluFailureStage(diag)
  const parts: string[] = []
  if (stage) parts.push(`接口阶段 ${stage}`)
  if (status !== undefined && status !== null && `${status}`.trim() !== '') parts.push(`HTTP ${status}`)
  parts.push(`带 Cookie：${diag.has_cookie ? '是' : '否'}`)
  parts.push(`额外带 Authorization：${diag.has_auth ? '是' : '否'}`)
  const mode = String(diag.auth_header_mode ?? '').trim()
  if (mode) parts.push(`授权模式 ${mode}`)
  if (stage.startsWith(STAGE_STORYBOARD)) {
    const detail = describeStoryboardZeroRecords(findFailedStoryboardAttempt(diag))
    if (detail) parts.push(detail)
  }
  return parts.join('｜')
}
