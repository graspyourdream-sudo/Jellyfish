/**
 * 第 4 步「资产与声音检查」里**角色声音**那一行的只读口径（设计包 §10）。
 *
 * 用户口径（逐字）：第 4 步人工操作为 **无（只读）** —— 显示继承结果与来源，缺项给
 * 「返回人物资产补充」，**不在第 4 步提供第二套选择或更换入口**。
 * 所以本模块只做一件事：把后端给的只读结论翻成主区能显示的中文，并算出"要不要提示去补充"。
 *
 * 为什么单独一个 `.ts`：文案与判定要能被 `node --test` 逐条断言（含禁词口径），
 * 渲染层只负责摆放，不做判断。
 */

/** 后端只读结论的原值（机器可读；本文件是它们在前端的唯一映射处）。 */
export const SHOT_VOICE_STATE_INHERITED = 'inherited'
export const SHOT_VOICE_STATE_AMBIGUOUS = 'ambiguous'
export const SHOT_VOICE_STATE_LEGACY_SNAPSHOT = 'legacy_snapshot'
export const SHOT_VOICE_STATE_OPT_OUT = 'opt_out'
export const SHOT_VOICE_STATE_MISSING = 'missing'

export const SHOT_VOICE_SECTION_TITLE = '角色声音'
export const SHOT_VOICE_READONLY_NOTE = '声音只在第 2 步人物资产里选择或更换；这里只读展示继承结果。'
export const SHOT_VOICE_COMPLETE_ACTION = '返回人物资产补充'
export const SHOT_VOICE_PREVIEW_LABEL = '试听'

const MISSING_HEADLINE = '声音缺项：还没有绑定角色声音'

/** 一行的只读展示模型。 */
export type ShotVoiceCheckView = {
  /** 主结论（一句话，中文） */
  headline: string
  /** 音色名（有继承来的声音时非空） */
  voiceName: string
  /** 试听地址（可能是相对地址） */
  audioUrl: string
  /** 继承来源的人物资产名（有继承声音时非空） */
  sourceName: string
  /** 声音是不是缺项（页面据此标红 / 提示补充） */
  missing: boolean
  /** 要不要提示「返回人物资产补充」 */
  needsAssetCompletion: boolean
  /** 补充说明（一行中文，解释为什么 / 怎么办） */
  detail: string
  /** 多个角色都绑了声音时的角色名（**不替用户挑**，如实列出来） */
  multiVoicedNames: string[]
  /** 内部标识：**只允许出现在默认收起的「技术详情」里** */
  refs: { voiceRef: string; sourceRef: string; snapshotRef: string }
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function toCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

/**
 * 把后端只读结论翻成展示模型。
 *
 * 未知原值一律走「缺项」兜底（绝不把原值回显到主区，也不假装"已绑定"）。
 */
export function describeShotVoiceInheritance(raw: unknown): ShotVoiceCheckView {
  const source = (raw ?? {}) as Record<string, unknown>
  const state = toText(source.state)
  const voiceName = toText(source.file_name)
  const audioUrl = toText(source.url)
  const sourceName = toText(source.source_asset_name)
  const characterCount = toCount(source.character_count)
  const voiceCount = toCount(source.voice_asset_count)
  const legacyName = toText(source.legacy_file_name)
  const candidates = Array.isArray(source.candidates)
    ? source.candidates.map((item) => toText(item)).filter((item) => item !== '')
    : []

  const refs = {
    voiceRef: toText(source.file_id),
    sourceRef: toText(source.source_asset_id),
    snapshotRef: toText(source.legacy_file_id),
  }

  if (state === SHOT_VOICE_STATE_INHERITED) {
    return {
      headline: `${voiceName || '已绑定音色'} · 继承自人物资产`,
      voiceName,
      audioUrl,
      sourceName,
      missing: false,
      needsAssetCompletion: false,
      detail: `这段声音来自人物资产「${sourceName || '未命名'}」；这个人物出现的镜头都会用它。`,
      multiVoicedNames: [],
      refs,
    }
  }

  if (state === SHOT_VOICE_STATE_AMBIGUOUS) {
    return {
      headline: '这一镜有多个角色都绑了声音，系统不替你挑',
      voiceName: '',
      audioUrl: '',
      sourceName: '',
      missing: false,
      needsAssetCompletion: true,
      detail: `${candidates.join('、')} 都有各自的角色声音 —— 多人物镜头里挑一个声音配错人比没有更糟，请先确认本镜该用哪一个人的声音。`,
      multiVoicedNames: candidates,
      refs,
    }
  }

  if (state === SHOT_VOICE_STATE_OPT_OUT) {
    return {
      headline: '本镜已标记无需声音',
      voiceName: voiceCount === 1 ? voiceName : '',
      audioUrl: '',
      sourceName,
      missing: false,
      needsAssetCompletion: false,
      detail:
        voiceCount > 0
          ? `这个人物已经绑了角色声音「${voiceName}」，但本镜被标记为无需声音；要改声音请去人物资产。`
          : '这是分镜准备阶段做的标记，本步骤只读。',
      multiVoicedNames: [],
      refs,
    }
  }

  if (state === SHOT_VOICE_STATE_LEGACY_SNAPSHOT) {
    return {
      headline: MISSING_HEADLINE,
      voiceName: '',
      audioUrl: '',
      sourceName: '',
      missing: true,
      needsAssetCompletion: true,
      detail: `这一镜还留着一段更早保存的声音「${legacyName || '未命名'}」，它只是历史记录、已不再用于逐镜编辑；请到人物资产里给这个人物绑定角色声音。`,
      multiVoicedNames: [],
      refs,
    }
  }

  // missing（含未知原值兜底）
  const why =
    characterCount > 0
      ? `这一镜关联的 ${characterCount} 个人物资产还没有绑定角色声音。`
      : '这一镜还没有关联人物资产。'
  return {
    headline: MISSING_HEADLINE,
    voiceName: '',
    audioUrl: '',
    sourceName: '',
    missing: true,
    needsAssetCompletion: true,
    detail: `${why}请回到第 2 步「资产准备」，在人物资产详情里选择音色。`,
    multiVoicedNames: [],
    refs,
  }
}

/** 「返回人物资产补充」的落地地址：项目工作台第 2 步的人物页签 + 当前章节。 */
export function assetCompletionPath(projectId: string, chapterId: string): string {
  const project = toText(projectId).trim()
  const chapter = toText(chapterId).trim()
  if (!project) return ''
  const params = new URLSearchParams({ step: 'extract_assets', tab: 'roles' })
  if (chapter) params.set('chapter', chapter)
  return `/projects/${project}?${params.toString()}`
}
