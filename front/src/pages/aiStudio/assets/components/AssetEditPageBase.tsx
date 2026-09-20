import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Empty,
  Image,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
} from 'antd'
import {
  ArrowLeftOutlined,
  CloseCircleOutlined,
  EditOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import { ScriptProcessingService, StudioFilesService, StudioProjectsService } from '../../../../services/generated'
import {
  adoptGeneratedImage,
  getAssetImagePrompts,
  previewImagePrompts,
  saveAssetImagePrompts,
  setEntityImagePrimary,
  submitImagePlan,
  type ImagePromptPreviewResult,
} from '../../../../services/llmPipelineApi'
import { listTaskLinksNormalized } from '../../../../services/filmTaskLinks'
import { buildFileDownloadUrl } from '../utils'
import { DisplayImageCard } from './DisplayImageCard'
import { ProjectVisualStyleAndStyleFields } from '../../project/ProjectVisualStyleAndStyleFields'
import { useProjectStyleOptions } from '../../project/useProjectStyleOptions'
import { defaultTaskActionErrorMessage, executeTaskCancel } from '../../components/taskActionHelpers'
import { handleTaskResultSafely } from '../../components/taskResultHelpers'
import { useRelationTaskNotification } from '../../components/taskNotificationHelpers'
import { useTaskPageContext } from '../../components/taskPageContext'
import { TASK_COPY } from '../../components/taskCopy'
import { useLocation } from 'react-router-dom'
import { classifyGenerationFailure, failureText } from '../../components/generationGate'
import { useGenerationDraft } from '../../hooks/useGenerationDraft'
import {
  CHARACTER_PORTRAIT_ANALYSIS_RELATION_TYPE,
  COSTUME_INFO_ANALYSIS_RELATION_TYPE,
  PROP_INFO_ANALYSIS_RELATION_TYPE,
  SCENE_INFO_ANALYSIS_RELATION_TYPE,
  useCancelableRelationTask,
} from '../../project/ProjectWorkbench/chapterDivisionTasks'

const MAX_VIEW_COUNT = 4
// 与后端 `AssetViewAngle`（backend/app/models/studio.py）一致的枚举值
export type AssetViewAngle =
  | 'FRONT'
  | 'LEFT'
  | 'RIGHT'
  | 'BACK'
  | 'THREE_QUARTER'
  | 'TOP'
  | 'DETAIL'

export type AssetUpdate = {
  name: string
  description: string
  tags: string[]
  view_count: number
  visual_style: '现实' | '动漫'
  style?: string
}

const DEFAULT_ANGLES: AssetViewAngle[] = ['FRONT', 'LEFT', 'RIGHT', 'BACK']

const ANGLE_LABEL_MAP: Record<AssetViewAngle, string> = {
  FRONT: '正面',
  LEFT: '左侧',
  RIGHT: '右侧',
  BACK: '背面',
  THREE_QUARTER: '3/4 侧面',
  TOP: '俯视',
  DETAIL: '细节',
}

export type BaseAsset = {
  id: string
  name: string
  description?: string
  tags?: string[]
  view_count?: number
  visual_style?: '现实' | '动漫'
  style?: string
}

export type BaseAssetImage = {
  id: number
  view_angle?: AssetViewAngle
  file_id?: string | null
  width?: number | null
  height?: number | null
  format?: string | null
  /** 定版主图标记（`PATCH /studio/entities/{type}/{id}/images/{image_id}`，同一资产下唯一） */
  is_primary?: boolean
}

export type AssetEditPageBaseProps<TAsset extends BaseAsset, TImage extends BaseAssetImage> = {
  assetId?: string
  missingAssetIdText: string
  assetDisplayName: string
  backTo: string
  relationType: string
  getAsset: (assetId: string) => Promise<TAsset | null>
  updateAsset: (assetId: string, payload: AssetUpdate) => Promise<TAsset | null>
  listImages: (assetId: string) => Promise<TImage[]>
  createImageSlot: (assetId: string, angle: AssetViewAngle) => Promise<void>
  updateImage: (assetId: string, imageId: number, payload: { file_id: string; width?: number | null; height?: number | null; format?: string | null }) => Promise<void>
  renderPrompt: (assetId: string, imageId: number) => Promise<{ prompt: string; images: string[] }>
  onNavigate: (to: string, replace?: boolean) => void
}

type HistoryCandidate<TImage extends BaseAssetImage> = {
  id: string
  file_id: string
  view_angle?: AssetViewAngle
  width?: number | null
  height?: number | null
  format?: string | null
  source: 'task-link' | 'image'
  originalImage?: TImage
}

/** 资产编辑页当前对应的实体类型（同时是 `llmPipelineApi` 里的 entity/asset_type 取值）。 */
export type AssetEntityType = 'character' | 'scene' | 'prop' | 'costume' | 'actor'

const ENTITY_TYPE_BY_RELATION: Record<string, AssetEntityType> = {
  actor_image: 'actor',
  character_image: 'character',
  scene_image: 'scene',
  prop_image: 'prop',
  costume_image: 'costume',
}

/**
 * 出图服务 V0（`image_pipeline`）只接受 character/scene/prop：
 * 后端 `external_image_client.SERVICE_ASSET_TYPES` 明确不含 costume/actor，
 * 传过去会被 400 拒绝，所以这两种资产的批量出图按钮直接禁用。
 */
const IMAGE_SERVICE_ASSET_TYPES: AssetEntityType[] = ['character', 'scene', 'prop']

function supportsImageServiceAssetType(entityType: AssetEntityType | null): boolean {
  return !!entityType && IMAGE_SERVICE_ASSET_TYPES.includes(entityType)
}

type ReferenceBatchSubmitResult = Awaited<ReturnType<typeof submitImagePlan>>

function normalizeTags(input: string): string[] {
  return input
    .split(/[,，\n]/g)
    .map((t) => t.trim())
    .filter(Boolean)
}

function clampViewCount(value?: number | null): number {
  const next = Number.isFinite(value as number) ? Number(value) : 1
  return Math.max(1, Math.min(MAX_VIEW_COUNT, Math.trunc(next)))
}

function getSmartDetectRelationType(relationType: string): string | null {
  if (relationType === 'actor_image' || relationType === 'character_image') return CHARACTER_PORTRAIT_ANALYSIS_RELATION_TYPE
  if (relationType === 'scene_image') return SCENE_INFO_ANALYSIS_RELATION_TYPE
  if (relationType === 'prop_image') return PROP_INFO_ANALYSIS_RELATION_TYPE
  if (relationType === 'costume_image') return COSTUME_INFO_ANALYSIS_RELATION_TYPE
  return null
}

function getAssetNavigateRelationType(relationType: string): AssetEntityType | null {
  return ENTITY_TYPE_BY_RELATION[relationType] ?? null
}

/** 项目 ID 兜底来源：资产本身 / 查询参数 / 路径 / returnTo 参数（从项目工作台跳来时）。 */
function resolveProjectIdFromLocation(pathname: string, search: string): string {
  const searchParams = new URLSearchParams(search)
  const fromQuery = (searchParams.get('projectId') ?? '').trim()
  if (fromQuery) return fromQuery

  const fromPath = /^\/projects\/([^/?#]+)/.exec(pathname)
  if (fromPath?.[1]) return decodeURIComponent(fromPath[1])

  const returnTo = (searchParams.get('returnTo') ?? '').trim()
  const fromReturnTo = /^\/projects\/([^/?#]+)/.exec(returnTo)
  if (fromReturnTo?.[1]) return decodeURIComponent(fromReturnTo[1])

  return ''
}

export function AssetEditPageBase<TAsset extends BaseAsset, TImage extends BaseAssetImage>({
  assetId,
  missingAssetIdText,
  assetDisplayName,
  backTo,
  relationType,
  getAsset,
  updateAsset,
  listImages,
  createImageSlot,
  updateImage,
  renderPrompt,
  onNavigate,
}: AssetEditPageBaseProps<TAsset, TImage>) {
  const { options: projectStyleOptions, defaultVisualStyle, getDefaultStyle } = useProjectStyleOptions()
  const taskCopy = TASK_COPY.smartDetect
  const location = useLocation()
  const [loading, setLoading] = useState(true)
  const [asset, setAsset] = useState<TAsset | null>(null)
  const [images, setImages] = useState<TImage[]>([])

  const [formName, setFormName] = useState('')
  const [formDesc, setFormDesc] = useState('')
  const [formTags, setFormTags] = useState('')
  const [formViewCount, setFormViewCount] = useState(1)
  const [formVisualStyle, setFormVisualStyle] = useState<'现实' | '动漫'>(defaultVisualStyle as '现实' | '动漫')
  const [formStyle, setFormStyle] = useState<string>(getDefaultStyle(defaultVisualStyle))
  const [savingBase, setSavingBase] = useState(false)

  const [smartDetectLoading, setSmartDetectLoading] = useState(false)
  const [smartDetectOpen, setSmartDetectOpen] = useState(false)
  const [smartDetectIssues, setSmartDetectIssues] = useState<string[]>([])
  const [smartDetectOptimizedDesc, setSmartDetectOptimizedDesc] = useState('')

  const [generatingByImageId, setGeneratingByImageId] = useState<Record<number, boolean>>({})

  const [promptPreviewOpen, setPromptPreviewOpen] = useState(false)
  const [promptPreviewLoading, setPromptPreviewLoading] = useState(false)
  const [promptPreviewImage, setPromptPreviewImage] = useState<TImage | null>(null)
  const promptDraft = useGenerationDraft<
    { prompt: string },
    { imageId: number | null; images: string[] },
    { prompt: string; images: string[] },
    /** 提交结果：P3 内联出图会连地址一起回来，便于立刻采纳/设版 */
    { taskId: string | null; url: string; dryRun: boolean; status: string; message: string }
  >({
    initialBase: { prompt: '' },
    initialContext: { imageId: null, images: [] },
    derive: async ({ base, context }) => {
      if (!assetId || !context.imageId) {
        throw new Error('asset image slot is required')
      }
      const result = await renderPrompt(assetId, context.imageId)
      return {
        prompt: (base.prompt || '').trim() || (result.prompt ?? ''),
        images: Array.isArray(result.images) ? result.images.filter(Boolean) : [],
      }
    },
    submit: async ({ context, derived }) => {
      if (!assetId || !context.imageId) {
        throw new Error('asset image slot is required')
      }
      if (!supportsImageServiceAssetType(assetNavigateRelationType)) {
        throw new Error('出图服务只支持角色/场景/道具；演员/服装请用别的通道（本页已禁用该按钮）')
      }
      // 优先用「本次动作显式选定的项目」，其次用页面解析出来的作用域。
      // 为什么不能只读 state：用户在选择项目弹窗里选完立刻恢复出图时，React 的
      // resolvedProjectId 可能还没重新渲染，读旧值会再次弹出选择框。
      const projectId = (activeGenerateProjectIdRef.current || resolvedProjectId).trim()
      if (!projectId) {
        throw new Error('缺少项目作用域：请从项目工作台进入本页，或先选择项目')
      }
      // 为什么改走 P3 直提端点：老的 `/studio/image-tasks/...` 只建一条 Celery 任务行，
      // 本机没有 broker/worker（且 DRY_RUN 下建行前就被守卫拦住），表现为"点了生成没反应"。
      // P3 端点在同进程内联执行并等到结果，拿到地址后就能让用户采纳/设版。
      const data = await submitImagePlan({
        project_id: projectId,
        asset_type: assetNavigateRelationType as 'character' | 'scene' | 'prop',
        stage: 'character_sheet',
        asset_ids: [assetId],
        prompt_overrides: [{ asset_id: assetId, prompt: (derived.prompt || '').trim() }],
        use_primary_reference: false,
        aspect_ratio: '16:9',
        image_model: 'image2',
        wait_seconds: 120,
      })
      const row = data?.results?.[0]
      return {
        taskId: row?.service_task_id ?? null,
        url: row ? adoptableUrl(row) : '',
        dryRun: Boolean(data?.summary?.dry_run),
        status: row?.status ?? '',
        message: row?.message ?? '',
      }
    },
  })
  const promptPreviewDraft = promptDraft.base.prompt
  const promptPreviewRefFileIds = promptDraft.context.images

  /**
   * 从第 3 步「生成」入口进来时（`?generate=1`）自动打开该资产的出图确认弹窗。
   * 只在图片加载完成后触发一次，避免与用户手动操作打架。
   */
  const autoGenerateHandledRef = useRef(false)
  useEffect(() => {
    if (autoGenerateHandledRef.current) return
    const params = new URLSearchParams(location.search)
    if (params.get('generate') !== '1') return
    if (loading || images.length === 0) return
    autoGenerateHandledRef.current = true
    const preferred = images.find((item) => item.is_primary) ?? images[0]
    if (preferred) void openPromptPreview(preferred)
    // openPromptPreview / images 每次渲染都是新引用，这里只用「是否已处理」把关
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images, loading, location.search])

  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyCandidates, setHistoryCandidates] = useState<HistoryCandidate<TImage>[]>([])
  const [editingSlotImage, setEditingSlotImage] = useState<TImage | null>(null)
  const [adoptingImageId, setAdoptingImageId] = useState<string | null>(null)

  // 九槽位图片提示词（LLM 预览 → 合并保存到资产 image_prompts）
  const [imagePromptOpen, setImagePromptOpen] = useState(false)
  const [imagePromptLoading, setImagePromptLoading] = useState(false)
  const [imagePromptSaving, setImagePromptSaving] = useState(false)
  const [imagePromptResult, setImagePromptResult] = useState<ImagePromptPreviewResult | null>(null)
  const [imagePromptDraftByCategory, setImagePromptDraftByCategory] = useState<Record<string, string>>({})
  const [savedPromptMap, setSavedPromptMap] = useState<Record<string, string>>({})

  // 定版主图
  const [settingPrimaryImageId, setSettingPrimaryImageId] = useState<number | null>(null)

  /** 上传本地图片写入槽位时，正在上传的槽位 id（同一时刻只允许一个）。 */
  const [uploadingImageId, setUploadingImageId] = useState<number | null>(null)

  // 垫图批量出图
  const [referenceBatchLoading, setReferenceBatchLoading] = useState(false)
  const [referenceBatchOpen, setReferenceBatchOpen] = useState(false)
  /** 单张生成的结果（P3 内联出图返回的地址），用于"采纳 / 采纳并设版" */
  const [singleGenResult, setSingleGenResult] = useState<{ url: string; prompt: string; status: string } | null>(null)
  const [singleGenAdopting, setSingleGenAdopting] = useState<'' | 'slot' | 'primary'>('')
  const [referenceBatchResult, setReferenceBatchResult] = useState<ReferenceBatchSubmitResult | null>(null)
  // 断点③：把生成结果采纳进资产槽位（落库，刷新后仍在）
  const [adoptingKey, setAdoptingKey] = useState<string | null>(null)
  const [manualProjectId, setManualProjectId] = useState('')
  const [projectIdModalOpen, setProjectIdModalOpen] = useState(false)
  const [projectIdDraft, setProjectIdDraft] = useState('')

  const smartDetectRelationType = useMemo(() => getSmartDetectRelationType(relationType), [relationType])
  const smartDetectRelationEntityId = useMemo(
    () => (assetId && smartDetectRelationType ? `${relationType}:${assetId}` : null),
    [assetId, relationType, smartDetectRelationType],
  )
  const assetNavigateRelationType = useMemo(
    () => getAssetNavigateRelationType(relationType),
    [relationType],
  )
  /**
   * 当前项目 ID：角色读资产自身的 `project_id`；场景/道具/服装/演员的读模型不带该字段，
   * 因此退回 URL（`?projectId=`、`/projects/<id>/...` 路径、工作台带过来的 `returnTo`），
   * 最后才是用户手动补填。
   */
  const resolvedProjectId = useMemo(() => {
    const assetProjectId = String(
      ((asset ?? null) as unknown as { project_id?: string | null } | null)?.project_id ?? '',
    ).trim()
    if (assetProjectId) return assetProjectId
    const fromLocation = resolveProjectIdFromLocation(location.pathname, location.search)
    if (fromLocation) return fromLocation
    return manualProjectId.trim()
  }, [asset, location.pathname, location.search, manualProjectId])
  const applySmartDetectResultValue = useCallback((resultValue: unknown) => {
    const result = (resultValue ?? {}) as Record<string, unknown>
    const issues = Array.isArray(result.issues)
      ? result.issues.filter((it: unknown): it is string => typeof it === 'string' && it.trim().length > 0)
      : []
    const optimizedDesc = String(result.optimized_description ?? '').trim()
    setSmartDetectIssues(issues)
    setSmartDetectOptimizedDesc(optimizedDesc)
    setSmartDetectOpen(true)
    if (issues.length > 0) message.warning(`发现 ${issues.length} 项可能缺失信息`)
    else message.success('未发现缺失信息')
  }, [])
  const applySmartDetectResult = useCallback(async (taskId: string) => {
    await handleTaskResultSafely(taskId, {
      readErrorMessage: '读取智能检测结果失败',
      failedFallbackMessage: '智能检测失败',
      onSucceeded: (resultValue) => {
        applySmartDetectResultValue(resultValue)
      },
      onFailed: (errorMessage) => {
        message.error(errorMessage)
      },
      onReadError: () => {
        message.error('读取智能检测结果失败')
      },
    })
  }, [applySmartDetectResultValue])
  const { task: smartDetectTask, settledTask: smartDetectSettledTask, applyCancelData: applySmartDetectCancelData } = useCancelableRelationTask({
    enabled: !!assetId && !!smartDetectRelationType && !!smartDetectRelationEntityId,
    relationType: smartDetectRelationType || '',
    relationEntityId: smartDetectRelationEntityId,
    onTaskSettled: applySmartDetectResult,
  })
  useTaskPageContext(
    [
      smartDetectRelationType && smartDetectRelationEntityId
        ? {
            relationType: smartDetectRelationType,
            relationEntityId: smartDetectRelationEntityId,
          }
        : null,
      assetNavigateRelationType && assetId
        ? {
            relationType: assetNavigateRelationType,
            relationEntityId: assetId,
          }
        : null,
    ],
  )
  const smartDetectBusy = smartDetectLoading || !!smartDetectTask

  const ensureImageSlots = useCallback(async (targetViewCount: number) => {
    if (!assetId) return []

    let current = await listImages(assetId)

    const byAngle = new Map<AssetViewAngle, TImage>()
    current.forEach((img) => {
      if (img.view_angle && !byAngle.has(img.view_angle)) {
        byAngle.set(img.view_angle, img)
      }
    })

    const requiredAngles = DEFAULT_ANGLES.slice(0, targetViewCount)
    let created = false

    for (const angle of requiredAngles) {
      if (!byAngle.get(angle)) {
        await createImageSlot(assetId, angle)
        created = true
      }
    }

    if (created) {
      current = await listImages(assetId)
    }

    return current
  }, [assetId, createImageSlot, listImages])

  const loadData = useCallback(async () => {
    if (!assetId) return

    setLoading(true)
    try {
      const nextAsset = await getAsset(assetId)
      if (!nextAsset) {
        message.error(`未找到${assetDisplayName}资产`)
        onNavigate(backTo, true)
        return
      }

      setAsset(nextAsset)
      setFormName(nextAsset.name)
      setFormDesc(nextAsset.description ?? '')
      setFormTags((nextAsset.tags ?? []).join(', '))
      {
        const nextVisual = (nextAsset.visual_style ?? defaultVisualStyle) as '现实' | '动漫'
        setFormVisualStyle(nextVisual)
        setFormStyle((nextAsset.style as string | undefined) ?? getDefaultStyle(nextVisual))
      }

      const targetCount = clampViewCount(nextAsset.view_count)
      setFormViewCount(targetCount)

      const imageRows = await ensureImageSlots(targetCount)
      setImages(imageRows)
    } catch {
      message.error(`加载${assetDisplayName}资产失败`)
    } finally {
      setLoading(false)
    }
  }, [assetId, assetDisplayName, backTo, defaultVisualStyle, ensureImageSlots, getAsset, getDefaultStyle, onNavigate])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const slotItems = useMemo(() => {
    const count = clampViewCount(formViewCount)
    const byAngle = new Map<AssetViewAngle, TImage>()
    images.forEach((img) => {
      if (img.view_angle) byAngle.set(img.view_angle, img)
    })

    return DEFAULT_ANGLES.slice(0, count).map((angle) => {
      const image = byAngle.get(angle) ?? null
      return {
        angle,
        image,
        imageUrl: buildFileDownloadUrl(image?.file_id),
      }
    })
  }, [formViewCount, images])

  const minViewCount = useMemo(() => clampViewCount(asset?.view_count), [asset?.view_count])

  const handleSaveBaseInfo = async () => {
    if (!assetId || !asset) return
    if (!formName.trim()) {
      message.warning('请输入名称')
      return
    }

    setSavingBase(true)
    try {
      const nextViewCount = Math.max(minViewCount, clampViewCount(formViewCount))
      const payload: AssetUpdate = {
        name: formName.trim(),
        description: formDesc.trim(),
        tags: normalizeTags(formTags),
        view_count: nextViewCount,
        visual_style: formVisualStyle,
        style: formStyle,
      }
      const nextAsset = await updateAsset(assetId, payload)
      if (nextAsset) setAsset(nextAsset)
      message.success('基础信息已保存')
      await loadData()
    } catch {
      message.error('保存失败')
    } finally {
      setSavingBase(false)
    }
  }

  const handleSmartDetectMissing = async () => {
    if (!assetId) return
    if (!smartDetectRelationEntityId) return

    const description = (formDesc || '').trim()
    if (!description) {
      if (relationType === 'actor_image') message.warning('请先输入演员描述再进行智能检测')
      else if (relationType === 'scene_image') message.warning('请先输入场景描述再进行智能检测')
      else if (relationType === 'prop_image') message.warning('请先输入道具描述再进行智能检测')
      else if (relationType === 'costume_image') message.warning('请先输入服装描述再进行智能检测')
      return
    }

    setSmartDetectLoading(true)
    message.info('已开始智能检测：同步调用大模型，通常需要 10~120 秒，请保持页面打开')
    try {
      // 同步接口在请求内直接跑完 LLM，不写任务表；本环境没有 Celery worker / Redis，
      // 所以不再走 `-async` 变体（那个只会写一条永远不会被执行的任务）。
      const request = () => {
        if (relationType === 'actor_image') {
          const character_context = asset?.name ? `角色名：${formName}\n演员标签：${formTags}` : `演员标签：${formTags}`
          return ScriptProcessingService.analyzeCharacterPortraitApiV1ScriptProcessingAnalyzeCharacterPortraitPost({
            requestBody: {
              relation_entity_id: smartDetectRelationEntityId,
              character_description: description,
              character_context: (character_context || '').trim() || null,
            },
          })
        }
        if (relationType === 'scene_image') {
          const scene_context = asset?.name ? `场景名：${formName}\n标签：${formTags}` : `标签：${formTags}`
          return ScriptProcessingService.analyzeSceneInfoApiV1ScriptProcessingAnalyzeSceneInfoPost({
            requestBody: {
              relation_entity_id: smartDetectRelationEntityId,
              scene_description: description,
              scene_context: (scene_context || '').trim() || null,
            },
          })
        }
        if (relationType === 'prop_image') {
          const prop_context = asset?.name ? `道具名：${formName}\n标签：${formTags}` : `标签：${formTags}`
          return ScriptProcessingService.analyzePropInfoApiV1ScriptProcessingAnalyzePropInfoPost({
            requestBody: {
              relation_entity_id: smartDetectRelationEntityId,
              prop_description: description,
              prop_context: (prop_context || '').trim() || null,
            },
          })
        }
        const costume_context = asset?.name ? `服装名：${formName}\n标签：${formTags}` : `标签：${formTags}`
        return ScriptProcessingService.analyzeCostumeInfoApiV1ScriptProcessingAnalyzeCostumeInfoPost({
          requestBody: {
            relation_entity_id: smartDetectRelationEntityId,
            costume_description: description,
            costume_context: (costume_context || '').trim() || null,
          },
        })
      }

      const response = await request()
      const result = response.data
      if (!result) {
        message.error('智能检测未返回结果')
        return
      }
      applySmartDetectResultValue(result)
    } catch (error) {
      const maybeAny = error as { response?: { status?: number }; status?: number }
      const status = maybeAny?.response?.status ?? maybeAny?.status
      if (status === 404) {
        message.error('接口未找到：请运行 `pnpm run openapi:update` 生成客户端代码后重试')
      } else {
        message.error(defaultTaskActionErrorMessage(error, '智能检测失败'))
      }
    } finally {
      setSmartDetectLoading(false)
    }
  }

  const handleCancelSmartDetectTask = async () => {
    if (!smartDetectTask?.taskId) return
    try {
      await executeTaskCancel({
        taskId: smartDetectTask.taskId,
        reason: `用户在${assetDisplayName}资产编辑页取消智能检测任务`,
        applyCancelData: applySmartDetectCancelData,
        cancelledImmediatelyMessage: taskCopy.cancelledImmediatelyMessage,
        cancelRequestedMessage: taskCopy.cancelRequestedMessage,
        fallbackErrorMessage: '取消智能检测任务失败',
      })
    } catch {
      // executeTaskCancel 已统一处理错误提示
    }
  }

  useRelationTaskNotification({
    task: smartDetectTask,
    settledTask: smartDetectSettledTask,
    title: taskCopy.title,
    sourceLabel: formName?.trim() ? `${assetDisplayName}：${formName.trim()}` : `${assetDisplayName}编辑页`,
    runningDescription: taskCopy.runningDescription,
    cancellingDescription: taskCopy.cancellingDescription,
    successDescription: taskCopy.successDescription,
    cancelledDescription: taskCopy.cancelledDescription,
    failedDescription: taskCopy.failedDescription,
    onCancel: smartDetectTask ? () => void handleCancelSmartDetectTask() : null,
    onNavigate: () => onNavigate(location.pathname),
  })
  const openPromptPreview = async (image: TImage, projectIdOverride?: string) => {
    // 缺项目作用域时，先让用户选项目；选中后带着**显式 id** 回到这里继续，
    // 不会因为 state 还没刷新而重复弹选择框。
    if (
      !requireProjectScope(
        (picked) => openPromptPreview(image, picked),
        '出图需要项目作用域：请先在弹窗里选择项目',
      )
    ) {
      return
    }
    // 明确记住本次出图使用的项目：单张生成必须显式使用它。
    activeGenerateProjectIdRef.current = (projectIdOverride || resolvedProjectId).trim()
    if (!assetId) return

    try {
      setPromptPreviewOpen(true)
      setPromptPreviewLoading(true)
      setPromptPreviewImage(image)
      const nextContext = { imageId: image.id, images: [] }
      promptDraft.hydrate({
        base: { prompt: '' },
        context: nextContext,
      })
      const derived = await promptDraft.deriveNow({
        base: { prompt: '' },
        context: nextContext,
      })
      if (derived) {
        promptDraft.hydrate({
          base: { prompt: derived.prompt },
          context: { imageId: image.id, images: derived.images },
          derived,
        })
      }
    } catch {
      message.error('获取提示词失败')
    } finally {
      setPromptPreviewLoading(false)
    }
  }

  const confirmGenerateWithPrompt = async () => {
    if (!assetId || !promptPreviewImage) return
    const prompt = (promptPreviewDraft || '').trim()
    if (!prompt) {
      message.warning('请输入提示词')
      return
    }

    setGeneratingByImageId((prev) => ({ ...prev, [promptPreviewImage.id]: true }))
    try {
      // P3 端点同进程内联执行：这里**直接拿到结果**（不再靠轮询一个永远不会被执行的任务行）
      const submitted = await promptDraft.submitNow()
      if (submitted?.dryRun) {
        message.info('演练模式：未真实出图（DRY_RUN 开着），因此没有可采纳的图片。')
        return
      }
      const url = String(submitted?.url ?? '').trim()
      if (!url) {
        // 不再输出 status=unknown 这种空话：有后端 message 就用它，没有就把后端状态原样带上。
        message.error(
          submitted?.message ||
            `出图没有返回可用图片地址（后端返回状态：${submitted?.status || '未提供'}）`,
        )
        return
      }
      setSingleGenResult({ url, prompt, status: String(submitted?.status ?? '') })
      setPromptPreviewOpen(false)
      setPromptPreviewImage(null)
    } catch (error) {
      // 真实原因照原样显示：缺项目作用域 / 被 DRY_RUN 拦住 / 参数缺失 / 服务错误都能一眼看出。
      const failure = classifyGenerationFailure(error, 'image')
      message.error(failureText(failure))
    } finally {
      setGeneratingByImageId((prev) => ({ ...prev, [promptPreviewImage.id]: false }))
    }
  }

  /** 采纳生成结果到资产图片槽位；`asPrimary` 决定是否同时设为定版（同一资产下唯一）。 */
  const adoptSingleGenResult = async (asPrimary: boolean) => {
    if (!assetId || !singleGenResult || !assetNavigateRelationType) return
    setSingleGenAdopting(asPrimary ? 'primary' : 'slot')
    try {
      await adoptGeneratedImage({
        entity_type: assetNavigateRelationType,
        entity_id: assetId,
        url: singleGenResult.url,
        image_id: promptPreviewImage?.id,
        set_primary: asPrimary,
        name: `${formName || asset?.name || assetId} 生成图`,
      })
      message.success(asPrimary ? '已采纳并设为定版（刷新后仍在，后续出图会用它当垫图）' : '已采纳到该槽位（刷新后仍在）')
      setSingleGenResult(null)
      await loadData()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '采纳失败')
    } finally {
      setSingleGenAdopting('')
    }
  }

  const openHistoryModal = async (targetImage: TImage) => {
    setEditingSlotImage(targetImage)
    setHistoryOpen(true)
    setHistoryLoading(true)

    try {
      const links = await listTaskLinksNormalized({
        resourceType: 'image',
        relationType,
        relationEntityId: String(targetImage.id),
      })
      const imagesByFileId = new Map<string, TImage>()
      images.forEach((img) => {
        if (img.file_id) {
          imagesByFileId.set(img.file_id, img)
        }
      })

      const seenFileIds = new Set<string>()
      const taskLinkCandidates: HistoryCandidate<TImage>[] = links
        .filter((link) => Boolean(link.file_id))
        .map((link) => {
          const fileId = String(link.file_id)
          const matchedImage = imagesByFileId.get(fileId)
          return {
            id: `task-link-${link.id}`,
            file_id: fileId,
            view_angle: matchedImage?.view_angle ?? targetImage.view_angle,
            width: matchedImage?.width ?? null,
            height: matchedImage?.height ?? null,
            format: matchedImage?.format ?? null,
            source: 'task-link' as const,
            originalImage: matchedImage,
          }
        })
        .filter((candidate) => {
          if (seenFileIds.has(candidate.file_id)) return false
          seenFileIds.add(candidate.file_id)
          return true
        })

      const fallbackCandidates: HistoryCandidate<TImage>[] = images
        .filter((img) => img.file_id && img.id !== targetImage.id && !seenFileIds.has(String(img.file_id)))
        .map((img) => ({
          id: `image-${img.id}`,
          file_id: String(img.file_id),
          view_angle: img.view_angle,
          width: img.width ?? null,
          height: img.height ?? null,
          format: img.format ?? null,
          source: 'image' as const,
          originalImage: img,
        }))

      setHistoryCandidates(taskLinkCandidates.length > 0 ? taskLinkCandidates : fallbackCandidates)
    } catch {
      message.error('加载历史生成图片失败')
      setHistoryCandidates([])
    } finally {
      setHistoryLoading(false)
    }
  }

  const handleAdoptHistoryImage = async (candidate: HistoryCandidate<TImage>) => {
    if (!assetId || !editingSlotImage || !candidate.file_id) return

    setAdoptingImageId(candidate.id)
    try {
      await updateImage(assetId, editingSlotImage.id, {
        file_id: candidate.file_id,
        width: candidate.width ?? null,
        height: candidate.height ?? null,
        format: candidate.format ?? null,
      })
      message.success('角度图片已更新')
      setHistoryOpen(false)
      setEditingSlotImage(null)
      await loadData()
    } catch {
      message.error('更新角度图片失败')
    } finally {
      setAdoptingImageId(null)
    }
  }

  /** T2：调用 LLM 九槽位图片提示词预览（只读，不写库），已保存的类别用于预填。 */
  const loadImagePromptPreview = async () => {
    if (!assetId) return
    const name = (formName || asset?.name || '').trim()
    const profile = (formDesc || asset?.description || '').trim()
    const shotText = [name, profile].filter(Boolean).join('\n')
    if (!shotText) {
      message.warning('请先填写名称或描述，再生成图片提示词')
      return
    }

    setImagePromptOpen(true)
    setImagePromptLoading(true)
    try {
      const saved = getAssetImagePrompts(asset)
      setSavedPromptMap(saved)
      const data = await previewImagePrompts({
        shot_text: shotText,
        project_id: resolvedProjectId || undefined,
        entity_profiles: [{ name, entity_type: assetNavigateRelationType ?? 'character', profile }],
        style_hint: formStyle.trim() || undefined,
      })
      setImagePromptResult(data)
      const nextDraft: Record<string, string> = {}
      ;(data?.slots ?? []).forEach((slot) => {
        const alreadySaved = String(saved[slot.category] ?? '').trim()
        nextDraft[slot.category] = alreadySaved || slot.prompt
      })
      setImagePromptDraftByCategory(nextDraft)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '生成图片提示词失败')
    } finally {
      setImagePromptLoading(false)
    }
  }

  /** T2：把确认后的槽位提示词合并写入资产 `image_prompts`（不覆盖其它已保存类别）。 */
  const handleSaveImagePrompts = async () => {
    if (!assetId || !assetNavigateRelationType) return

    const edited: Record<string, string> = {}
    Object.entries(imagePromptDraftByCategory).forEach(([category, value]) => {
      const text = String(value ?? '').trim()
      if (text) edited[category] = text
    })
    if (Object.keys(edited).length === 0) {
      message.warning('没有可保存的提示词')
      return
    }

    setImagePromptSaving(true)
    try {
      let currentSaved = getAssetImagePrompts(asset)
      try {
        const fresh = await getAsset(assetId)
        if (fresh) currentSaved = getAssetImagePrompts(fresh)
      } catch {
        // 读不到最新资产时退回页面已加载的 image_prompts
      }
      const merged = { ...currentSaved, ...edited }
      await saveAssetImagePrompts(assetNavigateRelationType, assetId, merged)
      setSavedPromptMap(merged)
      setImagePromptOpen(false)
      message.success(`已保存 ${Object.keys(edited).length} 个槽位提示词`)
      await loadData()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存图片提示词失败')
    } finally {
      setImagePromptSaving(false)
    }
  }

  /** T3：设为定版（后端会自动清掉同一资产其它行的 is_primary）。 */
  const handleSetPrimaryImage = async (image: TImage) => {
    if (!assetId || !assetNavigateRelationType) return

    setSettingPrimaryImageId(image.id)
    try {
      await setEntityImagePrimary(assetNavigateRelationType, assetId, image.id, true)
      message.success('已设为定版')
      await loadData()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '设为定版失败')
    } finally {
      setSettingPrimaryImageId(null)
    }
  }

  /**
   * 上传本地图片文件，写入该角度槽位的 `file_id`（走 `POST /studio/files/upload`）。
   *
   * 为什么需要它：资产图片此前**只有**「AI 生成 → 采纳」这一条入口，缺图时无法用
   * 手头已有的图把槽位补上（第 3 步「上传测试图片并设为定版」在页面上无处可点）。
   * 上传与「设为定版」保持两个独立动作：上传只写槽位 file_id，定版仍由
   * `handleSetPrimaryImage` 显式触发，避免上传即隐式改定版。
   */
  const handleUploadImage = async (target: TImage, file: File) => {
    if (!assetId) return
    if (!/\.(jpe?g|png|webp|gif)$/i.test(file.name)) {
      message.error('请上传图片文件（jpg / jpeg / png / webp / gif）')
      return
    }
    setUploadingImageId(target.id)
    try {
      const res = await StudioFilesService.uploadFileApiApiV1StudioFilesUploadPost({
        formData: { file: file as unknown as string },
        name: file.name.replace(/\.[^.]+$/, ''),
      })
      const created = res.data as unknown as { id?: string } | undefined
      const fileId = String(created?.id ?? '').trim()
      if (!fileId) {
        message.error('上传成功但没有拿到 file_id，请刷新后重试')
        return
      }
      await updateImage(assetId, target.id, { file_id: fileId, format: 'png' })
      message.success(`已上传并写入槽位（file_id=${fileId}）`)
      await loadData()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '图片上传失败')
    } finally {
      setUploadingImageId(null)
    }
  }

  /** T4：用定版主图做垫图提交批量出图（受 DRY_RUN 守卫，本页不落库）。 */
  const runReferenceBatch = async (projectId: string) => {
    if (!assetId) return
    const assetType = assetNavigateRelationType
    if (assetType !== 'character' && assetType !== 'scene' && assetType !== 'prop') {
      message.warning('出图服务 V0 只支持角色/场景/道具，当前资产类型无法垫图批量出图')
      return
    }

    setReferenceBatchLoading(true)
    try {
      const data = await submitImagePlan({
        project_id: projectId,
        asset_type: assetType,
        stage: 'reference_batch',
        asset_ids: [assetId],
        use_primary_reference: true,
        aspect_ratio: '16:9',
        image_model: 'image2',
      })
      setReferenceBatchResult(data)
      setReferenceBatchOpen(true)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '提交垫图批量出图失败')
    } finally {
      setReferenceBatchLoading(false)
    }
  }

  const handleSubmitReferenceBatch = async () => {
    if (!assetId) return
    if (!supportsImageServiceAssetType(assetNavigateRelationType)) return
    const projectId = resolvedProjectId.trim()
    if (!projectId) {
      // 场景/道具/服装的读模型没有 project_id，从资产库直接打开时也拿不到 URL 线索
      requireProjectScope(
        (picked) => runReferenceBatch(picked),
        '批量出图需要项目作用域：请先选择项目',
      )
      return
    }
    await runReferenceBatch(projectId)
  }

  /**
   * 可选项目列表：给「缺少项目作用域」时用**选择**代替手填项目 ID。
   *
   * 为什么要改：原来这里是一个纯文本输入框，要求用户自己去地址栏抄 `<项目 ID>`，
   * 填错或留空就变成一个没有信息量的失败（曾经显示成 status=unknown）。
   * 现在直接列项目让用户选。
   */
  const [projectOptions, setProjectOptions] = useState<{ label: string; value: string }[]>([])
  const [projectOptionsLoading, setProjectOptionsLoading] = useState(false)

  /**
   * 拉取可选项目（**分页取全量**：后端单页上限 100，旧项目可能在第 2 页之后）。
   * 只取第一页会让「比第一页更旧的项目」根本选不到。
   */
  const loadProjectOptions = useCallback(async () => {
    setProjectOptionsLoading(true)
    try {
      const options: { label: string; value: string }[] = []
      let page = 1
      let maxPage = 1
      do {
        const res = await StudioProjectsService.listProjectsApiV1StudioProjectsGet({ page, pageSize: 100 })
        const items = res.data?.items ?? []
        options.push(...items.map((item) => ({ label: item.name, value: item.id })))
        const reported = res.data?.pagination?.max_page
        maxPage = typeof reported === 'number' && reported > 0 ? reported : 1
        page += 1
      } while (page <= maxPage && options.length < 1000)
      setProjectOptions(options)
    } catch {
      setProjectOptions([])
    } finally {
      setProjectOptionsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (projectIdModalOpen && projectOptions.length === 0) void loadProjectOptions()
  }, [projectIdModalOpen, loadProjectOptions, projectOptions.length])

  /**
   * 记住「是哪个动作触发了选项目」。
   *
   * 只有在用户从某个具体生成动作（单张生成 / 批量出图）触发时才会被赋值；
   * 从页面顶部条主动选择项目时它是 null —— 那种情况下选中项目只应该
   * 「设置作用域并让生成按钮可用」，**不允许顺手发起一次批量出图**。
   */
  const pendingProjectActionRef = useRef<((projectId: string) => Promise<void> | void) | null>(null)

  /** 本次单张生成显式使用的项目作用域（提交时优先读它）。 */
  const activeGenerateProjectIdRef = useRef('')

  const handleConfirmProjectId = async () => {
    const next = projectIdDraft.trim()
    if (!next) {
      message.warning('请先选择项目')
      return
    }
    // 同步更新：不依赖 React state 刷新，紧接着恢复的动作也能拿到正确的项目
    activeGenerateProjectIdRef.current = next
    setManualProjectId(next)
    setProjectIdModalOpen(false)

    const action = pendingProjectActionRef.current
    pendingProjectActionRef.current = null
    if (action) {
      // 从具体生成动作触发：只恢复那一个动作
      await action(next)
      return
    }
    message.success('已设置项目作用域，出图按钮现在可用')
  }

  /**
   * 缺项目作用域时的统一入口。
   *
   * `action` 是「选中项目后要继续的那个动作」，只会被恢复一次；
   * 不传 action 表示用户只是要设置作用域（例如点页面顶部的「在这里选择项目」），
   * 这种情况选中后不触发任何生成。
   */
  const requireProjectScope = (
    action: ((projectId: string) => Promise<void> | void) | null,
    reason: string,
  ): boolean => {
    const current = (activeGenerateProjectIdRef.current || resolvedProjectId).trim()
    if (current) return true
    pendingProjectActionRef.current = action
    setProjectIdDraft(activeGenerateProjectIdRef.current || '')
    setProjectIdModalOpen(true)
    message.warning(reason)
    return false
  }

  const imagePromptDryRun = imagePromptResult?.meta?.dry_run === true
  const imagePromptDryRunReason = String(imagePromptResult?.meta?.dry_run_reason ?? '').trim()
  const imagePromptWarnings = imagePromptResult?.warnings ?? []
  const imagePromptSlots = imagePromptResult?.slots ?? []
  const imagePromptSavedOnlyCategories = Object.keys(savedPromptMap).filter(
    (category) => !imagePromptSlots.some((slot) => slot.category === category),
  )
  /** 采纳结果里可用的图片地址（DRY_RUN 占位地址不算）。 */
  const adoptableUrl = (row: ReferenceBatchSubmitResult['results'][number]): string => {
    const candidate = (row.oss_url || row.image_url || '').trim()
    if (!candidate) return ''
    if (!/^https?:\/\//i.test(candidate)) return ''
    if (candidate.includes('dry-run.invalid')) return '' // 演练占位，后端也会拒
    return candidate
  }

  const handleAdoptResult = async (row: ReferenceBatchSubmitResult['results'][number]) => {
    const url = adoptableUrl(row)
    if (!assetId || !url || !assetNavigateRelationType) return
    const key = `${row.source_asset_id}_${row.service_task_id}`
    setAdoptingKey(key)
    try {
      await adoptGeneratedImage({
        entity_type: assetNavigateRelationType,
        entity_id: assetId,
        url,
        set_primary: true,
        name: `${formName || asset?.name || assetId} 生成图`,
      })
      message.success('已采纳到资产并设为定版，刷新后仍在')
      await loadData()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '采纳失败')
    } finally {
      setAdoptingKey(null)
    }
  }

  const referenceBatchResults = referenceBatchResult?.results ?? []
  const referenceBatchWarnings = referenceBatchResult?.warnings ?? []
  const referenceBatchDryRun = referenceBatchResults.some((row) => row.dry_run)
  const referenceBatchSupported = supportsImageServiceAssetType(assetNavigateRelationType)
  const hasPrimaryImage = images.some((img) => img.is_primary === true)
  const referenceBatchTooltip = referenceBatchSupported
    ? '用该资产已设为定版的主图做垫图，提交 reference_batch 批量出图（受 DRY_RUN 守卫）'
    : assetNavigateRelationType === 'costume'
      ? '出图服务 V0 不支持服装（costume），无法垫图批量出图'
      : '出图服务 V0 只支持角色 / 场景 / 道具，当前资产类型无法垫图批量出图'

  if (!assetId) {
    return (
      <Card>
        <Empty description={missingAssetIdText} />
      </Card>
    )
  }

  return (
    <div className="space-y-4 h-full overflow-auto">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Space>
            <Button icon={<ArrowLeftOutlined />} onClick={() => onNavigate(backTo)}>
              返回{assetDisplayName}资产
            </Button>
            <Typography.Title level={5} style={{ margin: 0 }}>
              {assetDisplayName}资产编辑
            </Typography.Title>
            {asset?.id ? <Tag>{asset.id}</Tag> : null}
          </Space>
          <Button icon={<ReloadOutlined />} onClick={() => void loadData()} loading={loading}>
            刷新
          </Button>
        </div>
      </Card>

      <Collapse
        defaultActiveKey={['base', 'views']}
        items={[
          {
            key: 'base',
            label: '基础信息展示',
            children: loading ? (
              <div className="py-8 text-center">
                <Spin />
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <div className="text-gray-600 text-sm mb-1">名称</div>
                  <Input value={formName} onChange={(e) => setFormName(e.target.value)} disabled={smartDetectBusy || savingBase} />
                </div>
                <div>
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="text-gray-600 text-sm">描述</div>
                      {relationType === 'actor_image' ||
                      relationType === 'scene_image' ||
                      relationType === 'prop_image' ||
                      relationType === 'costume_image' ? (
                        <>
                          <Tooltip title="同步调用大模型分析缺失信息，通常需要 10~120 秒，期间请勿关闭页面">
                            <Button
                              type="primary"
                              size="small"
                              onClick={() => void handleSmartDetectMissing()}
                              loading={smartDetectLoading}
                              disabled={Boolean(loading) || smartDetectLoading}
                            >
                              {smartDetectLoading ? '检测中…' : '智能检测'}
                            </Button>
                          </Tooltip>
                          {smartDetectTask ? (
                            <Button
                              size="small"
                              danger
                              icon={<CloseCircleOutlined />}
                              disabled={smartDetectTask.cancelRequested}
                              onClick={() => void handleCancelSmartDetectTask()}
                            >
                              {smartDetectTask.cancelRequested ? '正在取消' : '取消检测'}
                            </Button>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  <Input.TextArea
                    rows={4}
                    value={formDesc}
                    onChange={(e) => setFormDesc(e.target.value)}
                    disabled={smartDetectBusy || savingBase}
                  />
                </div>
                <div>
                  <div className="text-gray-600 text-sm mb-1">标签（逗号分隔）</div>
                  <Input value={formTags} onChange={(e) => setFormTags(e.target.value)} disabled={smartDetectBusy || savingBase} />
                </div>
                <div>
                  <div className="text-gray-600 text-sm mb-1">镜头数（仅可增加，最大 4）</div>
                  <InputNumber
                    min={minViewCount}
                    max={4}
                    precision={0}
                    value={formViewCount}
                    onChange={(v) => setFormViewCount(v ?? minViewCount)}
                    disabled={smartDetectBusy || savingBase}
                  />
                </div>
                <div>
                  <div className="text-gray-600 text-sm mb-1">视觉风格</div>
                  <ProjectVisualStyleAndStyleFields
                    disabled={smartDetectBusy || savingBase}
                    visual_style={formVisualStyle}
                    style={formStyle}
                    options={projectStyleOptions}
                    onChange={(next) => {
                      setFormVisualStyle(next.visual_style)
                      setFormStyle(next.style)
                    }}
                  />
                </div>
                <Button type="primary" onClick={() => void handleSaveBaseInfo()} loading={savingBase || smartDetectLoading}>
                  保存基础信息
                </Button>
              </div>
            ),
          },
          {
            key: 'views',
            label: '多镜头图片',
            children: (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Space wrap>
                    <Tooltip title="调用大模型生成九类槽位的图片提示词；真实调用可能需要 10~120 秒，期间请勿关闭页面">
                      <Button
                        size="small"
                        icon={<RobotOutlined />}
                        loading={imagePromptLoading}
                        onClick={() => void loadImagePromptPreview()}
                      >
                        AI 生成图片提示词
                      </Button>
                    </Tooltip>
                    <Tooltip title={referenceBatchTooltip}>
                      <span className="inline-block">
                        <Button
                          size="small"
                          type="primary"
                          ghost
                          disabled={!referenceBatchSupported || referenceBatchLoading}
                          loading={referenceBatchLoading}
                          onClick={() => void handleSubmitReferenceBatch()}
                        >
                          用定版垫图批量出图
                        </Button>
                      </span>
                    </Tooltip>
                  </Space>
                  <div className="text-xs text-gray-500">
                    <span>{assetNavigateRelationType ? `资产类型：${assetNavigateRelationType}` : '资产类型：未知'}</span>
                    <span className="ml-3">
                      {resolvedProjectId ? `项目作用域：${resolvedProjectId}` : '项目作用域：未识别'}
                    </span>
                    {referenceBatchSupported && !hasPrimaryImage ? (
                      <span className="ml-3 text-orange-500">未设置定版（垫图会退回正面视角图）</span>
                    ) : null}
                  </div>
                </div>
                {referenceBatchSupported && !resolvedProjectId ? (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="缺少项目作用域：出图已禁用"
                    description={
                      <span className="text-xs">
                        从全局资产库直接打开时拿不到资产所属项目，出图无法定位资产。
                        请先从「项目工作台 → 第 3 步 图片准备」进入本页，或
                        <Button
                          type="link"
                          size="small"
                          className="!px-1"
                          onClick={() => {
                            // 只设置作用域，不发起任何生成
                            requireProjectScope(null, '请选择项目以启用出图')
                          }}
                        >
                          在这里选择项目
                        </Button>
                        。
                      </span>
                    }
                  />
                ) : null}
                <div className="text-xs text-gray-400">
                  图片提示词保存在资产的 `image_prompts`（按槽位类别合并）；批量出图结果本页不落库，
                  请在对应角度卡片点「编辑」→ 选择历史生成图片 →「选中并更新当前角度」采纳。
                </div>
                <Row gutter={[16, 16]}>
                  {slotItems.map((slot) => (
                    <Col xs={24} sm={12} lg={8} xl={6} key={slot.angle}>
                      <DisplayImageCard
                        title={`照片角度：${ANGLE_LABEL_MAP[slot.angle]}`}
                        imageUrl={slot.imageUrl}
                        imageAlt={slot.angle}
                        placeholder="暂无图片"
                        hoverable={false}
                        imageHeightClassName="h-44"
                        extra={
                          slot.image ? (
                            <Space size={4}>
                              {slot.image.is_primary ? <Tag color="gold">定版</Tag> : null}
                              <Tag color="blue">ID {slot.image.id}</Tag>
                            </Space>
                          ) : null
                        }
                        footer={
                          <div className="flex flex-wrap items-center gap-2">
                            <Tooltip
                              title={
                                resolvedProjectId
                                  ? undefined
                                  : '缺少项目作用域：请先从项目工作台第 2 步「资产准备」进入，或在页面顶部选择项目'
                              }
                            >
                              <span>
                                <Button
                                  type="primary"
                                  size="small"
                                  disabled={!slot.image || !resolvedProjectId}
                                  loading={Boolean(slot.image && generatingByImageId[slot.image.id])}
                                  onClick={() => slot.image && void openPromptPreview(slot.image)}
                                >
                                  生成
                                </Button>
                              </span>
                            </Tooltip>
                            <Button
                              size="small"
                              icon={<EditOutlined />}
                              disabled={!slot.image}
                              onClick={() => slot.image && void openHistoryModal(slot.image)}
                            >
                              编辑
                            </Button>
                            {slot.image ? (
                              <Tooltip title="上传手头已有的图片文件，直接写入该角度槽位（不触发生图、不消耗额度）">
                                <Upload
                                  showUploadList={false}
                                  accept=".jpg,.jpeg,.png,.webp,.gif,image/*"
                                  beforeUpload={(file) => {
                                    void handleUploadImage(slot.image as TImage, file as unknown as File)
                                    return false
                                  }}
                                >
                                  <Button
                                    size="small"
                                    icon={<UploadOutlined />}
                                    loading={uploadingImageId === slot.image.id}
                                    disabled={uploadingImageId !== null && uploadingImageId !== slot.image.id}
                                  >
                                    上传
                                  </Button>
                                </Upload>
                              </Tooltip>
                            ) : null}
                            {slot.image ? (
                              <Tooltip title={slot.image.is_primary ? '该图片已是当前定版' : '设为定版后，垫图批量出图会优先使用它'}>
                                <span className="inline-block">
                                  <Button
                                    size="small"
                                    icon={<SafetyCertificateOutlined />}
                                    disabled={slot.image.is_primary === true || settingPrimaryImageId !== null}
                                    loading={settingPrimaryImageId === slot.image.id}
                                    onClick={() => slot.image && void handleSetPrimaryImage(slot.image)}
                                  >
                                    设为定版
                                  </Button>
                                </span>
                              </Tooltip>
                            ) : null}
                          </div>
                        }
                      />
                    </Col>
                  ))}
                </Row>
              </div>
            ),
          },
        ]}
      />

      <Modal
        title="历史生成图片"
        open={historyOpen}
        onCancel={() => {
          setHistoryOpen(false)
          setEditingSlotImage(null)
        }}
        footer={null}
        width={960}
      >
        {historyLoading ? (
          <div className="py-8 text-center">
            <Spin />
          </div>
        ) : historyCandidates.length === 0 ? (
          <Empty description="暂无可用历史图片" />
        ) : (
          <Row gutter={[16, 16]}>
            {historyCandidates.map((candidate) => (
              <Col xs={24} sm={12} md={8} key={candidate.id}>
                <DisplayImageCard
                  title={candidate.view_angle ? `角度：${ANGLE_LABEL_MAP[candidate.view_angle] ?? candidate.view_angle}` : candidate.source === 'task-link' ? '任务产物' : `图片 ${candidate.id}`}
                  imageUrl={buildFileDownloadUrl(candidate.file_id)}
                  imageAlt={candidate.id}
                  placeholder="无缩略图"
                  hoverable={false}
                  imageHeightClassName="h-44"
                  footer={
                    <Button
                      className="mt-2"
                      type="primary"
                      size="small"
                      block
                      disabled={!candidate.file_id}
                      loading={adoptingImageId === candidate.id}
                      onClick={() => void handleAdoptHistoryImage(candidate)}
                    >
                      选中并更新当前角度
                    </Button>
                  }
                />
              </Col>
            ))}
          </Row>
        )}
      </Modal>

      <Modal
        title="提示词内容预览"
        open={promptPreviewOpen}
        onCancel={() => {
          setPromptPreviewOpen(false)
          setPromptPreviewImage(null)
        }}
        okText="生成"
        cancelText="取消"
        confirmLoading={Boolean(promptPreviewImage && generatingByImageId[promptPreviewImage.id])}
        onOk={() => void confirmGenerateWithPrompt()}
        destroyOnClose
        width={900}
      >
        {promptPreviewLoading ? (
          <div className="py-8 text-center">
            <Spin />
          </div>
        ) : (
          <div className="space-y-3">
            {/*
              确认弹窗必须写清「这一张会出到哪个项目 / 哪个资产」。
              收口要求：从全局资产库选完项目再发起单张生成时，用户要能在**这里**
              看到刚选中的项目作用域，而不是只靠页面顶部那行小字。
            */}
            <Alert
              type={resolvedProjectId || activeGenerateProjectIdRef.current ? 'info' : 'warning'}
              showIcon
              message={
                <span className="text-xs">
                  出图目标：项目作用域{' '}
                  <Typography.Text code>
                    {activeGenerateProjectIdRef.current || resolvedProjectId || '（未设置，提交前必须先选择项目）'}
                  </Typography.Text>
                  {assetNavigateRelationType ? ` · 资产 ${assetNavigateRelationType} ${assetId ?? ''}` : ''}
                </span>
              }
            />
            <div>
              <div className="text-xs text-gray-500 mb-2">关联图片（参考图）</div>
              {promptPreviewRefFileIds.length === 0 ? (
                <div className="text-xs text-gray-400">暂无关联图片</div>
              ) : (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  <Image.PreviewGroup>
                    {promptPreviewRefFileIds.map((fid) => (
                      <Image
                        key={fid}
                        width={72}
                        height={72}
                        style={{ objectFit: 'cover', borderRadius: 8 }}
                        src={buildFileDownloadUrl(fid)}
                      />
                    ))}
                  </Image.PreviewGroup>
                </div>
              )}
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-2">提示词（可编辑）</div>
              <Input.TextArea
                rows={10}
                value={promptPreviewDraft}
                onChange={(e) => promptDraft.setBase({ prompt: e.target.value })}
                placeholder="请输入提示词…"
              />
            </div>
          </div>
        )}
      </Modal>

      <Modal
        title="智能检测：缺失信息"
        open={smartDetectOpen}
        onCancel={() => setSmartDetectOpen(false)}
        footer={null}
        destroyOnClose
        width={880}
      >
        {smartDetectLoading ? (
          <div className="py-8 text-center">
            <Spin />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              {smartDetectIssues.length === 0 ? (
                <div className="text-sm text-gray-600">未发现缺失信息。</div>
              ) : (
                <div className="text-sm text-gray-600">发现 {smartDetectIssues.length} 项可能缺失信息（建议参考下面优化后的描述）：</div>
              )}
              {smartDetectIssues.length > 0 ? (
                <div className="space-y-2">
                  {smartDetectIssues.map((it, idx) => (
                    <div key={`${idx}_${it}`} className="text-sm text-gray-800">
                      {idx + 1}. {it}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            <div>
              <div className="text-xs text-gray-500 mb-2">优化后的描述（可直接填入）</div>
              <Input.TextArea rows={6} value={smartDetectOptimizedDesc} readOnly />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  const next = smartDetectOptimizedDesc.trim()
                  if (!next) {
                    message.warning('未返回有效的优化描述')
                    return
                  }
                  setFormDesc(next)
                  setSmartDetectOpen(false)
                  message.success('已填入描述')
                }}
                disabled={!smartDetectOptimizedDesc.trim()}
              >
                填入描述
              </Button>
              <Button onClick={() => setSmartDetectOpen(false)}>关闭</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        title="AI 生成图片提示词（九槽位）"
        open={imagePromptOpen}
        onCancel={() => setImagePromptOpen(false)}
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button loading={imagePromptLoading} disabled={imagePromptSaving} onClick={() => void loadImagePromptPreview()}>
              重新生成
            </Button>
            <Space>
              <Button disabled={imagePromptSaving} onClick={() => setImagePromptOpen(false)}>
                取消
              </Button>
              <Button
                type="primary"
                loading={imagePromptSaving}
                disabled={imagePromptLoading || Object.keys(imagePromptDraftByCategory).length === 0}
                onClick={() => void handleSaveImagePrompts()}
              >
                保存到资产
              </Button>
            </Space>
          </div>
        }
        destroyOnClose
        width={960}
      >
        {imagePromptLoading ? (
          <div className="py-8 text-center">
            <Spin />
          </div>
        ) : (
          <div className="space-y-4">
            {imagePromptDryRun ? (
              <Alert
                type="warning"
                showIcon
                message="当前处于 DRY_RUN 守卫：以下提示词由占位逻辑拼装，并未真实调用大模型"
                description={
                  imagePromptDryRunReason
                    ? `拦截原因：${imagePromptDryRunReason}`
                    : '守卫关闭后这里才是模型真实输出，请勿把占位内容当作最终提示词。'
                }
              />
            ) : null}
            {imagePromptWarnings.length > 0 ? (
              <Alert
                type="info"
                showIcon
                message={`提示（${imagePromptWarnings.length}）`}
                description={
                  <ul className="pl-4 list-disc space-y-1">
                    {imagePromptWarnings.map((warning, idx) => (
                      <li key={`${idx}_${warning}`}>{warning}</li>
                    ))}
                  </ul>
                }
              />
            ) : null}
            <div className="text-xs text-gray-500">
              已保存过的类别会用已保存内容预填（下面标了「已保存」）；点「保存到资产」时会按类别合并写入
              `image_prompts`，不会丢掉未出现在本次结果里的类别。
            </div>
            {imagePromptSavedOnlyCategories.length > 0 ? (
              <div className="text-xs text-gray-500">
                另有已保存但本次未生成的类别（保存时保留原值）：
                {imagePromptSavedOnlyCategories.map((category) => (
                  <Tag key={category} className="ml-1">
                    {category}
                  </Tag>
                ))}
              </div>
            ) : null}
            {imagePromptSlots.length === 0 ? (
              <Empty description="没有返回任何槽位" />
            ) : (
              imagePromptSlots.map((slot) => (
                <div key={slot.category} className="rounded-md border border-gray-200 p-3 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Tag color="blue">{slot.label || slot.category}</Tag>
                    <span className="text-xs text-gray-500">{slot.category}</span>
                    {slot.entity_name ? <Tag>主体：{slot.entity_name}</Tag> : null}
                    {savedPromptMap[slot.category] ? <Tag color="green">已保存</Tag> : null}
                  </div>
                  <Input.TextArea
                    rows={4}
                    value={imagePromptDraftByCategory[slot.category] ?? slot.prompt}
                    onChange={(e) =>
                      setImagePromptDraftByCategory((prev) => ({ ...prev, [slot.category]: e.target.value }))
                    }
                  />
                  {Object.keys(slot.layers ?? {}).length > 0 ? (
                    <div className="rounded bg-gray-50 p-2 space-y-1">
                      <div className="text-xs text-gray-500">分层结构</div>
                      {Object.entries(slot.layers).map(([layerKey, layerValue]) => (
                        <div key={layerKey} className="text-xs text-gray-600">
                          <span className="text-gray-400">{layerKey}：</span>
                          {layerValue}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {slot.negative_prompt ? (
                    <div className="text-xs text-gray-500">负面提示词：{slot.negative_prompt}</div>
                  ) : null}
                  {slot.warnings && slot.warnings.length > 0 ? (
                    <div className="space-y-1">
                      {slot.warnings.map((warning, idx) => (
                        <div key={`${slot.category}_${idx}`} className="text-xs text-red-500">
                          {warning}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        )}
      </Modal>

      {/* 单张生成结果：出图是内联执行的，拿到地址后由用户决定"采纳到槽位 / 采纳并设为定版"。
          不自动写库：用户要求「结果可采纳、可设定版」，采纳这一步必须是显式动作。 */}
      <Modal
        title="生成结果"
        open={Boolean(singleGenResult)}
        onCancel={() => setSingleGenResult(null)}
        footer={
          <Space>
            <Button onClick={() => setSingleGenResult(null)}>关闭</Button>
            <Button loading={singleGenAdopting === 'slot'} onClick={() => void adoptSingleGenResult(false)}>
              采纳到该槽位
            </Button>
            <Button type="primary" loading={singleGenAdopting === 'primary'} onClick={() => void adoptSingleGenResult(true)}>
              采纳并设为定版
            </Button>
          </Space>
        }
        destroyOnClose
        width={720}
      >
        <div className="space-y-3">
          <Alert
            type="success"
            showIcon
            message={`出图完成（${singleGenResult?.status || 'unknown'}）`}
            description="采纳会把图片下载入库并写进资产图片槽位（刷新后仍在）；设为定版后，后续出图会用它当垫图、镜头也会读到它。"
          />
          {singleGenResult?.url ? (
            <img src={singleGenResult.url} alt="" style={{ width: '100%', borderRadius: 8, border: '1px solid #e2e8f0' }} />
          ) : null}
          <div className="text-[11px] text-gray-500 break-all">{singleGenResult?.url}</div>
          <div className="rounded bg-slate-50 px-3 py-2 text-[11px] leading-5 text-gray-600">
            <div className="font-medium">本次使用的提示词</div>
            <div className="whitespace-pre-wrap">{singleGenResult?.prompt}</div>
          </div>
        </div>
      </Modal>

      <Modal
        title="垫图批量出图结果"
        open={referenceBatchOpen}
        onCancel={() => setReferenceBatchOpen(false)}
        footer={<Button onClick={() => setReferenceBatchOpen(false)}>关闭</Button>}
        destroyOnClose
        width={880}
      >
        <div className="space-y-4">
          <div className="text-xs text-gray-500">
            <span>阶段：reference_batch</span>
            <span className="ml-3">资产：{assetId ?? '-'}</span>
            {referenceBatchResult?.project_id ? (
              <span className="ml-3">项目：{referenceBatchResult.project_id}</span>
            ) : null}
            <span className="ml-3">守卫状态：{referenceBatchResult?.guard_status || '未知'}</span>
          </div>
          {referenceBatchDryRun ? (
            <Alert
              type="warning"
              showIcon
              message="DRY_RUN 守卫为 ON：没有真的调用出图服务"
              description="下面的 service_task_id 是占位值，oss_url 为空（DRY_RUN 不会调用出图服务、也不会上传 OSS）。"
            />
          ) : null}
          {referenceBatchWarnings.length > 0 ? (
            <Alert
              type="info"
              showIcon
              message={`警告（${referenceBatchWarnings.length}）`}
              description={
                <ul className="pl-4 list-disc space-y-1">
                  {referenceBatchWarnings.map((warning, idx) => (
                    <li key={`${idx}_${warning}`}>{warning}</li>
                  ))}
                </ul>
              }
            />
          ) : null}
          {referenceBatchResults.length === 0 ? (
            <Empty description="没有返回任何提交结果" />
          ) : (
            <div className="space-y-3">
              <div className="text-sm text-gray-600">共 {referenceBatchResults.length} 个提交结果：</div>
              {referenceBatchResults.map((row) => (
                <div
                  key={`${row.source_asset_id}_${row.service_task_id}`}
                  className="rounded-md border border-gray-200 p-3 space-y-1 text-sm"
                >
                  <div>
                    service_task_id：
                    <span className="font-mono">{row.service_task_id || '（空）'}</span>
                  </div>
                  <div>
                    status：
                    <Tag color={row.status === 'succeeded' ? 'green' : row.status === 'dry_run' ? 'orange' : 'blue'}>
                      {row.status || '未知'}
                    </Tag>
                    <span className="text-xs text-gray-400">{row.source_asset_id}</span>
                  </div>
                  <div>
                    oss_url：
                    {row.oss_url ? (
                      <a href={row.oss_url} target="_blank" rel="noreferrer">
                        {row.oss_url}
                      </a>
                    ) : (
                      <span className="text-gray-400">
                        （{row.dry_run ? 'DRY_RUN 下为空，未上传 OSS' : '未返回'}）
                      </span>
                    )}
                  </div>
                  {row.message ? <div className="text-xs text-gray-500">{row.message}</div> : null}
                  <div className="pt-1">
                    <Tooltip
                      title={
                        adoptableUrl(row)
                          ? '下载入库并写入资产图片槽位（同时设为定版）'
                          : 'DRY_RUN 下没有真实图片地址，无法采纳'
                      }
                    >
                      <Button
                        size="small"
                        type="primary"
                        disabled={!adoptableUrl(row)}
                        loading={adoptingKey === `${row.source_asset_id}_${row.service_task_id}`}
                        onClick={() => void handleAdoptResult(row)}
                      >
                        采纳到资产
                      </Button>
                    </Tooltip>
                  </div>
                </div>
              ))}
            </div>
          )}
          <Alert
            type="info"
            showIcon
            message="出图结果需要人工采纳才落库"
            description="点上面的「采纳到资产」会下载入库、写入资产图片槽位并设为定版（刷新后仍在）。也可以对目标角度点「编辑」→ 选择历史生成图片 →「选中并更新当前角度」。"
          />
        </div>
      </Modal>

      <Modal
        title="出图需要项目作用域：请选择项目"
        open={projectIdModalOpen}
        onCancel={() => {
          pendingProjectActionRef.current = null
          setProjectIdModalOpen(false)
        }}
        onOk={() => void handleConfirmProjectId()}
        okText="用这个项目继续"
        cancelText="取消"
        confirmLoading={referenceBatchLoading}
        destroyOnClose
      >
        <div className="space-y-3">
          <div className="text-sm text-gray-600">
            当前页面拿不到该资产所属的项目（场景 / 道具 / 服装 / 演员的资产读模型不含 project_id，
            直接从资产库打开时 URL 里也没有项目线索）。出图必须知道项目才能定位资产。
            推荐做法是从「项目工作台 → 第 3 步 图片准备」进入本页；也可以在这里直接选一个项目。
          </div>
          <Select
            showSearch
            allowClear
            loading={projectOptionsLoading}
            value={projectIdDraft || undefined}
            onChange={(value) => setProjectIdDraft(value ?? '')}
            placeholder="选择项目"
            optionFilterProp="label"
            options={projectOptions}
            style={{ width: '100%' }}
            notFoundContent={projectOptionsLoading ? '加载中…' : '没有可选项目'}
          />
          {projectOptions.length === 0 && !projectOptionsLoading ? (
            <div className="text-xs text-gray-400">
              没有读到任何项目；项目 ID 也可以在工作台地址栏 `/projects/&lt;项目 ID&gt;` 中查看。
            </div>
          ) : null}
        </div>
      </Modal>
    </div>
  )
}
