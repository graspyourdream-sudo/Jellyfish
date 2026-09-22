/**
 * 第 2 步「资产准备」→ **资产生产区**的纯逻辑（可单测）。
 *
 * 为什么单独抽一个模块：这一步的动作大多是"会花钱 / 会替换已有定版"的判断，
 * 判定必须可测、可复用，不能散在 JSX 里靠肉眼保证。这里只放纯函数与用户文案，
 * 不 import 任何 React / 网络模块，所以 `node --test` 能直接跑。
 *
 * 硬边界（用户点名，测试锁定）：
 *   A. 批量生成的默认勾选与默认提交范围**只包含没有图片的资产**，不覆盖已有图片/已有定版图；
 *   B. 对已有图片的资产「重新生成」、或把结果「设为定版」而该资产**已有定版**时，
 *      必须二次确认（写清会替换什么、会不会产生费用）。
 *
 * 文案口径（用户要求）：本模块产出的**每一句面向用户的文字**都不含内部字段
 * （`status` / `file_id` / 任务号 / 模型名 / 供应商名 / 「门禁」这类开发术语）。
 * `collectUserFacingTexts()` 把所有静态文案汇总出来，供测试做黑名单断言；
 * 后端回传的动态文本统一走 `maskInternalIds()` 再展示。
 */

// 带 `.ts` 后缀：本模块要能被 `node --test` 直接加载（Node ESM 不猜扩展名），
// tsconfig 已开 allowImportingTsExtensions，Vite 也照常解析。
import { maskInternalIds } from '../../../components/maskInternalIds.ts'

/* ------------------------------------------------------------------ 基础口径 */

export type ProductionAssetType = 'character' | 'scene' | 'prop' | 'costume'

/** 分页签顺序：人物 / 场景 / 道具 / 服装。 */
export const ASSET_TYPE_ORDER: ProductionAssetType[] = ['character', 'scene', 'prop', 'costume']

/** 分页签标题（用户语言）。 */
export const ASSET_TYPE_LABEL: Record<ProductionAssetType, string> = {
  character: '人物',
  scene: '场景',
  prop: '道具',
  costume: '服装',
}

/**
 * 出图服务当前**只接受**这三类资产（后端 `SERVICE_ASSET_TYPES`）。
 * 服装不在契约内 —— 选中服装时必须在**提交前**明确拦住并说明原因，
 * 不能静默丢弃，也不能让它进队列（本机没有 worker 的队列只会留下「排队中」假象）。
 */
export const SUBMITTABLE_ASSET_TYPES: ProductionAssetType[] = ['character', 'scene', 'prop']

export function isSubmittableAssetType(type: ProductionAssetType): boolean {
  return SUBMITTABLE_ASSET_TYPES.includes(type)
}

/**
 * 出图服务 V0 是「单资产单图」，一次只出一张 —— 这是对端契约，不是我们的选择。
 * 所以「张数」在界面上如实说明，不给一个点了没用的选项。
 */
export const IMAGES_PER_ASSET = 1

export type ProductionAsset = {
  /** `${type}:${id}`，全页面唯一的资产键 */
  key: string
  id: string
  type: ProductionAssetType
  name: string
  /** 已有图片（图片表里 `file_id` 非空） */
  hasImage: boolean
  /** 已设为定版 */
  hasPrimary: boolean
  /** 已保存图片提示词 */
  hasImagePrompt: boolean
  /** 当前首选图的行 ID（「设为定版」的默认目标）；null = 还没有图片 */
  imageId: number | null
  /** 现有图片地址（用于结果卡片旁边的对照） */
  thumbnail: string
  /** 还有待确认的提取候选 */
  hasPendingCandidate: boolean
}

export function assetKeyOf(type: ProductionAssetType, id: string): string {
  return `${type}:${id}`
}

/** 步骤信号里的资产 → 生产区资产（只做字段搬运，不改判定）。 */
export function toProductionAssets(
  assets: readonly {
    id: string
    name: string
    type: ProductionAssetType
    hasImage: boolean
    hasPrimary: boolean
    hasImagePrompt: boolean
    imageId: number | null
    thumbnail: string
    hasPendingCandidate: boolean
  }[],
): ProductionAsset[] {
  return assets.map((asset) => ({
    key: assetKeyOf(asset.type, asset.id),
    id: asset.id,
    type: asset.type,
    name: asset.name || asset.id,
    hasImage: asset.hasImage === true,
    hasPrimary: asset.hasPrimary === true,
    hasImagePrompt: asset.hasImagePrompt === true,
    imageId: typeof asset.imageId === 'number' ? asset.imageId : null,
    thumbnail: asset.thumbnail || '',
    hasPendingCandidate: asset.hasPendingCandidate === true,
  }))
}

/* -------------------------------------------------------------------- 选择 */

export type SelectionAction = 'all' | 'clear' | 'ungenerated'

/** 「未生成项」= 还没有任何图片的资产（**不含**已有图片但未定版的资产）。 */
export function isUngenerated(asset: ProductionAsset): boolean {
  return asset.hasImage !== true
}

/** 默认勾选范围：只选没有图片的资产（硬边界 A）。 */
export function selectUngenerated(assets: readonly ProductionAsset[]): string[] {
  return assets.filter(isUngenerated).map((asset) => asset.key)
}

/**
 * 工具条三个动作。
 *
 * `scopeType` = 当前分页签：全选 / 只选未生成 只作用在本分页签上，
 * 其它分页签的已选项**保留**（跨分页签累加，避免切页签把用户的选择清掉）。
 */
export function applySelectionAction(
  assets: readonly ProductionAsset[],
  current: readonly string[],
  action: SelectionAction,
  scopeType?: ProductionAssetType,
): string[] {
  const known = new Set(assets.map((asset) => asset.key))
  const kept = current.filter((key) => known.has(key))
  if (action === 'clear') return []
  const scope = scopeType ? assets.filter((asset) => asset.type === scopeType) : assets
  const scopeKeys =
    action === 'all' ? scope.map((asset) => asset.key) : scope.filter(isUngenerated).map((asset) => asset.key)
  const next = new Set(kept)
  scopeKeys.forEach((key) => next.add(key))
  return Array.from(next)
}

