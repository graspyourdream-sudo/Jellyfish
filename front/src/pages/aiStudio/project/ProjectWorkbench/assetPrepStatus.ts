/**
 * 「资产准备」的业务状态（纯逻辑，可单测）。
 *
 * 口径要求：**不新增状态数据库列**，直接根据现有数据算出来：
 *   - 提取候选是否还有待确认项（`shot_extracted_candidates.status`）
 *   - 是否已进项目（项目关联/角色行本身）
 *   - 图片提示词是否已保存（`<entity>.image_prompts`）
 *   - 是否已有图片文件（`*_images`）
 *   - 是否已设为定版（`*_images.is_primary`）
 *
 * 五个状态按顺序推进，每个状态对应**唯一明确的下一步**。
 */

export type AssetPrepStatusKey =
  | 'pending_candidate'
  | 'linked_prompt_todo'
  | 'prompt_ready_image_todo'
  | 'image_ready_primary_todo'
  | 'done'

export type AssetPrepStatusMeta = {
  key: AssetPrepStatusKey
  label: string
  /** 唯一的下一步动作（按钮文案） */
  nextActionLabel: string
  tone: 'default' | 'gold' | 'blue' | 'green'
}

export const ASSET_PREP_STATUSES: Record<AssetPrepStatusKey, AssetPrepStatusMeta> = {
  pending_candidate: {
    key: 'pending_candidate',
    label: '待确认',
    nextActionLabel: '确认写入',
    tone: 'gold',
  },
  linked_prompt_todo: {
    key: 'linked_prompt_todo',
    label: '已关联，待完善图片提示词',
    nextActionLabel: '填提示词',
    tone: 'gold',
  },
  prompt_ready_image_todo: {
    key: 'prompt_ready_image_todo',
    label: '提示词已就绪，待出图或上传',
    nextActionLabel: '生成图片',
    tone: 'blue',
  },
  image_ready_primary_todo: {
    key: 'image_ready_primary_todo',
    label: '已有图片，待设为定版',
    nextActionLabel: '去设为定版',
    tone: 'blue',
  },
  done: {
    key: 'done',
    label: '已定版',
    nextActionLabel: '查看定版图',
    tone: 'green',
  },
}

export type AssetPrepInput = {
  /** 该资产还有待确认的提取候选 */
  hasPendingCandidate?: boolean
  /** 是否已进项目（角色行天然属于项目；场景/道具/服装看关联或是否已在项目资产里） */
  linked?: boolean
  /** 是否已保存图片提示词；null = 当前载荷无法判定 */
  hasImagePrompt?: boolean | null
  /** 是否已有图片文件 */
  hasImage?: boolean
  /** 是否已设为定版（`is_primary`）；null/undefined = 无法判定 */
  hasPrimary?: boolean | null
}

/** 统一数据源（`asset-readiness`）里的一行——四类资产字段完全一致。 */
export type AssetReadinessFlags = {
  /** 本项目内还有同类型同名的未确认提取候选 */
  has_pending_candidate: boolean
  /** 已保存图片提示词 */
  has_image_prompt: boolean
  /** 已有图片（图片表里有 `file_id` 非空的行） */
  has_image: boolean
  /** 已设为定版 */
  has_primary: boolean
}

/**
 * 统一数据源 → 业务状态入参。
 *
 * **表格的每一行、顶部统计、步骤判定都走这一个映射**，避免三处各写一套判定
 * （此前场景/道具/服装因为读不到 `image_prompts` 而永远停在「待完善提示词」）。
 *
 * `linked` 恒为 true：能出现在项目资产清单里的资产，本身就意味着已经进了项目。
 */
export function assetPrepInputFromReadiness(flags: AssetReadinessFlags): AssetPrepInput {
  return {
    linked: true,
    hasPendingCandidate: flags.has_pending_candidate,
    hasImagePrompt: flags.has_image_prompt,
    hasImage: flags.has_image,
    hasPrimary: flags.has_primary,
  }
}

/** 单个资产的业务状态。 */
export function resolveAssetPrepStatus(input: AssetPrepInput): AssetPrepStatusMeta {
  if (input.hasPendingCandidate) return ASSET_PREP_STATUSES.pending_candidate
  if (input.linked === false) return ASSET_PREP_STATUSES.pending_candidate
  if (input.hasImagePrompt !== true) return ASSET_PREP_STATUSES.linked_prompt_todo
  if (!input.hasImage) return ASSET_PREP_STATUSES.prompt_ready_image_todo
  // 定版状态无法判定时不宣称「已定版」，停在「待设为定版」由用户确认
  if (input.hasPrimary !== true) return ASSET_PREP_STATUSES.image_ready_primary_todo
  return ASSET_PREP_STATUSES.done
}

export type AssetPrepSummary = {
  counts: Record<AssetPrepStatusKey, number>
  total: number
  /** 已定版数量 */
  done: number
  /** 只有**全部**资产都到达「已定版」才算整步就绪 */
  allDone: boolean
}

export function summarizeAssetPrep(inputs: readonly AssetPrepInput[]): AssetPrepSummary {
  const counts: Record<AssetPrepStatusKey, number> = {
    pending_candidate: 0,
    linked_prompt_todo: 0,
    prompt_ready_image_todo: 0,
    image_ready_primary_todo: 0,
    done: 0,
  }
  for (const item of inputs) {
    counts[resolveAssetPrepStatus(item).key] += 1
  }
  const total = inputs.length
  return { counts, total, done: counts.done, allDone: total > 0 && counts.done === total }
}

/** 一句话概览（页面顶部统计用）。 */
export function describeAssetPrepSummary(summary: AssetPrepSummary): string {
  if (summary.total === 0) return '还没有需要准备的资产'
  const parts = (Object.keys(summary.counts) as AssetPrepStatusKey[])
    .filter((key) => summary.counts[key] > 0)
    .map((key) => `${ASSET_PREP_STATUSES[key].label} ${summary.counts[key]}`)
  return `${summary.done}/${summary.total} 已定版｜${parts.join('｜')}`
}

/**
 * 参与定版状态检查的资产集合。
 *
 * **不做任何截断**：就绪判定必须覆盖范围内的每一个资产，
 * 否则第 25 个之后的资产会被漏掉，出现「前面都定版了就显示已就绪」的假象。
 * 并发控制由调用方负责（例如分批请求），这里只负责「选谁」。
 */
export function collectPrimaryLookupTargets<T extends { id: string }>(assets: readonly T[]): T[] {
  return [...assets]
}
