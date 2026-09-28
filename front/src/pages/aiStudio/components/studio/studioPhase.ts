/**
 * 分镜工作室 · 阶段模型（第 3–5 步共用一个页面容器）。
 *
 * ## 口径（任务书《Jellyfish UI/UX v2》第三部分）
 *
 * - 全局五步名称不变：1 剧本与分镜 · 2 资产准备 · 3 整集视频提示词 · 4 资产与声音检查 · 5 生成与交付；
 * - 「分镜工作室」是**第 3～5 步共用的页面容器**（`/projects/:projectId/chapters/:chapterId/studio`），
 *   容器内用阶段条切换 `3 / 4 / 5`；**切换阶段 ≠ 离开分镜工作室**，不换页、不换镜头；
 * - 阶段 key 沿用既有 `?studio=` 的取值（`video_prompt` / `binding` / `deliver`），
 *   旧深链（项目工作台第 4-6 步带过来的 `?studio=video_prompt|binding|generate_deliver`）继续可用；
 * - **当前镜头**也进 URL（`?shot=<shotId>`）：刷新、复制链接、重新进入都能恢复同一镜头。
 *   这是「正式业务事实来源」，不是 `localStorage`。
 *
 * 为什么把这些放在独立模块：阶段 ↔ 项目步骤的换算、URL 参数读写是**纯逻辑**，
 * 可以被 `node --test` 直接跑（见 `studioPhase.test.ts`），页面只调用它，不各自再写一套。
 */

/** 工作室阶段 key（= 项目内部步骤 key 里属于工作室的那三个）。 */
export type StudioPhaseKey = 'video_prompt' | 'binding' | 'deliver'

export type StudioPhaseMeta = {
  key: StudioPhaseKey
  /**
   * 项目里的内部步骤 key。
   *
   * **口径澄清（别被"六步"误导）**：项目内部步骤模型是**六步**
   * （`script` / `extract_assets` / `image_prep` / `video_prompt` / `binding` /
   * `generate_deliver`，见 `projectSteps.ts` 的 `PROJECT_STEPS`），
   * 而**展示给用户的是全局五步**（`GLOBAL_STEPS`）：
   * 第 2 步「资产准备」合并了 `extract_assets` + `image_prep`，
   * 第 3–5 步分别对应 `video_prompt` / `binding` / `generate_deliver`
   * 并由**同一个分镜工作室容器**的三个阶段承载。
   *
   * 两个模型的映射**只在这里**（`STUDIO_PHASES`）与 `projectSteps.ts` 的 `DISPLAY_STEPS` 各定一次，
   * 页面不许再自己写第三份；用户可见文案里不出现内部 key。
   */
  projectStepKey: 'video_prompt' | 'binding' | 'generate_deliver'
  /** 全局五步里的序号（3/4/5） */
  displayIndex: number
  /** 阶段条上的完整文案：`3 整集视频提示词` */
  label: string
  /** 五步导航里的名字（第 3 步**不**叫「分镜工作室」） */
  stepLabel: string
}

/** 阶段条顺序 = 业务顺序，唯一事实来源。 */
export const STUDIO_PHASES: StudioPhaseMeta[] = [
  {
    key: 'video_prompt',
    projectStepKey: 'video_prompt',
    displayIndex: 3,
    label: '3 整集视频提示词',
    stepLabel: '整集视频提示词',
  },
  {
    key: 'binding',
    projectStepKey: 'binding',
    displayIndex: 4,
    label: '4 资产与声音检查',
    stepLabel: '资产与声音检查',
  },
  {
    key: 'deliver',
    projectStepKey: 'generate_deliver',
    displayIndex: 5,
    label: '5 生成与交付',
    stepLabel: '生成与交付',
  },
]

/** 容器标题：阶段条上的容器名。 */
export const STUDIO_CONTAINER_LABEL = '分镜工作室'

/** URL 参数名（唯一事实来源，页面不许再写字符串字面量）。 */
export const STUDIO_PHASE_PARAM = 'studio'
export const STUDIO_SHOT_PARAM = 'shot'

/** 五步全量（工作室只占后三步，这里给全是为了渲染常驻五步条）。 */
export const GLOBAL_STEPS: Array<{ key: string; label: string; studioPhase: StudioPhaseKey | null }> = [
  { key: 'script_shots', label: '剧本与分镜', studioPhase: null },
  { key: 'asset_prep', label: '资产准备', studioPhase: null },
  { key: 'episode_prompt', label: '整集视频提示词', studioPhase: 'video_prompt' },
  { key: 'asset_binding', label: '资产与声音检查', studioPhase: 'binding' },
  { key: 'generate_deliver', label: '生成与交付', studioPhase: 'deliver' },
]

const PHASE_BY_KEY = new Map(STUDIO_PHASES.map((item) => [item.key, item]))

/** 旧 URL / 项目内部步骤 key → 阶段 key（认不出来时落到第 3 阶段，不抛错）。 */
export function resolveStudioPhaseFromParam(raw: string | null | undefined): StudioPhaseKey {
  const value = String(raw ?? '').trim()
  if (!value) return STUDIO_PHASES[0].key
  const direct = PHASE_BY_KEY.get(value as StudioPhaseKey)
  if (direct) return direct.key
  const byProjectStep = STUDIO_PHASES.find(
    (item) => item.projectStepKey === value || item.projectStepKey === value.replace(/-/g, '_'),
  )
  return byProjectStep?.key ?? STUDIO_PHASES[0].key
}

