/**
 * 「本镜生产」的**生成计划与提交**状态（唯一实现）。
 *
 * 为什么单独成 hook：第三部分要把「手动分镜 / 视频准备 / 分镜生产卡」合成一个连续工作区，
 * 但生成前的预检（参考模式要求的帧、供应商能不能取到帧、DRY_RUN 守卫）只能有**一套判断**。
 * 这里把它从原来的 `ShotProductionCard` 里抽出来，工作区的「本次请求实际使用的帧」「本镜还缺什么」
 * 「生成视频」「导出绑定提示词」四块共用同一份 plan 状态，不再各拉一次、各判一次。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { message } from 'antd'
import {
  persistGeneratedVideo,
  previewPromptDelivery,
  previewVideoSubmitPlan,
  submitVideo,
  type PromptDeliveryRow,
  type VideoPlanFrame,
} from '../../../../services/llmPipelineApi'

/** 生成计划摘要的结构（`previewVideoSubmitPlan` 返回） */
export type ShotRequestPlan = Awaited<ReturnType<typeof previewVideoSubmitPlan>>

/**
 * 参考方式：只给**业务说法**，不暴露后端枚举名给用户做选择题。
 * 取值与后端 `REQUIRED_FRAMES_BY_MODE` 一致。
 */
export const REFERENCE_MODE_OPTIONS = [
  { value: 'text_only', label: '纯文本（不用任何参考帧）' },
  { value: 'first', label: '用首帧' },
  { value: 'last', label: '用尾帧' },
  { value: 'key', label: '用关键帧' },
  { value: 'first_last', label: '首帧 + 尾帧' },
  { value: 'first_last_key', label: '首帧 + 尾帧 + 关键帧' },
] as const

const REFERENCE_MODE_LABELS: Record<string, string> = {
  text_only: '纯文本（不用参考帧）',
  first: '首帧',
  last: '尾帧',
  key: '关键帧',
  first_last: '首帧 + 尾帧',
  first_last_key: '首帧 + 尾帧 + 关键帧',
}

export function referenceModeLabel(mode: string | null | undefined): string {
  const key = String(mode ?? '').trim()
  if (!key) return '未设置'
  return REFERENCE_MODE_LABELS[key] ?? key
}

/**
 * 模型方案的**业务名称**。
 *
 * 固定策略是 `seedance-2.0-mini`（见后端 `video_submit.PINNED_VIDEO_MODEL`），
 * 页面上不该让用户读模型 ID；供应商名、原始模型名、分辨率档位属于技术详情。
 */
const VIDEO_MODEL_BUSINESS_NAMES: Record<string, string> = {
  'seedance-2.0-mini': '短视频标准方案（Seedance 2.0 Mini）',
}

export function videoModelBusinessName(modelName: string | null | undefined): string {
  const key = String(modelName ?? '').trim()
  if (!key) return '未解析'
  return VIDEO_MODEL_BUSINESS_NAMES[key] ?? key
}

/**
 * 计划里是否存在「有 file_id 但**供应商取不到**」的参考帧。
 *
 * 判定口径与后端 `resolve_vendor_image_ref` 一致：`usable=false` 且有 file_id。
 * 后端已经把这种帧算进 `generation_blocked`，这里再兜一层，避免用陈旧计划放开按钮。
 */
export function hasVendorUnusableFrame(plan: ShotRequestPlan | null | undefined): boolean {
  if (!plan) return false
  if (String(plan.reference_mode ?? '') === 'text_only') return false
  return (plan.frames ?? []).some((frame: VideoPlanFrame) => Boolean(frame.file_id) && frame.usable === false)
}

export type ShotRequestGap = { key: string; text: string }

export type UseShotRequestPlanResult = {
  /** 已保存提示词对应的交付行（含本镜实际使用的绑定文件） */
  row: PromptDeliveryRow | null
  rowLoading: boolean
  reloadRow: () => Promise<void>
  plan: ShotRequestPlan | null
  planLoading: boolean
  loadPlan: () => Promise<void>
  referenceMode: string
  setReferenceMode: (mode: string) => void
  imageFiles: NonNullable<PromptDeliveryRow['bound_files']>
  audioFile: NonNullable<PromptDeliveryRow['bound_files']>[number] | undefined
  gaps: ShotRequestGap[]
  /** 生成按钮是否该禁用（预检 + 供应商帧可用性 + 提示词），与按钮 disabled 同一口径 */
  generateDisabled: boolean
  generateBlockedReason: string
  generating: boolean
  doGenerate: () => Promise<void>
  /** 计划里缺失的帧类型（供状态文案复用，不重复计算） */
  missingFrameTypes: string[]
  unusableFrameTypes: string[]
}

