/**
 * 第 2 步「资产准备」工作台的**纯逻辑**（无 React、无请求，可直接 `node --test`）。
 *
 * 这里放的正是参考项目（`人物及场景生产项目`）里那套**已验证的状态机**：
 *   - 页签过滤（原 `public/index.html:549-552` 的类型页签 + 计数，
 *     页签同时决定下方结果卡显示哪一类）；
 *   - 勾选动作（原 `public/index.html:502-509`：全选 / 清空 / 只选未生成项）；
 *   - 主按钮文案与禁用（原 `public/app.js:850-933` `renderGenerationCommand()`：
 *     由「已选 / 未生成 / 需重新生成 / 生成中」推导，明细行一行汇总）。
 *
 * 与参考项目的**适配点**（不是照抄）：
 *   1. 参考项目按"风格是否过期"推导 stale；Jellyfish 换成后端契约给的
 *      `prompt.quality.needs_regeneration`（旧提示词需要重新生成）；
 *   2. 参考项目只有人物 / 场景 / 道具三个页签，Jellyfish 是人物 / 场景 / 道具 / 服装四类，
 *      但服装**不在出图服务契约内**（`assetProduction.SUBMITTABLE_ASSET_TYPES`），
 *      所以服装可以勾选、可以看资料，但不进批量生成；
 *   3. 参考项目把 `provider / 任务号 / 原始状态` 打在卡片副标题上（`labelFor`），
 *      Jellyfish 的用户口径相反：主界面只有用户语言，
 *      内部字段（模型 / 供应商 / 任务号 / file_id / 槽位 / 候选条数 …）只进默认收起的「技术详情」。
 */

/** 工作台四类资产的顺序（与出图分页签口径一致）。 */
export type WorkbenchAssetType = 'character' | 'scene' | 'prop' | 'costume'

export const WORKBENCH_TABS: WorkbenchAssetType[] = ['character', 'scene', 'prop', 'costume']

export const WORKBENCH_TAB_LABEL: Record<WorkbenchAssetType, string> = {
  character: '人物',
  scene: '场景',
  prop: '道具',
  costume: '服装',
}

/** 出图服务只接受人物 / 场景 / 道具：服装可以勾选但不进批量生成。 */
export const WORKBENCH_SUBMITTABLE_TYPES: WorkbenchAssetType[] = ['character', 'scene', 'prop']

export function isWorkbenchSubmittable(type: WorkbenchAssetType): boolean {
  return WORKBENCH_SUBMITTABLE_TYPES.includes(type)
}

/* --------------------------------------------------------------- 资产状态口径 */

/** 契约 `status.key`（后端给出的业务状态口径）。 */
export type WorkbenchStatusKey =
  | 'needs_profile'
  | 'needs_prompt'
  | 'ready'
  | 'generating'
  | 'failed'
  | 'has_image'
  | 'primary'

/**
 * 主界面**唯一**的状态词表（用户点名的那七个词）。
 *
 * 后端 `status.label` 优先；这个表是后端没给 label 时的兜底，
 * 也用于顶部状态计数的标签与测试断言 —— 两处必须同源，否则会出现
 * 「卡片说待补资料、计数说 needs_profile」这种自相矛盾。
 */
export const WORKBENCH_STATUS_LABEL: Record<WorkbenchStatusKey, string> = {
  needs_profile: '待补资料',
  needs_prompt: '待生成提示词',
  ready: '可以生成',
  generating: '生成中',
  failed: '生成失败',
  has_image: '已有图片待选择',
  primary: '已定版',
}

export const WORKBENCH_STATUS_ORDER: WorkbenchStatusKey[] = [
  'needs_profile',
  'needs_prompt',
  'ready',
  'generating',
  'failed',
  'has_image',
  'primary',
]

export type WorkbenchStatusTone = 'default' | 'blue' | 'green' | 'red' | 'gold' | 'purple'

