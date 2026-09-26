/**
 * 「广告剧情流程」的取数层（剧情策划页专用）。
 *
 * 为什么不走 OpenAPI generated client
 * ------------------------------------
 * 已提交的 `front/openapi.json` 与源码**已经漂移**（源码 165 个路由装饰器、
 * spec 里只有 138 条 path），`pnpm run openapi:update` 生成出来的 client 里没有本批新端点。
 * 生成目录是自动产物、不该手改，所以这里按 `llmPipelineApi` 的既有做法直接 fetch：
 * 复用它的 `callApi`（GET/POST）与 `GenerationRequestError`（同一套信封解析与错误类型），
 * 只为 PUT 补一个本地薄封装 —— 不往共享的 1400 行模块里加东西，避免多线同时改同一个文件。
 *
 * 能力探测：本批端点是否已上线**靠读 /openapi.json 判断**，不靠"先试着调一次"
 * （那会真的扣钱）。先例见 `assetProductionApi.fetchReferenceReworkAvailability`。
 *
 * 本文件覆盖的范围（剧情广告闭环，见 `site/content/docs/plans/drama-ad-full-loop.md` 二）：
 *   - 商品卡：`GET/PUT /projects/{pid}/product-card`、`POST …/product-card/extract`（付费 1 次）
 *   - 资料解析与归档：`POST /documents/parse`（TXT/MD/DOCX → 纯文本）、
 *     `POST /files/upload`（图片归档，落 `file_id`）
 *   - 选已有商品资料：`GET /entities/product`
 *   - 分层剧情：`POST /chapters/{cid}/drama-plan/generate {stage, confirm_overwrite}`、
 *     `POST …/consistency`、`POST …/confirm`
 *
 * 三条付费口径（页面文案与这里一致，不许各写一套）：
 *   1. `extract` 与 `generate` 都是**一次模型调用**，按钮上必须写明；
 *   2. 演练模式下后端返回 `source_summary.llm_called=false` 与说明性 `note`，
 *      页面据此照实说"本次没有调用模型"，**不许谎报已提取**；
 *   3. 其余端点（商品卡读写、资料解析、草稿保存、一致性检查、确认落库）都免费。
 */

import { OpenAPI } from './generated/core/OpenAPI'
/* `GenerationRequestError` 只用于再导出（`export type`），所以走 `import type`；
   `buildRequestFailure` 是构造出口（值），必须走值导入。 */
import { buildRequestFailure, callApi } from './llmPipelineApi'
import type { AnyRecord, GenerationRequestError } from './llmPipelineApi'

const API = '/api/v1/studio'

// ---------------------------------------------------------------------------
// 类型（与后端 schemas/studio/drama_plan.py 一一对应）
// ---------------------------------------------------------------------------

export type DramaBrief = {
  product_name: string
  product_description: string
  selling_points: string[]
  target_audience: string
  genre: string
  tone: string
  duration_seconds: number
  shot_count: number
  brand_voice: string
  mandatory_elements: string[]
  forbidden_elements: string[]
  director_notes: string
}

export type DramaPlanDialogue = { speaker: string; text: string; mode: string }

export type DramaPlanShot = {
  index: number
  title: string
  characters: string[]
  script_excerpt: string
  description: string
  duration: number
  camera_shot: string
  angle: string
  movement: string
  action_beats: string[]
  dialogue: DramaPlanDialogue[]
  product_present: boolean
}

/**
 * 角色 / 场景 / 道具 / 商品共用的草稿形状。
 *
 * `relation` 只在角色上有意义（契约 §二 `characters: [{name, relation, profile{}}]`）：
 * 资产预览那一段要把"和主角什么关系"显示出来，所以它是页面要读的字段（可缺）。
 */
export type DramaPlanNamedAsset = {
  name: string
  relation?: string
  profile: Record<string, string>
  shot_indexes: number[]
}

/**
 * 分层剧情的「完整剧情」段（契约 §二 `plan.story`）。
 *
 * 五段（钩子 / 冲突 / 商品介入 / 高潮反转 / 结尾引导）与 `full_text` 是**并列**关系：
 * `full_text` 是用户要通读、要能整段编辑的全文，五段是结构化摘录。
 * 全部字段允许缺失：草稿可能是旧版（只有 `logline` + `climax`）或后端尚未升级。
 */