export type SelectionSummary = {
  /** 已选资产数 */
  total: number
  /** 人物 / 场景 / 道具 / 服装各多少项 */
  byType: Record<ProductionAssetType, number>
  /** 可提交给出图服务的资产数（排除服装） */
  submittableCount: number
  /** 选中的服装项数（出图服务不支持，提交前会明确告知并跳过） */
  unsupportedCount: number
  /** 预计生成的图片数量（每个可提交资产 1 张） */
  estimatedImages: number
  /** 其中已经**有图片**的项数（属于「重新生成」，会覆盖/新增结果，需二次确认） */
  withExistingImage: number
  /** 其中已经**有定版图**的项数（重新生成不会静默替换定版） */
  withExistingPrimary: number
  /** 其中还没有图片的项数（默认范围） */
  ungenerated: number
  /** 其中还没有图片提示词的项数（会退化为确定性模板拼装） */
  withoutPrompt: number
  /** 已选资产（按类型顺序稳定排序） */
  assets: ProductionAsset[]
}

function emptyByType(): Record<ProductionAssetType, number> {
  return { character: 0, scene: 0, prop: 0, costume: 0 }
}

/** 选择范围与预计张数（确认框里的每一个数字都来自这里，不另行估算）。 */
export function summarizeSelection(
  assets: readonly ProductionAsset[],
  selectedKeys: readonly string[],
): SelectionSummary {
  const selected = new Set(selectedKeys)
  const picked = assets.filter((asset) => selected.has(asset.key))
  const byType = emptyByType()
  picked.forEach((asset) => {
    byType[asset.type] += 1
  })
  const submittable = picked.filter((asset) => isSubmittableAssetType(asset.type))
  return {
    total: picked.length,
    byType,
    submittableCount: submittable.length,
    unsupportedCount: picked.length - submittable.length,
    estimatedImages: submittable.length * IMAGES_PER_ASSET,
    withExistingImage: submittable.filter((asset) => asset.hasImage).length,
    withExistingPrimary: submittable.filter((asset) => asset.hasPrimary).length,
    ungenerated: submittable.filter((asset) => !asset.hasImage).length,
    withoutPrompt: submittable.filter((asset) => !asset.hasImagePrompt).length,
    assets: picked,
  }
}

/* ---------------------------------------------------------------- 生成设置 */

export type GenerationSettings = {
  /** 是否使用定版图当垫图（关掉 = 纯文本提示词出图） */
  useReference: boolean
  /** 画面比例 */
  aspectRatio: string
}

export const ASPECT_RATIO_OPTIONS = [
  { label: '16:9 横屏', value: '16:9' },
  { label: '9:16 竖屏', value: '9:16' },
  { label: '1:1 方形', value: '1:1' },
  { label: '4:3 横屏', value: '4:3' },
  { label: '3:4 竖屏', value: '3:4' },
] as const

export const DEFAULT_ASPECT_RATIO = '16:9'

/**
 * 默认生成设置：使用定版图当垫图（没有定版图的资产自然退化为纯提示词出图）+ 16:9。
 *
 * 说明：后端 `stage` 只决定**要不要垫图**（`character_sheet` = 不带垫图，
 * `reference_batch` = 带定版垫图），真实生成类型由后端按资产类型决定，
 * 所以这里不需要、也不应该把内部取值暴露给用户。
 */
export function defaultGenerationSettings(): GenerationSettings {
  return { useReference: true, aspectRatio: DEFAULT_ASPECT_RATIO }
}

/** 设置 → 后端 `stage`（内部值，不进用户文案）。 */
export function stageForSettings(settings: GenerationSettings): 'character_sheet' | 'reference_batch' {
  return settings.useReference ? 'reference_batch' : 'character_sheet'
}

/** 设置的一句话说明（用户语言）。 */
export function describeSettings(settings: GenerationSettings): string {
  return [
    settings.useReference ? '使用定版图当垫图' : '不使用垫图（只按提示词出图）',
    `画面比例 ${settings.aspectRatio}`,
    `每个资产 ${IMAGES_PER_ASSET} 张（出图服务一次只出一张）`,
  ].join('；')
}

/* ------------------------------------------------------ 二次确认（硬边界 B） */

export type BatchOperation = 'generate' | 'regenerate'
export type RuntimeMode = 'dry_run' | 'real'

export const COST_WARNING_REAL =
  '当前是真实模式：确认后会把请求发给出图服务并真实出图，按张计费，会产生真实费用。'
export const COST_WARNING_DRY_RUN =
  '当前是演练模式：不会真的调用出图服务、不产生费用；返回的是占位结果，不能采纳进资产。'

export function operationLabel(operation: BatchOperation): string {
  return operation === 'regenerate' ? '重新生成' : '生成'
}

/** 已有图片的资产做「重新生成」时必须二次确认（硬边界 B）。 */
export function requiresRegenerateConfirmation(assets: readonly ProductionAsset[]): boolean {
  return assets.some((asset) => asset.hasImage)
}

export type ConfirmationPlan = {
  /** 是否需要弹二次确认 */
  required: boolean
  /** 是否被阻止（提交前就拦住，并说明原因） */
  blocked: boolean
  blockedReason: string
  title: string
  lines: string[]
  costWarning: string
  okText: string
  cancelText: string
}

export type BatchConfirmationInput = {
  scope: SelectionSummary
  settings: GenerationSettings
  mode: RuntimeMode
  operation: BatchOperation
  /** 本次计划里带垫图的条数（来自只读的出图计划，取不到时传 null） */
  withReference: number | null
}

/**
 * 批量提交前的确认文案（要求 12）。
 *
 * 规则：
 * - **真实模式**一律二次确认（要花钱）；
 * - 批量（多于 1 项）一律二次确认（范围与张数要当面核对）；
 * - **重新生成**（选中项里有已有图片的资产）一律二次确认（硬边界 B）；
 * - 演练模式下单个未生成项的「生成」不弹框（不花钱、不覆盖任何东西）。
 */
