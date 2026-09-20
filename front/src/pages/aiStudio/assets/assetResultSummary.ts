/**
 * 出图结果口径（纯逻辑，不依赖 React / antd，可直接被 `node --test` 覆盖）。
 *
 * 这个文件只回答四个问题：
 *   1. 这次出图**到底算不算成功**？（`partial_failed` 这类「部分失败」绝不能算成功）
 *   2. **成功几条 / 失败几条**？（要整数计数，且不能只报总数）
 *   3. 失败时**真实原因是什么**？（上游原文优先，取不到时才给解释性兜底文案）
 *   4. 用户**下一步能做什么**？（可重试上传 / 检查 OSS 配置）
 *
 * 背景（真实故障）：出图服务在上游图片**已生成**、但它自己 **OSS 上传失败**时返回
 * `partial_failed`。旧页面把这个结果当成功透传，用绿色成功 Alert 渲染，而且丢掉了真正的
 * 错误消息 —— 用户看到「成功」，其实图没进 OSS、根本采纳不了。
 *
 * 三条硬约束：
 *   A. **部分失败不是成功。** `partial_failed` / `oss_failed` / 混合结果一律不得渲染成
 *      绿色成功 Alert；失败原因必须可见。
 *   B. **`ok` 字段不可信，但 status/outcome 优先于 `ok`。** 旧后端对 `partial_failed`
 *      恒返回 `ok: true`，所以只要 status/outcome 认得出来就以它为准；只有当 status 完全
 *      无法识别时才退回 `ok` 布尔。
 *   C. **新字段有就用，没有就逐级回退，绝不白屏。** 计数优先级为
 *      `ok_count/failed_count`（新）→ `by_status`（旧）→ `results` 逐行 → `total`（只报总数）。
 *      另外做一次「对账」：如果汇总字段说失败 0、但明细/`by_status` 里有失败，宁可多报失败，
 *      也不把失败说成成功（`countSource = 'evidence_override'`）。
 *   D. **不丢数。** 已识别的计数之和必须能解释 `total`：
 *      `okCount + failedCount + dryRunCount + pendingCount + unknownCount === total` 恒成立。
 *      解释不了的那部分计入 `unknownCount` / `unaccountedCount` 并**在文案里写出来**。
 *      绝不允许「有 N 条结果却显示成功 0 / 失败 0 且没有任何说明」——裸 `partial` 那次报障
 *      就是这条约束没立住（它落到了「未识别」，一条都没被计入）。
 */

/** 与 antd `AlertProps['type']` 完全一致，但本文件不依赖 antd。 */
export type AssetAlertType = 'success' | 'info' | 'warning' | 'error'

/** 归一化后的单条结果口径。 */
export type AssetResultOutcome =
  /** 真正成功（图片已生成且有可用地址） */
  | 'succeeded'
  /** 部分失败：上游图片已生成，但 OSS 上传 / 落库等后续步骤没完成 */
  | 'partial_failed'
  /** 失败 */
  | 'failed'
  /** 演练模式占位，既不算成功也不算失败 */
  | 'dry_run'
  /** 仍在处理中 */
  | 'pending'
  /** 状态无法识别 */
  | 'unknown'

/** 一条结果被算进哪一档（`ok + failed + dry_run + pending + unknown = total`）。 */
export type AssetResultBucket = 'ok' | 'failed' | 'dry_run' | 'pending' | 'unknown'

/** 最后采用的计数来源（排查「为什么是这个数」时用）。 */
export type AssetCountSource =
  /** 新后端的整数计数字段（ok_count / failed_count / oss_ready_count） */
  | 'summary_fields'
  /** 新后端归一化口径的分布 `by_outcome` 求和 */
  | 'by_outcome'
  /** 旧形状 by_status 各状态求和 */
  | 'by_status'
  /** results 数组逐行归类求和 */
  | 'results'
  /** 汇总字段与明细对账不一致，按明细（更保守）显示 */
  | 'evidence_override'
  /** 只有 total，没有成功/失败明细 */
  | 'total_only'
  /** 没有任何结果 */
  | 'empty'

export type NormalizedAssetResult = {
  /** 归一化口径 */
  outcome: AssetResultOutcome
  /** 原始 status / outcome 文本（原样展示，让用户看到 partial_failed 这种真话） */
  rawStatus: string
  /** 算进哪一档 */
  bucket: AssetResultBucket
  isSuccess: boolean
  isFailure: boolean
  /** 这一条属于「图片已生成但后续步骤失败」 */
  isPartialFailure: boolean
  /** 是否拿到了 OSS 长期地址 */
  ossReady: boolean
  /** 可展示的地址（OSS 优先，其次本地/临时地址） */
  url: string
  /** 真实失败原因原文（取不到时为空字符串） */
  errorText: string
  /** 上游是否真的给了错误原文（false 表示 errorText 是兜底解释） */
  hasUpstreamError: boolean
  /** 从错误里读到的 HTTP 状态码（例如 OSS 403） */
  httpStatus: number | null
  dryRun: boolean
  /** 原始行，便于调用方继续读别的字段 */
  raw: unknown
}