export type DramaStory = {
  full_text: string
  hook: string
  conflict: string
  product_usage: string
  climax: string
  cta: string
}

export type DramaPlan = {
  /** 一句话核心创意（分层生成的新字段；旧草稿没有） */
  one_liner?: string
  /** 受众情绪目标 */
  audience_emotion?: string
  title: string
  logline: string
  selling_points: string[]
  characters: DramaPlanNamedAsset[]
  scenes: DramaPlanNamedAsset[]
  /** 道具：契约的 plan JSON 目前没列它；后端给了就显示，没给就照实说没有 */
  props?: DramaPlanNamedAsset[]
  product: (DramaPlanNamedAsset & { description: string }) | null
  story?: DramaStory | null
  shots: DramaPlanShot[]
  climax: string
  warnings: string[]
}

/**
 * `drama_plan_drafts.stale_flags`（过期标记，后端 `DramaPlanStaleFlags`）。
 *
 * 字段缺失 = 不知道，不推断。`reasons` 是后端给的中文原因（页面可以直接显示）。
 */
export type DramaStaleFlagsRead = {
  one_liner_changed_at?: string
  story_changed_at?: string
  story_generated_at?: string
  shots_generated_at?: string
  story_stale?: boolean
  shots_stale?: boolean
  reasons?: string[]
  /* 兼容位：后端目前不下发这两个时间戳（覆盖判定在服务端做），前端读到就用、读不到不猜。 */
  manual_edited_at?: string
  generated_at?: string
}

/** 一致性检查的一条问题（`code` / `level` / `message` / `fix`）。 */
export type DramaPlanConsistencyIssue = {
  code?: string
  level?: string
  message?: string
  fix?: string
  [key: string]: unknown
}

/** 一致性检查的摘要（页面一行提示用；`text` 是后端给的中文总结）。 */
export type DramaPlanConsistencySummary = {
  errors?: number
  warnings?: number
  shots?: number
  product_shots?: number
  product_required?: number
  story_chars?: number
  characters?: number
  scenes?: number
  text?: string
}

export type DramaPlanConsistencyRead = {
  chapter_id?: string
  ok?: boolean
  issues?: DramaPlanConsistencyIssue[]
  summary?: DramaPlanConsistencySummary
  note?: string
  [key: string]: unknown
}

export type DramaPlanRead = {
  chapter_id: string
  project_id: string
  has_draft: boolean
  status: 'none' | 'running' | 'ok' | 'failed' | string
  /** 策划确认状态（与生成状态 `status` 分工不同：none / draft / confirmed） */
  story_status?: string
  brief: DramaBrief
  plan: DramaPlan | null
  error: string
  model: string
  meta: Record<string, unknown>
  claim_expires_at: string
  updated_at: string
  note: string
  /** 分层生成的过期标记（后端重算；页面据此显示「可能过期」） */
  stale_flags?: DramaStaleFlagsRead
  /** 一致性检查结果（最近一次） */
  consistency?: DramaPlanConsistencyRead | null
  /** 剧情广告阶段（与项目列表同一个口径） */
  ad_phase?: string
  ad_phase_label?: string
  confirmed_at?: string
  materialized_at?: string
  /** 落库统计（确认结果的结构化留档，幂等复核与页面回显都用它） */
  materialize_summary?: Record<string, unknown>
}

/**
 * 确认落库的结果。
 *
 * 字段按契约 §三：`assets_created` / `materials_linked` / `skipped[]` / `next_step` 是本轮新增，
 * 既有的 `characters_created` / `scenes_created` / `product_created` 保留（旧后端也返回它）
 * —— 页面按「有就显示、没有就不显示」处理，两种后端都能用。
 */
export type DramaPlanConfirm = {
  chapter_id?: string
  shots_created: number
  shots_updated?: number
  dialog_lines_created?: number
  dialog_lines_updated?: number
  assets_created?: number
  assets_reused?: number
  materials_linked?: number
  characters_created?: number
  scenes_created?: number
  product_created?: boolean
  shot_product_links: number
  shot_character_links?: number
  skipped?: string[]
  warnings: string[]
  /**
   * 下一步入口（第 2 步资产准备）。
   *
   * `url` 是契约口径（不带章节参数），`chapter_url` 带上刚确认的这一集 ——
   * 页面**优先用后者**：第 2 步按章节取镜头资产，少了参数会自己再找一集。
   */
  next_step?: { label?: string; url?: string; chapter_url?: string } | null
  note?: string
}