export const WORKBENCH_STATUS_TONE: Record<WorkbenchStatusKey, WorkbenchStatusTone> = {
  needs_profile: 'gold',
  needs_prompt: 'blue',
  ready: 'green',
  generating: 'blue',
  failed: 'red',
  has_image: 'purple',
  primary: 'green',
}

/* ------------------------------------------------------------------ 契约形状 */

/**
 * 工作台资产的最小结构（契约 `items[]` 的子集）。
 *
 * 刻意用"结构类型 + 全部可选"来读：后端字段没落地 / 少字段时页面降级为
 * 「待补资料」而不是崩掉，也不需要 `as any` 到处断言。
 */
export type WorkbenchStatusLike = {
  key?: string
  label?: string
  reason?: string
}

export type WorkbenchPromptQualityLike = {
  verdict?: string
  reasons?: string[]
  needs_regeneration?: boolean
}

export type WorkbenchImageLike = {
  has_image?: boolean
  has_primary?: boolean
  image_id?: number | null
  thumbnail?: string
  image_count?: number
}

export type WorkbenchItemLike = {
  asset_type?: string
  asset_id?: string
  name?: string
  status?: WorkbenchStatusLike | null
  prompt?: { quality?: WorkbenchPromptQualityLike | null; text?: string; saved?: boolean } | null
  image?: WorkbenchImageLike | null
  /** 后端显式给出的"能不能进批量"（需求 8：旧提示词的项为 false） */
  batch_eligible?: boolean
}

export function isWorkbenchAssetType(value: unknown): value is WorkbenchAssetType {
  return typeof value === 'string' && (WORKBENCH_TABS as string[]).includes(value)
}

/** 全页面唯一的资产键（同一项资产只出现一次，靠它保证）。 */
export function workbenchItemKey(item: WorkbenchItemLike): string {
  const type = isWorkbenchAssetType(item.asset_type) ? item.asset_type : 'character'
  return `${type}:${String(item.asset_id ?? '')}`
}

export function workbenchItemType(item: WorkbenchItemLike): WorkbenchAssetType {
  return isWorkbenchAssetType(item.asset_type) ? item.asset_type : 'character'
}

export function workbenchItemName(item: WorkbenchItemLike): string {
  return String(item.name ?? '').trim() || workbenchItemKey(item)
}

/** 该资产的提示词是否**需要重新生成**（需求 8：标出来、给单项入口、不进批量）。 */
export function needsPromptRegeneration(item: WorkbenchItemLike): boolean {
  const quality = item.prompt?.quality ?? null
  if (!quality) return false
  return quality.needs_regeneration === true || String(quality.verdict ?? '') === 'needs_regeneration'
}

/**
 * 该项是否**可以进批量选择**。
 *
 * 两个条件缺一不可：后端显式说可以（`batch_eligible`）+ 提示词不需要重新生成。
 * 需求 8 写死了后者：旧提示词要先重新生成提示词，不能直接拿去出图。
 */
export function isBatchEligible(item: WorkbenchItemLike): boolean {
  if (needsPromptRegeneration(item)) return false
  return item.batch_eligible === true
}

export function hasImage(item: WorkbenchItemLike): boolean {
  return item.image?.has_image === true
}

export function hasPrimary(item: WorkbenchItemLike): boolean {
  return item.image?.has_primary === true
}

/** 业务状态键：后端给了就用后端的，没给就按图片 / 提示词自己推。 */
export function workbenchStatusKey(item: WorkbenchItemLike): WorkbenchStatusKey {
  const raw = String(item.status?.key ?? '')
  if ((WORKBENCH_STATUS_ORDER as string[]).includes(raw)) return raw as WorkbenchStatusKey
  if (needsPromptRegeneration(item)) return 'needs_prompt'
  if (hasPrimary(item)) return 'primary'
  if (hasImage(item)) return 'has_image'
  if (String(item.prompt?.text ?? '').trim()) return 'ready'
  return 'needs_profile'
}