export function buildBatchConfirmation(input: BatchConfirmationInput): ConfirmationPlan {
  const { scope, settings, mode, operation } = input
  const label = operationLabel(operation)

  if (scope.submittableCount === 0) {
    return {
      required: false,
      blocked: true,
      blockedReason:
        scope.total === 0
          ? '还没有选择要生成的资产。'
          : '本次选中的资产里没有可以直接出图的类型：出图服务目前只支持人物、场景、道具；服装请先在资产页手工上传或生成图片。',
      title: `无法${label}`,
      lines: [],
      costWarning: '',
      okText: '知道了',
      cancelText: '',
    }
  }

  const required =
    mode === 'real' ||
    scope.total > 1 ||
    operation === 'regenerate' ||
    scope.withExistingImage > 0

  const lines: string[] = [
    `本次选择资产 ${scope.total} 项：人物 ${scope.byType.character}、场景 ${scope.byType.scene}、道具 ${scope.byType.prop}、服装 ${scope.byType.costume}`,
    `本次可出图 ${scope.submittableCount} 项，预计生成图片 ${scope.estimatedImages} 张`,
  ]
  if (scope.unsupportedCount > 0) {
    lines.push(
      `服装 ${scope.unsupportedCount} 项本次不会提交：出图服务目前只接受人物、场景、道具，服装图片请在资产页手工上传或生成`,
    )
  }
  if (operation === 'regenerate' || scope.withExistingImage > 0) {
    lines.push(
      `其中已有图片的资产 ${scope.withExistingImage} 项会走「重新生成」：新结果会作为一张新图片保存，` +
        '不会自动替换现有图片，也不会动现有定版图（要换定版由你手动确认）',
    )
  }
  if (scope.withExistingPrimary > 0) {
    lines.push(`其中已有定版图的资产 ${scope.withExistingPrimary} 项：本次只新增结果，定版图保持不变`)
  }
  if (scope.ungenerated > 0) {
    lines.push(`其中还没有图片的资产 ${scope.ungenerated} 项会直接生成首张参考图`)
  }
  lines.push(describeSettings(settings))
  if (settings.useReference) {
    const withReference = input.withReference
    lines.push(
      withReference === null
        ? '本次会尽量用各资产已定版的图当垫图（取不到垫图的会按纯提示词出图）'
        : `本次计划里带垫图 ${withReference} 项，其余没有可用垫图的会按纯提示词出图`,
    )
  }
  if (scope.withoutPrompt > 0) {
    lines.push(`其中 ${scope.withoutPrompt} 项还没有保存过图片提示词，本次会用资产描述拼装提示词`)
  }

  return {
    required,
    blocked: false,
    blockedReason: '',
    title:
      operation === 'regenerate'
        ? `确认重新生成这 ${scope.submittableCount} 项资产？`
        : `确认生成这 ${scope.submittableCount} 项资产的图片？`,
    lines,
    costWarning: mode === 'real' ? COST_WARNING_REAL : COST_WARNING_DRY_RUN,
    okText: mode === 'real' ? `确认真实生成（${scope.estimatedImages} 张）` : `确认生成（${scope.estimatedImages} 张）`,
    cancelText: '取消',
  }
}

/** 设为定版：该资产**已有定版**时必须二次确认（硬边界 B）。 */
export function requiresPrimaryReplaceConfirmation(asset: Pick<ProductionAsset, 'hasPrimary'> | undefined): boolean {
  return asset?.hasPrimary === true
}

export type PrimaryConfirmationPlan = {
  required: boolean
  title: string
  lines: string[]
  costWarning: string
}

/**
 * 「设为定版」的确认文案。
 *
 * 说实话：换定版本身**不产生出图费用**（只是改一个标识）；但它会改变
 * 后续出图使用的垫图，所以必须写清"替换的是什么"。
 */
export function buildPrimaryReplaceConfirmation(args: {
  assetName: string
  currentPrimaryNote?: string
  isFromGeneratedResult: boolean
}): PrimaryConfirmationPlan {
  return {
    required: true,
    title: `把这张设为「${args.assetName}」的定版图？`,
    lines: [
      args.currentPrimaryNote
        ? `该资产已有定版图（${args.currentPrimaryNote}），设为定版会替换掉它作为"定版"的身份`
        : '该资产已有定版图，设为定版会替换掉它作为"定版"的身份',
      '原图片不会被删除，仍在资产里，随时可以切回来',
      args.isFromGeneratedResult
        ? '这张是本次生成的结果，会先保存进该资产的图片再设为定版'
        : '这张来自该资产已有的图片',
      '后续出图会用它当垫图，镜头一致性以它为准',
    ],
    costWarning: '替换定版本身不产生出图费用；只有之后再点「生成」才会产生费用。',
  }
}

/* ---------------------------------------------------------- 在途闸门 / 幂等 */

export type SubmitGateReason = 'in_flight' | 'already_submitted_same_prompt'

export type SubmitGateDecision =
  | { allowed: true }
  | { allowed: false; reason: SubmitGateReason; message: string }

export type AssetSubmitGate = {
  /** 同一资产同一轮不得重复提交（防止连点重复付费） */
  begin: (assetKey: string) => SubmitGateDecision
  /** 提交返回后登记后端的幂等键（同资产 + 同提示词 = 同一把键） */
  finish: (assetKey: string, sourceTaskId: string) => void
  /** 释放在途标记（失败/异常时也要释放，否则该资产永远点不动） */
  release: (assetKey: string) => void
  /** 该资产的幂等键是否已经提交过（相同提示词 → 服务端会直接复用已有结果） */
  submittedKeys: () => string[]
  isInFlight: (assetKey: string) => boolean
}

/**
 * 在途闸门。
 *
 * 两层防重复：
 *  1. **本闸门**：同一资产在"提交中"期间再点一次会被拒绝（连点不重复付费）；
 *  2. **后端幂等键**（`build_source_task_id`：同项目 + 同资产 + 同提示词）：
 *     换一轮再提交同一提示词时，出图服务会直接返回已有任务，不再重复生成。
 *     所以这里记录已提交过的键，命中时如实提示用户"服务会复用已有结果"，
 *     而不是默默再发一次请求。
 */