export type AssetResultSummary = {
  /** 结果条数（results 长度与 summary.total 取较大值） */
  total: number
  okCount: number
  failedCount: number
  dryRunCount: number
  pendingCount: number
  /** 归一化口径为 `unknown` 的条数：既不算成功也不算失败 */
  unknownCount: number
  /**
   * 汇总里**没被任何已识别状态解释掉**的条数（`total` 比已识别计数之和多出来的部分）。
   * 这部分不会被丢弃：它同时计入 `unknownCount`，并在 `detailLines` 里显式说明。
   */
  unaccountedCount: number
  /** OSS 长期地址就绪条数（整数） */
  ossReadyCount: number
  /** 是否拿到了 results 明细数组 */
  hasRows: boolean
  /** 成功/失败明细是否可信；false 表示后端只给了 total */
  countsKnown: boolean
  hasFailure: boolean
  /** 部分失败：既有成功又有失败，或存在 partial_failed 条目 */
  hasPartialFailure: boolean
  /** 存在「图片已生成但 OSS / 落库未完成」的条目 */
  hasOssPartialFailure: boolean
  allSucceeded: boolean
  allFailed: boolean
  isDryRun: boolean
  /** 该用哪种 Alert 样式渲染（部分失败 = warning，全失败 = error，绝不 success） */
  alertType: AssetAlertType
  /** 一句话标题，例如「部分失败：成功 1 / 失败 1」 */
  title: string
  /** 整数计数文案，例如「成功 1 / 失败 1」；明细未知时为空 */
  countsText: string
  /** 展示给用户的失败原因（可能由多条拼接） */
  errorText: string
  hasUpstreamError: boolean
  httpStatus: number | null
  /** 可操作的下一步提示（可能为空字符串） */
  nextStepText: string
  /** Alert description 用的分行文案 */
  detailLines: string[]
  countSource: AssetCountSource
  /** 汇总字段与明细不一致时的说明（无冲突时为空） */
  mismatchNote: string
  /** 逐行归一化结果 */
  rows: NormalizedAssetResult[]
}

/** 单条结果口径 → antd Tag 颜色。**只有真正成功才是绿色**，`partial_failed` 用 volcano。 */
export const ASSET_OUTCOME_TAG_COLOR: Record<AssetResultOutcome, string> = {
  succeeded: 'green',
  partial_failed: 'volcano',
  failed: 'red',
  dry_run: 'orange',
  pending: 'blue',
  unknown: 'default',
}

/** 单条结果口径 → 中文标签。 */
export const ASSET_OUTCOME_LABEL: Record<AssetResultOutcome, string> = {
  succeeded: '成功',
  partial_failed: '部分失败',
  failed: '失败',
  dry_run: '演练占位',
  pending: '处理中',
  unknown: '未知',
}

export type DryRunBadgeState = 'dry_run' | 'real' | 'unknown'

export type DryRunBadge = {
  state: DryRunBadgeState
  /** 该用哪个 antd Tag 颜色 */
  color: string
  /** 该显示的文案（`unknown` 时明确说「未读到」，不谎报任何一侧） */
  text: string
}

/**
 * 守卫 DRY_RUN 标记 → 可展示的「演练 / 真实 / 未知」徽标口径。
 *
 * 为什么需要三态：以前页面里 `<GuardTag />` 有 6 处是**无参调用**，`dryRun` 是 `undefined`，
 * 于是无论实际守卫状态如何都渲染成红色的「真实调用已开启」—— 在演练模式下谎报正在真实付费调用。
 * 读不到就老实说「未知」，绝不默认成任何一侧。
 */
export function describeDryRunBadge(value: unknown): DryRunBadge {
  const dryRun = coerceLooseBoolean(value)
  if (dryRun === true) {
    return { state: 'dry_run', color: 'orange', text: 'DRY_RUN 占位（未真实调用）' }
  }
  if (dryRun === false) {
    return { state: 'real', color: 'red', text: '真实调用已开启' }
  }
  return { state: 'unknown', color: 'default', text: '守卫状态未知（未读到 DRY_RUN 标记）' }
}

/* ------------------------------------------------------------------ 值读取工具 */

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function readString(source: unknown, keys: readonly string[]): string {
  const record = asRecord(source)
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

/**
 * 把**单个值**宽松转成布尔：`true` / `'true'` / `1` / `'1'` / `'yes'` / `'on'` 都算真，
 * `false` / `'false'` / `0` / `'no'` / `'off'` 都算假，其它（含 `undefined` / `null` / `''`）
 * 返回 `null` 表示**读不到**。
 *
 * 为什么要有它：页面里以前散落着 `String(x) === 'true'` 这种「用字符串比较布尔」的写法 ——
 * 布尔 `true` 恰好能过，但后端把开关回成整数 `1` / `'yes'` / 缺失时就会渲染成相反的结论
 * （`undefined` → 假 → 在演练模式下谎报「真实调用已开启」）。统一走这个函数就不会再各写一套。
 */
export function coerceLooseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value !== 0 : null
  if (typeof value === 'string') {
    const token = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on'].includes(token)) return true
    if (['false', '0', 'no', 'off'].includes(token)) return false
    return null
  }
  return null
}

/** 从对象里按 key 列表宽松读布尔；读不到返回 null（区别于「明确是 false」）。 */
export function readLooseBoolean(source: unknown, keys: readonly string[]): boolean | null {
  const record = asRecord(source)
  for (const key of keys) {
    if (!(key in record)) continue
    const parsed = coerceLooseBoolean(record[key])
    if (parsed !== null) return parsed
  }
  return null
}

/** 内部沿用：从对象里读布尔（语义同 `readLooseBoolean`）。 */
function readBoolean(source: unknown, keys: readonly string[]): boolean | null {
  return readLooseBoolean(source, keys)
}

/** 宽松读整数：只接受非负有限数，读不到返回 null。 */
function readCount(source: unknown, keys: readonly string[]): number | null {
  const record = asRecord(source)
  for (const key of keys) {
    if (!(key in record)) continue
    const value = record[key]
    const parsed =
      typeof value === 'number' && Number.isFinite(value)
        ? value
        : typeof value === 'string' && value.trim() && Number.isFinite(Number(value))
          ? Number(value)
          : null
    if (parsed !== null && parsed >= 0) return Math.trunc(parsed)
  }
  return null
}