/** 业务状态**中文标签**（用户语言；后端 `status.label` 优先）。 */
export function workbenchStatusLabel(item: WorkbenchItemLike): string {
  const fromServer = String(item.status?.label ?? '').trim()
  if (fromServer) return fromServer
  return WORKBENCH_STATUS_LABEL[workbenchStatusKey(item)]
}

export function workbenchStatusTone(item: WorkbenchItemLike): WorkbenchStatusTone {
  return WORKBENCH_STATUS_TONE[workbenchStatusKey(item)]
}

/* -------------------------------------------------------------------- 页签 */

/** 页签过滤：**页签同时决定结果区显示哪一类**（参考项目同口径）。 */
export function itemsForTab<T extends WorkbenchItemLike>(
  items: readonly T[],
  tab: WorkbenchAssetType,
): T[] {
  return items.filter((item) => workbenchItemType(item) === tab)
}

/* -------------------------------------------------------------------- 计数 */

export type WorkbenchTypeCounts = Record<WorkbenchAssetType, number>

export function emptyTypeCounts(): WorkbenchTypeCounts {
  return { character: 0, scene: 0, prop: 0, costume: 0 }
}

/** 四类资产各多少项（顶部第一行数量）。 */
export function countByType(items: readonly WorkbenchItemLike[]): WorkbenchTypeCounts {
  const counts = emptyTypeCounts()
  items.forEach((item) => {
    counts[workbenchItemType(item)] += 1
  })
  return counts
}

export type WorkbenchStatusCounts = Record<WorkbenchStatusKey, number>

export function emptyStatusCounts(): WorkbenchStatusCounts {
  return {
    needs_profile: 0,
    needs_prompt: 0,
    ready: 0,
    generating: 0,
    failed: 0,
    has_image: 0,
    primary: 0,
  }
}

/** 七个业务状态各多少项（顶部第二行数量）。 */
export function countByStatus(items: readonly WorkbenchItemLike[]): WorkbenchStatusCounts {
  const counts = emptyStatusCounts()
  items.forEach((item) => {
    counts[workbenchStatusKey(item)] += 1
  })
  return counts
}

/** 待处理（`pending_review`）的一句话：入口按钮的文案来源。 */
export function describePendingReview(count: number): string {
  return count > 0 ? `待处理 ${count} 项` : '没有待处理项'
}

/* -------------------------------------------------------------------- 选择 */

export type WorkbenchSelectionAction = 'all' | 'clear' | 'ungenerated'

/** 未生成项 = 可以进批量、且还没有图片的项（需求：只选未生成项按 status/ 可批量推）。 */
export function isUngeneratedItem(item: WorkbenchItemLike): boolean {
  return isBatchEligible(item) && !hasImage(item)
}

/**
 * 三个勾选动作（语义与参考项目 `public/index.html:502-509` 一致）。
 *
 * `scopeType` = 当前页签：全选 / 只选未生成 只作用在本页签，
 * 其它页签的已选项**保留**（切页签不清空用户的选择）。
 */
export function applyWorkbenchSelection(
  items: readonly WorkbenchItemLike[],
  current: readonly string[],
  action: WorkbenchSelectionAction,
  scopeType?: WorkbenchAssetType,
): string[] {
  const known = new Set(items.map(workbenchItemKey))
  const kept = current.filter((key) => known.has(key))
  if (action === 'clear') return []
  const scope = scopeType ? itemsForTab(items, scopeType) : items
  const scopeKeys = (
    action === 'all' ? scope.filter(isBatchEligible) : scope.filter(isUngeneratedItem)
  ).map(workbenchItemKey)
  const next = new Set(kept)
  scopeKeys.forEach((key) => next.add(key))
  return Array.from(next)
}

/* -------------------------------------------------------------- 主操作推导 */