export function createAssetSubmitGate(): AssetSubmitGate {
  const inFlight = new Set<string>()
  const submitted = new Set<string>()
  return {
    begin(assetKey: string): SubmitGateDecision {
      if (inFlight.has(assetKey)) {
        return {
          allowed: false,
          reason: 'in_flight',
          message: '这一项正在提交中，已忽略重复点击（不会重复生成）。',
        }
      }
      inFlight.add(assetKey)
      return { allowed: true }
    },
    finish(assetKey: string, sourceTaskId: string) {
      inFlight.delete(assetKey)
      const key = String(sourceTaskId || '').trim()
      if (key) submitted.add(key)
    },
    release(assetKey: string) {
      inFlight.delete(assetKey)
    },
    submittedKeys() {
      return Array.from(submitted)
    },
    isInFlight(assetKey: string) {
      return inFlight.has(assetKey)
    },
  }
}

/**
 * 同一提示词是否已经提交过（幂等键相同）。
 *
 * 命中时**不是拦死**，而是把话说清楚：出图服务会返回已有结果，
 * 想出一张新的图需要改提示词（界面上的「重新生成」会自动加一句变化要求）。
 */
export function findIdempotentReuse(
  submittedKeys: readonly string[],
  sourceTaskId: string,
): boolean {
  const key = String(sourceTaskId || '').trim()
  return Boolean(key) && submittedKeys.includes(key)
}

/**
 * 尝试序号上限（与后端 `ImageSubmitRequest.attempt` 的 0..99 对齐）。
 */
export const MAX_ATTEMPT = 99

/**
 * 本次尝试的序号（0 = 首轮）。
 *
 * 语义：**本次是第几次尝试**（0 基）＝ 这个资产之前已经尝试过几次。
 * 首轮必须是 0（这样与只读计划里回显的幂等键一致）；每提交一次就把计数 +1，
 * 于是重试 / 重新生成自然拿到新的序号 → 后端算出一个新的幂等键 → 真的再出一张。
 */
export function attemptForNextTry(previousAttempts: number): number {
  const previous = Number.isFinite(previousAttempts) ? Math.max(0, Math.floor(previousAttempts)) : 0
  return Math.min(MAX_ATTEMPT, previous)
}

export type AttemptPlan = {
  /** 本次要用的提示词（**原样**，不再往提示词里塞任何东西） */
  prompt: string
  /** 本次的尝试序号（0 = 首轮） */
  attempt: number
  /** 给用户看的一句话：这次到底会怎么生成 */
  note: string
  /** 是否是一次"再来一张"（attempt > 0） */
  isRetry: boolean
}

/**
 * 「重新生成 / 重试失败项」的提交参数。
 *
 * 为什么用尝试序号、而不是往提示词里加字：
 * 出图服务的幂等键是「项目 + 资产 + 提示词」（外加尝试序号）。
 * 同一提示词原样再提交只会拿回上一次的结果（失败的话连失败都不变），
 * 所以重试/重生成必须换一个键——后端为此提供了 `attempt`（序号混进哈希）。
 * 这样**提示词保持干净**，界面上展示的提示词与实际送出的完全一致。
 */
export function buildAttemptPlan(
  basePrompt: string,
  options: { hasEditedPrompt: boolean; previousAttempt: number },
): AttemptPlan {
  const base = String(basePrompt || '').trim()
  const attempt = attemptForNextTry(options.previousAttempt)
  if (!base) {
    return {
      prompt: '',
      attempt,
      note: '这一项还没有提示词，会按资产描述拼装提示词后再生成。',
      isRetry: attempt > 0,
    }
  }
  if (options.hasEditedPrompt) {
    return {
      prompt: base,
      attempt,
      note: '本次使用你在「编辑提示词」里改过的提示词（会作为一条新提示词提交）。',
      isRetry: attempt > 0,
    }
  }
  return {
    prompt: base,
    attempt,
    note:
      attempt > 0
        ? `这是第 ${attempt + 1} 次尝试：用同一条提示词再生成一张新图（出图服务会为本次尝试分配新的任务，不会把上一次的结果直接还给你）。`
        : '这次会用上面这条提示词生成；同一条提示词如果之前提交过，出图服务会复用已有结果。',
    isRetry: attempt > 0,
  }
}

/* -------------------------------------------------------------- 任务与进度 */

export type ProductionTaskStatus =
  | 'queued'
  | 'submitting'
  | 'generating'
  | 'done'
  | 'failed'
  | 'dry_run'
  | 'stopped'

export type ProductionTask = {
  /** 一张结果卡片一个键：`${assetKey}#${round}`（同一资产多轮即多张卡片） */
  key: string
  assetKey: string
  assetId: string
  assetType: ProductionAssetType
  assetName: string
  round: number
  /** 这一项是第几次尝试（0 = 首轮）。重试/重新生成会 +1，后端据此换一个新的幂等键 */
  attempt: number
  operation: BatchOperation
  status: ProductionTaskStatus
  /** 后端幂等键（来自出图计划，前端不自己拼） */
  sourceTaskId: string
  /** 出图服务任务号（内部值，只进「技术详情」） */
  serviceTaskId: string
  /** 本次实际使用的提示词（用户可编辑，可见） */
  prompt: string
  /** 归一化口径（内部值，只进「技术详情」） */
  outcome: string
  ossUrl: string
  imageUrl: string
  /** 失败原因（已做内部标识屏蔽，可直接展示） */
  errorMessage: string
  /** 正常结果的说明（例如「结果暂存在出图服务本机，采纳后才会落到资产图片里」） */
  note: string
  /** 采纳后落到资产图片槽位的地址与行 ID */
  adoptedUrl: string
  adoptedImageId: number | null
  /** 这张结果是否已被设为该资产的定版 */
  isPrimary: boolean
  createdAt: number
  updatedAt: number
}

export const TASK_STATUS_LABEL: Record<ProductionTaskStatus, string> = {
  queued: '排队中',
  submitting: '正在提交',
  generating: '正在生成',
  done: '已完成',
  failed: '生成失败',
  dry_run: '演练占位',
  stopped: '已停止',
}

export type TaskStatusTone = 'default' | 'blue' | 'green' | 'red' | 'gold'

export function describeTaskStatus(status: ProductionTaskStatus): { label: string; tone: TaskStatusTone } {
  const label = TASK_STATUS_LABEL[status] ?? TASK_STATUS_LABEL.failed
  const tone: TaskStatusTone =
    status === 'done' ? 'green' : status === 'failed' ? 'red' : status === 'dry_run' ? 'gold' : status === 'stopped' ? 'default' : 'blue'
  return { label, tone }
}

