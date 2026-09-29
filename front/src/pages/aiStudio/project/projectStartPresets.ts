/**
 * 新建项目的「起点」与「整体风格」预设（纯逻辑，可单测）。
 *
 * 产品口径（第二部分）：
 * - 先选生产方式：**从剧本开始**（默认）、**从视频提示词开始**，或**剧情广告**
 *   （`kind=ad`：先做商品卡与分层剧情策划，确认策划后再汇入同一条五步流程）；
 * - 再选**项目整体风格**：真人竖屏 / 真人横屏 / 2D / 3D / 其他自定义。
 *
 * 为什么不做成新字段：数据库里已经有承载这三件事的列 ——
 * `visual_style`（现实/动漫）、`style`（题材风格，可自定义）、`default_video_ratio`（画幅）。
 * 预设只是把「整体风格」这一个用户概念**映射**到既有列上，因此后续提示词与出图
 * 复用它们时无需任何迁移：
 *   - 提示词：`build_base` / `shot_video_prompt_pack` 一直读实体与项目的 style / visual_style；
 *   - 画幅：`frame_submit.resolve_target_ratio` 的优先级是 请求 > 镜头 override > **项目默认** > 16:9。
 *
 * 剧情广告那一路**确实**新增了列（`projects.kind` 与创建请求里的 `ad_product_source` /
 * `ad_requirements`），因为它是"这是什么项目"与"资料来源/制作要求"，
 * 既有列里没有任何一列能承载（见 `site/content/docs/plans/drama-ad-full-loop.md` 一.1）。
 */

export type ProjectStartModeChoice = 'script' | 'prompts' | 'drama_ad'

/**
 * 后端 `projects.start_mode` 的取值域（`app/models/types.py` 的 `ProjectStartMode`）。
 *
 * ⚠️ 它**只有两个值**，和上面那份 UI 起点**不是同一个东西**：
 *   - `start_mode` 表达「从哪开始生产」：`script`（从剧本开始）/ `prompts`（从视频提示词开始）；
 *   - 「这是剧情广告项目」由**新列 `kind`** 表达（`kind: 'ad'` + `ad_product_source` /
 *     `ad_requirements`），见契约 §二「项目」。
 */
export type BackendStartMode = 'script' | 'prompts'

/**
 * UI 起点 → 后端 `start_mode`（**唯一的换算处**）。
 *
 * `drama_ad` 在 `start_mode` 上就是 `script`：剧情广告同样"先从剧本/策划开始"，
 * 它与其他项目的差别由 `kind=ad` 表达；创建后的落点另由 :func:`resolveStartLandingPath`
 * 决定（剧情广告 → 剧情策划页）。
 *
 * 为什么必须走这个函数、而不是就地写 `'script'`：
 * 真实事故（浏览器验收第 1 步直接 422）——页面把 UI 起点**原样**当成 `start_mode` 发出去，
 * 又用 `as any` 把类型错误吞掉了，于是 `tsc --noEmit` 全绿、运行时才被后端拒绝
 * （`start_mode: Input should be 'script' or 'prompts'`）。
 * 有了它，类型系统能真的拦住这件事：把 `ProjectStartModeChoice` 直接赋给
 * `start_mode` 会立刻编译失败（'drama_ad' 不在 `BackendStartMode` 里）。
 *
 * 未登记的值一律落到 `script`（= 与后端默认值一致的安全兜底，不猜成 prompts）。
 */
export function toBackendStartMode(
  choice: ProjectStartModeChoice | string | null | undefined,
): BackendStartMode {
  return choice === 'prompts' ? 'prompts' : 'script'
}

export type OverallStyleKey = 'live_portrait' | 'live_landscape' | 'anime_2d' | 'anime_3d' | 'custom'

export type OverallStylePreset = {
  key: OverallStyleKey
  label: string
  description: string
  /** 后端 `projects.visual_style` 取值（现实 / 动漫） */
  visualStyle: '现实' | '动漫' | null
  /** 后端 `projects.style` 取值（预设值；自定义时为 null，由用户自由填写） */
  style: string | null
  /** 后端 `projects.default_video_ratio` 取值 */
  defaultVideoRatio: string | null
}

