/**
 * 「这条镜头绑定的声音到底会不会进供应商请求」的**页面口径**（纯函数，可单测）。
 *
 * 为什么单独抽出来：
 *
 * - 后端把结论放在了计划/预览响应的 `audio` 审计字段里
 *   （`included` / `file_id` / `url` / `excluded_reason` / `how_to_fix` / `state`）；
 * - 页面必须在**提交之前**就把"已绑定，但供应商无法访问"说清楚（不是等生成失败才说），
 *   而这套文案要能脱离 React 单测 —— 所以判定与文案都放在这里，组件只负责渲染。
 *
 * 术语口径（不许夸大，与后端 `REFERENCE_AUDIO_TERMS_NOTE` 一致）：
 *
 * - **参考音频**：作为**输入**进入供应商请求（`audio_urls`）。本轮只验证到**请求计划层**
 *   —— "会被带进请求"有证据，"供应商据此影响生成结果"**没有证据**，页面不能说成已支持；
 * - **最终成片的音轨**：成片里那条轨，来自供应商侧 `generate_audio`（模型自己生成）；
 *   把已生成的音频混流/回贴成成片音轨是**另一条路径**，当前未实现。
 */

/** 后端计划响应里的参考音频审计（字段与 `VideoAudioPlanRead` 对齐，全部可选以兼容旧响应）。 */
export type AudioAudit = {
  included?: boolean
  file_id?: string
  url?: string
  declared_url?: string
  excluded_reason?: string
  reason_code?: string
  how_to_fix?: string
  state?: string
  vendor_supports_reference_audio?: boolean
  note?: string
}

export type AudioAdmissionTone = 'success' | 'warning' | 'info' | 'default'

export type AudioAdmissionView = {
  /** 状态短标签（绑定区/计划面板共用同一份文案） */
  tag: string
  tone: AudioAdmissionTone
  /** 一句话结论（绑定区的 Alert 标题） */
  title: string
  /** 原因 / 说明（可为空） */
  detail: string
  /** 补救办法（可为空） */
  fix: string
  /** 是否要在绑定区显示"已绑定但用不上"的警示（= 绑了但本次请求不携带） */
  blocked: boolean
  /** 术语澄清：参考音频（输入）≠ 最终成片音轨（输出） */
  terminology: string
}

/** 已携带时也要说清边界：只有"会进请求"这一件事被验证过。 */
export const REFERENCE_AUDIO_SCOPE_NOTE =
  '参考音频会送进供应商请求（本轮仅在**请求计划层**验证它会被带进请求）；'
  + '供应商是否据此影响生成结果，尚未有真实证据。'

export const REFERENCE_AUDIO_VS_FINAL_TRACK =
  '「参考音频」是**输入**；「最终成片的音轨」来自供应商侧 generate_audio（模型自己生成），'
  + '把已生成的音频混流/回贴成成片音轨是另一条路径，当前未实现。'

/** 后端原因码 → 给用户看的短标签（后端没给码时退回状态文案）。 */
const REASON_TAGS: Record<string, string> = {
  not_bound: '声音未绑定',
  opt_out: '本镜明确无需声音',
  file_missing: '已绑定，但素材库里查不到这个音频',
  vendor_unsupported: '已绑定，但当前模型不接受参考音频',
  no_address: '已绑定，但解析不出可公网访问的地址',
  local_path: '已绑定，但地址是本地/相对路径',
  private_address: '已绑定，但地址指向本机/内网',
  data_url_rejected: '已绑定，但供应商不接受内嵌音频',
}

const INCLUDED_TAGS: Record<string, string> = {
  public_url: '声音已绑定（公网地址，本次请求会携带）',
  asset_ref: '声音已绑定（asset:// 素材，本次请求会携带）',
  data_url_inline: '声音已绑定（内嵌音频，本次请求会携带）',
}

function text(value: unknown): string {
  return String(value ?? '').trim()
}

/**
 * 把后端审计翻译成页面文案。
 *
 * 判定顺序（与后端一致，页面不自己造规则）：
 * 1. 没有审计 / 没有绑定 → 「声音未绑定」；
 * 2. `state === 'opt_out'` → 「本镜明确无需声音」（是表态，不算漏绑）；
 * 3. `included === true` → 会携带，但**只说"会进请求"**，不说"会影响生成"；
 * 4. 绑了但没携带 → **「已绑定，但供应商无法访问」** + 真实原因 + 修法。
 */
export function describeAudioAdmission(audit: AudioAudit | null | undefined): AudioAdmissionView {
  const terminology = REFERENCE_AUDIO_VS_FINAL_TRACK
  if (!audit) {
    return {
      tag: '声音状态未知（尚未取到生成计划）',
      tone: 'default',
      title: '还没有读到这次的音频结论',
      detail: '页面会在计划加载完成后自动显示"这条声音会不会进本次生成请求"。',
      fix: '',
      blocked: false,
      terminology,
    }
  }

  const state = text(audit.state)
  const reasonCode = text(audit.reason_code)
  const fileId = text(audit.file_id)

  if (state === 'opt_out') {
    return {
      tag: REASON_TAGS.opt_out,
      tone: 'default',
      title: '本镜已明确标记：无需声音',
      detail: text(audit.excluded_reason),
      fix: '',
      blocked: false,
      terminology,
    }
  }

  if (!fileId && audit.included !== true) {
    return {
      tag: REASON_TAGS.not_bound,
      tone: 'default',
      title: '这条分镜还没有绑定声音',
      detail: text(audit.excluded_reason) || '未绑定：本次生成请求不携带参考音频。',
      fix: text(audit.how_to_fix),
      blocked: false,
      terminology,
    }
  }

  if (audit.included === true) {
    const url = text(audit.url) || text(audit.declared_url)
    return {
      tag: INCLUDED_TAGS[state] || '声音已绑定（本次请求会携带）',
      tone: 'success',
      title: '已绑定，且会作为参考音频进入本次请求',
      detail: url ? `本次请求携带的地址：${url}` : '',
      fix: REFERENCE_AUDIO_SCOPE_NOTE,
      blocked: false,
      terminology,
    }
  }

  // 绑了却没携带：这次请求用不上它 —— 必须在**提交之前**说清楚
  return {
    tag: REASON_TAGS[reasonCode] || '已绑定，但本次请求不携带它',
    tone: 'warning',
    title: '已绑定，但供应商无法访问',
    detail: text(audit.excluded_reason) || '供应商取不到这条声音，本次生成请求不会携带它。',
    fix: text(audit.how_to_fix),
    blocked: true,
    terminology,
  }
}

/** 计划面板用的短标签（没有审计时退回既有的 `audio_state` 文案）。 */
export function audioStateTag(
  audit: AudioAudit | null | undefined,
  legacyState?: string | null,
): string {
  if (audit) return describeAudioAdmission(audit).tag
  const state = text(legacyState)
  if (state === 'bound') return '声音已绑定（公网可用）'
  if (state === 'bound_not_public') return '已绑定，但供应商无法访问'
  if (state === 'opt_out') return REASON_TAGS.opt_out
  if (state === 'missing') return REASON_TAGS.not_bound
  return '声音状态未知'
}