export type TaskProgressSummary = {
  total: number
  done: number
  failed: number
  generating: number
  queued: number
  stopped: number
  dryRun: number
  /** 已经跑完（含失败/停止/演练占位）的条数 */
  finished: number
  percent: number
  hasFailure: boolean
  failureReasons: string[]
}

/**
 * 进度数字（要求 7）。全部来自真实的任务状态，不估算、不编造：
 * 总数 / 已完成 / 失败 / 生成中 / 排队中 / 已停止 / 演练占位。
 */
export function summarizeTaskProgress(tasks: readonly ProductionTask[]): TaskProgressSummary {
  const counts = { done: 0, failed: 0, generating: 0, queued: 0, stopped: 0, dryRun: 0 }
  const reasons: string[] = []
  tasks.forEach((task) => {
    switch (task.status) {
      case 'done':
        counts.done += 1
        break
      case 'failed':
        counts.failed += 1
        if (task.errorMessage) reasons.push(task.errorMessage)
        break
      case 'generating':
      case 'submitting':
        counts.generating += 1
        break
      case 'queued':
        counts.queued += 1
        break
      case 'stopped':
        counts.stopped += 1
        break
      case 'dry_run':
        counts.dryRun += 1
        break
      default:
        break
    }
  })
  const total = tasks.length
  const finished = counts.done + counts.failed + counts.stopped + counts.dryRun
  return {
    total,
    ...counts,
    finished,
    percent: total === 0 ? 0 : Math.round((finished / total) * 100),
    hasFailure: counts.failed > 0,
    failureReasons: Array.from(new Set(reasons)).slice(0, 3),
  }
}

export type ProgressLine = { label: string; value: number; tone: TaskStatusTone }

/** 进度条上方的那排数字（用户语言）。 */
export function describeProgressLines(summary: TaskProgressSummary): ProgressLine[] {
  return [
    { label: '总数', value: summary.total, tone: 'default' },
    { label: '已完成', value: summary.done, tone: 'green' },
    { label: '生成中', value: summary.generating, tone: 'blue' },
    { label: '排队中', value: summary.queued, tone: 'blue' },
    { label: '失败', value: summary.failed, tone: summary.failed > 0 ? 'red' : 'default' },
    { label: '已停止', value: summary.stopped, tone: 'default' },
    { label: '演练占位', value: summary.dryRun, tone: 'gold' },
  ]
}

/**
 * 停止本轮：**只把"还没开始"的项标成已停止**。
 *
 * 已经完成的卡片、已经采纳/设为定版的结果一个都不动（要求 9）。
 * 正在跑的那一项也不动 —— 出图服务没有取消接口，这一张会跑完。
 */
export function applyStopToQueue(tasks: readonly ProductionTask[]): ProductionTask[] {
  return tasks.map((task) => (task.status === 'queued' ? { ...task, status: 'stopped' } : task))
}

/** 停止时给用户的一句话（写清"停的是什么、什么跑完"）。 */
export function describeStopEffect(summary: TaskProgressSummary): string {
  const parts = [`已停止后续：排队中的 ${summary.queued} 项不会开始`]
  if (summary.generating > 0) parts.push(`正在生成的 ${summary.generating} 项会跑完（出图服务没有取消接口）`)
  parts.push(`已完成的 ${summary.done} 项结果会保留`)
  return parts.join('；')
}

/** 本轮是否有还在跑的项（用于按钮态与轮询开关）。 */
export function hasUnsettledTasks(tasks: readonly ProductionTask[]): boolean {
  return tasks.some((task) => task.status === 'submitting' || task.status === 'generating' || task.status === 'queued')
}

/**
 * 结果卡片的展示顺序：**已停止的排在最后**，默认只展示最近的 `maxVisible` 张。
 *
 * 为什么要这样排：用户点「停止后续」之后，未开始的项会变成"已停止"。
 * 若按插入顺序展示，一堆"已停止"的占位卡片会把**已完成的结果**挤出可视区，
 * 看起来像"结果丢了"——而实际一条都没丢（进度数字里也照样能看到已完成数量）。
 */
export function orderCardsForDisplay(
  tasks: readonly ProductionTask[],
  options: { showAll: boolean; maxVisible: number },
): ProductionTask[] {
  const stopped = tasks.filter((task) => task.status === 'stopped')
  const active = tasks.filter((task) => task.status !== 'stopped')
  if (options.showAll) return [...active, ...stopped]
  const pool = active.length > 0 ? active : stopped
  const limit = Math.max(0, options.maxVisible)
  return pool.slice(Math.max(0, pool.length - limit))
}

/* -------------------------------------------------------- 结果 → 任务状态 */

export type SubmitResultLike = {
  source_task_id?: string
  source_asset_id?: string
  service_task_id?: string
  status?: string
  outcome?: string
  ok?: boolean
  dry_run?: boolean
  image_url?: string
  oss_url?: string
  oss_ready?: boolean
  message?: string
  error_message?: string
}

export type NormalizedResult = {
  status: ProductionTaskStatus
  outcome: string
  /** 面向用户的原因/说明（已屏蔽内部标识） */
  reason: string
  /** 是否已经拿到长期资产地址（OSS URL） */
  hasLongTermAddress: boolean
  serviceTaskId: string
  ossUrl: string
  imageUrl: string
  sourceTaskId: string
}

/** 演练占位地址的不可达域名（与后端 `adopt.PLACEHOLDER_URL_MARKERS` 同口径）。 */
export const PLACEHOLDER_URL_MARKERS = ['dry-run.invalid']

export function isPlaceholderUrl(url: string): boolean {
  const text = String(url || '')
  return PLACEHOLDER_URL_MARKERS.some((marker) => text.includes(marker))
}

/** 本机 / 内网地址（上游与浏览器都取不到的那种）。 */
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /\.local$/i,
]

/**
 * 是否是**公网可访问**的绝对地址。
 *
 * 为什么需要：出图服务的产物有两种形态 —— 已上传长期存储（可以当长期资产）
 * 和只存在出图服务本机（`http://localhost:4173/images/xxx.png`）。
 * 后者虽然也是 `http://` 开头，但**不是长期资产地址**，
 * 拿它去登记外链素材只会得到一张别人打不开的图。
 */
