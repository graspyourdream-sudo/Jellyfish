/**
 * 资产生产区用到的接口封装（**全部是既有端点，没有新增后端**）。
 *
 * 为什么单独一个模块、而不直接用 `services/llmPipelineApi.ts`：
 * 本轮的改动范围不允许动那个共享模块，而它的 `ImageTaskResult` 缺少生产区需要的字段
 * （长期地址 `oss_url`、归一化口径 `outcome`、失败原文 `error_message`）。
 * 这里用**同一个** `callApi`（同一套统一信封解析）补出完整类型，不另写一套请求逻辑。
 *
 * 用到的端点（全部只读或幂等，且都是同进程内联执行，**不进任何队列**）：
 *   - POST /api/v1/studio/image-pipeline/plan/preview   出图计划预览（不触网、不花钱）
 *   - POST /api/v1/studio/image-pipeline/submit         批量提交出图（同步内联；演练模式返回占位）
 *   - GET  /api/v1/studio/image-pipeline/task/{id}      查询任务（回读产物地址）
 *   - POST /api/v1/studio/image-pipeline/adopt          采纳结果到资产图片槽位
 *   - POST /api/v1/studio/files/external                登记外部公网素材（不下载、不存副本）
 *   - POST /api/v1/studio/entities/{type}/{id}/images   新增一张图片槽位（不覆盖现有图片）
 *   - POST /api/v1/studio/llm/image-prompt/preview      大模型生成/完善图片提示词（演练模式返回占位）
 */

import { callApi, previewImagePrompts } from '../../../../../services/llmPipelineApi'
import { StudioEntitiesApi } from '../../../../../services/studioEntities'

export type AssetImageServiceResult = {
  source_task_id?: string
  source_asset_id?: string
  asset_type?: string
  stage?: string
  service_task_id?: string
  /** 上游原文状态（只进「技术详情」） */
  status?: string
  /** 归一化口径（只进「技术详情」） */
  outcome?: string
  ok?: boolean
  dry_run?: boolean
  image_url?: string
  oss_url?: string
  oss_ready?: boolean
  message?: string
  error_message?: string
  http_status?: number | null
  detail?: Record<string, unknown>
}

export type AssetImageSubmitResponse = {
  project_id: string
  asset_type: string
  stage: string
  results: AssetImageServiceResult[]
  summary: Record<string, unknown>
  outcome: string
  warnings: string[]
  guard_status: string
}

export type AssetImageTaskQuery = {
  service_task_id: string
  status: string
  oss_url: string
  local_path: string
  images: Record<string, unknown>[]
  error_message: string
  dry_run?: boolean
}

export type AdoptAssetImageResponse = {
  entity_type: string
  entity_id: string
  image_id: number
  file_id: string
  /** 落库后的可访问地址（垫图实际用的就是它） */
  url: string
  source_url: string
  is_primary: boolean
  name: string
  url_reachable: boolean | null
  url_probe: Record<string, unknown>
  warnings: string[]
}

export type ExternalFileResponse = {
  id: string
  type?: string
  name?: string
  thumbnail?: string
}

export type AssetImagePlanTargetLike = {
  source_task_id: string
  source_asset_id: string
  asset_type: string
  name: string
  prompt: string
  stage: string
  reference_image: string
  aspect_ratio: string
  prompt_source?: string
  warnings?: string[]
}

export type AssetImagePlanPreview = {
  project_id: string
  asset_type: string
  stage: string
  targets: AssetImagePlanTargetLike[]
  references: Record<string, unknown>[]
  warnings: string[]
  summary: Record<string, unknown>
  dry_run: boolean
}

export type SubmitAssetImagesBody = {
  project_id: string
  asset_type: 'character' | 'scene' | 'prop'
  stage: 'character_sheet' | 'reference_batch'
  asset_ids: string[]
  prompt_overrides?: { asset_id: string; prompt: string }[]
  use_primary_reference: boolean
  aspect_ratio: string
  wait_seconds?: number
  /**
   * 尝试序号（0 = 首轮）。
   *
   * 后端会把 `attempt` 混进幂等键：同一提示词原样重试会被出图服务按既有（失败）任务去重
   * ＝等于没重试；`attempt + 1` 才会拿到**新的**键、真的重新出图。
   * 同一个序号重复提交仍是同一个键（上游去重，页面侧的在途闸门继续拦住连点）。
   */
  attempt?: number
}

/**
 * 提交一轮出图（**一个资产一次调用**）。
 *
 * 为什么按资产逐个调用而不是一次提交一批：提交是同步内联执行的，
 * 一批提交时页面只能等到最后才有结果，也无法在资产之间"停止后续"，
 * 更没法给出「生成中 / 排队中 / 失败」的逐项进度。逐项提交让进度与停止都是真的。
 */