/** 是否读到了一个「真正的对象」（用来区分「字段存在但是 null」）。 */
function hasRecord(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(asRecord(value)).length > 0
}

const HTTP_STATUS_KEYS = [
  'http_status',
  'httpStatus',
  'status_code',
  'statusCode',
  'oss_http_status',
  'ossHttpStatus',
  'error_status',
  'error_code',
  'code',
] as const

/** 从错误文本里抠出 HTTP 状态码（例如 `HTTP 403` / `status=403` / `403 Forbidden`）。 */
function extractHttpStatusFromText(text: string): number | null {
  if (!text) return null
  const patterns = [
    /\b(?:http|status|code|错误码|状态码)\s*[:=]?\s*(\d{3})\b/i,
    /\b(\d{3})\s+(?:forbidden|unauthorized|not\s+found|internal\s+server\s+error|bad\s+gateway)\b/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match?.[1]) {
      const code = Number(match[1])
      if (code >= 100 && code <= 599) return code
    }
  }
  return null
}

function extractHttpStatus(source: unknown): number | null {
  const record = asRecord(source)
  for (const key of HTTP_STATUS_KEYS) {
    if (!(key in record)) continue
    const value = record[key]
    const parsed =
      typeof value === 'number' && Number.isFinite(value)
        ? value
        : typeof value === 'string' && /^\d{3}$/.test(value.trim())
          ? Number(value.trim())
          : null
    if (parsed !== null && parsed >= 100 && parsed <= 599) return parsed
  }
  const fromText = extractHttpStatusFromText(asErrorText(source))
  return fromText
}

/**
 * 从任意嵌套形状里取错误原文。**顺序很重要**：`detail.error_message` 优先，
 * 其次是 `message`，最后才是各种 `error`。
 */
function asErrorText(source: unknown, depth = 0): string {
  if (source === null || source === undefined || depth > 4) return ''
  if (typeof source === 'string') return source.trim()
  if (typeof source === 'number' && Number.isFinite(source)) return ''

  if (Array.isArray(source)) {
    const parts = source
      .map((item) => asErrorText(item, depth + 1))
      .filter(Boolean)
    return Array.from(new Set(parts)).slice(0, 3).join('；')
  }

  const record = asRecord(source)
  if (Object.keys(record).length === 0) return ''

  // ① detail / details（可能是对象，也可能是数组）
  const nested = [record.detail, record.details, record.error_detail, record.failure]
    .map((item) => asErrorText(item, depth + 1))
    .filter(Boolean)
  if (nested.length > 0) return nested[0]

  // ② 明确的错误字段，error_message 优先级最高
  const explicit = readString(source, [
    'error_message',
    'errorMessage',
    'error_msg',
    'err_msg',
    'oss_error_message',
    'upload_error_message',
    'reason',
    'fail_reason',
    'failure_reason',
    'message',
    'msg',
    'detail_message',
    'error',
  ])
  if (explicit) return explicit

  const nestedError = asErrorText(record.error, depth + 1)
  return nestedError
}

/** 取出单条结果可展示的失败原因（优先 `detail.error_message`）。 */
export function extractAssetResultErrorMessage(row: unknown): string {
  const record = asRecord(row)
  // 先看 detail / details，再看行本身；最后看上游可能塞在别处的 message。
  const fromRow = asErrorText(record)
  if (fromRow) return fromRow
  return readString(record, ['message', 'msg', 'error_message', 'detail'])
}

/* --------------------------------------------------------------- 状态归一化 */

const OK_STATUSES = new Set([
  'succeeded',
  'success',
  'ok',
  'done',
  'completed',
  'complete',
  'finished',
  'passed',
])

/** 部分失败：上游产物已生成，但后续（OSS 上传 / 落库）没完成。 */
const PARTIAL_FAILED_STATUSES = new Set([
  'partial',
  'partial_failed',
  'partial_fail',
  'partialfailure',
  'partial_ok',
  'partially_failed',
  'partial_error',
  'partial_success',
  'partial_succeeded',
  'oss_failed',
  'oss_fail',
  'oss_upload_failed',
  'oss_error',
  'upload_failed',
  'storage_failed',
  'storage_error',
  'persist_failed',
])

const FAILED_STATUSES = new Set([
  'failed',
  'fail',
  'failure',
  'error',
  'errored',
  'rejected',
  'blocked',
  'timeout',
  'timed_out',
  'cancelled',
  'canceled',
  'aborted',
  'exception',
])

const DRY_RUN_STATUSES = new Set(['dry_run', 'dryrun', 'dry', 'simulated', 'mock', 'placeholder'])

const PENDING_STATUSES = new Set([
  'pending',
  'queued',
  'queueing',
  'running',
  'processing',
  'submitted',
  'in_progress',
  'created',
  'waiting',
  'accepted',
  'started',
])

/**
 * 明确「无法判断」的状态。
 *
 * 为什么必须单列：后端归一化口径里有一个 `unknown`（`ok_count` / `running_count` /
 * `dry_run_count` / `unknown_count` 五档之一）。如果这里不认它，`classifyAssetResultStatus`
 * 会返回 null → 行级归一化退回读 `ok` 布尔 → 一条 `outcome=unknown` 的结果会被当成**成功**，
 * 那就等于把「不知道」谎报成「成功」。所以 `unknown` 必须显式命中，且**既不算成功也不算失败**。
 */