export function useShotRequestPlan(args: {
  projectId?: string
  chapterId?: string | null
  shotId: string
  /** 已保存到本镜的视频提示词（生成与导出读的就是它） */
  savedPrompt: string
  /** 生成成功后通知外层刷新（镜头详情 / 成片列表） */
  onGenerated?: () => Promise<void> | void
}): UseShotRequestPlanResult {
  const { projectId, chapterId, shotId, savedPrompt, onGenerated } = args
  const [row, setRow] = useState<PromptDeliveryRow | null>(null)
  const [rowLoading, setRowLoading] = useState(false)
  const [plan, setPlan] = useState<ShotRequestPlan | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [referenceMode, setReferenceModeState] = useState('first')

  const reloadRow = useCallback(async () => {
    if (!projectId || !shotId) return
    setRowLoading(true)
    try {
      const data = await previewPromptDelivery(projectId, chapterId, 'episode', [shotId])
      setRow((data?.rows ?? []).find((item) => item.shot_id === shotId) ?? null)
    } catch {
      setRow(null)
    } finally {
      setRowLoading(false)
    }
  }, [chapterId, projectId, shotId])

  useEffect(() => {
    void reloadRow()
  }, [reloadRow])

  // 参考模式一变，旧计划立即失效（按钮必须先禁用，避免用陈旧参数提交）
  const setReferenceMode = useCallback((mode: string) => {
    setReferenceModeState(mode)
    setPlan(null)
  }, [])

  const loadPlan = useCallback(async () => {
    if (!shotId) return
    setPlanLoading(true)
    try {
      // 摘要必须与真实提交同参：生成提交的就是这份「已保存提示词」。
      const data = await previewVideoSubmitPlan({
        shot_id: shotId,
        reference_mode: referenceMode,
        prompt: savedPrompt.trim() || undefined,
      })
      setPlan(data)
    } catch (error) {
      setPlan(null)
      message.warning(error instanceof Error ? error.message : '读取生成计划失败')
    } finally {
      setPlanLoading(false)
    }
  }, [referenceMode, savedPrompt, shotId])

  // 自动预检：进入工作区 / 切换镜头 / 切换参考方式 / 提示词变化都重拉一次
  useEffect(() => {
    void loadPlan()
  }, [loadPlan])

  const files = row?.bound_files ?? []
  const imageFiles = useMemo(() => files.filter((item) => String(item.slot ?? '') !== 'audio'), [files])
  const audioFile = useMemo(() => files.find((item) => String(item.slot ?? '') === 'audio'), [files])
  const missingImages = imageFiles.filter((item) => !item.usable)

  const gaps = useMemo<ShotRequestGap[]>(() => {
    const list: ShotRequestGap[] = []
    if (!savedPrompt.trim()) {
      list.push({ key: 'prompt', text: '还没有已保存的视频提示词（在「单镜编辑」里写好后保存）' })
    }
    if (!imageFiles.length) {
      list.push({ key: 'binding', text: '还没有绑定任何图片资产（到「资产与参考帧」确认推荐并保存）' })
    }
    if (missingImages.length) {
      list.push({
        key: 'binding-file',
        text: `上游素材里 ${missingImages.length} 个绑定资产没有可用图片文件（未定版或缺图）`,
      })
    }
    if (plan?.generation_blocked) {
      list.push({
        key: 'frames',
        text: `视频请求缺少参考方式「${referenceModeLabel(plan.reference_mode)}」要求的帧：${(plan.missing_frame_types ?? []).join('、')}（到「资产与参考帧」补齐或换参考方式）`,
      })
    }
    if (!audioFile) {
      list.push({ key: 'audio', text: '还没有声音：要配音就绑定音频，不需要就明确标记「本镜无需声音」' })
    }
    return list
  }, [audioFile, imageFiles.length, missingImages.length, plan, savedPrompt])

  const generateBlockedReason = useMemo(() => {
    if (!plan) return '生成计划尚未就绪：等计划加载完成后再生成（页面已自动预检）。'
    if (plan.generation_blocked) return plan.blocked_reason || '当前参考方式缺少必需帧，已阻止生成。'
    if (hasVendorUnusableFrame(plan)) {
      return '参考帧供应商无法访问：帧文件是本机/相对地址，只能解析成本机 data URL，'
        + '而当前供应商只接受公网地址。请把帧图片放到公网后重新设为该帧，或改用纯文本。'
    }
    if (!savedPrompt.trim()) return '本镜还没有已保存的提示词：先保存提示词再生成（生成读的就是这一份）。'
    return ''
  }, [plan, savedPrompt])

  const generateDisabled = Boolean(generateBlockedReason) || planLoading

  const doGenerate = useCallback(async () => {
    if (generateBlockedReason) {
      message.error(generateBlockedReason)
      return
    }
    if (!plan) return
    setGenerating(true)
    try {
      // 生成用**同一份计划参数**：参考方式、画幅、时长、提示词都取自刚才那份计划
      const result = await submitVideo({
        shot_id: shotId,
        reference_mode: plan.reference_mode || referenceMode,
        prompt: savedPrompt.trim(),
        images: [],
        ratio: plan.ratio || '16:9',
        duration_seconds: plan.seconds ?? undefined,
        timeout_seconds: 900,
      })
      if (result.status === 'dry_run') {
        message.info('演练模式（DRY_RUN）：只展示计划，不会产生正式视频，也未写入任何库', 6)
        return
      }
      if (result.status !== 'completed' || !result.url) {
        message.error(result.error || `视频生成未完成（status=${result.status}）`)
        return
      }
      const fileId = await persistGeneratedVideo(shotId, result.url, '镜头视频（直提）')
      message.success(`已生成并挂到本镜（file_id=${fileId}）`)
      await reloadRow()
      await onGenerated?.()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '生成失败')
    } finally {
      setGenerating(false)
    }
  }, [generateBlockedReason, onGenerated, plan, referenceMode, reloadRow, savedPrompt, shotId])

  return {
    row,
    rowLoading,
    reloadRow,
    plan,
    planLoading,
    loadPlan,
    referenceMode,
    setReferenceMode,
    imageFiles,
    audioFile,
    gaps,
    generateDisabled,
    generateBlockedReason,
    generating,
    doGenerate,
    missingFrameTypes: plan?.missing_frame_types ?? [],
    unusableFrameTypes: plan?.unusable_frame_types ?? [],
  }
}
