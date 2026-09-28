import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Collapse,
  Descriptions,
  Dropdown,
  Image,
  Input,
  Modal,
  Radio,
  Segmented,
  Select,
  Slider,
  Spin,
  Space,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Upload,
  message, Typography, } from 'antd'
import {
  AppstoreOutlined,
  CaretLeftOutlined,
  CaretRightOutlined,
  CameraOutlined,
  CustomerServiceOutlined,
  DeleteOutlined,
  DoubleRightOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FileTextOutlined,
  LinkOutlined,
  MergeCellsOutlined,
  PauseCircleOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  ScissorOutlined,
  SettingOutlined,
  SoundOutlined,
  StopOutlined,
  TagOutlined,
  ToolOutlined,
  VideoCameraOutlined,
  ThunderboltOutlined,
  UndoOutlined,
  UploadOutlined,
  VideoCameraAddOutlined,
  PlusOutlined,
  UserOutlined,
  DownloadOutlined,
} from '@ant-design/icons'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ChapterShotAssetBindingSection } from '../shots/components/ChapterShotAssetBindingSection'
import { ShotVoiceInheritancePanel } from './components/ShotVoiceInheritancePanel'
import { audioStateTag, describeAudioAdmission } from '../shots/components/audioAdmissionCore'
import { StudioStepProgressStrip } from './components/StudioStepProgressStrip'
import {
  FilmService,
  LlmService,
  StudioChaptersService,
  StudioEntitiesService,
  StudioFilesService,
  StudioImageTasksService,
  StudioProjectsService,
  StudioShotCharacterLinksService,
  StudioShotDetailsService,
  StudioShotDialogLinesService,
  StudioShotFrameImagesService,
  StudioShotLinksService,
  StudioShotsService,
} from '../../../services/generated'
import { createShotProductLink, StudioEntitiesApi } from '../../../services/studioEntities'
import { defaultTaskActionErrorMessage } from '../components/taskActionHelpers'
import type {
  CameraAngle,
  CameraMovement,
  CameraShotType,
  ChapterRead,
  EntityNameExistenceItem,
  ImageGenerationOptionsRead,
  ProjectActorLinkRead,
  ProjectCostumeLinkRead,
  ShotDetailRead,
  ShotDialogLineRead,
  ShotExtractedCandidateRead,
  ShotExtractedDialogueCandidateRead,
  ShotAssetsOverviewRead,
  ShotFrameImageRead,
  ShotCharacterLinkRead,
  ProjectPropLinkRead,
  ShotFramePromptMappingRead,
  ShotRead,
  ShotVideoReadinessRead,
  ShotRuntimeSummaryRead,
  ProjectSceneLinkRead,
  ShotVideoPromptPackRead,
} from '../../../services/generated'
import { listTaskLinksNormalized } from '../../../services/filmTaskLinks'
import {
  downloadDeliveryTxt,
  fetchBoardReadiness,
  fetchImageModels,
  previewPromptDelivery,
  persistGeneratedVideo,
  previewFramePlan,
  previewVideoSubmitPlan,
  saveShotVideoPrompt,
  submitFrameImage,
  submitVideo,
} from '../../../services/llmPipelineApi'
import type { FramePlanResult, ImageModelOption, PromptDeliveryRow } from '../../../services/llmPipelineApi'
import { buildFileDownloadUrl, resolveAssetUrl } from '../assets/utils'
import type { Chapter } from '../../../mocks/data'
import type { VideoPlanFrame } from '../../../services/llmPipelineApi'
import { executeTaskCancel } from '../components/taskActionHelpers'
import { useRelationTaskNotification } from '../components/taskNotificationHelpers'
import { VideoPromptLlmPanel } from './components/VideoPromptLlmPanel'
import { ShotBoundFilesPanel } from './components/ShotBoundFilesPanel'
import { StudioPhasePanel, type StudioPhaseExtras } from './components/studio/StudioPhasePanel'
import { EpisodeVideoPromptBoard } from '../project/ProjectWorkbench/components/EpisodeVideoPromptBoard'
import { StudioShotRail } from './components/studio/StudioShotRail'
import { AssetCheckSummaryCard, DeliveryDownloadCard, DeliveryReadinessCard, DeliveryTasksCard } from './components/studio/StudioDeliveryPanels'
import { ShotAssetChecklist } from './components/studio/ShotAssetChecklist'
import { ASSET_TYPE_LABEL } from '../project/ProjectWorkbench/components/assetProduction'
import { ratioFor, useAssetStrategies } from '../hooks/useAssetStrategies'
import { railShotCode, type RailShotView } from './components/studio/shotRailModel'
import { StudioShell } from '../components/studio/StudioShell'
import {
  buildStudioContinueLabel,
  buildStudioSearch,
  getNextStudioPhase,
  getStudioPhase,
  globalStepIndexForProjectStep,
  readStudioUrlState,
  type StudioPhaseKey,
} from '../components/studio/studioPhase'
import { downloadVideoBundleZip } from '../../../services/videoDeliveryApi'
import { useShotRequestPlan, REFERENCE_MODE_OPTIONS, referenceModeLabel, videoModelBusinessName } from './components/useShotRequestPlan'
import { frameTypeLabel, resolveShotStatus, type ShotStatusText } from './components/shotStatusText'
import { ExportScopeModal } from './components/ExportScopeModal'
import {
  describeFrameBlockReason,
  evaluateShotReadiness,
  summarizeStepState,
  STEP_STATE_META,
  type PromptDeliveryRowLike,
  type ShotReadiness,
} from './components/shotReadiness'
import { TASK_COPY } from '../components/taskCopy'
// 阶段 B ①：后端原文 → 主区的中文结论（掩码 → 洗句 → 业务化改写三级管道）
// 第 3 批收尾：`showUserConclusion` 用于「产品自己写的中文结论 + 原文只进技术详情」的成对文案
import { showUserConclusion, showUserError, showUserWarning, toUserFacingText } from '../components/userFacingMessage'
// 第 3 批收尾（审计 §4.3 模式 6）：warnings / 后端原因原文进技术详情层前先掩内部 ID
import { maskInternalIds } from '../components/maskInternalIds'
// 第 3 批收尾：第三层内容一律用**全仓唯一**的技术详情折叠壳（不另建一套）
import { TechnicalDetailSection } from '../project/ProjectWorkbench/components/workbench/TechnicalDetailCollapse'
import {
  TARGET_RATIO_SOURCE,
  framePromptSourceLabel as framePromptSourceLabelShared,
  guardStatusLabel,
  labelFor,
  taskStatusLabel,
  videoPromptSourceLabel as videoPromptSourceLabelShared,
} from '../components/enumLabels'
import { classifyGenerationFailure, failureText } from '../components/generationGate'
import { ChapterStudioBatchToolbar } from './components/ChapterStudioBatchToolbar'
import { ChapterStudioMaintenancePanel } from './components/ChapterStudioMaintenancePanel'
import { ChapterStudioReadinessDiagnosisPanel } from './components/ChapterStudioReadinessDiagnosisPanel'
import { ChapterStudioVideoReadinessPanel } from './components/ChapterStudioVideoReadinessPanel'
import { useGenerationDraft, type GenerationDraftState } from '../hooks/useGenerationDraft'
import { useTaskPageContext } from '../components/taskPageContext'
import type { RelationTaskState } from '../project/ProjectWorkbench/chapterDivisionTasks'
import { toRelationTaskStateFromStatusRead } from '../project/ProjectWorkbench/chapterDivisionTasks'
import { useProjectStyleOptions } from '../project/useProjectStyleOptions'
import './chapterStudio.separation.css'

const { TextArea } = Input

const FRAME_FILE_TAG_ADOPT = '采用'
const FRAME_FILE_TAG_ABANDON = '废弃'

type ShotFramePromptDebugContext = Record<string, unknown>
type ShotFramePromptQualityChecks = {
  passed: boolean
  issues: string[]
} | null
type FramePromptDerived = {
  basePrompt: string
  renderedPrompt: string
  selectedGuidance: string[]
  droppedGuidance: string[]
  selectedGuidanceDetails: Array<{ text: string; category: string; reasonTag: string; reason: string }>
  droppedGuidanceDetails: Array<{ text: string; category: string; reasonTag: string; reason: string }>
  images: string[]
  mappings: ShotFramePromptMappingRead[]
}
type VideoReferenceMode = 'first' | 'last' | 'key' | 'first_last' | 'first_last_key' | 'text_only'
type VideoPromptDerived = {
  prompt: string
  images: string[]
  pack: ShotVideoPromptPackRead | null
}

/**
 * 固定模型直提计划（`/api/v1/studio/image-pipeline/video-plan/preview`）的只读视图。
 *
 * 只用于在「视频生成提示词预览」弹窗里如实展示后端固定策略
 * （短视频标准方案 / 480p / 最短 5s）与付费守卫状态；
 * 它只预览、不提交，也不代表当前弹窗的「生成」一定走这条路。
 */
type VideoPinnedPlanView = {
  modelName: string
  resolution: string
  seconds: number
  provider: string
  modelPinned: boolean
  providerSupported: boolean
  guardStatus: string
  warnings: string[]
}

function normalizeVideoPinnedPlan(raw: unknown): VideoPinnedPlanView | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  const readString = (key: string): string => (typeof data[key] === 'string' ? (data[key] as string) : '')
  const rawSeconds = data.seconds
  const seconds = typeof rawSeconds === 'number' ? rawSeconds : Number(rawSeconds)
  return {
    modelName: readString('model_name'),
    resolution: readString('resolution'),
    seconds: Number.isFinite(seconds) ? seconds : 0,
    provider: readString('provider'),
    modelPinned: data.model_pinned === true,
    providerSupported: data.provider_supported !== false,
    guardStatus: readString('guard_status'),
    warnings: Array.isArray(data.warnings) ? (data.warnings as unknown[]).map((item) => String(item)) : [],
  }
}

/**
 * 视频提示词来源的中文标签。
 *
 * 审计 §4.3 模式 3：旧实现的兜底是 `return normalized || '未知来源'` ——
 * **未登记来源码会被原样端上屏**（运行时实测过 `jurilu` / `manual_workspace`）。
 * 现在收敛到全仓唯一映射表 `components/enumLabels.ts`（未登记一律中文兜底）。
 */
function videoPromptSourceLabel(source: string): string {
  return videoPromptSourceLabelShared(source)
}

/**
 * 是否允许真实付费（后端 `guard_status` → 中文结论）。
 *
 * 审计 §4.3 模式 3 / §6 边界项：这个值和 `pending` 一样属英文枚举原值直渲。
 * 口径已收敛到 `components/enumLabels.ts` 的 `guardStatusLabel`（**单一定义**，
 * 顺手修掉了旧实现里 `dry_run` 正则因 `i` 标志把「DRY_RUN=关且已确认」
 * 也判成「演练模式」的错误结论）；**原文仍留在「技术详情」的技术块里**。
 */
function describeGuardStatus(raw: string): string {
  return guardStatusLabel(raw)
}

/**
 * 关键帧出图的提示词来源（后端 frame-submit 计划里的 prompt_source）。
 *
 * 旧兜底同样是 `return normalized || '未知'`（未登记原值上屏），现走唯一映射表。
 */
function framePromptSourceLabel(source: string): string {
  return framePromptSourceLabelShared(source)
}

/** 帧类型 → shot_details 上保存该帧提示词的字段（与后端 FRAME_PROMPT_FIELDS 一致）。 */
function framePromptField(frameType: PromptFrameType): string {
  if (frameType === 'first') return 'first_frame_prompt'
  if (frameType === 'last') return 'last_frame_prompt'
  return 'key_frame_prompt'
}

function normalizeFrameExclusiveTags(tags: string[]): string[] {
  const cleaned = (tags || []).map((x) => String(x ?? '').trim()).filter(Boolean)
  const hasAdopt = cleaned.includes(FRAME_FILE_TAG_ADOPT)
  const hasAbandon = cleaned.includes(FRAME_FILE_TAG_ABANDON)
  const rest = cleaned.filter((t) => t !== FRAME_FILE_TAG_ADOPT && t !== FRAME_FILE_TAG_ABANDON)
  if (hasAdopt && !hasAbandon) return [FRAME_FILE_TAG_ADOPT, ...rest]
  if (!hasAdopt && hasAbandon) return [FRAME_FILE_TAG_ABANDON, ...rest]
  // 两者都没有或同时存在：同时存在时默认保留“采用”
  if (hasAdopt && hasAbandon) return [FRAME_FILE_TAG_ADOPT, ...rest]
  return rest
}

function readDebugContextText(
  context: ShotFramePromptDebugContext | null,
  key: string,
): string {
  if (!context) return ''
  const value = context[key]
  return typeof value === 'string' ? value.trim() : ''
}

function buildKeyframeGuidanceSummary(items: string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  items
    .flatMap((item) => item.split('；'))
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      if (seen.has(item)) return
      seen.add(item)
      result.push(item)
    })
  return result
}

function stripDirectiveLevelPrefix(item: string): string {
  const text = String(item || '').trim()
  if (text.startsWith('必须：')) return text.slice(3).trim()
  if (text.startsWith('优先：')) return text.slice(3).trim()
  return text
}

function parseDirectorCommandSummary(summary: string): Array<{
  level: 'must' | 'prefer'
  text: string
}> {
  return String(summary || '')
    .split('；')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (item.startsWith('必须：')) {
        return { level: 'must' as const, text: item.slice(3).trim() }
      }
      if (item.startsWith('优先：')) {
        return { level: 'prefer' as const, text: item.slice(3).trim() }
      }
      return { level: 'prefer' as const, text: item }
    })
}

function buildGuidanceLevelSummary(
  parsedDirectorCommands: Array<{ level: 'must' | 'prefer'; text: string }>,
  guidanceSummary: string[],
): { must: number; prefer: number; normal: number } {
  const must = parsedDirectorCommands.filter((item) => item.level === 'must').length
  const prefer = parsedDirectorCommands.filter((item) => item.level === 'prefer').length
  const parsedTexts = new Set(parsedDirectorCommands.map((item) => item.text.trim()).filter(Boolean))
  const normal = guidanceSummary
    .map((item) => stripDirectiveLevelPrefix(item))
    .filter((item) => item && !parsedTexts.has(item)).length
  return { must, prefer, normal }
}

function buildActionBeatPhaseTags(summary: string): Array<{ text: string; phaseLabel: string }> {
  return String(summary || '')
    .split('；')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const matched = item.match(/^\d+\.\s*(触发|峰值|收束)\s*·\s*(.+)$/)
      if (!matched) {
        return { phaseLabel: '阶段', text: item }
      }
      return {
        phaseLabel: matched[1],
        text: matched[2].trim(),
      }
    })
}

type InspectorMode = 'push' | 'overlay'
type ShotFilter = 'all' | 'pendingConfirm' | 'generating' | 'ready' | 'hidden' | 'problem'

type StudioShot = ShotRead & {
  hidden?: boolean
  hasProblem?: boolean
  hasSpeech?: boolean
  hasMusic?: boolean
}

type ShotRuntimeState = {
  has_active_tasks: boolean
  has_active_video_tasks: boolean
  has_active_prompt_tasks: boolean
  has_active_frame_tasks: boolean
  active_task_count: number
}

type LayoutPrefs = {
  leftWidth: number
  rightWidth: number
  inspectorOpen: boolean
  /** 兼容旧偏好：布局固定为三栏并排（不再有覆盖模式） */
  inspectorMode: InspectorMode
  autoOpenInspector: boolean
  timelineCollapsed: boolean
}

type KeyframeCardState = {
  loading: boolean
  taskStatus: string | null
  taskId: string | null
  thumbs: Array<{ linkId: number; fileId: string; thumbUrl: string }>
  modalOpen: boolean
  applyingFileId: string | null
  /** 上传本地图片作为该帧时，该卡片正在上传。 */
  uploading?: boolean
  /** 本次内联生成的落库结果（file_id 非空 = 已经写进 shot_frame_images，刷新后仍在）。 */
  lastFileId?: string | null
  /** 实际送出的提示词来源：request / saved / empty。 */
  lastPromptSource?: string | null
  /** 实际送出的参考图 file_id。 */
  lastReferenceFileIds?: string[]
  /** 供应商/适配层的如实说明（例如「参考图未透传」）。 */
  lastProviderNotes?: string[]
  /** 最近一次生成的耗时（毫秒）。 */
  lastElapsedMs?: number | null
}

type KeyframeResolutionProfile = 'standard' | 'high'

/**
 * 工作室阶段 key（第 3–5 步共用容器）。
 *
 * 唯一事实来源在 `components/studio/studioPhase.ts`：本文件不再自己写一份字面量联合，
 * 否则阶段条、URL 参数与就绪判定会各自漂移。
 */
type StudioStepKey = StudioPhaseKey


/** 没选镜头时的中性状态文案（不伪造就绪度） */
const NOT_SELECTED_STATUS: ShotStatusText = {
  key: 'not_ready',
  label: '未选择分镜',
  nextAction: '先在左侧选择一条分镜',
  tone: 'default',
  canGenerate: false,
  canExport: false,
} // 工作室三步 = 项目第 4/5/6 步

const LAYOUT_STORAGE_KEY = 'jellyfish_chapter_studio_layout_v2'
type PromptFrameType = 'first' | 'key' | 'last'

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function getResolutionProfileLabel(profile: KeyframeResolutionProfile): string {
  return profile === 'high' ? '高清（3K）' : '标准（2K）'
}

function resolveKeyframePixelSize(
  options: ImageGenerationOptionsRead | null,
  ratio: string,
  profile: KeyframeResolutionProfile,
): string {
  const normalizedRatio = String(ratio ?? '').trim()
  if (!options || !normalizedRatio) return ''
  const profiles = options.ratio_size_profiles?.[normalizedRatio] ?? null
  if (!profiles) return ''
  return profiles[profile] ?? profiles.standard ?? ''
}

function mapGenerationDraftStateToRenderState(
  state: GenerationDraftState,
): 'idle' | 'stale' | 'syncing' | 'clean' | 'error' {
  if (state === 'derived' || state === 'submitted') return 'clean'
  if (state === 'deriving' || state === 'submitting') return 'syncing'
  if (state === 'draft_changed' || state === 'context_changed') return 'stale'
  if (state === 'error') return 'error'
  return 'idle'
}

function getKeyframeRenderStatusMeta(state: GenerationDraftState) {
  const renderState = mapGenerationDraftStateToRenderState(state)
  if (renderState === 'clean') {
    return {
      color: 'green' as const,
      label: '已同步',
      description: '当前提交版本已与基础提示词和参考图顺序保持一致。',
    }
  }
  if (renderState === 'syncing') {
    return {
      color: 'blue' as const,
      label: '同步中',
      description: '正在根据当前基础提示词和参考图顺序更新提交版本…',
    }
  }
  if (renderState === 'error') {
    return {
      color: 'red' as const,
      label: '同步失败',
      description: '自动更新失败，请重试。若问题持续存在，请检查基础提示词和参考图。',
    }
  }
  if (renderState === 'idle') {
    return {
      color: 'default' as const,
      label: '待生成',
      description: '请先输入基础提示词，系统会自动生成提交版本。',
    }
  }
  return {
    color: 'gold' as const,
    label: '待同步',
    description: '基础提示词或参考图顺序已变化，提交版本正在等待更新。',
  }
}

function applyTaskCancelState(
  currentTask: RelationTaskState | null,
  data?: { task_id?: string | null; status?: string | null; cancel_requested?: boolean | null } | null,
): RelationTaskState | null {
  if (!currentTask) return null
  return {
    ...currentTask,
    taskId: data?.task_id || currentTask.taskId,
    status: (data?.status ?? currentTask.status) as RelationTaskState['status'],
    cancelRequested: data?.cancel_requested ?? true,
  }
}

function reorder<T>(list: T[], startIndex: number, endIndex: number) {
  const result = [...list]
  const [removed] = result.splice(startIndex, 1)
  result.splice(endIndex, 0, removed)
  return result
}

function normalizeAssetName(value?: string | null) {
  return String(value ?? '').trim().toLowerCase()
}

function uniqueNames(values: Array<string | null | undefined>) {
  const seen = new Set<string>()
  const result: string[] = []
  values.forEach((value) => {
    const raw = String(value ?? '').trim()
    if (!raw) return
    const key = normalizeAssetName(raw)
    if (!key || seen.has(key)) return
    seen.add(key)
    result.push(raw)
  })
  return result
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  if (target.isContentEditable) return true
  return Boolean(target.closest('[contenteditable="true"]'))
}

function toUIChapter(c: ChapterRead): Chapter {
  return {
    id: c.id,
    projectId: c.project_id,
    index: c.index,
    title: c.title,
    summary: c.summary ?? '',
    storyboardCount: c.shot_count ?? c.storyboard_count ?? 0,
    status: c.status ?? 'draft',
    updatedAt: new Date().toISOString(),
  }
}

const CAMERA_SHOT_OPTIONS: { value: CameraShotType; label: string }[] = [
  { value: 'ECU', label: '极特写' },
  { value: 'CU', label: '特写' },
  { value: 'MCU', label: '中近景' },
  { value: 'MS', label: '中景' },
  { value: 'MLS', label: '中远景' },
  { value: 'LS', label: '远景' },
  { value: 'ELS', label: '大全景' },
]

const CAMERA_ANGLE_OPTIONS: { value: CameraAngle; label: string }[] = [
  { value: 'EYE_LEVEL', label: '平视' },
  { value: 'HIGH_ANGLE', label: '俯视' },
  { value: 'LOW_ANGLE', label: '仰视' },
  { value: 'BIRD_EYE', label: '鸟瞰' },
  { value: 'DUTCH', label: '倾斜' },
  { value: 'OVER_SHOULDER', label: '越肩' },
]

const CAMERA_MOVEMENT_OPTIONS: { value: CameraMovement; label: string }[] = [
  { value: 'STATIC', label: '固定' },
  { value: 'PAN', label: '摇镜' },
  { value: 'TILT', label: '俯仰' },
  { value: 'DOLLY_IN', label: '推进' },
  { value: 'DOLLY_OUT', label: '拉出' },
  { value: 'TRACK', label: '跟拍' },
  { value: 'CRANE', label: '升降' },
  { value: 'HANDHELD', label: '手持' },
  { value: 'STEADICAM', label: '稳定器' },
  { value: 'ZOOM_IN', label: '变焦推' },
  { value: 'ZOOM_OUT', label: '变焦拉' },
]

function useLocalStoragePrefs() {
  const [prefs, setPrefs] = useState<LayoutPrefs>(() => {
    try {
      const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY)
      if (!raw) {
        // 第三部分：左列表 / 中间本镜生产区 / 右侧缩小预览**三栏并排**，
        // 预览默认展开（更窄），不再需要用户先点一下才看得到完整布局。
        return {
          leftWidth: 300,
          rightWidth: 340,
          inspectorOpen: true,
          inspectorMode: 'push',
          autoOpenInspector: true,
          timelineCollapsed: false,
        }
      }
      const parsed = JSON.parse(raw) as Partial<LayoutPrefs>
      return {
        leftWidth: typeof parsed.leftWidth === 'number' ? parsed.leftWidth : 300,
        rightWidth: typeof parsed.rightWidth === 'number' ? parsed.rightWidth : 340,
        inspectorOpen: typeof parsed.inspectorOpen === 'boolean' ? parsed.inspectorOpen : true,
        inspectorMode: parsed.inspectorMode === 'overlay' ? 'overlay' : 'push',
        autoOpenInspector: typeof parsed.autoOpenInspector === 'boolean' ? parsed.autoOpenInspector : true,
        timelineCollapsed: typeof parsed.timelineCollapsed === 'boolean' ? parsed.timelineCollapsed : false,
      }
    } catch {
      return {
        leftWidth: 300,
        rightWidth: 340,
        inspectorOpen: true,
        inspectorMode: 'push',
        autoOpenInspector: true,
        timelineCollapsed: false,
      }
    }
  })

  useEffect(() => {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(prefs))
  }, [prefs])

  return [prefs, setPrefs] as const
}