export function isPubliclyReachableUrl(url: string): boolean {
  const text = String(url || '').trim()
  if (!/^https?:\/\//i.test(text)) return false
  let host = ''
  try {
    host = new URL(text).hostname
  } catch {
    return false
  }
  if (!host) return false
  return !PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))
}

/** 失败原因：优先上游真话，其次按归一化口径给出可执行的说明；一律屏蔽内部标识。 */
export function describeFailureReason(result: Pick<SubmitResultLike, 'error_message' | 'message' | 'outcome'>): string {
  const text = String(result.error_message || result.message || '').trim()
  if (text) return maskInternalIds(text)
  if (String(result.outcome || '') === 'partial_failed') {
    return '图片已经生成，但没有完成长期存储，因此暂时不可用；可以稍后刷新这一项，或重新生成。'
  }
  return '生成失败，但没有拿到具体原因；可在结果卡片上点「查看详情」核对。'
}

/** 提交响应（单条结果）→ 任务状态。 */
export function resolveResultStatus(result: SubmitResultLike): NormalizedResult {
  const outcome = String(result.outcome || '')
  const serviceTaskId = String(result.service_task_id || '')
  const ossUrl = String(result.oss_url || '')
  const imageUrl = String(result.image_url || '')
  const sourceTaskId = String(result.source_task_id || '')
  const base = {
    outcome,
    serviceTaskId,
    ossUrl,
    imageUrl,
    sourceTaskId,
    hasLongTermAddress: Boolean(ossUrl),
  }
  if (result.dry_run === true || outcome === 'dry_run') {
    return {
      ...base,
      status: 'dry_run',
      reason: '演练模式返回的是占位结果，没有真实生成图片；关闭演练模式并确认真实调用后才会真的出图。',
    }
  }
  if (outcome === 'failed' || outcome === 'partial_failed') {
    return { ...base, status: 'failed', reason: describeFailureReason(result) }
  }
  if (outcome === 'running' || outcome === 'unknown' || (!outcome && result.ok !== false && serviceTaskId)) {
    if (serviceTaskId) {
      return { ...base, status: 'generating', reason: '已提交给出图服务，正在生成；可以点「刷新进度」查看结果。' }
    }
    return {
      ...base,
      status: 'failed',
      reason: '出图服务没有返回可继续查询的任务，请在「查看详情」里核对该次响应。',
    }
  }
  if (ossUrl) {
    return { ...base, status: 'done', reason: '' }
  }
  if (imageUrl) {
    return {
      ...base,
      status: 'done',
      reason: '结果暂存在出图服务本机，采纳后才会落到资产图片里（长期地址）。',
    }
  }
  if (serviceTaskId) {
    return { ...base, status: 'generating', reason: '已提交给出图服务，正在生成；可以点「刷新进度」查看结果。' }
  }
  return { ...base, status: 'failed', reason: describeFailureReason(result) }
}

/* -------------------------------------------------------- 提交结果去重/挑选 */

export type SubmitResultRow = SubmitResultLike & { source_asset_id?: string }

/**
 * 一次提交返回多条结果时的**去重**。
 *
 * 为什么要去重：同一个资产在项目里有多个关联行时，后端组装出的提交目标会出现
 * **重复条目**（同一个资产、同一把幂等键）。它们各自是一次真实的后端调用，
 * 但出图服务按幂等键只会有一个任务，所以页面必须按幂等键合并，
 * 否则进度数字（总数/完成/失败）会被重复条目放大。
 */
export function dedupeResults<T extends SubmitResultRow>(results: readonly T[]): T[] {
  const byKey = new Map<string, T>()
  const order: string[] = []
  results.forEach((row, index) => {
    const key = String(row.source_task_id || '').trim() || `__row_${index}`
    const current = byKey.get(key)
    if (!current) {
      byKey.set(key, row)
      order.push(key)
      return
    }
    if (resultRank(row) > resultRank(current)) byKey.set(key, row)
  })
  return order.map((key) => byKey.get(key) as T)
}

/** 结果"信息量"排序：有长期地址 > 有结果地址 > 有任务号 > 其它。 */
function resultRank(row: SubmitResultRow): number {
  if (String(row.oss_url || '')) return 3
  if (String(row.image_url || '')) return 2
  if (String(row.service_task_id || '')) return 1
  return 0
}

/** 从一次提交的多条结果里挑出「某一个资产」的代表结果。 */
export function pickResultForAsset<T extends SubmitResultRow>(
  results: readonly T[],
  assetId: string,
): T | null {
  const deduped = dedupeResults(results)
  const own = deduped.filter((row) => String(row.source_asset_id || '') === assetId)
  const pool = own.length > 0 ? own : deduped
  if (pool.length === 0) return null
  return pool.reduce((best, row) => (resultRank(row) > resultRank(best) ? row : best), pool[0])
}

/** 查询任务（回读产物）→ 任务补丁。 */export function resolveTaskQueryPatch(query: {
  status?: string
  oss_url?: string
  local_path?: string
  error_message?: string
  dry_run?: boolean
  images?: Record<string, unknown>[]
}): Pick<ProductionTask, 'status' | 'ossUrl' | 'imageUrl' | 'errorMessage' | 'outcome'> | null {
  const rawStatus = String(query.status || '').trim().toLowerCase()
  const ossUrl = String(query.oss_url || '')
  const localPath = String(query.local_path || '')
  if (query.dry_run === true || rawStatus === 'dry_run') {
    return { status: 'dry_run', ossUrl: '', imageUrl: '', errorMessage: '', outcome: 'dry_run' }
  }
  if (rawStatus === 'succeeded' || rawStatus === 'success' || rawStatus === 'completed' || rawStatus === 'done') {
    return { status: 'done', ossUrl, imageUrl: localPath, errorMessage: '', outcome: 'ok' }
  }
  if (rawStatus === 'failed' || rawStatus === 'partial_failed' || rawStatus === 'error' || rawStatus === 'timeout') {
    return {
      status: 'failed',
      ossUrl,
      imageUrl: localPath,
      errorMessage: describeFailureReason({ error_message: query.error_message, outcome: rawStatus }),
      outcome: rawStatus,
    }
  }
  return { status: 'generating', ossUrl, imageUrl: localPath, errorMessage: '', outcome: rawStatus || 'running' }
}

