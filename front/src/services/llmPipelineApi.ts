/**
 * LLM 管线前端共享 API 层。
 *
 * 为什么单独放一个模块（而不是直接用 `services/generated`）：
 * - 生成客户端来自 `npm run openapi:update`，而那条脚本依赖 pnpm（本机未安装），
 *   且新增的 `/api/v1/studio/llm/*`、`/api/v1/studio/image-pipeline/*` 尚未进入生成物；
 * - 生成目录是自动产物，不应手改。
 * 因此这里按 `PromptFlowPage` 里已有的做法，用 `OpenAPI.BASE` 拼绝对地址直接 fetch，
 * 并按后端统一信封 `{code, message, data, meta}` 解包：成功取 `data`，失败读 `meta.error`。
 *
 * 生产流程的 5 个页面都从这里取能力，避免每页各写一套。
 */

import { OpenAPI } from './generated'

export type AnyRecord = Record<string, any>

/**
 * 带 HTTP 状态码的请求异常。
 *
 * 为什么需要：五类生成状态（DRY_RUN 门禁 / 模型未配置 / 参数缺失 / 服务错误 / 正在处理）
 * 要靠状态码区分，而普通 Error 只剩一句 message，前端只能猜。
 * 它继承 Error，所以既有 `catch (e) { e.message }` 的调用方行为不变。
 */
export class GenerationRequestError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'GenerationRequestError'
    this.status = status
  }
}

