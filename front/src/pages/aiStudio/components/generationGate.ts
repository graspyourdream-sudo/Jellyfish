/**
 * 生成类操作的「统一状态口径」。
 *
 * 为什么要单独一个模块：
 * 以前每个生成入口各写一套反馈——有的只弹一次性 toast、有的把真实异常吞成 null
 * 再显示 `status=unknown`、有的干脆没有 handler（点了一点反应都没有），
 * 用户根本分不清「接口没接通」和「被演练门禁拦住了」。
 *
 * 现在所有生成/拆分入口统一用这里的五类状态：
 *   1. `dry_run`        已配置但被 DRY_RUN 阻止（能力是通的，只是门禁关着）
 *   2. `not_configured` 模型未配置
 *   3. `missing_params` 参数缺失
 *   4. `service_error`  服务错误（含接口未接通）
 *   5. `running`        正在处理
 *
 * 关键产品口径：**被 DRY_RUN 拦截 ≠ 模型接口没接通**。
 * 所以 `dry_run` 的文案必须说清楚「能力已配置、当前被演练门禁阻止」，并给出放开条件。
 */

import { useCallback, useEffect, useState } from 'react'
import { getOrchestrationStatus } from '../../../services/llmPipelineApi'
import { OpenAPI } from '../../../services/generated'

export type GenerationGateState =
  /** 已配置且未被门禁阻止：可以真实调用 */
  | 'ready'
  | 'dry_run'
  | 'not_configured'
  | 'missing_params'
  | 'service_error'
  | 'running'

/** 生成出口：门禁状态与「该出口需要的模型」都按出口区分。 */
export type GenerationOutlet = 'llm' | 'image' | 'video'

export type GenerationGateTone = 'success' | 'warning' | 'error' | 'info'

export type GenerationGateInfo = {
  state: GenerationGateState
  tone: GenerationGateTone
  /** 一句话状态，直接显示在按钮上方 */
  label: string
  /** 补充说明：为什么、怎么放开 */
  description: string
}

export type GenerationGateSnapshot = {
  loading: boolean
  /** 后台是否处于 DRY_RUN（null = 还没取到） */
  dryRun: boolean | null
  /** 后端给的守卫原文，例如「DRY_RUN=开（JELLYFISH_DRY_RUN，未发起真实调用）」 */
  guardText: string
  guardEnv: string
  confirmEnv: string
  /** 文本 / 图片 / 视频的默认模型 id（空 = 未配置） */
  textModelId: string
  imageModelId: string
  videoModelId: string
  /** 取状态本身失败时的原文（不要把失败伪装成「一切正常」） */
  error: string
  reload: () => void
}

const FALLBACK_GUARD_ENV = 'JELLYFISH_DRY_RUN'
const FALLBACK_CONFIRM_ENV = 'JELLYFISH_REAL_LLM_CONFIRMED'

function readModelId(payload: Record<string, unknown> | null, key: string): string {
  const value = payload?.[key]
  return typeof value === 'string' ? value : ''
}

/**
 * 五类状态的统一判定：先看门禁与模型配置，再落到具体出口。
 */
