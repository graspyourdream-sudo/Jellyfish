/**
 * 资产生产区（第 2 步「资产准备」的核心：连续生产流程）。
 *
 * 流程：选择要生成的资产 → 批量生成参考图 / 批量重新生成参考图 → 看进度与失败原因 → 结果卡片
 * → 采纳 → 设为定版 → 全部必要资产定版后进入下一步。
 *
 * 复用（**不重新建第二套生成逻辑**）：
 *   - 出图计划预览 `POST /studio/image-pipeline/plan/preview`（只读，给出提示词来源与幂等键）；
 *   - 批量出图提交 `POST /studio/image-pipeline/submit`（**同进程内联执行**，不进队列）；
 *   - 任务回读 `GET /studio/image-pipeline/task/{id}`；
 *   - 采纳 `POST /studio/image-pipeline/adopt`；新增图片槽位 `POST /studio/entities/.../images`；
 *   - 提示词生成/完善 `POST /studio/llm/image-prompt/preview` + 既有保存接口。
 *
 * 边界（硬要求）：
 *   - 默认只勾选 / 只提交**没有图片的资产**，不覆盖已有图片与已有定版图；
 *   - 「重新生成参考图」与「已有定版时替换定版」都必须二次确认；
 *   - 可选返工流程「使用已有参考图重新生成」是**单独入口**（走 Jellyfish 自己的图片通道），
 *     端点没上线时禁用并如实说明「该能力正在接入」；
 *   - 在途闸门 + 后端幂等键，重复点击不重复提交；
 *   - 停止 = 前端不再开始后续项，已完成的结果与定版状态全部保留；
 *   - 只用已验证的内联链路；出图服务不支持的资产类型（服装）在**提交前**明确拦住并说明原因。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Alert,
  Button,
  Collapse,
  Descriptions,
  Divider,
  Dropdown,
  Empty,
  Input,
  Modal,
  Progress,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import {
  CloseCircleOutlined,
  MoreOutlined,
  PictureOutlined,
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { StudioEntitiesApi } from '../../../../../services/studioEntities'
import { StudioProjectsService } from '../../../../../services/generated'
import { getAssetImagePrompts, saveAssetImagePrompts } from '../../../../../services/llmPipelineApi'
import type { GenerationGateSnapshot } from '../../../components/generationGate'
import { classifyGenerationFailure, failureText } from '../../../components/generationGate'
import type { ProjectSignalAsset } from '../hooks/useProjectStepSignals'
import { getProjectSignalAssetTypeLabel } from '../hooks/useProjectStepSignals'
import { assetPrepInputFromReadiness, resolveAssetPrepStatus } from '../assetPrepStatus'
import {
  ASSET_TYPE_LABEL,
  ASSET_TYPE_ORDER,
  ASPECT_RATIO_OPTIONS,
  DEFAULT_FLOW,
  FLOW_LABEL,
  IMAGES_PER_ASSET,
  REFERENCE_REWORK_UNAVAILABLE_HINT,
  applySelectionAction,
  applyStopToQueue,
  batchActionLabel,
  buildBatchConfirmation,
  buildPrimaryReplaceConfirmation,
  buildAttemptPlan,
  buildRegenerateWithReferenceConfirmation,
  canBatchWithReference,
  canRegenerateWithExistingReference,
  createAssetSubmitGate,
  defaultGenerationSettings,
  describeProgressLines,
  describeSettings,
  describeStopEffect,
  existingImageActionLabel,
  findIdempotentReuse,
  generateActionLabel,
  hasUnsettledTasks,
  isSubmittableAssetType,
  PROMPT_SLOT_BY_ASSET_TYPE,
  orderCardsForDisplay,
  pickResultForAsset,
  planAdoption,
  referenceReworkUnavailableHint,
  requiresPrimaryReplaceConfirmation,
  resolveProductionHeadline,
  resolveResultStatus,
  resolveTaskQueryPatch,
  selectUngenerated,
  supportHint,
  OUTPUT_MODE_STATEMENT,
  SUBMIT_STAGE,
  summarizeSelection,
  summarizeTaskProgress,
  toProductionAssets,
  type AssetSubmitGate,
  type BatchOperation,
  type GenerationSettings,
  type ProductionAsset,
  type ProductionAssetType,
  type ProductionFlow,
  type ProductionTask,
} from './assetProduction'
import {
  BATCH_REFERENCE_FLOW_LABEL,
  buildAspectRatioNotice,
  buildResultKindTag,
  aspectRatioSourceFromStrategy,
  groupAssetsByType,
  resultArtifactCopy,
} from './assetResultKind.ts'
import {
  clearRoundFromStorage,
  getBrowserStorage,
  loadRoundPlan,
  roundStoreKey,
  saveRoundToStorage,
} from './assetRoundStore.ts'
import {
  adoptAssetImageResult,
  createImageSlot,
  fetchReferenceReworkAvailability,
  regenerateWithExistingReference as callReferenceRegenerate,
  findEmptyImageSlot,
  previewAssetImagePrompt,
  previewAssetImagePlan,
  queryAssetImageTask,
  registerExternalImageFile,
  submitAssetImages,
  type AssetImagePlanTargetLike,
  type AssetImageServiceResult,
} from './assetProductionApi'
import { AssetResultCard } from './AssetResultCard'

/** 结果卡片一次最多铺多少张（多了会拖慢页面；其余可点「查看全部结果」）。 */
const MAX_VISIBLE_CARDS = 6
/** 结果仍在生成时的轮询间隔与上限（轮询是只读查询，不产生费用）。 */
const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS = 5 * 60 * 1000
/** 编辑提示词时使用的槽位：**唯一映射**在 assetProduction.PROMPT_SLOT_BY_ASSET_TYPE（有单测）。 */
const PROMPT_CATEGORY_BY_TYPE: Record<ProductionAssetType, string> = PROMPT_SLOT_BY_ASSET_TYPE
/** 道具没有大模型槽位（后端槽位表只定义了人物/场景/服装），只能手工填写。 */
const LLM_PROMPT_SUPPORTED: ProductionAssetType[] = ['character', 'scene', 'costume']

const PROMPT_SOURCE_LABEL: Record<string, string> = {
  saved: '用已保存的提示词',
  template: '用资产描述拼装的提示词',
  request: '用本次编辑的提示词',
}