const UNKNOWN_STATUSES = new Set(['unknown', 'unspecified', 'unrecognized', 'indeterminate'])

/** 把原始状态字符串归一化成 token（小写 + `-`/空白 → `_`）。 */
export function normalizeStatusToken(raw: unknown): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') return ''
  return String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_')
}

/**
 * 状态 → 归一化口径；**认不出来时返回 null**（调用方再退回 `ok` 布尔）。
 *
 * 匹配顺序是刻意的：先精确集合，再做包含式判断，且「部分失败」必须在通用
 * 「failed / error」之前命中 —— 否则 `partial_failed` 会被吞成普通失败，
 * 页面就说不出「图片已生成、只是 OSS 没传上去」这句关键信息。
 */
export function classifyAssetResultStatus(raw: unknown): AssetResultOutcome | null {
  const token = normalizeStatusToken(raw)
  if (!token) return null

  if (OK_STATUSES.has(token)) return 'succeeded'
  if (PARTIAL_FAILED_STATUSES.has(token)) return 'partial_failed'
  if (FAILED_STATUSES.has(token)) return 'failed'
  if (DRY_RUN_STATUSES.has(token)) return 'dry_run'
  if (PENDING_STATUSES.has(token)) return 'pending'
  if (UNKNOWN_STATUSES.has(token)) return 'unknown'

  // 包含式兜底：`partial_failed_by_oss` / `oss_upload_error_403` 这类复合状态
  //
  // ① 「含 partial 就是部分失败」必须最先判：`partial`（裸 token，实测真实入库形状之一）
  //    / `partially_failed` / `partial_ok` / `partial_failed_by_oss` 这类 token 以前会落到
  //    「未识别」（返回 null）→ 汇总时既不进成功也不进失败，页面就出现
  //    「1 条结果却显示成功 0 / 失败 0」。它们**都不是成功**，按部分失败计。
  // ② 含 `fail` / `error` / `denied` 的 token 绝不允许落到「未识别」：那是明确的坏消息。
  if (token.includes('partial')) return 'partial_failed'

  const looksPartial = token.includes('oss') || token.includes('upload')
  const looksBad = token.includes('fail') || token.includes('error') || token.includes('denied')
  if (looksPartial && looksBad) return 'partial_failed'
  if (looksBad) return 'failed'
  if (token.includes('success') || token.includes('succeed') || token === 'succeeded') return 'succeeded'
  if (token.includes('pending') || token.includes('queue') || token.includes('running')) return 'pending'
  if (token.includes('dry')) return 'dry_run'

  return null
}

const PARTIAL_FAILURE_TEXT_MARKERS = [
  'oss',
  'upload',
  '上传',
  'storage',
  'storage failed',
  '落库',
  'object',
]

/** 从错误文本里判断这是不是「后续步骤（OSS / 落库）失败」。 */
function looksLikeOssFailure(text: string): boolean {
  const lower = text.toLowerCase()
  return PARTIAL_FAILURE_TEXT_MARKERS.some((marker) => lower.includes(marker))
}

/** 没有上游原文时，给出解释性兜底文案（明确标注「未提供原因」，不伪造细节）。 */
function fallbackFailureText(outcome: AssetResultOutcome, rawStatus: string): string {
  const statusText = rawStatus || '未提供'
  if (outcome === 'partial_failed') {
    return `上游返回「${statusText}」但没有给出失败原因：图片可能已生成，但 OSS 上传 / 落库没完成（这条结果暂时不能采纳）。`
  }
  if (outcome === 'failed') {
    return `上游返回「${statusText}」但没有给出失败原因，请查看出图服务日志。`
  }
  return `上游返回「${statusText}」，没有更多信息。`
}

/* ------------------------------------------------------------- 逐行归一化 */

function pickUrl(record: Record<string, unknown>): { url: string; ossUrl: string } {
  const ossUrl = readString(record, [
    'oss_url',
    'ossUrl',
    'object_url',
    'storage_url',
    'oss_object_url',
    'remote_url',
  ])
  const fallbackUrl = readString(record, ['image_url', 'imageUrl', 'local_path', 'localPath', 'preview_url', 'url'])
  return { url: ossUrl || fallbackUrl, ossUrl }
}

