/**
 * 结果区（`ResultArea`）的折叠状态机与摘要文案 —— **纯逻辑**，不依赖 React。
 *
 * 为什么单独成文件：折叠行为有一堆边界（无任务 / 提交新一轮 / 正在生成 / 出现新结果 /
 * 用户手动收起），这些全都要有单测钉住；混在组件里就只能靠肉眼回归。
 *
 * 设计包口径（`jellyfish-opendesign-final/HANDOFF.md` §7「结果区折叠规则」）：
 *   | 状态                    | 面板行为                                        | 收起后保留                     |
 *   | 无任务、无未读结果      | 默认收起：只剩一行「生成结果 + 数量 + 状态摘要」 | 本轮数量                       |
 *   | 提交生成 / 正在生成     | 自动展开并显示任务进度                          | 进度落在结果卡片与底部就绪度   |
 *   | 读取已有出图结果        | 自动展开（收起态也保留「读取已有出图任务」入口） | 读取为只读查询，不计费         |
 *   | 出现新结果              | 自动展开，并标「N 项新结果待处理」              | 未读数量与状态                 |
 *   | 用户收起                | 随时可收起，点标题再展开                        | 本轮数量 + 已完成/生成中/失败  |
 *
 * 与设计表的一处**明确取舍**（写在代码里，避免以后被当成 bug）：
 *   「用户收起」与「出现新结果自动展开」会打架 —— 一边说随时可收起、一边说出现新结果要自动展开。
 *   这里按「手动意图优先」处理：用户手动收起之后，后续新结果**不再**强行把面板弹开
 *   （否则用户正在挑卡片时面板会一直自己弹起来），而是在收起态那一行上标出
 *   「N 项新结果待处理」，由用户自己点开。**新一轮**（提交生成 / 读取已有结果）是用户的
 *   明确动作，会清掉手动收起标记并直接展开。
 *
 * 未读口径：完成条数相对「用户上次确认过的条数」的增量。用户在**展开态**下收起面板视为已确认
 * （收起动作本身就说明他看过了）；这样收起后不会永远挂着一条清不掉的未读。
 */

import type { TaskProgressSummary } from '../assetProduction.ts'

/** 收起态高度（设计包：约 38）。 */
export const RESULT_AREA_COLLAPSED_HEIGHT = 38
/** 展开态整块高度（设计包：约 210）。 */
export const RESULT_AREA_EXPANDED_HEIGHT = 210
/**
 * 展开态内容区最高高度（设计包：内容区最高 172）。
 *
 * 数量来源：210 - 标题行（约 30）- 上下内边距（约 8）。内容超出时**面板自己局部滚动**，
 * 从而「不改变卡片网格与固定操作区的位置」（设计包 §7 的硬约束）。
 */
export const RESULT_AREA_CONTENT_MAX_HEIGHT = 172

/** 结果区只在用户语言里出现的三个数字标签（不含内部状态值）。 */
const DONE_LABEL = '已完成'
const RUNNING_LABEL = '生成中'
const FAILED_LABEL = '失败'

/**
 * 结果区摘要：只保留用户看得懂、且收起态那一行要用的数字。
 *
 * 刻意**不含** task_id / file_id / 原始 status 这些内部维度 —— 那些属于默认收起的技术详情。
 */
export type ResultAreaSnapshot = {
  /** 本轮一共多少项结果 */
  total: number
  /** 已完成（真正出图成功） */
  done: number
  /** 正在生成 / 正在提交 */
  running: number
  /** 生成失败 */
  failed: number
  /** 已停止（用户点了「停止后续」） */
  stopped: number
  /** 演练占位（演练模式下返回的占位结果） */
  dryRun: number
}

/** 折叠状态机的输入。`busy` = 本次批量操作仍在进行（提交/轮询中）。 */
export type ResultAreaContext = {
  snapshot: ResultAreaSnapshot
  busy: boolean
}

/** 状态机的输入事件。 */
export type ResultAreaEvent =
  /** 用户点了「批量生成 / 重新生成 / 读取已有出图任务」：新一轮 */
  | { type: 'round_started' }
  /** 用户点了面板标题：收起 / 展开 */
  | { type: 'user_toggle' }
  /** 任务状态更新或页面挂载：只做自动展开判定，不改变用户意图 */
  | { type: 'sync' }

export type ResultAreaState = {
  expanded: boolean
  /** 用户在本轮手动收起过：抑制「出现新结果自动展开」，但不抑制「新一轮」 */
  userCollapsed: boolean
  /** 用户上次确认过的已完成条数（未读 = done - seenDone），仅在用户收起时推进 */
  seenDone: number
}

/** 进度汇总 → 结果区摘要。数字**只做搬运**，不估算、不编造。 */
export function snapshotFromProgress(summary: TaskProgressSummary): ResultAreaSnapshot {
  return {
    total: summary.total,
    done: summary.done,
    // 顶部条与结果区共用同一份进度：这里把「生成中」与「待提交」都算作"还在跑"，
    // 因为两者都还没结果可看，且都应当把面板弹开（设计包 §7 第 2 行）。
    running: summary.generating + summary.queued,
    failed: summary.failed,
    stopped: summary.stopped,
    dryRun: summary.dryRun,
  }
}

/** 空摘要：没有任何任务。 */
export function emptyResultAreaSnapshot(): ResultAreaSnapshot {
  return { total: 0, done: 0, running: 0, failed: 0, stopped: 0, dryRun: 0 }
}

