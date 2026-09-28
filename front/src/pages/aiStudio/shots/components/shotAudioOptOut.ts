/**
 * 分镜准备页的「本镜无需声音」开关：口径与文案（纯逻辑，可单测）。
 *
 * 为什么这个开关在**分镜准备页**：
 * 角色声音的唯一事实来源是人物资产（第 2 步人物资产详情是全站唯一的选择 / 更换入口），
 * 镜头只做**继承**。而"这一镜用不用它"是**镜头自己的事** —— 属于分镜准备阶段的信息确认，
 * 所以它的开关放在这里；第 4 步「资产与声音检查」保持只读，不给第二套声音入口。
 *
 * 开关语义（两个方向都写清楚，不留含糊）：
 *   开启 = 这一镜**不继承**人物资产的角色声音（本镜按"无需声音"处理，
 *          也不会被当成漏绑声音）；
 *   关闭 = 这一镜照常继承人物资产的角色声音。
 *
 * 这个开关**不修改声音本身**：它写的是镜头级的那一个"无需声音"标记，
 * 落点是既有的镜头详情补丁口；人物资产上绑的是哪个音色，一个字都不会被这里改动。
 *
 * ⚠️ 本文件在 `shots/**` 的主区扫描面里（`shotsCopy.test.ts`）：用户可见文案不含
 * 内部字段名 / 原始状态值 / 地址 / 模型与供应方原名。
 */

/** 开关标题（用户语言，与既有的那个说法逐字一致）。 */
export const SHOT_AUDIO_OPT_OUT_LABEL = '本镜无需声音'

/** 开启态：一句话结论。 */
export const SHOT_AUDIO_OPT_OUT_MARKED = '已标记：本镜无需声音'
/** 关闭态：一句话结论（说明这一镜照常继承）。 */
export const SHOT_AUDIO_OPT_OUT_INHERITS = '这一镜照常继承人物资产的角色声音'

/**
 * 开关与**角色声音继承**的关系（这行是设计要求的"标注"，两个方向都写明）。
 */
export const SHOT_AUDIO_OPT_OUT_HINT =
  '开启后这一镜不继承人物资产的角色声音（本镜就按没有声音处理）；关闭时这一镜照常继承。'

/** 声音本身在哪儿改：明确写清这里不是第二个声音入口。 */
export const SHOT_AUDIO_OPT_OUT_SCOPE_NOTE =
  '角色声音本身仍然只在第 2 步「人物资产详情」里选择或更换；这里只决定这一镜用不用它，不会改到人物资产。'

/** 标记之后不会被算成漏绑（用户最关心的那一点）。 */
export const SHOT_AUDIO_OPT_OUT_NOT_MISSING_NOTE = '标记过的镜头不会被当成漏绑声音。'

export const SHOT_AUDIO_OPT_OUT_SAVED_ON = '已标记：本镜无需声音'
export const SHOT_AUDIO_OPT_OUT_SAVED_OFF = '已取消「无需声音」标记'
export const SHOT_AUDIO_OPT_OUT_SAVE_FAILED = '保存失败'

export type ShotAudioOptOutView = {
  /** 开关的勾选态（= 已标记"无需声音"） */
  checked: boolean
  /** 当前状态的一句话结论 */
  statusText: string
  /** 与继承关系的说明（两个方向都写明） */
  hint: string
  /** 声音本身在哪儿改（这里不是第二个声音入口） */
  scopeNote: string
  /** 标记后不算漏绑 */
  markedNote: string
}

/** 由"是否已标记"得出开关的展示模型（纯函数，页面只负责渲染）。 */
export function describeShotAudioOptOut(marked: boolean): ShotAudioOptOutView {
  return {
    checked: marked === true,
    statusText: marked === true ? SHOT_AUDIO_OPT_OUT_MARKED : SHOT_AUDIO_OPT_OUT_INHERITS,
    hint: SHOT_AUDIO_OPT_OUT_HINT,
    scopeNote: SHOT_AUDIO_OPT_OUT_SCOPE_NOTE,
    markedNote: SHOT_AUDIO_OPT_OUT_NOT_MISSING_NOTE,
  }
}

/**
 * 保存用的请求体（**唯一**定义处）。
 *
 * 只带这一个字段：镜头详情补丁是"只改传进来的字段"，所以这里不许夹带其它字段
 * （夹带了就等于顺手改了别的东西）。
 */
export function shotAudioOptOutPatch(next: boolean): { audio_opt_out: boolean } {
  return { audio_opt_out: next === true }
}

/** 保存成功后的提示文案。 */
export function shotAudioOptOutSavedText(next: boolean): string {
  return next === true ? SHOT_AUDIO_OPT_OUT_SAVED_ON : SHOT_AUDIO_OPT_OUT_SAVED_OFF
}