/** 把任意形状的一行结果归一化成可展示、可计数的口径。 */
export function normalizeAssetResultRow(row: unknown): NormalizedAssetResult {
  const record = asRecord(row)

  const outcomeRaw = readString(record, ['outcome'])
  const statusRaw = readString(record, ['status', 'state', 'result', 'task_status'])
  const okFlag = readBoolean(record, ['ok', 'is_ok', 'success', 'is_success'])
  const dryRunFlag = readBoolean(record, ['dry_run', 'dryRun']) === true

  let outcome = classifyAssetResultStatus(outcomeRaw) ?? classifyAssetResultStatus(statusRaw)
  const rawStatus = outcomeRaw || statusRaw

  // `ok` 只在状态认不出来时兜底：旧后端对 partial_failed 恒返回 ok=true，
  // 所以绝不能让 `ok` 覆盖一个已经识别出来的 status（约束 B）。
  if (outcome === null) {
    if (okFlag === true) outcome = 'succeeded'
    else if (okFlag === false) outcome = 'failed'
    else outcome = 'unknown'
  } else if (okFlag === false && outcome === 'succeeded') {
    // 显式 ok=false 是明确的失败证据（ok=true 不可信，false 可信），不把它渲染成绿色成功。
    outcome = 'failed'
  }

  const { url, ossUrl } = pickUrl(record)
  const ossReadyFlag = readBoolean(record, ['oss_ready', 'ossReady'])
  const ossReady = ossUrl !== '' || ossReadyFlag === true

  const detail = asRecord(record.detail)
  let upstreamText =
    readString(detail, ['error_message', 'errorMessage', 'message', 'error', 'reason']) ||
    extractAssetResultErrorMessage(record)
  if (!upstreamText) {
    // 有些形状把原因放在 details 数组的第一项里
    upstreamText = asErrorText(record.details)
  }
  const httpStatus = extractHttpStatus(record) ?? extractHttpStatusFromText(upstreamText)

  // DRY_RUN 不产生真实资产：占位行不该被算成成功。
  // 但真失败仍然是失败（演练也不会「失败」，这里只是不掩盖真错误）。
  if (dryRunFlag && (outcome === 'succeeded' || outcome === 'pending' || outcome === 'unknown')) {
    outcome = 'dry_run'
  }

  const isPartialFailure = outcome === 'partial_failed' || (outcome !== 'succeeded' && looksLikeOssFailure(upstreamText))
  const isSuccess = outcome === 'succeeded'
  const isFailure = outcome === 'failed' || outcome === 'partial_failed'
  const bucket: AssetResultBucket = isSuccess
    ? 'ok'
    : isFailure
      ? 'failed'
      : outcome === 'dry_run'
        ? 'dry_run'
        : outcome === 'unknown'
          ? 'unknown'
          : 'pending'

  const hasUpstreamError = upstreamText !== ''
  const finalText = hasUpstreamError ? upstreamText : isFailure ? fallbackFailureText(outcome, rawStatus) : ''

  return {
    outcome,
    rawStatus,
    bucket,
    isSuccess,
    isFailure,
    isPartialFailure,
    ossReady,
    url,
    errorText: finalText,
    hasUpstreamError,
    httpStatus,
    dryRun: dryRunFlag,
    raw: row,
  }
}

/* ----------------------------------------------------------------- 计数与汇总 */

type CountSet = {
  total: number
  ok: number
  failed: number
  dryRun: number
  pending: number
  unknown: number
  ossReady: number
  known: boolean
}

function countsFromRows(rows: readonly NormalizedAssetResult[]): CountSet {
  return {
    total: rows.length,
    ok: rows.filter((row) => row.bucket === 'ok').length,
    failed: rows.filter((row) => row.bucket === 'failed').length,
    dryRun: rows.filter((row) => row.bucket === 'dry_run').length,
    pending: rows.filter((row) => row.bucket === 'pending').length,
    unknown: rows.filter((row) => row.bucket === 'unknown').length,
    ossReady: rows.filter((row) => row.ossReady).length,
    known: rows.length > 0,
  }
}

/**
 * 按「状态 → 条数」的映射求和。
 * 同时用于旧形状 `by_status`（原始状态）和新形状 `by_outcome`（归一化口径），
 * 两者的键都能被 `classifyAssetResultStatus` 识别。
 */
function countsFromStatusMap(statusMap: Record<string, unknown>): CountSet | null {
  const entries = Object.entries(statusMap)
  if (entries.length === 0) return null
  let ok = 0
  let failed = 0
  let dryRun = 0
  let pending = 0
  let unknown = 0
  let total = 0
  for (const [status, rawCount] of entries) {
    const n = readCount({ value: rawCount }, ['value']) ?? 0
    total += n
    const outcome = classifyAssetResultStatus(status)
    if (outcome === 'succeeded') ok += n
    else if (outcome === 'failed' || outcome === 'partial_failed') failed += n
    else if (outcome === 'dry_run') dryRun += n
    else if (outcome === 'pending') pending += n
    // 认不出来的 token（含历史/方言状态）→ **未知**：
    // 以前它被塞进 `pending`（"处理中"），等于替后端编了一个"还在跑"的结论，
    // 而且 okCount / failedCount 都是 0 时页面上只看得到「成功 0 / 失败 0」。
    // 现在如实计入 unknown，并在文案里说出来（见 summarizeAssetResults 的不丢数对账）。
    else unknown += n
  }
  return { total, ok, failed, dryRun, pending, unknown, ossReady: 0, known: total > 0 }
}

/** 状态映射里是否含「部分失败」（旧形状 `by_status` 下唯一的线索）。 */
function statusMapHasPartialFailure(value: unknown): boolean {
  return Object.keys(asRecord(value)).some((key) => classifyAssetResultStatus(key) === 'partial_failed')
}

/**
 * 汇总一次出图结果。
 *
 * @param results 结果数组（可能为空 / 缺失 —— 后端只给汇总时就是这样）
 * @param options.summary 后端汇总对象；新字段 `ok_count`/`failed_count`/`oss_ready_count`
 *   有就用，没有就回退到 `by_outcome`（归一化）/ `by_status`（旧）/ `oss_ready` / `total`
 * @param options.payload 整包响应（用于从顶层 `details[].error_message` / `message` 兜底取原因）
 * @param options.dryRun 调用方已知的演练标记（例如 `summary.dry_run`）
 */