/** 分层生成的阶段（契约 §二 `generate` 请求体）。`all` 兼容旧的一次生成全部。 */
export type DramaGenerateStage = 'one_liner' | 'story' | 'storyboard' | 'all'

export type WorkingChapter = { chapter_id: string; project_id: string; created: boolean; title: string }

/* ------------------------------------------------------------ 商品卡 */

export type ProductSourceType = 'manual' | 'paste' | 'upload' | 'existing'

export type ProductCardReferenceFile = { file_id: string; name: string; kind: string }

/** 商品卡的可编辑字段（与后端 `ProductCardUpdate` 一一对应）。 */
export type ProductCardFields = {
  name: string
  category: string
  brand: string
  selling_points: string[]
  audience: string
  scenarios: string[]
  price_info: string
  compliance: string
  notes: string
  reference_files: ProductCardReferenceFile[]
}

export type ProductCardRead = ProductCardFields & {
  project_id: string
  source_type: ProductSourceType | string
  confirmed: boolean
  /** 服务端算出的缺项（页面优先用它显示「待补充」） */
  missing_fields: string[]
  /** 缺项的中文名（后端早就给了，页面直接用，不自己拼） */
  missing_labels: string[]
  /** 技术详情用：来源文件名、原文字数、提取时间、使用的模型 */
  source_summary: Record<string, unknown>
  updated_at: string
  note: string
}

export type ProductCardExtractRequest = {
  source_type: ProductSourceType
  text?: string
  file_ids?: string[]
  existing_product_id?: string
  extra_instructions?: string
}

/**
 * 提取结果：**不落库**（由用户核对后走 PUT 保存）。
 *
 * `source_summary` 里有两个页面必须读的键（后端 `product_extraction.build_source_summary`）：
 * `llm_called`（本次到底调没调模型）与 `extraction_status`
 * （`llm_extracted` / `dry_run_not_called` / `no_text_source_not_called` / `existing_mapped_not_called`）。
 */
export type ProductCardExtractRead = {
  fields: ProductCardFields
  missing_fields: string[]
  missing_labels: string[]
  source_summary: Record<string, unknown>
  warnings: string[]
  note: string
}

/** 资料解析结果（`POST /documents/parse`）：只有纯文本，不含任何存储地址。 */
export type DocumentParseRead = {
  filename: string
  format: string
  text: string
  char_count: number
  paragraph_count: number
  warnings: string[]
}

/** 上传归档结果（`POST /files/upload`）：只需要 `file_id` 与显示名。 */
export type UploadedFileRead = {
  id: string
  name: string
  type?: string
  thumbnail?: string
  url?: string
  url_reachable?: boolean | null
  warnings?: string[]
}

/** 选已有商品资料时用的一行（`GET /entities/product`）。 */
export type ProductEntityOption = { id: string; name: string; description?: string }

/** 空商品卡字段（新建 / 后端返回干净卡时的默认值）。 */
export function emptyProductCardFields(): ProductCardFields {
  return {
    name: '',
    category: '',
    brand: '',
    selling_points: [],
    audience: '',
    scenarios: [],
    price_info: '',
    compliance: '',
    notes: '',
    reference_files: [],
  }
}

/** 空 brief（新建时的默认值）。 */
export function emptyBrief(): DramaBrief {
  return {
    product_name: '',
    product_description: '',
    selling_points: [],
    target_audience: '',
    genre: '',
    tone: '',
    duration_seconds: 0,
    shot_count: 6,
    brand_voice: '',
    mandatory_elements: [],
    forbidden_elements: [],
    director_notes: '',
  }
}

// ---------------------------------------------------------------------------
// 薄封装（callApi 只有 GET/POST；PUT 与 multipart 各有一个薄封装，同一习惯）
// ---------------------------------------------------------------------------

/**
 * 结构化错误信封 → `detail`。
 *
 * 本批新端点按 `api/utils.error_envelope` 把结构化明细放在 **`meta.error`** 里
 * （与 `image_pipeline` / `prompt_board` 同一形状），而 `buildRequestFailure` 读的是
 * `payload.detail`。这里只把信封**摆正**（不改任何话术、不新建错误类型），
 * 于是 `error.detail.code` 能像既有 `image_prompt_replace_required` 那样被结构化读取
 * （例：商品卡确认被 409 拒绝时的 `product_card_required_missing`）。
 * 没有 `meta.error` 时原样返回 —— 老端点行为一个字节都不变。
 */