/* ------------------------------------------------------------------ 采纳 */

export type AdoptionPlan =
  | { mode: 'adopt'; imageId: number | null; reason: string }
  | { mode: 'new_slot'; reason: string }
  | { mode: 'blocked'; reason: string }

/**
 * 「采纳」的落点决策（**不得静默替换现有定版图**）。
 *
 * 背景：采纳端点在不传目标槽位时会复用该资产的**第一行**图片槽位
 * （`is_primary` 也保持原样）。对已有图片的资产而言，那意味着悄悄把现有
 * 图片（很可能就是定版图）换掉。所以这里分三种情况：
 *
 * - 该资产还没有图片 → 直接采纳到（空）槽位，安全；
 * - 该资产已有图片，但存在空槽位 → 采纳到那个空槽位，不动任何现有图片；
 * - 该资产已有图片且没有空槽位 → 用"登记外链素材 + 新建图片槽位"的方式新增一张，
 *   绝不覆盖（这需要长期可访问的地址；只有本机地址时明确拦住并说明原因）。
 */
export function planAdoption(args: {
  asset: Pick<ProductionAsset, 'hasImage' | 'imageId' | 'name'>
  url: string
  emptySlotId: number | null
}): AdoptionPlan {
  const url = String(args.url || '').trim()
  if (!url) {
    return {
      mode: 'blocked',
      reason: '这次结果没有可用的图片地址（演练模式不会产生真实图片），暂时无法采纳。',
    }
  }
  if (isPlaceholderUrl(url)) {
    return {
      mode: 'blocked',
      reason: '这是演练模式返回的占位地址，不是真实图片，不能采纳进资产。',
    }
  }
  if (!args.asset.hasImage) {
    return {
      mode: 'adopt',
      imageId: args.asset.imageId ?? null,
      reason: '该资产还没有图片，会用这张作为它的首张图片（不会成为定版，除非你单独确认）。',
    }
  }
  if (args.emptySlotId !== null) {
    return { mode: 'adopt', imageId: args.emptySlotId, reason: '该资产已有图片，会存入一个空的图片槽位，不动现有图片。' }
  }
  const isPublic = isPubliclyReachableUrl(url)
  if (!isPublic) {
    return {
      mode: 'blocked',
      reason:
        '该资产已经有图片，而这次结果只有出图服务本机地址；为避免覆盖现有图片，没有自动采纳。请到资产编辑页手工上传这张图。',
    }
  }
  return { mode: 'new_slot', reason: '该资产已有图片，会新增一张图片（现有图片与定版图都保持不变）。' }
}

/* ------------------------------------------------------------ 顶部状态文案 */

export type ProductionTone = TaskStatusTone

export type ProductionHeadline = {
  label: string
  tone: ProductionTone
  detail: string
}

export type ProductionHeadlineInput = {
  assets: readonly ProductionAsset[]
  progress: TaskProgressSummary
  /**
   * **已就绪**的资产数。
   *
   * 「就绪」的判定必须与步骤摘要（`assetPrepStatus.resolveAssetPrepStatus`）完全一致
   * （有提示词 + 有图片 + 已定版），否则会出现「本区说已定版、顶部摘要说未就绪」这种自相矛盾。
   */
  readyCount: number
}

/**
 * 本区顶部状态（要求 13）。只产出用户语言，取值只有这几种：
 * 可以开始提取 / 可以生成图片 / 正在生成 / 生成失败 / 已有图片，待设为定版 / 已定版。
 */
export function resolveProductionHeadline(input: ProductionHeadlineInput): ProductionHeadline {
  const { assets, progress, readyCount } = input
  if (assets.length === 0) {
    return {
      label: '可以开始提取',
      tone: 'gold',
      detail: '项目里还没有人物 / 场景 / 道具 / 服装资产：先在上面提取候选并确认写入，再回来准备图片。',
    }
  }
  if (progress.generating > 0 || progress.queued > 0) {
    return {
      label: '正在生成',
      tone: 'blue',
      detail: `本轮共 ${progress.total} 项：生成中 ${progress.generating} 项，排队中 ${progress.queued} 项，已完成 ${progress.done} 项。`,
    }
  }
  if (progress.failed > 0) {
    const reason = progress.failureReasons[0] || '失败原因未提供'
    return {
      label: '生成失败',
      tone: 'red',
      detail: `本轮有 ${progress.failed} 项生成失败：${reason}（可以在对应结果卡片上单独重试）`,
    }
  }
  const allReady = assets.length > 0 && readyCount === assets.length
  if (allReady) {
    return {
      label: '已定版',
      tone: 'green',
      detail: `全部 ${assets.length} 项资产都已定版，可以进入下一步（镜头视频提示词）。`,
    }
  }
  const hasImageNoPrimary = assets.some((asset) => asset.hasImage && !asset.hasPrimary)
  if (hasImageNoPrimary) {
    const count = assets.filter((asset) => asset.hasImage && !asset.hasPrimary).length
    return {
      label: '已有图片，待设为定版',
      tone: 'blue',
      detail: `有 ${count} 项资产已经有图片但还没定版：定版图会作为后续出图的垫图，请挑一张设为定版。`,
    }
  }
  const ungenerated = assets.filter(isUngenerated).length
  if (ungenerated > 0) {
    return {
      label: '可以生成图片',
      tone: 'gold',
      detail: `还有 ${ungenerated} 项资产没有图片：默认只勾选未生成项，选好后点「批量生成选中项」。`,
    }
  }
  const withoutPrompt = assets.filter((asset) => !asset.hasImagePrompt).length
  return {
    label: '可以生成图片',
    tone: 'gold',
    detail:
      withoutPrompt > 0
        ? `图片都已就绪，但还有 ${withoutPrompt} 项资产没有保存图片提示词：可以点「填提示词」或让大模型生成，再决定要不要重新生成。`
        : `图片与提示词都已就绪，但还有 ${assets.length - readyCount} 项资产没有定版：请挑一张满意的图设为定版。`,
  }
}

