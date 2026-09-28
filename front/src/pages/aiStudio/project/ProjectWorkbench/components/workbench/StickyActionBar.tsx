/**
 * 第 2 步资产工作台底部的**固定操作条**（设计包 §6 的 `StickyActionBar`）。
 *
 * 一屏只回答四件事，全部用契约里的真实数字说话：
 *
 *   ┌ 资产就绪：7 / 15  [▓▓▓░░░]  待补资料：2 项  生成失败：1 项  付费前会二次确认 ┐
 *   │                                              [待处理 3 项] [继续：资产准备]  │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *
 * 为什么单独一个组件：它是这一屏**唯一**固定不动的操作区，位置与高度都是硬约束
 * （56px；1440×900 下不许挡住结果区折叠面板的底部内容）。高度只写在一个地方，
 * 才能保证"展开结果区"不会把它顶掉。
 *
 * 数字的来源（**一个都不在这里算**，全部由调用方按既有唯一口径算好传进来）：
 *   - 就绪度 / 待补资料：`stickyActionBarState.resolveStickyActionBarCounts`
 *     （就绪判定复用 `assetPrepStatus`，与结果区同一份口径）；
 *   - 生成失败：本轮任务进度；
 *   - 待处理：待处理清单长度（文案复用 `workbenchState.describePendingReview`，
 *     与顶部批量区上那颗按钮同源同句）；
 *   - 步骤主按钮：文案 / 禁用理由 / 点击动作**全部**由外层页面给出的同一份判定提供，
 *     这里不拼第二套"下一步"口径。
 *
 * 本文件在 `workbench/**` 的主区禁词扫描面内（`workbenchState.test.ts`）：
 * 内部字段名、原始状态值这类排查用信息一律不出现，连注释也不出现。
 */

import { Button, Progress, Tooltip } from 'antd'
import { RightOutlined } from '@ant-design/icons'

import {
  FAILED_LABEL,
  NEEDS_PROFILE_LABEL,
  PAYMENT_CONFIRM_NOTE,
  READINESS_LABEL,
  STICKY_ACTION_BAR_HEIGHT,
  STICKY_ACTION_BAR_PROGRESS_WIDTH,
  describeActionBarPendingReview,
  describeCountValue,
  describeReadinessValue,
} from './stickyActionBarState.ts'
import type { StickyActionBarCounts } from './stickyActionBarState.ts'

export type StickyActionBarProps = {
  /** 四个数字（就绪 / 待补资料 / 失败 / 待处理），由调用方从真实数据源算好 */
  counts: StickyActionBarCounts
  /** 打开「待处理」抽屉（就是顶部那颗按钮打开的同一个抽屉） */
  onOpenPendingReview: () => void
  /**
   * 步骤主按钮文案。**必须**与外层步骤摘要、顶部主按钮用的是同一句话
   * （同一个 `continueLabel`），否则同屏会出现两个"下一步"。
   */
  continueLabel: string
  /** 非空 = 禁用主按钮，并在悬停时说明原因（与主按钮文案同源） */
  continueDisabledReason?: string
  /** 判定是否仍在进行（加载期间按钮转圈，不给结论） */
  continueLoading?: boolean
  onContinue: () => void
}

export function StickyActionBar(props: StickyActionBarProps) {
  const {
    counts,
    onOpenPendingReview,
    continueLabel,
    continueDisabledReason = '',
    continueLoading = false,
    onContinue,
  } = props

  const pendingLabel = describeActionBarPendingReview(counts.pendingReview)

  return (
    <div
      data-testid="sticky-action-bar"
      className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-200 bg-white px-3"
      style={{ height: STICKY_ACTION_BAR_HEIGHT }}
    >
      {/* 左：就绪度 + 两个计数 + 付费说明（说明文字不出可点动作，避免多出一个假入口） */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
        <span className="flex shrink-0 items-center gap-1">
          <span className="text-slate-500">{READINESS_LABEL}</span>
          <span className="font-medium text-slate-900" data-testid="sticky-action-bar-readiness">
            {describeReadinessValue(counts)}
          </span>
        </span>

        <Progress
          percent={counts.readyPercent}
          showInfo={false}
          size="small"
          className="!m-0 shrink-0"
          style={{ width: STICKY_ACTION_BAR_PROGRESS_WIDTH }}
          aria-label={`资产就绪 ${describeReadinessValue(counts)}`}
        />

        <span className="flex shrink-0 items-center gap-1">
          <span className="text-slate-500">{NEEDS_PROFILE_LABEL}</span>
          <span className="font-medium text-amber-600" data-testid="sticky-action-bar-needs-profile">
            {describeCountValue(counts.needsProfile)}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-1">
          <span className="text-slate-500">{FAILED_LABEL}</span>
          <span className="font-medium text-red-600" data-testid="sticky-action-bar-failed">
            {describeCountValue(counts.failed)}
          </span>
        </span>

        <span className="shrink-0 text-slate-400">{PAYMENT_CONFIRM_NOTE}</span>
      </div>

      {/* 右：待处理入口 + 步骤主按钮 */}
      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="small"
          disabled={counts.pendingReview === 0}
          onClick={onOpenPendingReview}
          data-testid="sticky-action-bar-pending-review"
        >
          {pendingLabel}
        </Button>

        <Tooltip title={continueDisabledReason}>
          <Button
            size="small"
            type="primary"
            icon={<RightOutlined />}
            loading={continueLoading}
            disabled={Boolean(continueDisabledReason)}
            onClick={onContinue}
            data-testid="sticky-action-bar-continue"
          >
            {continueLabel}
          </Button>
        </Tooltip>
      </div>
    </div>
  )
}

export default StickyActionBar