export function describeGenerationGate(
  snapshot: Pick<
    GenerationGateSnapshot,
    'loading' | 'dryRun' | 'guardText' | 'guardEnv' | 'confirmEnv' | 'textModelId' | 'imageModelId' | 'videoModelId' | 'error'
  >,
  outlet: GenerationOutlet,
  options?: { running?: boolean; runningText?: string },
): GenerationGateInfo {
  const openHint = `要真实调用，需显式设置 ${snapshot.guardEnv || FALLBACK_GUARD_ENV}=0 且 ${
    snapshot.confirmEnv || FALLBACK_CONFIRM_ENV
  }=1。`

  if (options?.running) {
    return {
      state: 'running',
      tone: 'info',
      label: options.runningText ?? '正在处理…',
      description: '请求已发出，等待本进程内联执行完成（本环境没有队列 worker，慢是正常的）。',
    }
  }

  if (snapshot.loading) {
    return {
      state: 'running',
      tone: 'info',
      label: '正在读取模型与门禁状态…',
      description: '读取完成后会显示「已配置 / 被门禁阻止 / 未配置」。',
    }
  }

  if (snapshot.error) {
    return {
      state: 'service_error',
      tone: 'error',
      label: '读取门禁状态失败',
      description: `无法确认当前是否被演练门禁阻止：${snapshot.error}`,
    }
  }

  const modelId =
    outlet === 'llm' ? snapshot.textModelId : outlet === 'image' ? snapshot.imageModelId : snapshot.videoModelId
  const modelLabel = outlet === 'llm' ? '文本模型' : outlet === 'image' ? '图片模型' : '视频模型'
  // 门禁优先于模型配置：DRY_RUN 下模型根本不会被构造，先说清「被谁挡住」才不误导用户。
  if (snapshot.dryRun) {
    return {
      state: 'dry_run',
      tone: 'warning',
      label: `能力已配置，当前被演练门禁（DRY_RUN）阻止`,
      description: `${snapshot.guardText || 'DRY_RUN=开'}；${modelLabel}已配置${
        modelId ? `：${modelId}` : '（未见默认模型，但门禁状态下未做真实校验）'
      }。${openHint} 演练模式下不会发起任何真实请求，也不会产生费用。`,
    }
  }

  if (!modelId) {
    return {
      state: 'not_configured',
      tone: 'error',
      label: `${modelLabel}未配置`,
      description: `请先到「模型管理」配置默认${modelLabel}（当前为空），再执行本操作。`,
    }
  }

  return {
    state: 'ready',
    tone: 'success',
    label: `已就绪：${modelLabel} ${modelId}，未开启演练门禁`,
    description: '本操作会发起真实调用。',
  }
}

/** 失败结果的分类结果，供 toast / Alert 统一使用。 */
export type GenerationFailure = {
  state: Exclude<GenerationGateState, 'running'>
  tone: GenerationGateTone
  title: string
  reason: string
}

function readStatus(error: unknown): number | null {
  const value = (error as { status?: unknown })?.status
  return typeof value === 'number' ? value : null
}

/**
 * 把生成客户端吐出来的「Generic Error: status: 409; … body: {…}」还原成人话。
 *
 * 为什么需要：`services/generated` 的请求层（自动产物，不手改）在失败时会拼出
 * 一串含原始 JSON body 的 message。直接显示给用户就是上一轮反馈里说的
 * 「裸 Generic Error，看不出到底是没接通还是被门禁拦住」。
 * 这里尽量从 body 里取出后端信封的 message（后端一直有写人话）。
 */
export function sanitizeErrorMessage(raw: string): string {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  const bodyIndex = text.indexOf('body:')
  if (bodyIndex < 0) return text
  const jsonPart = text.slice(bodyIndex + 'body:'.length).trim()
  try {
    const parsed = JSON.parse(jsonPart) as Record<string, unknown>
    const envelopeMessage = parsed?.message
    if (typeof envelopeMessage === 'string' && envelopeMessage.trim()) return envelopeMessage.trim()
    const detail = parsed?.detail
    if (typeof detail === 'string' && detail.trim()) return detail.trim()
  } catch {
    // body 不是完整 JSON（例如被截断）——退回原文，不做二次加工
  }
  return text
}

function readMessage(error: unknown): string {
  if (error instanceof Error) return sanitizeErrorMessage(error.message)
  if (typeof error === 'string') return sanitizeErrorMessage(error)
  try {
    return sanitizeErrorMessage(JSON.stringify(error))
  } catch {
    return String(error)
  }
}

/**
 * 把任意异常翻译成五类状态里的一类，并保留真实原因。
 *
 * 重点：绝不返回 `unknown` 之类无信息的结果——如果分类不出来，
 * 至少把原始 message 贴出来，让用户能复制给开发。
 */