type AssetProductionAreaProps = {
  projectId?: string
  assets: ProjectSignalAsset[]
  /** 生成状态（是否演练模式 / 模型是否就绪）—— 复用外层同一次取数 */
  gate: GenerationGateSnapshot
  /** 采纳 / 设为定版 / 保存提示词后重算步骤信号 */
  onReload?: () => void
  /** 打开既有资产编辑页（角色 → 项目角色页；其余 → 资产库编辑页） */
  onOpenAssetEditor?: (asset: ProjectSignalAsset, options?: { generate?: boolean }) => void
  /** 大模型批量生成提示词面板（由外层注入，避免重复实现） */
  promptPanel?: ReactNode
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function queuedPlaceholder(asset: ProductionAsset): ProductionTask {
  return {
    key: `${asset.key}#manual`,
    assetKey: asset.key,
    assetId: asset.id,
    assetType: asset.type,
    assetName: asset.name,
    round: 0,
    flow: DEFAULT_FLOW,
    attempt: 0,
    operation: 'regenerate',
    status: 'queued',
    sourceTaskId: '',
    serviceTaskId: '',
    prompt: '',
    outcome: '',
    ossUrl: '',
    imageUrl: '',
    errorMessage: '',
    note: '',
    resultKind: '',
    resultLabel: '',
    aspectRatio: '',
    aspectRatioSource: '',
    adoptedUrl: '',
    adoptedImageId: null,
    isPrimary: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/** 技术详情里的「图片类型」一行：结果标签 + 它是不是本次回包自带的。 */
function buildResultKindLabel(task: ProductionTask): string {
  const tag = buildResultKindTag(task.assetType, {
    resultKind: task.resultKind,
    resultLabel: task.resultLabel,
  })
  return tag.fromServer ? `${tag.label}（本次回包自带）` : `${tag.label}（按资产类型）`
}

/** 表格行 → 步骤信号资产（仅用于跳转资产编辑页）。 */
function toSignalAsset(asset: ProductionAsset): ProjectSignalAsset {
  return {
    id: asset.id,
    name: asset.name,
    type: asset.type,
    hasImage: asset.hasImage,
    thumbnail: asset.thumbnail,
    hasPrimary: asset.hasPrimary,
    imageId: asset.imageId,
    hasImagePrompt: asset.hasImagePrompt,
    hasPendingCandidate: asset.hasPendingCandidate,
  }
}

export function AssetProductionArea(props: AssetProductionAreaProps) {
  const { projectId, assets, gate, onReload, onOpenAssetEditor, promptPanel } = props
  const navigate = useNavigate()
  const { projectId: routeProjectId } = useParams<{ projectId: string }>()
  const [searchParams] = useSearchParams()
  const effectiveProjectId = projectId || routeProjectId || ''
  /** 当前集（第 2 步是集级页面）：本地恢复按 `project_id + chapter_id` 分键 */
  const chapterId = searchParams.get('chapter') ?? ''

  const productionAssets = useMemo(() => toProductionAssets(assets), [assets])
  const assetByKey = useMemo(() => {
    const map = new Map<string, ProductionAsset>()
    productionAssets.forEach((asset) => map.set(asset.key, asset))
    return map
  }, [productionAssets])

  const [tab, setTab] = useState<ProductionAssetType>('character')
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [settings, setSettings] = useState<GenerationSettings>(() => defaultGenerationSettings())
  const [tasks, setTasks] = useState<ProductionTask[]>([])
  const [running, setRunning] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [busyKeys, setBusyKeys] = useState<string[]>([])
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({})
  const [promptEditorKey, setPromptEditorKey] = useState('')
  const [promptSlotDrafts, setPromptSlotDrafts] = useState<Record<string, string>>({})
  const [promptSlotLoading, setPromptSlotLoading] = useState(false)
  const [promptSaving, setPromptSaving] = useState(false)
  const [promptGenerating, setPromptGenerating] = useState(false)
  const [detailTask, setDetailTask] = useState<ProductionTask | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [planError, setPlanError] = useState('')
  const [planWarnings, setPlanWarnings] = useState<string[]>([])
  const [planTargetsByType, setPlanTargetsByType] = useState<Record<string, AssetImagePlanTargetLike[]>>({})
  /** 只读计划里的分流口径（`strategy`）：结果类型标签、画幅来源、模板名 */
  const [planStrategyByType, setPlanStrategyByType] = useState<Record<string, Record<string, unknown>>>({})
  const [showAllCards, setShowAllCards] = useState(false)
  /** 可选返工流程「使用已有参考图重新生成」的可用性（端点没上线 → 禁用 + 如实说明） */
  const [reworkAvailability, setReworkAvailability] = useState<{
    available: boolean
    reason: string
    reasonCode: 'available' | 'not_deployed' | 'unknown'
  }>({
    available: false,
    reason: REFERENCE_REWORK_UNAVAILABLE_HINT,
    reasonCode: 'not_deployed',
  })
  /** 项目自己的最终视频画幅（`projects.default_video_ratio`）：只用于把人物固定 16:9 说清楚 */
  const [projectVideoRatio, setProjectVideoRatio] = useState('')
  /** 刷新后恢复上次结果时给用户的那句话（只读恢复，绝不会重新提交） */
  const [restoredNote, setRestoredNote] = useState('')

  const stopRef = useRef(false)
  const gateRef = useRef<AssetSubmitGate>(createAssetSubmitGate())
  const roundRef = useRef(0)
  const pollingRef = useRef<Set<string>>(new Set())
  const planCacheRef = useRef<Map<string, AssetImagePlanTargetLike[]>>(new Map())
  /** 每个资产已经尝试过几次（0 = 还没提交过）。重试/重新生成都靠它换一个新的幂等键。 */
  const attemptRef = useRef<Map<string, number>>(new Map())

  /* ------------------------------------------- 本轮结果与进度的本地持久化（D5） */

  /** 存储键：`project_id + chapter_id` 分键（换项目 / 换集互不串）。 */
  const roundKey = roundStoreKey(effectiveProjectId, chapterId)
  /** 已经为哪个键做过恢复（避免用户改过列表后被重复覆盖）。 */
  const restoredKeyRef = useRef('')

  /**
   * 刷新后**只读恢复**本轮结果与进度。
   *
   * 只做三件事：读存、校验、把在途状态标成"已停止"。这里**没有**任何提交/轮询调用，
   * `planRoundRestore` 也恒定返回 `shouldSubmit: false` —— 刷新一次不会重复计费。
   */
  useEffect(() => {
    if (!effectiveProjectId) return
    if (restoredKeyRef.current === roundKey) return
    restoredKeyRef.current = roundKey
    const plan = loadRoundPlan(getBrowserStorage(), roundKey, { projectId: effectiveProjectId, chapterId })
    if (plan.shouldSubmit) return
    setTasks(plan.tasks)
    setRestoredNote(plan.note)
  }, [chapterId, effectiveProjectId, roundKey])

  /** 结果变化就落盘（空列表 = 清掉，不留下空壳）。 */
  useEffect(() => {
    if (!effectiveProjectId) return
    if (restoredKeyRef.current !== roundKey) return
    saveRoundToStorage(getBrowserStorage(), roundKey, {
      projectId: effectiveProjectId,
      chapterId,
      tasks,
    })
  }, [chapterId, effectiveProjectId, roundKey, tasks])

  /** 项目自己的最终视频画幅：只读一次，用来把「人物参考图固定 16:9」和成片画幅分清楚。 */
  useEffect(() => {
    if (!effectiveProjectId) return
    let cancelled = false
    void (async () => {
      try {
        const res = await StudioProjectsService.getProjectApiV1StudioProjectsProjectIdGet({
          projectId: effectiveProjectId,
        })
        const ratio = (res?.data as { default_video_ratio?: string | null } | undefined)?.default_video_ratio
        if (!cancelled) setProjectVideoRatio(typeof ratio === 'string' ? ratio.trim() : '')
      } catch {
        // 读不到就只写人物固定口径那一半，不编一个项目画幅出来
        if (!cancelled) setProjectVideoRatio('')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [effectiveProjectId])

  // 资产清单变化（例如刚采纳完）时重建默认勾选：**仍然只勾未生成项**
  const assetsFingerprint = productionAssets.map((asset) => `${asset.key}:${asset.hasImage ? 1 : 0}`).join('|')
  useEffect(() => {
    setSelectedKeys(selectUngenerated(productionAssets))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetsFingerprint])

  const tabAssets = useMemo(() => productionAssets.filter((asset) => asset.type === tab), [productionAssets, tab])
  const scope = useMemo(() => summarizeSelection(productionAssets, selectedKeys), [productionAssets, selectedKeys])
  const progress = useMemo(() => summarizeTaskProgress(tasks), [tasks])
  /**
   * 「已就绪」的资产数：判定口径与外层步骤摘要**完全一致**
   * （`resolveAssetPrepStatus`：有提示词 + 有图片 + 已定版），
   * 否则会出现「本区说已定版、顶部摘要说未就绪」这种自相矛盾的说法。
   */
  const readyCount = useMemo(
    () =>
      productionAssets.filter(
        (asset) =>
          resolveAssetPrepStatus(
            assetPrepInputFromReadiness({
              has_pending_candidate: asset.hasPendingCandidate,
              has_image_prompt: asset.hasImagePrompt,
              has_image: asset.hasImage,
              has_primary: asset.hasPrimary,
            }),
          ).key === 'done',
      ).length,
    [productionAssets],
  )
  const headline = useMemo(
    () => resolveProductionHeadline({ assets: productionAssets, progress, readyCount }),
    [productionAssets, progress, readyCount],
  )
  const runtimeMode: 'dry_run' | 'real' = gate.dryRun === false ? 'real' : 'dry_run'
  // 生成配置提示：**只说用户能理解的**（不出现模型名、供应商名、原始状态值）
  const imageModelState = gate.models.image.state
  // 结果卡片顺序：已停止的排到最后（停止后先看到的仍是已完成结果），默认只展示最近 6 张
  const visibleCards = useMemo(
    () => orderCardsForDisplay(tasks, { showAll: showAllCards, maxVisible: MAX_VISIBLE_CARDS }),
    [showAllCards, tasks],
  )
  const unsettled = hasUnsettledTasks(tasks)
  const busyNow = running || preparing || unsettled

  /* --------------------------------------------------------- 出图计划（只读） */

  const loadPlan = useCallback(
    async (assetType: ProductionAssetType): Promise<AssetImagePlanTargetLike[]> => {
      if (!effectiveProjectId || !isSubmittableAssetType(assetType)) return []
      // 计划缓存键里带上比例：换了比例就要重新取计划（出图方式固定，不参与缓存键）
      const cacheKey = `${assetType}:${SUBMIT_STAGE}:${settings.aspectRatio}`
      const cached = planCacheRef.current.get(cacheKey)
      if (cached) return cached
      setPlanLoading(true)
      setPlanError('')
      try {
        // 只读计划：按提示词直接生成，**不把已有图片当输入**（见 assetProduction.SUBMIT_STAGE 注释）
        const data = await previewAssetImagePlan({
          project_id: effectiveProjectId,
          asset_type: assetType as 'character' | 'scene' | 'prop',
          aspect_ratio: settings.aspectRatio,
        })
        const targets = Array.isArray(data?.targets) ? data.targets : []
        planCacheRef.current.set(cacheKey, targets)
        setPlanTargetsByType((prev) => ({ ...prev, [cacheKey]: targets }))
        // 分流口径（结果类型标签 / 画幅来源 / 模板名）也存下来：页面据它把"这次生成的是什么图"说清
        setPlanStrategyByType((prev) => ({
          ...prev,
          [cacheKey]: (data?.strategy ?? {}) as Record<string, unknown>,
        }))
        setPlanWarnings(Array.isArray(data?.warnings) ? data.warnings : [])
        return targets
      } catch (error) {
        setPlanError(error instanceof Error ? error.message : '出图计划读取失败')
        return []
      } finally {
        setPlanLoading(false)
      }
    },
    [effectiveProjectId, settings],
  )

  const planTargetForAsset = useCallback(
    (asset: ProductionAsset, targets: AssetImagePlanTargetLike[]): AssetImagePlanTargetLike | undefined =>
      targets.find((target) => target.source_asset_id === asset.id),
    [],
  )

  const planKeyFor = (assetType: ProductionAssetType) =>
    `${assetType}:${SUBMIT_STAGE}:${settings.aspectRatio}`
  const currentPlanTargets = planTargetsByType[planKeyFor(tab)] ?? []
  const currentPlanStrategy = planStrategyByType[planKeyFor(tab)] ?? {}

  /** 当前页签的结果文案（结果类型标签 / 按钮名 / 说明都按类型取） */
  const tabCopy = resultArtifactCopy(tab)

  /**
   * **人物参考图固定 16:9，不等于项目最终视频画幅**（用户点名要写在页面上）。
   *
   * 只在「本次是人物 + 画幅来自人物固定口径」时出现；同时给出项目自己的成片画幅，
   * 两个值不同时一眼就能看出区别。
   */
  const tabRatioNotice = buildAspectRatioNotice({
    assetTypes: [tab],
    projectRatio: projectVideoRatio,
    source: aspectRatioSourceFromStrategy(currentPlanStrategy),
    ratio: typeof currentPlanStrategy.aspect_ratio === 'string' ? currentPlanStrategy.aspect_ratio : null,
  })

  /** 选中项里可直接出图的部分（服装不在出图服务契约内） */
  const pickedAssets = useMemo(
    () => scope.assets.filter((asset) => isSubmittableAssetType(asset.type)),
    [scope],
  )
  /** 批量生成的**按类型分组**（混选时必须分组提交，不能混成同一批同一个口径） */
  const pickedGroups = useMemo(() => groupAssetsByType(pickedAssets), [pickedAssets])
  /** 已有图片、可以"再生成一张"的选中项 */
  const pickedRegenerateAssets = useMemo(() => pickedAssets.filter((asset) => asset.hasImage), [pickedAssets])
  /** 某个类型的只读计划里的分流口径（提交时用它给"画幅来源"兜底） */
  const strategyForType = useCallback(
    (assetType: ProductionAssetType): Record<string, unknown> =>
      planStrategyByType[`${assetType}:${SUBMIT_STAGE}:${settings.aspectRatio}`] ?? {},
    [planStrategyByType, settings.aspectRatio],
  )

  /** 返工能力在**当前页签类型**下的如实说明（端点没上线时按类型取词，不让场景说"参考图"） */
  const reworkHintFor = useCallback(
    (assetType: ProductionAssetType): string => {
      if (reworkAvailability.available) return ''
      if (reworkAvailability.reasonCode === 'not_deployed') return referenceReworkUnavailableHint(assetType)
      return reworkAvailability.reason || referenceReworkUnavailableHint(assetType)
    },
    [reworkAvailability],
  )

  useEffect(() => {
    planCacheRef.current.clear()
    setPlanTargetsByType({})
    setPlanStrategyByType({})
  }, [settings.aspectRatio])

  useEffect(() => {
    if (tabAssets.length > 0 && isSubmittableAssetType(tab)) void loadPlan(tab)
  }, [loadPlan, tab, tabAssets.length])

  // 返工能力的可用性：只读读一次接口清单，**绝不**用"试着调一次"来探测（那会真的出图花钱）
  useEffect(() => {
    let cancelled = false
    void fetchReferenceReworkAvailability().then((state) => {
      if (!cancelled) setReworkAvailability(state)
    })
    return () => {
      cancelled = true
    }
  }, [])

  /* -------------------------------------------------------------- 任务更新 */

  const updateTask = useCallback((key: string, patch: Partial<ProductionTask>) => {
    setTasks((prev) => prev.map((task) => (task.key === key ? { ...task, ...patch, updatedAt: Date.now() } : task)))
  }, [])

  const setBusy = useCallback((key: string, busy: boolean) => {
    setBusyKeys((prev) => (busy ? Array.from(new Set([...prev, key])) : prev.filter((item) => item !== key)))
  }, [])

  /* ---------------------------------------------------------------- 结果轮询 */

  const pollTask = useCallback(
    async (taskKey: string, serviceTaskId: string) => {
      if (!serviceTaskId || pollingRef.current.has(taskKey)) return
      pollingRef.current.add(taskKey)
      const deadline = Date.now() + POLL_TIMEOUT_MS
      try {
        while (Date.now() < deadline) {
          // 停止后不再继续轮询（已完成的结果一个都不丢，也可以随时点「刷新进度」）
          if (stopRef.current) return
          // eslint-disable-next-line no-await-in-loop
          await sleep(POLL_INTERVAL_MS)
          try {
            // eslint-disable-next-line no-await-in-loop
            const query = await queryAssetImageTask(serviceTaskId)
            const patch = resolveTaskQueryPatch(query)
            if (patch) updateTask(taskKey, patch)
            if (patch && patch.status !== 'generating') return
          } catch {
            return
          }
        }
      } finally {
        pollingRef.current.delete(taskKey)
      }
    },
    [updateTask],
  )

  const refreshTask = useCallback(
    async (task: ProductionTask) => {
      if (!task.serviceTaskId) {
        message.info('这一项还没有可查询的任务（演练模式不会创建真实任务）。')
        return
      }
      setBusy(task.key, true)
      try {
        const query = await queryAssetImageTask(task.serviceTaskId)
        const patch = resolveTaskQueryPatch(query)
        if (patch) updateTask(task.key, patch)
      } catch (error) {
        message.error(error instanceof Error ? error.message : '查询任务失败')
      } finally {
        setBusy(task.key, false)
      }
    },
    [setBusy, updateTask],
  )

  /* ------------------------------------------------------------ 提交一轮任务 */

  const submitRound = useCallback(
    async (
      operation: BatchOperation,
      targets: ProductionAsset[],
      planByType: Map<string, AssetImagePlanTargetLike[]>,
      options?: {
        /**
         * 走哪条流程：默认「生成参考图」；`regenerate_with_existing_reference` 是
         * **可选返工流程**（使用已有参考图重新生成，单独入口 + 二次确认）。
         */
        flow?: ProductionFlow
        /**
         * 强制按"再来一次"处理（失败项重试用）。
         *
         * 失败项所在的资产可能还没有图片，单看 `hasImage` 会误判成首轮 →
         * 尝试序号不加 → 幂等键不变 → 出图服务把上次那条**失败**任务原样还回来，
         * 用户看到的就是"点了重试但什么也没发生"。
         */
        forceRetry?: boolean
      },
    ): Promise<void> => {
      if (!effectiveProjectId) return
      const flow: ProductionFlow = options?.flow ?? DEFAULT_FLOW
      stopRef.current = false
      roundRef.current += 1
      const round = roundRef.current
      setRunning(true)
      // 先把整轮排进队列：进度里的「排队中」是真实状态，不是装饰
      const queued: ProductionTask[] = targets.map((asset, index) => ({
        ...queuedPlaceholder(asset),
        key: `${asset.key}#${round}-${index}`,
        round,
        flow,
        operation: asset.hasImage ? 'regenerate' : operation,
        status: 'queued',
      }))
      setTasks((prev) => [...prev, ...queued])

      let reused = 0
      for (let index = 0; index < targets.length; index += 1) {
        const asset = targets[index]
        const taskKey = queued[index].key
        if (stopRef.current) break
        const decision = gateRef.current.begin(asset.key)
        if (!decision.allowed) {
          updateTask(taskKey, { status: 'stopped', errorMessage: decision.message })
          continue
        }
        const planTarget = planTargetForAsset(asset, planByType.get(asset.type) ?? [])
        const edited = String(promptDrafts[asset.key] ?? '').trim()
        const basePrompt = edited || String(planTarget?.prompt ?? '')
        // 「重新生成 / 重试」靠**尝试序号**拿到新的幂等键：提示词保持原样，
        // 后端会把序号混进哈希，出图服务因此会真的再出一张（而不是返回上一次的结果）。
        const previousAttempt = attemptRef.current.get(asset.key) ?? 0
        const isRetryRound = asset.hasImage || operation === 'regenerate' || options?.forceRetry === true
        const attemptPlan = buildAttemptPlan(basePrompt, {
          hasEditedPrompt: Boolean(edited),
          previousAttempt: isRetryRound ? previousAttempt : 0,
        })
        const promptOverride = attemptPlan.prompt
        const overrideNeeded = Boolean(promptOverride) && promptOverride !== String(planTarget?.prompt ?? '')
        if (
          // 只有首轮（序号 0）才可能与只读计划里的幂等键相同：
          // 重试 / 重新生成的序号 > 0，键一定不同，不能误报"复用了已有结果"。
          attemptPlan.attempt === 0 &&
          planTarget?.source_task_id &&
          !overrideNeeded &&
          findIdempotentReuse(gateRef.current.submittedKeys(), planTarget.source_task_id)
        ) {
          // 同一提示词已经提交过：出图服务会直接返回已有结果（不重复生成、不重复计费）
          reused += 1
        }
        updateTask(taskKey, {
          status: 'submitting',
          attempt: attemptPlan.attempt,
          prompt: promptOverride || String(planTarget?.prompt ?? ''),
          sourceTaskId: String(planTarget?.source_task_id ?? ''),
        })
        try {
          // eslint-disable-next-line no-await-in-loop
          const response = await submitAssetImages({
            project_id: effectiveProjectId,
            asset_type: asset.type as 'character' | 'scene' | 'prop',
            asset_ids: [asset.id],
            aspect_ratio: settings.aspectRatio,
            prompt_overrides: overrideNeeded ? [{ asset_id: asset.id, prompt: promptOverride }] : [],
            // 0 = 首轮；>0 = 重试/重新生成（换一个新的幂等键，才会真的再出一张）
            attempt: attemptPlan.attempt,
          })
          const result: AssetImageServiceResult | null = pickResultForAsset(
            Array.isArray(response?.results) ? response.results : [],
            asset.id,
          )
          // 记下"已经尝试过几次"（本次序号 + 1），下一次重试/重新生成就会换一个新的幂等键
          attemptRef.current.set(asset.key, attemptPlan.attempt + 1)
          gateRef.current.finish(asset.key, String(result?.source_task_id ?? planTarget?.source_task_id ?? ''))
          if (!result) {
            updateTask(taskKey, {
              status: 'failed',
              errorMessage: '出图服务没有返回这一项的结果，请打开「查看详情」核对该次响应。',
            })
            continue
          }
          const normalized = resolveResultStatus(result, asset.type)
          updateTask(taskKey, {
            status: normalized.status,
            outcome: normalized.outcome,
            serviceTaskId: normalized.serviceTaskId,
            ossUrl: normalized.ossUrl,
            imageUrl: normalized.imageUrl,
            sourceTaskId: normalized.sourceTaskId || String(planTarget?.source_task_id ?? ''),
            prompt: promptOverride || String(planTarget?.prompt ?? ''),
            // 结果类型标签与画幅**按回包**记下来（卡片显示 / 技术详情都读它）
            resultKind: normalized.resultKind,
            resultLabel: normalized.resultLabel,
            aspectRatio: normalized.aspectRatio || String(planTarget?.aspect_ratio ?? ''),
            aspectRatioSource:
              normalized.aspectRatioSource ||
              aspectRatioSourceFromStrategy(strategyForType(asset.type)),
            errorMessage: normalized.status === 'failed' ? normalized.reason : '',
            note: normalized.status === 'failed' ? '' : normalized.reason,
          })
          if (normalized.status === 'generating' && normalized.serviceTaskId) {
            void pollTask(taskKey, normalized.serviceTaskId)
          }
        } catch (error) {
          gateRef.current.release(asset.key)
          const failure = classifyGenerationFailure(error, 'image')
          updateTask(taskKey, { status: 'failed', errorMessage: failureText(failure), note: '' })
        }
      }
      if (reused > 0) {
        message.info(
          `有 ${reused} 项用的是同一个提示词、之前已经提交过：出图服务直接复用了已有结果，没有重复生成。想出一张新的图请用「重新生成」。`,
        )
      }
      setRunning(false)
    },
    [effectiveProjectId, planTargetForAsset, pollTask, promptDrafts, settings, strategyForType, updateTask],
  )

  /** 取只读计划（不触网、不花钱），供确认框与提交时的提示词/幂等键使用。 */
  const preparePlans = useCallback(
    async (picked: ProductionAsset[]): Promise<Map<string, AssetImagePlanTargetLike[]>> => {
      const planByType = new Map<string, AssetImagePlanTargetLike[]>()
      setPreparing(true)
      try {
        for (const type of Array.from(new Set(picked.map((asset) => asset.type)))) {
          // eslint-disable-next-line no-await-in-loop
          const targets = await loadPlan(type)
          planByType.set(type, targets)
        }
      } finally {
        setPreparing(false)
      }
      return planByType
    },
    [loadPlan],
  )

  /**
   * 提交一次返工（可选流程）：走 `/image-pipeline/reference-regenerate`。
   *
   * 复用同一套任务队列/卡片/进度/轮询，只是端点与流程名不同——不另造第二套生成逻辑。
   */
  const submitReferenceRework = useCallback(
    async (asset: ProductionAsset) => {
      if (!effectiveProjectId) return
      stopRef.current = false
      roundRef.current += 1
      const round = roundRef.current
      const taskKey = `${asset.key}#${round}-rework`
      const edited = String(promptDrafts[asset.key] ?? '').trim()
      const previousAttempt = attemptRef.current.get(asset.key) ?? 0
      const attemptPlan = buildAttemptPlan(edited, {
        hasEditedPrompt: Boolean(edited),
        previousAttempt,
      })
      setTasks((prev) => [
        ...prev,
        {
          ...queuedPlaceholder(asset),
          key: taskKey,
          round,
          flow: 'regenerate_with_existing_reference',
          operation: 'regenerate',
          status: 'submitting',
          attempt: attemptPlan.attempt,
          prompt: attemptPlan.prompt,
        },
      ])
      const decision = gateRef.current.begin(asset.key)
      if (!decision.allowed) {
        updateTask(taskKey, { status: 'stopped', errorMessage: decision.message })
        return
      }
      setRunning(true)
      try {
        const response = await callReferenceRegenerate({
          project_id: effectiveProjectId,
          asset_type: asset.type,
          asset_id: asset.id,
          prompt: attemptPlan.prompt || undefined,
          reference_image_id: asset.imageId ?? null,
          target_ratio: settings.aspectRatio,
          attempt: attemptPlan.attempt,
        })
        attemptRef.current.set(asset.key, attemptPlan.attempt + 1)
        const result = pickResultForAsset(Array.isArray(response?.results) ? response.results : [], asset.id)
        gateRef.current.finish(asset.key, String(result?.source_task_id ?? response?.source_task_id ?? ''))
        if (!result) {
          updateTask(taskKey, {
            status: 'failed',
            errorMessage: '这次没有返回结果，请打开「查看详情」核对该次响应。',
          })
          return
        }
        const copy = resultArtifactCopy(asset.type)
        const normalized = resolveResultStatus(result, asset.type)
        const referenceNote = response?.reference_label
          ? `${copy.existingImageAction}：${copy.existingImageInputLabel} = ${response.reference_label}`
          : `${copy.existingImageAction}：${copy.existingImageInputLabel} = 该资产已有的图片`
        updateTask(taskKey, {
          status: normalized.status,
          outcome: normalized.outcome,
          serviceTaskId: normalized.serviceTaskId,
          ossUrl: normalized.ossUrl,
          imageUrl: normalized.imageUrl,
          sourceTaskId: normalized.sourceTaskId || String(response?.source_task_id ?? ''),
          prompt: attemptPlan.prompt || String(response?.prompt ?? ''),
          // 返工流程的回包同样带 result_kind / result_label / aspect_ratio（与默认主流程同形）
          resultKind: normalized.resultKind || String(response?.result_kind ?? ''),
          resultLabel: normalized.resultLabel || String(response?.result_label ?? ''),
          aspectRatio: normalized.aspectRatio || String(response?.aspect_ratio ?? ''),
          aspectRatioSource: normalized.aspectRatioSource || String(response?.aspect_ratio_source ?? ''),
          errorMessage: normalized.status === 'failed' ? normalized.reason : '',
          note: normalized.status === 'failed' ? '' : `${referenceNote}；${normalized.reason}`.replace(/；$/, ''),
        })
        if (normalized.status === 'generating' && normalized.serviceTaskId) {
          void pollTask(taskKey, normalized.serviceTaskId)
        }
      } catch (error) {
        gateRef.current.release(asset.key)
        const failure = classifyGenerationFailure(error, 'image')
        updateTask(taskKey, { status: 'failed', errorMessage: failureText(failure), note: '' })
      } finally {
        setRunning(false)
      }
    },
    [effectiveProjectId, pollTask, promptDrafts, settings.aspectRatio, updateTask],
  )

  /* ----------------------------------------------------------- 单项生成/重生成 */

  const submitSingle = useCallback(
    async (asset: ProductionAsset) => {
      if (!isSubmittableAssetType(asset.type)) {
        Modal.warning({
        title: `暂时不能${generateActionLabel(asset.type)}`,
        content: supportHint(asset.type),
        okText: '知道了',
      })
        return
      }
      const planByType = await preparePlans([asset])
      const singleScope = summarizeSelection(productionAssets, [asset.key])
      const confirmation = buildBatchConfirmation({
        scope: singleScope,
        settings,
        mode: runtimeMode,
        operation: 'generate',
        projectVideoRatio,
        aspectRatioSource: aspectRatioSourceFromStrategy(strategyForType(asset.type)),
        aspectRatioValue:
          typeof strategyForType(asset.type).aspect_ratio === 'string'
            ? String(strategyForType(asset.type).aspect_ratio)
            : null,
      })
      if (confirmation.blocked) {
        Modal.warning({ title: confirmation.title, content: confirmation.blockedReason, okText: '知道了' })
        return
      }
      const proceed = () => {
        void submitRound('generate', [asset], planByType)
      }
      if (!confirmation.required) {
        proceed()
        return
      }
      Modal.confirm({
        title: confirmation.title,
        width: 520,
        okText: confirmation.okText,
        cancelText: confirmation.cancelText,
        content: <ConfirmationBody lines={confirmation.lines} costWarning={confirmation.costWarning} mode={runtimeMode} />,
        onOk: proceed,
      })
    },
    [preparePlans, productionAssets, projectVideoRatio, runtimeMode, settings, strategyForType, submitRound],
  )

  const regenerateOne = useCallback(
    async (asset: ProductionAsset) => {
      if (!isSubmittableAssetType(asset.type)) {
        Modal.warning({
        title: `暂时不能${generateActionLabel(asset.type, 'regenerate')}`,
        content: supportHint(asset.type),
        okText: '知道了',
      })
        return
      }
      const planByType = await preparePlans([asset])
      const scopeForOne = summarizeSelection(productionAssets, [asset.key])
      const confirmation = buildBatchConfirmation({
        scope: scopeForOne,
        settings,
        mode: runtimeMode,
        operation: 'regenerate',
        projectVideoRatio,
        aspectRatioSource: aspectRatioSourceFromStrategy(strategyForType(asset.type)),
        aspectRatioValue:
          typeof strategyForType(asset.type).aspect_ratio === 'string'
            ? String(strategyForType(asset.type).aspect_ratio)
            : null,
      })
      if (confirmation.blocked) {
        Modal.warning({ title: confirmation.title, content: confirmation.blockedReason, okText: '知道了' })
        return
      }
      Modal.confirm({
        title: `重新生成「${asset.name}」的${resultArtifactCopy(asset.type).noun}？`,
        width: 560,
        okText: confirmation.okText,
        cancelText: confirmation.cancelText,
        content: <ConfirmationBody lines={confirmation.lines} costWarning={confirmation.costWarning} mode={runtimeMode} />,
        onOk: () => {
          void submitRound('regenerate', [asset], planByType)
        },
      })
    },
    [preparePlans, productionAssets, projectVideoRatio, runtimeMode, settings, strategyForType, submitRound],
  )

  /**
   * **可选返工流程**：用该资产已有的图片重新生成（单独入口 + 二次确认）。
   *
   * 与默认主流程的区别（用户明确要求分清）：
   * - 默认主流程走 `/image-pipeline/submit`（上游服务端点，按提示词直接生成，**不传已有图片**）；
   * - 本流程走 `/image-pipeline/reference-regenerate`（Jellyfish 自己的图片通道，
   *   把该资产**已有的图片**真的传进请求），**只在该资产已有图片时可用**；
   * - 端点还没上线时**禁用并如实说明「该能力正在接入」**，不假装可用；
   * - 文案**按资产类型取词**：人物叫参考图，场景 / 道具 / 服装用各自的图名。
   */
  const regenerateWithExistingReference = useCallback(
    async (asset: ProductionAsset) => {
      const copy = resultArtifactCopy(asset.type)
      if (!canRegenerateWithExistingReference(asset)) {
        Modal.warning({
          title: '这一项还不能这样重生成',
          content: `该资产还没有${copy.noun}：请先用默认流程「${copy.generateAction}」出一张，再考虑用它保一致性。`,
          okText: '知道了',
        })
        return
      }
      if (!reworkAvailability.available) {
        Modal.warning({
          title: '该能力正在接入',
          content: reworkHintFor(asset.type),
          okText: '知道了',
        })
        return
      }
      const referenceLabel = asset.hasPrimary ? '该资产当前的定版图片' : '该资产当前的首选图片'
      const confirmation = buildRegenerateWithReferenceConfirmation({
        assetName: asset.name,
        referenceLabel,
        mode: runtimeMode,
        assetType: asset.type,
      })
      Modal.confirm({
        title: confirmation.title,
        width: 560,
        okText: confirmation.okText,
        cancelText: confirmation.cancelText,
        content: (
          <div className="space-y-2">
            {asset.thumbnail ? (
              <div className="flex items-center gap-2 rounded border border-slate-200 p-2">
                <img src={asset.thumbnail} alt={asset.name} className="h-14 w-14 rounded object-cover" />
                <span className="text-[11px] text-slate-500">
                  {`${copy.existingImageInputLabel}（${referenceLabel}）`}
                </span>
              </div>
            ) : null}
            <ul className="list-disc pl-5 text-xs leading-5">
              {confirmation.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <Alert
              type={runtimeMode === 'real' ? 'warning' : 'info'}
              showIcon
              message={<span className="text-xs">{confirmation.costWarning}</span>}
            />
          </div>
        ),
        onOk: () => {
          void submitReferenceRework(asset)
        },
      })
    },
    [reworkAvailability, reworkHintFor, runtimeMode, submitReferenceRework],
  )

  const retryTask = useCallback(
    async (task: ProductionTask) => {
      const asset = assetByKey.get(task.assetKey)
      if (!asset) return
      if (!isSubmittableAssetType(asset.type)) {
        Modal.warning({ title: '这一项不能重试', content: supportHint(asset.type), okText: '知道了' })
        return
      }
      const planByType = await preparePlans([asset])
      Modal.confirm({
        title: `重试「${asset.name}」这一项？`,
        width: 560,
        okText: runtimeMode === 'real' ? '确认真实生成' : '确认重试',
        cancelText: '取消',
        content: (
          <div className="space-y-2">
            <div className="text-xs">
              只重试这一项，不影响其它结果；会用同一条提示词再生成一次（会拿到一个新的任务，
              不会把上一次的失败结果直接还给你）。
            </div>
            <Alert
              type={runtimeMode === 'real' ? 'warning' : 'info'}
              showIcon
              message={
                <span className="text-xs">
                  {runtimeMode === 'real'
                    ? '当前是真实模式：重试同样会产生真实费用。'
                    : '当前是演练模式：不产生费用，返回的是占位结果。'}
                </span>
              }
            />
          </div>
        ),
        onOk: () => {
          void submitRound('generate', [asset], planByType, { forceRetry: true })
        },
      })
    },
    [assetByKey, preparePlans, runtimeMode, submitRound],
  )

  /* ------------------------------------------------------- 批量生成 / 重新生成 */

  const startBatch = useCallback(
    async (operation: BatchOperation) => {
      if (busyNow) {
        message.info('本轮还在进行中；要中断后续请点「停止后续」。')
        return
      }
      const picked = scope.assets.filter((asset) => isSubmittableAssetType(asset.type))
      const groups = groupAssetsByType(picked)
      const ratioStrategy = strategyForType(picked[0]?.type ?? tab)
      const confirmationInput = {
        scope,
        settings,
        mode: runtimeMode,
        operation,
        // 人物固定 16:9 那句话要同时给出项目自己的成片画幅
        projectVideoRatio,
        aspectRatioSource: aspectRatioSourceFromStrategy(ratioStrategy),
        aspectRatioValue: typeof ratioStrategy.aspect_ratio === 'string' ? String(ratioStrategy.aspect_ratio) : null,
      }
      if (picked.length === 0) {
        const blocked = buildBatchConfirmation(confirmationInput)
        Modal.warning({ title: blocked.title, content: blocked.blockedReason, okText: '知道了' })
        return
      }
      const planByType = await preparePlans(picked)
      const confirmation = buildBatchConfirmation(confirmationInput)
      if (confirmation.blocked) {
        Modal.warning({ title: confirmation.title, content: confirmation.blockedReason, okText: '知道了' })
        return
      }
      /**
       * **按 asset_type 分组提交**（用户点名）。
       *
       * 出图提交接口一次只接受一个 asset_type，所以混选时逐组提交（每组自己一轮、自己的结果类型标签），
       * 而不是把人物 / 场景 / 道具混成一批当成同一种类型处理。
       */
      const proceed = () => {
        void (async () => {
          for (const group of groups) {
            // eslint-disable-next-line no-await-in-loop
            await submitRound(operation, group.items, planByType)
          }
        })()
      }
      // 一次点击只产生一轮任务：不确认就绝不提交
      if (!confirmation.required) {
        proceed()
        return
      }
      Modal.confirm({
        title: confirmation.title,
        width: 580,
        okText: confirmation.okText,
        cancelText: confirmation.cancelText,
        content: <ConfirmationBody lines={confirmation.lines} costWarning={confirmation.costWarning} mode={runtimeMode} />,
        onOk: proceed,
      })
    },
    [busyNow, preparePlans, projectVideoRatio, runtimeMode, scope, settings, strategyForType, submitRound, tab],
  )

  const handleStop = () => {
    stopRef.current = true
    const next = applyStopToQueue(tasks)
    setTasks(next)
    message.info(describeStopEffect(summarizeTaskProgress(next)))
  }

  /* -------------------------------------------------------------------- 采纳 */

  const adoptTask = useCallback(
    async (task: ProductionTask, options?: { silent?: boolean }): Promise<number | null> => {
      const asset = assetByKey.get(task.assetKey)
      if (!asset) return null
      const url = task.ossUrl || task.imageUrl
      setBusy(task.key, true)
      try {
        const emptySlotId = asset.hasImage ? await findEmptyImageSlot(asset.type, asset.id) : null
        const plan = planAdoption({ asset, url, emptySlotId })
        if (plan.mode === 'blocked') {
          Modal.warning({ title: '暂时不能采纳', content: plan.reason, okText: '知道了' })
          return null
        }
        if (plan.mode === 'adopt') {
          const adopted = await adoptAssetImageResult({
            entity_type: asset.type,
            entity_id: asset.id,
            url,
            image_id: plan.imageId,
            // 采纳**不动定版**：定版必须由用户单独确认（硬边界 B）
            set_primary: false,
            name: `${asset.name} 生成图`,
          })
          updateTask(task.key, { adoptedUrl: adopted.url, adoptedImageId: adopted.image_id, isPrimary: false })
          if (!options?.silent) {
            message.success(`已保存进「${asset.name}」的图片（定版图没有改动）`)
            if (Array.isArray(adopted.warnings) && adopted.warnings.length > 0) {
              Modal.info({
                title: '已入库，但有需要你知道的提醒',
                content: (
                  <ul className="list-disc pl-5 text-xs">
                    {adopted.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                ),
              })
            }
          }
          onReload?.()
          return adopted.image_id
        }
        // 新增一张图片（该资产已有图片且没有空槽位）：绝不覆盖现有图片/定版图
        const file = await registerExternalImageFile({
          url,
          name: `${asset.name} 生成图`,
          project_id: effectiveProjectId || null,
          usage_kind: 'asset_image',
        })
        const slot = await createImageSlot(asset.type, asset.id, String(file.id))
        updateTask(task.key, {
          adoptedUrl: String(file.thumbnail || url),
          adoptedImageId: slot.id,
          isPrimary: false,
        })
        if (!options?.silent) {
          message.success(`已为「${asset.name}」新增一张图片（现有图片与定版图都保持不变）`)
        }
        onReload?.()
        return slot.id
      } catch (error) {
        const failure = classifyGenerationFailure(error, 'image')
        message.error(failureText(failure))
        return null
      } finally {
        setBusy(task.key, false)
      }
    },
    [assetByKey, effectiveProjectId, onReload, setBusy, updateTask],
  )

  /* ---------------------------------------------------------------- 设为定版 */

  const setPrimary = useCallback(
    async (task: ProductionTask) => {
      const asset = assetByKey.get(task.assetKey)
      if (!asset) return
      const doIt = async () => {
        let imageId = task.adoptedImageId
        if (imageId === null) imageId = await adoptTask(task, { silent: true })
        if (imageId === null) return
        const targetImageId = imageId
        setBusy(task.key, true)
        /**
         * 写定版。
         *
         * 后端**不静默替换定版**：该资产已有定版图、而本次会把它换成另一张时，
         * 必须显式带 `confirm_replace_primary=true`，否则返回结构化 409（一行都不改）。
         * 所以这里只在「用户已经在确认框里点过」的情况下带这个开关。
         */
        const applyPrimary = (confirmReplace: boolean) =>
          StudioEntitiesApi.updateImage(asset.type, asset.id, targetImageId, {
            is_primary: true,
            confirm_replace_primary: confirmReplace,
          })
        try {
          try {
            await applyPrimary(requiresPrimaryReplaceConfirmation(asset))
          } catch (error) {
            // 数据不同步（例如别处刚改过定版）导致后端拒绝：用后端原文再确认一次，不猜、不静默
            if ((error as { status?: number } | null)?.status !== 409) throw error
            const detail = error instanceof Error ? error.message : '该资产已有定版图，需要你确认后才能替换。'
            await new Promise<void>((resolve, reject) => {
              Modal.confirm({
                title: '该资产已有定版图，确认替换吗？',
                width: 560,
                okText: '确认替换定版',
                cancelText: '取消',
                content: <div className="text-xs">{detail}</div>,
                onOk: () => resolve(),
                onCancel: () => reject(new Error('cancelled')),
              })
            })
            await applyPrimary(true)
          }
          // 同一资产的多张结果里只有用户选中的这张是定版（不做任何静默替换）
          setTasks((prev) =>
            prev.map((item) =>
              item.assetKey === asset.key ? { ...item, isPrimary: item.key === task.key, updatedAt: Date.now() } : item,
            ),
          )
          message.success(`已把这张设为「${asset.name}」的定版图`)
          onReload?.()
        } catch (error) {
          if (error instanceof Error && error.message === 'cancelled') return
          const failure = classifyGenerationFailure(error, 'image')
          message.error(failureText(failure))
        } finally {
          setBusy(task.key, false)
        }
      }
      if (requiresPrimaryReplaceConfirmation(asset)) {
        const confirmation = buildPrimaryReplaceConfirmation({ assetName: asset.name, isFromGeneratedResult: true })
        Modal.confirm({
          title: confirmation.title,
          width: 540,
          okText: '确认替换定版',
          cancelText: '取消',
          content: (
            <div className="space-y-2">
              <ul className="list-disc pl-5 text-xs leading-5">
                {confirmation.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <Alert type="info" showIcon message={<span className="text-xs">{confirmation.costWarning}</span>} />
            </div>
          ),
          onOk: doIt,
        })
        return
      }
      await doIt()
    },
    [adoptTask, assetByKey, onReload, setBusy],
  )

  /* ---------------------------------------------------------------- 编辑提示词 */

  const openPromptEditor = useCallback(
    async (asset: ProductionAsset) => {
      const category = PROMPT_CATEGORY_BY_TYPE[asset.type]
      setPromptEditorKey(asset.key)
      setPromptSlotDrafts({ [category]: promptDrafts[asset.key] ?? '' })
      setPromptSlotLoading(true)
      try {
        const res = await StudioEntitiesApi.get(asset.type, asset.id)
        const prompts = getAssetImagePrompts(res.data as Record<string, unknown> | null)
        const saved = String(prompts[category] ?? '').trim()
        const targets = planTargetsByType[planKeyFor(asset.type)] ?? []
        const planPrompt = String(planTargetForAsset(asset, targets)?.prompt ?? '').trim()
        setPromptSlotDrafts({ [category]: promptDrafts[asset.key] ?? saved ?? '' })
        if (!saved && !promptDrafts[asset.key] && planPrompt) {
          // 没保存过提示词时，把"计划里实际会用的那条"展示出来（用户据此改）
          setPromptSlotDrafts({ [category]: planPrompt })
        }
      } catch {
        setPromptSlotDrafts({ [category]: promptDrafts[asset.key] ?? '' })
      } finally {
        setPromptSlotLoading(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [planTargetForAsset, planTargetsByType, promptDrafts, settings],
  )

  const generatePrompt = useCallback(
    async (asset: ProductionAsset) => {
      if (!LLM_PROMPT_SUPPORTED.includes(asset.type)) {
        message.info('该资产类型没有大模型提示词槽位（道具），请在这里手工填写。')
        return
      }
      setPromptGenerating(true)
      try {
        const detail = await StudioEntitiesApi.get(asset.type, asset.id)
        const entity = (detail.data ?? {}) as Record<string, unknown>
        const result = await previewAssetImagePrompt({
          projectId: effectiveProjectId || null,
          assetType: asset.type,
          name: String(entity.name ?? asset.name),
          description: String(entity.description ?? ''),
          category: PROMPT_CATEGORY_BY_TYPE[asset.type],
        })
        if (!result.prompt) {
          message.warning('这次没有拿到提示词内容，请稍后重试或手工填写。')
          return
        }
        setPromptSlotDrafts({ [PROMPT_CATEGORY_BY_TYPE[asset.type]]: result.prompt })
        if (!result.llmCalled) {
          message.warning('演练模式下后端没有真的调用大模型，这是模板内容：可以手工修改后再保存。')
        }
      } catch (error) {
        message.error(error instanceof Error ? error.message : '生成提示词失败')
      } finally {
        setPromptGenerating(false)
      }
    },
    [effectiveProjectId],
  )

  const savePrompt = useCallback(async () => {
    const asset = assetByKey.get(promptEditorKey)
    if (!asset) return
    const category = PROMPT_CATEGORY_BY_TYPE[asset.type]
    const text = String(promptSlotDrafts[category] ?? '').trim()
    if (!text) {
      message.warning('提示词为空，没有保存。')
      return
    }
    setPromptSaving(true)
    try {
      await saveAssetImagePrompts(asset.type, asset.id, { [category]: text })
      setPromptDrafts((prev) => ({ ...prev, [asset.key]: text }))
      setPromptEditorKey('')
      message.success(`已保存「${asset.name}」的图片提示词（出图会立刻读它）`)
      onReload?.()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存提示词失败')
    } finally {
      setPromptSaving(false)
    }
  }, [assetByKey, onReload, promptEditorKey, promptSlotDrafts])

  /* -------------------------------------------------------------------- 渲染 */

  const columns: TableColumnsType<ProductionAsset> = [
    {
      title: '资产',
      key: 'name',
      ellipsis: true,
      render: (_: unknown, record) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate" title={record.name}>
            {record.name}
          </span>
          {!isSubmittableAssetType(record.type) ? (
            <Tooltip title={supportHint(record.type)}>
              <Tag bordered={false} className="mr-0 text-gray-400">
                暂不支持批量出图
              </Tag>
            </Tooltip>
          ) : null}
        </span>
      ),
    },
    {
      title: '状态',
      key: 'status',
      width: 180,
      render: (_: unknown, record) => {
        const status = resolveAssetPrepStatus(
          assetPrepInputFromReadiness({
            has_pending_candidate: record.hasPendingCandidate,
            has_image_prompt: record.hasImagePrompt,
            has_image: record.hasImage,
            has_primary: record.hasPrimary,
          }),
        )
        const color =
          status.tone === 'green' ? 'green' : status.tone === 'blue' ? 'blue' : status.tone === 'gold' ? 'gold' : 'default'
        return (
          <Tag color={color} bordered={false}>
            {status.label}
          </Tag>
        )
      },
    },
    {
      title: '图片',
      key: 'image',
      width: 110,
      render: (_: unknown, record) =>
        record.thumbnail ? (
          <img src={record.thumbnail} alt={record.name} className="h-10 w-10 rounded object-cover" />
        ) : (
          <Tag bordered={false} className="text-gray-400">
            {record.hasImage ? '已有图片' : '暂无'}
          </Tag>
        ),
    },
    {
      title: '图片提示词',
      key: 'prompt',
      width: 180,
      render: (_: unknown, record) => {
        const target = planTargetForAsset(record, planTargetsByType[planKeyFor(record.type)] ?? [])
        const source = target?.prompt_source ? PROMPT_SOURCE_LABEL[target.prompt_source] ?? '' : ''
        return (
          <Space size={4} wrap>
            <Tag color={record.hasImagePrompt || promptDrafts[record.key] ? 'green' : 'gold'} bordered={false}>
              {record.hasImagePrompt || promptDrafts[record.key] ? '已保存' : '待填写'}
            </Tag>
            {promptDrafts[record.key] ? <Tag bordered={false}>本次已改</Tag> : null}
            {source ? <span className="text-[11px] text-gray-400">{source}</span> : null}
          </Space>
        )
      },
    },
    {
      title: '定版',
      key: 'primary',
      width: 100,
      render: (_: unknown, record) =>
        record.hasPrimary ? (
          <Tag color="green" bordered={false}>
            已定版
          </Tag>
        ) : record.hasImage ? (
          <Tag color="blue" bordered={false}>
            待设定版
          </Tag>
        ) : (
          <Tag bordered={false} className="text-gray-400">
            未生成
          </Tag>
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 230,
      render: (_: unknown, record) => {
        const supported = isSubmittableAssetType(record.type)
        return (
          <Space size={4} wrap>
            <Button size="small" onClick={() => void openPromptEditor(record)}>
              {record.hasImagePrompt || promptDrafts[record.key] ? '改提示词' : '填提示词'}
            </Button>
            {supported ? (
              <Button
                size="small"
                type="primary"
                icon={<PictureOutlined />}
                disabled={busyNow}
                onClick={() => (record.hasImage ? void regenerateOne(record) : void submitSingle(record))}
              >
                {record.hasImage
                  ? generateActionLabel(record.type, 'regenerate')
                  : generateActionLabel(record.type)}
              </Button>
            ) : null}
            {onOpenAssetEditor ? (
              <Dropdown
                menu={{
                  items: [
                    { key: 'edit', label: '编辑资产', onClick: () => onOpenAssetEditor(toSignalAsset(record)) },
                    {
                      key: 'generate',
                      label: '进入该资产出图页',
                      onClick: () => onOpenAssetEditor(toSignalAsset(record), { generate: true }),
                    },
                    { type: 'divider' },
                    {
                      key: 'rework',
                      // 按类型取词：人物 = 使用已有参考图重新生成；场景/道具/服装用各自的图名
                      label: reworkAvailability.available
                        ? existingImageActionLabel(record.type)
                        : `${existingImageActionLabel(record.type)}（该能力正在接入）`,
                      disabled: !canRegenerateWithExistingReference(record) || !reworkAvailability.available,
                      onClick: () => void regenerateWithExistingReference(record),
                    },
                  ],
                }}
              >
                <Button size="small" icon={<MoreOutlined />} />
              </Dropdown>
            ) : null}
          </Space>
        )
      },
    },
  ]

  if (productionAssets.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="项目还没有人物 / 场景 / 道具 / 服装资产：请先在上面确认提取候选（关联已有资产或新建）"
      >
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => navigate(`/projects/${effectiveProjectId}?step=extract_assets`)}
        >
          去提取资产
        </Button>
      </Empty>
    )
  }

  const promptEditorAsset = promptEditorKey ? assetByKey.get(promptEditorKey) : undefined
  const promptEditorCategory = promptEditorAsset ? PROMPT_CATEGORY_BY_TYPE[promptEditorAsset.type] : ''
  const promptEditorPlanTarget = promptEditorAsset
    ? planTargetForAsset(promptEditorAsset, planTargetsByType[planKeyFor(promptEditorAsset.type)] ?? [])
    : undefined

  return (
    <div className="space-y-3">
      {/* 顶部状态：用户语言（不给原始状态值） */}
      <Alert
        type={
          headline.tone === 'red'
            ? 'error'
            : headline.tone === 'green'
              ? 'success'
              : headline.tone === 'blue'
                ? 'info'
                : 'warning'
        }
        showIcon
        message={
          <span className="text-sm">
            当前状态：<span className="font-medium">{headline.label}</span>
          </span>
        }
        description={<span className="text-xs">{headline.detail}</span>}
        action={
          headline.label === '已定版' ? (
            <Button size="small" type="primary" onClick={() => navigate(`/projects/${effectiveProjectId}?step=video_prompt`)}>
              进入下一步
            </Button>
          ) : null
        }
      />

      {/* 生成配置没就绪时，在**花钱之前**用用户语言讲清楚 */}
      {imageModelState !== 'configured' ? (
        <Alert
          type={imageModelState === 'missing' ? 'warning' : 'info'}
          showIcon
          message={
            <span className="text-xs">
              {imageModelState === 'missing'
                ? '还没有配置图片生成用的模型，现在点生成会失败：请先到「模型管理」里配置默认图片模型。'
                : '暂时无法确认图片生成是否已配置好；如果生成后没有结果，可以到「模型管理」里核对。'}
            </span>
          }
        />
      ) : null}

      {/* 分页签：人物 / 场景 / 道具 / 服装 */}
      <Segmented
        block
        value={tab}
        onChange={(value) => setTab(value as ProductionAssetType)}
        options={ASSET_TYPE_ORDER.map((type) => {
          const typeAssets = productionAssets.filter((asset) => asset.type === type)
          const done = typeAssets.filter((asset) => asset.hasPrimary).length
          return { label: `${ASSET_TYPE_LABEL[type]} ${done}/${typeAssets.length}`, value: type }
        })}
      />

      <div className="space-y-3 rounded-lg border border-slate-200 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Space size={4} wrap>
            <Button
              size="small"
              onClick={() => setSelectedKeys((prev) => applySelectionAction(productionAssets, prev, 'all', tab))}
            >
              全选本页签
            </Button>
            <Button
              size="small"
              onClick={() => setSelectedKeys((prev) => applySelectionAction(productionAssets, prev, 'ungenerated', tab))}
            >
              只选未生成项
            </Button>
            <Button size="small" onClick={() => setSelectedKeys([])}>
              清空选择
            </Button>
          </Space>
          <Space size={8} wrap>
            <Tag bordered={false}>
              {`已选 ${scope.total} 项（人物 ${scope.byType.character} / 场景 ${scope.byType.scene} / 道具 ${scope.byType.prop} / 服装 ${scope.byType.costume}）`}
            </Tag>
            <Tag color="blue" bordered={false}>{`预计生成 ${scope.estimatedImages} 张`}</Tag>
            {/* 选中项按类型分组：每一组生成什么图，说清各是哪一类（不让场景/道具并进「参考图」） */}
            {pickedGroups.map((group) => (
              <Tag key={group.assetType} bordered={false} color={group.copy.tone}>
                {`${group.copy.label} ${group.count}`}
              </Tag>
            ))}
            {scope.unsupportedCount > 0 ? (
              <Tag color="gold" bordered={false}>{`服装 ${scope.unsupportedCount} 项暂不支持批量出图`}</Tag>
            ) : null}
          </Space>
        </div>

        {/* 生成设置：只给用户能理解的选项 */}
        <div className="flex flex-wrap items-center gap-4 rounded-md bg-slate-50 px-3 py-2">
          {/* 出图方式（如实陈述，**按页签类型取词**：人物 = 参考图，场景/道具 = 各自的资产图） */}
          <span className="text-xs text-slate-600">{tabCopy.outputModeStatement}</span>
          <Tag>
            {canBatchWithReference(tab)
              ? `${BATCH_REFERENCE_FLOW_LABEL}：只对人物开放（本页签可用）`
              : `${BATCH_REFERENCE_FLOW_LABEL}：只对人物开放，${tabCopy.noun}不参与`}
          </Tag>
          <Space size={6}>
            <span className="text-xs text-slate-600">画面比例</span>
            <Select
              size="small"
              style={{ width: 132 }}
              value={settings.aspectRatio}
              onChange={(value) => setSettings((prev) => ({ ...prev, aspectRatio: value }))}
              options={ASPECT_RATIO_OPTIONS.map((item) => ({ label: item.label, value: item.value }))}
            />
            {/* 人物参考图的画幅是写死的：这里的选项对人物不生效（如实说明，不给假开关） */}
            {tabRatioNotice.applies ? (
              <span className="text-[11px] text-gray-400">{`（人物参考图固定 ${tabRatioNotice.referenceRatio}，这里的选项对人物不生效）`}</span>
            ) : null}
          </Space>
          <Space size={6}>
            <span className="text-xs text-slate-600">张数</span>
            <Tag bordered={false}>{`每个资产 ${IMAGES_PER_ASSET} 张`}</Tag>
            <span className="text-[11px] text-gray-400">出图服务一次只出一张，要多张请再点一次「重新生成」</span>
          </Space>
          <Tag color={runtimeMode === 'real' ? 'red' : 'gold'} bordered={false}>
            {runtimeMode === 'real' ? '真实模式：会真实出图并产生费用' : '演练模式：不产生费用，返回占位结果'}
          </Tag>
        </div>

        {/*
          **人物参考图固定 16:9，不等于项目最终视频画幅**（用户点名要写在页面上）。
          这里同时给出项目自己的成片画幅，两个值不同时一眼就能看出区别。
        */}
        {tabRatioNotice.applies ? (
          <Alert
            type="info"
            showIcon
            message={<span className="text-xs">{tabRatioNotice.statement}</span>}
          />
        ) : null}

        <Space size={8} wrap>
          {/* 批量按钮**按类型取名**：人物 = 批量生成参考图；场景/道具 = 各自的资产图；混选时按类型分组列出 */}
          <Tooltip title="默认只勾选还没有图片的资产，不会覆盖已有图片或已有定版图">
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={preparing}
              disabled={busyNow || scope.submittableCount === 0}
              onClick={() => void startBatch('generate')}
            >
              {batchActionLabel(pickedAssets, 'generate')}
            </Button>
          </Tooltip>
          <Tooltip title="对已有图片的资产按提示词再生成一张（会二次确认；不会自动替换现有图片或定版）">
            <Button
              disabled={busyNow || pickedRegenerateAssets.length === 0}
              onClick={() => void startBatch('regenerate')}
            >
              {batchActionLabel(pickedRegenerateAssets, 'regenerate')}
            </Button>
          </Tooltip>
          <Button danger disabled={!unsettled} onClick={handleStop}>
            停止后续
          </Button>
          <Button
            icon={<CloseCircleOutlined />}
            disabled={tasks.length === 0}
            onClick={() => {
              setTasks([])
              // 本地恢复内容一起清掉，避免刷新后又"回来"
              clearRoundFromStorage(getBrowserStorage(), roundKey)
              setRestoredNote('')
            }}
          >
            清空结果卡片
          </Button>
          <Button size="small" icon={<ReloadOutlined />} disabled={!onReload} onClick={() => onReload?.()}>
            刷新资产清单
          </Button>
        </Space>

        {/* 进度：数字全部来自真实任务状态 */}
        {tasks.length > 0 ? (
          <div className="space-y-1">
            <Progress percent={progress.percent} size="small" status={progress.hasFailure ? 'exception' : undefined} />
            <Space size={6} wrap>
              {describeProgressLines(progress).map((line) => (
                <Tag key={line.label} bordered={false} color={line.tone === 'default' ? undefined : line.tone}>
                  {`${line.label} ${line.value}`}
                </Tag>
              ))}
            </Space>
            {progress.hasFailure ? (
              <Alert
                type="error"
                showIcon
                message={
                  <span className="text-xs">{`有 ${progress.failed} 项生成失败，可以在结果卡片上「重试这一项」或「重新生成」`}</span>
                }
                description={
                  <ul className="list-disc pl-5 text-[11px]">
                    {progress.failureReasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                }
              />
            ) : null}
          </div>
        ) : null}
      </div>

      {/*
        刷新后恢复的说明（缺陷 D5）：说白了是"只读恢复"——
        不会因为恢复而重新提交、也不会重复计费。
      */}
      {restoredNote ? (
        <Alert
          type="info"
          showIcon
          closable
          message={<span className="text-xs">{restoredNote}</span>}
          onClose={() => setRestoredNote('')}
          action={
            <Button
              size="small"
              onClick={() => {
                setTasks([])
                clearRoundFromStorage(getBrowserStorage(), roundKey)
                setRestoredNote('')
              }}
            >
              清空恢复内容
            </Button>
          }
        />
      ) : null}

      {/* 结果卡片 */}
      {tasks.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-slate-900">
              {`生成结果（${tasks.length} 张${
                tasks.filter((task) => task.status === 'stopped').length > 0
                  ? `，其中已停止 ${tasks.filter((task) => task.status === 'stopped').length} 张`
                  : ''
              }）`}
            </span>
            {tasks.length > visibleCards.length ? (
              <Button size="small" type="link" onClick={() => setShowAllCards((prev) => !prev)}>
                {showAllCards ? '只看最近的结果' : `查看全部 ${tasks.length} 张结果`}
              </Button>
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {visibleCards.map((task) => (
              <AssetResultCard
                key={task.key}
                task={task}
                asset={assetByKey.get(task.assetKey)}
                busy={busyKeys.includes(task.key)}
                onViewDetail={setDetailTask}
                onEditPrompt={(item) => {
                  const asset = assetByKey.get(item.assetKey)
                  if (asset) void openPromptEditor(asset)
                }}
                onRegenerate={(item) => {
                  const asset = assetByKey.get(item.assetKey)
                  if (asset) void regenerateOne(asset)
                }}
                onRegenerateWithExistingReference={(item) => {
                  const asset = assetByKey.get(item.assetKey)
                  if (asset) void regenerateWithExistingReference(asset)
                }}
                canUseExistingReference={canRegenerateWithExistingReference(assetByKey.get(task.assetKey))}
                reworkAvailable={reworkAvailability.available}
                reworkUnavailableHint={reworkHintFor(task.assetType)}
                onRetry={(item) => void retryTask(item)}
                onAdopt={(item) => void adoptTask(item)}
                onSetPrimary={(item) => void setPrimary(item)}
                onRefresh={(item) => void refreshTask(item)}
              />
            ))}
          </div>
        </div>
      ) : null}

      {/* 资产清单（当前页签）：选择与单项操作 */}
      <Table<ProductionAsset>
        rowKey="key"
        size="small"
        loading={planLoading}
        columns={columns}
        dataSource={tabAssets}
        pagination={tabAssets.length > 8 ? { pageSize: 8, size: 'small' } : false}
        rowSelection={{
          selectedRowKeys: selectedKeys,
          onChange: (keys) => {
            // 保留其它分页签的已选项（选择跨页签累加，避免切页签丢掉选择）
            const tabKeys = new Set(tabAssets.map((asset) => asset.key))
            setSelectedKeys((prev) => [...prev.filter((key) => !tabKeys.has(key)), ...keys.map((key) => String(key))])
          },
        }}
      />

      {promptPanel ? <div className="border-t border-slate-200 pt-3">{promptPanel}</div> : null}

      {/* 编辑提示词 */}
      <Modal
        title={promptEditorAsset ? `编辑图片提示词 · ${promptEditorAsset.name}` : '编辑图片提示词'}
        open={Boolean(promptEditorKey)}
        onCancel={() => setPromptEditorKey('')}
        width={720}
        footer={
          <Space>
            <Button disabled={promptSaving} onClick={() => setPromptEditorKey('')}>
              取消
            </Button>
            <Button type="primary" loading={promptSaving} disabled={promptSlotLoading} onClick={() => void savePrompt()}>
              保存到资产
            </Button>
          </Space>
        }
      >
        {promptEditorAsset ? (
          <div className="space-y-3">
            <Alert
              type="info"
              showIcon
              message={<span className="text-xs">{`保存的就是出图实际读取的那一条提示词（${promptEditorCategory}）`}</span>}
              description={
                <span className="text-[11px]">
                  现在的来源：
                  {promptEditorPlanTarget?.prompt_source
                    ? PROMPT_SOURCE_LABEL[promptEditorPlanTarget.prompt_source] ?? ''
                    : '（还没有出图计划数据）'}
                  ；保存后本次生成就会用你保存的这条。
                </span>
              }
            />
            <Spin spinning={promptSlotLoading}>
              <div className="space-y-2 rounded-md border border-gray-200 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Tag color="blue" className="mr-0">
                    {`${getProjectSignalAssetTypeLabel(promptEditorAsset.type)}正面图片`}
                  </Tag>
                  <span className="text-[11px] text-gray-500">
                    {LLM_PROMPT_SUPPORTED.includes(promptEditorAsset.type)
                      ? '可以让大模型按资产描述生成一条，再手工修改'
                      : '该资产类型没有大模型提示词槽位，请手工填写'}
                  </span>
                </div>
                <Input.TextArea
                  rows={5}
                  value={promptSlotDrafts[promptEditorCategory] ?? ''}
                  placeholder="例如：韩虹，35 岁女律师，齐肩黑发，深灰西装，正脸半身，纯白背景"
                  onChange={(event) => setPromptSlotDrafts({ [promptEditorCategory]: event.target.value })}
                />
                <Space size={8} wrap>
                  <Button
                    size="small"
                    loading={promptGenerating}
                    disabled={!LLM_PROMPT_SUPPORTED.includes(promptEditorAsset.type)}
                    onClick={() => void generatePrompt(promptEditorAsset)}
                  >
                    用大模型生成/完善
                  </Button>
                  <span className="text-[11px] text-gray-400">{OUTPUT_MODE_STATEMENT}</span>
                </Space>
              </div>
            </Spin>
          </div>
        ) : null}
      </Modal>

      {/* 结果详情（原始字段都在这里） */}
      <Modal
        title={detailTask ? `结果详情 · ${detailTask.assetName}` : '结果详情'}
        open={Boolean(detailTask)}
        onCancel={() => setDetailTask(null)}
        footer={<Button onClick={() => setDetailTask(null)}>关闭</Button>}
        width={720}
      >
        {detailTask ? (
          <div className="space-y-3">
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="资产">
                {`${detailTask.assetName}（${getProjectSignalAssetTypeLabel(detailTask.assetType)}）`}
              </Descriptions.Item>
              <Descriptions.Item label="来龙去脉">{`本轮第 ${detailTask.round} 轮 · ${
                FLOW_LABEL[detailTask.flow] ?? resultArtifactCopy(detailTask.assetType).generateAction
              }`}</Descriptions.Item>
              <Descriptions.Item label="图片类型">
                {`${buildResultKindLabel(detailTask)}${detailTask.aspectRatio ? `｜画幅 ${detailTask.aspectRatio}` : ''}${
                  detailTask.aspectRatioSource === 'character_reference_fixed' ? '（人物参考图固定口径）' : ''
                }`}
              </Descriptions.Item>
              <Descriptions.Item label="这次用的提示词">
                <span className="text-xs">{detailTask.prompt || '（还没有提示词）'}</span>
              </Descriptions.Item>
            </Descriptions>
            <Collapse
              size="small"
              items={[
                {
                  key: 'raw',
                  label: <span className="text-xs text-gray-500">技术详情（接口返回的原始字段）</span>,
                  children: (
                    <pre className="m-0 max-h-[320px] overflow-auto rounded bg-gray-50 p-2 text-[11px] leading-5">
                      {JSON.stringify(
                        {
                          status: detailTask.status,
                          outcome: detailTask.outcome,
                          source_task_id: detailTask.sourceTaskId,
                          service_task_id: detailTask.serviceTaskId,
                          oss_url: detailTask.ossUrl,
                          image_url: detailTask.imageUrl,
                          adopted_image_id: detailTask.adoptedImageId,
                          adopted_url: detailTask.adoptedUrl,
                          is_primary: detailTask.isPrimary,
                          error_message: detailTask.errorMessage,
                          note: detailTask.note,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  ),
                },
              ]}
            />
          </div>
        ) : null}
      </Modal>

      {/* 出图计划（只读）：默认收起的技术详情 */}
      <Collapse
        ghost
        size="small"
        items={[
          {
            key: 'plan',
            label: <span className="text-xs text-gray-500">技术详情：本次出图计划（只读，不触网、不花钱）</span>,
            children: (
              <div className="space-y-2 text-xs text-gray-600">
                <Space size={6} wrap>
                  <Tag bordered={false}>{`当前页签 ${ASSET_TYPE_LABEL[tab]}`}</Tag>
                  <Tag bordered={false}>{`计划条目 ${currentPlanTargets.length}`}</Tag>
                  <Tag bordered={false}>{tabCopy.outputModeStatement}</Tag>
                  <Tag bordered={false}>{describeSettings(settings, tab)}</Tag>
                  {tabRatioNotice.applies ? <Tag bordered={false}>{tabRatioNotice.statement}</Tag> : null}
                </Space>
                {planError ? <Alert type="error" showIcon message="出图计划读取失败" description={planError} /> : null}
                {planWarnings.length > 0 ? (
                  <ul className="list-disc pl-5">
                    {planWarnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                ) : null}
                <Descriptions size="small" column={1} bordered>
                  {currentPlanTargets.slice(0, 10).map((target, index) => (
                    <Descriptions.Item key={`${target.source_task_id}-${index}`} label={target.name || target.source_asset_id}>
                      {`幂等键 ${target.source_task_id}｜提示词来源 ${target.prompt_source ?? ''}｜计划里的已有图片输入字段：${
                        target.reference_image || '（默认流程不传）'
                      }`}
                    </Descriptions.Item>
                  ))}
                </Descriptions>
                <Divider className="!my-2" />
                <Typography.Text type="secondary" className="text-[11px]">
                  同项目 + 同资产 + 同提示词 = 同一把幂等键：重复提交会被出图服务识别为同一个任务，不会重复生成；每个资产在提交中也不会被重复提交。
                </Typography.Text>
              </div>
            ),
          },
        ]}
      />
    </div>
  )
}

/** 确认框正文：范围明细 + 费用提示。 */
function ConfirmationBody(props: { lines: string[]; costWarning: string; mode: 'dry_run' | 'real' }) {
  return (
    <div className="space-y-2">
      <ul className="list-disc pl-5 text-xs leading-5">
        {props.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <Alert
        type={props.mode === 'real' ? 'warning' : 'info'}
        showIcon
        message={<span className="text-xs">{props.costWarning}</span>}
      />
    </div>
  )
}

export default AssetProductionArea