export const OVERALL_STYLE_PRESETS: OverallStylePreset[] = [
  {
    key: 'live_portrait',
    label: '真人竖屏',
    description: '真人实拍质感，9:16 竖屏（短剧默认）',
    visualStyle: '现实',
    style: '真人都市',
    defaultVideoRatio: '9:16',
  },
  {
    key: 'live_landscape',
    label: '真人横屏',
    description: '真人实拍质感，16:9 横屏',
    visualStyle: '现实',
    style: '真人都市',
    defaultVideoRatio: '16:9',
  },
  {
    key: 'anime_2d',
    label: '2D',
    description: '2D 动画/国漫质感，16:9 横屏',
    visualStyle: '动漫',
    style: '国漫',
    defaultVideoRatio: '16:9',
  },
  {
    key: 'anime_3d',
    label: '3D',
    description: '3D 动画质感，16:9 横屏',
    visualStyle: '动漫',
    style: '动漫3D',
    defaultVideoRatio: '16:9',
  },
  {
    key: 'custom',
    label: '其他自定义',
    description: '自己选视觉风格、视频风格与画面比例',
    visualStyle: null,
    style: null,
    defaultVideoRatio: null,
  },
]

export const START_MODE_OPTIONS: { key: ProjectStartModeChoice; label: string; description: string }[] = [
  {
    key: 'script',
    label: '从剧本开始',
    description: '导入或填写剧本 → 拆分/手工编辑分镜 → 资产准备 → 整集提示词 → 绑定 → 生成或导出',
  },
  {
    key: 'prompts',
    label: '从视频提示词开始',
    description:
      '创建后自动建默认章节，直接进整集提示词看板：批量导入/生成 → 预览确认 → 创建对应镜头 → 继续资产准备或直接绑定',
  },
  /* 第三种是**项目类型**（不是另一种"从哪开始生产"）：`kind=ad` 会先走商品卡与剧情策划，
     确认策划后才汇入同一条五步流程。它与前两种的差别在于"先有商品事实、再有剧情"。 */
  {
    key: 'drama_ad',
    label: '剧情广告',
    description:
      '先填商品资料与剧情策划（一句话核心创意 → 完整剧情 → 分镜），确认策划后进入资产准备；商品会作为正式资产落库',
  },
]

/**
 * **「短剧项目」页**可选的起点（只有两种）。
 *
 * 为什么必须把它单独列出来、而不是靠页面自己 `filter`：「短剧项目」与「广告视频」现在是
 * 两个并列的一级入口（左侧 5 个入口之一），业务上互斥 ——
 *   - 短剧项目页只能建 `kind=drama`，**不许**出现「剧情广告」这个选项，
 *     否则用户在「短剧项目」里建出一条广告项目，建完还会从当前列表消失（它归广告视频页）；
 *   - 广告项目的新建固定在「广告视频」入口（`AdProjectCreateModal`，硬编 `kind=ad`）。
 *
 * 三种起点的**真实业务能力一个都没删**：`START_MODE_OPTIONS` 仍是全集，
 * 广告起点只是换了入口（原来挤在短剧新建弹窗的第三项里）。
 */
export const DRAMA_START_MODE_OPTIONS = START_MODE_OPTIONS.filter(
  (option) => option.key !== 'drama_ad',
)

/* ==========================================================================
 * 剧情广告（kind=ad）新建向导：商品资料来源 + 基本制作要求
 * ========================================================================== */

/** 向导里的「商品资料来源」四选一；`none` = 暂无资料（先建项目，商品卡到策划页再补）。 */
export type AdProductSourceChoice = 'paste' | 'upload' | 'existing' | 'none'

export type AdProductSourceOption = {
  key: AdProductSourceChoice
  label: string
  /** 后端 `ad_product_source.type` 取值（`none` 落成 `manual`：既没有文字也没有文件） */
  payloadType: 'manual' | 'paste' | 'upload' | 'existing'
  hint: string
}

/**
 * 后端 `AdProductSource.type` 只有四个取值（`manual` / `paste` / `upload` / `existing`），
 * 而用户看到的是四种**资料来源**。两者不是一一对应：向导里的「暂无商品资料」
 * 落成 `manual`（= 没给任何来源，商品卡保持空、缺项全标「待补充」），
 * 与"手工填写"在数据上是同一件事。这张表是**唯一**的换算处。
 */
