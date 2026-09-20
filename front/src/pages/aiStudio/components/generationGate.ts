/**
 * 生成状态钩子：读取「门禁状态」与「每个出口真实的模型配置」，并复用纯逻辑做判定。
 *
 * 数据来源（全部是只读端点，不触网、不花钱）：
 *   - `GET /api/v1/studio/llm/orchestration/status` → guard（dry_run / env / 原文）
 *   - `GET /api/v1/llm/model-settings`             → 默认文本 / 图片 / 视频模型 id
 *   - `GET /api/v1/llm/models`                     → 模型表（校验 id 真实存在、类别匹配）
 *   - `GET /api/v1/llm/providers`                  → 供应商表（校验模型挂的供应商存在且未停用）
 *
 * 为什么要查三张表而不是只看一个默认 id：
 * 收口要求「图片和视频出口不能只依赖文本模型状态，必须使用各自真实的配置来源；
 * 无法确认时写『配置状态无法确认』」。只看 `default_*_model_id` 非空就宣称「已配置」，
 * 会把「id 指向一个不存在的模型 / 挂了一个不存在或已停用的供应商」也报成已配置。
 *
 * 纯逻辑（状态判定与错误分类）在 `generationStatusCore.ts`，本文件只负责取数与缓存。
 */

import { useCallback, useEffect, useState } from 'react'
import { getOrchestrationStatus } from '../../../services/llmPipelineApi'
import { OpenAPI } from '../../../services/generated'
import {
  FALLBACK_CONFIRM_ENV,
  FALLBACK_GUARD_ENV,
  type GenerationGateSnapshot,
  type GenerationOutlet,
  type ModelConfigInfo,
} from './generationStatusCore'

export * from './generationStatusCore'

type ModelRow = { id?: string; name?: string; category?: string; provider_id?: string }
type ProviderRow = { id?: string; name?: string; status?: string }

const DEFAULT_MODEL_KEYS: Record<GenerationOutlet, string> = {
  llm: 'default_text_model_id',
  image: 'default_image_model_id',
  video: 'default_video_model_id',
}

const EXPECTED_CATEGORY: Record<GenerationOutlet, string> = {
  llm: 'text',
  image: 'image',
  video: 'video',
}

const OUTLET_LABEL: Record<GenerationOutlet, string> = {
  llm: '文本模型',
  image: '图片模型',
  video: '视频模型',
}