export type WorkbenchAnalysisLike = {
  generated?: boolean
  status?: string
  status_label?: string
  hint?: string
  content_changed?: boolean
  records_total?: number
}

export type WorkbenchCommandCounts = {
  /** 已选总数 */
  selected: number
  /** 已选中「可以生成」的项（没有图片，会走批量生成） */
  generatable: number
  /** 已选中「已有图片」的项（走批量重新生成） */
  regeneratable: number
  /** 已选中、提示词需要重新生成的项（**不进批量**，只提示） */
  needsRegeneration: number
  /** 已选中、正在生成的项 */
  generating: number
  /** 已选中、出图服务不支持的项（服装） */
  unsupported: number
  /** 已选中、可进批量但没有提示词的项 */
  withoutPrompt: number
}

export type WorkbenchCommand = {
  /** 推荐操作的标题（一句话） */
  title: string
  /** 明细行：已选 / 待生成 / 需重新生成 / 生成中 */
  detail: string
  /** 主按钮文案 */
  primaryLabel: string
  primaryDisabled: boolean
  /** 主按钮禁用时**为什么**（用户语言；可用时为空串） */
  primaryDisabledReason: string
  /** 批量重新生成按钮文案 */
  regenerateLabel: string
  regenerateDisabled: boolean
  counts: WorkbenchCommandCounts
}

export type WorkbenchCommandInput = {
  items: readonly WorkbenchItemLike[]
  selectedKeys: readonly string[]
  /** 本轮是否正在提交 / 生成（来自既有的批量提交与结果状态） */
  busy?: boolean
  analysis?: WorkbenchAnalysisLike | null
}

function countSelected(
  items: readonly WorkbenchItemLike[],
  selectedKeys: readonly string[],
): WorkbenchCommandCounts {
  const selected = new Set(selectedKeys)
  const picked = items.filter((item) => selected.has(workbenchItemKey(item)))
  const counts: WorkbenchCommandCounts = {
    selected: picked.length,
    generatable: 0,
    regeneratable: 0,
    needsRegeneration: 0,
    generating: 0,
    unsupported: 0,
    withoutPrompt: 0,
  }
  picked.forEach((item) => {
    if (needsPromptRegeneration(item)) counts.needsRegeneration += 1
    if (!isWorkbenchSubmittable(workbenchItemType(item))) {
      counts.unsupported += 1
      return
    }
    if (workbenchStatusKey(item) === 'generating') {
      counts.generating += 1
      return
    }
    if (!isBatchEligible(item)) return
    if (hasImage(item)) counts.regeneratable += 1
    else counts.generatable += 1
    if (!String(item.prompt?.text ?? '').trim()) counts.withoutPrompt += 1
  })
  return counts
}

/**
 * 主按钮文案与禁用由「已选 / 待生成 / 需重新生成 / 生成中」推导
 * （参考项目 `public/app.js:850-933` `renderGenerationCommand()` 的同一条状态机）。
 *
 * 需求 7 的硬约束也在这里：`analysis.generated === false` 时，
 * **任何**生成类按钮都不得显示为可用态，标题只说「请先分析本章资产」。
 */