/** 本轮是不是一条结果都没有。 */
export function isEmptyResultAreaSnapshot(snapshot: ResultAreaSnapshot): boolean {
  return snapshot.total <= 0
}

/** 还没有到终态、仍在推进的条数（待提交 + 生成中）。 */
export function resultAreaRunningCount(snapshot: ResultAreaSnapshot): number {
  return Math.max(0, snapshot.running)
}

/** 未读 = 完成条数相对上次确认的增量（永不为负）。 */
export function countNewResults(seenDone: number, snapshot: ResultAreaSnapshot): number {
  return Math.max(0, snapshot.done - Math.max(0, seenDone))
}

/**
 * 收起态那一行：本轮数量 + 已完成 / 生成中 / 失败 + 未读标记。
 *
 * 三个数字**恒定出现**（不因为为 0 就隐藏）：收起态是用户扫一眼的地方，
 * 数字位置固定才好对比；只在有失败时用文字说清"这几项可以重试"。
 */
export function describeResultAreaCollapsedLine(
  snapshot: ResultAreaSnapshot,
  unread: number,
): string {
  if (isEmptyResultAreaSnapshot(snapshot)) return '生成结果 · 本轮还没有任务'
  const parts = [
    `本轮 ${snapshot.total} 项`,
    `${DONE_LABEL} ${snapshot.done}`,
    `${RUNNING_LABEL} ${resultAreaRunningCount(snapshot)}`,
    `${FAILED_LABEL} ${snapshot.failed}`,
  ]
  if (snapshot.stopped > 0) parts.push(`已停止 ${snapshot.stopped}`)
  const head = `生成结果 · ${parts.join(' · ')}`
  return unread > 0 ? `${head} · ${unread} 项新结果待处理` : head
}

/**
 * 页面挂载时的初值。
 *
 * 设计包 §7 末行：「原型默认展示收起态；实现时若进入页面已存在进行中任务或未读结果，应直接展开」。
 * 刷新后本地只读恢复（D5）回来的那一轮就属于"已存在的结果" —— 所以只要有任务就展开，
 * 并把它计成未读（seenDone = 0），用户看完收起时才算确认。
 */
export function initialResultAreaState(snapshot: ResultAreaSnapshot): ResultAreaState {
  if (isEmptyResultAreaSnapshot(snapshot)) {
    return { expanded: false, userCollapsed: false, seenDone: 0 }
  }
  return { expanded: true, userCollapsed: false, seenDone: 0 }
}

/**
 * 只在字段真的变了的时候才换新对象。
 *
 * 为什么必须这样：组件里用 `useEffect` 把每次渲染的新摘要喂给状态机（`sync`），
 * 如果无脑 `{...state, expanded: true}`，每轮都会产生一个新对象 → setState 不会 bail out
 * → 无限重渲染。保持引用相等是这套写法成立的前提，并有单测钉住。
 */
function applyIfChanged(state: ResultAreaState, next: ResultAreaState): ResultAreaState {
  if (
    state.expanded === next.expanded &&
    state.userCollapsed === next.userCollapsed &&
    state.seenDone === next.seenDone
  ) {
    return state
  }
  return next
}

/**
 * 状态机。纯函数：同样的 (state, event, ctx) 一定得到同样的结果。
 *
 * **引用稳定约定**：状态没有实质变化时返回**同一个** state 引用（见 `applyIfChanged`）。
 */
export function reduceResultArea(
  state: ResultAreaState,
  event: ResultAreaEvent,
  ctx: ResultAreaContext,
): ResultAreaState {
  const { snapshot, busy } = ctx

  // 1) 用户点标题：收起 / 展开。收起 = 确认已看过（推进 seenDone，未读随之清零）。
  if (event.type === 'user_toggle') {
    if (state.expanded) {
      return applyIfChanged(state, { expanded: false, userCollapsed: true, seenDone: snapshot.done })
    }
    // 展开时**不**推进 seenDone：这样"N 项新结果待处理"会一直挂在标题上，
    // 直到用户下一次收起（= 明确表示看完了）。
    return applyIfChanged(state, { expanded: true, userCollapsed: false, seenDone: state.seenDone })
  }

  // 2) 新一轮（提交生成 / 读取已有出图任务）：这是用户的明确动作，清掉手动收起并展开。
  if (event.type === 'round_started') {
    return applyIfChanged(state, { expanded: true, userCollapsed: false, seenDone: snapshot.done })
  }

  // 3) 任务更新 / 挂载
  if (isEmptyResultAreaSnapshot(snapshot)) {
    // 没有任务：默认收起。用户之前的手动收起标记也一并清掉（没有可收起的内容了）。
    return applyIfChanged(state, { expanded: false, userCollapsed: false, seenDone: 0 })
  }
  if (state.userCollapsed) {
    // 手动意图优先：保持收起，未读继续累计，由收起态那一行标出来。
    return state
  }
  if (busy || resultAreaRunningCount(snapshot) > 0) {
    return applyIfChanged(state, { expanded: true, userCollapsed: false, seenDone: state.seenDone })
  }
  if (!state.expanded && countNewResults(state.seenDone, snapshot) > 0) {
    return applyIfChanged(state, { expanded: true, userCollapsed: false, seenDone: state.seenDone })
  }
  return state
}