function withStructuredDetail(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!payload || payload.detail !== undefined) return payload
  const meta = (payload.meta ?? {}) as Record<string, unknown>
  if (meta.error === undefined || meta.error === null) return payload
  return { ...payload, detail: meta.error }
}

async function parseJsonPayload(text: string): Promise<Record<string, unknown> | undefined> {
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

async function callApiPut<T = Record<string, unknown>>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${OpenAPI.BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let payload = await parseJsonPayload(text)
  if (!response.ok) {
    /* 与 `callApi` 同口径（审计 §4.7 服务层）：`message` 只保留中文结论，
       后端原文 / `detail` / 响应体 / 状态码收进 `GenerationRequestError.technical`。
       本文件是 `callApi` 的同型薄封装，**不在这里另起一套话术** —— 复用同一个构造出口。 */
    payload = withStructuredDetail(payload)
    throw buildRequestFailure(null, response.status, text, payload)
  }
  return (payload?.data ?? null) as T
}

/**
 * multipart 薄封装（资料解析 / 图片归档）。
 *
 * `action` 是**主区中文结论**（后端原文照旧只进技术字段），与 `parseScriptDocument` 同一口径；
 * 这里额外做结构化信封摆正，理由与 `callApiPut` 相同。
 */
async function callApiUpload<T = Record<string, unknown>>(
  path: string,
  form: FormData,
  action: string,
): Promise<T> {
  const response = await fetch(`${OpenAPI.BASE}${path}`, { method: 'POST', body: form })
  const text = await response.text()
  const payload = withStructuredDetail(await parseJsonPayload(text))
  if (!response.ok) {
    throw buildRequestFailure(action, response.status, text, payload)
  }
  return (payload?.data ?? null) as T
}

// ---------------------------------------------------------------------------
// 能力探测：本批端点是否已在后端上线（读 /openapi.json，不试调）
// ---------------------------------------------------------------------------

let availabilityCache: boolean | null = null

/** 一次探测里要看的路径后缀（缺任何一个都说明后端还没升级到本批契约）。 */
const REQUIRED_PATH_SUFFIXES: readonly string[] = [
  '/drama-plan/generate',
  '/drama-plan/consistency',
  '/product-card',
  '/product-card/extract',
]

export async function fetchDramaPlanAvailability(): Promise<boolean> {
  if (availabilityCache !== null) return availabilityCache
  try {
    const resp = await fetch(`${OpenAPI.BASE}/openapi.json`, { method: 'GET' })
    if (!resp.ok) {
      availabilityCache = false
      return false
    }
    const spec = (await resp.json()) as { paths?: Record<string, unknown> }
    const paths = Object.keys(spec.paths ?? {})
    availabilityCache = REQUIRED_PATH_SUFFIXES.every((suffix) => paths.some((key) => key.endsWith(suffix)))
  } catch {
    availabilityCache = false
  }
  return availabilityCache
}

/** 仅供测试/热更新后强制重新探测。 */
export function resetDramaPlanAvailability(): void {
  availabilityCache = null
}

// ---------------------------------------------------------------------------
// 端点
// ---------------------------------------------------------------------------

/** 项目里取一个可用空章节（没有就建一个，标题取商品名）。 */
export function resolveWorkingChapter(projectId: string, productName: string): Promise<WorkingChapter> {
  return callApi<WorkingChapter>(`${API}/projects/${encodeURIComponent(projectId)}/drama-plan/chapter`, {
    product_name: productName,
  })
}

/** 读草稿（只读，永不付费）。 */
export function getDramaPlan(chapterId: string): Promise<DramaPlanRead> {
  return callApi<DramaPlanRead>(`${API}/chapters/${encodeURIComponent(chapterId)}/drama-plan`)
}

/** 保存 brief（免费，绝不触发模型调用）。 */
export function saveDramaBrief(chapterId: string, brief: DramaBrief): Promise<DramaPlanRead> {
  return callApiPut<DramaPlanRead>(
    `${API}/chapters/${encodeURIComponent(chapterId)}/drama-plan/brief`,
    brief as unknown as Record<string, unknown>,
  )
}

/**
 * 草稿 → 请求体（**白名单**）。
 *
 * 为什么必须白名单：后端 `DramaPlanDraft` 是 `extra="forbid"`，多带一个它不认的键
 * 就是一个 422（页面会看到"草稿结构不合法"这种和用户改动无关的报错）。
 * 页面上有些东西只是**演示用**的中间状态（例如按钮预览用的道具清单），
 * 它们不该被发出去。这里按 DTO 逐字段搬运，DTO 之外一个都不带。
 */
export function toDramaPlanDraftPayload(plan: DramaPlan): Record<string, unknown> {
  const namedAsset = (item: DramaPlanNamedAsset) => ({
    name: String(item?.name ?? ''),
    relation: String(item?.relation ?? ''),
    profile: (item?.profile ?? {}) as Record<string, string>,
    shot_indexes: Array.isArray(item?.shot_indexes) ? item.shot_indexes : [],
  })
  const story = (plan.story ?? {}) as Partial<DramaStory>
  return {
    title: String(plan.title ?? ''),
    logline: String(plan.logline ?? ''),
    one_liner: String(plan.one_liner ?? ''),
    audience_emotion: String(plan.audience_emotion ?? ''),
    story: {
      full_text: String(story.full_text ?? ''),
      hook: String(story.hook ?? ''),
      conflict: String(story.conflict ?? ''),
      product_usage: String(story.product_usage ?? ''),
      climax: String(story.climax ?? ''),
      cta: String(story.cta ?? ''),
    },
    selling_points: Array.isArray(plan.selling_points) ? plan.selling_points : [],
    characters: (plan.characters ?? []).map(namedAsset),
    scenes: (plan.scenes ?? []).map(namedAsset),
    product: plan.product
      ? { ...namedAsset(plan.product), description: String(plan.product.description ?? '') }
      : null,
    shots: (plan.shots ?? []).map((shot) => ({
      index: Number(shot.index ?? 0),
      title: String(shot.title ?? ''),
      characters: Array.isArray(shot.characters) ? shot.characters : [],
      script_excerpt: String(shot.script_excerpt ?? ''),
      description: String(shot.description ?? ''),
      duration: Number(shot.duration ?? 0),
      camera_shot: String(shot.camera_shot ?? ''),
      angle: String(shot.angle ?? ''),
      movement: String(shot.movement ?? ''),
      action_beats: Array.isArray(shot.action_beats) ? shot.action_beats : [],
      dialogue: (shot.dialogue ?? []).map((line) => ({
        speaker: String(line.speaker ?? ''),
        text: String(line.text ?? ''),
        mode: String(line.mode || 'DIALOGUE'),
      })),
      product_present: Boolean(shot.product_present),
    })),
    climax: String(plan.climax ?? ''),
    warnings: Array.isArray(plan.warnings) ? plan.warnings : [],
  }
}

/** 保存手改后的草稿（免费，只写草稿列）。 */
export function saveDramaDraft(chapterId: string, plan: DramaPlan): Promise<DramaPlanRead> {
  return callApiPut<DramaPlanRead>(
    `${API}/chapters/${encodeURIComponent(chapterId)}/drama-plan/draft`,
    toDramaPlanDraftPayload(plan),
  )
}

/** 生成剧情方案（**会调用 1 次模型**；演练模式下返回占位且不落草稿）。
 *
 * `stage` 决定这一次生成哪一层（契约 §二）：`one_liner` → 一句话 + 受众情绪；
 * `story` → 基于**已确认的一句话**出完整剧情；`storyboard` → 基于当前完整剧情出分镜；
 * `all` → 一次出全部（兼容旧行为）。
 * `confirmOverwrite`：人工编辑时间晚于上次生成时间时必须为 `true`，否则后端 409。
 */
export function generateDramaPlan(
  chapterId: string,
  stage: DramaGenerateStage = 'all',
  confirmOverwrite = false,
): Promise<DramaPlanRead> {
  return callApi<DramaPlanRead>(`${API}/chapters/${encodeURIComponent(chapterId)}/drama-plan/generate`, {
    stage,
    confirm_overwrite: confirmOverwrite,
  })
}

/** 一致性检查（免费）：商品是否覆盖足够镜头、人物/冲突/结局是否与分镜对应等。 */
export function runDramaPlanConsistency(chapterId: string): Promise<DramaPlanConsistencyRead> {
  return callApi<DramaPlanConsistencyRead>(
    `${API}/chapters/${encodeURIComponent(chapterId)}/drama-plan/consistency`,
    {},
  )
}

/** 确认落成正式内容（一个事务、幂等；免费）。 */
export function confirmDramaPlan(chapterId: string): Promise<DramaPlanConfirm> {
  return callApi<DramaPlanConfirm>(`${API}/chapters/${encodeURIComponent(chapterId)}/drama-plan/confirm`, {})
}

/* ------------------------------------------------------------ 商品卡 */

/** 读商品卡（免费；后端没有卡时返回一张空卡，不会是 null）。 */
export function getProductCard(projectId: string): Promise<ProductCardRead> {
  return callApi<ProductCardRead>(`${API}/projects/${encodeURIComponent(projectId)}/product-card`)
}

/**
 * 保存商品卡（免费）。
 *
 * `confirmed=true` 时后端校验必填项（名称为空 → 409 `product_card_required_missing`，
 * 结构化明细在 `error.detail` 里）；其余缺项保留为「待补充」，不会被编造。
 */
export function saveProductCard(
  projectId: string,
  fields: ProductCardFields,
  confirmed: boolean,
): Promise<ProductCardRead> {
  return callApiPut<ProductCardRead>(`${API}/projects/${encodeURIComponent(projectId)}/product-card`, {
    ...(fields as unknown as Record<string, unknown>),
    confirmed,
  })
}

/**
 * 从资料提取商品信息（**付费：1 次模型调用**；`existing` 与无文字资料时不调用，见 `note`）。
 *
 * 返回的字段**不落库**：页面负责回填表单，由用户点「确认商品卡」后走 PUT 保存。
 */
export function extractProductCard(
  projectId: string,
  body: ProductCardExtractRequest,
): Promise<ProductCardExtractRead> {
  return callApi<ProductCardExtractRead>(`${API}/projects/${encodeURIComponent(projectId)}/product-card/extract`, {
    ...(body as unknown as Record<string, unknown>),
  })
}

/* ------------------------------------------- 参考资料：解析文本 / 归档图片 */

/**
 * 解析资料文档（TXT / MD / DOCX，≤5MiB）为纯文本（免费，不写库、不上传对象存储）。
 *
 * **图片不走这里**（解析不出来）——图片走 :func:`uploadReferenceFile` 归档。
 */
export function parseReferenceDocument(file: File): Promise<DocumentParseRead> {
  const form = new FormData()
  form.append('file', file)
  return callApiUpload<DocumentParseRead>(
    `${API}/documents/parse`,
    form,
    '资料解析失败，请确认文件是 TXT / MD / DOCX 后重试',
  )
}

/**
 * 归档一张商品参考图或一份商品资料文件（免费；演练模式下写对象存储可能被拦截，页面照实提示）。
 *
 * `usage_kind` 默认 `upload` —— 那是后端 `FileUsageKind` 里"用户在项目里上传的文件"这一项。
 * **不要自造新的用途字符串**：那一列是枚举类型，写了成员外的值会在落库时报错。
 */
export function uploadReferenceFile(
  file: File,
  options: { projectId?: string; usageKind?: string } = {},
): Promise<UploadedFileRead> {
  const form = new FormData()
  form.append('file', file)
  if (options.projectId) {
    form.append('project_id', options.projectId)
    form.append('usage_kind', options.usageKind ?? 'upload')
  }
  return callApiUpload<UploadedFileRead>(`${API}/files/upload`, form, '图片上传失败，请稍后重试')
}

/** 选已有商品资料（免费，只读列表）。 */
export async function listProductEntities(pageSize = 100): Promise<ProductEntityOption[]> {
  const data = await callApi<{ items?: Array<Record<string, unknown>> }>(
    `${API}/entities/product?page=1&page_size=${encodeURIComponent(String(pageSize))}`,
  )
  return (data?.items ?? []).map((item) => ({
    id: String(item.id ?? ''),
    name: String(item.name ?? ''),
    description: String(item.description ?? ''),
  }))
}

export type { AnyRecord, GenerationRequestError }
