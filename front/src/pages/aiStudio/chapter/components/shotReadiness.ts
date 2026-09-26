/**
 * 每镜"就绪结果"的**唯一判定来源**（第二部分要求：三个行为共用同一套判断）。
 *
 * 为什么必须只有一套：进度条、生产卡按钮、导出弹窗如果各写一份判断，
 * 就会出现"进度条说就绪、按钮却禁用"这类互相矛盾的状态。
 *
 * 两条就绪度**分开**（用户明确要求）：
 * - `canGenerate`：还要求当前参考模式需要的帧全部可用；
 * - `canExport`：只要有**有效来源**的提示词就能导出（不要求生成过视频、不要求关键帧齐全），
 *   绑定文件缺失只作为提醒标注，不阻止导出。
 */

// 阶段 B ③（审计 §4.3 模式 3）：帧类型不许原值上屏，复用同目录已有的 frameTypeLabel
import { frameTypeLabel } from './shotStatusText.ts'
// 阶段 B ③（审计 §4.3 模式 6）：`frame_block_reasons` 是后端原文，进主区前先过三级管道
import { toUserFacingText } from '../../components/userFacingMessage.ts'

export type PromptDeliveryFile = {
  slot?: string
  slot_label?: string
  asset_id?: string
  asset_name?: string
  file_id?: string
  url?: string
  is_primary?: boolean
  usable?: boolean
  resolved_from?: string
}

export type PromptDeliveryRowLike = {
  shot_id: string
  shot_code: string
  shot_title: string
  video_prompt: string
  video_prompt_source: string
  exportable: boolean
  bound_files?: PromptDeliveryFile[]
}

export type StepState = 'not_started' | 'partial' | 'ready'

export type ShotReadiness = {
  shotId: string
  code: string
  title: string
  /** 当前步骤状态 */
  stepState: StepState
  /** 缺少的具体内容（给用户看的） */
  missing: string[]
  /** 生成就绪（含参考帧要求） */
  canGenerate: boolean
  /** 导出就绪（只看提示词 + 标注绑定缺失） */
  canExport: boolean
  /** 绑定文件缺失的提醒（导出允许，但要标注） */
  exportWarnings: string[]
  hasPrompt: boolean
  hasBoundFiles: boolean
}

/** 有正文且来源在白名单内才算"可导出"的来源（与交付导出口径一致）。 */
const EXPORT_SOURCES = [
  'jurilu',
  'skill',
  'llm',
  'internal',
  'manual',
  'manual_workspace',
  'shot_description',
  'external_import',
]

export function hasExportableSource(source: string | null | undefined): boolean {
  return EXPORT_SOURCES.includes(String(source ?? '').trim().toLowerCase())
}

export type ReadinessInput = {
  row: PromptDeliveryRowLike
  /** 当前参考模式要求的帧类型（first/last/key…）；纯文本模式传空数组 */
  requiredFrameTypes?: string[]
  /** 这些帧里**供应商真的取得到**的帧类型（有 file_id ≠ 可用，见下） */
  usableFrameTypes?: string[]
  /**
   * 有 `file_id` 但**供应商取不到**的帧类型（典型：本机存储的帧只能变成 base64 data URL，
   * 而 APIMart 只接受 http(s):// / asset://）。
   * 判定口径来自后端 `resolve_vendor_image_ref`，与计划预检、提交前校验是同一份实现。
   */
  unusableFrameTypes?: string[]
  /** 不可用/缺失帧的具体原因（后端原样带回，页面直接展示） */
  frameBlockReasons?: string[]
  /** 计划是否已经拿到并有效（未拿到时不能算生成就绪） */
  planReady?: boolean
  extraBlockers?: string[]
}

export function evaluateShotReadiness(input: ReadinessInput): ShotReadiness {
  const { row } = input
  const missing: string[] = []
  const exportWarnings: string[] = []
  const prompt = String(row.video_prompt ?? '').trim()
  const hasPrompt = Boolean(prompt)
  const files = row.bound_files ?? []
  const imageFiles = files.filter((item) => String(item.slot ?? '') !== 'audio')
  const usableImages = imageFiles.filter((item) => item.usable)
  const hasBoundFiles = files.length > 0

  if (!hasPrompt) missing.push('还没有视频提示词')
  if (!imageFiles.length) missing.push('还没有绑定图片资产')
  else if (!usableImages.length) missing.push('绑定的图片资产没有可用文件（未定版或缺图）')

  const required = (input.requiredFrameTypes ?? []).filter(Boolean)
  const usable = new Set((input.usableFrameTypes ?? []).filter(Boolean))
  const unusable = new Set((input.unusableFrameTypes ?? []).filter(Boolean))
  const missingFrames = required.filter((frame) => !usable.has(frame))
  // 区分两类阻断，页面提示必须说清是"没上传"还是"上传了但供应商取不到"
  const absentFrames = missingFrames.filter((frame) => !unusable.has(frame))
  const blockedFrames = missingFrames.filter((frame) => unusable.has(frame))
  if (absentFrames.length) missing.push(`缺少参考帧：${absentFrames.map(frameTypeLabel).join('、')}`)
  if (blockedFrames.length) {
    // 审计 §4.3 模式 5：主区禁词「供应商」→ 用户语言「当前服务取不到」；帧类型同样过映射
    missing.push(`参考帧已上传但当前服务取不到：${blockedFrames.map(frameTypeLabel).join('、')}`)
  }
  for (const reason of input.frameBlockReasons ?? []) {
    // 审计 §4.3 模式 6：这串直接渲染在主区「本镜还缺什么」里（源头 ChapterStudio 传 frame_block_reasons）
    if (reason) missing.push(toUserFacingText(reason, '这一帧这次用不了：可以重新生成或换一张参考图'))
  }
  if (input.planReady === false && required.length) missing.push('生成计划尚未加载完成')
  missing.push(...(input.extraBlockers ?? []))

  // 导出就绪：只看"这一镜能不能作为提示词交付"，不要求生成过视频，也不要求帧齐全
  const canExport = hasPrompt && hasExportableSource(row.video_prompt_source)
  if (!hasPrompt) exportWarnings.push('缺提示词')
  else if (!hasExportableSource(row.video_prompt_source)) exportWarnings.push('提示词不是正式保存的版本，暂时不可导出')
  if (!imageFiles.length) exportWarnings.push('未绑定图片资产')
  else if (!usableImages.length) exportWarnings.push('绑定图片没有可用文件')

  // 生成就绪：提示词 + 计划 + 参考帧齐全（绑定文件缺失不单独阻止，但已在 missing 里体现）
  const canGenerate = hasPrompt && missingFrames.length === 0 && input.planReady !== false

  const stepState: StepState = !hasPrompt && !hasBoundFiles ? 'not_started' : canExport && canGenerate ? 'ready' : 'partial'

  return {
    shotId: row.shot_id,
    code: row.shot_code,
    title: row.shot_title,
    stepState,
    missing,
    canGenerate,
    canExport,
    exportWarnings,
    hasPrompt,
    hasBoundFiles,
  }
}

/** 顶部三态：只有范围内**每一镜**都满足该步骤要求才算"已就绪"。 */
export function summarizeStepState(states: StepState[]): StepState {
  if (!states.length) return 'not_started'
  if (states.every((state) => state === 'ready')) return 'ready'
  if (states.every((state) => state === 'not_started')) return 'not_started'
  return 'partial'
}

export const STEP_STATE_META: Record<StepState, { label: string; color: string }> = {
  not_started: { label: '未开始', color: 'default' },
  partial: { label: '部分完成', color: 'gold' },
  ready: { label: '已就绪', color: 'green' },
}