export function deriveWorkbenchCommand(input: WorkbenchCommandInput): WorkbenchCommand {
  const counts = countSelected(input.items, input.selectedKeys)
  const analysis = input.analysis ?? null
  const analyzed = analysis ? analysis.generated === true : true
  const busy = input.busy === true

  const detail = [
    `已选 ${counts.selected}`,
    `待生成 ${counts.generatable}`,
    `需重新生成 ${counts.needsRegeneration}`,
    `生成中 ${counts.generating}`,
  ].join(' · ')

  if (!analyzed) {
    const hint = String(analysis?.hint ?? '').trim() || '本章还没有资产资料：先点「分析本章资产」。'
    return {
      title: '请先分析本章资产',
      detail,
      primaryLabel: '批量生成选中项',
      primaryDisabled: true,
      primaryDisabledReason: hint,
      regenerateLabel: '批量重新生成已选项',
      regenerateDisabled: true,
      counts,
    }
  }

  const title = (() => {
    if (counts.selected === 0) return '选择本轮要生产的人物、场景或道具'
    if (counts.generatable > 0) return `本轮将处理 ${counts.generatable} 项资产`
    if (counts.generating > 0) return `${counts.generating} 项正在生成`
    if (counts.needsRegeneration > 0) return `${counts.needsRegeneration} 项提示词需要重新生成`
    if (counts.regeneratable > 0) return `所选资产都已有图片（${counts.regeneratable} 项可重新生成）`
    return '所选资产暂时没有可批量执行的项'
  })()

  /* 主按钮：待生成优先；否则说明为什么点不了（不撒谎、也不给假动作）。 */
  let primaryLabel = '批量生成选中项'
  let primaryDisabled = true
  let primaryDisabledReason = ''
  if (busy) {
    primaryLabel = '正在提交批量任务…'
    primaryDisabledReason = '本轮还在进行中；要中断后续请点「停止后续」。'
  } else if (counts.generatable > 0) {
    primaryLabel = `批量生成选中项（${counts.generatable}）`
    primaryDisabled = false
  } else if (counts.selected === 0) {
    primaryDisabledReason = '先勾选要生成的资产，或点「只选未生成项」。'
  } else if (counts.generating > 0) {
    primaryLabel = `批量生成中（${counts.generating}）`
    primaryDisabledReason = '选中的资产正在生成，等这一轮跑完再点。'
  } else if (counts.needsRegeneration > 0) {
    primaryDisabledReason = '选中的资产里有提示词需要先重新生成提示词，暂时不能直接生成图片。'
  } else if (counts.unsupported === counts.selected) {
    primaryDisabledReason = '服装暂不支持批量出图：可以先保存资料与提示词，再单独处理。'
  } else {
    primaryDisabledReason = '选中的资产都已有图片：需要再出一张请用「批量重新生成已选项」。'
  }

  const regenerateDisabled = busy || counts.regeneratable === 0
  return {
    title,
    detail,
    primaryLabel,
    primaryDisabled,
    primaryDisabledReason: primaryDisabled ? primaryDisabledReason : '',
    regenerateLabel:
      counts.regeneratable > 0 ? `批量重新生成已选项（${counts.regeneratable}）` : '批量重新生成已选项',
    regenerateDisabled,
    counts,
  }
}

/* ---------------------------------------------------------------- 分析入口 */

export type AnalysisAction = {
  /** 按钮文案：没分析过 = 「分析本章资产」，否则 = 「重新分析本章资产」 */
  label: string
  /** 是不是主按钮 */
  primary: boolean
  /** 旁注（用户语言，来自 analysis.hint） */
  hint: string
  /** 本章内容变了 / 资料过期时的提醒（空串 = 没有提醒） */
  staleNotice: string
}

/**
 * 顶部「分析本章资产 / 重新分析本章资产」的文案与是否主按钮。
 *
 * 参考项目 `#scriptCommandBar` 的口径：唯一主操作区里"推荐的那一个"才是主按钮；
 * 这里"还没分析"→分析是主按钮，"已分析"→分析降级为次要按钮（主按钮让位给批量生成）。
 */
export function deriveAnalysisAction(analysis?: WorkbenchAnalysisLike | null): AnalysisAction {
  const data = analysis ?? null
  const generated = data?.generated === true
  const hint = String(data?.hint ?? '').trim()
  const contentChanged = data?.content_changed === true
  const status = String(data?.status ?? '')
  const stale = generated && (contentChanged || status === 'stale')
  return {
    label: generated ? '重新分析本章资产' : '分析本章资产',
    primary: !generated,
    hint,
    staleNotice: stale
      ? '本章剧本已经改过：重新分析只会更新资料，你手动改过的内容不会被覆盖。'
      : '',
  }
}

