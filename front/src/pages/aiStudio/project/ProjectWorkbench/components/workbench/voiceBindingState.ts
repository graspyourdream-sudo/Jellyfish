/**
 * 第 2 步「人物资产详情 · 角色声音」的纯逻辑与文案（`node --test` 可直接加载）。
 *
 * 设计包 §10 的口径（本模块是它在第 2 步的落点）：
 * **声音的唯一事实来源是人物资产** —— 选择 / 试听 / 保存 / 更换是全站唯一入口，
 * 这个人物出现的镜头自动继承它；更换后同步到已继承的全部镜头（更换需二次确认）。
 *
 * 为什么单独一个 `.ts` 而不是写在 `.tsx` 里：工作台主区的源码禁词扫描
 * （`workbenchState.test.ts`）连注释都不许出现内部标识词。所以"读后端契约字段名"
 * 这件事留在本层，渲染层只认下面这些业务字段（`voiceRef` / `voiceName` / `audioUrl`），
 * 内部编号也只在默认收起的「技术详情」里露一次。
 *
 * 本模块不 import React / antd，也不发请求：纯函数 + 文案，便于逐条断言。
 */

import type { AssetVoiceBindRequest } from '../../../../../../services/generated'

/** 「角色声音」区块的视图模型（字段名一律是业务说法）。 */
export type VoiceBindingView = {
  /** 这个人物现在有没有绑定角色声音 */
  bound: boolean
  /** 当前生效的音色名（未绑定时为空串） */
  voiceName: string
  /** 试听地址（可能是相对地址，由渲染层补成绝对地址） */
  audioUrl: string
  /** 文件编号：**只允许出现在默认收起的「技术详情」**（主区不出现） */
  voiceRef: string
  /** 资产类型的中文名（后端给，如「角色」） */
  assetLabel: string
}

/** 一条可选的音色（= 素材库里的一段音频）。 */
export type VoiceOption = {
  id: string
  name: string
  /** 试听地址 */
  audioUrl: string
}

/**
 * 绑定请求体的**唯一**构造处。
 *
 * 为什么要在这里构造：工作台渲染层的源码禁词扫描连注释都不许出现内部字段名，
 * 所以读/写契约字段名这件事一律留在本层，`.tsx` 只认业务字段。
 */
export function voiceBindRequest(option: VoiceOption): AssetVoiceBindRequest {
  return { file_id: option.id }
}

export const VOICE_SECTION_TITLE = '角色声音'
export const VOICE_SCOPE_HINT = '声音属于人物资产：这里选一次，这个人物出现的镜头都会继承它。'
export const VOICE_UNBOUND_MAIN = '还没有绑定角色声音'
export const VOICE_UNBOUND_HINT = '不绑定也能照常保存其它资料；绑定后这个人物在镜头里才有配音。'
export const VOICE_BOUND_PREFIX = '已绑定音色'
export const VOICE_SELECT_LABEL = '选择音色'
export const VOICE_REPLACE_LABEL = '更换'
export const VOICE_PREVIEW_LABEL = '试听'
export const VOICE_SAVE_LABEL = '保存'
export const VOICE_PICKER_TITLE = '选择音色'
export const VOICE_PICKER_EMPTY = '素材库里还没有音频文件：先在「文件」里上传一段配音，再回来选择音色。'
export const VOICE_PICKER_HINT = '音色就是项目里的一段音频素材；上传与整理在「文件」里完成。'
export const VOICE_LOAD_FAILED = '角色声音加载失败'
export const VOICE_OPTIONS_LOAD_FAILED = '音频素材加载失败'
export const VOICE_SAVE_FAILED = '角色声音保存失败'

const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wma', '.aiff', '.aif']

/** 只有**人物资产**才有「角色声音」区块（设计包 §10 的范围边界）。 */
export function voiceSectionAppliesTo(assetType: string): boolean {
  return String(assetType ?? '').trim().toLowerCase() === 'character'
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

/**
 * 把后端返回的资产声音翻成视图模型。
 *
 * 后端 `bound=false` 时其余字段都是空串，所以这里不编造名字：未绑定就显示未绑定。
 */
export function normalizeAssetVoice(raw: unknown): VoiceBindingView {
  const source = (raw ?? {}) as Record<string, unknown>
  const bound = source.bound === true
  return {
    bound,
    voiceName: bound ? toText(source.file_name) : '',
    audioUrl: bound ? toText(source.url) : '',
    voiceRef: bound ? toText(source.file_id) : '',
    assetLabel: toText(source.asset_label),
  }
}

/** 文件名看着是不是音频（后端按后缀/类型判定，前端只负责别把图片当音色）。 */
export function isAudioFileName(name: string): boolean {
  const lower = String(name ?? '').toLowerCase()
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** 素材库列表里的音频 → 可选音色（按关键字过滤；名字为空的用文件编号兜底，不显示空行）。 */
export function voiceOptionsFromFiles(files: readonly unknown[], keyword = ''): VoiceOption[] {
  const needle = String(keyword ?? '').trim().toLowerCase()
  return files
    .map((raw) => {
      const row = (raw ?? {}) as Record<string, unknown>
      return {
        id: toText(row.id),
        name: toText(row.name) || toText(row.id),
        audioUrl: toText(row.thumbnail),
        type: toText(row.type).toLowerCase(),
      }
    })
    .filter((row) => row.id !== '' && row.type === 'audio')
    .filter((row) => (needle ? row.name.toLowerCase().includes(needle) : true))
    .map(({ id, name, audioUrl }) => ({ id, name, audioUrl }))
}

/** 相对地址补成可播放的绝对地址（本机存储返回的是 `/files/...` 这类相对路径）。 */
export function toPlayableUrl(url: string, base: string): string {
  const raw = String(url ?? '').trim()
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  const prefix = String(base ?? '').replace(/\/+$/, '')
  return `${prefix}${raw.startsWith('/') ? '' : '/'}${raw}`
}

/**
 * 「更换」的二次确认文案。
 *
 * 为什么必须确认（设计包 §10）：更换会同步到该人物**已继承的全部镜头**，
 * 所以确认框要把影响范围说清（几个镜头会一起变），而不是只问一句"确定吗"。
 */
export function replaceVoiceConfirmText(
  assetName: string,
  currentName: string,
  nextName: string,
  inheritedShotCount: number,
): { title: string; content: string } {
  const name = String(assetName ?? '').trim() || '这个人物'
  const shots = Math.max(0, Math.trunc(inheritedShotCount))
  const scope = shots > 0 ? `${name}出现的 ${shots} 个镜头会一起换成新声音` : `${name}出现的镜头会一起换成新声音`
  const from = String(currentName ?? '').trim()
  return {
    title: `把${name}的角色声音换成「${String(nextName ?? '').trim()}」？`,
    content: `${scope}${from ? `（原来的「${from}」不再生效）` : ''}。更换后无需逐镜重选，已继承的镜头自动同步。`,
  }
}

/** 保存成功的提示（把"生效范围"说清，而不是只说"保存成功"）。 */
export function voiceSavedText(assetName: string, voiceName: string): string {
  const name = String(assetName ?? '').trim() || '这个人物'
  return `已把「${String(voiceName ?? '').trim()}」绑定给${name}；它出现的镜头会自动继承这段声音`
}

/** 「本镜无需声音」之类的历史遗留与本区块无关：这里只回答"这个人物有没有声音"。 */
export function voiceStatusSummary(view: VoiceBindingView | null): string {
  if (!view || !view.bound) return VOICE_UNBOUND_MAIN
  return `${VOICE_BOUND_PREFIX}：${view.voiceName || '（未命名）'}`
}
