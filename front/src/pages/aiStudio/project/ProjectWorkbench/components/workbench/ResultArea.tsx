/**
 * 结果区（`ResultArea`）—— 设计包 §7「结果区折叠规则」的落地件。
 *
 * 这是**唯一**放生成结果的地方：主区底部、固定操作区之上（sticky），可折叠。
 *
 * 为什么单独抽成一个组件（而不是继续散在 `AssetProductionArea` 里）：
 *   - 折叠行为有自己的一套状态机（`resultAreaState.ts`，含单测）；
 *   - 固定高度是硬约束：「结果面板不得长期挤压 1440×900 下的资产卡主工作区」（§7）。
 *     只有把高度写在**一个**地方，才能保证展开态也抢不走卡片网格的高度。
 *
 * 这一层**只负责呈现与折叠**：任务进度、结果卡片、采纳 / 定版 / 重新生成全部仍由
 * 既有出图机制（`AssetProductionArea`）提供，本组件不新建第二套提交或轮询。
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Tag, Tooltip } from 'antd'
import { DownOutlined, UpOutlined } from '@ant-design/icons'

import {
  RESULT_AREA_COLLAPSED_HEIGHT,
  RESULT_AREA_CONTENT_MAX_HEIGHT,
  RESULT_AREA_EXPANDED_HEIGHT,
  countNewResults,
  describeResultAreaCollapsedLine,
  emptyResultAreaSnapshot,
  initialResultAreaState,
  isEmptyResultAreaSnapshot,
  reduceResultArea,
  resultAreaRunningCount,
  type ResultAreaSnapshot,
} from './resultAreaState.ts'

export type ResultAreaProps = {
  /** 本轮结果摘要：数字来自真实任务状态，本组件不做任何估算 */
  snapshot: ResultAreaSnapshot
  /** 本次批量操作是否仍在进行（提交 / 轮询中） */
  busy: boolean
  /**
   * 新一轮信号：数值每变化一次，即视为用户发起了新一轮（提交生成 / 读取已有出图任务）。
   * 用它区分「用户主动开始一轮」与「任务自己更新了状态」——前者要清掉手动收起并展开。
   */
  roundSignal?: number
  /**
   * 只读入口：读取已有出图任务（不计费）。
   * 收起态也保留入口（设计包 §7 第 3 行），所以这里与结果内容分开收。
   */
  readEntry?: ReactNode
  /** 结果卡片等内容 */
  children?: ReactNode
  /** 吸附在主区底部（工作台内为 true）。 */
  sticky?: boolean
}