export function submitAssetImages(body: SubmitAssetImagesBody): Promise<AssetImageSubmitResponse> {
  return callApi('/api/v1/studio/image-pipeline/submit', body as unknown as Record<string, unknown>)
}

/** 出图计划预览（只读：不触网、不建任务、不写库）。 */
export function previewAssetImagePlan(body: {
  project_id: string
  asset_type: 'character' | 'scene' | 'prop'
  stage: 'character_sheet' | 'reference_batch'
  asset_ids?: string[]
  use_primary_reference: boolean
  aspect_ratio?: string
}): Promise<AssetImagePlanPreview> {
  return callApi('/api/v1/studio/image-pipeline/plan/preview', body as unknown as Record<string, unknown>)
}

/** 查询出图任务（回读产物地址）。 */
export function queryAssetImageTask(serviceTaskId: string): Promise<AssetImageTaskQuery> {
  return callApi(`/api/v1/studio/image-pipeline/task/${encodeURIComponent(serviceTaskId)}`)
}

/** 采纳结果到资产图片槽位（`set_primary` 由调用方显式决定，默认不动定版）。 */
export function adoptAssetImageResult(body: {
  entity_type: 'character' | 'scene' | 'prop' | 'costume'
  entity_id: string
  url: string
  image_id?: number | null
  set_primary?: boolean
  /** 会顶掉该资产已有定版图时，必须由用户确认后传 true（否则后端结构化 409） */
  confirm_replace_primary?: boolean
  name?: string
}): Promise<AdoptAssetImageResponse> {
  return callApi('/api/v1/studio/image-pipeline/adopt', body as unknown as Record<string, unknown>)
}

/** 登记外部公网素材（不下载、不在本地存副本；地址就是资产长期地址）。 */
export function registerExternalImageFile(body: {
  url: string
  name?: string
  project_id?: string | null
  usage_kind?: string
}): Promise<ExternalFileResponse> {
  return callApi('/api/v1/studio/files/external', {
    ...body,
    type: 'image',
  } as unknown as Record<string, unknown>)
}

/**
 * 找一个**空**的图片槽位（`file_id` 为空的行）。
 *
 * 用途：该资产已经有图片时，采纳必须落到空槽位上 —— 采纳端点在不指定槽位时
 * 会复用第一行，那会把现有图片（很可能就是定版图）悄悄换掉。
 */
export async function findEmptyImageSlot(
  entityType: 'character' | 'scene' | 'prop' | 'costume',
  entityId: string,
): Promise<number | null> {
  try {
    const res = await StudioEntitiesApi.listImages(entityType, entityId, { pageSize: 100 })
    const rows = (res.data?.items ?? []) as { id?: number; file_id?: string | null }[]
    const empty = rows.find((row) => typeof row.id === 'number' && !String(row.file_id ?? '').trim())
    return empty && typeof empty.id === 'number' ? empty.id : null
  } catch {
    // 读不到就不冒风险：返回 null，调用方会走"新增一张"的分支（同样不会覆盖）
    return null
  }
}

/** 新增一张图片槽位（不会覆盖现有图片）。 */
export async function createImageSlot(
  entityType: 'character' | 'scene' | 'prop' | 'costume',
  entityId: string,
  fileId: string,
): Promise<{ id: number; file_id: string | null }> {
  const res = await StudioEntitiesApi.createImage(entityType, entityId, {
    file_id: fileId,
    is_primary: false,
  })
  const row = (res.data ?? {}) as { id?: number; file_id?: string | null }
  if (typeof row.id !== 'number') {
    throw new Error('新增图片槽位失败：接口没有返回图片编号')
  }
  return { id: row.id, file_id: row.file_id ?? null }
}

/** 大模型生成/完善**一个**资产的图片提示词（只预览，不写库）。 */
export async function previewAssetImagePrompt(args: {
  projectId?: string | null
  assetType: string
  name: string
  description: string
  category: string
}): Promise<{ prompt: string; llmCalled: boolean; warnings: string[]; latencyMs: number | null }> {
  const preview = await previewImagePrompts({
    project_id: args.projectId ?? null,
    entity_profiles: [
      {
        name: args.name,
        entity_type: args.assetType,
        profile: args.description,
      },
    ],
    categories: [args.category],
  })
  const slots = Array.isArray(preview?.slots) ? preview.slots : []
  const matched = slots.find((slot) => String(slot?.category ?? '') === args.category) ?? slots[0]
  return {
    prompt: String(matched?.prompt ?? '').trim(),
    llmCalled: Boolean(preview?.meta?.llm_called),
    warnings: Array.isArray(preview?.warnings) ? preview.warnings : [],
    latencyMs: typeof preview?.meta?.latency_ms === 'number' ? preview.meta.latency_ms : null,
  }
}