export function classifyGenerationFailure(error: unknown, outlet: GenerationOutlet = 'image'): GenerationFailure {
  const message = readMessage(error) || '未知错误'
  const status = readStatus(error)
  const modelLabel = outlet === 'llm' ? '文本模型' : outlet === 'image' ? '图片模型' : '视频模型'

  if (/DRY_RUN/i.test(message) || status === 409) {
    return {
      state: 'dry_run',
      tone: 'warning',
      title: '被演练门禁（DRY_RUN）阻止，未发起真实请求',
      reason: message,
    }
  }
  if (status === 400 || status === 422) {
    return { state: 'missing_params', tone: 'error', title: '参数缺失或不合法', reason: message }
  }
  if (status === 404) {
    return { state: 'service_error', tone: 'error', title: '接口未接通或目标资源不存在', reason: message }
  }
  if (typeof status === 'number' && status >= 500) {
    return { state: 'service_error', tone: 'error', title: '服务错误', reason: message }
  }
  if (/模型|model|model_id|未配置/i.test(message)) {
    return { state: 'not_configured', tone: 'error', title: `${modelLabel}未配置`, reason: message }
  }
  if (status === null) {
    return { state: 'service_error', tone: 'error', title: '请求未送达服务（网络或接口未接通）', reason: message }
  }
  return { state: 'service_error', tone: 'error', title: `请求失败（HTTP ${status}）`, reason: message }
}

/** 失败结果的单行文案：标题 + 真实原因，避免再出现 `status=unknown` 这类空话。 */
export function failureText(failure: GenerationFailure): string {
  return `${failure.title}：${failure.reason}`
}

type ModelSettingsPayload = Record<string, unknown> | null

/**
 * 读取「模型 + 门禁」状态（只读端点，不触网、不花钱）。
 *
 * 多个入口共用一份模块级缓存，避免每个面板各发一轮请求；
 * 失败时把错误原文留在快照里，由 UI 明确显示，不静默降级。
 */
let gateCache: {
  dryRun: boolean
  guardText: string
  guardEnv: string
  confirmEnv: string
  textModelId: string
  imageModelId: string
  videoModelId: string
} | null = null

async function fetchModelSettings(): Promise<ModelSettingsPayload> {
  const response = await fetch(`${OpenAPI.BASE}/api/v1/llm/model-settings`)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`模型设置读取失败（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : null
  return (payload?.data ?? null) as ModelSettingsPayload
}

export function useGenerationGate(): GenerationGateSnapshot {
  const [loading, setLoading] = useState(gateCache === null)
  const [error, setError] = useState('')
  const [token, setToken] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      if (gateCache && token === 0) {
        setLoading(false)
        return
      }
      setLoading(true)
      setError('')
      try {
        const [orchestration, settings] = await Promise.all([
          getOrchestrationStatus(),
          fetchModelSettings(),
        ])
        const guard = (orchestration?.guard ?? {}) as Record<string, unknown>
        gateCache = {
          dryRun: guard.dry_run !== false,
          guardText: String(orchestration?.guard_status_text ?? ''),
          guardEnv: String(guard.env ?? FALLBACK_GUARD_ENV),
          confirmEnv: String(guard.confirm_env ?? FALLBACK_CONFIRM_ENV),
          textModelId: readModelId(settings, 'default_text_model_id'),
          imageModelId: readModelId(settings, 'default_image_model_id'),
          videoModelId: readModelId(settings, 'default_video_model_id'),
        }
      } catch (e) {
        if (!cancelled) setError(readMessage(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [token])

  const reload = useCallback(() => {
    gateCache = null
    setToken((value) => value + 1)
  }, [])

  return {
    loading,
    dryRun: gateCache?.dryRun ?? null,
    guardText: gateCache?.guardText ?? '',
    guardEnv: gateCache?.guardEnv ?? FALLBACK_GUARD_ENV,
    confirmEnv: gateCache?.confirmEnv ?? FALLBACK_CONFIRM_ENV,
    textModelId: gateCache?.textModelId ?? '',
    imageModelId: gateCache?.imageModelId ?? '',
    videoModelId: gateCache?.videoModelId ?? '',
    error,
    reload,
  }
}