export function getStudioPhase(key: StudioPhaseKey): StudioPhaseMeta {
  return PHASE_BY_KEY.get(key) ?? STUDIO_PHASES[0]
}

export function studioPhaseIndex(key: StudioPhaseKey): number {
  const index = STUDIO_PHASES.findIndex((item) => item.key === key)
  return index >= 0 ? index : 0
}

/** 上一 / 下一阶段（没有则 null）——阶段条两侧的翻页按钮与键盘快捷键用。 */
export function getPrevStudioPhase(key: StudioPhaseKey): StudioPhaseKey | null {
  const index = studioPhaseIndex(key)
  return index <= 0 ? null : STUDIO_PHASES[index - 1].key
}

export function getNextStudioPhase(key: StudioPhaseKey): StudioPhaseKey | null {
  const index = studioPhaseIndex(key)
  return index < 0 || index >= STUDIO_PHASES.length - 1 ? null : STUDIO_PHASES[index + 1].key
}

/** 项目内部步骤 key → 全局五步序号（0 起）。工作台与工作室共用同一份换算。 */
export function globalStepIndexForProjectStep(projectStepKey: string): number {
  const phase = STUDIO_PHASES.find((item) => item.projectStepKey === projectStepKey)
  if (phase) return phase.displayIndex - 1
  if (projectStepKey === 'script') return 0
  if (projectStepKey === 'extract_assets' || projectStepKey === 'image_prep') return 1
  return 0
}

/** 阶段 → 项目内部步骤 key（写 URL / 判定就绪时用）。 */
export function projectStepKeyForPhase(key: StudioPhaseKey): StudioPhaseMeta['projectStepKey'] {
  return getStudioPhase(key).projectStepKey
}

/**
 * 阶段链路（用于切换阶段时**不丢**当前镜头、并记住各阶段滚动位置）。
 *
 * 返回的是「阶段 key → 该阶段在容器内的挂载键」，页面据此给每个阶段一个稳定的
 * `key`，React 才不会在切阶段时把中栏整个卸载重建（那正是"切阶段丢滚动/丢未保存编辑"的成因）。
 */
export function studioPhaseMountKey(phase: StudioPhaseKey, shotId: string | null): string {
  return `studio:${phase}:${shotId ?? 'none'}`
}

/* ------------------------------------------------------------------ */
/* URL 读写（纯函数，可单测）                                          */
/* ------------------------------------------------------------------ */

export type StudioUrlState = {
  phase: StudioPhaseKey
  shotId: string | null
}

/** 从 `URLSearchParams` / query 串里读阶段与当前镜头。 */
export function readStudioUrlState(search: string | URLSearchParams | null | undefined): StudioUrlState {
  const params =
    search instanceof URLSearchParams
      ? search
      : new URLSearchParams(String(search ?? '').replace(/^\?/, ''))
  const shot = String(params.get(STUDIO_SHOT_PARAM) ?? '').trim()
  return {
    phase: resolveStudioPhaseFromParam(params.get(STUDIO_PHASE_PARAM)),
    shotId: shot || null,
  }
}

/**
 * 写「工作室 URL」：**只改 studio / shot 两个参数**，其余原样保留。
 *
 * 为什么不新建一套：项目、章节来自路由段；阶段与镜头来自这两个参数；
 * 三者合起来就是「刷新 / 复制链接 / 重新进入」需要恢复的全部业务状态。
 */
export function buildStudioSearch(
  current: string | URLSearchParams | null | undefined,
  next: Partial<StudioUrlState>,
): string {
  const params = new URLSearchParams(
    current instanceof URLSearchParams ? current.toString() : String(current ?? '').replace(/^\?/, ''),
  )
  if (next.phase) params.set(STUDIO_PHASE_PARAM, next.phase)
  if (next.shotId !== undefined) {
    const shot = String(next.shotId ?? '').trim()
    if (shot) params.set(STUDIO_SHOT_PARAM, shot)
    else params.delete(STUDIO_SHOT_PARAM)
  }
  return params.toString()
}

/**
 * 工作室深链（供工作台 / 任务中心 / 第 2 步下一步调用）。
 *
 * 任务中心的「返回对应镜头」就是靠这里的 `shot` 参数：带上镜头号，
 * 落地后直接选中该镜头，不是停在第一镜。
 */
export function buildStudioPath(args: {
  projectId: string
  chapterId: string
  phase?: StudioPhaseKey
  shotId?: string | null
}): string {
  const base = `/projects/${encodeURIComponent(args.projectId)}/chapters/${encodeURIComponent(args.chapterId)}/studio`
  const search = buildStudioSearch(null, {
    phase: args.phase ?? STUDIO_PHASES[0].key,
    shotId: args.shotId ?? null,
  })
  return search ? `${base}?${search}` : base
}

/**
 * 阶段条上「本阶段唯一主要操作」的文案。
 *
 * 硬口径（任务书第六部分）：**同屏只能有一个「流程下一步」主按钮**，
 * 多处需要展示下一步时**必须复用同一份 `continueLabel` / 禁用原因 / 点击逻辑**。
 * 这里只算「在工作室里往下走」的那个按钮，不参与第 2 步自己的批量生产操作。
 */
export const STUDIO_CONTINUE_ACTION: Record<StudioPhaseKey, string> = {
  video_prompt: '资产与声音检查',
  binding: '生成与交付',
  deliver: '预览成片',
}

export function buildStudioContinueLabel(phase: StudioPhaseKey): string {
  return `继续：${STUDIO_CONTINUE_ACTION[phase]}`
}