export const AD_PRODUCT_SOURCE_OPTIONS: AdProductSourceOption[] = [
  {
    key: 'paste',
    label: '粘贴商品文案',
    payloadType: 'paste',
    hint: '把商品详情/卖点文案贴进来，创建后可在策划页一键提取',
  },
  {
    key: 'upload',
    label: '上传资料文件',
    payloadType: 'upload',
    hint: '先上传 TXT / DOCX / 图片资料（创建后到策划页解析成文本再提取）',
  },
  {
    key: 'existing',
    label: '选已有商品',
    payloadType: 'existing',
    hint: '复用库里已有的商品资产作为资料来源',
  },
  {
    key: 'none',
    label: '暂无商品资料',
    payloadType: 'manual',
    hint: '先建项目，商品卡留到策划页手工填写（缺项会标「待补充」）',
  },
]

export type AdProductSourceInput = {
  choice: AdProductSourceChoice
  /** `paste` 时的商品文案 */
  text?: string
  /** `upload` 时已上传资料的文件 ID（向导里由上传动作产生） */
  fileIds?: readonly string[]
  /** `existing` 时选中的商品资产 ID */
  productId?: string
}

/** 向导的「商品资料来源」→ 创建请求里的 `ad_product_source`。 */
export function buildAdProductSource(input: AdProductSourceInput): {
  type: 'manual' | 'paste' | 'upload' | 'existing'
  text: string
  file_ids: string[]
  product_id: string
} {
  const option = AD_PRODUCT_SOURCE_OPTIONS.find((item) => item.key === input.choice)
    ?? AD_PRODUCT_SOURCE_OPTIONS[AD_PRODUCT_SOURCE_OPTIONS.length - 1]
  const text = option.payloadType === 'paste' ? String(input.text ?? '') : ''
  const fileIds = option.payloadType === 'upload' ? [...(input.fileIds ?? [])].map((id) => String(id)).filter(Boolean) : []
  const productId = option.payloadType === 'existing' ? String(input.productId ?? '') : ''
  return { type: option.payloadType, text, file_ids: fileIds, product_id: productId }
}

export type AdRequirementsInput = {
  genre?: string
  tone?: string
  shotCount?: number | null
  durationSeconds?: number | null
  directorNotes?: string
  mandatoryElements?: readonly string[]
  forbiddenElements?: readonly string[]
}

/** 镜头数与时长都按后端 DTO 的合法区间收口（`shot_count` 1–16、`duration_seconds` ≥ 0）。 */
export const AD_SHOT_COUNT_MIN = 1
export const AD_SHOT_COUNT_MAX = 16
export const AD_DEFAULT_SHOT_COUNT = 6

function clampInt(value: number | null | undefined, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(max, Math.max(min, num))
}

/** 向导的「基本制作要求」→ 创建请求里的 `ad_requirements`。 */
export function buildAdRequirements(input: AdRequirementsInput): {
  genre: string
  tone: string
  shot_count: number
  duration_seconds: number
  director_notes: string
  mandatory_elements: string[]
  forbidden_elements: string[]
} {
  return {
    genre: String(input.genre ?? '').trim(),
    tone: String(input.tone ?? '').trim(),
    shot_count: clampInt(input.shotCount, AD_SHOT_COUNT_MIN, AD_SHOT_COUNT_MAX, AD_DEFAULT_SHOT_COUNT),
    duration_seconds: clampInt(input.durationSeconds, 0, 600, 0),
    director_notes: String(input.directorNotes ?? ''),
    mandatory_elements: [...(input.mandatoryElements ?? [])].map((item) => String(item)).filter(Boolean),
    forbidden_elements: [...(input.forbiddenElements ?? [])].map((item) => String(item)).filter(Boolean),
  }
}

/**
 * 向导提交时**只对剧情广告**补齐的那三个字段（`kind` + `ad_*`）。
 *
 * 非剧情广告返回 `null`：普通短剧项目的请求体一个字段都不变（避免把 `ad_*` 塞给后端，
 * 后端那两个字段是 `extra="forbid"` 的强类型 DTO，塞了就是 422）。
 */
export function buildAdProjectCreateFields(input: {
  startMode: ProjectStartModeChoice
  productSource?: AdProductSourceInput
  requirements?: AdRequirementsInput
}): {
  kind: 'ad'
  ad_product_source: ReturnType<typeof buildAdProductSource>
  ad_requirements: ReturnType<typeof buildAdRequirements>
} | null {
  if (input.startMode !== 'drama_ad') return null
  return {
    kind: 'ad',
    ad_product_source: buildAdProductSource(input.productSource ?? { choice: 'none' }),
    ad_requirements: buildAdRequirements(input.requirements ?? {}),
  }
}