/* ----------------------------------------------------- 主界面禁词（用户点名） */

/**
 * 用户点名的**主页面禁词**：这些只允许出现在默认收起的「技术详情」里。
 *
 * 测试用它检查两处：① 纯函数产出的**全部静态文案**（标题 / 按钮 / 状态 / 计数标签）；
 * ② 主界面组件源码。带内部字段名的那个组件（`TechnicalDetailCollapse.tsx`）是唯一豁免文件。
 */
export const MAIN_SCREEN_FORBIDDEN_TERMS: readonly string[] = [
  '候选',
  '聚合',
  '检查中',
  '槽位',
  '项目内资产',
  '全局资产',
  '提示词质量未知',
  '最终提示词',
  '生成依据',
  '接口名',
  '供应商',
  '任务号',
  'file_id',
  '内部状态',
  'asset_id',
  'service_task_id',
  'source_task_id',
  'oss_url',
  'provider',
]

/**
 * **源码级**扫描用的子集。
 *
 * 为什么比上面短：契约里就带 `asset_id` / `oss_url` 这类字段名，
 * 主界面组件读它们（例如给卡片做 key）是正常的代码，不是给用户看的文案；
 * 而下面这些词在任何形式的用户可见文案里都不该出现，
 * 所以它们连注释与代码字符串都一并禁掉。
 */
export const MAIN_SCREEN_FORBIDDEN_SOURCE_TERMS: readonly string[] = [
  '候选',
  '聚合',
  '检查中',
  '槽位',
  '项目内资产',
  '全局资产',
  '提示词质量未知',
  '最终提示词',
  '生成依据',
  '供应商',
  '任务号',
  'file_id',
]

/** 返回 `text` 命中的禁词（空数组 = 干净）。 */
export function findMainScreenForbiddenTerms(
  text: string,
  terms: readonly string[] = MAIN_SCREEN_FORBIDDEN_TERMS,
): string[] {
  const haystack = String(text ?? '')
  return terms.filter((term) => haystack.includes(term))
}

/* ------------------------------------------------------------ 待处理（复核） */

export type PendingReviewKind =
  | 'alias_conflict'
  | 'same_name_other_type'
  | 'multiple_candidates'
  | 'costume_without_asset'

export const PENDING_REVIEW_KIND_LABEL: Record<PendingReviewKind, string> = {
  alias_conflict: '名称对不上',
  same_name_other_type: '同名不同类型',
  multiple_candidates: '同一项有多个来源',
  costume_without_asset: '服装还没有对应资产',
}

/** 后端给了没登记的 kind 时也不显示英文枚举（退回"需要你确认"）。 */
export function describePendingReviewKind(kind: string): string {
  const key = String(kind ?? '') as PendingReviewKind
  return PENDING_REVIEW_KIND_LABEL[key] ?? '需要你确认'
}

/* -------------------------------------------------- 资产资料字段中文标签 */

/** 详情抽屉里按类型展示资料字段的中文标签（后端字段名不出现在主界面）。 */
export const PROFILE_FIELD_LABEL: Record<string, string> = {
  identity: '身份',
  relation: '人物关系',
  appearance: '外貌',
  hairstyle: '发型',
  personality: '性格',
  costume_style: '服装配饰',
  gender_age: '性别年龄',
  space: '空间',
  furnishing: '陈设',
  time_weather: '时间天气',
  lighting: '光线',
  mood: '氛围',
  material: '材质',
  shape: '形状',
  size: '尺寸',
  state: '状态',
  owner: '所属',
  plot_role: '剧情作用',
  wearer: '穿着人物',
  era: '身份时代',
  style: '款式',
  color: '颜色',
  accessory: '配饰',
  occasion: '场合',
}

export function profileFieldLabel(key: string): string {
  return PROFILE_FIELD_LABEL[String(key ?? '')] ?? String(key ?? '')
}