export function ResultArea(props: ResultAreaProps) {
  const { snapshot, busy, roundSignal = 0, readEntry, children, sticky = true } = props

  const [state, setState] = useState(() => initialResultAreaState(snapshot))

  /**
   * 任务数字 / 忙碌状态变化 → 交给状态机做自动展开判定。
   *
   * 依赖是 `snapshot`（调用方 useMemo 过，引用稳定）与 `busy`：
   * 状态机在无实质变化时返回同一个引用，所以 setState 会 bail out，不会无限重渲染
   * （这条约定有单测钉住，见 `resultAreaState.test.ts`）。
   */
  useEffect(() => {
    setState((prev) => reduceResultArea(prev, { type: 'sync' }, { snapshot, busy }))
  }, [snapshot, busy])

  /** 新一轮：清掉手动收起并展开。首帧不触发（那时还没有"新一轮"这回事）。 */
  useEffect(() => {
    if (roundSignal <= 0) return
    setState((prev) => reduceResultArea(prev, { type: 'round_started' }, { snapshot, busy }))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只跟 roundSignal 走，避免任务更新时重复展开
  }, [roundSignal])

  const unread = countNewResults(state.seenDone, snapshot)
  const running = resultAreaRunningCount(snapshot)
  const toggle = () => setState((prev) => reduceResultArea(prev, { type: 'user_toggle' }, { snapshot, busy }))

  const summaryLine = describeResultAreaCollapsedLine(snapshot, unread)

  return (
    <section
      data-testid="result-area"
      data-expanded={state.expanded ? 'true' : 'false'}
      aria-label="生成结果"
      className={`z-10 border-t border-slate-200 bg-white/95 backdrop-blur ${
        sticky ? 'sticky bottom-0' : ''
      }`}
      style={{ maxHeight: state.expanded ? RESULT_AREA_EXPANDED_HEIGHT : RESULT_AREA_COLLAPSED_HEIGHT }}
    >
      {/* 标题行：收起态就是那一行摘要；点标题随时收起 / 展开（设计包 §7 末行） */}
      <div
        className="flex items-center gap-2 px-1"
        style={{ height: RESULT_AREA_COLLAPSED_HEIGHT }}
      >
        <button
          type="button"
          onClick={toggle}
          aria-expanded={state.expanded}
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 text-left hover:bg-slate-50"
          title={state.expanded ? '收起结果区' : '展开结果区'}
        >
          <span className="shrink-0 text-sm font-medium text-slate-900">生成结果</span>
          <span className="min-w-0 truncate text-xs text-slate-600" data-testid="result-area-summary">
            {summaryLine}
          </span>
          {unread > 0 ? (
            <Tag color="blue" bordered={false} className="mr-0 shrink-0" data-testid="result-area-unread">
              {`${unread} 项新结果待处理`}
            </Tag>
          ) : null}
          {running > 0 ? (
            <Tag bordered={false} className="mr-0 shrink-0" data-testid="result-area-running">
              {`${running} 项还在生成`}
            </Tag>
          ) : null}
          <span className="ml-auto shrink-0 text-gray-400">
            {state.expanded ? <DownOutlined /> : <UpOutlined />}
          </span>
        </button>

        {/*
          收起态也保留「读取已有出图任务」入口：不展开面板就点得到，
          点一下展开并把只读表单露出来（设计包 §7 第 3 行）。
        */}
        {!state.expanded ? (
          <Button
            size="small"
            type="link"
            className="shrink-0 !px-1"
            onClick={toggle}
            data-testid="result-area-read-entry-collapsed"
          >
            读取已有出图任务
          </Button>
        ) : null}

        <Tooltip title="生成的图会先出现在这里：点「采纳」落到资产图片，点「设为定版」定下对外使用的那一张。">
          <span className="shrink-0 text-[11px] text-gray-400">采纳 / 定版都在这里</span>
        </Tooltip>
      </div>

      {/* 展开态内容：面板自身局部滚动，最高 172 —— 不改变卡片网格与固定操作区的位置 */}
      {state.expanded ? (
        <div
          className="overflow-y-auto border-t border-slate-100 px-1 pb-2 pt-1"
          style={{ maxHeight: RESULT_AREA_CONTENT_MAX_HEIGHT }}
          data-testid="result-area-content"
        >
          {/* 读取已有出图任务（只读、不计费）：唯一入口，收起态从上面那个链接进来 */}
          {readEntry ? (
            <div className="mb-2" data-testid="result-area-read-entry">
              {readEntry}
            </div>
          ) : null}

          {isEmptyResultAreaSnapshot(snapshot) && unread === 0 ? (
            <div className="px-1 py-3 text-xs text-gray-500">
              本轮还没有生成结果。在顶部选好资产后点「批量生成」；已经有出图结果的话，可以用上面的「读取已有出图任务」把它读回来（只读、不计费）。
            </div>
          ) : (
            children
          )}
        </div>
      ) : null}
    </section>
  )
}

export default ResultArea

/** 便捷构造：给还没有任务的场景一份空摘要（避免调用方手写零值对象）。 */
export function emptyResultAreaSnapshotForDisplay(): ResultAreaSnapshot {
  return emptyResultAreaSnapshot()
}