export function getOverallStylePreset(key: OverallStyleKey): OverallStylePreset {
  return OVERALL_STYLE_PRESETS.find((preset) => preset.key === key) ?? OVERALL_STYLE_PRESETS[0]
}

/**
 * 把「整体风格」预设换算成要写进项目的三个字段。
 *
 * 自定义时返回 `null`，调用方改用用户自己填写的视觉风格/视频风格/比例。
 */
export function resolveOverallStyleFields(
  key: OverallStyleKey,
): { visual_style: '现实' | '动漫'; style: string; default_video_ratio: string } | null {
  const preset = getOverallStylePreset(key)
  if (preset.key === 'custom' || !preset.visualStyle || !preset.style || !preset.defaultVideoRatio) return null
  return {
    visual_style: preset.visualStyle,
    style: preset.style,
    default_video_ratio: preset.defaultVideoRatio,
  }
}

/**
 * 新建项目时**最终写入** `projects.default_video_ratio` 的取值（方案 B，2026-09-23 用户拍板）。
 *
 * 口径：
 * - 选中非「其他自定义」的风格时，选择器会把预设画幅**自动填进输入框**（见 ProjectLobby 的 onChange），
 *   让用户看到「存进去的就是这个」；
 * - **用户手填的值优先**（可以在预设基础上改成别的比例，比如真人竖屏改成 16:9）；
 * - 输入框被清空时回落到该风格的预设默认值，而不是留空；
 * - 「其他自定义」没有预设默认值，完全以用户填写为准（可以留空 = 由模型/供应商决定）。
 */
export function resolveProjectVideoRatio(
  overallStyle: OverallStyleKey | undefined,
  typedRatio: string | null | undefined,
): string | null {
  const typed = String(typedRatio ?? '').trim()
  if (typed) return typed
  const presetRatio = overallStyle ? resolveOverallStyleFields(overallStyle)?.default_video_ratio : undefined
  return presetRatio ?? null
}

/**
 * 新建成功后应该落到哪一步（工作台的 `?step=`）。
 *
 * 剧情广告**不用这个函数**：它不进工作台，而是直接进剧情策划页
 * （用 :func:`resolveStartLandingPath`）。这里对 `drama_ad` 返回 `script` 只是
 * 「万一有人只调这一个函数」时的安全兜底 —— 不会把广告项目丢进错误的步骤。
 */
export function resolveLandingStep(startMode: ProjectStartModeChoice): 'script' | 'video_prompt' {
  return startMode === 'prompts' ? 'video_prompt' : 'script'
}

/** 剧情策划页路径（`chapterId` 可选：项目刚创建时会带上默认章节）。 */
export function dramaPlanPath(projectId: string, chapterId?: string | null): string {
  const params = new URLSearchParams()
  params.set('projectId', projectId)
  if (chapterId) params.set('chapterId', chapterId)
  return `/drama-plan?${params.toString()}`
}

/**
 * 新建项目后的落点（唯一的换算处）：
 * - 剧情广告 → 直接进剧情策划页（带 `projectId` + 响应里的 `chapter_id`）；
 * - 其余起点 → 既有工作台步骤。
 *
 * 为什么必须带 `chapter_id`：策划页是**章节级**的，创建接口已经建好了默认章节；
 * 不带上就会退化成"再点一次项目、再建一集"，多一集空章节。
 */
export function resolveStartLandingPath(
  startMode: ProjectStartModeChoice,
  projectId: string,
  chapterId?: string | null,
): string {
  if (startMode === 'drama_ad') return dramaPlanPath(projectId, chapterId)
  return `/projects/${encodeURIComponent(projectId)}?step=${resolveLandingStep(startMode)}`
}

/**
 * 确认策划之后的第 2 步入口（资产准备），带上是哪一集。
 *
 * 与后端 `confirm` 的 `next_step.url` 同口径，多带 `chapter`：
 * 第 2 步页面需要知道"准备哪一集的资产"，而这个信息只有策划页手里最准。
 */
export function resolveAssetPreparationPath(projectId: string, chapterId: string): string {
  return `/projects/${encodeURIComponent(projectId)}?step=extract_assets&chapter=${encodeURIComponent(chapterId)}`
}