async function callApi<T = AnyRecord>(path: string, body?: AnyRecord): Promise<T> {
  const response = await fetch(`${OpenAPI.BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let payload: AnyRecord | undefined
  try {
    payload = text ? (JSON.parse(text) as AnyRecord) : undefined
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    const meta = (payload?.meta ?? {}) as AnyRecord
    const error = (meta.error ?? {}) as AnyRecord
    const detail = payload?.detail
    const suffix = detail ? `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）` : ''
    throw new GenerationRequestError(
      String(error.message ?? payload?.message ?? text ?? `HTTP ${response.status}`) + suffix,
      response.status,
    )
  }
  return (payload?.data ?? null) as T
}

/** PATCH 版本（保存类端点用；POST 版本见 callApi）。 */
async function callApiPatch<T = AnyRecord>(path: string, body: AnyRecord): Promise<T> {
  const response = await fetch(`${OpenAPI.BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let payload: AnyRecord | undefined
  try {
    payload = text ? (JSON.parse(text) as AnyRecord) : undefined
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    const meta = (payload?.meta ?? {}) as AnyRecord
    const error = (meta.error ?? {}) as AnyRecord
    const detail = payload?.detail
    const suffix = detail ? `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）` : ''
    throw new GenerationRequestError(
      String(error.message ?? payload?.message ?? text ?? `HTTP ${response.status}`) + suffix,
      response.status,
    )
  }
  return (payload?.data ?? null) as T
}

/* ------------------------------------------------------------------ 类型 */

/** 图片提示词的一个槽位（与后端 PromptCategory 一致）。 */
export interface ImagePromptSlot {
  category: string
  label?: string
  entity_name?: string | null
  layers: Record<string, string>
  prompt: string
  negative_prompt: string
  warnings?: string[]
}

export interface EntityProfileInput {
  name: string
  entity_type: string
  profile?: string
  base_prompt?: string
  image_prompt?: string
}

export interface LlmRunMeta {
  dry_run: boolean
  llm_called: boolean
  latency_ms?: number | null
  raw_output_chars?: number
  json_repairs?: string[]
  dry_run_reason?: string | null
  target?: { model_name?: string; provider_name?: string; base_url?: string } | null
}

export interface ImagePromptPreviewResult {
  shot_id?: string | null
  project_id?: string | null
  slots: ImagePromptSlot[]
  entity_cards?: AnyRecord[]
  warnings: string[]
  meta: LlmRunMeta
}

export interface VideoPromptPreviewResult {
  shot_id?: string | null
  final_prompt: string
  negative_prompt: string
  camera_movement: { key: string; label: string; enum_code?: string | null; db_note?: string }
  camera: { camera_shot: string; angle: string; movement: string; duration?: number | null }
  frame_mode: string
  duration_seconds: number
  subject_action: string
  expression_mood: string
  atmosphere: string
  action_beats: string[]
  warnings: string[]
  meta: LlmRunMeta
}

export interface BindingSuggestion {
  slot: 'characters' | 'scene' | 'props' | 'costumes'
  asset_id: string
  asset_type: string
  asset_name?: string
  confidence: number
  reason: string
  agreement: 'both' | 'llm_only' | 'conflict' | 'heuristic_only'
  tier: 'auto' | 'review' | 'discard'
  already_bound: boolean
  confirm_endpoint: string
}

export interface AssetBindingShot {
  shot_id: string
  index: number
  title: string
  script_excerpt: string
  suggestions: BindingSuggestion[]
  heuristic_suggestions: Record<string, string[]>
  bound: Record<string, string[]>
  warnings: string[]
}

export interface AssetBindingPreviewResult {
  project_id: string
  catalog: AnyRecord[]
  shots: AssetBindingShot[]
  dropped: AnyRecord[]
  unmatched_names: AnyRecord[]
  parse_warnings: string[]
  batch_count: number
  tier_summary: Record<string, number>
  cost_note: string
  meta: LlmRunMeta
}

export interface ImagePlanTarget {
  source_task_id: string
  source_asset_id: string
  asset_type: string
  name: string
  prompt: string
  stage: string
  reference_image: string
  generation_type: string
  aspect_ratio: string
  image_model: string
  object_key_template: string
  /** 提示词实际来源：request / saved（步骤 3 已保存的 image_prompts）/ template。 */
  prompt_source?: 'request' | 'saved' | 'template' | string
  warnings: string[]
}

export interface ImageTaskResult {
  source_asset_id: string
  service_task_id: string
  status: string
  dry_run: boolean
  image_url: string
  oss_url: string
  message: string
}

export type FrameMode = 'single_frame' | 'first_last_frame'

/* ------------------------------------------------------------ 编排层接口 */

/** 九槽位图片提示词生成（只预览，不写库）。 */
export function previewImagePrompts(body: {
  shot_id?: string | null
  shot_text?: string | null
  project_id?: string | null
  entity_profiles?: EntityProfileInput[]
  categories?: string[]
  style_hint?: string
  negative_prompt?: string
}): Promise<ImagePromptPreviewResult> {
  return callApi('/api/v1/studio/llm/image-prompt/preview', body as AnyRecord)
}

/** 视频提示词生成（只预览，不写库）。 */
export function previewVideoPrompt(body: {
  shot_id?: string | null
  shot_text?: string | null
  first_frame_image_ref?: string | null
  last_frame_image_ref?: string | null
  camera_movement?: string | null
  duration_seconds?: number | null
  frame_mode?: FrameMode | null
  project_id?: string | null
  entity_profiles?: EntityProfileInput[]
}): Promise<VideoPromptPreviewResult> {
  return callApi('/api/v1/studio/llm/video-prompt/preview', body as AnyRecord)
}

/** 资产关联推荐（只建议，不写库；确认后走既有 link 端点）。 */
export function previewAssetBinding(body: {
  project_id: string
  episode_id?: string
  shot_ids?: string[]
  batch_size?: number
  max_shots?: number
  include_heuristic?: boolean
}): Promise<AssetBindingPreviewResult> {
  return callApi('/api/v1/studio/llm/asset-binding/preview', body as AnyRecord)
}

/* -------------------------------------------------------- 出图 / 出视频 */

/** 出图提交计划（不触网）。 */
export function previewImagePlan(body: {
  project_id: string
  asset_type: 'character' | 'scene' | 'prop'
  stage: 'character_sheet' | 'reference_batch'
  asset_ids?: string[]
  prompt_overrides?: { asset_id: string; prompt: string }[]
  use_primary_reference?: boolean
  aspect_ratio?: string
  image_model?: string
  negative_prompt?: string
}): Promise<{
  project_id: string
  asset_type: string
  stage: string
  targets: ImagePlanTarget[]
  references: AnyRecord[]
  warnings: string[]
  summary: AnyRecord
  dry_run: boolean
}> {
  return callApi('/api/v1/studio/image-pipeline/plan/preview', body as AnyRecord)
}

/** 提交出图任务（受守卫；默认 DRY_RUN 返回占位）。 */
export function submitImagePlan(body: {
  project_id: string
  asset_type: 'character' | 'scene' | 'prop'
  stage: 'character_sheet' | 'reference_batch'
  asset_ids?: string[]
  prompt_overrides?: { asset_id: string; prompt: string }[]
  use_primary_reference?: boolean
  aspect_ratio?: string
  image_model?: string
  negative_prompt?: string
  wait_seconds?: number
}): Promise<{
  project_id: string
  results: ImageTaskResult[]
  summary: AnyRecord
  warnings: string[]
  guard_status: string
}> {
  return callApi('/api/v1/studio/image-pipeline/submit', body as AnyRecord)
}

/** 查询出图任务（回读 OSS 地址）。 */
export function queryImageTask(serviceTaskId: string): Promise<AnyRecord> {
  return callApi(`/api/v1/studio/image-pipeline/task/${encodeURIComponent(serviceTaskId)}`)
}

/** 直提出视频的计划预览（不建任务）。 */
export interface VideoPlanFrame {
  role: string
  frame_type: string
  file_id: string
  url: string
  /** **供应商口径**是否可用：本地地址只能变 data URL，对只收 http(s):// / asset:// 的供应商是 false */
  usable: boolean
  /** 引用形态：public / local_data_url / missing / not_found / unreadable */
  ref_kind?: string
  /** 不可用时的具体原因（可直接展示） */
  reason?: string
}

export interface VideoSubmitPlanResult {
  shot_id: string
  provider?: string
  model_name?: string
  resolution?: string
  reference_mode?: string
  reference_image_count?: number
  required_frame_types?: string[]
  frames?: VideoPlanFrame[]
  missing_frame_types?: string[]
  /** 有 file_id 但供应商取不到的帧（与 missing 一样阻止生成） */
  unusable_frame_types?: string[]
  generation_blocked?: boolean
  blocked_reason?: string
  audio_file_id?: string
  audio_url?: string
  audio_opt_out?: boolean
  audio_state?: string
  prompt?: string
  prompt_source?: string
  ratio?: string
  seconds?: number | null
  warnings?: string[]
  guard_status?: string
}

export function previewVideoSubmitPlan(body: {
  shot_id: string
  reference_mode?: string
  prompt?: string
  images?: string[]
  ratio?: string
  duration_seconds?: number | null
}): Promise<AnyRecord> {
  return callApi('/api/v1/studio/image-pipeline/video-plan/preview', body as AnyRecord)
}

/**
 * 采纳生成的图片到资产图片槽位（断点③：落库，刷新后仍在）。
 *
 * 出图提交本身不写库（后端设计如此），所以必须由用户显式采纳才落正式产物。
 * DRY_RUN 的占位地址会被后端拒绝（422）。
 */
export function adoptGeneratedImage(body: {
  entity_type: string
  entity_id: string
  url: string
  image_id?: number | null
  set_primary?: boolean
  name?: string
}): Promise<AnyRecord> {
  return callApi('/api/v1/studio/image-pipeline/adopt', body as AnyRecord)
}

/** 提示词包导出（图片 + 视频 + 绑定 + 参考图，只读）。 */
export function exportPromptPackage(body: {
  project_id: string
  shot_ids?: string[]
  max_shots?: number
  include_image_prompts?: boolean
  include_video_prompts?: boolean
  include_bindings?: boolean
  format?: 'json' | 'text' | 'markdown'
}): Promise<AnyRecord> {
  return callApi('/api/v1/studio/image-pipeline/prompt-package', body as AnyRecord)
}

/** 守卫状态（页面顶部用来显示「当前是否真实付费调用」）。 */
export function getOrchestrationStatus(): Promise<AnyRecord> {
  return callApi('/api/v1/studio/llm/orchestration/status')
}

/* ------------------------------------------- 章节提取候选（第 2 步产物，只读） */

export interface ChapterAssetCandidateItem {
  candidate_type: string
  type_label: string
  name: string
  aliases: string[]
  shot_count: number
  shot_ids: string[]
  statuses: Record<string, number>
  linked_entity_id: string | null
  existing_asset_id: string | null
  linked_to_project: boolean
  linked_to_shot: boolean
  recommendation: 'link_existing' | 'create_new' | string
}

export interface ChapterAssetCandidates {
  chapter_id: string
  project_id: string
  chapter_title: string
  shot_total: number
  shot_with_candidates: number
  summary: {
    total_candidates?: number
    merged_groups?: number
    by_type?: Record<string, number>
    by_status?: Record<string, number>
    link_existing_count?: number
    create_new_count?: number
  }
  items: ChapterAssetCandidateItem[]
  notes: string[]
}

/* ------------------------------------------------- 剧本文档解析（TXT / MD / DOCX） */

export interface ParsedDocument {
  filename: string
  format: string
  text: string
  char_count: number
  paragraph_count: number
  warnings: string[]
}

/**
 * 解析剧本文档为纯文本。
 *
 * 后端只解析、不落盘、不写库、不上传对象存储（`POST /studio/documents/parse`），
 * 因此 DRY_RUN 下也能用，且不会产生任何费用。
 * 旧版 `.doc` 会返回明确错误（「请另存为 DOCX」），这里原样抛出给用户看。
 */
export async function parseScriptDocument(file: File): Promise<ParsedDocument> {
  const form = new FormData()
  form.append('file', file)
  const response = await fetch(`${OpenAPI.BASE}/api/v1/studio/documents/parse`, {
    method: 'POST',
    body: form,
  })
  const text = await response.text()
  let payload: AnyRecord | undefined
  try {
    payload = text ? (JSON.parse(text) as AnyRecord) : undefined
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    const meta = (payload?.meta ?? {}) as AnyRecord
    const error = (meta.error ?? {}) as AnyRecord
    throw new GenerationRequestError(
      String(error.message ?? payload?.message ?? text ?? `HTTP ${response.status}`),
      response.status,
    )
  }
  return (payload?.data ?? null) as ParsedDocument
}

/** 章节提取候选聚合（只读：不建资产、不写库）。 */
export function fetchChapterAssetCandidates(chapterId: string): Promise<ChapterAssetCandidates> {
  return callApi(`/api/v1/studio/chapters/${encodeURIComponent(chapterId)}/asset-candidates`)
}

/* ------------------------------------------------- 九槽位定义（用于手工填写） */

export interface ImagePromptSlotSpec {
  category: string
  label: string
  entity_type: string | null
  view_hint: string
  subject_source: string
}

let slotSpecsCache: ImagePromptSlotSpec[] | null = null

/**
 * 九槽位图片提示词的确定性定义（来自只读的编排层状态端点，**不触网、不花钱**）。
 *
 * 用途：DRY_RUN 下无法真实调用大模型，但用户仍需要一条把自己的提示词写进
 * `image_prompts` 的路；表单的槽位名必须由后端给，不能在前端硬编码。
 */
export async function fetchImagePromptSlots(): Promise<ImagePromptSlotSpec[]> {
  if (slotSpecsCache) return slotSpecsCache
  const data = await callApi<AnyRecord>('/api/v1/studio/llm/orchestration/status')
  const slots = (data?.image_prompt_slots ?? []) as ImagePromptSlotSpec[]
  slotSpecsCache = slots
  return slots
}

/* ------------------------------------------------- 既有端点的便捷封装 */

/**
 * 保存资产级图片提示词（写到 `<entities>` 表的 `image_prompts` JSON 列）。
 *
 * 该列是本次为「下一步直接读取保存结果」新增的；`PATCH /studio/entities/{type}/{id}`
 * 的后端请求体是宽松 dict，所以不需要重新生成客户端。
 */
export function saveAssetImagePrompts(
  entityType: 'character' | 'scene' | 'prop' | 'costume' | 'actor',
  entityId: string,
  imagePrompts: Record<string, string>,
  extra: AnyRecord = {},
): Promise<AnyRecord> {
  return callApiPatch(
    `/api/v1/studio/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`,
    { image_prompts: imagePrompts, ...extra },
  )
}

/** 读取资产级图片提示词（返回空对象表示还没生成过）。 */
export function getAssetImagePrompts(entity: AnyRecord | null | undefined): Record<string, string> {
  const raw = entity?.image_prompts
  if (!raw || typeof raw !== 'object') return {}
  return raw as Record<string, string>
}

/**
 * 设为定版主图（`is_primary`）。
 *
 * 后端会自动把同一资产下其余行清成 false，所以这里只需把目标行置 true。
 * 此前该字段只有 `character_images` 有列、且未在任何 schema 暴露，
 * 因此通过 HTTP 完全不可达——本次迁移后 5 类图片表都已支持。
 */
export function setEntityImagePrimary(
  entityType: 'character' | 'scene' | 'prop' | 'costume' | 'actor',
  entityId: string,
  imageId: number,
  isPrimary = true,
): Promise<AnyRecord> {
  return callApiPatch(
    `/api/v1/studio/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}/images/${imageId}`,
    { is_primary: isPrimary },
  )
}

/** 保存视频提示词到镜头（写 `shot_details.video_prompt` + `video_prompt_source`）。 */
export function saveShotVideoPrompt(
  shotId: string,
  videoPrompt: string,
  source = 'llm',
): Promise<AnyRecord> {
  return callApiPatch(`/api/v1/studio/shot-details/${encodeURIComponent(shotId)}`, {
    video_prompt: videoPrompt,
    video_prompt_source: source,
  })
}

/* --------------------------------------------- 出口A 交付（只读，用于步骤 6 内联预览） */

export interface PromptDeliveryRow {
  shot_id: string
  chapter_id: string
  chapter_label: string
  shot_code: string
  shot_title: string
  video_prompt: string
  video_prompt_source: string
  exportable: boolean
  issue: string
  bound_assets: Record<string, string[]>
  bound_files: Array<Record<string, any>>
}

export interface PromptDeliveryPreview {
  project_id: string
  scope: string
  scope_label: string
  export_sources: string[]
  include_bindings: boolean
  export_source: string
  exportable_count: number
  skipped_count: number
  has_content: boolean
  rows: PromptDeliveryRow[]
  text: string
  note: string
}

/**
 * 交付清单与预览（**纯读**端点，不写库、不触网、不花钱）。
 *
 * 第 6 步「生成与交付」在工作台内联展示它，用户不必跳去「提示词导入/交付」菜单
 * 就能确认"已保存的提示词 + 已绑定的素材"真的进了交付内容。
 */
export function previewPromptDelivery(
  projectId: string,
  chapterId?: string | null,
  scope: 'current_shot' | 'episode' | 'episodes' = 'episode',
  /** 选中镜头范围：给了就只按这些镜头取清单（优先于 chapter_id）。 */
  shotIds?: string[],
): Promise<PromptDeliveryPreview> {
  const query = new URLSearchParams({ scope, include_bindings: 'true' })
  const selected = (shotIds ?? []).filter(Boolean)
  if (selected.length) query.set('shot_ids', selected.join(','))
  if (chapterId) query.set('chapter_id', chapterId)
  return callApi(`/api/v1/studio/prompt-delivery/${encodeURIComponent(projectId)}?${query.toString()}`)
}

/* ------------------------------------------- 直提落库（生成结果 → files → 镜头） */

export interface SubmitVideoResult {
  shot_id: string
  provider?: string
  status: string
  url?: string
  file_id?: string
  provider_task_id?: string
  elapsed_ms?: number
  error?: string
  warnings?: string[]
  guard_status?: string
}

/**
 * 直提出视频（**同进程内联执行**，不经过 Celery 队列）。
 *
 * 与 `/api/v1/film/tasks/video` 的区别：那条链路把任务丢给队列，本机没有 Redis / worker 时
 * 任务只会停在 pending（"点生成没反应"）。这条会真的等到结果。
 * DRY_RUN 下返回 `status: dry_run` 的占位结果，不花钱。
 */
export function submitVideo(body: {
  shot_id: string
  reference_mode: string
  prompt: string
  images?: string[]
  ratio: string
  duration_seconds?: number
  timeout_seconds?: number
}): Promise<SubmitVideoResult> {
  return callApi('/api/v1/studio/image-pipeline/video-submit', body as AnyRecord)
}

/**
 * 把生成结果落库并挂到镜头：登记素材 → 写 `shot.generated_video_file_id`。
 *
 * 直提端点本身不写库（结果只在响应里），不落库的话刷新就没了、交付也读不到。
 * 返回 file_id。
 */
export async function persistGeneratedVideo(shotId: string, url: string, name?: string): Promise<string> {
  const created = await callApi<AnyRecord>('/api/v1/studio/files/external', {
    url,
    name: name || `镜头视频（直提）`,
    type: 'video',
    shot_id: shotId,
    usage_kind: 'generated_video',
  })
  const fileId = String(created?.id ?? '').trim()
  if (!fileId) throw new Error('视频已生成但登记素材失败（没有拿到 file_id）')
  await callApiPatch(`/api/v1/studio/shots/${encodeURIComponent(shotId)}`, {
    generated_video_file_id: fileId,
  })
  return fileId
}

export { callApi, callApiPatch }

/* --------------------------------------- 关键帧出图（同进程内联，不走队列） */

export type FrameSubmitFrameType = 'first' | 'key' | 'last'

/** 一个可选的图片模型（关键帧走哪条出图通道）。 */
export interface ImageModelOption {
  id: string
  name: string
  provider_id: string
  description?: string
}

/**
 * 列出可用的**图片**模型。
 *
 * 关键帧用哪条通道出图，直接决定「参考图到底有没有被送出去」：
 * - `model-image2` → 出图服务垫片（本机 4321 → 4173），垫片自己写明 `/images/edits` 的参考图**无法透传**；
 * - `model-gpt-image-2` → APIMart 直连，参考图以 `image_urls`（公网地址）真的送出去。
 */
export async function fetchImageModels(): Promise<ImageModelOption[]> {
  const data = await callApi<AnyRecord>('/api/v1/llm/models?category=image&page=1&page_size=100')
  const items = Array.isArray(data?.items) ? data.items : []
  return items.map((item: AnyRecord) => ({
    id: String(item?.id ?? ''),
    name: String(item?.name ?? ''),
    provider_id: String(item?.provider_id ?? ''),
    description: String(item?.description ?? ''),
  }))
}

export interface FrameSubmitResult {
  shot_id: string
  frame_type: FrameSubmitFrameType
  status: string
  dry_run?: boolean
  task_id?: string
  provider?: string
  provider_task_id?: string
  image_url?: string
  file_id?: string
  image_slot_id?: number | null
  prompt?: string
  prompt_source?: string
  reference_file_ids?: string[]
  /** 供应商/适配层的如实说明，例如垫片回传「参考图未透传」。 */
  provider_notes?: string[]
  elapsed_ms?: number
  error?: string
  warnings?: string[]
  guard_status?: string
  note?: string
}

export interface FramePlanResult {
  shot_id: string
  frame_type: FrameSubmitFrameType
  prompt: string
  prompt_source: string
  reference_file_ids: string[]
  reference_count: number
  target_ratio: string
  target_ratio_source: string
  resolution_profile: string
  provider: string
  model_name: string
  image_slot_id: number | null
  warnings: string[]
  dry_run: boolean
}

/**
 * 关键帧出图计划预览：**只看**这一帧会用哪条提示词（来源）、带哪些参考图、什么画幅。
 *
 * 不触网、不建任务、不写库 —— 用来在花钱之前回答「我保存的提示词到底有没有被用上」。
 */
export function previewFramePlan(body: {
  shot_id: string
  frame_type: FrameSubmitFrameType
  prompt?: string
  images?: string[]
  target_ratio?: string
  resolution_profile?: 'standard' | 'high'
  model_id?: string | null
}): Promise<FramePlanResult> {
  return callApi('/api/v1/studio/image-pipeline/frame-plan/preview', body as AnyRecord)
}

/**
 * 关键帧出图（**同进程内联执行**）。
 *
 * 与 `/studio/image-tasks/shot/{id}/frame-image-tasks` 的区别：那条只建一条 Celery 任务行，
 * 本机没有 broker/worker 时永远停在「排队中」（用户看到的就是"点了生成没反应"）。
 * 这条会真的等到结果，并把图片写进 `shot_frame_images.file_id`（刷新后仍在）。
 * DRY_RUN 下返回 `status: dry_run` 的计划，不花钱、不写库。
 */
export function submitFrameImage(body: {
  shot_id: string
  frame_type: FrameSubmitFrameType
  prompt?: string
  images?: string[]
  target_ratio?: string
  resolution_profile?: 'standard' | 'high'
  model_id?: string | null
  timeout_seconds?: number
}): Promise<FrameSubmitResult> {
  return callApi('/api/v1/studio/image-pipeline/frame-submit', body as AnyRecord)
}

/* ------------------------------- 集级视频提示词看板（进入分镜工作台之前的主入口） */

export type PromptBoardOrigin = 'llm_draft' | 'jurilu_import' | 'external_import' | 'manual'
export type PromptBoardMode = 'fill_empty' | 'overwrite_selected'

export interface PromptBoardShot {
  shot_id: string
  index: number
  code: string
  title: string
  script_excerpt: string
  video_prompt: string
  video_prompt_source: string
  has_prompt: boolean
}

export interface PromptBoardRead {
  chapter_id: string
  shots: PromptBoardShot[]
  summary: { total: number; with_prompt: number; missing: number }
}

/** 集级看板：本集镜头 + 当前提示词与来源（只读）。 */
export function fetchPromptBoard(chapterId: string): Promise<PromptBoardRead> {
  return callApi(`/api/v1/studio/prompt-board/${encodeURIComponent(chapterId)}`)
}

export interface BoardReadinessRow {
  shot_id: string
  code: string
  index: number
  title: string
  has_prompt: boolean
  video_prompt: string
  video_prompt_source: string
  bound_image_total: number
  bound_image_usable: number
  bound_image_missing_names: string[]
  audio_file_id: string
  audio_opt_out: boolean
  required_frame_types: string[]
  usable_frame_types: string[]
  missing_frame_types: string[]
  /** 有 file_id 但供应商取不到的帧（例如本机地址只能变 data URL） */
  unusable_frame_types?: string[]
  /** 帧不可用/缺失的具体原因（可直接展示） */
  frame_block_reasons?: string[]
  /** 生成是否被参考帧阻断（缺帧 ∪ 帧不可用；text_only 恒为 false） */
  generation_blocked?: boolean
}

/** 集级就绪批量读取（只读、不触网）：顶部三态 / 定位 / 门禁共用这一份数据。 */
export function fetchBoardReadiness(
  chapterId: string,
  referenceMode = 'first',
): Promise<{ chapter_id: string; reference_mode: string; rows: BoardReadinessRow[]; summary: AnyRecord }> {
  return callApi(
    `/api/v1/studio/prompt-board/${encodeURIComponent(chapterId)}/readiness?reference_mode=${encodeURIComponent(referenceMode)}`,
  )
}

export interface PromptDraftResult {
  shot_id: string
  code?: string
  status: 'draft' | 'dry_run' | 'failed' | 'skipped' | 'error'
  prompt?: string
  draft_token?: string
  reason?: string
  latency_ms?: number
  warnings?: string[]
}

/** 单镜生成草稿（真 LLM，不落库）：页面据此逐镜排队，可随时停止。 */
export function draftVideoPrompt(
  chapterId: string,
  body: { shot_id: string; mode?: PromptBoardMode },
): Promise<PromptDraftResult> {
  return callApi(`/api/v1/studio/prompt-board/${encodeURIComponent(chapterId)}/draft`, body as AnyRecord)
}

export interface PromptImportEntry {
  number: number | null
  prompt: string
  shot_id: string
  matched_by: string
  status: string
  message: string
}

export interface PromptImportPreview {
  entries: PromptImportEntry[]
  issues: string[]
  save_allowed: boolean
  count_mismatch: boolean
  matched_only_save_allowed: boolean
  shots: PromptBoardShot[]
  summary: { total: number; ok: number; unmatched: number }
}

/** 批量导入解析 + 匹配（**不落库**）：粘贴文本与上传文件都走这里。 */
export function parsePromptImport(chapterId: string, text: string): Promise<PromptImportPreview> {
  return callApi(`/api/v1/studio/prompt-board/${encodeURIComponent(chapterId)}/import-parse`, { text } as AnyRecord)
}

export interface PromptBoardSaveResult {
  applied_count: number
  skipped_count: number
  results: Array<{ shot_id: string; code?: string; applied: boolean; reason: string }>
  error?: string
  source?: string
}

/**
 * 确认后批量保存。**来源由流程决定**：调用方只能给出 origin（哪种流程来的），
 * 服务端映射成真实 source；`llm_draft` 的条目必须带后端签发的 draft_token。
 */
export function savePromptBoard(
  chapterId: string,
  body: {
    entries: Array<{ shot_id: string; prompt: string; draft_token?: string }>
    mode: PromptBoardMode
    origin: PromptBoardOrigin
    selected_shot_ids?: string[]
    allow_partial?: boolean
  },
): Promise<PromptBoardSaveResult> {
  return callApi(`/api/v1/studio/prompt-board/${encodeURIComponent(chapterId)}/save`, body as AnyRecord)
}

/**
 * 下载「出口 A」的 TXT（**真实文件下载**，不走 window.open）。
 *
 * 为什么不用 window.open：
 * 1. 前端 dev server 没有 `/api` 代理，相对地址会被 SPA fallback 接住 → 打开一个 404 页面，
 *    却让人以为"导出成功"；
 * 2. 失败时无法感知：404/500 也会被当成一次成功跳转。
 * 这里用 fetch + Blob + `<a download>`：地址强制指向 `OpenAPI.BASE`（真实后端），
 * 非 2xx 直接抛错由页面提示，成功则触发浏览器的 download 事件并带上后端文件名。
 */
export async function downloadDeliveryTxt(
  projectId: string,
  chapterId: string | null | undefined,
  shotIds: string[],
): Promise<{ url: string; filename: string; bytes: number }> {
  const params = new URLSearchParams()
  const selected = shotIds.filter(Boolean)
  if (selected.length) {
    params.set('scope', 'episode')
    params.set('shot_ids', selected.join(','))
  } else {
    params.set('scope', chapterId ? 'episode' : 'episodes')
  }
  if (chapterId) params.set('chapter_id', chapterId)
  params.set('include_bindings', 'true')
  const base = String(OpenAPI.BASE ?? '').replace(/\/+$/, '')
  const url = `${base}/api/v1/studio/prompt-delivery/${encodeURIComponent(projectId)}/export?${params.toString()}`

  const response = await fetch(url)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`导出失败：HTTP ${response.status}${text ? `（${text.slice(0, 120)}）` : ''}`)
  }
  const blob = await response.blob()
  if (!blob.size) throw new Error('导出失败：后端返回了空文件')

  const disposition = response.headers.get('content-disposition') || ''
  const matched = /filename="?([^";]+)"?/i.exec(disposition)
  const filename = matched?.[1] || `${projectId}-prompt.txt`

  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
  return { url, filename, bytes: blob.size }
}

export interface JuriluPreviewRow {
  action: string
  order: number
  label: string
  summary: string
  prompt: string
  source: string
  reason?: string
  shot_id?: string
  index?: number
  title?: string
}

export interface JuriluPreviewResult {
  chapter_id: string
  chapter_shot_count: number
  entry_count: number
  plan_summary: string
  counts: Record<string, number>
  rows: JuriluPreviewRow[]
  diagnostics?: AnyRecord
  warnings?: string[]
  source_url?: string
}

/**
 * 巨日禄 Cookie 导入**预览**（抓取 + 配对，**不写库**）。
 * Cookie 只用于本次抓取：不保存、不回显、不写日志（后端已保证）。
 */
export function previewJuriluImport(
  projectId: string,
  body: {
    chapter_id: string
    url: string
    cookie?: string
    authorization?: string
    auth_mode?: string
    referer?: string
    api_url_override?: string
    create_missing?: boolean
    overwrite?: boolean
  },
): Promise<JuriluPreviewResult> {
  return callApi(`/api/v1/studio/jurilu-import/${encodeURIComponent(projectId)}/preview`, body as AnyRecord)
}
