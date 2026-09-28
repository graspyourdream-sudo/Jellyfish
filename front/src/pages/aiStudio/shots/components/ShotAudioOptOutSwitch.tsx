/**
 * 分镜准备页的「本镜无需声音」开关（Task 4：入口从已删除的旧绑定区搬到这里）。
 *
 * 它只做一件事：把**这一镜**的"无需声音"标记写进既有的镜头详情补丁口
 * （`shot_details.audio_opt_out`，后端语义一个字没改），并把与**角色声音继承**的关系
 * 写清楚（开启 = 本镜不继承；关闭 = 本镜照常继承）。
 *
 * 为什么它**不是**第二个声音编辑入口：
 *   - 这里没有音色列表、没有试听、没有选择与更换 —— 那些只在第 2 步「人物资产详情」里；
 *   - 它改的是**镜头自己的那一格标记**，人物资产上绑的音色一个字节都不会被改动；
 *   - 第 4 步「资产与声音检查」仍然是只读展示，本开关不改变那一步的任何行为。
 *
 * 错误出口走全仓统一的 message 包装层（`showUserError`）：主区只出中文结论，
 * 后端原文进默认收起的「技术详情」。
 */

import { Space, Switch, Typography, message } from 'antd'

import { showUserError } from '../../components/userFacingMessage'
import {
  SHOT_AUDIO_OPT_OUT_LABEL,
  SHOT_AUDIO_OPT_OUT_SAVE_FAILED,
  describeShotAudioOptOut,
  shotAudioOptOutSavedText,
} from './shotAudioOptOut.ts'

export type ShotAudioOptOutSwitchProps = {
  /** 当前是否已明确标记「本镜无需声音」（来自这条分镜的详情，没拿到就传 false） */
  marked: boolean
  /** 正在保存（防重复点击） */
  saving?: boolean
  /** 没有分镜 / 不能写的时候禁用，不给一个点了没反应的开关 */
  disabled?: boolean
  /**
   * 写入。失败时**抛错**：本组件负责走统一 message 包装层，页面不必另写一套提示。
   */
  onSave: (next: boolean) => Promise<void>
}

export function ShotAudioOptOutSwitch(props: ShotAudioOptOutSwitchProps) {
  const { marked, saving = false, disabled = false, onSave } = props
  const view = describeShotAudioOptOut(marked)

  const handleToggle = async (next: boolean) => {
    try {
      await onSave(next)
      message.success(shotAudioOptOutSavedText(next))
    } catch (error) {
      /* 失败提示统一由这里给：主区只出中文结论，后端原文进技术详情 */
      void showUserError(error, SHOT_AUDIO_OPT_OUT_SAVE_FAILED)
    }
  }

  return (
    <div className="space-y-2" data-testid="shot-audio-opt-out">
      <Space size={8} wrap>
        <Switch
          size="small"
          checked={view.checked}
          loading={saving}
          disabled={disabled || saving}
          checkedChildren="无需"
          unCheckedChildren="继承"
          aria-label={SHOT_AUDIO_OPT_OUT_LABEL}
          data-testid="shot-audio-opt-out-switch"
          onChange={(next) => void handleToggle(next)}
        />
        <span className="text-sm text-slate-800">{SHOT_AUDIO_OPT_OUT_LABEL}</span>
        <span
          className={view.checked ? 'text-xs text-amber-600' : 'text-xs text-slate-500'}
          data-testid="shot-audio-opt-out-status"
        >
          {view.statusText}
        </span>
      </Space>

      <Typography.Text type="secondary" className="block text-[11px]">
        {view.hint}
      </Typography.Text>
      <Typography.Text type="secondary" className="block text-[11px]">
        {view.markedNote}
      </Typography.Text>
      <Typography.Text type="secondary" className="block text-[11px]">
        {view.scopeNote}
      </Typography.Text>
    </div>
  )
}

export default ShotAudioOptOutSwitch