const ChapterStudio: React.FC = () => {
  const { projectId, chapterId } = useParams<{
    projectId?: string
    chapterId?: string
  }>()
  const location = useLocation()
  const [chapter, setChapter] = useState<Chapter | null>(null)
  const [projectVisualStyle, setProjectVisualStyle] = useState<'现实' | '动漫'>('现实')
  const [projectStyle, setProjectStyle] = useState<string>('真人都市')
  const [projectDefaultVideoRatio, setProjectDefaultVideoRatio] = useState<string>('')
  const { videoRatioOptions, defaultVideoRatio: capabilityDefaultVideoRatio } = useProjectStyleOptions()
  const [imageGenerationOptions, setImageGenerationOptions] = useState<ImageGenerationOptionsRead | null>(null)
  // 关键帧出图模型：空 = 后端默认（image2 → 出图服务垫片）；选 gpt-image-2 = APIMart 直连
  // （只有直连这条路会把参考图以公网地址真的送出去）。
  const [keyframeImageModelId, setKeyframeImageModelId] = useState<string>('')
  const [shots, setShots] = useState<StudioShot[]>([])
  const [shotRuntimeMap, setShotRuntimeMap] = useState<Record<string, ShotRuntimeState>>({})
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null)
  const [selectedShotIds, setSelectedShotIds] = useState<string[]>([])
  const locationSelectionAppliedRef = useRef(false)
  const lastSelectedIndexRef = useRef<number>(-1)
  const [shotDetail, setShotDetail] = useState<ShotDetailRead | null>(null)
  const [dialogLines, setDialogLines] = useState<ShotDialogLineRead[]>([])
  const [frameImages, setFrameImages] = useState<ShotFrameImageRead[]>([])
  const [sceneLinks, setSceneLinks] = useState<ProjectSceneLinkRead[]>([])
  const [actorImageLinks, setActorImageLinks] = useState<ProjectActorLinkRead[]>([])
  const [propLinks, setPropLinks] = useState<ProjectPropLinkRead[]>([])
  const [costumeLinks, setCostumeLinks] = useState<ProjectCostumeLinkRead[]>([])
  const [shotCharacterLinks, setShotCharacterLinks] = useState<ShotCharacterLinkRead[]>([])
  const [shotCandidateItems, setShotCandidateItems] = useState<ShotExtractedCandidateRead[]>([])
  const [shotDialogueCandidateItems, setShotDialogueCandidateItems] = useState<ShotExtractedDialogueCandidateRead[]>([])
  const shotCandidatesRequestSeqRef = useRef(0)
  const [shotDurations, setShotDurations] = useState<Record<string, number>>({})
  const [loadingShots, setLoadingShots] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [prefs, setPrefs] = useLocalStoragePrefs()
  /**
   * 就绪数据只拉一次（外层持有）：范围交付行 + 整集交付行 + 分镜板就绪。
   * 左侧镜头列表的状态文案、中间工作区的状态、导出范围都读这一份。
   */
  const [scopeRows, setScopeRows] = useState<PromptDeliveryRow[]>([])
  const [episodeRows, setEpisodeRows] = useState<PromptDeliveryRow[]>([])
  const [readinessRows, setReadinessRows] = useState<Array<Record<string, any>>>([])
  const [batchSkipExtractionUpdating, setBatchSkipExtractionUpdating] = useState(false)
  /** 单镜关键帧生成的在途状态（工作室只做单镜补漏，批量入口已移除） */
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const saveTimerRef = useRef<number | null>(null)
  const cameraPatchSeqRef = useRef(0)
  const [cameraUpdating, setCameraUpdating] = useState(false)
  const [promptAssetsUpdating, setPromptAssetsUpdating] = useState(false)

  const [frameTab, setFrameTab] = useState<'head' | 'keyframes' | 'tail' | 'compare'>('keyframes')
  const [keyframeResolutionProfile, setKeyframeResolutionProfile] = useState<KeyframeResolutionProfile>('standard')
  const [frameFileTagsMap, setFrameFileTagsMap] = useState<Record<string, string[]>>({})
  const [frameFileTagsLoading, setFrameFileTagsLoading] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [loopCurrent, setLoopCurrent] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [previewVideoFileId, setPreviewVideoFileId] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [videoDuration, setVideoDuration] = useState(0)
  const [videoTime, setVideoTime] = useState(0)

  const [filter, setFilter] = useState<ShotFilter>('all')

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const res = await LlmService.getImageGenerationOptionsApiV1LlmImageGenerationOptionsGet()
        if (!active) return
        setImageGenerationOptions(res.data ?? null)
      } catch {
        if (!active) return
        setImageGenerationOptions(null)
      }
    })()
    return () => {
      active = false
    }
  }, [])

  const containerRef = useRef<HTMLDivElement | null>(null)
  const showPreviewMinimizeButton = false
  const showPreviewFrameSegmented = false
  const showChapterTimeline = false
  const resolveShotVideoRatio = useCallback(
    (detail?: ShotDetailRead | null) => {
      const shotRatio = String(detail?.override_video_ratio ?? '').trim()
      const projectRatio = String(projectDefaultVideoRatio ?? '').trim()
      const fallbackRatio = String(capabilityDefaultVideoRatio ?? '').trim()
      return shotRatio || projectRatio || fallbackRatio
    },
    [capabilityDefaultVideoRatio, projectDefaultVideoRatio],
  )

  const hiddenKey = useMemo(() => (chapterId ? `jellyfish_hidden_shots_${chapterId}` : null), [chapterId])
  const hiddenIds = useMemo(() => {
    if (!hiddenKey) return new Set<string>()
    try {
      const raw = window.localStorage.getItem(hiddenKey)
      const arr = raw ? (JSON.parse(raw) as unknown) : []
      return new Set(Array.isArray(arr) ? (arr.filter((x) => typeof x === 'string') as string[]) : [])
    } catch {
      return new Set<string>()
    }
  }, [hiddenKey])

  const saveHiddenIds = (next: Set<string>) => {
    if (!hiddenKey) return
    try {
      window.localStorage.setItem(hiddenKey, JSON.stringify(Array.from(next)))
    } catch {
      // ignore
    }
  }

  const toggleHiddenShots = (ids: string[]) => {
    if (!hiddenKey) return
    const next = new Set(hiddenIds)
    ids.forEach((id) => {
      if (next.has(id)) next.delete(id)
      else next.add(id)
    })
    saveHiddenIds(next)
    setShots((prev) => prev.map((s) => (ids.includes(s.id) ? { ...s, hidden: next.has(s.id) } : s)))
  }

  useEffect(() => {
    let active = true
    void (async () => {
      if (!projectId) return
      try {
        const data = await previewPromptDelivery(projectId, chapterId ?? null, 'episode', selectedShotIds ?? [])
        if (active) setScopeRows(data?.rows ?? [])
      } catch {
        if (active) setScopeRows([])
      }
    })()
    return () => {
      active = false
    }
  }, [chapterId, projectId, selectedShotIds])

  useEffect(() => {
    let active = true
    void (async () => {
      if (!projectId || !chapterId) return
      try {
        const data = await previewPromptDelivery(projectId, chapterId, 'episode')
        if (active) setEpisodeRows(data?.rows ?? [])
      } catch {
        if (active) setEpisodeRows([])
      }
      try {
        const readiness = await fetchBoardReadiness(chapterId, 'first')
        if (active) setReadinessRows(readiness.rows ?? [])
      } catch {
        if (active) setReadinessRows([])
      }
    })()
    return () => {
      active = false
    }
  }, [chapterId, projectId])

  const loadShots = async () => {
    if (!chapterId) return
    setLoadingShots(true)
    try {
      const [res, runtimeRes] = await Promise.all([
        StudioShotsService.listShotsApiV1StudioShotsGet({
          chapterId,
          page: 1,
          pageSize: 100,
          order: 'index',
          isDesc: false,
        }),
        StudioShotsService.listShotRuntimeSummaryApiV1StudioShotsRuntimeSummaryGet({
          chapterId,
        }),
      ])
      const arr = res.data?.items ?? []
      const runtimeItems: ShotRuntimeSummaryRead[] = runtimeRes.data ?? []
      setShotRuntimeMap(
        Object.fromEntries(
          runtimeItems.map((item) => [
            item.shot_id,
            {
              has_active_tasks: item.has_active_tasks,
              has_active_video_tasks: item.has_active_video_tasks,
              has_active_prompt_tasks: item.has_active_prompt_tasks,
              has_active_frame_tasks: item.has_active_frame_tasks,
              active_task_count: item.active_task_count,
            },
          ]),
        ),
      )
      // 给分镜补充一些“工作台态”的展示字段（后续可由后端返回）
      const enriched: StudioShot[] = arr
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((s, idx) => ({
          ...s,
          hidden: hiddenIds.has(s.id),
          hasProblem: idx === 4,
          hasSpeech: false,
          hasMusic: idx % 3 !== 0,
        }))

      setShots(enriched)

      const locationState = location.state as { focusShotId?: string; selectedShotIds?: string[] } | null
      if (!locationSelectionAppliedRef.current && locationState) {
        const nextSelectedIds = (locationState.selectedShotIds ?? []).filter((id) =>
          enriched.some((shot) => shot.id === id),
        )
        const focusShotId =
          locationState.focusShotId && enriched.some((shot) => shot.id === locationState.focusShotId)
            ? locationState.focusShotId
            : nextSelectedIds[0] ?? null

        if (nextSelectedIds.length > 0) {
          setSelectedShotIds(nextSelectedIds)
        }
        if (focusShotId) {
          setSelectedShotId(focusShotId)
        }
        locationSelectionAppliedRef.current = true
        return
      }

      const selectedExists = selectedShotId ? enriched.some((s) => s.id === selectedShotId) : false
      if (!selectedShotId || !selectedExists) {
        const firstUnfinished = enriched.find((s) => !s.hidden && s.status !== 'ready')
        const firstVisible = enriched.find((s) => !s.hidden)
        setSelectedShotId((firstUnfinished ?? firstVisible ?? enriched[0])?.id ?? null)
      }
    } catch {
      message.error('加载分镜失败')
    } finally {
      setLoadingShots(false)
    }
  }

  const patchShotInList = (shotId: string, patch: Partial<StudioShot>) => {
    setShots((prev) => prev.map((s) => (s.id === shotId ? { ...s, ...patch } : s)))
  }

  const updateShotTitleInOps = async (shotId: string, title: string) => {
    try {
      const res = await StudioShotsService.updateShotApiV1StudioShotsShotIdPatch({
        shotId,
        requestBody: { title },
      } as any)
      if (res.data) patchShotInList(shotId, res.data as any)
      message.success('标题已保存')
    } catch {
      message.error('保存标题失败')
    }
  }

  const updateShotScriptExcerptInOps = async (shotId: string, script_excerpt: string) => {
    try {
      const res = await StudioShotsService.updateShotApiV1StudioShotsShotIdPatch({
        shotId,
        requestBody: { script_excerpt },
      } as any)
      if (res.data) patchShotInList(shotId, res.data as any)
      message.success('备注已保存')
    } catch {
      message.error('保存备注失败')
    }
  }

  const deleteShotFromOps = async (shotId: string) => {
    try {
      await StudioShotsService.deleteShotApiV1StudioShotsShotIdDelete({ shotId })
      await loadShots()
      message.success('已删除')
    } catch {
      message.error('删除失败')
    }
  }

  const loadChapter = async () => {
    if (!chapterId) return
    try {
      const [chapterRes, projectRes] = await Promise.all([
        StudioChaptersService.getChapterApiV1StudioChaptersChapterIdGet({ chapterId }),
        projectId ? StudioProjectsService.getProjectApiV1StudioProjectsProjectIdGet({ projectId }) : Promise.resolve(null),
      ])
      const data = chapterRes.data
      if (!data) {
        setChapter(null)
        return
      }
      setChapter(toUIChapter(data))
      const nextVisualStyle = projectRes?.data?.visual_style
      const nextStyle = projectRes?.data?.style
      const nextDefaultRatio = typeof projectRes?.data?.default_video_ratio === 'string' ? projectRes.data.default_video_ratio : ''
      if (nextVisualStyle === '现实' || nextVisualStyle === '动漫') {
        setProjectVisualStyle(nextVisualStyle)
      }
      if (typeof nextStyle === 'string' && nextStyle.trim()) {
        setProjectStyle(nextStyle)
      }
      setProjectDefaultVideoRatio(nextDefaultRatio)
    } catch {
      // 章节信息仅用于标题展示，失败不阻断工作台
      setChapter(null)
      setProjectDefaultVideoRatio('')
    }
  }

  useEffect(() => {
    void loadShots()
    void loadChapter()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId, location.state, projectId])

  useEffect(() => {
    if (!selectedShotId) {
      shotCandidatesRequestSeqRef.current += 1
      setShotDetail(null)
      setDialogLines([])
      setFrameImages([])
      setSceneLinks([])
      setActorImageLinks([])
      setPropLinks([])
      setCostumeLinks([])
      setShotCharacterLinks([])
      setShotCandidateItems([])
      setShotDialogueCandidateItems([])
      return
    }
    setLoadingDetail(true)
    const reqSeq = ++shotCandidatesRequestSeqRef.current
    setShotCandidateItems([])
    setShotDialogueCandidateItems([])
    Promise.all([
      StudioShotDetailsService.getShotDetailApiV1StudioShotDetailsShotIdGet({ shotId: selectedShotId }).then((r: any) => r.data ?? null),
      StudioShotDialogLinesService.listShotDialogLinesApiV1StudioShotDialogLinesGet({
        shotDetailId: selectedShotId,
        q: null,
        order: 'index',
        isDesc: false,
        page: 1,
        pageSize: 100,
      }).then((r: any) => r.data?.items ?? []),
      StudioShotFrameImagesService.listShotFrameImagesApiV1StudioShotFrameImagesGet({
        shotDetailId: selectedShotId,
        order: null,
        isDesc: false,
        page: 1,
        pageSize: 100,
      }).then((r: any) => r.data?.items ?? []),
      StudioShotLinksService.listProjectEntityLinksApiV1StudioShotLinksEntityTypeGet({
        entityType: 'scene',
        projectId: projectId ?? null,
        chapterId: chapterId ?? null,
        shotId: selectedShotId,
        assetId: null,
        order: null,
        isDesc: false,
        page: 1,
        pageSize: 100,
      }).then((r: any) => r.data?.items ?? []),
      StudioShotLinksService.listProjectEntityLinksApiV1StudioShotLinksEntityTypeGet({
        entityType: 'actor',
        projectId: projectId ?? null,
        chapterId: chapterId ?? null,
        shotId: selectedShotId,
        assetId: null,
        order: null,
        isDesc: false,
        page: 1,
        pageSize: 100,
      }).then((r: any) => r.data?.items ?? []),
      StudioShotLinksService.listProjectEntityLinksApiV1StudioShotLinksEntityTypeGet({
        entityType: 'prop',
        projectId: projectId ?? null,
        chapterId: chapterId ?? null,
        shotId: selectedShotId,
        assetId: null,
        order: null,
        isDesc: false,
        page: 1,
        pageSize: 100,
      }).then((r: any) => r.data?.items ?? []),
      StudioShotLinksService.listProjectEntityLinksApiV1StudioShotLinksEntityTypeGet({
        entityType: 'costume',
        projectId: projectId ?? null,
        chapterId: chapterId ?? null,
        shotId: selectedShotId,
        assetId: null,
        order: null,
        isDesc: false,
        page: 1,
        pageSize: 100,
      }).then((r: any) => r.data?.items ?? []),
      StudioShotCharacterLinksService.listShotCharacterLinksApiV1StudioShotCharacterLinksGet({
        shotId: selectedShotId,
      }).then((r: any) => (r.data ?? []) as ShotCharacterLinkRead[]),
      StudioShotsService.getShotExtractedCandidatesApiV1StudioShotsShotIdExtractedCandidatesGet({
        shotId: selectedShotId,
      }).then((r) => r.data ?? []),
      StudioShotsService.getShotExtractedDialogueCandidatesApiV1StudioShotsShotIdExtractedDialogueCandidatesGet({
        shotId: selectedShotId,
      }).then((r) => r.data ?? []),
    ])
      .then(([detail, dialogs, frames, scenes, actors, props, costumes, shotCharacters, candidates, dialogueCandidates]) => {
        if (reqSeq !== shotCandidatesRequestSeqRef.current) return
        setShotDetail(detail)
        lastSavedDetailRef.current = detail
        setDialogLines(dialogs)
        setFrameImages(frames)
        setSceneLinks(scenes)
        setActorImageLinks(actors)
        setPropLinks(props)
        setCostumeLinks(costumes)
        setShotCharacterLinks(shotCharacters)
        setShotCandidateItems(candidates as ShotExtractedCandidateRead[])
        setShotDialogueCandidateItems(dialogueCandidates as ShotExtractedDialogueCandidateRead[])
        if (detail?.duration != null) {
          setShotDurations((prev) => ({ ...prev, [selectedShotId]: detail.duration ?? 0 }))
        }
      })
      .catch(() => {
        if (reqSeq !== shotCandidatesRequestSeqRef.current) return
        message.error('加载分镜详情失败')
      })
      .finally(() => {
        if (reqSeq !== shotCandidatesRequestSeqRef.current) return
        setLoadingDetail(false)
      })
  }, [selectedShotId])

  useEffect(() => {
    // 选中分镜时同步多选的“主选中项”
    if (!selectedShotId) return
    if (selectedShotIds.includes(selectedShotId)) return
    setSelectedShotIds([selectedShotId])
  }, [selectedShotId, selectedShotIds])

  const selectedShot = useMemo(() => shots.find((s) => s.id === selectedShotId) ?? null, [shots, selectedShotId])
  useTaskPageContext(
    selectedShotId
      ? [
          {
            relationType: 'shot',
            relationEntityId: selectedShotId,
          },
        ]
      : [],
  )
  const selectedShots = useMemo(
    () => shots.filter((shot) => selectedShotIds.includes(shot.id)),
    [selectedShotIds, shots],
  )
  const currentPreviewVideoFileId = previewVideoFileId || selectedShot?.generated_video_file_id || null
  const currentPreviewVideoUrl = currentPreviewVideoFileId ? buildFileDownloadUrl(currentPreviewVideoFileId) ?? '' : ''

  useEffect(() => {
    // 切换分镜时：主预览区视频跟随分镜（清空手动选择的预览视频）
    setPreviewVideoFileId(null)
  }, [selectedShotId])

  const refreshDialogLines = async (shotId: string) => {
    const res = await StudioShotDialogLinesService.listShotDialogLinesApiV1StudioShotDialogLinesGet({
      shotDetailId: shotId,
      q: null,
      order: 'index',
      isDesc: false,
      page: 1,
      pageSize: 100,
    })
    setDialogLines(res.data?.items ?? [])
  }

  const refreshShotFrameImages = useCallback(async () => {
    if (!selectedShotId) return
    try {
      const res = await StudioShotFrameImagesService.listShotFrameImagesApiV1StudioShotFrameImagesGet({
        shotDetailId: selectedShotId,
        order: null,
        isDesc: false,
        page: 1,
        pageSize: 100,
      })
      setFrameImages((res.data?.items ?? []) as ShotFrameImageRead[])
    } catch {
      message.error('刷新关键帧类型失败')
    }
  }, [selectedShotId])

  const deleteDialogLine = async (lineId: number) => {
    if (!selectedShotId) return
    await StudioShotDialogLinesService.deleteShotDialogLineApiV1StudioShotDialogLinesLineIdDelete({ lineId })
    await refreshDialogLines(selectedShotId)
  }

  const refreshPromptAssetLinks = async (shotId: string) => {
    const [scenes, actors, props, costumes] = await Promise.all([
      StudioShotLinksService.listProjectEntityLinksApiV1StudioShotLinksEntityTypeGet({
        entityType: 'scene',
        projectId: projectId ?? null,
        chapterId: chapterId ?? null,
        shotId,
        assetId: null,
        order: null,
        isDesc: false,
        page: 1,
        pageSize: 100,
      }).then((r: any) => (r.data?.items ?? []) as ProjectSceneLinkRead[]),
      StudioShotLinksService.listProjectEntityLinksApiV1StudioShotLinksEntityTypeGet({
        entityType: 'actor',
        projectId: projectId ?? null,
        chapterId: chapterId ?? null,
        shotId,
        assetId: null,
        order: null,
        isDesc: false,
        page: 1,
        pageSize: 100,
      }).then((r: any) => (r.data?.items ?? []) as ProjectActorLinkRead[]),
      StudioShotLinksService.listProjectEntityLinksApiV1StudioShotLinksEntityTypeGet({
        entityType: 'prop',
        projectId: projectId ?? null,
        chapterId: chapterId ?? null,
        shotId,
        assetId: null,
        order: null,
        isDesc: false,
        page: 1,
        pageSize: 100,
      }).then((r: any) => (r.data?.items ?? []) as ProjectPropLinkRead[]),
      StudioShotLinksService.listProjectEntityLinksApiV1StudioShotLinksEntityTypeGet({
        entityType: 'costume',
        projectId: projectId ?? null,
        chapterId: chapterId ?? null,
        shotId,
        assetId: null,
        order: null,
        isDesc: false,
        page: 1,
        pageSize: 100,
      }).then((r: any) => (r.data?.items ?? []) as ProjectCostumeLinkRead[]),
    ])
    setSceneLinks(scenes)
    setActorImageLinks(actors)
    setPropLinks(props)
    setCostumeLinks(costumes)
  }

  const loadShotCandidateItems = useCallback(async (shotId: string) => {
    try {
      const res = await StudioShotsService.getShotExtractedCandidatesApiV1StudioShotsShotIdExtractedCandidatesGet({
        shotId,
      })
      setShotCandidateItems(res.data ?? [])
    } catch {
      setShotCandidateItems([])
    }
  }, [])

  const loadShotDialogueCandidateItems = useCallback(async (shotId: string) => {
    try {
      const res = await StudioShotsService.getShotExtractedDialogueCandidatesApiV1StudioShotsShotIdExtractedDialogueCandidatesGet({
        shotId,
      })
      setShotDialogueCandidateItems(res.data ?? [])
    } catch {
      setShotDialogueCandidateItems([])
    }
  }, [])

  const batchUpdateSkipExtraction = useCallback(
    async (skip: boolean) => {
      const targetShots = selectedShots.filter((shot) => Boolean(shot.skip_extraction) !== skip)
      if (targetShots.length === 0) {
        message.info(skip ? '所选分镜已全部标记为无需提取' : '所选分镜已全部恢复提取')
        return
      }
      setBatchSkipExtractionUpdating(true)
      try {
        const results = await Promise.all(
          targetShots.map(async (shot) => {
            const res = await StudioShotsService.updateShotSkipExtractionApiV1StudioShotsShotIdSkipExtractionPatch({
              shotId: shot.id,
              requestBody: { skip },
            })
            return { shotId: shot.id, data: res.data?.state.shot ?? null }
          }),
        )
        results.forEach(({ shotId, data }) => {
          if (data) {
            patchShotInList(shotId, data as Partial<StudioShot>)
          } else {
            patchShotInList(shotId, { skip_extraction: skip })
          }
        })
        if (selectedShotId && targetShots.some((shot) => shot.id === selectedShotId)) {
          await Promise.all([
            loadShotCandidateItems(selectedShotId),
            loadShotDialogueCandidateItems(selectedShotId),
          ])
        }
        message.success(
          skip
            ? `已批量标记 ${targetShots.length} 条分镜为无需提取`
            : `已批量恢复 ${targetShots.length} 条分镜的提取确认流程`,
        )
      } catch {
        message.error(skip ? '批量标记无需提取失败' : '批量恢复提取失败')
      } finally {
        setBatchSkipExtractionUpdating(false)
      }
    },
    [loadShotCandidateItems, loadShotDialogueCandidateItems, patchShotInList, selectedShotId, selectedShots],
  )

  const updatePromptProps = async (propIds: string[]) => {
    if (!selectedShotId || !projectId) return
    const next = Array.from(new Set(propIds.map((x) => x.trim()).filter(Boolean)))
    setPromptAssetsUpdating(true)
    try {
      const currentLinks = propLinks.filter((l) => (l.shot_id ?? null) === selectedShotId)
      await Promise.all(currentLinks.map((l) => StudioShotLinksService.deleteProjectPropLinkApiV1StudioShotLinksPropLinkIdDelete({ linkId: l.id })))
      await Promise.all(
        next.map((pid) =>
          StudioShotLinksService.createProjectPropLinkApiV1StudioShotLinksPropPost({
            requestBody: { project_id: projectId, chapter_id: chapterId ?? null, shot_id: selectedShotId, asset_id: pid },
          }),
        ),
      )
      await refreshPromptAssetLinks(selectedShotId)
      await loadShotCandidateItems(selectedShotId)
    } catch {
      message.error('更新道具失败')
    } finally {
      setPromptAssetsUpdating(false)
    }
  }

  const updatePromptCostumes = async (costumeIds: string[]) => {
    if (!selectedShotId || !projectId) return
    const next = Array.from(new Set(costumeIds.map((x) => x.trim()).filter(Boolean)))
    setPromptAssetsUpdating(true)
    try {
      const currentLinks = costumeLinks.filter((l) => (l.shot_id ?? null) === selectedShotId)
      await Promise.all(currentLinks.map((l) => StudioShotLinksService.deleteProjectCostumeLinkApiV1StudioShotLinksCostumeLinkIdDelete({ linkId: l.id })))
      await Promise.all(
        next.map((cid) =>
          StudioShotLinksService.createProjectCostumeLinkApiV1StudioShotLinksCostumePost({
            requestBody: { project_id: projectId, chapter_id: chapterId ?? null, shot_id: selectedShotId, asset_id: cid },
          }),
        ),
      )
      await refreshPromptAssetLinks(selectedShotId)
      await loadShotCandidateItems(selectedShotId)
    } catch {
      message.error('更新服装失败')
    } finally {
      setPromptAssetsUpdating(false)
    }
  }

  const updatePromptScene = async (sceneId?: string) => {
    if (!selectedShotId || !projectId) return
    setPromptAssetsUpdating(true)
    try {
      const currentLinks = sceneLinks.filter((l) => (l.shot_id ?? null) === selectedShotId)
      await Promise.all(currentLinks.map((l) => StudioShotLinksService.deleteProjectSceneLinkApiV1StudioShotLinksSceneLinkIdDelete({ linkId: l.id })))
      const nextSceneId = (sceneId ?? '').trim()
      if (nextSceneId) {
        await StudioShotLinksService.createProjectSceneLinkApiV1StudioShotLinksScenePost({
          requestBody: {
            project_id: projectId,
            chapter_id: chapterId ?? null,
            shot_id: selectedShotId,
            asset_id: nextSceneId,
          },
        })
      }
      await refreshPromptAssetLinks(selectedShotId)
      await loadShotCandidateItems(selectedShotId)
      patchShotDetailLocal({ scene_id: nextSceneId || null })
    } catch {
      message.error('更新场景失败')
    } finally {
      setPromptAssetsUpdating(false)
    }
  }

  const updatePromptActors = async (actorIds: string[]) => {
    if (!selectedShotId) return
    const next = Array.from(new Set(actorIds.map((x) => x.trim()).filter(Boolean)))
    const current = shotCharacterLinks
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((x) => x.character_id)
    const removed = current.filter((id) => !next.includes(id))
    if (removed.length > 0) {
      message.warning('这一版还不支持移除已关联角色，只会新增或重排')
    }
    if (next.length === 0) return
    setPromptAssetsUpdating(true)
    try {
      await Promise.all(
        next.map((characterId, index) =>
          StudioShotCharacterLinksService.upsertShotCharacterLinkApiV1StudioShotCharacterLinksPost({
            requestBody: { shot_id: selectedShotId, character_id: characterId, index, note: '' },
          }),
        ),
      )
      const refreshed = await StudioShotCharacterLinksService.listShotCharacterLinksApiV1StudioShotCharacterLinksGet({ shotId: selectedShotId })
      setShotCharacterLinks((refreshed.data ?? []) as ShotCharacterLinkRead[])
      await loadShotCandidateItems(selectedShotId)
    } catch {
      message.error('更新角色失败')
    } finally {
      setPromptAssetsUpdating(false)
    }
  }

  const generateFrameImageTask = async () => {
    if (!selectedShotId) return
    // 在途闸门：Ctrl/Cmd+Enter 连按不该发两次请求（单镜补漏，一次一张）
    if (generating) return
    const target =
      (frameTab === 'head' && frameImages.find((x) => x.frame_type === 'first')) ||
      (frameTab === 'tail' && frameImages.find((x) => x.frame_type === 'last')) ||
      frameImages.find((x) => x.frame_type === 'key') ||
      frameImages[0]
    if (!target) {
      message.warning('请先添加一张分镜帧图')
      return
    }
    const prompt =
      (target.frame_type === 'first'
        ? shotDetail?.first_frame_prompt
        : target.frame_type === 'last'
          ? shotDetail?.last_frame_prompt
          : shotDetail?.key_frame_prompt) ?? ''
    if (!prompt.trim()) {
      message.warning('请先生成或填写提示词')
      return
    }
    setGenerating(true)
    try {
      const linked = await StudioShotsService.listShotLinkedAssetsApiV1StudioShotsShotIdLinkedAssetsGet({
        shotId: selectedShotId,
        page: 1,
        pageSize: 100,
      })
      const items = (linked.data?.items ?? []) as any[]
      const extractFileId = (thumbnail?: string | null): string | null => {
        const v = (thumbnail || '').trim()
        if (!v) return null
        if (!v.includes('/') && !v.includes(':')) return v
        try {
          const url = new URL(v, typeof window !== 'undefined' ? window.location.origin : 'http://localhost')
          const m = url.pathname.match(/\/api\/v1\/studio\/files\/([^/]+)\/download\/?$/)
          if (m?.[1]) return decodeURIComponent(m[1])
        } catch {
          // ignore
        }
        return null
      }
      const imagesPayload = items
        .map((x) => {
          const fileId = typeof x?.file_id === 'string' && x.file_id.trim() ? x.file_id.trim() : extractFileId(x?.thumbnail)
          return fileId
            ? {
                type: x?.type as any,
                id: String(x?.id ?? ''),
                name: String(x?.name ?? x?.id ?? ''),
                file_id: fileId,
              }
            : null
        })
        .filter(Boolean)
      const targetRatio = resolveShotVideoRatio(shotDetail)
      if (!targetRatio) {
        message.warning('请先设置视频比例')
        return
      }
      // 快捷键（Cmd/Ctrl+Enter）走的也是**同进程内联**端点：
      // 老端点只建 Celery 任务行，本机没有 broker/worker，按了等于没按。
      const result = await submitFrameImage({
        shot_id: selectedShotId,
        frame_type: target.frame_type as 'first' | 'key' | 'last',
        prompt,
        images: (imagesPayload as Array<{ file_id?: string }>).map((x) => String(x?.file_id ?? '')).filter(Boolean),
        target_ratio: targetRatio,
        resolution_profile: keyframeResolutionProfile,
        model_id: keyframeImageModelId || null,
      })
      if (result.dry_run) {
        // 审计 §4.3 模式 4：主区不许出现 DRY_RUN / 环境变量名
        message.info('演练模式：没有真实出图、没有产生费用。')
      } else if (result.status === 'succeeded' && result.file_id) {
        await refreshShotFrameImages()
        message.success('帧图已生成并保存到本镜（内部 ID 见「技术详情」）')
      } else {
        // 审计 §4.3 模式 3：不许把 `status=xxx` 拼进中文句
        message.error(toUserFacingText(result.error, '图片没能生成出来，请重试；若持续失败请到「技术详情」看原因'))
      }
    } catch (error) {
      void showUserError(error, '图片没能生成出来，请重试')
    } finally {
      setGenerating(false)
    }
  }

  const currentFrameSlot = useMemo(() => {
    if (frameTab === 'head') return frameImages.find((x) => x.frame_type === 'first') ?? null
    if (frameTab === 'tail') return frameImages.find((x) => x.frame_type === 'last') ?? null
    return frameImages.find((x) => x.frame_type === 'key') ?? frameImages[0] ?? null
  }, [frameImages, frameTab])

  const currentFrameFileId = useMemo(() => {
    const fid = currentFrameSlot?.file_id ?? null
    return fid ? String(fid) : null
  }, [currentFrameSlot?.file_id])

  const currentFrameFileTags = useMemo(() => {
    if (!currentFrameFileId) return []
    return frameFileTagsMap[currentFrameFileId] ?? []
  }, [currentFrameFileId, frameFileTagsMap])

  useEffect(() => {
    if (!currentFrameFileId) return
    if (frameFileTagsMap[currentFrameFileId]) return
    let canceled = false
    setFrameFileTagsLoading(true)
    void (async () => {
      try {
        const res = await StudioFilesService.getFileDetailApiV1StudioFilesFileIdGet({ fileId: currentFrameFileId })
        if (canceled) return
        const tagsRaw = Array.isArray((res.data as any)?.tags) ? ((res.data as any).tags as string[]).filter(Boolean) : []
        setFrameFileTagsMap((prev) => ({ ...prev, [currentFrameFileId]: normalizeFrameExclusiveTags(tagsRaw) }))
      } catch {
        if (!canceled) setFrameFileTagsMap((prev) => ({ ...prev, [currentFrameFileId]: [] }))
      } finally {
        if (!canceled) setFrameFileTagsLoading(false)
      }
    })()
    return () => {
      canceled = true
    }
  }, [currentFrameFileId, frameFileTagsMap])

  const updateCurrentFrameFileTags = useCallback(
    async (nextTags: string[]) => {
      if (!currentFrameFileId) return
      const cleaned = Array.from(
        new Set(
          (nextTags || [])
            .map((x) => String(x ?? '').trim())
            .filter((x) => x.length > 0),
        ),
      )
      const normalized = normalizeFrameExclusiveTags(cleaned)
      setFrameFileTagsLoading(true)
      setFrameFileTagsMap((prev) => ({ ...prev, [currentFrameFileId]: normalized }))
      try {
        await StudioFilesService.updateFileMetaApiV1StudioFilesFileIdPatch({
          fileId: currentFrameFileId,
          requestBody: { tags: normalized } as any,
        })
      } catch {
        message.error('更新标签失败')
      } finally {
        setFrameFileTagsLoading(false)
      }
    },
    [currentFrameFileId],
  )

  // 选中分镜后若开启「自动展开画面预览」：默认展开（尤其是未就绪分镜）
  useEffect(() => {
    if (!selectedShot) return
    if (!prefs.autoOpenInspector) return
    if (prefs.inspectorOpen) return
    // “若无视频则自动展开”：这里用 status !== ready 作为近似判定
    if (selectedShot.status !== 'ready') {
      setPrefs((p) => ({ ...p, inspectorOpen: true }))
    }
  }, [prefs.autoOpenInspector, prefs.inspectorOpen, selectedShot, setPrefs])

  /**
   * 进入工作室时，如果检查器是折叠的，先自动展开一次。
   *
   * 为什么：现在工作室的**步骤内容全在右侧检查器里**（视频提示词 / 资产与声音检查 / 生成与交付
   * 的页签与按钮），而上面那条「无视频才展开」的规则在镜头都达到 ready、且已生成视频后会
   * 判定为"不需要展开"——结果用户进来只看到主预览，找不到提示词编辑与绑定入口，
   * 只能点别处乱跳。这里保证首次进入一定看得到本步骤的界面；用户之后仍可手动收起。
   */
  const studioStepAutoOpenedRef = useRef(false)
  useEffect(() => {
    if (studioStepAutoOpenedRef.current) return
    studioStepAutoOpenedRef.current = true
    if (!prefs.inspectorOpen) {
      setPrefs((p) => ({ ...p, inspectorOpen: true }))
    }
  }, [prefs.inspectorOpen, setPrefs])

  const lastSavedDetailRef = useRef<ShotDetailRead | null>(null)

  const patchShotDetailLocal = (patch: Partial<ShotDetailRead>) => {
    setShotDetail((prev) => (prev ? { ...prev, ...patch } : prev))
  }

  const patchShotDetailImmediate = async (patch: Partial<ShotDetailRead>) => {
    if (!selectedShotId) return
    patchShotDetailLocal(patch)
    setCameraUpdating(true)
    const seq = ++cameraPatchSeqRef.current
    try {
      const r: any = await StudioShotDetailsService.updateShotDetailApiV1StudioShotDetailsShotIdPatch({
        shotId: selectedShotId,
        requestBody: patch as any,
      })
      if (seq !== cameraPatchSeqRef.current) return
      if (r.data) {
        setShotDetail(r.data)
        lastSavedDetailRef.current = r.data
        if (r.data.duration != null) {
          setShotDurations((m) => ({ ...m, [selectedShotId]: r.data?.duration ?? 0 }))
        }
      }
    } catch {
      if (seq !== cameraPatchSeqRef.current) return
      message.error('镜头参数更新失败')
    } finally {
      if (seq === cameraPatchSeqRef.current) setCameraUpdating(false)
    }
  }

  // 自动保存（防抖）：shotDetail 变更后 PATCH 到后端
  useEffect(() => {
    if (!selectedShotId || !shotDetail) return
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    setSaving(true)
    saveTimerRef.current = window.setTimeout(() => {
      const prev = lastSavedDetailRef.current
      const next = shotDetail
      const patch: Record<string, unknown> = {}
      const assignIfChanged = <K extends keyof ShotDetailRead>(key: K) => {
        if (prev?.[key] !== next[key]) patch[key] = next[key] ?? null
      }
      assignIfChanged('scene_id')
      // 镜头语言字段（camera_shot/angle/movement/duration）走即时更新，不在此处防抖提交
      // array / object fields
      if (JSON.stringify(prev?.mood_tags ?? null) !== JSON.stringify(next.mood_tags ?? null)) patch.mood_tags = next.mood_tags ?? null
      assignIfChanged('atmosphere')
      assignIfChanged('follow_atmosphere')
      assignIfChanged('has_bgm')
      assignIfChanged('override_video_ratio')
      assignIfChanged('vfx_type')
      assignIfChanged('vfx_note')
      assignIfChanged('first_frame_prompt')
      assignIfChanged('key_frame_prompt')
      assignIfChanged('last_frame_prompt')

      const keys = Object.keys(patch)
      if (keys.length === 0) {
        setSaving(false)
        saveTimerRef.current = null
        return
      }

      void StudioShotDetailsService.updateShotDetailApiV1StudioShotDetailsShotIdPatch({
        shotId: selectedShotId,
        requestBody: patch as any,
      })
        .then((r: any) => {
          if (r.data) {
            setShotDetail(r.data)
            lastSavedDetailRef.current = r.data
            if (r.data.duration != null) {
              setShotDurations((m) => ({ ...m, [selectedShotId]: r.data?.duration ?? 0 }))
            }
          }
        })
        .catch(() => {
          message.error('自动保存失败')
        })
        .finally(() => {
          setSaving(false)
          saveTimerRef.current = null
        })
    }, 1000)
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
  }, [selectedShotId, shotDetail])

  // 播放器：同步时间与状态
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onTimeUpdate = () => setVideoTime(v.currentTime || 0)
    const onLoaded = () => setVideoDuration(v.duration || 0)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('timeupdate', onTimeUpdate)
    v.addEventListener('loadedmetadata', onLoaded)
    return () => {
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('timeupdate', onTimeUpdate)
      v.removeEventListener('loadedmetadata', onLoaded)
    }
  }, [selectedShotId])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.playbackRate = playbackRate
  }, [playbackRate])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    v.loop = loopCurrent
  }, [loopCurrent])

  useEffect(() => {
    const v = videoRef.current
    if (!v || !currentPreviewVideoUrl) return
    v.load()
    void v.play().catch(() => {
      // 浏览器策略可能阻止自动播放，保留静默失败
    })
  }, [currentPreviewVideoUrl])

  // 快捷键：←/→ 切换分镜，Space 播放暂停，P/Ctrl+I 面板，H 隐藏，M 合并，Ctrl/Cmd+Enter 保存并生成
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      const key = e.key.toLowerCase()

      if (key === 'p' || (key === 'i' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault()
        setPrefs((p) => ({ ...p, inspectorOpen: !p.inspectorOpen }))
        return
      }

      if (key === ' ') {
        e.preventDefault()
        const v = videoRef.current
        if (!v) return
        if (v.paused) void v.play()
        else v.pause()
        return
      }

      if (key === 'arrowleft' || key === 'arrowright') {
        e.preventDefault()
        const visible = shots.filter((s) => !s.hidden)
        const idx = visible.findIndex((s) => s.id === selectedShotId)
        if (idx === -1) return
        const next = key === 'arrowleft' ? visible[idx - 1] : visible[idx + 1]
        if (next) setSelectedShotId(next.id)
        return
      }

      if ((e.ctrlKey || e.metaKey) && key === 'enter') {
        e.preventDefault()
        void generateFrameImageTask()
        return
      }

      if (key === 'h') {
        e.preventDefault()
        if (!selectedShotId) return
        toggleHiddenShots([selectedShotId])
        return
      }

      if (key === 'm') {
        e.preventDefault()
        if (selectedShotIds.length < 2) {
          message.info('请先多选至少 2 个分镜再合并')
          return
        }
        Modal.confirm({
          title: `合并 ${selectedShotIds.length} 个分镜？`,
          content: '将它们合并为一个新的分镜（Mock 行为）。',
          okText: '合并',
          cancelText: '取消',
          onOk: () => {
            message.success('已合并（Mock）')
          },
        })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedShotId, selectedShotIds.length, shots, setPrefs])

  const getShotReadinessFlags = useCallback((shot: StudioShot) => {
    const runtime = shotRuntimeMap[shot.id]
    const isReady = !shot.hidden && shot.status === 'ready'
    const isGenerating = !shot.hidden && Boolean(runtime?.has_active_tasks)
    const isPendingConfirm = !shot.hidden && shot.status === 'pending'
    const hasProblem = Boolean(shot.hasProblem)
    const missing: string[] = []
    if (isPendingConfirm) missing.push('待确认')
    if (isGenerating) missing.push('生成中')
    return {
      isReady,
      isGenerating,
      isPendingConfirm,
      hasProblem,
      missing,
    }
  }, [shotRuntimeMap])

  const chapterTitle = useMemo(() => {
    if (!chapter) return '章节生成工作台'
    return `第${chapter.index}章 · ${chapter.title.replace(/^第\d+[集章：:\s]*/g, '').trim() || chapter.title}`
  }, [chapter])

  /**
   * 每镜就绪（同一份判定：`evaluateShotReadiness`），供状态文案使用。
   * 这里只做「取数 + 调用同一函数」，不重写任何生成/导出口径。
   */
  const shotReadinessById = useMemo(() => {
    const boardById = new Map(readinessRows.map((item) => [String(item.shot_id), item]))
    const deliveryById = new Map(episodeRows.map((row) => [String(row.shot_id), row]))
    const map = new Map<string, ShotReadiness>()
    for (const shot of shots) {
      const boardRow = boardById.get(shot.id) as
        | { required_frame_types?: string[]; usable_frame_types?: string[]; unusable_frame_types?: string[] }
        | undefined
      const required = boardRow?.required_frame_types ?? []
      const usable = new Set(boardRow?.usable_frame_types ?? [])
      const row =
        deliveryById.get(shot.id) ??
        ({
          shot_id: shot.id,
          shot_code: String(shot.index),
          shot_title: shot.title,
          video_prompt: '',
          video_prompt_source: '',
          exportable: false,
          bound_files: [],
        } as PromptDeliveryRowLike)
      map.set(
        shot.id,
        evaluateShotReadiness({
          row,
          requiredFrameTypes: required,
          usableFrameTypes: Array.from(usable),
          unusableFrameTypes: boardRow?.unusable_frame_types ?? [],
          planReady: true,
        }),
      )
    }
    return map
  }, [episodeRows, readinessRows, shots])

  /** 每镜的业务状态文案（左侧列表用）：待确认资产候选 / 待保存视频提示词 / 待绑定素材 / 缺少首帧… */
  const shotStatusById = useMemo(() => {
    const boardById = new Map(readinessRows.map((item) => [String(item.shot_id), item]))
    const map = new Map<string, ShotStatusText>()
    for (const shot of shots) {
      const boardRow = boardById.get(shot.id) as
        | { required_frame_types?: string[]; usable_frame_types?: string[]; unusable_frame_types?: string[] }
        | undefined
      const required = boardRow?.required_frame_types ?? []
      const usable = new Set(boardRow?.usable_frame_types ?? [])
      const readiness = shotReadinessById.get(shot.id)
      if (!readiness) continue
      map.set(
        shot.id,
        resolveShotStatus({
          readiness,
          missingFrames: required.filter((frame: string) => !usable.has(frame)),
          blockedFrames: boardRow?.unusable_frame_types ?? [],
          extractionPending: shot.status === 'pending' && !shot.skip_extraction,
          generating: Boolean(shotRuntimeMap[shot.id]?.has_active_tasks),
          generated: Boolean(shot.generated_video_file_id),
        }),
      )
    }
    return map
  }, [readinessRows, shotReadinessById, shotRuntimeMap, shots])

  /** 还没选镜头时的中性状态（工作区头部用；不谎称任何就绪度） */
  const statusForSelectedShot: ShotStatusText = selectedShotId
    ? shotStatusById.get(selectedShotId) ?? NOT_SELECTED_STATUS
    : NOT_SELECTED_STATUS

  const filteredShots = useMemo(() => {
    const list = shots.slice().sort((a, b) => a.index - b.index)
    switch (filter) {
      case 'pendingConfirm':
        return list.filter((s) => getShotReadinessFlags(s).isPendingConfirm)
      case 'generating':
        return list.filter((s) => getShotReadinessFlags(s).isGenerating)
      case 'ready':
        return list.filter((s) => getShotReadinessFlags(s).isReady)
      case 'hidden':
        return list.filter((s) => Boolean(s.hidden))
      case 'problem':
        return list.filter((s) => !s.hidden && Boolean(s.hasProblem))
      default:
        return list
    }
  }, [filter, getShotReadinessFlags, shots])

  const shotFilterCounts = useMemo(() => {
    const list = shots.slice()
    return {
      all: list.length,
      pendingConfirm: list.filter((s) => getShotReadinessFlags(s).isPendingConfirm).length,
      generating: list.filter((s) => getShotReadinessFlags(s).isGenerating).length,
      ready: list.filter((s) => getShotReadinessFlags(s).isReady).length,
      hidden: list.filter((s) => Boolean(s.hidden)).length,
      problem: list.filter((s) => !s.hidden && Boolean(s.hasProblem)).length,
    } satisfies Record<ShotFilter, number>
  }, [getShotReadinessFlags, shots])

  const multiToolbarVisible = selectedShotIds.length > 1

  const handleSelectShot = (shotId: string, indexInFiltered: number, e: React.MouseEvent) => {
    setSelectedShotId(shotId)
    const isRange = e.shiftKey && lastSelectedIndexRef.current >= 0
    const isToggle = e.ctrlKey || e.metaKey

    if (isRange) {
      const start = Math.min(lastSelectedIndexRef.current, indexInFiltered)
      const end = Math.max(lastSelectedIndexRef.current, indexInFiltered)
      const rangeIds = filteredShots.slice(start, end + 1).map((s) => s.id)
      setSelectedShotIds(Array.from(new Set([...selectedShotIds, ...rangeIds])))
      return
    }

    if (isToggle) {
      setSelectedShotIds((prev) => (prev.includes(shotId) ? prev.filter((id) => id !== shotId) : [...prev, shotId]))
      lastSelectedIndexRef.current = indexInFiltered
      return
    }

    setSelectedShotIds([shotId])
    lastSelectedIndexRef.current = indexInFiltered
  }

  const matchesFilter = (s: StudioShot, f: ShotFilter) => {
    const flags = getShotReadinessFlags(s)
    switch (f) {
      case 'pendingConfirm':
        return flags.isPendingConfirm
      case 'generating':
        return flags.isGenerating
      case 'ready':
        return flags.isReady
      case 'hidden':
        return Boolean(s.hidden)
      case 'problem':
        return !s.hidden && flags.hasProblem
      default:
        return true
    }
  }

  const reorderWithinFilter = (sourceId: string, destId: string) => {
    if (sourceId === destId) return
    setShots((prev) => {
      const ordered = prev.slice().sort((a, b) => a.index - b.index)
      const subset = ordered.filter((s) => matchesFilter(s, filter))
      const sourceIndex = subset.findIndex((s) => s.id === sourceId)
      const destIndex = subset.findIndex((s) => s.id === destId)
      if (sourceIndex === -1 || destIndex === -1) return prev
      const movedSubset = reorder(subset, sourceIndex, destIndex)
      const movedQueue = [...movedSubset]
      const replaced = ordered.map((s) => (matchesFilter(s, filter) ? (movedQueue.shift() as StudioShot) : s))
      const next = replaced.map((s, idx) => ({ ...s, index: idx + 1 }))

      // 后台同步排序（不阻塞 UI）
      const beforeMap = new Map(prev.map((s) => [s.id, s.index]))
      void (async () => {
        try {
          const changed = next.filter((s) => beforeMap.get(s.id) !== s.index)
          await Promise.all(
            changed.map((s) =>
              StudioShotsService.updateShotApiV1StudioShotsShotIdPatch({
                shotId: s.id,
                requestBody: { index: s.index },
              }),
            ),
          )
        } catch {
          message.error('同步排序失败')
        }
      })()

      return next
    })
  }

  const shotContextMenu = (shot: StudioShot) => ([
    {
      key: 'copy',
      icon: <LinkOutlined />,
      label: '复制分镜',
      onClick: () => message.success('已复制（Mock）'),
    },
    {
      key: 'insert_after',
      icon: <VideoCameraAddOutlined />,
      label: '在后插入新分镜',
      onClick: () => message.success('已插入（Mock）'),
    },
    {
      key: 'transition',
      icon: <ScissorOutlined />,
      label: '设为转场点',
      onClick: () => message.success('已设置（Mock）'),
    },
    { type: 'divider' as const },
    {
      key: 'toggle_hide',
      icon: shot.hidden ? <EyeOutlined /> : <EyeInvisibleOutlined />,
      label: shot.hidden ? '取消隐藏' : '隐藏',
      onClick: () => toggleHiddenShots([shot.id]),
    },
    {
      key: 'delete',
      icon: <DeleteOutlined />,
      danger: true,
      label: '删除',
      onClick: () =>
        Modal.confirm({
          title: '删除分镜？',
          content: '此操作不可撤销。',
          okText: '删除',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: async () => {
            try {
              await StudioShotsService.deleteShotApiV1StudioShotsShotIdDelete({ shotId: shot.id })
              await loadShots()
              message.success('已删除')
            } catch {
              message.error('删除失败')
            }
          },
        }),
    },
  ])

  const batchMenuItems = [
    {
      key: 'merge',
      icon: <MergeCellsOutlined />,
      label: '合并',
      disabled: selectedShotIds.length < 2,
      onClick: () => {
        if (selectedShotIds.length < 2) return
        Modal.confirm({
          title: `合并 ${selectedShotIds.length} 个分镜？`,
          okText: '合并',
          cancelText: '取消',
          onOk: () => message.success('已合并（Mock）'),
        })
      },
    },
    {
      key: 'hide',
      icon: <EyeInvisibleOutlined />,
      label: '隐藏',
      onClick: () => toggleHiddenShots(selectedShotIds),
    },
    {
      key: 'delete',
      icon: <DeleteOutlined />,
      danger: true,
      label: '删除',
      onClick: () =>
        Modal.confirm({
          title: `删除 ${selectedShotIds.length} 个分镜？`,
          okText: '删除',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: async () => {
            try {
              await Promise.all(selectedShotIds.map((id) => StudioShotsService.deleteShotApiV1StudioShotsShotIdDelete({ shotId: id })))
              await loadShots()
              message.success('已删除')
            } catch {
              message.error('删除失败')
            }
          },
        }),
    },
    { type: 'divider' as const },
    {
      key: 'skip-extraction',
      icon: <StopOutlined />,
      danger: true,
      label: '维护：标记无需提取',
      onClick: () =>
        Modal.confirm({
          title: `确认以维护方式将 ${selectedShotIds.length} 个分镜标记为无需提取？`,
          content: '这属于准备阶段的维护性调整。标记后这些分镜会直接按“提取确认已完成”处理。',
          okText: '确认',
          okButtonProps: { danger: true, loading: batchSkipExtractionUpdating },
          cancelText: '取消',
          cancelButtonProps: { disabled: batchSkipExtractionUpdating },
          onOk: () => batchUpdateSkipExtraction(true),
        }),
    },
    {
      key: 'restore-extraction',
      icon: <UndoOutlined />,
      label: '维护：恢复提取',
      disabled: batchSkipExtractionUpdating,
      onClick: () => batchUpdateSkipExtraction(false),
    },
  ]
  /** 多选时只留维护动作（合并/隐藏/删除/提取维护）：工作室不做批量生成与批量导入。 */
  const batchMaintenanceMenuItems = batchMenuItems

  const toolbarSettingsItems = [
    {
      key: 'advanced',
      icon: <SettingOutlined />,
      label: '高级设置（维护）',
      onClick: () => setAdvancedSettingsOpen(true),
    },
    { type: 'divider' as const },
    {
      key: 'autoOpen',
      icon: <SettingOutlined />,
      label: (
        <div className="flex items-center justify-between gap-3">
          <span>选中分镜自动展开</span>
          <Switch
            size="small"
            checked={prefs.autoOpenInspector}
            onChange={(v) => setPrefs((p) => ({ ...p, autoOpenInspector: v }))}
          />
        </div>
      ),
    },
  ]

  const subtitleLines = useMemo(() => {
    if (!selectedShot || dialogLines.length === 0) return []
    const dur = Math.max(1, shotDetail?.duration ?? shotDurations[selectedShot.id] ?? 1)
    const per = dur / dialogLines.length
    return dialogLines.map((d, i) => ({
      key: `${selectedShot.id}-${d.id}`,
      role: d.speaker_character_id ?? '—',
      text: d.text,
      start: i * per,
      end: (i + 1) * per,
    }))
  }, [dialogLines, selectedShot, shotDetail?.duration, shotDurations])

  const activeSubtitleIndex = useMemo(() => {
    if (!selectedShot || subtitleLines.length === 0) return -1
    const t = videoTime
    return subtitleLines.findIndex((l) => t >= l.start && t < l.end)
  }, [selectedShot, subtitleLines, videoTime])

  const navigate = useNavigate()
  /** 「高级设置（维护）」弹窗：入口在容器右上角的设置菜单里 */
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false)

  /*
   * ---------------- 工作室阶段（第 3–5 步共用容器）的状态 ----------------
   *
   * 阶段**由外层（本组件）持有**：阶段条、URL 参数（`?studio=`）、中栏面板与左栏摘要是同一个值。
   * 初始值来自 URL，因此从项目工作台第 3/4/5 步跳进来会直接落在对应阶段，刷新后也停在同一个阶段。
   */
  const [studioStepKey, setStudioStepKey] = useState<StudioStepKey>(
    () => readStudioUrlState(window.location.search).phase,
  )

  /**
   * 切阶段只改「工作室阶段」与 URL：**当前镜头不动，已选镜头集合也不动**。
   *
   * - 写 URL 走 `buildStudioSearch`（只动 `studio` / `shot`，其它参数原样保留）；
   * - 用 push 而不是 replace：任务书要求「浏览器前进、后退行为正确」——每次换阶段都应能退回来；
   *   同一阶段重复点击是 no-op。
   */
  const handleStudioStepChange = (next: StudioStepKey) => {
    if (next === studioStepKey) return
    setStudioStepKey(next)
    const search = buildStudioSearch(window.location.search, { phase: next })
    navigate({ pathname: window.location.pathname, search }, { replace: false })
  }

  /**
   * 本镜资产总览（只读）。
   *
   * **由外层持有**：底部胶片条、左栏「引用素材」、阶段 4 核对表读的是同一份，
   * 因此在哪一处都不会出现"这张卡说已关联、核对表说缺"的分叉。
   */
  const [shotAssetsOverview, setShotAssetsOverview] = useState<ShotAssetsOverviewRead | null>(null)
  const shotAssetsOverviewRequestSeqRef = useRef(0)

  const loadShotAssetsOverview = useCallback(async (shotId: string) => {
    const reqSeq = ++shotAssetsOverviewRequestSeqRef.current
    try {
      const res = await StudioShotsService.getShotAssetsOverviewApiApiV1StudioShotsShotIdAssetsOverviewGet({
        shotId,
      })
      if (reqSeq !== shotAssetsOverviewRequestSeqRef.current) return
      setShotAssetsOverview(res.data ?? null)
    } catch {
      if (reqSeq !== shotAssetsOverviewRequestSeqRef.current) return
      setShotAssetsOverview(null)
    }
  }, [])

  useEffect(() => {
    if (!selectedShotId) {
      shotAssetsOverviewRequestSeqRef.current += 1
      setShotAssetsOverview(null)
      return
    }
    void loadShotAssetsOverview(selectedShotId)
    /* 依赖里带候选：确认/忽略候选之后资产总览必须跟着重算（与改造前同一条件）。 */
  }, [loadShotAssetsOverview, selectedShotId, shotCandidateItems])

  /*
   * 底部胶片条的勾选与「批量维护」的多选**合并成同一份** `selectedShotIds`：
   * 两份并存的后果是"勾了要下载、维护菜单却说没选"这种自相矛盾的界面。
   * 「当前镜头」仍是独立状态（`selectedShotId`）—— 勾选**不会**切换当前镜头。
   */

  /** 各资产类型的出图口径（含**按类型的画面比例**）：只读读口，读不到就不显示比例。 */
  const assetStrategies = useAssetStrategies()

  /** 每镜已关联的资产项数（胶片条副行与交付页共用，避免两处各算一遍）。 */
  const shotAssetLinkCountById = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of episodeRows) {
      const count = Object.values(row.bound_assets ?? {}).reduce(
        (sum, list) => sum + (list?.length ?? 0),
        0,
      )
      map.set(String(row.shot_id), count)
    }
    return map
  }, [episodeRows])

  /**
   * 去第 2 步（带上页签）。
   *
   * 素材与角色声音的唯一编辑入口都在第 2 步：工作室这边只给"去哪里补"，
   * 不在本页开第二个编辑入口（设计包 §10 的硬约束）。
   */
  const goAssetPrepWithTab = useCallback(
    (tab: string) => {
      if (!projectId) return
      navigate(`/projects/${projectId}?step=extract_assets&tab=${encodeURIComponent(tab)}`)
    },
    [navigate, projectId],
  )

  /** 单镜下载：直接下载这一镜**实际生成好的那份成片**（不是临时候选）。 */
  const downloadSingleShotVideo = useCallback(
    (shotId: string) => {
      const shot = shots.find((item) => item.id === shotId)
      const fileId = shot?.generated_video_file_id
      if (!fileId) {
        void message.warning('这一镜还没有可下载的成片，先生成成功后再下载。')
        return
      }
      const url = buildFileDownloadUrl(String(fileId))
      if (!url) {
        void message.error('这一镜的成片地址暂时取不到，请稍后重试。')
        return
      }
      // 用 <a download> 触发浏览器下载（不是 window.open 打开一个页面）
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${railShotCode(shot?.index ?? 0)}-${shot?.title ?? '成片'}.mp4`
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
    },
    [shots],
  )

  /**
   * 批量下载（**唯一实现**）：底部胶片条与阶段 5 的「下载所选成片」都调它。
   *
   * 真正打包在后端（流式 ZIP，只含生成成功的成片 + 一份交付清单）；
   * 前端不做"逐个打开下载窗口"那种假批量。
   */
  const downloadSelectedBundle = useCallback(async () => {
    if (!projectId) {
      await message.warning('还没有读到项目信息，暂时不能打包下载')
      return
    }
    if (selectedShotIds.length === 0) {
      await message.warning('还没有勾选镜头。请在底部分镜列表里勾选，或用「全选」一键勾上所有已有成片的镜头。')
      return
    }
    try {
      const result = await downloadVideoBundleZip({
        projectId,
        scope: 'episode',
        chapterId,
        shotIds: selectedShotIds,
      })
      await message.success(
        result.excluded > 0
          ? `已打包下载 ${result.included} 条成片（另有 ${result.excluded} 个镜头没有可交付成片，未包含）：${result.filename}`
          : `已打包下载 ${result.included} 条成片：${result.filename}`,
      )
    } catch (error) {
      await message.error(toUserFacingText(error, '打包下载失败，请稍后重试'))
    }
  }, [projectId, chapterId, selectedShotIds])

  /** 交付清单 TXT（与「实际使用的文件」同一份数据；后端既有出口，纯读不花钱）。 */
  const downloadDeliveryManifest = useCallback(() => {
    if (!projectId) return
    void downloadDeliveryTxt(projectId, chapterId ?? null, selectedShotIds)
      .then((result) => message.success(`已下载交付清单：${result.filename}（${result.bytes} 字节）`))
      .catch((error) => void message.error(toUserFacingText(error, '导出失败')))
  }, [projectId, chapterId, selectedShotIds])

  /**
   * 「当前镜头」进 URL（`?shot=`）：刷新 / 复制链接 / 重新进入都能恢复同一镜。
   *
   * 这是**正式业务状态**（任务书第三部分明说不能只靠 localStorage）：
   * 项目与章节来自路由段，阶段与镜头来自查询参数，三者合起来就是全部要恢复的业务状态。
   */
  useEffect(() => {
    const fromUrl = readStudioUrlState(location.search).shotId
    if (!fromUrl) return
    if (!shots.some((shot) => shot.id === fromUrl)) return
    setSelectedShotId((current) => (current === fromUrl ? current : fromUrl))
  }, [shots, location.search])

  useEffect(() => {
    if (!selectedShotId) return
    const current = readStudioUrlState(location.search).shotId
    if (current === selectedShotId) return
    const search = buildStudioSearch(location.search, { shotId: selectedShotId })
    // replace：切换镜头不该把浏览器的返回栈塞满（阶段切换才用 push）
    navigate({ pathname: location.pathname, search }, { replace: true })
  }, [selectedShotId, location.search, location.pathname, navigate])

  /**
   * **阶段跟着 URL 走**（这一条是「浏览器前进 / 后退行为正确」的关键）。
   *
   * 只把初始值读一次是不够的：用户点后退时 URL 变了、React 状态没变，
   * 表现就是"后退按钮按了没反应"。所以这里订阅 `location.search`，
   * 让阶段与镜头始终是 URL 的函数 —— 深链、刷新、前进后退三种入口共用同一条恢复路径。
   */
  useEffect(() => {
    const fromUrl = readStudioUrlState(location.search).phase
    setStudioStepKey((current) => (current === fromUrl ? current : fromUrl))
  }, [location.search])

  /*
   * ---------------- 分镜工作室（第 3–5 步共用容器） ----------------
   *
   * 容器结构（设计包第 11 页）：顶部项目上下文 + 常驻五步条 + 工作室阶段条，
   * 主体「左引用素材 / 中当前阶段 / 右本镜预览」，底部横向滑动的分镜胶片条。
   *
   * **切换阶段不离开本容器**：只换中栏，当前镜头、已选集合与各阶段滚动位置都保持。
   */
  const studioPhaseMeta = getStudioPhase(studioStepKey)
  const studioStepIndex = globalStepIndexForProjectStep(studioPhaseMeta.projectStepKey)
  const studioNextPhase = getNextStudioPhase(studioStepKey)
  const studioShotLabel = selectedShot
    ? `${String(selectedShot.index).padStart(2, '0')} · ${selectedShot.title}`
    : ''

  /**
   * 胶片条卡片：**同一份判定**同时供底部胶片条、阶段 4 核对与阶段 5 交付使用。
   *
   * 「可交付」的判据只有一个：镜头上有**生成成功并已落库**的成片文件。
   * 失败与半成品不会落库（后端只在成功时写入），因此天然进不了交付包 ——
   * 页面不需要（也不许）另立一套判定。
   */
  const railShots: RailShotView[] = useMemo(() => {
    const fallbackRatio = projectDefaultVideoRatio || capabilityDefaultVideoRatio || ''
    return filteredShots.map((s) => {
      const businessStatus = shotStatusById.get(s.id) ?? NOT_SELECTED_STATUS
      const flags = getShotReadinessFlags(s)
      const hasVideo = Boolean(s.generated_video_file_id)
      const duration = shotDurations[s.id]
      const tone: RailShotView['statusTone'] = flags.isGenerating
        ? 'info'
        : hasVideo
          ? 'success'
          : businessStatus.tone === 'red'
            ? 'danger'
            : businessStatus.tone === 'gold'
              ? 'warning'
              : 'neutral'
      const metaParts = [
        duration ? `${duration}s` : '',
        fallbackRatio,
        hasVideo ? `素材 ${shotAssetLinkCountById.get(s.id) ?? 0} 项` : businessStatus.nextAction,
      ].filter(Boolean)
      return {
        id: s.id,
        index: s.index,
        code: railShotCode(s.index),
        title: s.title,
        thumbnail: s.thumbnail ? resolveAssetUrl(s.thumbnail) ?? '' : '',
        statusLabel: hasVideo ? '已成片' : businessStatus.label,
        statusTone: tone,
        meta: metaParts.join(' · '),
        hasDeliverableVideo: hasVideo,
        blockedReason: hasVideo ? '' : businessStatus.nextAction,
      }
    })
  }, [
    filteredShots,
    shotStatusById,
    getShotReadinessFlags,
    shotDurations,
    shotAssetLinkCountById,
    projectDefaultVideoRatio,
    capabilityDefaultVideoRatio,
    resolveAssetUrl,
  ])

  /** 左栏「引用素材」：只读展示本镜实际关联到的资产（首/关键/尾帧是用途，不单独成条）。 */
  const studioMaterialItems = useMemo(() => {
    const items = shotAssetsOverview?.items ?? []
    return items
      .filter((item) => item.source !== 'candidate')
      .map((item) => ({
        key: item.key,
        type: item.type,
        name: item.name,
        typeLabel: ASSET_TYPE_LABEL[item.type] ?? '资产',
        thumbnail: item.thumbnail ? resolveAssetUrl(item.thumbnail) ?? '' : '',
        ratio: ratioFor(assetStrategies, item.type),
      }))
  }, [shotAssetsOverview, assetStrategies, resolveAssetUrl])

  /**
   * 阶段 4 / 5 的区块（交给 `StudioPhasePanel` 渲染）。
   *
   * 数据全部来自**同一份**逐镜判定（`railShots`）与既有的只读接口，
   * 因此不会出现"胶片条说可交付、交付页说还差一镜"这种互相打架的口径。
   */
  const studioPhaseExtras: StudioPhaseExtras = useMemo(() => {
    const goAssetPrep = (tab: string) => goAssetPrepWithTab(tab)
    /*
     * 「本集已关联资产的镜头数」按**交付清单的绑定结果**统计（与第 2 步同一份数据），
     * 不用成片状态凑数 —— 否则会出现"核对表逐行说没关联、汇总却说全都关联了"的自相矛盾。
     */
    const linkedShotCount = episodeRows.filter(
      (row) =>
        Object.values(row.bound_assets ?? {}).reduce((sum, list) => sum + (list?.length ?? 0), 0) > 0,
    ).length
    return {
      checklist: (
        <ShotAssetChecklist
          items={shotAssetsOverview?.items ?? []}
          onGoAssetPrep={goAssetPrep}
          voicePanel={
            selectedShot ? (
              <ShotVoiceInheritancePanel
                shotId={selectedShot.id}
                projectId={projectId}
                chapterId={chapterId}
              />
            ) : (
              <span className="st-hint">先在底部「分镜列表」里选一条镜头，再核对它的角色声音继承结果。</span>
            )
          }
        />
      ),
      checkSummary: (
        <AssetCheckSummaryCard totalShots={railShots.length} linkedShots={linkedShotCount} />
      ),
      deliveryReadiness: (
        <DeliveryReadinessCard
          shots={railShots}
          onLocateFirstIncomplete={(shotId) => setSelectedShotId(shotId)}
        />
      ),
      deliveryTasks: (
        <DeliveryTasksCard
          shots={railShots}
          activeShotId={selectedShotId}
          downloadingShotId={null}
          onLocateShot={(shotId) => setSelectedShotId(shotId)}
          onRetryShot={(shotId) => {
            /* 单镜重试＝选中该镜 + 回到阶段 3 用同一套守卫重新提交（不假装自动重试）。 */
            setSelectedShotId(shotId)
            handleStudioStepChange('video_prompt')
            void message.info('已定位到这一镜：在「生成视频」里点一次即可重新提交（会按同一套预检与计费确认）。')
          }}
          onDownloadShot={(shotId) => downloadSingleShotVideo(shotId)}
        />
      ),
      deliveryDownload: (
        <DeliveryDownloadCard
          shots={railShots}
          selectedCount={selectedShotIds.length}
          onDownloadSelected={() => void downloadSelectedBundle()}
          onDownloadManifest={() => downloadDeliveryManifest()}
          manifestDisabled={!projectId || railShots.length === 0}
        />
      ),
    }
  }, [
    railShots,
    episodeRows,
    shotAssetsOverview,
    selectedShot,
    projectId,
    chapterId,
    selectedShotId,
    selectedShotIds,
    downloadSelectedBundle,
    downloadSingleShotVideo,
    downloadDeliveryManifest,
    goAssetPrepWithTab,
  ])

  const focusPreview = () => {
    const node = containerRef.current?.querySelector('.studio-preview')
    if (node instanceof HTMLElement) node.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  return (
    <div ref={containerRef} className="w-full h-full min-h-0">
      <StudioShell
        context={{
          projectId,
          chapterLabel: chapterTitle,
          stepText: `第 ${studioStepIndex + 1} 步 · ${studioPhaseMeta.stepLabel}（在分镜工作室里）`,
          saving,
          callCount: null,
          onBack: projectId ? () => navigate(`/projects/${projectId}?tab=chapters`) : undefined,
          actions: (
            <>
              <Dropdown menu={{ items: toolbarSettingsItems }} trigger={['click']}>
                <Button size="small" data-testid="studio-settings">
                  设置
                </Button>
              </Dropdown>
              <Tooltip title={prefs.inspectorOpen ? '隐藏本镜预览' : '显示本镜预览'}>
                <Button
                  size="small"
                  onClick={() => setPrefs((prev) => ({ ...prev, inspectorOpen: !prev.inspectorOpen }))}
                  data-testid="studio-toggle-preview"
                >
                  {prefs.inspectorOpen ? '隐藏预览' : '显示预览'}
                </Button>
              </Tooltip>
              {/* 全容器**唯一**的「流程下一步」主按钮：文案 / 禁用 / 点击都在这一处 */}
              <Button
                size="small"
                type="primary"
                onClick={() => (studioNextPhase ? handleStudioStepChange(studioNextPhase) : focusPreview())}
                data-testid="studio-continue"
              >
                {buildStudioContinueLabel(studioStepKey)}
              </Button>
            </>
          ),
        }}
        currentStepIndex={studioStepIndex}
        doneStepIndexes={Array.from({ length: studioStepIndex }, (_, i) => i)}
        onStepClick={(index, label) => {
          /* 原型口径：点非当前步骤**不移动高亮、不切换内容**，只说明它在哪完成。 */
          message.info(
            `第 ${index + 1} 步「${label}」在${index >= 2 ? '分镜工作室' : '项目工作台'}里完成；这里只显示进度，不切换页面。`,
          )
        }}
        phase={studioStepKey}
        onPhaseChange={handleStudioStepChange}
        currentShotLabel={studioShotLabel}
        side={
          <>
            <article className="st-card" data-testid="studio-materials">
              <div className="st-card__head">
                <span className="st-card__title">引用素材</span>
                <span className="st-tag">{`${studioMaterialItems.length} 项`}</span>
                <div className="st-card__right">
                  <Button size="small" onClick={() => goAssetPrepWithTab('roles')}>
                    去第 2 步编辑
                  </Button>
                </div>
              </div>
              <div className="st-card__body">
                {studioMaterialItems.length === 0 ? (
                  <div className="st-hint">
                    本镜还没有关联任何资产素材。到第 2 步「资产准备」里补齐后，它们会出现在这里，
                    并在分镜提示词里以引用的形式出现。
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {studioMaterialItems.map((item) => (
                      <article key={item.key} className="st-card" data-material-type={item.type}>
                        <div className="studio-railcard__media">
                          {item.thumbnail ? (
                            <img src={item.thumbnail} alt="" loading="lazy" />
                          ) : (
                            `${item.typeLabel}参考图`
                          )}
                        </div>
                        <div style={{ padding: '7px 8px', display: 'grid', gap: 4 }}>
                          <div style={{ fontSize: 12, fontWeight: 600 }} title={item.name}>
                            {item.name}
                          </div>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            <span className="st-chip">{item.typeLabel}</span>
                            {item.ratio ? <span className="st-chip">{item.ratio}</span> : null}
                          </div>
                          <div className="st-hint">已关联</div>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
                <div className="st-hint" style={{ marginTop: 8 }}>
                  首帧 / 关键帧 / 尾帧是素材的<b>用途</b>，不单独成条；它们在本镜的「生成视频」里核对。
                </div>
              </div>
            </article>

            <article className="st-card" data-testid="studio-voice-summary">
              <div className="st-card__head">
                <span className="st-card__title">资产与声音</span>
                <span className="st-tag">{studioStepKey === 'binding' ? '本阶段逐镜核对' : '只读摘要'}</span>
                <div className="st-card__right">
                  <Button size="small" onClick={() => goAssetPrepWithTab('roles')}>
                    去第 2 步
                  </Button>
                </div>
              </div>
              <div className="st-card__body">
                <div className="st-hint">
                  角色声音在<b>第 2 步的人物资产详情</b>里绑定与更换（全站唯一入口）。
                  本页只读展示继承结果与来源，不提供第二套选择 / 试听 / 更换 / 保存入口。
                </div>
              </div>
            </article>
          </>
        }
        center={
          <>
              <Inspector
                projectId={projectId}
                chapterId={chapterId}
                projectVisualStyle={projectVisualStyle}
                projectStyle={projectStyle}
                projectDefaultVideoRatio={projectDefaultVideoRatio}
                capabilityDefaultVideoRatio={capabilityDefaultVideoRatio}
                videoRatioOptions={videoRatioOptions}
                imageGenerationOptions={imageGenerationOptions}
                keyframeResolutionProfile={keyframeResolutionProfile}
                onChangeKeyframeResolutionProfile={setKeyframeResolutionProfile}
                loadingDetail={loadingDetail}
                shotDetail={shotDetail}
                dialogLines={dialogLines}
                frameImages={frameImages}
                sceneLinks={sceneLinks}
                propLinks={propLinks}
                costumeLinks={costumeLinks}
                shotCharacterLinks={shotCharacterLinks}
                shotDialogueCandidateItems={shotDialogueCandidateItems}
                cameraUpdating={cameraUpdating}
                promptAssetsUpdating={promptAssetsUpdating}
                onDeleteDialogLine={deleteDialogLine}
                onUpdatePromptScene={updatePromptScene}
                onUpdatePromptActors={updatePromptActors}
                onUpdatePromptProps={updatePromptProps}
                onUpdatePromptCostumes={updatePromptCostumes}
                selectedShot={selectedShot}
                onUpdateShotTitle={updateShotTitleInOps}
                onUpdateShotScriptExcerpt={updateShotScriptExcerptInOps}
                onDeleteShotOps={deleteShotFromOps}
                onPatchShotDetail={patchShotDetailLocal}
                onPatchShotDetailImmediate={patchShotDetailImmediate}
                onSelectPreviewVideo={setPreviewVideoFileId}
                onRefreshShotFrameImages={refreshShotFrameImages}
                keyframeImageModelId={keyframeImageModelId}
                onChangeKeyframeImageModelId={setKeyframeImageModelId}
                selectedShotIds={selectedShotIds}
                onAutoLocateShot={(shotId) => {
                  setSelectedShotId(shotId)
                  setSelectedShotIds([shotId])
                }}
                status={statusForSelectedShot}
                onShotDataChanged={() => void loadShots()}
                scopeRows={scopeRows}
                episodeRows={episodeRows}
                readinessRows={readinessRows}
                studioPhaseExtras={studioPhaseExtras}
                studioStepKey={studioStepKey}
                onStudioStepChange={handleStudioStepChange}
                shotAssetsOverview={shotAssetsOverview}
                onRefreshShotAssetsOverview={loadShotAssetsOverview}
                advancedSettingsOpen={advancedSettingsOpen}
                onCloseAdvancedSettings={() => setAdvancedSettingsOpen(false)}
              />
          </>
        }
        preview={
          <>
          <Card
            title={
              <div className="flex items-center gap-3 min-w-0">
                <span className="font-medium">主预览区</span>
                {selectedShot && (
                  <span className="text-xs text-gray-500 truncate">
                    当前分镜：{String(selectedShot.index).padStart(2, '0')} · {selectedShot.title}
                  </span>
                )}
              </div>
            }
            extra={
              <Space size="small">
                {showPreviewMinimizeButton && (
                  <Tooltip title="最小化预览（占位）">
                    <Button size="small" icon={<DoubleRightOutlined />} onClick={() => message.info('最小化预览（Mock）')} />
                  </Tooltip>
                )}
                <Tooltip title="截取当前帧（Mock）">
                  <Button size="small" icon={<ScissorOutlined />} onClick={() => message.success('已截取当前帧（Mock）')} />
                </Tooltip>
                <Tooltip title={currentPreviewVideoFileId ? '下载当前预览视频' : '暂无可下载视频'}>
                  <Button
                    size="small"
                    icon={<DownloadOutlined />}
                    disabled={!currentPreviewVideoFileId || !currentPreviewVideoUrl}
                    onClick={() => {
                      if (!currentPreviewVideoUrl) return
                      window.open(currentPreviewVideoUrl, '_blank', 'noopener,noreferrer')
                    }}
                  />
                </Tooltip>
              </Space>
            }
            className="cs-preview-card flex-1 min-h-0"
            styles={{ body: { height: '100%', minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 12 } }}
          >
            <div className="flex items-center justify-between gap-2">
              {showPreviewFrameSegmented ? (
                <Segmented
                  size="small"
                  value={frameTab}
                  onChange={(v) => setFrameTab(v as typeof frameTab)}
                  options={[
                    { label: '首帧', value: 'head' },
                    { label: '关键帧列表', value: 'keyframes' },
                    { label: '尾帧', value: 'tail' },
                    { label: '参考对比', value: 'compare' },
                  ]}
                />
              ) : (
                <div />
              )}
              <Space size="small">
                <Select
                  size="small"
                  value={playbackRate}
                  style={{ width: 86 }}
                  onChange={(v) => setPlaybackRate(v)}
                  options={[0.5, 1, 1.25, 1.5, 2].map((v) => ({ label: `${v}x`, value: v }))}
                />
                <Tooltip title="循环当前分镜">
                  <Switch size="small" checked={loopCurrent} onChange={setLoopCurrent} />
                </Tooltip>
                <Space size={4} className="max-w-[320px]">
                  <Radio.Group
                    size="small"
                    buttonStyle="solid"
                    disabled={!currentFrameFileId || frameFileTagsLoading}
                    value={currentFrameFileTags.includes(FRAME_FILE_TAG_ADOPT) ? FRAME_FILE_TAG_ADOPT : currentFrameFileTags.includes(FRAME_FILE_TAG_ABANDON) ? FRAME_FILE_TAG_ABANDON : ''}
                    onChange={(e) => {
                      const v = String(e?.target?.value ?? '')
                      const base = currentFrameFileTags.filter((t) => t !== FRAME_FILE_TAG_ADOPT && t !== FRAME_FILE_TAG_ABANDON)
                      if (!v) void updateCurrentFrameFileTags(base)
                      else void updateCurrentFrameFileTags([v, ...base])
                    }}
                  >
                    <Radio.Button value={FRAME_FILE_TAG_ADOPT}>采用</Radio.Button>
                    <Radio.Button value={FRAME_FILE_TAG_ABANDON}>废弃</Radio.Button>
                  </Radio.Group>
                  <Select
                    mode="tags"
                    size="small"
                    style={{ minWidth: 160, maxWidth: 220 }}
                    placeholder="自定义标签"
                    disabled={!currentFrameFileId || frameFileTagsLoading}
                    loading={frameFileTagsLoading}
                    value={currentFrameFileTags.filter((t) => t !== FRAME_FILE_TAG_ADOPT && t !== FRAME_FILE_TAG_ABANDON)}
                    onChange={(vals) => {
                      const base = Array.isArray(vals) ? (vals as any[]).map((v) => String(v)) : []
                      const keep =
                        currentFrameFileTags.find((t) => t === FRAME_FILE_TAG_ADOPT || t === FRAME_FILE_TAG_ABANDON) ?? null
                      void updateCurrentFrameFileTags(keep ? [keep, ...base] : base)
                    }}
                  />
                </Space>
                <Tooltip title="当前镜头数据">
                  <Tag className="m-0">
                    帧图 {frameImages.length} · 关联 {sceneLinks.length + actorImageLinks.length + propLinks.length + costumeLinks.length}
                  </Tag>
                </Tooltip>
              </Space>
            </div>

            <div className="flex-1 min-h-0 overflow-auto flex flex-col gap-8 pr-1">
              <div className="relative">
                <div className="cs-player-shell">
                  <div className="aspect-video bg-black rounded overflow-hidden flex items-center justify-center">
                  {/* Mock：没有真实视频源时仍可展示播放器结构 */}
                  <video
                    ref={videoRef}
                    className="w-full h-full object-contain"
                    controls={false}
                    muted
                    playsInline
                    preload="metadata"
                    src={currentPreviewVideoUrl || undefined}
                  />
                  {!selectedShot && (
                    <div className="absolute inset-0 flex items-center justify-center text-gray-400">
                      请选择分镜
                    </div>
                  )}
                  {selectedShot && !currentPreviewVideoUrl && selectedShot.status !== 'ready' && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Badge
                        status={shotRuntimeMap[selectedShot.id]?.has_active_tasks ? 'processing' : 'default'}
                        text={shotRuntimeMap[selectedShot.id]?.has_active_tasks ? '生成中…' : '未生成'}
                      />
                    </div>
                  )}
                  </div>
                </div>

                {/* 播放控制条 */}
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    size="small"
                    icon={<CaretLeftOutlined />}
                    onClick={() => message.info('帧退（Mock）')}
                  />
                  <Button
                    size="small"
                    type="primary"
                    icon={isPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                    onClick={() => {
                      const v = videoRef.current
                      if (!v) return
                      if (v.paused) void v.play()
                      else v.pause()
                    }}
                  >
                    {isPlaying ? '暂停' : '播放'}
                  </Button>
                  <Button
                    size="small"
                    icon={<CaretRightOutlined />}
                    onClick={() => message.info('帧进（Mock）')}
                  />
                  <div className="flex-1 min-w-0">
                    <Slider
                      tooltip={{ formatter: null }}
                      min={0}
                      max={Math.max(1, videoDuration || shotDetail?.duration || (selectedShotId ? shotDurations[selectedShotId] : 0) || 1)}
                      value={videoTime}
                      onChange={(v) => {
                        const vv = videoRef.current
                        if (!vv) return
                        vv.currentTime = Number(v)
                        setVideoTime(Number(v))
                      }}
                    />
                  </div>
                  <div className="text-xs text-gray-400 w-[110px] text-right">
                    {videoTime.toFixed(1)} / {Math.max(videoDuration || 0, shotDetail?.duration || (selectedShotId ? shotDurations[selectedShotId] : 0) || 0).toFixed(1)}s
                  </div>
                </div>

                {/* 对白字幕条 */}
                <div className="cs-subtitle mt-2 px-3 py-2">
                  {subtitleLines.length === 0 ? (
                    <div className="text-sm opacity-80">暂无对白字幕</div>
                  ) : (
                    <div className="flex flex-col gap-1">
                      {subtitleLines.map((l, idx) => {
                        const active = idx === activeSubtitleIndex
                        return (
                          <div
                            key={l.key}
                            className="cs-sub-line text-sm cursor-pointer"
                            style={{ opacity: active ? 1 : 0.6, fontWeight: active ? 600 : 400 }}
                            onClick={() => {
                              const v = videoRef.current
                              if (!v) return
                              v.currentTime = l.start
                              setVideoTime(l.start)
                            }}
                          >
                            <span style={{ opacity: 0.9 }}>{l.role}：</span>
                            <span>{l.text}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* 章节级时间轴（可折叠，固定在底部不参与滚动） */}
            {showChapterTimeline && (
              <div
                className="rounded border border-solid border-gray-200 flex-shrink-0 min-h-0 flex flex-col"
                style={{ background: 'var(--ant-color-bg-container)' }}
              >
                <div className="px-3 py-2 flex items-center justify-between flex-shrink-0">
                  <div className="text-sm font-medium">章节时间轴</div>
                  <Button
                    size="small"
                    type="text"
                    onClick={() => setPrefs((p) => ({ ...p, timelineCollapsed: !p.timelineCollapsed }))}
                  >
                    {prefs.timelineCollapsed ? '展开' : '折叠'}
                  </Button>
                </div>
                {!prefs.timelineCollapsed && (
                  <div className="px-3 pb-3 flex-shrink-0 overflow-hidden">
                    <div className="flex items-center gap-2 overflow-x-auto py-1 min-h-[32px]">
                      {shots
                        .slice()
                        .sort((a, b) => a.index - b.index)
                        .filter((s) => !s.hidden)
                        .map((s) => {
                          const active = s.id === selectedShotId
                          return (
                            <div
                              key={s.id}
                              className="shrink-0 cursor-pointer rounded"
                              style={{
                                width: clamp(18 + ((shotDurations[s.id] ?? 1) || 1) * 6, 24, 96),
                                height: 14,
                                background:
                                  shotRuntimeMap[s.id]?.has_active_tasks
                                    ? 'rgba(59,130,246,0.45)'
                                    : s.status === 'ready'
                                    ? 'rgba(34,197,94,0.45)'
                                    : 'rgba(156,163,175,0.45)',
                                outline: active ? '2px solid var(--ant-color-primary)' : '1px solid rgba(0,0,0,0.06)',
                              }}
                              title={`${String(s.index).padStart(2, '0')} · ${s.title}`}
                              onClick={() => setSelectedShotId(s.id)}
                            />
                          )
                        })}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      点击条块跳转分镜；隐藏分镜不参与预览
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>
          </>
        }
        rail={
          <>
            <div
              className="studio-rail__head"
              style={{ borderBottom: '1px solid var(--st-border)', paddingBottom: 8 }}
            >
              {loadingShots ? <span className="st-hint">镜头加载中…</span> : null}
              <Segmented
                size="small"
                value={filter}
                onChange={(v) => setFilter(v as ShotFilter)}
                options={[
                  { label: `全部 ${shotFilterCounts.all}`, value: 'all' },
                  { label: `待处理 ${shotFilterCounts.pendingConfirm}`, value: 'pendingConfirm' },
                  { label: `生成中 ${shotFilterCounts.generating}`, value: 'generating' },
                  { label: `已就绪 ${shotFilterCounts.ready}`, value: 'ready' },
                  { label: `隐藏 ${shotFilterCounts.hidden}`, value: 'hidden' },
                  { label: `有问题 ${shotFilterCounts.problem}`, value: 'problem' },
                ]}
              />
              {multiToolbarVisible ? (
                <ChapterStudioBatchToolbar
                  selectedCount={selectedShotIds.length}
                  maintenanceMenuItems={batchMaintenanceMenuItems}
                />
              ) : null}
            </div>
            <StudioShotRail
              shots={railShots}
              activeShotId={selectedShotId}
              selectedShotIds={selectedShotIds}
              onSelectedShotIdsChange={setSelectedShotIds}
              onSelectShot={handleSelectShot}
              onReorder={reorderWithinFilter}
              onShotContextMenu={(shotId) => {
                const target = shots.find((item) => item.id === shotId)
                return target ? shotContextMenu(target) : []
              }}
              projectId={projectId}
              chapterId={chapterId}
              phase={studioStepKey}
            />
          </>
        }
      />
    </div>
  )
}

export default ChapterStudio

function Inspector(props: {
  projectId?: string
  chapterId?: string
  projectVisualStyle: '现实' | '动漫'
  projectStyle: string
  projectDefaultVideoRatio: string
  capabilityDefaultVideoRatio: string
  videoRatioOptions: Array<{ value: string; label: React.ReactNode }>
  imageGenerationOptions: ImageGenerationOptionsRead | null
  keyframeResolutionProfile: KeyframeResolutionProfile
  onChangeKeyframeResolutionProfile: (value: KeyframeResolutionProfile) => void
  /** 关键帧用哪个图片模型（空 = 后端默认，通常是出图服务垫片的 image2）。 */
  keyframeImageModelId: string
  onChangeKeyframeImageModelId: (value: string) => void
  loadingDetail: boolean
  shotDetail: ShotDetailRead | null
  dialogLines: ShotDialogLineRead[]
  frameImages: ShotFrameImageRead[]
  sceneLinks: ProjectSceneLinkRead[]
  propLinks: ProjectPropLinkRead[]
  costumeLinks: ProjectCostumeLinkRead[]
  shotCharacterLinks: ShotCharacterLinkRead[]
  shotDialogueCandidateItems: ShotExtractedDialogueCandidateRead[]
  cameraUpdating: boolean
  promptAssetsUpdating: boolean
  onDeleteDialogLine: (lineId: number) => Promise<void>
  onUpdatePromptScene: (sceneId?: string) => Promise<void>
  onUpdatePromptActors: (actorIds: string[]) => Promise<void>
  onUpdatePromptProps: (propIds: string[]) => Promise<void>
  onUpdatePromptCostumes: (costumeIds: string[]) => Promise<void>
  selectedShot: StudioShot | null
  onUpdateShotTitle: (shotId: string, title: string) => Promise<void>
  onUpdateShotScriptExcerpt: (shotId: string, script_excerpt: string) => Promise<void>
  onDeleteShotOps: (shotId: string) => Promise<void>
  onPatchShotDetail: (patch: Partial<ShotDetailRead>) => void
  onPatchShotDetailImmediate: (patch: Partial<ShotDetailRead>) => Promise<void>
  onSelectPreviewVideo: (fileId: string) => void
  /** 下拉展开时拉取最新分镜帧图，用于「参考」关键帧类型选项动态更新 */
  onRefreshShotFrameImages?: () => Promise<void>
  /** 工作室里勾选的分镜（第 4 步「只处理选中项」批量生成用） */
  selectedShotIds?: string[]
  /** 进入工作台时自动定位到"当前步骤下第一个未完成镜头"（由外层执行选择） */
  onAutoLocateShot?: (shotId: string) => void
  /** 当前镜头的业务状态文案（由外层用同一份就绪判定算好，工作区与左侧列表共用） */
  status: ShotStatusText
  /** 生成成功后回读列表（镜头上的 generated_video_file_id 要重新拉才显示） */
  onShotDataChanged?: () => Promise<void> | void
  /** 范围（勾选优先，否则整集）交付行：只拉一次，左侧列表与工作区共用 */
  scopeRows: PromptDeliveryRow[]
  /** 整集交付行：用于「第一个未完成镜头」定位与导出范围 */
  episodeRows: PromptDeliveryRow[]
  /** 集级真实就绪数据（每镜提示词/绑定/参考帧/声音） */
  readinessRows: Array<Record<string, any>>
  /**
   * 阶段 4 / 5 的区块（由外层构建后传进来）。
   *
   * 为什么由外层构建：这两块读的是「本集逐镜的就绪与生成结果」，数据在外层手上
   * （同一份判定也供底部胶片条使用）；让 Inspector 再取一次就会变成第二套口径。
   */
  studioPhaseExtras?: StudioPhaseExtras
  /**
   * 工作室阶段（第 3–5 步共用容器）。
   *
   * **由外层持有**：阶段条、URL 参数（`?studio=`）与中栏面板必须是同一个值，
   * 否则会出现"阶段条停在 4、中栏显示 3"这种页面自己打自己的情况。
   */
  studioStepKey: StudioStepKey
  /** 切阶段（只改阶段与 URL；当前镜头与已选集合不动） */
  onStudioStepChange: (next: StudioStepKey) => void
  /** 本镜资产总览（外层持有：左栏引用素材与阶段 4 核对表读同一份） */
  shotAssetsOverview: ShotAssetsOverviewRead | null
  /** 重新读一次本镜资产总览（关联/解绑之后刷新用；实现只在外层一处） */
  onRefreshShotAssetsOverview: (shotId: string) => Promise<void>
  /** 「高级设置（维护）」弹窗是否打开（开合状态在外层，内容在本层 —— 内容要读本层的镜头数据） */
  advancedSettingsOpen: boolean
  /** 关闭「高级设置（维护）」 */
  onCloseAdvancedSettings: () => void
}) {
  const {
    projectId,
    chapterId,
    projectVisualStyle,
    projectStyle,
    projectDefaultVideoRatio,
    capabilityDefaultVideoRatio,
    videoRatioOptions,
    imageGenerationOptions,
    keyframeResolutionProfile,
    onChangeKeyframeResolutionProfile,
    keyframeImageModelId,
    onChangeKeyframeImageModelId,
    loadingDetail,
    shotDetail,
    dialogLines,
    frameImages,
    sceneLinks,
    propLinks,
    costumeLinks,
    shotCharacterLinks,
    shotDialogueCandidateItems,
    cameraUpdating,
    promptAssetsUpdating,
    onDeleteDialogLine,
    onUpdatePromptScene,
    onUpdatePromptActors,
    onUpdatePromptProps,
    onUpdatePromptCostumes,
    selectedShot,
    onUpdateShotTitle,
    onUpdateShotScriptExcerpt,
    onDeleteShotOps,
    onPatchShotDetail,
    onPatchShotDetailImmediate,
    onSelectPreviewVideo,
    onRefreshShotFrameImages,
    selectedShotIds,
    onAutoLocateShot,
    status,
    onShotDataChanged,
    scopeRows,
    episodeRows,
    readinessRows,
    studioPhaseExtras,
    studioStepKey,
    onStudioStepChange,
    shotAssetsOverview,
    onRefreshShotAssetsOverview,
    advancedSettingsOpen,
    onCloseAdvancedSettings,
  } = props
  const currentChapterId = chapterId ?? null
  const [imageVersion, setImageVersion] = useState('v1')
  const [refImageType, setRefImageType] = useState<string | undefined>(undefined)
  const [refFrameTypeSelectLoading, setRefFrameTypeSelectLoading] = useState(false)
  const [useBoneDepth, setUseBoneDepth] = useState(false)
  const [audioMode, setAudioMode] = useState<'none' | 'prompt' | 'upload'>('none')
  const [hideShot, setHideShot] = useState(false)
  /** 「维护设置」移出日常页签后，从这里进入（高级设置） */
  const [sceneNameMap, setSceneNameMap] = useState<Record<string, string>>({})
  const [characterNameMap, setCharacterNameMap] = useState<Record<string, string>>({})
  const [linkRoleOpen, setLinkRoleOpen] = useState(false)
  const [linkRoleLoading, setLinkRoleLoading] = useState(false)
  const [linkRoleSelectedIds, setLinkRoleSelectedIds] = useState<string[]>([])
  const [projectRoleOptions, setProjectRoleOptions] = useState<
    Array<{ value: string; label: React.ReactNode; searchLabel: string; disabled?: boolean }>
  >([])
  const [shotLinkedAssets, setShotLinkedAssets] = useState<
    Array<{ type: string; id: string; name?: string; thumbnail?: string; image_id?: number | null }>
  >([])
  const [shotRenderPromptLoading, setShotRenderPromptLoading] = useState(false)
  const [shotExtractStatus, setShotExtractStatus] = useState<{
    source: 'idle'
    updatedAt: number | null
    message: string
  }>({
    source: 'idle',
    updatedAt: null,
    message: '',
  })
  const [readinessExistenceMap, setReadinessExistenceMap] = useState<Record<string, EntityNameExistenceItem>>({})
  const [readinessExistenceLoading, setReadinessExistenceLoading] = useState(false)
  const [linkSceneOpen, setLinkSceneOpen] = useState(false)
  const [linkSceneLoading, setLinkSceneLoading] = useState(false)
  const [projectSceneOptions, setProjectSceneOptions] = useState<Array<{ value: string; label: React.ReactNode; searchLabel: string }>>([])

  const [linkPropOpen, setLinkPropOpen] = useState(false)
  const [linkPropLoading, setLinkPropLoading] = useState(false)
  const [linkPropSelectedIds, setLinkPropSelectedIds] = useState<string[]>([])
  const [projectPropOptions, setProjectPropOptions] = useState<Array<{ value: string; label: React.ReactNode; searchLabel: string; disabled?: boolean }>>([])

  const [linkCostumeOpen, setLinkCostumeOpen] = useState(false)
  const [linkCostumeLoading, setLinkCostumeLoading] = useState(false)
  const [linkCostumeSelectedIds, setLinkCostumeSelectedIds] = useState<string[]>([])
  const [projectCostumeOptions, setProjectCostumeOptions] = useState<Array<{ value: string; label: React.ReactNode; searchLabel: string; disabled?: boolean }>>([])
  const [opsTitleDraft, setOpsTitleDraft] = useState('')
  const [opsNoteDraft, setOpsNoteDraft] = useState('')
  const opsTitleSaveTimerRef = useRef<number | null>(null)
  const opsNoteSaveTimerRef = useRef<number | null>(null)
  const [keyframePromptPreviewOpen, setKeyframePromptPreviewOpen] = useState(false)
  const [keyframePlanPreview, setKeyframePlanPreview] = useState<FramePlanResult | null>(null)
  /** 已经自动定位过的步骤（每个步骤一次；切换镜头不受影响） */
  const autoLocatedStepRef = useRef<StudioStepKey | null>(null)
  // 第二部分：导出前的范围检查（列出可导出/缺提示词/缺绑定文件），确认后再调既有 TXT 接口
  const [exportScopeOpen, setExportScopeOpen] = useState(false)
  // 关键帧走哪条出图通道的**可选列表**（选中值由外层持有，和分辨率档位同一口径）
  const [imageModelOptions, setImageModelOptions] = useState<ImageModelOption[]>([])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const items = await fetchImageModels()
        if (active) setImageModelOptions(items)
      } catch {
        if (active) setImageModelOptions([])
      }
    })()
    return () => {
      active = false
    }
  }, [])
  const [keyframePromptPreviewLoading, setKeyframePromptPreviewLoading] = useState(false)
  const [keyframePromptActionLoading, setKeyframePromptActionLoading] = useState(false)
  const [keyframePromptPreviewFrameType, setKeyframePromptPreviewFrameType] = useState<PromptFrameType>('key')
  const [keyframePromptDebugContext, setKeyframePromptDebugContext] = useState<ShotFramePromptDebugContext | null>(null)
  const [keyframePromptDebugCollapsed, setKeyframePromptDebugCollapsed] = useState(true)
  const [keyframeDirectiveCollapsed, setKeyframeDirectiveCollapsed] = useState(true)
  const [keyframePromptDecisionCollapsed, setKeyframePromptDecisionCollapsed] = useState(true)
  const [keyframePromptQualityChecks, setKeyframePromptQualityChecks] = useState<ShotFramePromptQualityChecks>(null)
  const [videoPromptPreviewOpen, setVideoPromptPreviewOpen] = useState(false)
  const [videoPromptPreviewLoading, setVideoPromptPreviewLoading] = useState(false)
  const [videoPromptPreviewSubmitting, setVideoPromptPreviewSubmitting] = useState(false)
  const [videoPromptContextCollapsed, setVideoPromptContextCollapsed] = useState(true)
  const [videoPromptSaving, setVideoPromptSaving] = useState(false)
  const [videoPinnedPlan, setVideoPinnedPlan] = useState<VideoPinnedPlanView | null>(null)
  /** 本次打开弹窗时 LLM 生成的原样结果，用于区分「人工编辑」与「原样接受生成结果」。 */
  const [videoLlmDerivedPrompt, setVideoLlmDerivedPrompt] = useState('')
  const resolveVideoRatioForRequest = useCallback(() => {
    const shotRatio = String(shotDetail?.override_video_ratio ?? '').trim()
    const projectRatio = String(projectDefaultVideoRatio ?? '').trim()
    const fallbackRatio = String(capabilityDefaultVideoRatio ?? '').trim()
    return shotRatio || projectRatio || fallbackRatio
  }, [capabilityDefaultVideoRatio, projectDefaultVideoRatio, shotDetail?.override_video_ratio])
  const resolvedKeyframeRatio = resolveVideoRatioForRequest()
  const resolvedKeyframePixelSize = resolveKeyframePixelSize(
    imageGenerationOptions,
    resolvedKeyframeRatio,
    keyframeResolutionProfile,
  )
  /**
   * 出视频的「第几轮」。
   *
   * 后端把「镜头 + 生成参数 + attempt」哈希成幂等键：**同一次**（同一 attempt）重复点生成
   * 只会复用既有任务、不会重复计费；只有明确点「重新生成」把 attempt 加 1，才会真的
   * 再调用一次供应商。用 ref 而不是 state 的原因：submit 回调是闭包，state 更新在同一个
   * 事件里读不到新值，会出现"点了重新生成却还是复用了旧任务"。
   */
  const videoAttemptRef = useRef(0)
  const videoPromptDraft = useGenerationDraft<
    { prompt: string },
    { referenceMode: VideoReferenceMode; images: string[] },
    VideoPromptDerived,
    { taskId: string | null }
  >({
    initialBase: { prompt: '' },
    initialContext: { referenceMode: 'text_only', images: [] },
    derive: async ({ base, context }) => {
      if (!selectedShot?.id) {
        throw new Error('shot is required')
      }
      const ratio = resolveVideoRatioForRequest()
      if (!ratio) {
        throw new Error('video ratio is required')
      }
      const res = await FilmService.previewVideoGenerationPromptApiV1FilmTasksVideoPreviewPromptPost({
        requestBody: {
          shot_id: selectedShot.id,
          reference_mode: context.referenceMode,
          prompt: (base.prompt || '').trim() || null,
          images: context.images,
          ratio,
        } as any,
      })
      const data = (res as any)?.data ?? null
      return {
        prompt: typeof data?.prompt === 'string' ? data.prompt : '',
        images: Array.isArray(data?.images) ? (data.images as string[]).filter(Boolean) : [],
        pack: data?.pack ?? null,
      }
    },
    submit: async ({ derived, context }) => {
      if (!selectedShot?.id) {
        throw new Error('shot is required')
      }
      const ratio = resolveVideoRatioForRequest()
      if (!ratio) {
        throw new Error('video ratio is required')
      }
      // 为什么不再走 /film/tasks/video：那条链路把任务丢给 Celery 队列，而本机没有
      // Redis / worker（task_always_eager=False），任务只会停在 pending —— 表现就是
      // "点了生成没反应"。这里改走**同进程内联执行**的直提端点，并在拿到地址后
      // 立刻落库挂到该镜头，界面刷新即可见。
      const result = await submitVideo({
        shot_id: selectedShot.id,
        reference_mode: context.referenceMode,
        prompt: (derived.prompt || '').trim(),
        images: derived.images,
        ratio,
        duration_seconds: Math.max(5, Number(shotDetail?.duration ?? 5) || 5),
        timeout_seconds: 900,
        // 同一轮（同一 attempt）重复点生成 = 复用既有任务，不重复计费；
        // 点「重新生成」才会把 attempt +1 → 换成一个新的幂等键。
        attempt: videoAttemptRef.current,
      })
      if (result.status === 'dry_run') {
        // 演练模式：守卫拦下了真实调用。这不是错误，要说清楚而不是报红。
        message.info(
          // 审计 §4.3 模式 4：整句里的 DRY_RUN / JELLYFISH_* 环境变量名全部摘掉
          '演练模式：本次没有真实生成、没有产生费用。如需真实生成，请联系管理员开启。',
          8,
        )
        // 关键：把「被门禁阻止」和「没有任务 ID」区分开，否则调用方会再报一次红字。
        return { taskId: null, gated: true }
      }
      if (result.deduplicated) {
        // 后端命中了同一轮的既有任务：**没有**再调供应商、没有产生新费用。
        // 产物在首次提交时就已经落库并挂到本镜，所以这里**不再**重复登记（否则会多出
        // 一条 files 记录 + 一个媒体对象）。
        message.info(
          '本轮已经提交过，直接复用既有任务，没有重复扣费。要真的再生成一次请点「重新生成」。',
          8,
        )
        if (result.status === 'completed' && result.url) {
          return {
            taskId: selectedShot.generated_video_file_id?.trim() || null,
            completed: true as const,
            videoUrl: result.url,
          }
        }
      }
      if (result.status !== 'completed' || !result.url) {
        // 审计 §4.3 模式 3：`status=xxx` 属英文枚举原值直渲
        throw new Error(toUserFacingText(result.error, '视频没有生成出来，请重试'))
      }
      const fileId = await persistGeneratedVideo(selectedShot.id, result.url, '镜头视频（直提）')
      const refreshed = await StudioShotDetailsService.getShotDetailApiV1StudioShotDetailsShotIdGet({
        shotId: selectedShot.id,
      })
      if (refreshed.data) onPatchShotDetail(refreshed.data)
      // 这条链路是**同进程内联执行**：走到这里视频已经生成并落库，
      // 返回的是产物 file_id，不是可轮询的任务 ID。
      // 以前调用方拿它去轮询 `/film/tasks/{id}/status` → 必然 404 → 页面永久显示 pending。
      return {
        taskId: fileId,
        completed: true as const,
        videoUrl: result.url,
      }
    },
  })
  const videoPromptPreviewDraft = videoPromptDraft.base.prompt
  const videoPromptPreviewImages = videoPromptDraft.context.images
  const videoReferenceMode = videoPromptDraft.context.referenceMode
  const videoPromptPreviewPack = videoPromptDraft.derived?.pack ?? null
  const videoActionBeatPhases = videoPromptPreviewPack?.action_beat_phases ?? []
  const videoActionBeats = videoActionBeatPhases.length > 0
    ? videoActionBeatPhases.map((item) => ({
        text: item.text,
        phase: item.phase,
      }))
    : (videoPromptPreviewPack?.action_beats ?? []).map((text) => ({
        text,
        phase: null,
      }))
  const videoVisibleActionBeats = videoPromptContextCollapsed
    ? videoActionBeats.slice(0, 2)
    : videoActionBeats
  const hiddenVideoActionBeatCount = Math.max(0, videoActionBeats.length - videoVisibleActionBeats.length)
  // 已持久化到 shot_details.video_prompt 的内容（交付导出读的就是这一列）。
  const savedVideoPrompt = (shotDetail?.video_prompt ?? '').trim()
  const savedVideoPromptSource = String(shotDetail?.video_prompt_source ?? '').trim()
  const savedVideoPromptDiffers = Boolean(savedVideoPrompt) && savedVideoPrompt !== (videoPromptPreviewDraft || '').trim()

  /**
   * 「4. 视频提示词」步骤里的就地编辑器。
   *
   * 之前这条内容只存在于「6. 生成与交付 → 视频生成」页签的弹窗里，第 4 步看不到它，
   * 用户只能去别处找 —— 现在本步骤直接可看可改可保存，不跳页。
   */
  const [videoPromptTabDraft, setVideoPromptTabDraft] = useState('')
  const [videoPromptTabSaving, setVideoPromptTabSaving] = useState(false)
  useEffect(() => {
    // 切换分镜 / 外部保存后回填（用户正在输入时不要覆盖：只在内容与已保存值不同且草稿为空或等于上一次已保存值时同步）
    setVideoPromptTabDraft(savedVideoPrompt)
  }, [selectedShot?.id, savedVideoPrompt])

  const saveVideoPromptTab = async (source: 'manual' | 'llm') => {
    if (!selectedShot?.id) {
      message.warning('请先选择一个分镜')
      return
    }
    const text = videoPromptTabDraft.trim()
    if (!text) {
      message.warning('提示词为空，无法保存')
      return
    }
    setVideoPromptTabSaving(true)
    try {
      await saveShotVideoPrompt(selectedShot.id, text, source)
      const refreshed = await StudioShotDetailsService.getShotDetailApiV1StudioShotDetailsShotIdGet({
        shotId: selectedShot.id,
      })
      if (refreshed.data) onPatchShotDetail(refreshed.data)
      message.success(`视频提示词已保存到镜头（来源：${videoPromptSourceLabel(source)}）`)
    } catch (err) {
      void showUserError(err, '保存视频提示词失败')
    } finally {
      setVideoPromptTabSaving(false)
    }
  }
  const videoLlmDerivedPromptTrimmed = videoLlmDerivedPrompt.trim()
  const videoLlmResultDiffers = Boolean(videoLlmDerivedPromptTrimmed) && videoLlmDerivedPromptTrimmed !== (videoPromptPreviewDraft || '').trim()
  const videoPromptSaveSource = videoLlmDerivedPromptTrimmed && videoLlmDerivedPromptTrimmed === (videoPromptPreviewDraft || '').trim() ? 'llm' : 'internal'
  const [videoTaskPolling, setVideoTaskPolling] = useState(false)
  const [videoTaskStatus, setVideoTaskStatus] = useState<string | null>(null)
  const [videoTaskId, setVideoTaskId] = useState<string | null>(null)
  const [videoTask, setVideoTask] = useState<RelationTaskState | null>(null)
  const [videoSettledTask, setVideoSettledTask] = useState<RelationTaskState | null>(null)
  const [promptTask, setPromptTask] = useState<RelationTaskState | null>(null)
  const [promptSettledTask, setPromptSettledTask] = useState<RelationTaskState | null>(null)
  const [frameImageTask, setFrameImageTask] = useState<RelationTaskState | null>(null)
  const [frameImageSettledTask, setFrameImageSettledTask] = useState<RelationTaskState | null>(null)
  const [generatedVideos, setGeneratedVideos] = useState<Array<{ linkId: number; fileId: string; url: string }>>([])
  const [videoReadiness, setVideoReadiness] = useState<ShotVideoReadinessRead | null>(null)
  const [videoReadinessLoading, setVideoReadinessLoading] = useState(false)
  const [keyframeCards, setKeyframeCards] = useState<Record<PromptFrameType, KeyframeCardState>>({
    first: { loading: false, taskStatus: null, taskId: null, thumbs: [], modalOpen: false, applyingFileId: null },
    key: { loading: false, taskStatus: null, taskId: null, thumbs: [], modalOpen: false, applyingFileId: null },
    last: { loading: false, taskStatus: null, taskId: null, thumbs: [], modalOpen: false, applyingFileId: null },
  })
  const selectedShotSourceLabel = useMemo(() => {
    if (!selectedShot) return '分镜工作室'
    const shotTitle = selectedShot.title?.trim()
    return shotTitle ? `镜头：${shotTitle}` : `镜头：第 ${selectedShot.index} 镜`
  }, [selectedShot])
  useRelationTaskNotification({
    task: videoTask,
    settledTask: videoSettledTask,
    title: TASK_COPY.videoGeneration.title,
    sourceLabel: selectedShotSourceLabel,
    runningDescription: TASK_COPY.videoGeneration.runningDescription,
    cancellingDescription: TASK_COPY.videoGeneration.cancellingDescription,
    successDescription: TASK_COPY.videoGeneration.successDescription,
    cancelledDescription: TASK_COPY.videoGeneration.cancelledDescription,
    failedDescription: TASK_COPY.videoGeneration.failedDescription,
    onCancel:
      videoTask?.taskId
        ? () =>
            void executeTaskCancel({
              taskId: videoTask.taskId,
              reason: '用户在分镜工作室取消视频生成任务',
              applyCancelData: (data) => {
                setVideoTask((current) => applyTaskCancelState(current, data))
                return null
              },
              cancelledImmediatelyMessage: TASK_COPY.videoGeneration.cancelledImmediatelyMessage,
              cancelRequestedMessage: TASK_COPY.videoGeneration.cancelRequestedMessage,
              fallbackErrorMessage: '取消视频生成任务失败',
            })
        : null,
    onNavigate: () => undefined,
  })
  useRelationTaskNotification({
    task: promptTask,
    settledTask: promptSettledTask,
    title: TASK_COPY.shotFramePrompt.title,
    sourceLabel: selectedShotSourceLabel,
    runningDescription: TASK_COPY.shotFramePrompt.runningDescription,
    cancellingDescription: TASK_COPY.shotFramePrompt.cancellingDescription,
    successDescription: TASK_COPY.shotFramePrompt.successDescription,
    cancelledDescription: TASK_COPY.shotFramePrompt.cancelledDescription,
    failedDescription: TASK_COPY.shotFramePrompt.failedDescription,
    onCancel:
      promptTask?.taskId
        ? () =>
            void executeTaskCancel({
              taskId: promptTask.taskId,
              reason: '用户在分镜工作室取消分镜提示词生成任务',
              applyCancelData: (data) => {
                setPromptTask((current) => applyTaskCancelState(current, data))
                return null
              },
              cancelledImmediatelyMessage: TASK_COPY.shotFramePrompt.cancelledImmediatelyMessage,
              cancelRequestedMessage: TASK_COPY.shotFramePrompt.cancelRequestedMessage,
              fallbackErrorMessage: '取消分镜提示词生成任务失败',
            })
        : null,
    onNavigate: () => undefined,
  })
  useRelationTaskNotification({
    task: frameImageTask,
    settledTask: frameImageSettledTask,
    title: TASK_COPY.shotFrameImage.title,
    sourceLabel: selectedShotSourceLabel,
    runningDescription: TASK_COPY.shotFrameImage.runningDescription,
    cancellingDescription: TASK_COPY.shotFrameImage.cancellingDescription,
    successDescription: TASK_COPY.shotFrameImage.successDescription,
    cancelledDescription: TASK_COPY.shotFrameImage.cancelledDescription,
    failedDescription: TASK_COPY.shotFrameImage.failedDescription,
    onCancel:
      frameImageTask?.taskId
        ? () =>
            void executeTaskCancel({
              taskId: frameImageTask.taskId,
              reason: '用户在分镜工作室取消关键帧图片生成任务',
              applyCancelData: (data) => {
                setFrameImageTask((current) => applyTaskCancelState(current, data))
                return null
              },
              cancelledImmediatelyMessage: TASK_COPY.shotFrameImage.cancelledImmediatelyMessage,
              cancelRequestedMessage: TASK_COPY.shotFrameImage.cancelRequestedMessage,
              fallbackErrorMessage: '取消关键帧图片生成任务失败',
            })
        : null,
    onNavigate: () => undefined,
  })
  const showAvTab = false
  const showGenRefParams = false
  const showGenRefVersions = false

  // 注意：这里**故意不**"按镜头自动切换工作区".
  // 连续工作区的展开项只随**步骤**变化；切换镜头时用户停在哪一块就留在哪一块。

  useEffect(() => {
    setHideShot(Boolean(selectedShot?.hidden))
  }, [selectedShot?.hidden])

  useEffect(() => {
    if (!selectedShot?.id) {
      setVideoReadiness(null)
      return
    }
    let canceled = false
    setVideoReadinessLoading(true)
    void (async () => {
      try {
        const res = await StudioShotsService.getShotVideoReadinessApiApiV1StudioShotsShotIdVideoReadinessGet({
          shotId: selectedShot.id,
          referenceMode: videoReferenceMode,
        })
        if (canceled) return
        setVideoReadiness((res.data ?? null) as ShotVideoReadinessRead | null)
      } catch {
        if (canceled) return
        setVideoReadiness(null)
      } finally {
        if (!canceled) setVideoReadinessLoading(false)
      }
    })()
    return () => {
      canceled = true
    }
  }, [
    selectedShot?.id,
    selectedShot?.status,
    videoReferenceMode,
    shotDetail?.duration,
    shotDetail?.first_frame_prompt,
    shotDetail?.key_frame_prompt,
    shotDetail?.last_frame_prompt,
    frameImages.map((x) => `${x.id}:${x.file_id ?? ''}`).join('|'),
  ])

  useEffect(() => {
    if (!selectedShot?.id) {
      setGeneratedVideos([])
      return
    }
    let canceled = false
    void (async () => {
      try {
        const links = await listTaskLinksNormalized({
          resourceType: 'video',
          relationType: 'video',
          relationEntityId: selectedShot.id,
          order: 'updated_at',
          isDesc: true,
          page: 1,
          pageSize: 100,
        })
        if (canceled) return
        const seen = new Set<string>()
        const list = links
          .filter((l) => Boolean(l.file_id))
          .map((l) => ({
            linkId: l.id,
            fileId: String(l.file_id),
            url: buildFileDownloadUrl(String(l.file_id)) ?? '',
          }))
          .filter((v) => Boolean(v.url))
          .filter((v) => {
            if (seen.has(v.fileId)) return false
            seen.add(v.fileId)
            return true
          })
        const currentId = selectedShot.generated_video_file_id?.trim() || ''
        if (currentId && !list.some((x) => x.fileId === currentId)) {
          const currentUrl = buildFileDownloadUrl(currentId) ?? ''
          if (currentUrl) list.unshift({ linkId: -1, fileId: currentId, url: currentUrl })
        }
        setGeneratedVideos(list)
      } catch {
        if (!canceled) setGeneratedVideos([])
      }
    })()
    return () => {
      canceled = true
    }
  }, [selectedShot?.id, selectedShot?.generated_video_file_id, videoTaskStatus, videoTaskPolling])

  useEffect(() => {
    setOpsTitleDraft(selectedShot?.title ?? '')
    setOpsNoteDraft(selectedShot?.script_excerpt ?? '')
    if (opsTitleSaveTimerRef.current) window.clearTimeout(opsTitleSaveTimerRef.current)
    if (opsNoteSaveTimerRef.current) window.clearTimeout(opsNoteSaveTimerRef.current)
    opsTitleSaveTimerRef.current = null
    opsNoteSaveTimerRef.current = null
  }, [selectedShot?.id])

  useEffect(() => {
    if (!selectedShot?.id) return
    if (opsTitleDraft === (selectedShot.title ?? '')) return

    if (opsTitleSaveTimerRef.current) window.clearTimeout(opsTitleSaveTimerRef.current)
    opsTitleSaveTimerRef.current = window.setTimeout(() => {
      void onUpdateShotTitle(selectedShot.id, opsTitleDraft)
      opsTitleSaveTimerRef.current = null
    }, 500)

    return () => {
      if (opsTitleSaveTimerRef.current) window.clearTimeout(opsTitleSaveTimerRef.current)
      opsTitleSaveTimerRef.current = null
    }
  }, [opsTitleDraft, selectedShot?.id, selectedShot?.title, onUpdateShotTitle])

  useEffect(() => {
    if (!selectedShot?.id) return
    if (opsNoteDraft === (selectedShot.script_excerpt ?? '')) return

    if (opsNoteSaveTimerRef.current) window.clearTimeout(opsNoteSaveTimerRef.current)
    opsNoteSaveTimerRef.current = window.setTimeout(() => {
      void onUpdateShotScriptExcerpt(selectedShot.id, opsNoteDraft)
      opsNoteSaveTimerRef.current = null
    }, 500)

    return () => {
      if (opsNoteSaveTimerRef.current) window.clearTimeout(opsNoteSaveTimerRef.current)
      opsNoteSaveTimerRef.current = null
    }
  }, [opsNoteDraft, selectedShot?.id, selectedShot?.script_excerpt, onUpdateShotScriptExcerpt])

  const flushOpsTitle = async () => {
    if (!selectedShot?.id) return
    if (opsTitleSaveTimerRef.current) window.clearTimeout(opsTitleSaveTimerRef.current)
    opsTitleSaveTimerRef.current = null
    if (opsTitleDraft === (selectedShot.title ?? '')) return
    await onUpdateShotTitle(selectedShot.id, opsTitleDraft)
  }

  const flushOpsNote = async () => {
    if (!selectedShot?.id) return
    if (opsNoteSaveTimerRef.current) window.clearTimeout(opsNoteSaveTimerRef.current)
    opsNoteSaveTimerRef.current = null
    if (opsNoteDraft === (selectedShot.script_excerpt ?? '')) return
    await onUpdateShotScriptExcerpt(selectedShot.id, opsNoteDraft)
  }

  const sceneIds = useMemo(() => Array.from(new Set(sceneLinks.map((x) => x.scene_id).filter(Boolean))), [sceneLinks])
  const characterIds = useMemo(() => Array.from(new Set(shotCharacterLinks.map((x) => x.character_id).filter(Boolean))), [shotCharacterLinks])

  const linkedCharacterIds = useMemo(() => characterIds, [characterIds])
  const linkedSceneId = useMemo(() => {
    if (!selectedShot?.id) return null
    return sceneLinks.find((l) => (l.shot_id ?? null) === selectedShot.id)?.scene_id ?? shotDetail?.scene_id ?? null
  }, [sceneLinks, selectedShot?.id, shotDetail?.scene_id])
  const linkedPropIds = useMemo(() => {
    if (!selectedShot?.id) return []
    return Array.from(new Set(propLinks.filter((l) => (l.shot_id ?? null) === selectedShot.id).map((l) => l.prop_id).filter(Boolean))) as string[]
  }, [propLinks, selectedShot?.id])
  const linkedCostumeIds = useMemo(() => {
    if (!selectedShot?.id) return []
    return Array.from(new Set(costumeLinks.filter((l) => (l.shot_id ?? null) === selectedShot.id).map((l) => l.costume_id).filter(Boolean))) as string[]
  }, [costumeLinks, selectedShot?.id])

  useEffect(() => {
    if (!selectedShot?.id) {
      setShotLinkedAssets([])
      return
    }
    let canceled = false
    void (async () => {
      try {
        const res = await StudioShotsService.listShotLinkedAssetsApiV1StudioShotsShotIdLinkedAssetsGet({
          shotId: selectedShot.id,
          page: 1,
          pageSize: 100,
        })
        if (canceled) return
        const items = (res.data?.items ?? []) as any[]
        setShotLinkedAssets(
          items
            .filter((x) => x && typeof x.type === 'string' && typeof x.id === 'string')
            .map((x) => ({
              type: String(x.type),
              id: String(x.id),
              name: typeof x.name === 'string' ? x.name : undefined,
              image_id: typeof x.image_id === 'number' ? x.image_id : x.image_id === null ? null : undefined,
              thumbnail: typeof x.thumbnail === 'string' && x.thumbnail.trim() ? x.thumbnail.trim() : undefined,
            })),
        )
      } catch {
        if (!canceled) setShotLinkedAssets([])
      }
    })()
    return () => {
      canceled = true
    }
  }, [selectedShot?.id])


  useEffect(() => {
    if (!selectedShot?.id) {
      setShotExtractStatus({ source: 'idle', updatedAt: null, message: '' })
      return
    }
    setShotExtractStatus({
      source: 'idle',
      updatedAt: null,
      message: '待确认候选请前往分镜编辑页提取或刷新。',
    })
  }, [
    selectedShot?.id,
  ])

  const linkedAssetThumbByKey = useMemo(() => {
    const map = new Map<string, string>()
    shotLinkedAssets.forEach((it) => {
      if (!it.thumbnail) return
      map.set(`${it.type}:${it.id}`, it.thumbnail)
    })
    return map
  }, [shotLinkedAssets])

  const promptAssetReadiness = useMemo(() => {
    if (selectedShot?.skip_extraction) {
      return {
        checks: [] as Array<{
          key: 'characters' | 'scene' | 'props' | 'costumes'
          label: string
          importance: string
          entries: Array<{ id: number; name: string; status: ShotExtractedCandidateRead['candidate_status'] }>
          missing: string[]
          expectedCount: number
          actualCount: number
          ignoredCount: number
          resolvedCount: number
          ready: boolean
        }>,
        expectedChecks: [] as Array<{
          key: 'characters' | 'scene' | 'props' | 'costumes'
          label: string
          importance: string
          entries: Array<{ id: number; name: string; status: ShotExtractedCandidateRead['candidate_status'] }>
          missing: string[]
          expectedCount: number
          actualCount: number
          ignoredCount: number
          resolvedCount: number
          ready: boolean
        }>,
        readyCount: 1,
        totalCount: 1,
        percent: 100,
        hasMissing: false,
      }
    }
    const overviewItems = shotAssetsOverview?.items ?? []
    /* 类型放宽到 `string`：镜头资产概览里还有**商品**（第五类资产）。
       逐项比较用 `String(...)` 读，避免把生成客户端里那份还没更新的类型联合当判据。 */
    const bucket = (type: 'character' | 'scene' | 'prop' | 'costume' | 'product') =>
      overviewItems.filter((item) => String((item as { type?: string }).type ?? '') === type)

    const checks = [
      {
        key: 'characters' as const,
        label: '角色',
        importance: '影响人物一致性、关键帧参考图和画面主体描述。',
        candidates: bucket('character'),
      },
      {
        key: 'scene' as const,
        label: '场景',
        importance: '影响镜头环境描述、视频提示词和整体空间连续性。',
        candidates: bucket('scene'),
      },
      {
        key: 'props' as const,
        label: '道具',
        importance: '影响关键动作细节，缺失时容易让画面叙事元素不完整。',
        candidates: bucket('prop'),
      },
      {
        key: 'costumes' as const,
        label: '服装',
        importance: '影响角色外观连续性，尤其在多镜头或生成多版本时更明显。',
        candidates: bucket('costume'),
      },
      {
        key: 'products' as const,
        label: '商品',
        importance: '影响商品在成片里的呈现：剧情广告要求商品出现在足够多的镜头里，缺关联会漏掉。',
        candidates: bucket('product'),
      },
    ].map((item) => {
      const entries = item.candidates.map((candidate) => ({
        id: candidate.candidate_id ?? -1,
        name: candidate.name,
        status: candidate.candidate_status ?? (candidate.is_linked ? 'linked' : 'pending'),
      }))
      const pending = entries.filter((entry) => entry.status === 'pending')
      const linked = entries.filter((entry) => entry.status === 'linked')
      const ignored = entries.filter((entry) => entry.status === 'ignored')
      return {
        ...item,
        entries,
        missing: pending.map((entry) => entry.name),
        expectedCount: entries.length,
        actualCount: linked.length,
        ignoredCount: ignored.length,
        resolvedCount: linked.length + ignored.length,
        ready: entries.length === 0 || pending.length === 0,
      }
    })

    const expectedChecks = checks.filter((item) => item.expectedCount > 0)
    const readyCount = expectedChecks.filter((item) => item.ready).length
    return {
      checks,
      expectedChecks,
      readyCount,
      totalCount: expectedChecks.length,
      percent: expectedChecks.length === 0 ? 100 : Math.round((readyCount / expectedChecks.length) * 100),
      hasMissing: expectedChecks.some((item) => item.missing.length > 0),
    }
  }, [selectedShot?.skip_extraction, shotAssetsOverview?.items])

  useEffect(() => {
    if (!projectId || !selectedShot?.id) {
      setReadinessExistenceMap({})
      return
    }

    const overviewItems = shotAssetsOverview?.items ?? []
    const characterNames = uniqueNames(
      overviewItems.filter((item) => item.type === 'character' && item.candidate_status === 'pending').map((item) => item.name),
    )
    const sceneNames = uniqueNames(
      overviewItems.filter((item) => item.type === 'scene' && item.candidate_status === 'pending').map((item) => item.name),
    )
    const propNames = uniqueNames(
      overviewItems.filter((item) => item.type === 'prop' && item.candidate_status === 'pending').map((item) => item.name),
    )
    const costumeNames = uniqueNames(
      overviewItems.filter((item) => item.type === 'costume' && item.candidate_status === 'pending').map((item) => item.name),
    )
    /* 商品是第五类资产：它同样要参与"项目里/资产库里有没有同名资产"的对账，
       否则商品候选在诊断里永远显示不出「需新建 / 资产库已有 / 已关联」。 */
    const productNames = uniqueNames(
      overviewItems
        .filter(
          (item) =>
            String((item as { type?: string }).type ?? '') === 'product' &&
            item.candidate_status === 'pending',
        )
        .map((item) => item.name),
    )

    if (
      characterNames.length === 0 &&
      sceneNames.length === 0 &&
      propNames.length === 0 &&
      costumeNames.length === 0 &&
      productNames.length === 0
    ) {
      setReadinessExistenceMap({})
      return
    }

    let cancelled = false
    setReadinessExistenceLoading(true)
    void (async () => {
      try {
        /* `product_names` 是**新增的可选参数**（后端向后兼容：不传时行为与以前一致），
           生成客户端里还没有这个键，所以按结构化对象发出去。 */
        const existenceBody: Record<string, unknown> = {
          project_id: projectId,
          shot_id: selectedShot.id,
          character_names: characterNames,
          scene_names: sceneNames,
          prop_names: propNames,
          costume_names: costumeNames,
        }
        if (productNames.length > 0) existenceBody.product_names = productNames
        const res = await StudioEntitiesService.checkEntityNamesExistenceApiV1StudioEntitiesExistenceCheckPost({
          requestBody: existenceBody as never,
        })
        if (cancelled) return
        const data = res.data
        const next: Record<string, EntityNameExistenceItem> = {}
        ;(data?.characters ?? []).forEach((item) => {
          next[`characters:${normalizeAssetName(item.name)}`] = item
        })
        ;(data?.scenes ?? []).forEach((item) => {
          next[`scene:${normalizeAssetName(item.name)}`] = item
        })
        ;(data?.props ?? []).forEach((item) => {
          next[`props:${normalizeAssetName(item.name)}`] = item
        })
        ;(data?.costumes ?? []).forEach((item) => {
          next[`costumes:${normalizeAssetName(item.name)}`] = item
        })
        /* 商品的返回桶同样按结构化读取（生成客户端里还没有 `products` 这个键）。 */
        ;(((data ?? {}) as Record<string, unknown>).products as EntityNameExistenceItem[] | undefined ?? []).forEach(
          (item) => {
            next[`products:${normalizeAssetName(item.name)}`] = item
          },
        )
        setReadinessExistenceMap(next)
      } catch {
        if (!cancelled) setReadinessExistenceMap({})
      } finally {
        if (!cancelled) setReadinessExistenceLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    projectId,
    selectedShot?.id,
    shotAssetsOverview?.items,
  ])

  const getReadinessExistenceLabel = useCallback((checkKey: 'characters' | 'scene' | 'props' | 'costumes' | 'products', name: string) => {
    const item = readinessExistenceMap[`${checkKey}:${normalizeAssetName(name)}`]
    if (!item) {
      return readinessExistenceLoading ? '检测中' : null
    }
    if (!item.exists) return '需新建'
    if (item.linked_to_project && !item.linked_to_shot) return '项目内可关联'
    if (!item.linked_to_project) return '资产库已有'
    if (item.linked_to_shot) return '已关联'
    return null
  }, [readinessExistenceLoading, readinessExistenceMap])


  const promptAssetReadinessNote = useMemo(() => {
    if (!selectedShot) return '请先选择一个分镜。'
    if (selectedShot.skip_extraction) return '当前分镜已明确标记为无需提取，系统会直接按“提取确认已完成”处理。'
    if (!shotAssetsOverview) return '当前还没有读到这条分镜的资产情况，暂时无法显示确认进度。'
    return '这里作为生成前的诊断：先看当前镜头的信息确认状态；需要提取、刷新或精细确认，请到分镜编辑页处理。'
  }, [selectedShot, shotAssetsOverview])

  const shotExtractStatusText = useMemo(() => {
    if (!shotExtractStatus.message) return ''
    if (!shotExtractStatus.updatedAt) return shotExtractStatus.message
    const time = new Date(shotExtractStatus.updatedAt).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    return `${shotExtractStatus.message} · ${time}`
  }, [shotExtractStatus])

  const goToShotEditForAssets = useCallback(() => {
    if (!projectId || !currentChapterId || !selectedShot?.id) return
    window.location.assign(`/projects/${projectId}/chapters/${currentChapterId}/shots/${selectedShot.id}/edit`)
  }, [currentChapterId, projectId, selectedShot?.id])

  const extractFileIdFromThumbnail = useCallback((thumbnail?: string | null): string | null => {
    const v = (thumbnail || '').trim()
    if (!v) return null
    // 纯 file_id：不包含路径或协议
    if (!v.includes('/') && !v.includes(':')) return v
    try {
      const url = new URL(v, typeof window !== 'undefined' ? window.location.origin : 'http://localhost')
      const m = url.pathname.match(/\/api\/v1\/studio\/files\/([^/]+)\/download\/?$/)
      if (m?.[1]) return decodeURIComponent(m[1])
    } catch {
      // ignore
    }
    return null
  }, [])

  const shotLinkedAssetNameByFileId = useMemo(() => {
    const map = new Map<string, string>()
    shotLinkedAssets.forEach((it: any) => {
      const fid =
        (typeof it?.file_id === 'string' && it.file_id.trim() ? it.file_id.trim() : null) ??
        extractFileIdFromThumbnail(it?.thumbnail ?? null)
      if (!fid) return
      const name = typeof it?.name === 'string' && it.name.trim() ? it.name.trim() : String(it?.id ?? '')
      if (!name) return
      map.set(fid, name)
    })
    return map
  }, [extractFileIdFromThumbnail, shotLinkedAssets])

  const deriveKeyframePromptPreview = useCallback(
    async ({
      base,
      context,
    }: {
      base: { frameType: PromptFrameType; prompt: string }
      context: { refFileIds: string[] }
    }): Promise<FramePromptDerived> => {
      if (!selectedShot?.id) {
        throw new Error('shot is required')
      }
      const basePrompt = (base.prompt || '').trim()
      const refFileIds = (context.refFileIds || []).filter(Boolean)
      if (!basePrompt) {
        return {
          basePrompt: '',
          renderedPrompt: '',
          selectedGuidance: [],
          droppedGuidance: [],
          selectedGuidanceDetails: [],
          droppedGuidanceDetails: [],
          images: [],
          mappings: [],
        }
      }

      const imagesPayload = refFileIds
        .map((fid) => {
          const match =
            shotLinkedAssets.find((x) => extractFileIdFromThumbnail(x.thumbnail ?? null) === fid) ??
            shotLinkedAssets.find((x) => (x as any)?.file_id === fid)
          return match
            ? {
                type: match.type as any,
                id: match.id,
                name: match.name ?? match.id,
                file_id: fid,
              }
            : null
        })
        .filter(Boolean)

      const rendered = await StudioImageTasksService.renderShotFramePromptApiV1StudioImageTasksShotShotIdFrameRenderPromptPost({
        shotId: selectedShot.id,
        requestBody: {
          frame_type: base.frameType,
          prompt: basePrompt,
          images: imagesPayload as any,
        } as any,
      })
      const d = rendered.data as any
      return {
        basePrompt: typeof d?.base_prompt === 'string' ? d.base_prompt : basePrompt,
        renderedPrompt: typeof d?.rendered_prompt === 'string' ? d.rendered_prompt : '',
        selectedGuidance: Array.isArray(d?.selected_guidance)
          ? d.selected_guidance.map((item: unknown) => String(item ?? '').trim()).filter(Boolean)
          : [],
        droppedGuidance: Array.isArray(d?.dropped_guidance)
          ? d.dropped_guidance.map((item: unknown) => String(item ?? '').trim()).filter(Boolean)
          : [],
        selectedGuidanceDetails: Array.isArray(d?.selected_guidance_details)
          ? d.selected_guidance_details
            .map((item: any) => ({
              text: String(item?.text ?? '').trim(),
              category: String(item?.category ?? '').trim(),
              reasonTag: String(item?.reason_tag ?? '').trim(),
              reason: String(item?.reason ?? '').trim(),
            }))
            .filter((item: { text: string }) => item.text)
          : [],
        droppedGuidanceDetails: Array.isArray(d?.dropped_guidance_details)
          ? d.dropped_guidance_details
            .map((item: any) => ({
              text: String(item?.text ?? '').trim(),
              category: String(item?.category ?? '').trim(),
              reasonTag: String(item?.reason_tag ?? '').trim(),
              reason: String(item?.reason ?? '').trim(),
            }))
            .filter((item: { text: string }) => item.text)
          : [],
        images: Array.isArray(d?.images) ? (d.images as string[]).filter(Boolean) : [],
        mappings: Array.isArray(d?.mappings) ? (d.mappings as ShotFramePromptMappingRead[]) : [],
      }
    },
    [extractFileIdFromThumbnail, selectedShot?.id, shotLinkedAssets],
  )

  const keyframePromptDraft = useGenerationDraft<
    { frameType: PromptFrameType; prompt: string },
    { refFileIds: string[] },
    FramePromptDerived,
    { taskId: string | null }
  >({
    initialBase: { frameType: 'key', prompt: '' },
    initialContext: { refFileIds: [] },
    derive: deriveKeyframePromptPreview,
    submit: async ({ base, context, derived }) => {
      if (!selectedShot?.id) {
        throw new Error('shot is required')
      }
      const resolvedItems =
        derived.mappings.length > 0
          ? derived.mappings.map((mapping) => ({
              type: mapping.type,
              id: mapping.id,
              name: mapping.name,
              file_id: mapping.file_id,
            }))
          : (context.refFileIds || []).map((fid) => {
              const match =
                shotLinkedAssets.find((x) => extractFileIdFromThumbnail(x.thumbnail ?? null) === fid) ??
                shotLinkedAssets.find((x) => (x as any)?.file_id === fid)
              return {
                type: (match?.type as any) ?? 'character',
                id: match?.id ?? fid,
                name: match?.name ?? match?.id ?? fid,
                file_id: fid,
              }
            })

      const ratio = resolveVideoRatioForRequest()
      if (!ratio) {
        throw new Error('video ratio is required')
      }
      // 默认生成路径也走**同进程内联**端点（老端点只建 Celery 任务行，本机不会被执行）。
      // 界面上的「生成」按钮目前走 confirmGenerateKeyframeWithPrompt，这里保持一致，
      // 避免将来有人再调用 draft.submitNow() 时又踩回死队列。
      const result = await submitFrameImage({
        shot_id: selectedShot.id,
        frame_type: base.frameType,
        prompt: (base.prompt || '').trim(),
        images: (resolvedItems as Array<{ file_id?: string }>).map((x) => String(x?.file_id ?? '')).filter(Boolean),
        target_ratio: ratio,
        resolution_profile: keyframeResolutionProfile,
        model_id: keyframeImageModelId || null,
      })
      return {
        taskId: result.task_id ?? null,
      }
    },
  })
  const keyframePromptPreviewDraft = keyframePromptDraft.base.prompt
  const keyframePromptRenderedDraft = keyframePromptDraft.derived?.renderedPrompt ?? ''
  const keyframePromptSelectedGuidance = keyframePromptDraft.derived?.selectedGuidance ?? []
  const keyframePromptDroppedGuidance = keyframePromptDraft.derived?.droppedGuidance ?? []
  const keyframePromptSelectedGuidanceDetails = keyframePromptDraft.derived?.selectedGuidanceDetails ?? []
  const keyframePromptDroppedGuidanceDetails = keyframePromptDraft.derived?.droppedGuidanceDetails ?? []
  const keyframePromptVisibleSelectedGuidanceDetails = keyframePromptDecisionCollapsed
    ? keyframePromptSelectedGuidanceDetails.slice(0, 2)
    : keyframePromptSelectedGuidanceDetails
  const keyframePromptVisibleDroppedGuidanceDetails = keyframePromptDecisionCollapsed
    ? keyframePromptDroppedGuidanceDetails.slice(0, 1)
    : keyframePromptDroppedGuidanceDetails
  const keyframePromptRenderMappings = keyframePromptDraft.derived?.mappings ?? []
  const keyframePromptPreviewRefFileIds = keyframePromptDraft.context.refFileIds
  const keyframePromptRenderState = keyframePromptDraft.state
  const renderShotPromptToTextarea = useCallback(
    async (opts?: { frameType?: PromptFrameType; prompt?: string; refFileIds?: string[]; showPreviewLoading?: boolean }) => {
      if (!selectedShot?.id) return
      const frameType = opts?.frameType ?? keyframePromptPreviewFrameType
      const basePrompt = (typeof opts?.prompt === 'string' ? opts.prompt : keyframePromptPreviewDraft || '').trim()
      const refFileIds = (opts?.refFileIds ?? keyframePromptPreviewRefFileIds ?? []).filter(Boolean)
      const nextBase = { frameType, prompt: basePrompt }
      const nextContext = { refFileIds }
      keyframePromptDraft.hydrate({
        base: nextBase,
        context: nextContext,
        state: basePrompt ? 'draft_changed' : 'idle',
      })
      if (!basePrompt) {
        return
      }
      setShotRenderPromptLoading(true)
      if (opts?.showPreviewLoading) {
        setKeyframePromptPreviewLoading(true)
      }
      try {
        const derived = await keyframePromptDraft.deriveNow({ base: nextBase, context: nextContext })
        if (derived?.images?.length) {
          keyframePromptDraft.hydrate({
            base: nextBase,
            context: { refFileIds: derived.images },
            derived: {
              ...derived,
              images: derived.images,
            },
          })
        }
      } catch {
        keyframePromptDraft.setState('error')
      } finally {
        if (opts?.showPreviewLoading) {
          setKeyframePromptPreviewLoading(false)
        }
        setShotRenderPromptLoading(false)
      }
    },
    [
      keyframePromptDraft,
      keyframeResolutionProfile,
      keyframePromptPreviewDraft,
      keyframePromptPreviewFrameType,
      keyframePromptPreviewRefFileIds,
      selectedShot?.id,
    ],
  )

  const orderedLinkedCharacterIds = useMemo(() => {
    return shotCharacterLinks
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((x) => x.character_id)
      .filter(Boolean)
      .map((x) => String(x))
  }, [shotCharacterLinks])

  const autoKeyframeRefFileIds = useMemo(() => {
    const out: string[] = []
    const push = (fid: string | null) => {
      if (!fid) return
      if (out.includes(fid)) return
      out.push(fid)
    }
    // 角色（按 index 顺序）
    orderedLinkedCharacterIds.forEach((cid) =>
      push(extractFileIdFromThumbnail(linkedAssetThumbByKey.get(`character:${cid}`) ?? null)),
    )
    // 场景（单个）
    if (linkedSceneId) push(extractFileIdFromThumbnail(linkedAssetThumbByKey.get(`scene:${linkedSceneId}`) ?? null))
    // 道具
    linkedPropIds.forEach((pid) => push(extractFileIdFromThumbnail(linkedAssetThumbByKey.get(`prop:${pid}`) ?? null)))
    // 服装
    linkedCostumeIds.forEach((cid) =>
      push(extractFileIdFromThumbnail(linkedAssetThumbByKey.get(`costume:${cid}`) ?? null)),
    )
    return out
  }, [
    extractFileIdFromThumbnail,
    linkedCostumeIds,
    linkedPropIds,
    linkedSceneId,
    linkedAssetThumbByKey,
    orderedLinkedCharacterIds,
  ])

  const moveKeyframePromptRefFile = useCallback((fromIndex: number, toIndex: number) => {
    const current = keyframePromptPreviewRefFileIds
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= current.length || toIndex >= current.length) return
    const next = reorder(current, fromIndex, toIndex)
    keyframePromptDraft.setContext({ refFileIds: next })
  }, [keyframePromptDraft, keyframePromptPreviewRefFileIds])

  const loadProjectRoleOptions = async () => {
    if (!projectId) {
      setProjectRoleOptions([])
      return
    }
    setLinkRoleLoading(true)
    try {
      /**
       * 角色选项：实体列表接口**不支持按项目过滤**，只能取全局角色再按 `project_id` 过滤。
       * 以前只取第 1 页 20 条，于是「全局角色超过 20 个」的项目里下拉恒为空 ——
       * 关联角色这一步在页面上等于做不了。这里分页拉取（一次 100 条，最多 5 页）
       * 直到不够一页为止，与工作台 `useProjectStepSignals` 的口径保持一致。
       */
      const collected: any[] = []
      for (let page = 1; page <= 5; page += 1) {
        const res = await StudioEntitiesApi.list('character', { page, pageSize: 100, q: null, isDesc: true })
        const batch = (res.data?.items ?? []) as any[]
        collected.push(...batch.filter((x: any) => x?.project_id === projectId))
        if (batch.length < 100) break
      }
      const opts = collected.map((c: any) => {
        const id = String(c?.id ?? '')
        const name = String(c?.name ?? id)
        const thumb = typeof c?.thumbnail === 'string' ? c.thumbnail : ''
        const disabled = linkedCharacterIds.includes(id)
        return {
          value: id,
          searchLabel: name,
          disabled,
          label: (
            <div className="flex items-center gap-2 min-w-0">
              {thumb ? (
                <img src={resolveAssetUrl(thumb)} alt="" className="w-6 h-6 rounded object-cover shrink-0" />
              ) : (
                <div className="w-6 h-6 rounded bg-gray-100 flex items-center justify-center text-gray-400 shrink-0">
                  <UserOutlined />
                </div>
              )}
              <div className="min-w-0 truncate">{name}</div>
            </div>
          ),
        }
      })
      setProjectRoleOptions(opts)
    } catch {
      setProjectRoleOptions([])
    } finally {
      setLinkRoleLoading(false)
    }
  }

  const loadProjectAssetOptions = async (kind: 'scene' | 'prop' | 'costume') => {
    if (!projectId) return
    if (kind === 'scene') setLinkSceneLoading(true)
    if (kind === 'prop') setLinkPropLoading(true)
    if (kind === 'costume') setLinkCostumeLoading(true)
    try {
      const res = await StudioShotLinksService.listProjectEntityLinksApiV1StudioShotLinksEntityTypeGet({
        entityType: kind,
        projectId,
        chapterId: null,
        shotId: null,
        assetId: null,
        order: null,
        isDesc: false,
        page: 1,
        pageSize: 20,
      })
      const items = (res.data?.items ?? []) as any[]
      const ids = Array.from(
        new Set(
          items
            .map((it) => (kind === 'scene' ? it.scene_id : kind === 'prop' ? it.prop_id : it.costume_id))
            .filter(Boolean)
            .map((x) => String(x)),
        ),
      )
      const details = await Promise.all(
        ids.map(async (id) => {
          try {
            const r = await StudioEntitiesApi.get(kind as any, id)
            const d = (r.data ?? null) as any
            return { id, name: String(d?.name ?? id), thumb: typeof d?.thumbnail === 'string' ? d.thumbnail : '' }
          } catch {
            return { id, name: id, thumb: '' }
          }
        }),
      )
      const nextThumbMap: Record<string, string> = {}
      details.forEach((d) => {
        if (d.thumb) nextThumbMap[d.id] = d.thumb
      })

      const makeLabel = (d: { id: string; name: string; thumb: string }) => (
        <div className="flex items-center gap-2 min-w-0">
          {d.thumb ? (
            <img src={resolveAssetUrl(d.thumb)} alt="" className="w-6 h-6 rounded object-cover shrink-0" />
          ) : (
            <div className="w-6 h-6 rounded bg-gray-100 flex items-center justify-center text-gray-400 shrink-0">
              <UserOutlined />
            </div>
          )}
          <div className="min-w-0 truncate">{d.name}</div>
        </div>
      )

      if (kind === 'scene') {
        setProjectSceneOptions(details.map((d) => ({ value: d.id, searchLabel: d.name, label: makeLabel(d) })))
      } else if (kind === 'prop') {
        setProjectPropOptions(
          details.map((d) => ({ value: d.id, searchLabel: d.name, label: makeLabel(d), disabled: linkedPropIds.includes(d.id) })),
        )
      } else {
        setProjectCostumeOptions(
          details.map((d) => ({ value: d.id, searchLabel: d.name, label: makeLabel(d), disabled: linkedCostumeIds.includes(d.id) })),
        )
      }
    } finally {
      if (kind === 'scene') setLinkSceneLoading(false)
      if (kind === 'prop') setLinkPropLoading(false)
      if (kind === 'costume') setLinkCostumeLoading(false)
    }
  }

  const openReadinessLinker = useCallback(
    async (kind: 'characters' | 'scene' | 'props' | 'costumes') => {
      if (!selectedShot?.id) return
      if (kind === 'characters') {
        onStudioStepChange('binding')
        setLinkRoleSelectedIds([])
        setLinkRoleOpen(true)
        await loadProjectRoleOptions()
        return
      }
      if (kind === 'scene') {
        onStudioStepChange('binding')
        setLinkSceneOpen(true)
        await loadProjectAssetOptions('scene')
        return
      }
      if (kind === 'props') {
        onStudioStepChange('binding')
        setLinkPropSelectedIds([])
        setLinkPropOpen(true)
        await loadProjectAssetOptions('prop')
        return
      }
      onStudioStepChange('binding')
      setLinkCostumeSelectedIds([])
      setLinkCostumeOpen(true)
      await loadProjectAssetOptions('costume')
    },
    [loadProjectAssetOptions, loadProjectRoleOptions, selectedShot?.id],
  )

  const openReadinessCreate = useCallback((kind: 'characters' | 'scene' | 'props' | 'costumes' | 'products', name: string) => {
    if (!projectId || !selectedShot?.id) return
    const currentShotId = selectedShot.id
    const styleQ =
      `&visualStyle=${encodeURIComponent(projectVisualStyle)}` +
      `&style=${encodeURIComponent(projectStyle)}`
    const ctxQ =
      `&projectId=${encodeURIComponent(projectId)}` +
      `&chapterId=${encodeURIComponent(currentChapterId ?? '')}` +
      `&shotId=${encodeURIComponent(currentShotId)}` +
      styleQ
    const open = (url: string) => window.open(url, '_blank', 'noopener,noreferrer')
    if (kind === 'characters') {
      open(`/projects/${encodeURIComponent(projectId)}?tab=roles&create=1&name=${encodeURIComponent(name)}${ctxQ}`)
      return
    }
    const tab =
      kind === 'scene' ? 'scene' : kind === 'props' ? 'prop' : kind === 'products' ? 'product' : 'costume'
    open(`/assets?tab=${tab}&create=1&name=${encodeURIComponent(name)}${ctxQ}`)
  }, [currentChapterId, projectId, projectStyle, projectVisualStyle, selectedShot?.id])

  const handleReadinessMissingAction = useCallback(async (
    kind: 'characters' | 'scene' | 'props' | 'costumes' | 'products',
    name: string,
  ) => {
    const item = readinessExistenceMap[`${kind}:${normalizeAssetName(name)}`]
    if (kind === 'products') {
      /* 商品是第五类资产（契约 §六）：
         - 资产库里还没有 → 打开商品页新建（带上名称与项目上下文，与其余几类同一口径）；
         - 已经有了 → **一键关联到本镜**（写 project_product_links），
           不另开一个"选商品"弹窗（商品没有出图通道，不需要挑图/挑演员那套东西）。 */
      if (!item || !item.exists) {
        openReadinessCreate(kind, name)
        return
      }
      const productId = String(item.asset_id ?? '')
      if (!projectId || !selectedShot?.id || !productId) return
      try {
        await createShotProductLink({
          project_id: projectId,
          chapter_id: currentChapterId ?? '',
          shot_id: selectedShot.id,
          asset_id: productId,
        })
        message.success('已把这个商品关联到本镜')
        await onRefreshShotAssetsOverview(selectedShot.id)
      } catch (error) {
        message.error(defaultTaskActionErrorMessage(error, '关联商品失败'))
      }
      return
    }
    if (item && !item.exists) {
      openReadinessCreate(kind, name)
      return
    }
    await openReadinessLinker(kind)
  }, [
    currentChapterId,
    onRefreshShotAssetsOverview,
    openReadinessCreate,
    openReadinessLinker,
    projectId,
    readinessExistenceMap,
    selectedShot?.id,
  ])

  useEffect(() => {
    if (sceneIds.length === 0) {
      setSceneNameMap({})
      return
    }
    void (async () => {
      const entries = await Promise.all(
        sceneIds.map(async (id) => {
          try {
            const r = await StudioEntitiesApi.get('scene', id)
            const d = r.data as { name?: string } | null | undefined
            return [id, d?.name?.trim() || id] as const
          } catch {
            return [id, id] as const
          }
        }),
      )
      setSceneNameMap(Object.fromEntries(entries))
    })()
  }, [sceneIds])

  useEffect(() => {
    if (characterIds.length === 0) {
      setCharacterNameMap({})
      return
    }
    void (async () => {
      const entries = await Promise.all(
        characterIds.map(async (id) => {
          try {
            const r = await StudioEntitiesApi.get('character', id)
            const d = r.data as { name?: string; thumbnail?: string | null } | null | undefined
            const name = d?.name?.trim() || id
            const thumb = typeof d?.thumbnail === 'string' && d.thumbnail.trim() ? d.thumbnail.trim() : ''
            return { id, name, thumb }
          } catch {
            return { id, name: id, thumb: '' }
          }
        }),
      )
      const nextNameMap: Record<string, string> = {}
      entries.forEach((e) => {
        nextNameMap[e.id] = e.name
      })
      setCharacterNameMap(nextNameMap)
    })()
  }, [characterIds])

  const getPromptFromDetailByType = (frameType: PromptFrameType): string => {
    if (!shotDetail) return ''
    if (frameType === 'first') return shotDetail.first_frame_prompt ?? ''
    if (frameType === 'last') return shotDetail.last_frame_prompt ?? ''
    return shotDetail.key_frame_prompt ?? ''
  }

  const frameLabel: Record<PromptFrameType, string> = { first: '首帧', key: '关键帧', last: '尾帧' }

  const handleRefFrameTypeDropdownVisibleChange = useCallback(
    async (open: boolean) => {
      if (!open || !onRefreshShotFrameImages) return
      setRefFrameTypeSelectLoading(true)
      try {
        await onRefreshShotFrameImages()
      } finally {
        setRefFrameTypeSelectLoading(false)
      }
    },
    [onRefreshShotFrameImages],
  )

  const refFrameTypeOptions = useMemo(() => {
    const kinds = new Set((frameImages ?? []).map((x) => x.frame_type))
    const opts: Array<{ value: string; label: string }> = []
    if (kinds.has('first')) opts.push({ value: 'first', label: '首帧' })
    if (kinds.has('last')) opts.push({ value: 'last', label: '尾帧' })
    if (kinds.has('first') && kinds.has('last')) opts.push({ value: 'first_last', label: '首尾帧' })
    if (kinds.has('key')) opts.push({ value: 'key', label: '关键帧' })
    return opts
  }, [frameImages])

  useEffect(() => {
    const allowed = new Set(refFrameTypeOptions.map((x) => x.value))
    setRefImageType((prev) => (prev && allowed.has(prev) ? prev : undefined))
  }, [refFrameTypeOptions])

  const buildVideoRefSelection = () => {
    const first = frameImages.find((x) => x.frame_type === 'first')?.file_id ?? null
    const last = frameImages.find((x) => x.frame_type === 'last')?.file_id ?? null
    const key = frameImages.find((x) => x.frame_type === 'key')?.file_id ?? null

    const s = refImageType
    if (s === 'first_last') {
      return {
        referenceMode: 'first_last' as const,
        images: [first, last].filter((x): x is string => Boolean(x)),
      }
    }
    if (s === 'key') return { referenceMode: 'key' as const, images: key ? [key] : [] }
    if (s === 'first') return { referenceMode: 'first' as const, images: first ? [first] : [] }
    if (s === 'last') return { referenceMode: 'last' as const, images: last ? [last] : [] }
    return { referenceMode: 'text_only' as const, images: [] }
  }

  const openVideoPromptPreview = async () => {
    if (!selectedShot?.id) {
      message.warning('请先选择一个分镜')
      return
    }
    const { referenceMode, images } = buildVideoRefSelection()
    const nextContext = { referenceMode, images }
    const savedPrompt = (shotDetail?.video_prompt ?? '').trim()
    const savedSource = String(shotDetail?.video_prompt_source ?? '').trim()
    // 已保存的提示词优先回填到输入框，避免 LLM 结果把它静默覆盖掉。
    videoPromptDraft.hydrate({
      base: { prompt: savedPrompt },
      context: nextContext,
    })
    setVideoPromptContextCollapsed(true)
    setVideoPinnedPlan(null)
    setVideoPromptPreviewOpen(true)
    setVideoPromptPreviewLoading(true)
    // 计划预览用到的提示词与参考图（带提示词请求时后端只做本地组装，不会触发 LLM 出词）。
    let planPrompt = savedPrompt
    let planImages = images
    try {
      const derived = await videoPromptDraft.deriveNow({
        base: { prompt: '' },
        context: nextContext,
      })
      if (derived) {
        const llmPrompt = (derived.prompt ?? '').trim()
        setVideoLlmDerivedPrompt(llmPrompt)
        const initialPrompt = savedPrompt || derived.prompt
        planPrompt = initialPrompt
        planImages = derived.images
        videoPromptDraft.hydrate({
          base: { prompt: initialPrompt },
          context: {
            referenceMode,
            images: derived.images,
          },
          derived: {
            ...derived,
            prompt: initialPrompt,
          },
        })
        if (savedPrompt) {
          if (savedPrompt !== llmPrompt) {
            message.warning(
              `已载入该镜头已保存的视频提示词（来源：${videoPromptSourceLabel(savedSource)}），本次大模型生成结果未覆盖它；` +
                '如需改用本次生成结果，请在弹窗内点击「使用本次大模型结果」。',
            )
          } else {
            message.info('已载入该镜头已保存的视频提示词')
          }
        }
      }
    } catch {
      message.error('获取视频提示词预览失败')
    } finally {
      setVideoPromptPreviewLoading(false)
    }
    if (planPrompt) {
      // 固定模型直提计划：只预览（不提交、不触网），用于如实展示后端固定策略与 DRY_RUN 守卫状态。
      void previewVideoSubmitPlan({
        shot_id: selectedShot.id,
        reference_mode: referenceMode,
        prompt: planPrompt,
        images: planImages,
        ratio: resolveVideoRatioForRequest(),
      })
        .then((plan) => setVideoPinnedPlan(normalizeVideoPinnedPlan(plan)))
        .catch(() => setVideoPinnedPlan(null))
    }
  }

  /**
   * 保存视频提示词到镜头（`shot_details.video_prompt` + `video_prompt_source`）。
   *
   * 来源判定：与本次大模型生成结果完全一致 → `llm`；被人工改过 → `internal`。
   * 保存后回读一次详情，让 inspector 立刻显示已持久化的值（与 patchShotDetailImmediate 同款做法）。
   */
  const saveVideoPromptToShot = async () => {
    if (!selectedShot?.id) {
      message.warning('请先选择一个分镜')
      return
    }
    const prompt = (videoPromptPreviewDraft || '').trim()
    if (!prompt) {
      message.warning('提示词为空，无法保存')
      return
    }
    const llmPrompt = videoLlmDerivedPrompt.trim()
    const source = llmPrompt && prompt === llmPrompt ? 'llm' : 'internal'
    const shotId = selectedShot.id
    setVideoPromptSaving(true)
    try {
      await saveShotVideoPrompt(shotId, prompt, source)
      const refreshed = await StudioShotDetailsService.getShotDetailApiV1StudioShotDetailsShotIdGet({ shotId })
      if (refreshed.data) onPatchShotDetail(refreshed.data)
      message.success(`视频提示词已保存到镜头（来源：${videoPromptSourceLabel(source)}）`)
    } catch (err) {
      void showUserError(err, '保存视频提示词失败')
    } finally {
      setVideoPromptSaving(false)
    }
  }

  /** 放弃已保存/人工编辑内容，改用本次大模型生成结果（保存时会标记为 llm 来源）。 */
  const applyVideoLlmDerivedPrompt = () => {
    const llmPrompt = videoLlmDerivedPrompt.trim()
    if (!llmPrompt) {
      message.warning('本次没有可用的大模型生成结果')
      return
    }
    const currentDerived = videoPromptDraft.derived
    videoPromptDraft.hydrate({
      base: { prompt: llmPrompt },
      context: videoPromptDraft.context,
      derived: currentDerived
        ? { ...currentDerived, prompt: llmPrompt }
        : { prompt: llmPrompt, images: videoPromptDraft.context.images, pack: null },
    })
    message.info('已切换为本次大模型生成结果')
  }

  /**
   * 明确「重新生成」：把 attempt 加 1，换一个新的幂等键，才会真的再调用一次供应商。
   *
   * 为什么必须有这个按钮：没有它，用户在"结果不满意"时只能再点一次「生成」——而那是
   * 同一轮，会被后端正确地判成复用（不重复扣费），于是表现为"点了没反应"。
   * 语义要在这里说清楚：这是**会再花一次钱**的动作。
   */
  const regenerateVideoGeneration = async () => {
    videoAttemptRef.current += 1
    message.info(
      `已开始第 ${videoAttemptRef.current + 1} 轮生成（重新生成会真的再产生一次费用）。`,
      6,
    )
    await submitVideoGeneration()
  }

  const submitVideoGeneration = async () => {
    if (!selectedShot?.id) {
      message.warning('请先选择一个分镜')
      return
    }
    if (!resolveVideoRatioForRequest()) {
      message.warning('当前镜头缺少视频比例，请先设置项目默认比例或镜头覆盖比例')
      return
    }
    const prompt = (videoPromptPreviewDraft || '').trim()
    if (!prompt) {
      message.warning('请输入视频提示词')
      return
    }
    setVideoPromptPreviewSubmitting(true)
    try {
      const submitted = await videoPromptDraft.submitNow()
      const result = submitted as
        | { taskId: string | null; gated?: boolean; completed?: boolean; videoUrl?: string }
        | null
      if (result?.gated) {
        // DRY_RUN 提示已经在提交实现里说清楚了，这里不再叠加误导性的红字。
        return
      }
      if (result?.completed && result.videoUrl) {
        // 内联执行已完成的成功路径：本轮就结束，不启动任何轮询。
        setVideoTaskId(result.taskId ?? null)
        setVideoTaskStatus('已生成')
        setVideoTaskPolling(false)
        setVideoSettledTask(null)
        setVideoTask(null)
        setVideoPromptPreviewOpen(false)
        message.success('视频已生成并写入本镜')
        return
      }
      const taskId = result?.taskId
      if (!taskId) {
        // 审计 §4.3 模式 2/3：主区不出现「接口」「任务 ID」
        message.error('视频没有生成出来：服务没有返回成片，请重试')
        return
      }
      setVideoTaskId(taskId)
      setVideoTaskStatus('排队中')
      setVideoTaskPolling(true)
      setVideoTask({
        taskId,
        status: 'pending',
        progress: 0,
        cancelRequested: false,
      })
      setVideoSettledTask(null)
      setVideoPromptPreviewOpen(false)
    } catch (error) {
      // 真实原因照原样显示（DRY_RUN / 模型未配置 / 参数缺失 / 服务错误都能看出来）
      const failure = classifyGenerationFailure(error, 'video')
      setVideoTaskStatus(null)
      setVideoTaskPolling(false)
      message.error(failureText(failure))
    } finally {
      setVideoPromptPreviewSubmitting(false)
    }
  }

  useEffect(() => {
    if (!videoTaskPolling || !videoTaskId) return
    let cancelled = false
    void (async () => {
      try {
        let finalTaskState: RelationTaskState | null = null
        for (let i = 0; i < 60; i += 1) {
          await sleep(2000)
          if (cancelled) return
          const statusRes = await FilmService.getTaskStatusApiV1FilmTasksTaskIdStatusGet({ taskId: videoTaskId })
          const status = statusRes.data?.status ?? null
          if (!status) continue
          if (statusRes.data) {
            finalTaskState = toRelationTaskStateFromStatusRead(statusRes.data)
            setVideoTask(finalTaskState)
          }
          setVideoTaskStatus(status)
          if (status === 'succeeded' || status === 'failed' || status === 'cancelled') break
        }
        if (
          !cancelled &&
          finalTaskState &&
          (finalTaskState.status === 'succeeded' ||
            finalTaskState.status === 'failed' ||
            finalTaskState.status === 'cancelled')
        ) {
          setVideoTask(null)
          setVideoSettledTask(finalTaskState)
        }
      } catch {
        if (!cancelled) {
          message.error('获取视频任务状态失败')
        }
      } finally {
        if (!cancelled) setVideoTaskPolling(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [videoTaskPolling, videoTaskId])
  const updateCardState = (frameType: PromptFrameType, patch: Partial<KeyframeCardState>) => {
    setKeyframeCards((prev) => ({ ...prev, [frameType]: { ...prev[frameType], ...patch } }))
  }

  const getLatestFrameSlotId = async (frameType: PromptFrameType): Promise<number | null> => {
    if (!selectedShot?.id) return null
    const res = await StudioShotFrameImagesService.listShotFrameImagesApiV1StudioShotFrameImagesGet({
      shotDetailId: selectedShot.id,
      order: null,
      isDesc: false,
      page: 1,
      pageSize: 100,
    })
    const items = (res.data?.items ?? []) as ShotFrameImageRead[]
    const slot = items.find((x) => x.frame_type === frameType)
    return slot?.id ?? null
  }

  const loadCardThumbs = async (frameType: PromptFrameType, slotIdOverride?: number | null, retryCount = 1) => {
    const localSlotId = frameImages.find((x) => x.frame_type === frameType)?.id ?? null
    const slotId = slotIdOverride ?? localSlotId ?? (await getLatestFrameSlotId(frameType))
    if (!slotId) {
      updateCardState(frameType, { thumbs: [] })
      return
    }
    let thumbs: Array<{ linkId: number; fileId: string; thumbUrl: string }> = []
    for (let i = 0; i < retryCount; i += 1) {
      const links = await listTaskLinksNormalized({
        resourceType: 'image',
        relationType: 'shot_frame_image',
        relationEntityId: String(slotId),
        order: 'updated_at',
        isDesc: true,
        page: 1,
        pageSize: 100,
      })
      const seen = new Set<string>()
      thumbs = links
        .filter((l) => Boolean(l.file_id))
        .filter((l) => {
          const fid = String(l.file_id)
          if (seen.has(fid)) return false
          seen.add(fid)
          return true
        })
        .map((l) => ({
          linkId: l.id,
          fileId: String(l.file_id),
          thumbUrl: buildFileDownloadUrl(String(l.file_id)) ?? '',
        }))
      if (thumbs.length > 0 || i === retryCount - 1) break
      await sleep(800)
    }
    updateCardState(frameType, { thumbs })
  }

  const generateKeyframeCard = async (frameType: PromptFrameType) => {
    if (!selectedShot?.id) {
      message.warning('请先选择一个分镜')
      return
    }
    try {
      setKeyframePromptPreviewLoading(true)
      setKeyframePromptPreviewOpen(true)
      setKeyframePromptPreviewFrameType(frameType)
      setKeyframePromptDebugCollapsed(true)
      setKeyframeDirectiveCollapsed(true)
      setKeyframePromptDecisionCollapsed(true)
      const basePrompt = getPromptFromDetailByType(frameType)
      keyframePromptDraft.hydrate({
        base: { frameType, prompt: basePrompt },
        context: { refFileIds: autoKeyframeRefFileIds },
        state: basePrompt.trim() ? 'draft_changed' : 'idle',
      })
      setKeyframePromptDebugContext(null)
      setKeyframePromptQualityChecks(null)
      // 文本区域内容：统一由 frame-render-prompt 获取
      if (basePrompt.trim()) {
        void renderShotPromptToTextarea({
          frameType,
          prompt: basePrompt,
          refFileIds: autoKeyframeRefFileIds,
          showPreviewLoading: true,
        })
      } else {
        setKeyframePromptPreviewLoading(false)
      }
    } catch {
      message.error('获取提示词失败')
      setKeyframePromptPreviewLoading(false)
    } finally {
      // loading 由 renderShotPromptToTextarea 结束后关闭
    }
  }

  const regenerateKeyframePrompt = async () => {
    if (!selectedShot?.id) {
      message.warning('请先选择一个分镜')
      return
    }
    const frameType = keyframePromptPreviewFrameType
    setKeyframePromptActionLoading(true)
    try {
      const created = await FilmService.createShotFramePromptTaskApiV1FilmTasksShotFramePromptsPost({
        requestBody: {
          shot_id: selectedShot.id,
          frame_type: frameType,
        },
      })
      const taskId = created.data?.task_id
      if (!taskId) {
        message.error('提示词生成没能启动，请重试')
        return
      }
      setPromptTask({
        taskId,
        status: 'pending',
        progress: 0,
        cancelRequested: false,
      })
      setPromptSettledTask(null)

      let finalStatus = 'pending'
      let finalTaskState: RelationTaskState | null = null
      for (let i = 0; i < 30; i += 1) {
        await sleep(2000)
        const statusRes = await FilmService.getTaskStatusApiV1FilmTasksTaskIdStatusGet({ taskId })
        const status = statusRes.data?.status
        if (!status) continue
        finalStatus = status
        if (statusRes.data) {
          finalTaskState = toRelationTaskStateFromStatusRead(statusRes.data)
          setPromptTask(finalTaskState)
        }
        if (status === 'succeeded' || status === 'failed' || status === 'cancelled') break
      }
      if (
        finalTaskState &&
        (finalTaskState.status === 'succeeded' ||
          finalTaskState.status === 'failed' ||
          finalTaskState.status === 'cancelled')
      ) {
        setPromptTask(null)
        setPromptSettledTask(finalTaskState)
      }

      if (finalStatus !== 'succeeded') {
        if (finalStatus !== 'failed' && finalStatus !== 'cancelled') {
          message.warning('生成任务仍在执行，请稍后重试')
        }
        return
      }

      const resultRes = await FilmService.getTaskResultApiV1FilmTasksTaskIdResultGet({ taskId })
      const result = (resultRes.data?.result ?? null) as Record<string, unknown> | null
      const generatedPrompt = typeof result?.prompt === 'string' ? result.prompt : ''
      const debugContext =
        result && typeof result.debug_context === 'object' && result.debug_context !== null
          ? (result.debug_context as ShotFramePromptDebugContext)
          : null
      const qualityChecks =
        result &&
        typeof result.quality_checks === 'object' &&
        result.quality_checks !== null &&
        typeof (result.quality_checks as Record<string, unknown>).passed === 'boolean'
          ? {
              passed: Boolean((result.quality_checks as Record<string, unknown>).passed),
              issues: Array.isArray((result.quality_checks as Record<string, unknown>).issues)
                ? ((result.quality_checks as Record<string, unknown>).issues as unknown[])
                    .map((item) => (typeof item === 'string' ? item.trim() : ''))
                    .filter(Boolean)
                : [],
            }
          : null
      if (!generatedPrompt.trim()) {
        message.warning('生成完成，但未返回提示词')
        return
      }
      if (frameType === 'first') {
        onPatchShotDetail({ first_frame_prompt: generatedPrompt })
      } else if (frameType === 'last') {
        onPatchShotDetail({ last_frame_prompt: generatedPrompt })
      } else {
        onPatchShotDetail({ key_frame_prompt: generatedPrompt })
      }
      setKeyframePromptDebugContext(debugContext)
      setKeyframePromptQualityChecks(qualityChecks)
      keyframePromptDraft.replaceBase({ frameType, prompt: generatedPrompt })
      keyframePromptDraft.setState('draft_changed')
      await renderShotPromptToTextarea({
        frameType,
        prompt: generatedPrompt,
        refFileIds: keyframePromptPreviewRefFileIds.length > 0 ? keyframePromptPreviewRefFileIds : autoKeyframeRefFileIds,
      })
      message.success('提示词已生成')
    } catch {
      message.error('生成提示词失败')
    } finally {
      setKeyframePromptActionLoading(false)
    }
  }

  useEffect(() => {
    // 弹窗打开时，若当前没有参考图，则自动填充为分镜关联实体的参考图
    if (!keyframePromptPreviewOpen) return
    if (keyframePromptPreviewRefFileIds.length > 0) return
    if (autoKeyframeRefFileIds.length === 0) return
    keyframePromptDraft.setContext({ refFileIds: autoKeyframeRefFileIds })
  }, [autoKeyframeRefFileIds, keyframePromptPreviewOpen, keyframePromptPreviewRefFileIds.length])

  useEffect(() => {
    if (!keyframePromptPreviewOpen) return
    if (mapGenerationDraftStateToRenderState(keyframePromptRenderState) !== 'stale') return
    const basePrompt = (keyframePromptPreviewDraft || '').trim()
    if (!basePrompt) return
    const refFileIds =
      keyframePromptPreviewRefFileIds.length > 0 ? keyframePromptPreviewRefFileIds : autoKeyframeRefFileIds
    const timer = window.setTimeout(() => {
      void renderShotPromptToTextarea({
        frameType: keyframePromptPreviewFrameType,
        prompt: basePrompt,
        refFileIds,
      })
    }, 400)
    return () => {
      window.clearTimeout(timer)
    }
  }, [
    autoKeyframeRefFileIds,
    keyframePromptPreviewDraft,
    keyframePromptPreviewFrameType,
    keyframePromptPreviewOpen,
    keyframePromptPreviewRefFileIds,
    keyframePromptRenderState,
    renderShotPromptToTextarea,
  ])

  /**
   * 后端「这一帧到底会用哪条提示词 / 哪些参考图」的计划预览（只读、不触网、不写库）。
   *
   * 为什么要多这一份：界面上的草稿和真正提交的入参是两回事 —— 用户要能一眼看到
   * 提交读的是**镜头里已保存的**帧提示词（来源标签），而不是"我以为的"。
   */
  const loadKeyframePlanPreview = useCallback(
    async (frameType: PromptFrameType) => {
      if (!selectedShot?.id) return
      const ratio = resolveVideoRatioForRequest()
      const refFileIds =
        keyframePromptPreviewRefFileIds.length > 0 ? keyframePromptPreviewRefFileIds : autoKeyframeRefFileIds
      try {
        const plan = await previewFramePlan({
          shot_id: selectedShot.id,
          frame_type: frameType,
          images: refFileIds,
          target_ratio: ratio,
          resolution_profile: keyframeResolutionProfile,
          model_id: keyframeImageModelId || null,
        })
        setKeyframePlanPreview(plan)
      } catch (error) {
        setKeyframePlanPreview(null)
        void showUserWarning(error, '读取关键帧提交计划失败')
      }
    },
    [
      autoKeyframeRefFileIds,
      keyframeImageModelId,
      keyframePromptPreviewRefFileIds,
      keyframeResolutionProfile,
      resolveVideoRatioForRequest,
      selectedShot?.id,
    ],
  )

  useEffect(() => {
    if (!keyframePromptPreviewOpen || !selectedShot?.id) {
      setKeyframePlanPreview(null)
      return
    }
    const timer = window.setTimeout(() => {
      void loadKeyframePlanPreview(keyframePromptPreviewFrameType)
    }, 300)
    return () => {
      window.clearTimeout(timer)
    }
  }, [
    keyframePromptPreviewFrameType,
    keyframePromptPreviewOpen,
    loadKeyframePlanPreview,
    selectedShot?.id,
  ])

  /**
   * 把弹窗里的提示词保存到镜头（`shot_details.first/key/last_frame_prompt`）。
   *
   * 为什么必须有这一步：关键帧提交时"没填 prompt"的兜底读的就是这几个字段。
   * 只改了输入框不保存，下一次打开又是空的，也就谈不上"保存内容被下一步实际使用"。
   */
  const saveKeyframePromptToShot = async () => {
    if (!selectedShot?.id) return
    const frameType = keyframePromptPreviewFrameType
    const prompt = (keyframePromptPreviewDraft || '').trim()
    if (!prompt) {
      message.warning('提示词为空，未保存')
      return
    }
    const field = framePromptField(frameType)
    setKeyframePromptActionLoading(true)
    try {
      await onPatchShotDetailImmediate({ [field]: prompt } as Partial<ShotDetailRead>)
      keyframePromptDraft.setState('submitted')
      message.success(`已保存到本镜（${frameLabel[frameType]}提示词，${prompt.length} 字）`)
      await loadKeyframePlanPreview(frameType)
    } catch (error) {
      void showUserError(error, '保存失败')
    } finally {
      setKeyframePromptActionLoading(false)
    }
  }

  /** 范围内每镜的就绪结果（命中范围：勾选优先，否则当前集） */
  const scopeReadiness: ShotReadiness[] = useMemo(() => {
    const byId = new Map(readinessRows.map((item) => [String(item.shot_id), item]))
    const rows = scopeRows.length
      ? scopeRows
      : readinessRows.map((item) => ({
          shot_id: String(item.shot_id),
          shot_code: String(item.code ?? ''),
          shot_title: String(item.title ?? ''),
          video_prompt: String(item.video_prompt ?? ''),
          video_prompt_source: String(item.video_prompt_source ?? ''),
          exportable: Boolean(item.has_prompt),
          bound_files: [],
        }))
    return rows.map((row) => {
      const real = byId.get(row.shot_id)
      return evaluateShotReadiness({
        row,
        // 关键：用**真实**的必需帧 / 可用帧，不再传空数组把缺帧镜头算成可生成
        requiredFrameTypes: (real?.required_frame_types as string[]) ?? [],
        usableFrameTypes: (real?.usable_frame_types as string[]) ?? [],
        // 有 file_id 但供应商取不到（本机地址只能变 data URL）→ 与缺帧一样阻断，
        // 但提示要区分开："已上传但供应商无法访问"，不是"没上传"。
        unusableFrameTypes: (real?.unusable_frame_types as string[]) ?? [],
        frameBlockReasons: (real?.frame_block_reasons as string[]) ?? [],
        planReady: true,
        extraBlockers: [],
      })
    })
  }, [readinessRows, scopeRows])

  const scopeState = summarizeStepState(scopeReadiness.map((item) => item.stepState))

  /** 各步骤对该镜的要求（判定口径只有这一份，见 shotReadiness.ts） */
  /** 同一份就绪数据 → 按当前步骤取状态（口径只此一处） */
  const shotSatisfiesStep = useCallback(
    (state: ReturnType<typeof evaluateShotReadiness>): boolean => {
      if (studioStepKey === 'video_prompt') return state.canExport // 有效提示词（来源白名单内）
      if (studioStepKey === 'binding') return state.hasBoundFiles
      return state.canGenerate // 生成步骤：提示词 + 参考帧 + 阻断项
    },
    [studioStepKey],
  )

  /**
   * 进入工作室 / 切换步骤时，自动落到**该步骤下第一个未完成镜头**。
   *
   * 每一步只自动定位一次：用户在同一步里主动点选其它镜头后不再抢焦点；
   * 切到另一步会重新定位到那一步的第一个未完成镜头（第三部分要求）。
   */
  useEffect(() => {
    // 必须**两份数据都到位**才判定：只有交付行、还没有集级就绪（含参考帧）时，
    // 缺帧的镜头会被误算成"满足"，自动定位就停在第一镜上（真实缺陷：生成步骤选错镜头）。
    if (autoLocatedStepRef.current === studioStepKey) return
    if (!episodeRows.length || !readinessRows.length) return
    const byId = new Map(readinessRows.map((item) => [String(item.shot_id), item]))
    const states = episodeRows.map((row) => {
      const real = byId.get(row.shot_id)
      return evaluateShotReadiness({
        row,
        requiredFrameTypes: (real?.required_frame_types as string[]) ?? [],
        usableFrameTypes: (real?.usable_frame_types as string[]) ?? [],
        // 有 file_id 但供应商取不到（本机地址只能变 data URL）→ 与缺帧一样阻断，
        // 但提示要区分开："已上传但供应商无法访问"，不是"没上传"。
        unusableFrameTypes: (real?.unusable_frame_types as string[]) ?? [],
        frameBlockReasons: (real?.frame_block_reasons as string[]) ?? [],
        planReady: true,
      })
    })
    const firstIncomplete = states.find((state) => !shotSatisfiesStep(state))
    autoLocatedStepRef.current = studioStepKey
    if (firstIncomplete && firstIncomplete.shotId !== selectedShot?.id) {
      onAutoLocateShot?.(firstIncomplete.shotId)
    }
  }, [episodeRows, onAutoLocateShot, readinessRows, selectedShot?.id, shotSatisfiesStep, studioStepKey])

  /** 导出范围：多选时按选中，否则按**当前集**（一镜的选择不该被当成"导出范围只有一镜"） */
  const exportReadiness: ShotReadiness[] = useMemo(() => {
    if ((selectedShotIds ?? []).length > 1) return scopeReadiness
    const byId = new Map(readinessRows.map((item) => [String(item.shot_id), item]))
    return episodeRows.map((row) => {
      const real = byId.get(row.shot_id)
      return evaluateShotReadiness({
        row,
        requiredFrameTypes: (real?.required_frame_types as string[]) ?? [],
        usableFrameTypes: (real?.usable_frame_types as string[]) ?? [],
        // 有 file_id 但供应商取不到（本机地址只能变 data URL）→ 与缺帧一样阻断，
        // 但提示要区分开："已上传但供应商无法访问"，不是"没上传"。
        unusableFrameTypes: (real?.unusable_frame_types as string[]) ?? [],
        frameBlockReasons: (real?.frame_block_reasons as string[]) ?? [],
        planReady: true,
      })
    })
  }, [episodeRows, readinessRows, scopeReadiness, (selectedShotIds ?? []).length])


  /**
   * 本镜生成计划与提交（**唯一一份**）：④本次实际使用的帧 / ⑤还缺什么 / ⑥生成视频 / ⑦导出 共用。
   * 预检、供应商帧可用性、DRY_RUN 守卫都在 `useShotRequestPlan` 里，页面不再各判一次。
   */
  const requestPlan = useShotRequestPlan({
    projectId,
    chapterId,
    shotId: selectedShot?.id ?? '',
    savedPrompt: String((shotDetail as unknown as { video_prompt?: string } | null)?.video_prompt ?? ''),
    onGenerated: async () => {
      if (!selectedShot?.id) return
      const refreshed = await StudioShotDetailsService.getShotDetailApiV1StudioShotDetailsShotIdGet({
        shotId: selectedShot.id,
      })
      if (refreshed.data) onPatchShotDetail(refreshed.data)
      await onShotDataChanged?.()
    },
  })

  /**
   * 第 3 批收尾（审计 §4.3 模式 4/6 + §7.1-6 成对文案）：④「本次请求实际使用的帧」里
   * 后端给的**帧不可用原因**（`reference_preflight` 会把本机 / 内网 host 拼进句子）——
   * 主区只出产品自己写的中文结论，原句只进技术详情层。
   */
  const requestFrameReasonNotes = useMemo(
    () => (requestPlan.plan?.frames ?? [])
      .map((frame: VideoPlanFrame) => describeFrameBlockReason(frame.reason).technicalDetail)
      .filter((item: string) => Boolean(item)),
    [requestPlan.plan],
  )

  /**
   * 第 3 批收尾：④ 的声音准入结论复用 `describeAudioAdmission` 的**同一份**口径 ——
   * 主区给中文结论，后端 `excluded_reason` / `how_to_fix`（可能带 `/files/...` 地址）只进技术详情。
   */
  const planAudioAdmission = useMemo(
    () => describeAudioAdmission(requestPlan.plan?.audio ?? null),
    [requestPlan.plan?.audio],
  )

  const confirmGenerateKeyframeWithPrompt = async () => {
    if (!selectedShot?.id) {
      message.warning('请先选择一个分镜')
      return
    }
    const frameType = keyframePromptPreviewFrameType
    const basePrompt = (keyframePromptPreviewDraft || '').trim()
    if (!basePrompt) {
      message.warning('请输入提示词')
      return
    }
    const ratio = resolveVideoRatioForRequest()
    if (!ratio) {
      message.warning('请先在项目设置或镜头里配置视频比例（关键帧要跟视频同画幅）')
      return
    }

    setKeyframePromptActionLoading(true)
    updateCardState(frameType, { loading: true, taskStatus: 'running', taskId: null })
    try {
      const refFileIds = keyframePromptPreviewRefFileIds.length > 0 ? keyframePromptPreviewRefFileIds : autoKeyframeRefFileIds
      keyframePromptDraft.replaceContext({ refFileIds })

      // 关键帧走**同进程内联**端点：队列那条路本机没有 broker/worker，
      // 只会留下一条永远 pending 的任务行（用户看到的就是「点了生成没反应」）。
      const result = await submitFrameImage({
        shot_id: selectedShot.id,
        frame_type: frameType,
        prompt: basePrompt,
        images: refFileIds,
        target_ratio: ratio,
        resolution_profile: keyframeResolutionProfile,
        model_id: keyframeImageModelId || null,
      })

      updateCardState(frameType, {
        taskId: result.task_id ?? null,
        taskStatus: result.status,
        lastFileId: result.file_id ?? null,
        lastPromptSource: result.prompt_source ?? null,
        lastReferenceFileIds: result.reference_file_ids ?? [],
        lastProviderNotes: result.provider_notes ?? [],
        lastElapsedMs: result.elapsed_ms ?? null,
      })

      if (result.task_id) {
        const snapshot: RelationTaskState = {
          taskId: result.task_id,
          status: result.status === 'succeeded' ? 'succeeded' : result.status === 'timeout' ? 'running' : 'failed',
          progress: result.status === 'succeeded' ? 100 : 0,
          cancelRequested: false,
        }
        setFrameImageTask(snapshot)
        setFrameImageSettledTask(snapshot)
      }

      const notes = result.provider_notes ?? []
      if (notes.length) {
        /* 审计 §4.3 模式 6：这是唯一一处把生成服务方的原话铺到主区 toast 的地方（`:5086`）。
           第 3 批收尾（审计 §7.1-6）：**主区给产品自己写的中文结论**，后端原话
           （可能含「参考图未透传」/ 存储地址 / 环境变量名）只进「技术详情」——
           走 `showUserConclusion` 而不是 `showUserWarning`，避免「后端长文本过一遍管道
           仍然是后端文本」这个上一批在交付预览上踩过的坑。 */
        void showUserConclusion(
          'warning',
          '生成服务对这次结果有额外说明（可能没有按你选的参考图出图）。建议先核对再采用；原始说明见「技术详情」。',
          notes.join('\n'),
          '生成关键帧',
        )
      }

      if (result.dry_run) {
        message.info('演练模式：未真实出图。以上是本次会用的提示词与参考图（来源已标注）。', 6)
        return
      }
      if (result.status === 'succeeded' && result.file_id) {
        const seconds = ((result.elapsed_ms ?? 0) / 1000).toFixed(1)
        message.success(`${frameLabel[frameType]}已生成并保存（${seconds}s，内部 ID 见「技术详情」）`)
        // 帧图列表由上层（ChapterStudio）持有：用它的刷新入口，避免本地 state 与库里脱节
        await onRefreshShotFrameImages?.()
        await loadCardThumbs(frameType, result.image_slot_id ?? null, 3)
        setKeyframePromptPreviewOpen(false)
        return
      }
      // 审计 §4.3 模式 3：不许把 `status=xxx` 拼进中文句
      message.error(toUserFacingText(result.error, `${frameLabel[frameType]}没能生成出来，请重试；若持续失败请到「技术详情」看原因`))
    } catch (error) {
      updateCardState(frameType, { taskStatus: 'failed' })
      void showUserError(error, `${frameLabel[frameType]}生成失败`)
    } finally {
      updateCardState(frameType, { loading: false })
      setKeyframePromptActionLoading(false)
    }
  }

  /**
   * 上传本地图片作为某一帧（首帧/关键帧/尾帧），走 `POST /studio/files/upload`
   * 拿 file_id，再写进 `shot_frame_images`（已有槽位 PATCH，没槽位则先 POST 建槽）。
   *
   * 为什么需要它：这一页此前只有「AI 生成 → 落库」一条路，缺帧时除了花钱生成
   * 没有任何办法把已有图片填进槽位（缺帧门禁就永远补不上）。上传不触发生图、
   * 不产生付费调用，也不改动作战的参考模式与提交参数。
   */
  const uploadKeyframeImage = async (frameType: PromptFrameType, file: File) => {
    if (!selectedShot?.id) return
    if (!/\.(jpe?g|png|webp|gif)$/i.test(file.name)) {
      message.error('请上传图片文件（jpg / jpeg / png / webp / gif）')
      return
    }
    updateCardState(frameType, { uploading: true })
    try {
      const uploaded = await StudioFilesService.uploadFileApiApiV1StudioFilesUploadPost({
        formData: {
          file: file as unknown as string,
          project_id: projectId ?? null,
          chapter_id: chapterId ?? null,
          shot_id: selectedShot.id,
          usage_kind: projectId ? 'shot_frame' : null,
        },
        name: file.name.replace(/\.[^.]+$/, ''),
      })
      const fileId = String((uploaded.data as unknown as { id?: string } | undefined)?.id ?? '').trim()
      if (!fileId) {
        message.error('上传成功但没有拿到文件编号，请刷新后重试')
        return
      }
      const slot = frameImages.find((x) => x.frame_type === frameType)
      if (slot) {
        await StudioShotFrameImagesService.updateShotFrameImageApiV1StudioShotFrameImagesImageIdPatch({
          imageId: slot.id,
          requestBody: { file_id: fileId } as never,
        })
      } else {
        await StudioShotFrameImagesService.createShotFrameImageApiV1StudioShotFrameImagesPost({
          requestBody: {
            shot_detail_id: selectedShot.id,
            frame_type: frameType,
            file_id: fileId,
          } as never,
        })
      }
      await onRefreshShotFrameImages?.()
      // 审计 §4.3 模式 2：主区禁词「槽位」
      message.success(`${frameLabel[frameType]}已上传并设为该帧`)
    } catch (error) {
      void showUserError(error, `${frameLabel[frameType]}上传失败`)
    } finally {
      updateCardState(frameType, { uploading: false })
    }
  }

  const applyCardImage = async (frameType: PromptFrameType, fileId: string) => {
    const slot = frameImages.find((x) => x.frame_type === frameType)
    if (!slot) return
    updateCardState(frameType, { applyingFileId: fileId })
    try {
      await StudioShotFrameImagesService.updateShotFrameImageApiV1StudioShotFrameImagesImageIdPatch({
        imageId: slot.id,
        requestBody: { file_id: fileId } as any,
      })
      await loadCardThumbs(frameType)
      message.success('已切换使用图片')
    } catch {
      message.error('切换失败')
    } finally {
      updateCardState(frameType, { applyingFileId: null })
    }
  }

  useEffect(() => {
    if (!selectedShot?.id) return
    void Promise.all([loadCardThumbs('first'), loadCardThumbs('key'), loadCardThumbs('last')])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedShot?.id, frameImages.map((x) => `${x.id}:${x.file_id ?? ''}`).join('|')])

  const pendingDialogueCandidates = shotDialogueCandidateItems.filter((item) => item.candidate_status === 'pending')

  return (
    <div className="w-full h-full flex flex-col min-h-0">

      {/* 步骤切换 / 范围统计 / 头部都在「本镜生产」工作区里统一提供（这里不再重复一套）。 */}
      <ExportScopeModal
        open={exportScopeOpen}
        onClose={() => setExportScopeOpen(false)}
        readiness={exportReadiness}
        chapterLabel={chapterId ?? undefined}
        onConfirm={async (shotIds) => {
          if (!projectId) return
          try {
            // 复用既有 TXT 导出接口，只传最终选中的镜头范围；失败时提示错误而不是打开 404 页面
            const result = await downloadDeliveryTxt(projectId, chapterId ?? null, shotIds)
            message.success(`已下载交付提示词：${result.filename}（${result.bytes} 字节，${shotIds.length} 镜）`)
            setExportScopeOpen(false)
          } catch (error) {
            void showUserError(error, '导出失败')
          }
        }}
      />
      <StudioStepProgressStrip
        projectId={projectId}
        chapterId={chapterId ?? null}
        step={studioStepKey}
        selectedShotIds={selectedShotIds}
      />

      <div className="studio-mid__scroll flex-1 min-h-0 overflow-auto">
        {(() => {
          const items = [
              {
              key: 'ops',
              label: '维护设置',
              children: (
                <ChapterStudioMaintenancePanel
                  opsTitleDraft={opsTitleDraft}
                  opsNoteDraft={opsNoteDraft}
                  hideShot={hideShot}
                  onChangeTitle={setOpsTitleDraft}
                  onBlurTitle={() => {
                    void flushOpsTitle()
                  }}
                  onChangeNote={setOpsNoteDraft}
                  onBlurNote={() => {
                    void flushOpsNote()
                  }}
                  onToggleHidden={setHideShot}
                  onRequestDelete={() => {
                    if (!selectedShot?.id) return
                    Modal.confirm({
                      title: '删除分镜？',
                      content: '此操作不可撤销。',
                      okText: '删除',
                      okButtonProps: { danger: true },
                      cancelText: '取消',
                      onOk: () => onDeleteShotOps(selectedShot.id),
                    })
                  }}
                />
              ),
            },
              {
              key: 'video_prompt_text',
              label: '视频提示词',
              children: (
                <div>
                  <div className="cs-group-title">
                    <FileTextOutlined /> 视频提示词
                  </div>
                  {!selectedShot ? (
                    <div className="text-xs text-gray-500">请先在左侧选择一条分镜。</div>
                  ) : (
                    <div className="space-y-3">
                      <div
                        className={`rounded-lg border px-3 py-2 text-[11px] leading-5 ${
                          savedVideoPrompt
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                            : 'border-slate-200 bg-slate-50 text-slate-600'
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">
                            {savedVideoPrompt ? '该镜头已保存视频提示词' : '该镜头尚未保存视频提示词'}
                          </span>
                          {savedVideoPrompt ? (
                            <>
                              <Tag color="green">{`来源：${videoPromptSourceLabel(savedVideoPromptSource)}`}</Tag>
                              <Tag>{`${savedVideoPrompt.length} 字`}</Tag>
                            </>
                          ) : null}
                        </div>
                        <div className="mt-1">
                          交付导出读的就是这里保存的这份提示词：必须是正式保存过的版本
                          （大模型生成 / 外部导入 / 人工编辑 / 一键技能生成都算；临时拼装的模板不算）。
                          在这里手工修改后保存，来源固定记为「人工编辑」。
                        </div>
                      </div>

                      <div>
                        <div className="text-xs text-gray-500 mb-1">
                          {savedVideoPrompt ? '修改后保存（不会自动覆盖你写的内容）' : '在这里直接写提示词'}
                        </div>
                        <Input.TextArea
                          rows={8}
                          value={videoPromptTabDraft}
                          placeholder="例：3s，中景，韩虹把节目邀请函放到桌上并推向许晨，镜头固定，室内办公室，真人短剧风格"
                          onChange={(e) => setVideoPromptTabDraft(e.target.value)}
                        />
                      </div>

                      <Space wrap size={8}>
                        <Button
                          type="primary"
                          loading={videoPromptTabSaving}
                          disabled={!videoPromptTabDraft.trim()}
                          onClick={() => void saveVideoPromptTab('manual')}
                        >
                          保存到镜头
                        </Button>
                        <Button
                          disabled={!videoLlmDerivedPrompt.trim() || videoPromptTabSaving}
                          onClick={() => setVideoPromptTabDraft(videoLlmDerivedPrompt.trim())}
                        >
                          填入本次生成结果
                        </Button>
                        <Button
                          disabled={videoPromptTabSaving || !videoPromptTabDraft}
                          onClick={() => setVideoPromptTabDraft(savedVideoPrompt)}
                        >
                          还原为已保存内容
                        </Button>
                        <span className="text-[11px] text-gray-400">
                          {`草稿 ${videoPromptTabDraft.trim().length} 字`}
                          {savedVideoPrompt && videoPromptTabDraft.trim() !== savedVideoPrompt
                            ? '（与已保存内容不一致）'
                            : ''}
                        </span>
                      </Space>

                      {videoLlmDerivedPrompt ? (
                        <Alert
                          type="info"
                          showIcon
                          message="本次生成上下文里有可用的拼装结果"
                          description={
                            <div className="space-y-1 text-[11px]">
                              <div>
                                点「填入本次生成结果」会把下面这段填进编辑器（仍需要你确认后再保存）：
                              </div>
                              <div className="max-h-28 overflow-auto rounded bg-white/60 p-2 whitespace-pre-wrap font-mono">
                                {videoLlmDerivedPrompt}
                              </div>
                            </div>
                          }
                        />
                      ) : null}

                      {/* 大模型补漏：**只针对当前镜头**（整集入口在项目第 3 步） */}
                      <div className="rounded-lg border border-slate-200 bg-white p-3">
                        <VideoPromptLlmPanel
                          projectId={projectId}
                          chapterId={chapterId}
                          currentShotId={selectedShot?.id ?? null}
                          selectedShotIds={selectedShotIds ?? []}
                          onSaved={async (shotId, prompt) => {
                            // 保存的若是当前镜头，同步刷新本页「已保存内容」（读的是 shot_details），
                            // 避免界面显示与库里不一致 —— 与「保存到镜头」按钮同一套刷新方式。
                            if (shotId !== selectedShot?.id) return
                            setVideoPromptTabDraft(prompt)
                            const refreshed = await StudioShotDetailsService.getShotDetailApiV1StudioShotDetailsShotIdGet({
                              shotId,
                            })
                            if (refreshed.data) onPatchShotDetail(refreshed.data)
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              ),
            },
              {
              key: 'camera',
              label: '生成参数',
              children: (
                <div>
                  {loadingDetail ? (
                    <div className="text-gray-500">加载中…</div>
                  ) : shotDetail ? (
                    <>
                      <div className="cs-group">
                        <div className="cs-group-title">
                          <CameraOutlined /> 镜头语言
                        </div>
                        <div className="space-y-4">
                          <div>
                            <div className="text-gray-500 text-xs mb-1">景别</div>
                            <Radio.Group
                              value={shotDetail.camera_shot}
                              optionType="button"
                              buttonStyle="solid"
                              size="small"
                              options={CAMERA_SHOT_OPTIONS}
                              onChange={(e) => void onPatchShotDetailImmediate({ camera_shot: e.target.value })}
                              disabled={cameraUpdating}
                            />
                          </div>
                          <div>
                            <div className="text-gray-500 text-xs mb-1">角度</div>
                            <Radio.Group
                              value={shotDetail.angle}
                              optionType="button"
                              size="small"
                              options={CAMERA_ANGLE_OPTIONS}
                              onChange={(e) => void onPatchShotDetailImmediate({ angle: e.target.value })}
                              disabled={cameraUpdating}
                            />
                          </div>
                          <div>
                            <div className="text-gray-500 text-xs mb-1">运镜</div>
                            <Radio.Group
                              value={shotDetail.movement}
                              size="small"
                              options={CAMERA_MOVEMENT_OPTIONS}
                              onChange={(e) => void onPatchShotDetailImmediate({ movement: e.target.value })}
                              disabled={cameraUpdating}
                            />
                          </div>
                          <div>
                            <div className="text-gray-500 text-xs mb-1">时长（1–30s，整数）</div>
                            <div className="flex items-center gap-2">
                              <Slider
                                min={1}
                                max={30}
                                step={1}
                                value={Math.max(1, Math.min(30, Math.round(shotDetail.duration ?? 1)))}
                                style={{ flex: 1 }}
                                onChange={(v) => void onPatchShotDetailImmediate({ duration: Math.round(Number(v)) })}
                                disabled={cameraUpdating}
                              />
                              <Input
                                size="small"
                                value={`${Math.max(1, Math.min(30, Math.round(shotDetail.duration ?? 1)))}`}
                                style={{ width: 72 }}
                                onChange={(e) => {
                                  const raw = Number(e.target.value)
                                  if (!Number.isFinite(raw)) return
                                  const n = Math.max(1, Math.min(30, Math.round(raw)))
                                  void onPatchShotDetailImmediate({ duration: n })
                                }}
                                disabled={cameraUpdating}
                              />
                            </div>
                          </div>
                          <div>
                            <div className="text-gray-500 text-xs mb-1">视频比例</div>
                            <Select
                              size="small"
                              allowClear
                              value={shotDetail.override_video_ratio ?? undefined}
                              placeholder={projectDefaultVideoRatio || capabilityDefaultVideoRatio || '请选择视频比例'}
                              options={videoRatioOptions}
                              onChange={(value) => {
                                onPatchShotDetail({ override_video_ratio: value ?? null })
                              }}
                              disabled={cameraUpdating}
                            />
                            <div className="mt-1 text-[11px] text-gray-400">
                              当前生效：{resolveVideoRatioForRequest() || '未设置'}
                            </div>
                          </div>
                        </div>
                      </div>

                      <div className="cs-group">
                        <div className="cs-group-title">
                          <TagOutlined /> 情绪标签
                        </div>
                        <div className="cs-hint">用标签快速标记镜头情绪，便于生成风格统一。</div>
                        <div className="mt-3">
                          <Space wrap>
                            {['愤怒', '反转', '紧张', '温馨', '压抑'].map((t) => (
                              <Tag key={t} className="cursor-pointer">
                                {t}
                              </Tag>
                            ))}
                            <Button size="small" type="dashed">
                              + 自定义
                            </Button>
                          </Space>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="text-gray-500">请选择分镜</div>
                  )}
                </div>
              ),
            },
              {
              key: 'readiness_diag',
              label: '确认诊断',
              children: (
                <div>
                  <ChapterStudioReadinessDiagnosisPanel
                    selectedShot={selectedShot}
                    shotAssetsOverview={shotAssetsOverview}
                    promptAssetReadiness={promptAssetReadiness}
                    promptAssetReadinessNote={promptAssetReadinessNote}
                    shotExtractStatusSource={shotExtractStatus.source}
                    shotExtractStatusText={shotExtractStatusText}
                    onGoToShotEdit={goToShotEditForAssets}
                    onHandleMissingAction={(kind, name) => {
                      void handleReadinessMissingAction(kind, name)
                    }}
                    getReadinessExistenceLabel={getReadinessExistenceLabel}
                  />

                </div>
              ),
            },
              {
              key: 'atmosphere',
              label: '氛围描述',
              children: (
                <div>
                  <div className="cs-group">
                    <div className="cs-group-title">
                      <PictureOutlined /> 氛围描述
                    </div>
                    <div>
                        <div className="flex items-center justify-between">
                          <div className="text-gray-500 text-xs">氛围描述</div>
                          <Switch
                            size="small"
                            checked={shotDetail?.follow_atmosphere ?? false}
                            onChange={(v) => onPatchShotDetail({ follow_atmosphere: v })}
                          />
                        </div>
                        <TextArea
                          rows={3}
                          placeholder="氛围描述…（可选跟随画面）"
                          value={shotDetail?.atmosphere ?? ''}
                          onChange={(e) => onPatchShotDetail({ atmosphere: e.target.value })}
                        />
                    </div>
                  </div>

                </div>
              ),
            },
              {
              key: 'binding',
              label: '资产与声音检查',
              children: (
                <div>
                  <div className="cs-group-title">
                    <LinkOutlined /> 资产与声音检查
                  </div>
                  {selectedShot?.id && projectId && chapterId ? (
                    <div className="rounded-2xl border border-slate-200 bg-slate-50/70 px-3 py-3">
                      <ChapterShotAssetBindingSection
                        projectId={projectId}
                        chapterId={chapterId}
                        shotId={selectedShot.id}
                        onReloadPreparationState={async () => {
                          await onRefreshShotAssetsOverview(selectedShot.id)
                        }}
                      />
                      <div className="mt-4 border-t border-slate-200 pt-4">
                        {/* 实际使用的文件：图片逐个给出 file_id/定版状态，声音给出绑定的音频文件 */}
                        <ShotBoundFilesPanel
                          projectId={projectId}
                          chapterId={chapterId}
                          shotId={selectedShot.id}
                        />
                      </div>
                      <div className="mt-4 border-t border-slate-200 pt-4">
                        {/* 角色声音（**只读**）：声音的唯一事实来源是人物资产，
                            第 2 步人物资产详情是全站唯一的选择 / 更换入口；
                            这里只显示继承结果与来源，缺项时给「返回人物资产补充」。
                            此前这一块是逐镜的声音绑定区（第二套编辑入口），已按设计包 §10 移除。 */}
                        <ShotVoiceInheritancePanel
                          shotId={selectedShot.id}
                          projectId={projectId}
                          chapterId={chapterId}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-gray-500">请先在左侧选择一条分镜。</div>
                  )}
                </div>
              ),
            },
              {
              key: 'dialogue',
              label: '对白状态',
              children: (
                <div>
                  <div className="cs-group">
                    <div className="cs-group-title">
                      <SoundOutlined /> 对白状态
                    </div>
                    <div className="cs-hint">这里主要查看当前镜头对白与待确认状态。待确认对白的主确认入口在分镜编辑页，工作室侧重继续准备关键帧、图片和视频生成。</div>
                    <div className="space-y-4 mt-3">
                      <div>
                        <Button icon={<EditOutlined />} onClick={goToShotEditForAssets}>
                          去分镜编辑确认对白
                        </Button>
                      </div>
                      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-500">
                        如需新增对白、接受候选或忽略候选，请前往分镜编辑页处理。工作室这里主要用于查看当前对白状态，并继续后续生成准备。
                      </div>

                      {pendingDialogueCandidates.length > 0 ? (
                        <div>
                          <div className="text-gray-500 text-xs mb-2">待确认对白</div>
                          <div className="space-y-2">
                            {pendingDialogueCandidates.map((candidate) => (
                              <div key={candidate.id} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="text-xs text-amber-700 mb-1">
                                      {candidate.speaker_name?.trim() || '未知'} → {candidate.target_name?.trim() || '未知'}
                                    </div>
                                    <div className="text-xs text-gray-700 break-words">{candidate.text}</div>
                                  </div>
                                  <Button size="small" icon={<EditOutlined />} onClick={goToShotEditForAssets}>
                                    去编辑页处理
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      <div>
                        <div className="text-gray-500 text-xs mb-2">当前对白</div>
                        {dialogLines.length > 0 ? (
                          <div className="space-y-1">
                            {dialogLines.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((l) => (
                              <div key={l.id} className="flex items-center gap-2">
                                <div className="text-xs text-gray-600 truncate flex-1 min-w-0">{l.text}</div>
                                <Button
                                  size="small"
                                  type="text"
                                  danger
                                  icon={<DeleteOutlined />}
                                  onClick={() => {
                                    Modal.confirm({
                                      title: '删除该对白？',
                                      okText: '删除',
                                      cancelText: '取消',
                                      okButtonProps: { danger: true },
                                      onOk: async () => {
                                        try {
                                          await onDeleteDialogLine(l.id)
                                          message.success('已删除')
                                        } catch {
                                          message.error('删除失败')
                                        }
                                      },
                                    })
                                  }}
                                />
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="text-xs text-gray-400">当前镜头还没有对白。</div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ),
            },
              {
              // >>> 技术详情层开始（kf_specs 整块只由 technical 折叠块渲染；主区禁词扫描按本标记区间豁免）
              key: 'kf_specs',
              label: '关键帧规格',
              children: (
                <div className="space-y-3">
                  <div className="cs-group">
                    <div className="cs-group-title">
                      <SettingOutlined /> 关键帧规格
                    </div>
                    <div className="text-xs text-gray-500 mb-2">
                      关键帧会跟随当前视频比例生成；这里控制参考帧分辨率档位。
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="min-w-[96px] text-xs text-gray-500">分辨率档位</div>
                      <Select
                        size="small"
                        value={keyframeResolutionProfile}
                        style={{ width: 160 }}
                        options={[
                          { value: 'standard', label: '标准（2K）' },
                          { value: 'high', label: '高清（3K）' },
                        ]}
                        onChange={(value) => onChangeKeyframeResolutionProfile(value as KeyframeResolutionProfile)}
                      />
                    </div>
                    <div className="mt-2 rounded bg-gray-50 px-3 py-2 text-xs text-gray-600">
                      <div>
                        当前规格：{resolvedKeyframeRatio || '未设置比例'} ·{' '}
                        {getResolutionProfileLabel(keyframeResolutionProfile)}
                        {resolvedKeyframePixelSize ? ` → ${resolvedKeyframePixelSize}` : ''}
                      </div>
                      <div className="mt-1 text-gray-500">
                        当前模型：{imageGenerationOptions?.provider || '未识别供应商'}
                        {imageGenerationOptions?.model_name ? ` / ${imageGenerationOptions.model_name}` : ''}
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-3">
                      <div className="min-w-[96px] text-xs text-gray-500">出图通道</div>
                      <Select
                        size="small"
                        value={keyframeImageModelId}
                        style={{ width: 260 }}
                        onChange={(value) => onChangeKeyframeImageModelId(value)}
                        options={[
                          {
                            value: '',
                            label: `后端默认${imageGenerationOptions?.model_name ? `（${imageGenerationOptions.model_name}）` : ''}`,
                          },
                          ...imageModelOptions.map((item) => ({
                            value: item.id,
                            label: `${item.name}（${item.provider_id}）`,
                          })),
                        ]}
                      />
                    </div>
                    <div className="mt-1 text-[11px] leading-5 text-gray-500">
                      「后端默认」（出图服务垫片）不会把参考图透传给上游；选 APIMart 直连的模型才会以
                      image_urls（公网地址）真的把参考图送出去 —— 生成的响应里会写明送了几张。
                    </div>
                  </div>
                </div>
              ),
            },
              {
              // <<< 技术详情层结束
              key: 'kf_cards',
              label: '关键帧与参考图',
              children: (
                <div className="space-y-3">
                  {(['first', 'key', 'last'] as PromptFrameType[]).map((ft) => {
                    const st = keyframeCards[ft]
                    const slot = frameImages.find((x) => x.frame_type === ft)
                    const inUseFileId = slot?.file_id ? String(slot.file_id) : ''
                    const statusText =
                      st.taskStatus === 'pending'
                        ? '排队中'
                        : st.taskStatus === 'running'
                          ? '生成中'
                          : st.taskStatus === 'succeeded'
                            ? '已完成'
                            : st.taskStatus === 'failed'
                              ? '失败'
                              : st.taskStatus === 'cancelled'
                                ? '已取消'
                                : ''
                    return (
                      <div key={ft} className="cs-group">
                        <div className="cs-group-title flex items-center justify-between gap-2">
                          <span>{frameLabel[ft]}图片</span>
                          <Space size={8}>
                            {/* 审计 §4.3 模式 2：Tooltip **悬停即见**，里面不许写后端表名 */}
                            <Tooltip title="上传手头已有的图片作为该帧（只做登记，不触发生图、不消耗额度）">
                              <Upload
                                showUploadList={false}
                                accept=".jpg,.jpeg,.png,.webp,.gif,image/*"
                                beforeUpload={(file) => {
                                  void uploadKeyframeImage(ft, file as unknown as File)
                                  return false
                                }}
                              >
                                <Button size="small" icon={<UploadOutlined />} loading={Boolean(st.uploading)}>
                                  上传
                                </Button>
                              </Upload>
                            </Tooltip>
                            <Button size="small" type="link" onClick={() => updateCardState(ft, { modalOpen: true })}>
                              更多
                            </Button>
                            <Button size="small" type="primary" loading={st.loading} onClick={() => void generateKeyframeCard(ft)}>
                              生成
                            </Button>
                          </Space>
                        </div>
                        <div className="text-xs text-gray-500 min-h-5">{statusText}</div>
                        {st.lastProviderNotes?.length ? (
                          /* 第 3 批收尾（审计 §7.1-6 成对文案）：`provider_notes` 是生成服务方的原话。
                             主区只出产品结论（toast），原话在这里（默认收起的「技术详情」）逐条可查 ——
                             这份折叠块是它在**屏幕上的唯一出口**（不依赖任何内存日志）。
                             放在帧卡片上而不是预览弹窗里：生成成功时弹窗会被关掉，卡片是持久落点。 */
                          <TechnicalDetailSection testId="keyframe-provider-note-detail" hint="生成服务对这次结果的原始说明">
                            <ul className="list-disc pl-4 text-[11px]">
                              {st.lastProviderNotes.map((note, index) => (
                                <li key={`provider-note-${ft}-${index}`}>{maskInternalIds(String(note))}</li>
                              ))}
                            </ul>
                          </TechnicalDetailSection>
                        ) : null}
                        {st.thumbs.length === 0 ? (
                          <div className="mt-2 h-24 border border-dashed rounded flex items-center justify-center text-xs text-gray-400">暂无图片</div>
                        ) : (
                          <div className="mt-2 flex items-center gap-2 overflow-x-auto whitespace-nowrap pb-1">
                            {st.thumbs.slice(0, 4).map((it) => (
                              <img key={it.linkId} src={it.thumbUrl} alt="" className="w-16 h-16 rounded object-cover border border-gray-200 shrink-0" />
                            ))}
                          </div>
                        )}
                        <Modal title={`${frameLabel[ft]}图片`} open={st.modalOpen} onCancel={() => updateCardState(ft, { modalOpen: false })} footer={null} width={720}>
                          {ft === 'first' ? (
                            <div className="mb-3">
                              <div className="text-sm text-gray-600 mb-2">关联角色</div>
                              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                                <button
                                  type="button"
                                  className="w-12 h-12 rounded border border-dashed border-gray-300 flex items-center justify-center text-gray-500 shrink-0 hover:border-gray-400 hover:text-gray-700"
                                  disabled={promptAssetsUpdating || linkRoleLoading}
                                  onClick={() => {
                                    setLinkRoleSelectedIds([])
                                    setLinkRoleOpen(true)
                                    void loadProjectRoleOptions()
                                  }}
                                  title="添加关联角色"
                                >
                                  <PlusOutlined />
                                </button>
                                {linkedCharacterIds.length === 0 ? (
                                  <div className="text-xs text-gray-400">暂无关联角色</div>
                                ) : (
                                  linkedCharacterIds.map((cid) => {
                                    const thumb = linkedAssetThumbByKey.get(`character:${cid}`)
                                    // 审计 §4.3 模式 1：`?? cid` 会把角色内部 ID 端上屏
                                    const name = characterNameMap[cid] ?? '（角色名称读取失败）'
                                    return thumb ? (
                                    <Image
                                        key={cid}
                                        width={48}
                                        height={48}
                                        style={{ objectFit: 'cover', borderRadius: 8 }}
                                        src={resolveAssetUrl(thumb)}
                                        preview={{ src: resolveAssetUrl(thumb) }}
                                      />
                                    ) : (
                                      <div
                                        key={cid}
                                        title={name}
                                        className="w-12 h-12 rounded bg-gray-100 flex items-center justify-center text-gray-400 shrink-0"
                                      >
                                        <UserOutlined />
                                      </div>
                                    )
                                  })
                                )}
                              </div>

                              <div className="mt-3 text-sm text-gray-600 mb-2">关联场景</div>
                              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                                <button
                                  type="button"
                                  className="w-12 h-12 rounded border border-dashed border-gray-300 flex items-center justify-center text-gray-500 shrink-0 hover:border-gray-400 hover:text-gray-700"
                                  disabled={promptAssetsUpdating || linkSceneLoading}
                                  onClick={() => {
                                    setLinkSceneOpen(true)
                                    void loadProjectAssetOptions('scene')
                                  }}
                                  title="添加/更换关联场景"
                                >
                                  <PlusOutlined />
                                </button>
                                {linkedSceneId ? (
                                  linkedAssetThumbByKey.get(`scene:${linkedSceneId}`) ? (
                                    <Image
                                      key={linkedSceneId}
                                      width={48}
                                      height={48}
                                      style={{ objectFit: 'cover', borderRadius: 8 }}
                                      src={resolveAssetUrl(linkedAssetThumbByKey.get(`scene:${linkedSceneId}`) ?? '')}
                                      preview={{ src: resolveAssetUrl(linkedAssetThumbByKey.get(`scene:${linkedSceneId}`) ?? '') }}
                                    />
                                  ) : (
                                    // 审计 §4.3 模式 1：`?? linkedSceneId` 会把场景内部 ID 端上屏
                                    <div className="text-xs text-gray-400">已关联场景：{sceneNameMap[linkedSceneId] ?? '（场景名称读取失败）'}</div>
                                  )
                                ) : (
                                  <div className="text-xs text-gray-400">暂无关联场景</div>
                                )}
                              </div>

                              <div className="mt-3 text-sm text-gray-600 mb-2">关联道具</div>
                              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                                <button
                                  type="button"
                                  className="w-12 h-12 rounded border border-dashed border-gray-300 flex items-center justify-center text-gray-500 shrink-0 hover:border-gray-400 hover:text-gray-700"
                                  disabled={promptAssetsUpdating || linkPropLoading}
                                  onClick={() => {
                                    setLinkPropSelectedIds([])
                                    setLinkPropOpen(true)
                                    void loadProjectAssetOptions('prop')
                                  }}
                                  title="添加关联道具"
                                >
                                  <PlusOutlined />
                                </button>
                                {linkedPropIds.length === 0 ? (
                                  <div className="text-xs text-gray-400">暂无关联道具</div>
                                ) : (
                                  linkedPropIds.map((pid) =>
                                    linkedAssetThumbByKey.get(`prop:${pid}`) ? (
                                      <Image
                                        key={pid}
                                        width={48}
                                        height={48}
                                        style={{ objectFit: 'cover', borderRadius: 8 }}
                                        src={resolveAssetUrl(linkedAssetThumbByKey.get(`prop:${pid}`) ?? '')}
                                        preview={{ src: resolveAssetUrl(linkedAssetThumbByKey.get(`prop:${pid}`) ?? '') }}
                                      />
                                    ) : (
                                      <div key={pid} className="w-12 h-12 rounded bg-gray-100 flex items-center justify-center text-gray-400 shrink-0">
                                        <UserOutlined />
                                      </div>
                                    ),
                                  )
                                )}
                              </div>

                              <div className="mt-3 text-sm text-gray-600 mb-2">关联服装</div>
                              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                                <button
                                  type="button"
                                  className="w-12 h-12 rounded border border-dashed border-gray-300 flex items-center justify-center text-gray-500 shrink-0 hover:border-gray-400 hover:text-gray-700"
                                  disabled={promptAssetsUpdating || linkCostumeLoading}
                                  onClick={() => {
                                    setLinkCostumeSelectedIds([])
                                    setLinkCostumeOpen(true)
                                    void loadProjectAssetOptions('costume')
                                  }}
                                  title="添加关联服装"
                                >
                                  <PlusOutlined />
                                </button>
                                {linkedCostumeIds.length === 0 ? (
                                  <div className="text-xs text-gray-400">暂无关联服装</div>
                                ) : (
                                  linkedCostumeIds.map((cid) =>
                                    linkedAssetThumbByKey.get(`costume:${cid}`) ? (
                                      <Image
                                        key={cid}
                                        width={48}
                                        height={48}
                                        style={{ objectFit: 'cover', borderRadius: 8 }}
                                        src={resolveAssetUrl(linkedAssetThumbByKey.get(`costume:${cid}`) ?? '')}
                                        preview={{ src: resolveAssetUrl(linkedAssetThumbByKey.get(`costume:${cid}`) ?? '') }}
                                      />
                                    ) : (
                                      <div key={cid} className="w-12 h-12 rounded bg-gray-100 flex items-center justify-center text-gray-400 shrink-0">
                                        <UserOutlined />
                                      </div>
                                    ),
                                  )
                                )}
                              </div>
                            </div>
                          ) : null}

                          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                            {st.thumbs.map((it) => {
                              const inUse = inUseFileId && inUseFileId === it.fileId
                              return (
                                <div key={it.linkId} className="border rounded p-2">
                                  <img src={it.thumbUrl} alt="" className="w-full h-36 object-cover rounded" />
                                  <div className="mt-2 flex items-center justify-between">
                                    {inUse ? (
                                      <Tag color="green">使用中</Tag>
                                    ) : (
                                      <Button size="small" loading={st.applyingFileId === it.fileId} onClick={() => void applyCardImage(ft, it.fileId)}>
                                        使用
                                      </Button>
                                    )}
                                  </div>
                                </div>
                              )
                            })}
                          </div>

                          <Modal
                            title="关联角色"
                            open={linkRoleOpen}
                            onCancel={() => setLinkRoleOpen(false)}
                            footer={null}
                            destroyOnHidden
                            width={560}
                          >
                            <div className="space-y-2">
                              <div className="text-xs text-gray-500">来源：当前项目全部角色（选择后立即保存；已关联的角色不可重复选择）</div>
                              <Select
                                mode="multiple"
                                className="w-full"
                                placeholder="选择要关联到当前分镜的角色"
                                value={linkRoleSelectedIds}
                                loading={linkRoleLoading}
                                disabled={promptAssetsUpdating}
                                options={projectRoleOptions}
                                optionFilterProp="searchLabel"
                                showSearch
                                filterOption={(input: string, option?: any) =>
                                  String(option?.searchLabel ?? '').toLowerCase().includes(input.toLowerCase())
                                }
                                onChange={(vals: Array<string | number>) => {
                                  const nextNew = (vals ?? []).map((v) => String(v)).filter(Boolean)
                                  setLinkRoleSelectedIds(nextNew)
                                  const merged = Array.from(new Set([...linkedCharacterIds, ...nextNew]))
                                  void (async () => {
                                    await onUpdatePromptActors(merged)
                                    setLinkRoleOpen(false)
                                    setLinkRoleSelectedIds([])
                                  })()
                                }}
                              />
                            </div>
                          </Modal>

                          <Modal
                            title="关联场景"
                            open={linkSceneOpen}
                            onCancel={() => setLinkSceneOpen(false)}
                            footer={null}
                            destroyOnHidden
                            width={560}
                          >
                            <div className="space-y-2">
                              <div className="text-xs text-gray-500">来源：当前项目场景（选择后立即保存）</div>
                              <Select
                                className="w-full"
                                placeholder="选择要关联到当前分镜的场景"
                                value={linkedSceneId ?? undefined}
                                loading={linkSceneLoading}
                                disabled={promptAssetsUpdating}
                                options={projectSceneOptions}
                                optionFilterProp="searchLabel"
                                showSearch
                                filterOption={(input: string, option?: any) =>
                                  String(option?.searchLabel ?? '').toLowerCase().includes(input.toLowerCase())
                                }
                                onChange={(v: string) => {
                                  void (async () => {
                                    await onUpdatePromptScene(v)
                                    setLinkSceneOpen(false)
                                  })()
                                }}
                              />
                            </div>
                          </Modal>

                          <Modal
                            title="关联道具"
                            open={linkPropOpen}
                            onCancel={() => setLinkPropOpen(false)}
                            footer={null}
                            destroyOnHidden
                            width={560}
                          >
                            <div className="space-y-2">
                              <div className="text-xs text-gray-500">来源：当前项目道具（选择后立即保存；已关联的不可重复选择）</div>
                              <Select
                                mode="multiple"
                                className="w-full"
                                placeholder="选择要关联到当前分镜的道具"
                                value={linkPropSelectedIds}
                                loading={linkPropLoading}
                                disabled={promptAssetsUpdating}
                                options={projectPropOptions}
                                optionFilterProp="searchLabel"
                                showSearch
                                filterOption={(input: string, option?: any) =>
                                  String(option?.searchLabel ?? '').toLowerCase().includes(input.toLowerCase())
                                }
                                onChange={(vals: Array<string | number>) => {
                                  const nextNew = (vals ?? []).map((v) => String(v)).filter(Boolean)
                                  setLinkPropSelectedIds(nextNew)
                                  const merged = Array.from(new Set([...linkedPropIds, ...nextNew]))
                                  void (async () => {
                                    await onUpdatePromptProps(merged)
                                    setLinkPropOpen(false)
                                    setLinkPropSelectedIds([])
                                  })()
                                }}
                              />
                            </div>
                          </Modal>

                          <Modal
                            title="关联服装"
                            open={linkCostumeOpen}
                            onCancel={() => setLinkCostumeOpen(false)}
                            footer={null}
                            destroyOnHidden
                            width={560}
                          >
                            <div className="space-y-2">
                              <div className="text-xs text-gray-500">来源：当前项目服装（选择后立即保存；已关联的不可重复选择）</div>
                              <Select
                                mode="multiple"
                                className="w-full"
                                placeholder="选择要关联到当前分镜的服装"
                                value={linkCostumeSelectedIds}
                                loading={linkCostumeLoading}
                                disabled={promptAssetsUpdating}
                                options={projectCostumeOptions}
                                optionFilterProp="searchLabel"
                                showSearch
                                filterOption={(input: string, option?: any) =>
                                  String(option?.searchLabel ?? '').toLowerCase().includes(input.toLowerCase())
                                }
                                onChange={(vals: Array<string | number>) => {
                                  const nextNew = (vals ?? []).map((v) => String(v)).filter(Boolean)
                                  setLinkCostumeSelectedIds(nextNew)
                                  const merged = Array.from(new Set([...linkedCostumeIds, ...nextNew]))
                                  void (async () => {
                                    await onUpdatePromptCostumes(merged)
                                    setLinkCostumeOpen(false)
                                    setLinkCostumeSelectedIds([])
                                  })()
                                }}
                              />
                            </div>
                          </Modal>
                        </Modal>
                      </div>
                    )
                  })}
                </div>
              ),
            },
              ...(showAvTab ? [{
                key: 'av',
                label: '音视频控制',
                children: (
                  <div>
                    <div className="cs-group">
                      <div className="cs-group-title">
                        <CustomerServiceOutlined /> 配乐
                      </div>
                      <div className="space-y-3">
                        <Radio.Group
                          value={audioMode}
                          onChange={(e) => setAudioMode(e.target.value)}
                          options={[
                            { value: 'none', label: '无' },
                            { value: 'prompt', label: '提示词' },
                            { value: 'upload', label: '上传音频' },
                          ]}
                        />
                        {audioMode === 'prompt' && <TextArea rows={3} placeholder="配乐提示词（支持多版本）…" />}
                        {audioMode === 'upload' && (
                          <Button block icon={<UploadOutlined />}>
                            上传音频
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="cs-group">
                      <div className="cs-group-title">
                        <SoundOutlined /> 音效
                      </div>
                      <div className="space-y-3">
                        <Button block icon={<UploadOutlined />}>
                          添加一条音效（Mock）
                        </Button>
                      </div>
                    </div>

                    <div className="cs-group">
                      <div className="cs-group-title">
                        <SettingOutlined /> 开关
                      </div>
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm">关闭配乐</span>
                          <Switch />
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-sm">关闭对白</span>
                          <Switch />
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-sm">智能对口型</span>
                          <Switch />
                        </div>
                      </div>
                    </div>
                  </div>
                ),
              }] : []),
              {
              key: 'gen_ref_readiness',
              label: '视频准备度',
              children: (
                <div>
                  <ChapterStudioVideoReadinessPanel
                    selectedShot={selectedShot}
                    videoReadinessLoading={videoReadinessLoading}
                    videoReadiness={videoReadiness}
                    videoReferenceMode={videoReferenceMode}
                  />

                  <div className="cs-group">
                    <div className="cs-group-title">
                      <LinkOutlined /> 参考
                    </div>
                    <Select
                      allowClear
                      placeholder="按已有关键帧类型选择"
                      className="w-full"
                      value={refImageType}
                      onChange={(v) => setRefImageType(v === undefined || v === null ? undefined : String(v))}
                      options={refFrameTypeOptions}
                      loading={refFrameTypeSelectLoading}
                      onOpenChange={handleRefFrameTypeDropdownVisibleChange}
                    />
                  </div>

                  {showGenRefParams && (
                    <div className="cs-group">
                      <div className="cs-group-title">
                        <ToolOutlined /> 参数
                      </div>
                      <Space direction="vertical" className="w-full" size="small">
                        <Select
                          size="small"
                          placeholder="模型选择"
                          options={[
                            { value: 'model_a', label: '模型 A（写实）' },
                            { value: 'model_b', label: '模型 B（风格化）' },
                          ]}
                        />
                        <div className="flex items-center justify-between">
                          <span className="text-sm">ControlNet（深度/骨骼）</span>
                          <Switch checked={useBoneDepth} onChange={setUseBoneDepth} />
                        </div>
                        <Slider min={3} max={12} defaultValue={5} />
                      </Space>
                    </div>
                  )}

                </div>
              ),
            },
              {
              key: 'gen_ref_videos',
              label: '已生成视频',
              children: (
                <div>
                  <div className="cs-group">
                    <div className="cs-group-title">
                      <ThunderboltOutlined /> 生成
                    </div>
                    <div className="text-xs text-gray-500">
                      生成入口在工作区「⑥ 生成视频」；这里只列已产出的视频（同一份预检与守卫）。
                      {videoTaskStatus ? ` 任务状态：${taskStatusLabel(videoTaskStatus)}` : ''}
                    </div>
                  </div>

                  <div className="cs-group">
                    <div className="cs-group-title">
                      <VideoCameraOutlined /> 已生成视频
                    </div>
                    {generatedVideos.length === 0 ? (
                      <div className="text-xs text-gray-400">当前分镜暂无已生成视频</div>
                    ) : (
                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                        {generatedVideos.map((item, idx) => (
                          <div key={`${item.linkId}-${item.fileId}`} className="border rounded p-2">
                            <video
                              src={item.url}
                              className="w-full h-20 rounded object-cover bg-black"
                              preload="metadata"
                              muted
                              onClick={() => onSelectPreviewVideo(item.fileId)}
                              style={{ cursor: 'pointer' }}
                            />
                            <div className="mt-2 flex items-center justify-between gap-2">
                              <span className="text-xs text-gray-500">视频 {idx + 1}</span>
                              <Tooltip title="下载视频">
                                <Button
                                  size="small"
                                  icon={<DownloadOutlined />}
                                  onClick={() => {
                                    if (!item.url) return
                                    window.open(item.url, '_blank', 'noopener,noreferrer')
                                  }}
                                />
                              </Tooltip>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {showGenRefVersions && (
                    <div className="cs-group">
                      <div className="cs-group-title">
                        <AppstoreOutlined /> 版本
                      </div>
                      <Tabs
                        type="card"
                        size="small"
                        activeKey={imageVersion}
                        onChange={setImageVersion}
                        items={[
                          { key: 'v1', label: 'v1' },
                          { key: 'v2', label: 'v2' },
                          { key: 'v3', label: 'v3' },
                        ]}
                      />
                    </div>
                  )}
                </div>
              ),
              },
            ]

            const part = (key: string): React.ReactNode =>
              (items.find((item) => String(item.key) === key)?.children ?? null) as React.ReactNode

            const chapterTitleFallback = String(chapterId ?? '本集')
            const savedPromptText = String((shotDetail as unknown as { video_prompt?: string } | null)?.video_prompt ?? '')
            const savedPromptSrc = String((shotDetail as unknown as { video_prompt_source?: string } | null)?.video_prompt_source ?? '')

            /*
             阶段面板的各个区块。**沿用既有实现**：提示词编辑、绑定与参考帧、生成预检与提交、
             导出都是同一条链路（同一份请求、同一份守卫），这里只把它们按阶段 3 / 4 / 5 重新排版，
             不复制任何请求，也不另立第二套判定。
            */
            const STUDIO_PARTS = {
              /*
               * 整集批量工具：原「分镜提示词中转页」的**真实能力**（批量生成 / 批量导入 /
               * 服务端草稿恢复）现在就在阶段 3 里，默认收起、展开即真实可用。
               * 用的还是同一个组件与同一条保存链路，没有第二套实现。
               */
              batchTools: (
                <Collapse
                  size="small"
                  destroyOnHidden
                  items={[
                    {
                      key: 'episode_batch',
                      label: '展开整集批量（生成提示词 / 导入 / 草稿）',
                      children: (
                        <EpisodeVideoPromptBoard
                          projectId={projectId ?? ''}
                          chapterId={chapterId ?? null}
                          chapterLabel={chapterTitleFallback}
                        />
                      ),
                    },
                  ]}
                />
              ),
                  // ① 已保存的视频提示词与来源（只读回显：生成与导出读的就是它）
                  promptSaved: (
                    <div className="space-y-2">
                      <Space size={6} wrap>
                        <Tag color={savedPromptText.trim() ? 'green' : 'gold'}>
                          {/* 审计 §4.3 模式 3：与弹窗里 `:7465` 同一字段，必须走同一份映射 */}
                          {savedPromptText.trim() ? `来源：${videoPromptSourceLabel(savedPromptSrc) || '未标记'}` : '尚未保存'}
                        </Tag>
                        <span className="text-[11px] text-gray-500">{`${savedPromptText.trim().length} 字`}</span>
                      </Space>
                      <div className="whitespace-pre-wrap rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                        {savedPromptText.trim() || '还没有保存过视频提示词：到②里写好后保存，生成与导出读的就是这一份。'}
                      </div>
                    </div>
                  ),
                  // ② 单镜编辑 / 重新生成 / 保存（原「手动分镜」的提示词、镜头语言、氛围描述三处合并）
                  promptEditor: (
                    <div className="space-y-3">
                      {part('video_prompt_text')}
                      <Collapse
                        size="small"
                        items={[
                          { key: 'camera', label: '镜头语言（景别 / 角度 / 运动 / 时长）', children: part('camera') },
                          { key: 'atmosphere', label: '氛围描述', children: part('atmosphere') },
                        ]}
                      />
                    </div>
                  ),
                  // ③ 当前绑定（编辑与补齐入口＝「资产与参考帧」：绑定 + 声音 + 关键帧）
                  binding: (
                    <div className="space-y-3">
                      {part('binding')}
                      <Collapse
                        size="small"
                        items={[
                          {
                            key: 'kf_cards',
                            label: '关键帧与参考图（首帧 / 关键帧 / 尾帧的生成、上传、应用）',
                            children: part('kf_cards'),
                          },
                        ]}
                      />
                    </div>
                  ),
                  // ④ 本次请求实际使用的帧（只读：这次真的会发出去的文件）
                  requestFrames: (
                    <div className="space-y-3">
                      <Space size={6} wrap>
                        <span className="text-[11px] text-gray-500">参考方式</span>
                        <Select
                          size="small"
                          style={{ width: 210 }}
                          value={requestPlan.referenceMode}
                          onChange={(value) => requestPlan.setReferenceMode(value)}
                          options={REFERENCE_MODE_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
                        />
                        <Button size="small" loading={requestPlan.planLoading} onClick={() => void requestPlan.loadPlan()}>
                          刷新预检
                        </Button>
                      </Space>
                      {requestPlan.plan ? (
                        <div className="space-y-2">
                          <div className="text-[11px] text-gray-600">
                            {`要求帧：${(requestPlan.plan.required_frame_types ?? []).map((item: string) => frameTypeLabel(item)).join('、') || '无（纯文本）'}`}
                          </div>
                          {(requestPlan.plan.frames ?? []).length ? (
                            (requestPlan.plan.frames ?? []).map((frame: VideoPlanFrame) => (
                              <div key={`${frame.frame_type}-${frame.file_id}`} className="flex items-start gap-2">
                                {frame.url ? (
                                  <img
                                    src={resolveAssetUrl(frame.url)}
                                    alt=""
                                    style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6, border: '1px solid #e2e8f0' }}
                                  />
                                ) : (
                                  <div className="flex h-10 w-10 items-center justify-center rounded border border-dashed border-slate-300 text-[10px] text-gray-400">
                                    缺
                                  </div>
                                )}
                                <div className="min-w-0">
                                  <Tag color={frame.usable ? 'green' : 'red'} style={{ marginInlineEnd: 4 }}>
                                    {frameTypeLabel(frame.frame_type)}
                                  </Tag>
                                  {frame.file_id && !frame.usable ? (
                                    <Tag color="orange" style={{ marginInlineEnd: 4 }}>
                                      已上传但当前服务取不到这张图
                                    </Tag>
                                  ) : null}
                                  <span className="text-[11px] text-gray-500">{frame.usable ? '本次请求会使用' : '本次请求用不了'}</span>
                                  {frame.reason ? (
                                    /* 第 3 批收尾（审计 §4.3 模式 4）：后端原因里带本机 / 内网 host 与相对路径 ——
                                       主区只出产品自己写的中文结论，原句在下面默认收起的「技术详情」里。 */
                                    <div className="mt-0.5 max-w-[520px] text-[10px] leading-4 text-orange-600">
                                      {describeFrameBlockReason(frame.reason).mainText}
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            ))
                          ) : (
                            <div className="text-[11px] text-gray-500">该参考方式不需要帧文件（纯文本生成）。</div>
                          )}
                          <div className="text-xs">
                            <Tag
                              color={
                                requestPlan.plan.audio_opt_out
                                  ? 'default'
                                  : requestPlan.plan.audio?.included === true
                                    ? 'cyan'
                                    : 'gold'
                              }
                              style={{ marginInlineEnd: 4 }}
                            >
                              {audioStateTag(requestPlan.plan.audio, requestPlan.plan.audio_state)}
                            </Tag>
                            <span className="text-[11px] text-gray-500">声音文件与内部 ID 见「技术详情」。</span>
                            {requestFrameReasonNotes.length || planAudioAdmission.technicalDetail ? (
                              /* 第 3 批收尾（审计 §4.3 模式 4/6）：④ 里两处后端原文 ——
                                 帧不可用原因（含本机 / 内网 host）与声音地址 / 原始说明 ——
                                 只出现在默认收起的「技术详情」里（复用全仓唯一折叠壳）。 */
                              <TechnicalDetailSection testId="request-audit-detail" hint="生成服务对这次参考图与声音的原始说明">
                                {requestFrameReasonNotes.length ? (
                                  <ul className="list-disc pl-4 text-[11px]">
                                    {requestFrameReasonNotes.map((item: string, index: number) => (
                                      <li key={`request-frame-reason-${index}`}>{item}</li>
                                    ))}
                                  </ul>
                                ) : null}
                                {planAudioAdmission.technicalDetail ? (
                                  <div className="whitespace-pre-wrap text-[11px]">{planAudioAdmission.technicalDetail}</div>
                                ) : null}
                              </TechnicalDetailSection>
                            ) : null}
                            {/* 绑了但用不上：计划阶段就把原因与修法写出来（不等到提交失败） */}
                            {requestPlan.plan.audio?.included === false && requestPlan.plan.audio?.file_id ? (
                              /* 第 3 批收尾（审计 §4.3 模式 4/6）：后端 `excluded_reason` 里带 `/files/...` 这类
                                 存储形态 —— 主区改用 `describeAudioAdmission` 的产品结论，原文（含地址）只进技术详情层。 */
                              <div className="mt-1 max-w-[560px] text-[10px] leading-4 text-orange-600">
                                <div>{planAudioAdmission.detail}</div>
                                {planAudioAdmission.fix ? (
                                  <div className="text-slate-500">怎么修：{planAudioAdmission.fix}</div>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ) : (
                        <div className="text-[11px] text-gray-500">正在读取本次请求实际使用的帧（只读预检，不触网、不花钱）。</div>
                      )}
                    </div>
                  ),
                  // ⑤ 本镜还缺什么（与生成按钮同一份判定）
                  gaps: (
                    <div className="space-y-3">
                      {requestPlan.gaps.length ? (
                        <Alert
                          type="warning"
                          showIcon
                          message={`本镜还缺 ${requestPlan.gaps.length} 项`}
                          description={
                            <ul className="list-disc pl-4 text-[11px]">
                              {requestPlan.gaps.map((gap) => (
                                <li key={gap.key}>{gap.text}</li>
                              ))}
                            </ul>
                          }
                        />
                      ) : (
                        <Alert type="success" showIcon message="本镜已具备生成与导出的条件" />
                      )}
                      {part('readiness_diag')}
                      {part('gen_ref_readiness')}
                    </div>
                  ),
                  // ⑥ 生成视频（唯一生成入口：复用同一份预检 / 供应商帧可用性 / 付费守卫）
                  generate: (
                    <div className="space-y-3">
                      <Space size={8} wrap>
                        <Tooltip title="先看最终请求摘要（提示词 / 参考帧 / 声音 / 模型方案 / 时长 / 画幅）">
                          <Button size="small" loading={requestPlan.planLoading} onClick={() => void requestPlan.loadPlan()}>
                            刷新预检
                          </Button>
                        </Tooltip>
                        <Button
                          size="small"
                          type="primary"
                          icon={<PlayCircleOutlined />}
                          loading={requestPlan.generating}
                          disabled={requestPlan.generateDisabled}
                          onClick={() => void requestPlan.doGenerate()}
                        >
                          生成视频
                        </Button>
                        <Tooltip title="同一轮重复点「生成视频」只会复用已完成的任务、不会重复计费；要真的再生成一次用这个（会再产生一次费用）">
                          <Button
                            size="small"
                            danger
                            loading={requestPlan.generating}
                            disabled={requestPlan.generateDisabled}
                            onClick={() => void requestPlan.doRegenerate()}
                          >
                            重新生成（下一轮）
                          </Button>
                        </Tooltip>
                        <Button size="small" onClick={() => void openVideoPromptPreview()}>
                          查看完整请求（可保存提示词）
                        </Button>
                        {requestPlan.plan?.guard_status ? (
                          // 审计 §4.3 模式 3：`guard_status` 是自由文本，主区只给中文结论
                          <Tag color="gold">{`是否允许真实付费：${describeGuardStatus(requestPlan.plan.guard_status)}`}</Tag>
                        ) : null}
                      </Space>
                      {requestPlan.generateBlockedReason ? (
                        <Alert
                          type="warning"
                          showIcon
                          message="当前还不能生成（按钮已禁用）"
                          description={requestPlan.generateBlockedReason}
                        />
                      ) : null}
                      {requestPlan.plan ? (
                        <Descriptions size="small" column={2} bordered>
                          <Descriptions.Item label="模型方案">
                            {videoModelBusinessName(requestPlan.plan.model_name)}
                          </Descriptions.Item>
                          <Descriptions.Item label="参考方式">
                            {referenceModeLabel(requestPlan.plan.reference_mode)}
                          </Descriptions.Item>
                          <Descriptions.Item label="画幅">{requestPlan.plan.ratio || '继承项目设置'}</Descriptions.Item>
                          <Descriptions.Item label="时长">
                            {requestPlan.plan.seconds == null ? '最短有效时长' : `${requestPlan.plan.seconds} 秒`}
                          </Descriptions.Item>
                          <Descriptions.Item label="提示词来源">
                            {videoPromptSourceLabel(requestPlan.plan.prompt_source) || '—'}
                          </Descriptions.Item>
                          <Descriptions.Item label="参考图数量">
                            {requestPlan.plan.reference_image_count ?? 0}
                          </Descriptions.Item>
                        </Descriptions>
                      ) : null}
                      {requestPlan.plan?.warnings?.length ? (
                        /* 第 3 批收尾（审计 §4.3 模式 6 + §7.1-6 成对文案）：
                           这里原先把后端 warnings 过一遍管道后逐条铺在主区 —— 实机走查抓到的是
                           一句**英文后端原文**（`Required frame image is missing: 首帧;please generate it 首帧`）。
                           主区改成产品自己写的中文结论；后端原文在同一页默认收起的
                           「技术详情 → 后端原始提示」里可查。 */
                        <>
                          <Alert
                            type="info"
                            showIcon
                            message={`这次提交计划有 ${requestPlan.plan.warnings.length} 条需要注意的地方`}
                            description="例如：参考图没有全部用上、时长或画幅按默认值提交、参考音频这次不会带上。生成前请核对上面的参考方式 / 画幅 / 参考图数量；生成服务的原始说明见下面默认收起的「技术详情」。"
                          />
                          {/* 第 3 批收尾（审计 §7.1-6）：原文就地给出口 —— 与工作区「技术详情 → 后端原始提示」
                              是同一份数据，这里放在提醒旁边，用户不用跳步骤就能展开核对。 */}
                          <TechnicalDetailSection testId="video-plan-warning-detail" hint="生成服务对这次提交计划的原始说明">
                            <ul className="list-disc pl-4 text-[11px]">
                              {requestPlan.plan.warnings.map((warning: string, index: number) => (
                                <li key={`plan-raw-warning-${index}`}>{maskInternalIds(warning)}</li>
                              ))}
                            </ul>
                          </TechnicalDetailSection>
                        </>
                      ) : null}
                      {part('gen_ref_videos')}
                    </div>
                  ),
                  // ⑦ 导出绑定提示词
                  exportBlock: (
                    <div className="space-y-2">
                      <Space size={8} wrap>
                        <Button size="small" icon={<DownloadOutlined />} onClick={() => setExportScopeOpen(true)}>
                          导出绑定提示词（TXT）
                        </Button>
                        <Typography.Text type="secondary" className="text-[11px]">
                          导出弹窗只列出可导出的镜头（与「可生成」分开判断）。
                        </Typography.Text>
                      </Space>
                    </div>
                  ),
                  dialogue: dialogLines.length ? part('dialogue') : null,
                  // 技术详情：内部标识与调用参数（默认收起；STEP_OPEN_KEYS 不含 technical）
                  // >>> 技术详情层开始（默认收起；主区禁词扫描按本标记区间豁免）
                  technical: (
                    <div className="space-y-3">
                      <Descriptions size="small" column={1} bordered>
                        <Descriptions.Item label="供应商 / 适配层">
                          {requestPlan.plan?.provider || imageGenerationOptions?.provider || '—'}
                        </Descriptions.Item>
                        <Descriptions.Item label="模型（原始 ID）">
                          {requestPlan.plan?.model_name || '—'}
                        </Descriptions.Item>
                        <Descriptions.Item label="分辨率档位">
                          {requestPlan.plan?.resolution || '—'}
                        </Descriptions.Item>
                        <Descriptions.Item label="参考帧 file_id">
                          {(requestPlan.plan?.frames ?? []).map((frame: VideoPlanFrame) => `${frame.frame_type}:${frame.file_id || '（缺）'}`).join('　') || '—'}
                        </Descriptions.Item>
                        <Descriptions.Item label="绑定素材 file_id">
                          {requestPlan.row?.bound_files?.length
                            ? (
                                <ul className="list-disc pl-4 text-[11px]">
                                  {requestPlan.row.bound_files.map((item) => (
                                    <li key={`${item.slot}-${item.asset_id}`}>
                                      {`${item.slot_label || item.slot} · ${item.asset_name || item.asset_id} · ${item.file_id || '（无文件）'}`}
                                    </li>
                                  ))}
                                </ul>
                              )
                            : '—'}
                        </Descriptions.Item>
                        <Descriptions.Item label="声音 file_id">
                          {requestPlan.plan?.audio_file_id || '—'}
                        </Descriptions.Item>
                        <Descriptions.Item label="声音地址 storage">
                          <span className="break-all">{requestPlan.plan?.audio_url || '—'}</span>
                        </Descriptions.Item>
                        <Descriptions.Item label="已生成视频 file_id">
                          {generatedVideos.map((item) => item.fileId).join('　') || '—'}
                        </Descriptions.Item>
                        <Descriptions.Item label="守卫状态">
                          {requestPlan.plan?.guard_status || '（未取到计划）'}
                        </Descriptions.Item>
                        <Descriptions.Item label="后端原始提示">
                          {requestPlan.plan?.warnings?.length ? (
                            <ul className="list-disc pl-4 text-[11px]">
                              {requestPlan.plan.warnings.map((warning: string, index: number) => (
                                <li key={`raw-warning-${index}`}>{warning}</li>
                              ))}
                            </ul>
                          ) : (
                            '—'
                          )}
                        </Descriptions.Item>
                        {/* 审计 §4.3 模式 4：原来铺在主区的「不再走 POST /api/v1/film/tasks/video：
                            Celery 队列 / Redis / worker / 停在 pending」整段，下沉到这里（历史实现说明）。 */}
                        <Descriptions.Item label="历史实现说明">
                          视频生成一度走 POST /api/v1/film/tasks/video（队列链路）：任务会丢给 Celery 队列，
                          本机没有 Redis / worker 时任务只会停在 pending（表现为「点了生成没反应」）。
                          现在改为同进程内联执行。
                        </Descriptions.Item>
                        {/* 审计 §4.3 模式 4：原来铺在主区的「DRY_RUN 守卫只作用于直提端点…」，下沉到这里。 */}
                        <Descriptions.Item label="付费守卫适用范围">
                          DRY_RUN 守卫只作用于「生成」这条直提链路；既有任务链路不经过该守卫，
                          请到任务状态 /「已生成视频」里核对真实结果。
                        </Descriptions.Item>
                      </Descriptions>
                      {part('kf_specs')}
                    </div>
                  ),
                  // <<< 技术详情层结束
            }

            return (
              <>
              {/* 中栏 = 当前阶段的主工作区（第 3–5 步共用容器里的一个阶段） */}
              <StudioPhasePanel
                phase={studioStepKey}
                currentShotLabel={
                  selectedShot ? `${String(selectedShot.index).padStart(2, '0')} · ${selectedShot.title}` : ''
                }
                extras={studioPhaseExtras}
                parts={STUDIO_PARTS}
                shotStatus={status}
                scopeSummary={
                  <Space size={6} wrap>
                    <Tag color={STEP_STATE_META[scopeState].color}>
                      {`${(selectedShotIds ?? []).length ? '选中范围' : '本集'}：${STEP_STATE_META[scopeState].label}`}
                    </Tag>
                    <Typography.Text type="secondary" className="text-[11px]">
                      {`范围 ${scopeReadiness.length} 镜 · 可生成 ${scopeReadiness.filter((item) => item.canGenerate).length} · 可导出 ${scopeReadiness.filter((item) => item.canExport).length}`}
                    </Typography.Text>
                  </Space>
                }
              />

              {/* 维护类的结构性操作（改标题 / 隐藏 / 删除）放在默认关闭的高级设置里，
                  日常生产面不再出现它们；入口在容器右上角的「设置」菜单。 */}
              <Modal
                title="高级设置（维护）"
                open={advancedSettingsOpen}
                onCancel={onCloseAdvancedSettings}
                footer={null}
                width={620}
              >
                {part('ops')}
              </Modal>
              </>
            )
          })()}


        <Modal
          title={`${frameLabel[keyframePromptPreviewFrameType]}图片生成提示词预览`}
          open={keyframePromptPreviewOpen}
          onCancel={() => {
            if (keyframePromptActionLoading) return
            setKeyframePromptPreviewOpen(false)
          }}
          footer={(
            <div className="flex items-center justify-between">
              <div />
              <Space>
                <Button
                  loading={keyframePromptActionLoading}
                  onClick={() => {
                    if (keyframePromptActionLoading) return
                    setKeyframePromptPreviewOpen(false)
                  }}
                >
                  取消
                </Button>
                <Button type="primary" loading={keyframePromptActionLoading} onClick={() => void confirmGenerateKeyframeWithPrompt()}>
                  生成
                </Button>
              </Space>
            </div>
          )}
          destroyOnHidden
          width={900}
        >
          {(() => {
            const hasBasePrompt = keyframePromptPreviewDraft.trim().length > 0
            const renderStatusMeta = getKeyframeRenderStatusMeta(keyframePromptRenderState)
            const debugVisualStyle = readDebugContextText(keyframePromptDebugContext, 'visual_style')
            const debugStyle = readDebugContextText(keyframePromptDebugContext, 'style')
            const debugCharacterContext = readDebugContextText(keyframePromptDebugContext, 'character_context')
            const debugSceneContext = readDebugContextText(keyframePromptDebugContext, 'scene_context')
            const debugPropContext = readDebugContextText(keyframePromptDebugContext, 'prop_context')
            const debugCostumeContext = readDebugContextText(keyframePromptDebugContext, 'costume_context')
            const debugShotDescription = readDebugContextText(keyframePromptDebugContext, 'shot_description')
            const debugDialogSummary = readDebugContextText(keyframePromptDebugContext, 'dialog_summary')
            const debugPreviousShotTitle = readDebugContextText(keyframePromptDebugContext, 'previous_shot_title')
            const debugPreviousShotScriptExcerpt = readDebugContextText(keyframePromptDebugContext, 'previous_shot_script_excerpt')
            const debugPreviousShotEndState = readDebugContextText(keyframePromptDebugContext, 'previous_shot_end_state')
            const debugNextShotTitle = readDebugContextText(keyframePromptDebugContext, 'next_shot_title')
            const debugNextShotScriptExcerpt = readDebugContextText(keyframePromptDebugContext, 'next_shot_script_excerpt')
            const debugNextShotStartGoal = readDebugContextText(keyframePromptDebugContext, 'next_shot_start_goal')
            const debugContinuityGuidance = readDebugContextText(keyframePromptDebugContext, 'continuity_guidance')
            const debugCompositionAnchor = readDebugContextText(keyframePromptDebugContext, 'composition_anchor')
            const debugScreenDirectionGuidance = readDebugContextText(keyframePromptDebugContext, 'screen_direction_guidance')
            const debugFrameSpecificGuidance = readDebugContextText(keyframePromptDebugContext, 'frame_specific_guidance')
            const debugDirectorCommandSummary = readDebugContextText(keyframePromptDebugContext, 'director_command_summary')
            const debugActionBeatPhases = readDebugContextText(keyframePromptDebugContext, 'action_beat_phases')
            const debugSelectedActionBeatPhase = readDebugContextText(keyframePromptDebugContext, 'selected_action_beat_phase')
            const debugSelectedActionBeatText = readDebugContextText(keyframePromptDebugContext, 'selected_action_beat_text')
            const actionBeatPhaseTags = buildActionBeatPhaseTags(debugActionBeatPhases)
            const parsedDirectorCommandSummary = parseDirectorCommandSummary(debugDirectorCommandSummary)
            const keyframeGuidanceSummary = buildKeyframeGuidanceSummary([
              debugDirectorCommandSummary,
              debugFrameSpecificGuidance,
              debugContinuityGuidance,
              debugCompositionAnchor,
              debugScreenDirectionGuidance,
            ])
            const guidanceLevelSummary = buildGuidanceLevelSummary(parsedDirectorCommandSummary, keyframeGuidanceSummary)
            const debugUnifyStyle =
              typeof keyframePromptDebugContext?.unify_style === 'boolean'
                ? (keyframePromptDebugContext.unify_style ? '是' : '否')
                : readDebugContextText(keyframePromptDebugContext, 'unify_style')
            const hasPromptDebugContext = Boolean(
              debugVisualStyle ||
                debugStyle ||
                debugCharacterContext ||
                debugSceneContext ||
                debugPropContext ||
                debugCostumeContext ||
                debugShotDescription ||
                debugDialogSummary ||
                debugPreviousShotTitle ||
                debugPreviousShotScriptExcerpt ||
                debugPreviousShotEndState ||
                debugNextShotTitle ||
                debugNextShotScriptExcerpt ||
                debugNextShotStartGoal ||
                debugContinuityGuidance ||
                debugCompositionAnchor ||
                debugScreenDirectionGuidance ||
                debugFrameSpecificGuidance ||
                debugDirectorCommandSummary ||
                debugActionBeatPhases ||
                debugSelectedActionBeatText ||
                debugUnifyStyle,
            )
            const hasPromptQualityChecks = keyframePromptQualityChecks !== null
            return keyframePromptPreviewLoading ? (
              <div className="py-8 text-center">
                <Spin />
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-slate-900">本次提交计划（后端只读预览）</div>
                      <div className="mt-1 text-xs text-slate-500">
                        这是提交时后端实际会用的提示词来源、参考图与画幅；不触网、不写库。
                      </div>
                    </div>
                    <Tag color={keyframePlanPreview ? 'green' : 'default'}>
                      {keyframePlanPreview ? '已核对' : '读取中'}
                    </Tag>
                  </div>
                  {keyframePlanPreview ? (
                    <div className="space-y-2 text-xs text-slate-700">
                      <div className="flex flex-wrap items-center gap-2">
                        <Tag color={keyframePlanPreview.prompt_source === 'saved' ? 'blue' : 'default'}>
                          提示词来源：{framePromptSourceLabel(keyframePlanPreview.prompt_source)}
                        </Tag>
                        <Tag>{keyframePlanPreview.prompt.length} 字</Tag>
                        <Tag>{`参考图 ${keyframePlanPreview.reference_count} 张`}</Tag>
                        <Tag>{`画幅 ${keyframePlanPreview.target_ratio}（${labelFor(TARGET_RATIO_SOURCE, keyframePlanPreview.target_ratio_source)}）`}</Tag>
                        {/* 审计 §6.2：主区只用业务化说法，原始 provider / 模型名只进「技术详情」 */}
                        <Tag>{videoModelBusinessName(keyframePlanPreview.model_name)}</Tag>
                      </div>
                      <div className="rounded bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-600">
                        <div className="line-clamp-3 break-all">{keyframePlanPreview.prompt || '（空）'}</div>
                      </div>
                      <div
                        className={`rounded px-3 py-2 text-[11px] ${
                          !keyframePlanPreview.prompt
                            ? 'bg-amber-50 text-amber-700'
                            : keyframePlanPreview.prompt === keyframePromptPreviewDraft.trim()
                              ? 'bg-emerald-50 text-emerald-700'
                              : 'bg-amber-50 text-amber-700'
                        }`}
                      >
                        {!keyframePlanPreview.prompt
                          ? '镜头里还没有保存过这帧的提示词：本次会用下面输入框里的文本提交（来源＝本次输入），提交后建议保存一次。'
                          : keyframePlanPreview.prompt === keyframePromptPreviewDraft.trim()
                            ? '下面输入框里的文本与镜头里保存的内容完全一致：提交读的就是这条。'
                            : '下面输入框的文本与镜头里保存的内容不同：本次按输入框提交（来源＝本次输入），不会自动改镜头里的保存值。'}
                      </div>
                      {keyframePlanPreview.warnings.length ? (
                        /* 第 3 批收尾（审计 §4.3 模式 4/6 + §7.1-6 成对文案）：
                           旧实现把后端 warnings **原样**逐条铺在主区（里面含「已跳过：[file_id…]」
                           这类内部编号与「供应商「x」没有配置 API Key」这类点名）。
                           现在主区只给产品自己写的中文结论，后端原话进默认收起的「技术详情」。 */
                        <>
                          <div className="rounded bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-700">
                            {`这次的提交计划有 ${keyframePlanPreview.warnings.length} 条需要注意的地方：参考图可能没有全部用上，或本次用的提示词与镜头里保存的那份不同。`}
                            生成前请先核对上面的提示词来源与「参考图映射」；原始说明见下面的「技术详情」。
                          </div>
                          <TechnicalDetailSection testId="keyframe-plan-warning-detail" hint="生成服务对这次提交计划的原始说明">
                            <ul className="list-disc pl-5 text-[11px]">
                              {keyframePlanPreview.warnings.map((item, index) => (
                                <li key={`plan-warning-${index}`}>{maskInternalIds(String(item))}</li>
                              ))}
                            </ul>
                          </TechnicalDetailSection>
                        </>
                      ) : null}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-400">正在读取提交计划…</div>
                  )}
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-slate-900">参考图映射</div>
                      <div className="mt-1 text-xs text-slate-500">
                        图片顺序会直接决定提交版本中的图1、图2映射关系，并影响模型生成结果。
                      </div>
                    </div>
                    <Tag color="gold">顺序影响图1/图2</Tag>
                  </div>
                  {keyframePromptPreviewRefFileIds.length === 0 ? (
                    <div className="text-xs text-gray-400">暂无关联图片</div>
                  ) : (
                    <div className="flex gap-3 overflow-x-auto pb-1">
                      <Image.PreviewGroup>
                        {keyframePromptPreviewRefFileIds.map((fid, index) => (
                          <div key={fid} className="w-[92px] shrink-0">
                            {/* 审计 §4.3 模式 1：`?? fid` 会把 file_id 同时打进正文与**悬停可见**的 title */}
                            <Tooltip title={shotLinkedAssetNameByFileId.get(fid) ?? '（未命名参考图）'}>
                              <Image
                                width={72}
                                height={72}
                                style={{ objectFit: 'cover', borderRadius: 8, border: '1px solid #e2e8f0' }}
                                src={buildFileDownloadUrl(fid)}
                              />
                            </Tooltip>
                            <div className="mt-1">
                              <Tag color="blue">{`图${index + 1}`}</Tag>
                            </div>
                            <div className="truncate text-[11px] text-gray-700">
                              {shotLinkedAssetNameByFileId.get(fid) ?? '（未命名参考图）'}
                            </div>
                            <div className="mt-1 flex gap-1">
                              <Button
                                size="small"
                                disabled={index === 0 || keyframePromptActionLoading || shotRenderPromptLoading}
                                onClick={() => moveKeyframePromptRefFile(index, index - 1)}
                              >
                                左移
                              </Button>
                              <Button
                                size="small"
                                disabled={
                                  index === keyframePromptPreviewRefFileIds.length - 1 ||
                                  keyframePromptActionLoading ||
                                  shotRenderPromptLoading
                                }
                                onClick={() => moveKeyframePromptRefFile(index, index + 1)}
                              >
                                右移
                              </Button>
                            </div>
                          </div>
                        ))}
                      </Image.PreviewGroup>
                    </div>
                  )}
                </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-slate-900">基础提示词</div>
                    <div className="mt-1 text-xs text-slate-500">
                      描述画面内容本身，不包含图片映射说明。
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      AI生成会继承当前项目风格，并优先参考已确认的角色、场景、道具和服装设定。
                    </div>
                  </div>
                  <Space size="small">
                    <Tag color={hasBasePrompt ? 'blue' : 'default'}>{hasBasePrompt ? '可编辑' : '未生成'}</Tag>
                    <Tooltip title="保存到本镜：之后不填提示词直接点「生成」时，读的就是这条已保存内容">
                      <Button
                        size="small"
                        loading={keyframePromptActionLoading}
                        disabled={!hasBasePrompt}
                        onClick={() => void saveKeyframePromptToShot()}
                      >
                        保存到镜头
                      </Button>
                    </Tooltip>
                    <Button
                      size="small"
                      type={hasBasePrompt ? 'default' : 'primary'}
                      loading={keyframePromptActionLoading}
                      onClick={() => void regenerateKeyframePrompt()}
                    >
                      AI生成
                    </Button>
                  </Space>
                </div>
                {!hasBasePrompt ? (
                  <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                    当前还没有基础提示词。你可以先让 AI 生成一版，再按需修改；也可以直接手动输入。
                  </div>
                  ) : null}
                  {hasPromptQualityChecks ? (
                    <div
                      className={`mb-3 rounded-lg border px-3 py-2 text-xs ${
                        keyframePromptQualityChecks?.passed
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          : 'border-amber-200 bg-amber-50 text-amber-700'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Tag color={keyframePromptQualityChecks?.passed ? 'green' : 'gold'}>
                          {keyframePromptQualityChecks?.passed ? '质量校验通过' : '已触发自动修正'}
                        </Tag>
                        <span>
                          {keyframePromptQualityChecks?.passed
                            ? '本次 AI 生成已通过基础质量校验。'
                            : '本次 AI 生成触发过自动修正，系统已尽量清理不符合基础提示词要求的内容。'}
                        </span>
                      </div>
                    </div>
                  ) : null}
                  <Input.TextArea
                    rows={6}
                    value={keyframePromptPreviewDraft}
                    onChange={(e) => {
                      keyframePromptDraft.setBase((prev) => ({ ...prev, prompt: e.target.value }))
                      if (!e.target.value.trim()) {
                        keyframePromptDraft.resetDerived()
                      }
                    }}
                    placeholder="请输入基础提示词，例如人物动作、场景氛围、镜头视角等…"
                    disabled={keyframePromptActionLoading || shotRenderPromptLoading}
                  />
                  {keyframeGuidanceSummary.length > 0 || debugDirectorCommandSummary ? (
                    <div className="mt-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-3 text-xs text-sky-800">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          {/* 审计 §4.3 模式 2：主区禁词「生成依据」 */}
                          <div className="font-medium">这条基础提示词是怎么来的</div>
                          <div className="mt-1 text-sky-700">
                            这些导演约束主要用于生成上游基础提示词，默认先看摘要；只有少量高优先级规则会再进入最终图片提示词。
                          </div>
                        </div>
                        <Button size="small" type="text" onClick={() => setKeyframeDirectiveCollapsed((prev) => !prev)}>
                          {keyframeDirectiveCollapsed ? '展开细节' : '收起细节'}
                        </Button>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Tag color="red">{`必须 ${guidanceLevelSummary.must}`}</Tag>
                        <Tag color="blue">{`优先 ${guidanceLevelSummary.prefer}`}</Tag>
                        <Tag>{`普通 ${guidanceLevelSummary.normal}`}</Tag>
                        {actionBeatPhaseTags.length > 0 ? (
                          <Tag color="purple">{`动作阶段 ${actionBeatPhaseTags.length}`}</Tag>
                        ) : null}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {(keyframeDirectiveCollapsed
                          ? (
                            parsedDirectorCommandSummary.length > 0
                              ? parsedDirectorCommandSummary
                                  .slice(0, 2)
                                  .map((item) => `${item.level === 'must' ? '必须' : '优先'} · ${item.text}`)
                              : keyframeGuidanceSummary.slice(0, 2)
                          )
                          : keyframeGuidanceSummary
                        ).map((item) => (
                          <Tooltip key={item} title={item}>
                            <Tag color="blue" className="max-w-[240px] overflow-hidden">
                              <span className="inline-block max-w-[200px] truncate align-bottom">{item}</span>
                            </Tag>
                          </Tooltip>
                        ))}
                      </div>
                      {actionBeatPhaseTags.length > 0 ? (
                        <div className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-3 text-xs text-slate-700">
                          <div className="flex items-center justify-between gap-2">
                            <div className="font-medium text-slate-800">当前帧消费的动作阶段</div>
                            {debugSelectedActionBeatPhase && debugSelectedActionBeatText ? (
                              <Tag color="purple">
                                {`${debugSelectedActionBeatPhase} · ${debugSelectedActionBeatText}`}
                              </Tag>
                            ) : null}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {actionBeatPhaseTags.map((item, index) => (
                              <Tooltip key={`${item.phaseLabel}:${index}:${item.text}`} title={`${item.phaseLabel} · ${item.text}`}>
                                <Tag
                                  color={
                                    item.phaseLabel === '触发'
                                      ? 'gold'
                                      : item.phaseLabel === '峰值'
                                        ? 'blue'
                                        : 'green'
                                  }
                                  className="max-w-[240px] overflow-hidden"
                                >
                                  <span className="inline-block max-w-[200px] truncate align-bottom">
                                    {item.phaseLabel} · {item.text}
                                  </span>
                                </Tag>
                              </Tooltip>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {!keyframeDirectiveCollapsed ? (
                        <div className="mt-3 grid gap-3 md:grid-cols-2">
                          {debugDirectorCommandSummary ? (
                            <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-3 text-xs text-indigo-800">
                              <div className="font-medium">高优先级导演指令</div>
                              <div className="mt-2 flex flex-wrap gap-2">
                                {parsedDirectorCommandSummary.map((item, index) => (
                                  <Tooltip key={`${item.level}:${index}:${item.text}`} title={`${item.level === 'must' ? '必须' : '优先'} · ${item.text}`}>
                                    <Tag
                                      color={item.level === 'must' ? 'red' : 'blue'}
                                      className="max-w-[240px] overflow-hidden"
                                    >
                                      <span className="inline-block max-w-[200px] truncate align-bottom">
                                        {item.level === 'must' ? '必须' : '优先'} · {item.text}
                                      </span>
                                    </Tag>
                                  </Tooltip>
                                ))}
                              </div>
                            </div>
                          ) : null}
                          {keyframeGuidanceSummary.length > 0 ? (
                            <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-3 text-xs text-blue-800">
                              {/* 审计 §4.3 模式 2：主区留英文内部术语「Guidance」 */}
                              <div className="font-medium">补充生成要求</div>
                              <div className="mt-2 flex flex-wrap gap-2">
                                {keyframeGuidanceSummary.map((item) => (
                                  <Tooltip key={item} title={item}>
                                    <Tag color="blue" className="max-w-[220px] overflow-hidden">
                                      <span className="inline-block max-w-[180px] truncate align-bottom">{item}</span>
                                    </Tag>
                                  </Tooltip>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  {hasPromptDebugContext ? (
                    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600">
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-medium text-slate-700">最近一次 AI 生成上下文</div>
                        <Space size="small">
                          <Tag color="default">调试信息</Tag>
                          <Button
                            size="small"
                            type="text"
                            onClick={() => setKeyframePromptDebugCollapsed((prev) => !prev)}
                          >
                            {keyframePromptDebugCollapsed ? '展开细节' : '收起细节'}
                          </Button>
                        </Space>
                      </div>
                      {keyframePromptDebugCollapsed ? (
                        <div className="mt-2 text-slate-500">
                          调试信息默认收起，展开后可查看最近一次 AI 生成使用的项目风格、镜头描述、连续性约束与实体上下文。
                        </div>
                      ) : (
                        <div className="mt-2 grid gap-2 md:grid-cols-2">
                          <div>
                            <div className="text-slate-500">项目风格</div>
                            <div className="mt-1 text-slate-700">
                              {[debugVisualStyle, debugStyle].filter(Boolean).join(' / ') || '无'}
                            </div>
                          </div>
                          <div>
                            <div className="text-slate-500">统一风格</div>
                            <div className="mt-1 text-slate-700">{debugUnifyStyle || '无'}</div>
                          </div>
                          {debugShotDescription ? (
                            <div className="md:col-span-2">
                              <div className="text-slate-500">镜头补充描述</div>
                              <div className="mt-1 whitespace-pre-wrap text-slate-700">{debugShotDescription}</div>
                            </div>
                          ) : null}
                          {debugDialogSummary ? (
                            <div className="md:col-span-2">
                              <div className="text-slate-500">对白摘要</div>
                              <div className="mt-1 whitespace-pre-wrap text-slate-700">{debugDialogSummary}</div>
                            </div>
                          ) : null}
                          {debugActionBeatPhases ? (
                            <div className="md:col-span-2">
                              <div className="text-slate-500">动作拍点阶段</div>
                              <div className="mt-1 flex flex-wrap gap-2">
                                {actionBeatPhaseTags.map((item, index) => (
                                  <Tag
                                    key={`debug-action-phase:${index}:${item.text}`}
                                    color={
                                      item.phaseLabel === '触发'
                                        ? 'gold'
                                        : item.phaseLabel === '峰值'
                                          ? 'blue'
                                          : 'green'
                                    }
                                  >
                                    {`${item.phaseLabel} · ${item.text}`}
                                  </Tag>
                                ))}
                              </div>
                              {debugSelectedActionBeatPhase || debugSelectedActionBeatText ? (
                                <div className="mt-2 text-slate-700">
                                  {`当前帧优先消费：${[debugSelectedActionBeatPhase, debugSelectedActionBeatText].filter(Boolean).join(' · ')}`}
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                          {debugPreviousShotTitle || debugPreviousShotScriptExcerpt || debugPreviousShotEndState ? (
                            <div className="md:col-span-2 rounded-lg border border-slate-200 bg-white px-3 py-3">
                              <div className="text-slate-500">上一镜头承接</div>
                              <div className="mt-1 space-y-1 text-slate-700">
                                {debugPreviousShotTitle ? <div>标题：{debugPreviousShotTitle}</div> : null}
                                {debugPreviousShotScriptExcerpt ? (
                                  <div className="whitespace-pre-wrap">摘录：{debugPreviousShotScriptExcerpt}</div>
                                ) : null}
                                {debugPreviousShotEndState ? (
                                  <div className="whitespace-pre-wrap">结尾状态：{debugPreviousShotEndState}</div>
                                ) : null}
                              </div>
                            </div>
                          ) : null}
                          {debugNextShotTitle || debugNextShotScriptExcerpt || debugNextShotStartGoal ? (
                            <div className="md:col-span-2 rounded-lg border border-slate-200 bg-white px-3 py-3">
                              <div className="text-slate-500">下一镜头衔接</div>
                              <div className="mt-1 space-y-1 text-slate-700">
                                {debugNextShotTitle ? <div>标题：{debugNextShotTitle}</div> : null}
                                {debugNextShotScriptExcerpt ? (
                                  <div className="whitespace-pre-wrap">摘录：{debugNextShotScriptExcerpt}</div>
                                ) : null}
                                {debugNextShotStartGoal ? (
                                  <div className="whitespace-pre-wrap">起始目标：{debugNextShotStartGoal}</div>
                                ) : null}
                              </div>
                            </div>
                          ) : null}
                          {debugContinuityGuidance ? (
                            <div className="md:col-span-2">
                              <div className="text-slate-500">连续性建议</div>
                              <div className="mt-1 whitespace-pre-wrap text-slate-700">{debugContinuityGuidance}</div>
                            </div>
                          ) : null}
                          {debugCompositionAnchor ? (
                            <div className="md:col-span-2">
                              <div className="text-slate-500">构图与空间锚点</div>
                              <div className="mt-1 whitespace-pre-wrap text-slate-700">{debugCompositionAnchor}</div>
                            </div>
                          ) : null}
                          {debugScreenDirectionGuidance ? (
                            <div className="md:col-span-2">
                              <div className="text-slate-500">朝向与视线建议</div>
                              <div className="mt-1 whitespace-pre-wrap text-slate-700">{debugScreenDirectionGuidance}</div>
                            </div>
                          ) : null}
                          {debugFrameSpecificGuidance ? (
                            <div className="md:col-span-2">
                              <div className="text-slate-500">当前帧专项建议</div>
                              <div className="mt-1 whitespace-pre-wrap text-slate-700">{debugFrameSpecificGuidance}</div>
                            </div>
                          ) : null}
                          {debugCharacterContext ? (
                            <div className="md:col-span-2">
                              <div className="text-slate-500">角色上下文</div>
                              <div className="mt-1 whitespace-pre-wrap text-slate-700">{debugCharacterContext}</div>
                            </div>
                          ) : null}
                          {debugSceneContext ? (
                            <div className="md:col-span-2">
                              <div className="text-slate-500">场景上下文</div>
                              <div className="mt-1 whitespace-pre-wrap text-slate-700">{debugSceneContext}</div>
                            </div>
                          ) : null}
                          {debugPropContext ? (
                            <div className="md:col-span-2">
                              <div className="text-slate-500">道具上下文</div>
                              <div className="mt-1 whitespace-pre-wrap text-slate-700">{debugPropContext}</div>
                            </div>
                          ) : null}
                          {debugCostumeContext ? (
                            <div className="md:col-span-2">
                              <div className="text-slate-500">服装上下文</div>
                              <div className="mt-1 whitespace-pre-wrap text-slate-700">{debugCostumeContext}</div>
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-slate-900">最终提交版本</div>
                      <div className="mt-1 text-xs text-slate-500">
                        系统会根据当前基础提示词和参考图顺序自动生成这一版内容，提交给模型时将使用这里的结果。
                      </div>
                    </div>
                    <Space size="small">
                      <Tag color="geekblue">系统生成</Tag>
                      <Tag>只读</Tag>
                      <Button
                        size="small"
                        onClick={() =>
                          void renderShotPromptToTextarea({
                            frameType: keyframePromptPreviewFrameType,
                            prompt: keyframePromptPreviewDraft,
                            refFileIds:
                              keyframePromptPreviewRefFileIds.length > 0
                                ? keyframePromptPreviewRefFileIds
                                : autoKeyframeRefFileIds,
                          })
                        }
                        disabled={!hasBasePrompt}
                        loading={shotRenderPromptLoading}
                      >
                        重新同步
                      </Button>
                      <Button
                        size="small"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(keyframePromptRenderedDraft || '')
                            message.success('已复制提交版本')
                          } catch {
                            message.error('复制失败')
                          }
                        }}
                        disabled={!keyframePromptRenderedDraft.trim()}
                      >
                        复制
                      </Button>
                    </Space>
                  </div>
                  <div
                    className={`mb-3 rounded-lg border px-3 py-2 text-sm ${
                      renderStatusMeta.color === 'green'
                        ? 'border-green-200 bg-green-50 text-green-700'
                        : renderStatusMeta.color === 'blue'
                          ? 'border-blue-200 bg-blue-50 text-blue-700'
                          : renderStatusMeta.color === 'red'
                            ? 'border-red-200 bg-red-50 text-red-700'
                            : renderStatusMeta.color === 'gold'
                              ? 'border-amber-200 bg-amber-50 text-amber-700'
                              : 'border-slate-200 bg-white text-slate-600'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Tag color={renderStatusMeta.color}>{renderStatusMeta.label}</Tag>
                      <span>{renderStatusMeta.description}</span>
                    </div>
                  </div>
                  {keyframePromptRenderMappings.length > 0 ? (
                    <div className="mb-2 flex flex-wrap gap-2">
                      {keyframePromptRenderMappings.map((mapping) => (
                        <Tag key={`${mapping.token}:${mapping.file_id}`}>{`${mapping.token} = ${mapping.name}`}</Tag>
                      ))}
                    </div>
                  ) : null}
                  {keyframePromptSelectedGuidance.length > 0 || keyframePromptDroppedGuidance.length > 0 ? (
                    <div className="mb-3 rounded-lg border border-slate-200 bg-white px-3 py-3 text-xs text-slate-700">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-medium text-slate-900">最终图片提示词收敛结果</div>
                          <div className="mt-1 text-slate-500">
                            系统会从上游导演约束里挑出最关键的少量规则，补进最终图片提示词。
                          </div>
                        </div>
                        <Space size="small" wrap>
                          <Tag color="green">{`保留 ${keyframePromptSelectedGuidance.length}`}</Tag>
                          <Tag color="gold">{`压缩 ${keyframePromptDroppedGuidance.length}`}</Tag>
                          {(keyframePromptSelectedGuidance.length > 2 || keyframePromptDroppedGuidance.length > 0) ? (
                            <Button
                              size="small"
                              type="text"
                              onClick={() => setKeyframePromptDecisionCollapsed((prev) => !prev)}
                            >
                              {keyframePromptDecisionCollapsed ? '查看取舍' : '收起取舍'}
                            </Button>
                          ) : null}
                        </Space>
                      </div>
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-xs text-emerald-800">
                          <div className="font-medium">实际保留的生成要求</div>
                          {keyframePromptSelectedGuidance.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {keyframePromptVisibleSelectedGuidanceDetails.map((item) => (
                                <Tooltip
                                  key={`selected:${item.text}`}
                                  title={(
                                    <div className="max-w-[320px] text-xs leading-5">
                                      {item.reasonTag ? (
                                        <Tag color="green" className="mb-1">
                                          {item.reasonTag}
                                        </Tag>
                                      ) : null}
                                      <div>{item.text}</div>
                                      {item.reason ? <div className="mt-1 text-slate-500">{item.reason}</div> : null}
                                    </div>
                                  )}
                                >
                                  <Tag color="green" className="max-w-[240px] overflow-hidden">
                                    <span className="inline-block max-w-[200px] truncate align-bottom">{item.text}</span>
                                  </Tag>
                                </Tooltip>
                              ))}
                              {keyframePromptDecisionCollapsed && keyframePromptSelectedGuidanceDetails.length > 2 ? (
                                <Tag>{`+${keyframePromptSelectedGuidanceDetails.length - 2} 条`}</Tag>
                              ) : null}
                            </div>
                          ) : (
                            <div className="mt-2 text-emerald-700">当前没有额外 guidance 被保留。</div>
                          )}
                        </div>
                        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800">
                          <div className="font-medium">已压缩的生成要求</div>
                          {keyframePromptDroppedGuidance.length > 0 ? (
                            keyframePromptDecisionCollapsed ? (
                              <div className="mt-2 text-amber-700">
                                当前有 {keyframePromptDroppedGuidance.length} 条 guidance 被压缩，展开后可查看具体取舍原因。
                              </div>
                            ) : (
                              <div className="mt-2 flex flex-wrap gap-2">
                                {keyframePromptVisibleDroppedGuidanceDetails.map((item) => (
                                  <Tooltip
                                    key={`dropped:${item.text}`}
                                    title={(
                                      <div className="max-w-[320px] text-xs leading-5">
                                        {item.reasonTag ? (
                                          <Tag color="gold" className="mb-1">
                                            {item.reasonTag}
                                          </Tag>
                                        ) : null}
                                        <div>{item.text}</div>
                                        {item.reason ? <div className="mt-1 text-slate-500">{item.reason}</div> : null}
                                      </div>
                                    )}
                                  >
                                    <Tag color="gold" className="max-w-[240px] overflow-hidden">
                                      <span className="inline-block max-w-[200px] truncate align-bottom">{item.text}</span>
                                    </Tag>
                                  </Tooltip>
                                ))}
                              </div>
                            )
                          ) : (
                            <div className="mt-2 text-amber-700">当前没有 guidance 被压缩。</div>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : null}
                  {hasBasePrompt ? (
                    <div className="rounded-lg border border-slate-200 bg-white px-3 py-3 text-sm leading-6 text-slate-800 whitespace-pre-wrap min-h-[220px]">
                      {keyframePromptRenderedDraft || '系统正在根据当前内容准备提交版本…'}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-6 text-sm text-slate-500">
                      <div className="font-medium text-slate-700">等待基础提示词</div>
                      <div className="mt-2">
                        基础提示词准备完成后，系统会自动：
                      </div>
                      <div className="mt-2 space-y-1 text-slate-500">
                        <div>1. 根据当前参考图顺序生成图1 / 图2映射</div>
                        <div>2. 补充“## 图片内容说明”</div>
                        <div>3. 生成最终提交给模型的提示词</div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })()}
        </Modal>

        <Modal
          title="视频生成提示词预览"
          open={videoPromptPreviewOpen}
          onCancel={() => {
            if (videoPromptPreviewSubmitting) return
            setVideoPromptPreviewOpen(false)
          }}
          footer={[
            <Button
              key="cancel"
              disabled={videoPromptPreviewSubmitting || videoPromptSaving}
              onClick={() => {
                if (videoPromptPreviewSubmitting || videoPromptSaving) return
                setVideoPromptPreviewOpen(false)
              }}
            >
              取消
            </Button>,
            <Button
              key="save-prompt"
              loading={videoPromptSaving}
              disabled={videoPromptPreviewSubmitting || videoPromptPreviewLoading}
              onClick={() => void saveVideoPromptToShot()}
            >
              保存提示词
            </Button>,
            <Button
              key="regenerate"
              danger
              loading={videoPromptPreviewSubmitting}
              disabled={videoPromptSaving}
              onClick={() => void regenerateVideoGeneration()}
            >
              重新生成（下一轮）
            </Button>,
            <Button
              key="submit"
              type="primary"
              loading={videoPromptPreviewSubmitting}
              disabled={videoPromptSaving}
              onClick={() => void submitVideoGeneration()}
            >
              生成
            </Button>,
          ]}
          width={900}
          destroyOnHidden
        >
          {videoPromptPreviewLoading ? (
            <div className="py-8 text-center">
              <Spin />
            </div>
          ) : (
            <div className="space-y-3">
              <div
                className={`rounded-lg border px-3 py-2 text-[11px] leading-5 ${
                  savedVideoPrompt
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : 'border-slate-200 bg-slate-50 text-slate-600'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {savedVideoPrompt ? '该镜头已有保存的视频提示词' : '该镜头尚未保存视频提示词'}
                  </span>
                  {savedVideoPrompt ? (
                    <>
                      <Tag color="green">{`来源：${videoPromptSourceLabel(savedVideoPromptSource)}`}</Tag>
                      <Tag>{`长度 ${savedVideoPrompt.length} 字`}</Tag>
                      {savedVideoPromptDiffers ? <Tag color="orange">与当前编辑内容不一致</Tag> : null}
                    </>
                  ) : (
                    <Tag>交付导出读取这里保存的提示词</Tag>
                  )}
                </div>
                <div className="mt-1">
                  {savedVideoPrompt
                    ? '打开弹窗时已回填该已保存内容，并且不会被大模型结果自动覆盖；点击「保存提示词」才会写回。'
                    : '当前草稿尚未落库，交付页面（「提示词导入/交付」）读不到；点击「保存提示词」可写入该镜头。'}
                </div>
                <div className="mt-1">
                  {`本次保存将标记来源为：${videoPromptSourceLabel(videoPromptSaveSource)}`}
                  {videoLlmResultDiffers ? '（与本次大模型生成结果不一致）' : '（与本次大模型生成结果一致）'}
                </div>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
                {/* 审计 §4.3 模式 4：「生成路径：直提」+ 两个完整接口路径 + Celery/Redis/pending
                    整段从主区撤下 —— 接口路径与历史实现说明下沉到下面默认收起的「技术详情」。 */}
                <div className="font-medium">生成方式：立即执行，生成完自动挂到本镜</div>
                <div className="mt-1">
                  「生成」会在当前服务里直接跑完并等你看到结果：成功后自动把成片登记成素材并挂到本镜
                  （刷新后仍可见、交付也能读到）。
                </div>
                <div className="mt-1">
                  本集统一用「短视频标准方案」（固定 480p、最短 5 秒）；
                  参考音频（若该镜头绑定）与参考图也会一并带上。演练模式下只返回占位结果，不发生真实费用。
                </div>
                {videoPinnedPlan ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Tag color={videoPinnedPlan.modelPinned ? 'green' : 'red'}>
                      {`模型方案：${videoModelBusinessName(videoPinnedPlan.modelName)}`}
                    </Tag>
                    <Tag>{`分辨率：${videoPinnedPlan.resolution || '未知'}`}</Tag>
                    <Tag>{`最短时长：${videoPinnedPlan.seconds || 0}s`}</Tag>
                    {/* 审计 §4.3 模式 5：「供应商：prov-xxx」从主区移除，原始值只进技术详情 */}
                    {videoPinnedPlan.providerSupported ? null : <Tag color="red">当前视频方案不支持这个参考方式</Tag>}
                  </div>
                ) : (
                  // 审计 §4.3 点名的开发术语：「契约」不上主区
                  <div className="mt-2">暂时还读不到这次的视频方案预览（参考图数量或镜头数据不满足生成条件）。</div>
                )}
                <div className="mt-1">
                  {videoPinnedPlan?.guardStatus
                    ? `是否允许真实付费：${describeGuardStatus(videoPinnedPlan.guardStatus)}`
                    : '暂时读不到是否允许真实付费（未取到计划预览）。'}
                </div>
                {videoPinnedPlan && videoPinnedPlan.warnings.length > 0 ? (
                  /* 第 3 批收尾（审计 §4.3 模式 4/6 + §7.1-6 成对文案）：
                     旧实现把后端 warnings 过一遍管道后逐条铺在主区 —— 那仍然是**后端句子的改写结果**，
                     且原因里可能带本机 / 内网 host。主区改成产品自己写的中文结论，
                     后端原话进默认收起的「技术详情」。 */
                  <div className="mt-1">
                    <div className="rounded bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800">
                      {`这次的提交计划有 ${videoPinnedPlan.warnings.length} 条需要注意的地方：可能有个别参考图没能带上，或时长 / 画幅按项目默认值提交。`}
                      生成前请先核对上面的方案标签与参考图；原始说明见下面的「技术详情」。
                    </div>
                    <TechnicalDetailSection testId="video-pinned-plan-warning-detail" hint="生成服务对这次提交计划的原始说明">
                      <ul className="mt-0 list-disc pl-4">
                        {videoPinnedPlan.warnings.map((item: string, index: number) => (
                          <li key={`video-pinned-warning-${index}`}>{maskInternalIds(item)}</li>
                        ))}
                      </ul>
                    </TechnicalDetailSection>
                  </div>
                ) : null}
                {/* 审计 §4.3 模式 4：「DRY_RUN 守卫只作用于直提端点…」整句下沉到「技术详情」 */}
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-700">镜头连续性上下文</div>
                    <div className="mt-1 text-[11px] leading-5 text-slate-500">
                      这些上下文会参与视频模板渲染和提交版本补强，默认先展示摘要，需要时再展开细节。
                    </div>
                  </div>
                  <Button
                    type="link"
                    size="small"
                    className="px-0"
                    onClick={() => setVideoPromptContextCollapsed((prev) => !prev)}
                  >
                    {videoPromptContextCollapsed ? '展开细节' : '收起细节'}
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Tag color="blue">{`动作节拍 ${videoActionBeats.length}`}</Tag>
                  {videoPromptPreviewPack?.previous_shot_summary ? (
                    <Tag color="purple">上一镜头</Tag>
                  ) : null}
                  {videoPromptPreviewPack?.next_shot_goal ? (
                    <Tag color="cyan">下一镜头</Tag>
                  ) : null}
                  {videoPromptPreviewPack?.continuity_guidance ? (
                    <Tag color="gold">连续性</Tag>
                  ) : null}
                </div>
                <div className="mt-3 space-y-3">
                  <div>
                    <div className="text-slate-500">动作节拍</div>
                    {videoVisibleActionBeats.length > 0 ? (
                      <div className="mt-1 flex flex-wrap gap-2">
                        {videoVisibleActionBeats.map((item, index) => (
                          <Tag
                            key={`${index}:${item.phase ?? 'raw'}:${item.text}`}
                            color={
                              item.phase === 'trigger'
                                ? 'gold'
                                : item.phase === 'peak'
                                  ? 'blue'
                                  : item.phase === 'aftermath'
                                    ? 'green'
                                    : 'default'
                            }
                          >
                            {item.phase
                              ? `${item.phase === 'trigger' ? '触发' : item.phase === 'peak' ? '峰值' : '收束'} · ${item.text}`
                              : item.text}
                          </Tag>
                        ))}
                        {videoPromptContextCollapsed && hiddenVideoActionBeatCount > 0 ? (
                          <Tag>{`+${hiddenVideoActionBeatCount}`}</Tag>
                        ) : null}
                      </div>
                    ) : (
                      <div className="mt-1 text-gray-400">暂无动作节拍</div>
                    )}
                  </div>
                  {!videoPromptContextCollapsed ? (
                    <>
                      <div>
                        <div className="text-slate-500">上一镜头摘要</div>
                        <div className="mt-1 whitespace-pre-wrap text-slate-700">
                          {videoPromptPreviewPack?.previous_shot_summary || '无'}
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-500">下一镜头目标</div>
                        <div className="mt-1 whitespace-pre-wrap text-slate-700">
                          {videoPromptPreviewPack?.next_shot_goal || '无'}
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-500">连续性建议</div>
                        <div className="mt-1 whitespace-pre-wrap text-slate-700">
                          {videoPromptPreviewPack?.continuity_guidance || '无'}
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-500">构图与空间锚点</div>
                        <div className="mt-1 whitespace-pre-wrap text-slate-700">
                          {videoPromptPreviewPack?.composition_anchor || '无'}
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-500">朝向与视线建议</div>
                        <div className="mt-1 whitespace-pre-wrap text-slate-700">
                          {videoPromptPreviewPack?.screen_direction_guidance || '无'}
                        </div>
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-2">关联图片（参考图）</div>
                {videoPromptPreviewImages.length === 0 ? (
                  <div className="text-xs text-gray-400">暂无关联图片</div>
                ) : (
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    <Image.PreviewGroup>
                      {videoPromptPreviewImages.map((fid) => (
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
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div className="text-xs text-gray-500">提示词（可编辑）</div>
                  <div className="flex items-center gap-2">
                    {videoLlmDerivedPromptTrimmed && videoLlmResultDiffers ? (
                      <Button type="link" size="small" className="px-0" onClick={applyVideoLlmDerivedPrompt}>
                        使用本次大模型结果
                      </Button>
                    ) : null}
                    <span className="text-[11px] text-gray-400">{`保存来源：${videoPromptSourceLabel(videoPromptSaveSource)}`}</span>
                  </div>
                </div>
                <Input.TextArea
                  rows={10}
                  value={videoPromptPreviewDraft}
                  onChange={(e) => videoPromptDraft.setBase({ prompt: e.target.value })}
                  placeholder="请输入视频提示词…"
                  disabled={videoPromptPreviewSubmitting || videoPromptSaving}
                />
              </div>
            </div>
          )}
        </Modal>
      </div>
    </div>
  )
}