/* -------------------------------------------------------- 内部标识黑名单自检 */

/**
 * 用户界面里**不允许出现**的内部标识（第三部分要求四）。
 * 只用于测试自检：任何面向用户的静态文案都不该命中它们。
 */
export const INTERNAL_TOKEN_BLACKLIST = [
  'file_id',
  'storage_key',
  'asset_id',
  'source_task_id',
  'service_task_id',
  'oss_url',
  'image_url',
  'status',
  'dry_run',
  'dry-run',
  'partial_failed',
  'queued',
  'running',
  'gpt-image',
  'apimart',
  'provider',
  'celery',
  'build_source_task_id',
  '门禁',
]

/**
 * 汇总本模块产出的所有静态用户文案（测试用）。
 *
 * 动态文案（后端错误原文）不在这里 —— 它们统一经 `maskInternalIds()` 处理。
 */
export function collectUserFacingTexts(): string[] {
  const assets: ProductionAsset[] = [
    {
      key: 'character:a',
      id: 'a',
      type: 'character',
      name: '甲',
      hasImage: false,
      hasPrimary: false,
      hasImagePrompt: false,
      imageId: null,
      thumbnail: '',
      hasPendingCandidate: false,
    },
    {
      key: 'scene:b',
      id: 'b',
      type: 'scene',
      name: '乙',
      hasImage: true,
      hasPrimary: true,
      hasImagePrompt: true,
      imageId: 7,
      thumbnail: '/x.png',
      hasPendingCandidate: false,
    },
    {
      key: 'costume:c',
      id: 'c',
      type: 'costume',
      name: '丙',
      hasImage: true,
      hasPrimary: false,
      hasImagePrompt: true,
      imageId: 9,
      thumbnail: '/y.png',
      hasPendingCandidate: false,
    },
  ]
  const texts: string[] = [
    ...Object.values(ASSET_TYPE_LABEL),
    ...Object.values(TASK_STATUS_LABEL),
    ...Object.values(ASPECT_RATIO_OPTIONS).map((item) => item.label),
    describeSettings({ useReference: true, aspectRatio: DEFAULT_ASPECT_RATIO }),
    describeSettings({ useReference: false, aspectRatio: '9:16' }),
    COST_WARNING_REAL,
    COST_WARNING_DRY_RUN,
    operationLabel('generate'),
    operationLabel('regenerate'),
    TASK_STATUS_LABEL.queued,
  ]
  const scope = summarizeSelection(assets, assets.map((asset) => asset.key))
  const confirmation = buildBatchConfirmation({
    scope,
    settings: { useReference: true, aspectRatio: DEFAULT_ASPECT_RATIO },
    mode: 'real',
    operation: 'regenerate',
    withReference: 1,
  })
  texts.push(confirmation.title, confirmation.costWarning, confirmation.okText, confirmation.cancelText, ...confirmation.lines)
  const dryConfirmation = buildBatchConfirmation({
    scope,
    settings: { useReference: false, aspectRatio: DEFAULT_ASPECT_RATIO },
    mode: 'dry_run',
    operation: 'generate',
    withReference: null,
  })
  texts.push(dryConfirmation.title, dryConfirmation.costWarning, dryConfirmation.okText, ...dryConfirmation.lines)
  const primary = buildPrimaryReplaceConfirmation({ assetName: '乙', isFromGeneratedResult: true })
  texts.push(primary.title, primary.costWarning, ...primary.lines)

  // —— 顶部状态的每一种取值都要被覆盖（含"正在生成""生成失败"）——
  const ungeneratedOnly = assets.filter((asset) => !asset.hasImage)
  const progressCases: TaskProgressSummary[] = [
    summarizeTaskProgress([]),
    summarizeTaskProgress([makeSampleTask({ status: 'generating' })]),
    summarizeTaskProgress([makeSampleTask({ status: 'failed', errorMessage: '上游返回失败' })]),
  ]
  const assetCases: ProductionAsset[][] = [[], ungeneratedOnly, assets]
  const primaryCountCases = [0, 1, 3]
  assetCases.forEach((assetCase) => {
    progressCases.forEach((progress) => {
      primaryCountCases.forEach((readyCount) => {
        const headline = resolveProductionHeadline({ assets: assetCase, progress, readyCount })
        texts.push(headline.label, headline.detail)
      })
    })
  })

  texts.push(
    ...describeProgressLines(summarizeTaskProgress([])).map((line) => line.label),
    describeStopEffect(summarizeTaskProgress([makeSampleTask({ status: 'generating' })])),
    ...['queued', 'submitting', 'generating', 'done', 'failed', 'dry_run', 'stopped'].map(
      (status) => describeTaskStatus(status as ProductionTaskStatus).label,
    ),
    // 失败原因的兜底文案（不带后端原文的那两条分支）
    describeFailureReason({ outcome: 'partial_failed' }),
    describeFailureReason({ outcome: 'failed' }),
    // 「重新生成」的提示词说明
    buildAttemptPlan('甲：正面全身参考图', { hasEditedPrompt: false, previousAttempt: 0 }).note,
    buildAttemptPlan('甲：正面全身参考图', { hasEditedPrompt: true, previousAttempt: 0 }).note,
    buildAttemptPlan('', { hasEditedPrompt: false, previousAttempt: 0 }).note,
    // 采纳的三个分支说明
    planAdoption({ asset: assets[0], url: '', emptySlotId: null }).reason ?? '',
  )
  return texts.filter((text) => typeof text === 'string' && text.length > 0)
}

/** 造一条样例任务（仅测试与文案自检用）。 */
export function makeSampleTask(patch: Partial<ProductionTask> = {}): ProductionTask {
  return {
    key: 'character:a#1',
    assetKey: 'character:a',
    assetId: 'a',
    assetType: 'character',
    assetName: '甲',
    round: 1,
    attempt: 0,
    operation: 'generate',
    status: 'queued',
    sourceTaskId: '',
    serviceTaskId: '',
    prompt: '',
    outcome: '',
    ossUrl: '',
    imageUrl: '',
    errorMessage: '',
    note: '',
    adoptedUrl: '',
    adoptedImageId: null,
    isPrimary: false,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }
}