async function getJson(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${OpenAPI.BASE}${path}`)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`GET ${path} 失败（HTTP ${response.status}）：${text.slice(0, 200)}`)
  }
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  return (payload?.data ?? {}) as Record<string, unknown>
}

/** 全量分页读取（后端单页上限 100）。 */
async function getAllRows(path: string, key = 'items'): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  let page = 1
  let maxPage = 1
  do {
    const data = await getJson(`${path}${path.includes('?') ? '&' : '?'}page=${page}&page_size=100`)
    const items = Array.isArray(data?.[key]) ? (data[key] as Record<string, unknown>[]) : []
    rows.push(...items)
    const pagination = (data?.pagination ?? {}) as { max_page?: number }
    maxPage = typeof pagination.max_page === 'number' && pagination.max_page > 0 ? pagination.max_page : 1
    page += 1
  } while (page <= maxPage && rows.length < 500)
  return rows
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 判定单个出口的模型配置状态。
 *
 * 返回 `unknown` 的几种情况都必须向用户说明原因，不允许默认当成「已配置」。
 */
function resolveModelConfig(
  outlet: GenerationOutlet,
  settings: Record<string, unknown>,
  models: ModelRow[],
  providers: ProviderRow[],
  modelsLoaded: boolean,
  providersLoaded: boolean,
): ModelConfigInfo {
  const label = OUTLET_LABEL[outlet]
  const modelId = readString(settings, DEFAULT_MODEL_KEYS[outlet])

  if (!modelId) {
    return { state: 'missing', modelName: '', reason: `没有配置默认${label} id。` }
  }
  if (!modelsLoaded) {
    return {
      state: 'unknown',
      modelName: '',
      reason: `读不到模型表，无法确认默认${label}（id=${modelId}）是否真的存在。`,
    }
  }
  const model = models.find((item) => readString(item, 'id') === modelId)
  if (!model) {
    return { state: 'unknown', modelName: '', reason: `默认${label} id=${modelId} 在模型表里查不到。` }
  }
  const category = readString(model, 'category')
  if (category && EXPECTED_CATEGORY[outlet] && category !== EXPECTED_CATEGORY[outlet]) {
    return {
      state: 'unknown',
      modelName: '',
      reason: `默认${label} id=${modelId} 的类别是「${category}」，与该出口不匹配。`,
    }
  }
  const providerId = readString(model, 'provider_id')
  if (providersLoaded && providerId) {
    const provider = providers.find((item) => readString(item, 'id') === providerId)
    if (!provider) {
      return {
        state: 'unknown',
        modelName: '',
        reason: `默认${label}（${readString(model, 'name') || modelId}）挂的供应商 ${providerId} 不在供应商表里。`,
      }
    }
    if (readString(provider, 'status').toLowerCase() === 'disabled') {
      return {
        state: 'missing',
        modelName: '',
        reason: `默认${label}（${readString(model, 'name') || modelId}）的供应商「${
          readString(provider, 'name') || providerId
        }」已停用。`,
      }
    }
  }
  return { state: 'configured', modelName: readString(model, 'name') || modelId, reason: '' }
}

const EMPTY_MODEL_CONFIG: Record<GenerationOutlet, ModelConfigInfo> = {
  llm: { state: 'unknown', modelName: '', reason: '尚未读取配置状态。' },
  image: { state: 'unknown', modelName: '', reason: '尚未读取配置状态。' },
  video: { state: 'unknown', modelName: '', reason: '尚未读取配置状态。' },
}

type GateCache = {
  dryRun: boolean
  guardText: string
  guardEnv: string
  confirmEnv: string
  models: Record<GenerationOutlet, ModelConfigInfo>
}

let gateCache: GateCache | null = null

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
        // 门禁与模型配置各自独立请求：一个失败不应让另一个也变成「无法确认」。
        const [orchestrationResult, settingsResult, modelsResult, providersResult] = await Promise.allSettled([
          getOrchestrationStatus(),
          getJson('/api/v1/llm/model-settings'),
          getAllRows('/api/v1/llm/models'),
          getAllRows('/api/v1/llm/providers'),
        ])

        if (orchestrationResult.status === 'rejected') {
          throw orchestrationResult.reason
        }
        const orchestration = (orchestrationResult.value ?? {}) as Record<string, unknown>
        const guard = (orchestration.guard ?? {}) as Record<string, unknown>
        const settings =
          settingsResult.status === 'fulfilled' ? (settingsResult.value as Record<string, unknown>) : {}
        const models = modelsResult.status === 'fulfilled' ? (modelsResult.value as ModelRow[]) : []
        const providers = providersResult.status === 'fulfilled' ? (providersResult.value as ProviderRow[]) : []
        const modelsLoaded = modelsResult.status === 'fulfilled'
        const providersLoaded = providersResult.status === 'fulfilled'

        gateCache = {
          dryRun: guard.dry_run !== false,
          guardText: String(orchestration.guard_status_text ?? ''),
          guardEnv: String(guard.env ?? FALLBACK_GUARD_ENV),
          confirmEnv: String(guard.confirm_env ?? FALLBACK_CONFIRM_ENV),
          models: {
            llm: resolveModelConfig('llm', settings, models, providers, modelsLoaded, providersLoaded),
            image: resolveModelConfig('image', settings, models, providers, modelsLoaded, providersLoaded),
            video: resolveModelConfig('video', settings, models, providers, modelsLoaded, providersLoaded),
          },
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
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
    models: gateCache?.models ?? EMPTY_MODEL_CONFIG,
    error,
    reload,
  }
}