export function summarizeAssetResults(
  results?: readonly unknown[] | null,
  options?: { summary?: unknown; payload?: unknown; dryRun?: unknown },
): AssetResultSummary {
  const rows = asArray(results).map((row) => normalizeAssetResultRow(row))
  const rowCounts = countsFromRows(rows)

  const summary = asRecord(options?.summary)
  const payload = asRecord(options?.payload)
  // `by_outcome`（归一化口径，新）优先于 `by_status`（原始状态，旧）。
  const byOutcomeRaw = summary.by_outcome ?? summary.byOutcome ?? payload.by_outcome
  const byStatusRaw = summary.by_status ?? summary.byStatus ?? payload.by_status
  const byOutcomeCounts = hasRecord(byOutcomeRaw) ? countsFromStatusMap(asRecord(byOutcomeRaw)) : null
  const byStatusCounts = hasRecord(byStatusRaw) ? countsFromStatusMap(asRecord(byStatusRaw)) : null

  const fieldOk = readCount(summary, ['ok_count', 'okCount', 'success_count', 'successCount', 'succeeded_count'])
  const fieldFailed = readCount(summary, ['failed_count', 'failedCount', 'failure_count', 'error_count'])
  const fieldPending = readCount(summary, ['pending_count', 'pendingCount', 'queued_count', 'running_count'])
  const fieldDryRun = readCount(summary, ['dry_run_count', 'dryRunCount'])
  const fieldUnknown = readCount(summary, ['unknown_count', 'unknownCount'])
  const fieldPartialFailed = readCount(summary, ['partial_failed_count', 'partialFailedCount'])
  const hasFieldCounts = fieldOk !== null || fieldFailed !== null

  const fieldOssReady = readCount(summary, ['oss_ready_count', 'ossReadyCount'])
  const ossReadyRaw = summary.oss_ready ?? summary.ossReady ?? payload.oss_ready
  const ossReadyLegacyCount = readCount({ oss_ready: ossReadyRaw }, ['oss_ready'])
  const ossReadyLegacyFlag = readBoolean({ oss_ready: ossReadyRaw }, ['oss_ready'])

  const summaryTotal = readCount(summary, ['total', 'total_count', 'count'])
  const payloadSummary = asRecord(payload.summary).total

  const resultsLength = rows.length
  let total = Math.max(
    resultsLength,
    summaryTotal ?? 0,
    readCount({ total: payloadSummary }, ['total']) ?? 0,
  )

  // —— 第一优先：新后端的整数计数字段
  let countSource: AssetCountSource = 'empty'
  let okCount = 0
  let failedCount = 0
  let dryRunCount = 0
  let pendingCount = 0
  let unknownCount = 0
  let countsKnown = false
  let mismatchNote = ''

  const applyCounts = (counts: CountSet) => {
    okCount = counts.ok
    failedCount = counts.failed
    dryRunCount = counts.dryRun
    pendingCount = counts.pending
    unknownCount = counts.unknown
    countsKnown = counts.known
  }

  if (hasFieldCounts) {
    const known =
      fieldOk !== null ||
      fieldFailed !== null ||
      fieldPending !== null ||
      fieldDryRun !== null ||
      fieldUnknown !== null
    const derivedTotal = total > 0 ? total : (fieldOk ?? 0) + (fieldFailed ?? 0)
    // 「既不是成功也不是失败」的那部分：running + dry_run + unknown
    const neutral = (fieldPending ?? 0) + (fieldUnknown ?? 0)
    const pending = fieldPending ?? fieldDryRun ?? 0
    const ok = fieldOk ?? Math.max(0, derivedTotal - (fieldFailed ?? 0) - neutral - (fieldDryRun ?? 0))
    const failed = fieldFailed ?? Math.max(0, derivedTotal - ok - neutral - (fieldDryRun ?? 0))
    applyCounts({
      total: derivedTotal,
      ok,
      failed,
      dryRun: fieldDryRun ?? 0,
      pending: pending,
      unknown: fieldUnknown ?? 0,
      ossReady: 0,
      known,
    })
    countSource = 'summary_fields'
  } else if (byOutcomeCounts) {
    // 归一化口径的分布（新）：比原始状态更可靠，优先于 by_status
    applyCounts(byOutcomeCounts)
    countSource = 'by_outcome'
  } else if (byStatusCounts) {
    applyCounts(byStatusCounts)
    countSource = 'by_status'
  } else if (rowCounts.known) {
    applyCounts(rowCounts)
    countSource = 'results'
  } else if (total > 0) {
    countsKnown = false
    countSource = 'total_only'
  }

  // —— 对账：汇总字段说「没有失败」但明细/by_outcome/by_status 有失败时，按明细显示（宁可多报失败）
  // 只把「真正来自上游的原因」当锚点：行内没有原文时它的 errorText 是我们自己编的兜底文案，
  // 不能让那种兜底文案盖掉后端在顶层给出的真实原因。
  const statusEvidence = (() => {
    const candidates = [byOutcomeCounts, byStatusCounts].filter(Boolean) as CountSet[]
    if (candidates.length === 0) return null
    return candidates.reduce((best, item) => (item.failed > best.failed ? item : best))
  })()
  const evidence = statusEvidence && statusEvidence.failed > rowCounts.failed ? statusEvidence : rowCounts
  // 只有当证据本身能和已知总数自洽时才覆盖：否则一个离谱的分布会把 total 撑爆。
  const evidenceFits = evidence.known && evidence.failed > failedCount && evidence.total <= total
  if (countsKnown && evidenceFits) {
    mismatchNote = `后端汇总与明细不一致（汇总失败 ${failedCount} 条 / 明细失败 ${evidence.failed} 条），已按明细显示。`
    okCount = evidence.ok
    failedCount = evidence.failed
    dryRunCount = evidence.dryRun
    pendingCount = evidence.pending
    unknownCount = evidence.unknown
    countSource = 'evidence_override'
  }

  // —— 不丢数（硬约束，比任何单个来源的口径都重要）：
  // 已识别的计数之和**必须能解释 total**；解释不了的那部分绝不静默丢弃。
  //   ① 计数比 total 少（后端 total 大于它给出的分布，或明细比汇总少）→ 差额计入
  //      ``unknownCount`` 并单独记 ``unaccountedCount``，文案里明说「N 条状态未识别」；
  //   ② 计数比 total 多（后端 total 偏小）→ 按计数显示（宁可多报条数，也不吞掉结果）。
  // 这样恒有 ok + failed + dryRun + pending + unknown === total，杜绝
  // 「有 N 条结果却显示成功 0 / 失败 0 且没有任何说明」。
  let unaccountedCount = 0
  if (countsKnown) {
    const accounted = okCount + failedCount + dryRunCount + pendingCount + unknownCount
    if (accounted > total) {
      total = accounted
    } else if (accounted < total) {
      unaccountedCount = total - accounted
      unknownCount += unaccountedCount
    }
  }

  const ossReadyCount =
    fieldOssReady ??
    ossReadyLegacyCount ??
    (ossReadyLegacyFlag === true ? total : ossReadyLegacyFlag === false ? 0 : rowCounts.ossReady)

  const isDryRun =
    readBoolean(options ?? {}, ['dryRun']) === true ||
    readBoolean(summary, ['dry_run', 'dryRun']) === true ||
    readBoolean(payload, ['dry_run', 'dryRun']) === true ||
    (countsKnown && total > 0 && dryRunCount === total)

  const hasRows = rows.length > 0
  const failedRows = rows.filter((row) => row.isFailure)
  const hasFailure = failedCount > 0 || failedRows.length > 0
  const hasOssPartialFailure =
    rows.some((row) => row.isPartialFailure) ||
    // 旧形状 by_status / 新形状 by_outcome 里只要出现 partial_failed 就算 ——
    // 注意后端的**聚合** `summary.outcome` 对部分失败给的是 `failed`，所以不能只靠它。
    statusMapHasPartialFailure(byStatusRaw) ||
    statusMapHasPartialFailure(byOutcomeRaw) ||
    (fieldPartialFailed ?? 0) > 0 ||
    readBoolean(summary, ['has_partial_failure', 'hasPartialFailure']) === true ||
    classifyAssetResultStatus(readString(summary, ['outcome', 'status'])) === 'partial_failed' ||
    classifyAssetResultStatus(readString(payload, ['outcome', 'status'])) === 'partial_failed' ||
    (hasFailure && countSource !== 'empty' && !hasRows && looksLikeOssFailure(readString(summary, ['message', 'error_message'])))
  const hasPartialFailure = hasOssPartialFailure || (okCount > 0 && failedCount > 0)
  const allSucceeded = countsKnown && total > 0 && okCount === total && failedCount === 0
  const allFailed =
    countsKnown &&
    failedCount > 0 &&
    okCount === 0 &&
    pendingCount === 0 &&
    dryRunCount === 0 &&
    unknownCount === 0

  // —— 失败原因：优先用明细里的 `detail.error_message`，明细缺失时用汇总/整包兜底
  const upstreamDetailTexts = Array.from(
    new Set(failedRows.filter((row) => row.hasUpstreamError).map((row) => row.errorText).filter(Boolean)),
  )
  const fallbackDetailTexts = Array.from(
    new Set(failedRows.filter((row) => !row.hasUpstreamError).map((row) => row.errorText).filter(Boolean)),
  )
  // 明细没有原文时，再看汇总 / 整包层级（含顶层 details[].error_message）
  const summaryLevelText = asErrorText(summary) || asErrorText(payload)
  const texts = upstreamDetailTexts.length
    ? upstreamDetailTexts.slice(0, 3)
    : summaryLevelText
      ? [summaryLevelText]
      : fallbackDetailTexts.slice(0, 3)
  // 一条原因都没有时，给出明确标注「未提供原因」的兜底文案，绝不静默成空 Alert。
  if (texts.length === 0 && hasFailure) {
    texts.push(
      hasOssPartialFailure
        ? '后端只返回了「部分失败」标记，没有给出失败原因：图片可能已生成，但 OSS 上传 / 落库没完成（可查后端日志确认）。'
        : '后端只返回了失败标记，没有给出失败原因（可查后端日志确认）。',
    )
  }
  const errorText = texts.join('；')
  // summaryLevelText 只会是上游原文（不含我们合成的兜底文案），所以它非空即视为有原文。
  const hasUpstreamError = upstreamDetailTexts.length > 0 || summaryLevelText !== ''

  const httpStatus =
    failedRows.find((row) => row.httpStatus !== null)?.httpStatus ?? extractHttpStatus(summary)

  // 计数文案：成功/失败两个数永远给全；「既不是成功也不是失败」的部分必须**在文案里说出来**，
  // 否则用户看到「成功 0 / 失败 0」会以为没有结果（这正是裸 `partial` 那次报障的样子）。
  const countNotes: string[] = []
  if (unknownCount > 0) countNotes.push(`其中 ${unknownCount} 条状态未识别`)
  if (okCount === 0 && failedCount === 0) {
    if (pendingCount > 0) countNotes.push(`${pendingCount} 条处理中`)
    if (dryRunCount > 0) countNotes.push(`${dryRunCount} 条演练占位`)
  }
  const countsText =
    countsKnown && total > 0
      ? countNotes.length > 0
        ? `成功 ${okCount} / 失败 ${failedCount}，${countNotes.join('、')}（既不算成功也不算失败）`
        : `成功 ${okCount} / 失败 ${failedCount}`
      : ''

  // —— 标题 / 样式：部分失败必须是 warning，全失败是 error，绝不给绿色成功
  let alertType: AssetAlertType = 'info'
  let title = '没有出图结果'
  if (countsKnown && total > 0) {
    if (allSucceeded) {
      alertType = 'success'
      title = `出图完成：成功 ${okCount} / 失败 ${failedCount}`
    } else if (okCount > 0 && failedCount > 0) {
      alertType = 'warning'
      title = `部分失败：成功 ${okCount} / 失败 ${failedCount}`
    } else if (okCount > 0 && pendingCount > 0) {
      alertType = 'info'
      title = `部分完成：成功 ${okCount} / 失败 ${failedCount}（另有 ${pendingCount} 条处理中）`
    } else if (failedCount > 0) {
      alertType = 'error'
      title = hasOssPartialFailure
        ? `出图未完成：成功 ${okCount} / 失败 ${failedCount}（含图片已生成但 OSS 未就绪的条目）`
        : `出图失败：成功 ${okCount} / 失败 ${failedCount}`
    } else if (dryRunCount > 0) {
      alertType = 'warning'
      title = `演练模式：没有真实出图（成功 ${okCount} / 失败 ${failedCount}）`
    } else if (pendingCount > 0) {
      alertType = 'info'
      title = `出图处理中：成功 ${okCount} / 失败 ${failedCount}（${pendingCount} 条待完成）`
    } else {
      // 只剩 unknown：既不是成功也不是失败，如实说「状态未知」，绝不冒充成功
      alertType = 'info'
      title = `状态未知：成功 ${okCount} / 失败 ${failedCount}（${unknownCount} 条无法判断）`
    }
  } else if (total > 0) {
    alertType = 'info'
    title = `出图结果：共 ${total} 条（后端未提供成功 / 失败明细）`
  }

  // —— 可操作的下一步
  let nextStepText = ''
  if (hasOssPartialFailure || looksLikeOssFailure(errorText)) {
    nextStepText =
      '可重试上传；若仍失败请检查 OSS 配置（bucket / AccessKey / 地域 / 写权限）以及后端 OSS 守卫状态。'
  } else if (hasFailure) {
    const authLike =
      httpStatus === 401 ||
      httpStatus === 403 ||
      /forbidden|unauthorized|accessdenied|access denied|signature|credential|access key|no permission|无权限|鉴权/i.test(
        errorText,
      )
    nextStepText = authLike
      ? '这是鉴权 / 权限错误：请检查 OSS AccessKey 与出图服务凭据配置后重试。'
      : '可重试出图；若持续失败请查看出图服务状态与项目作用域是否正确。'
  } else if (pendingCount > 0) {
    nextStepText = '仍有任务在跑：稍后刷新查看，或重新查询该任务。'
  } else if (allSucceeded) {
    nextStepText = '结果可采纳到资产槽位；需要定版时用「采纳并设为定版」。'
  } else if (dryRunCount > 0) {
    nextStepText = '当前是演练模式：关闭 DRY_RUN 守卫后重试才会真实出图。'
  }

  // —— Alert description 分行文案
  const detailLines: string[] = []
  if (countsText) {
    const ossPart = `OSS 长期地址就绪 ${ossReadyCount} 条`
    detailLines.push(`${countsText}（共 ${total} 条，${ossPart}）`)
  } else if (total > 0) {
    detailLines.push(`共 ${total} 条（后端未提供成功 / 失败明细）`)
  }
  if (texts.length > 0) {
    for (const text of texts) detailLines.push(`失败原因：${text}`)
  }
  if (okCount > 0 && !isDryRun && countsKnown && ossReadyCount < okCount) {
    detailLines.push(
      `注意：成功 ${okCount} 条里有 ${okCount - ossReadyCount} 条没拿到 OSS 长期地址，采纳可能失败（本地 / 临时地址不算长期资产）。`,
    )
  }
  if (dryRunCount > 0) detailLines.push(`演练（DRY_RUN）占位结果 ${dryRunCount} 条，不是真实出图。`)
  if (pendingCount > 0 && okCount > 0) detailLines.push(`另有 ${pendingCount} 条仍在处理中。`)
  if (unknownCount > 0) {
    detailLines.push(`另有 ${unknownCount} 条状态未知（后端未给出可判断的信息，既不算成功也不算失败）。`)
  }
  if (unaccountedCount > 0) {
    detailLines.push(
      `其中 ${unaccountedCount} 条后端没有给出状态、也没有出现在明细里（已按「状态未识别」计入，既不算成功也不算失败）。`,
    )
  }
  if (mismatchNote) detailLines.push(mismatchNote)
  if (nextStepText) detailLines.push(`下一步：${nextStepText}`)

  return {
    total,
    okCount,
    failedCount,
    dryRunCount,
    pendingCount,
    unknownCount,
    unaccountedCount,
    ossReadyCount,
    hasRows,
    countsKnown,
    hasFailure,
    hasPartialFailure,
    hasOssPartialFailure,
    allSucceeded,
    allFailed,
    isDryRun,
    alertType,
    title,
    countsText,
    errorText,
    hasUpstreamError,
    httpStatus,
    nextStepText,
    detailLines,
    countSource,
    mismatchNote,
    rows,
  }
}

/** 单张结果的便捷入口（内部就是 `[row]` 的汇总）。 */
export function summarizeSingleAssetResult(
  result: unknown,
  options?: { summary?: unknown; payload?: unknown; dryRun?: unknown },
): AssetResultSummary {
  return summarizeAssetResults(result === null || result === undefined ? [] : [result], options)
}

/** 整数计数文案，例如「成功 1 / 失败 0」；明细未知时返回空字符串。 */
export function formatAssetCounts(summary: AssetResultSummary): string {
  return summary.countsText
}
