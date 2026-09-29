/**
 * 任务中心的**未读逻辑**（纯函数 + 版本化的本机持久化）。
 *
 * ## 改前是什么样
 *
 * 红色角标用的是 `tasks.length` —— **全部任务数**，不是未读数。于是它会在
 * 「用户根本没看过的新结果」和「早就处理过的旧任务」之间说谎：
 * 任务越积越多，角标永远是一个与"新"无关的数字；用户点开面板它也**不会**清零。
 *
 * ## 本轮的最终口径（任务书 §6.1）
 *
 * | 概念 | 定义 |
 * |---|---|
 * | 已结束 | `succeeded` / `failed` / `cancelled` 三种 |
 * | **红色角标** | **未读的已结束任务结果**数量 —— 只认这一项 |
 * | 活跃任务 | `pending` / `running` / `streaming`；**不计入**红色角标，另用中性/蓝色文案（「运行中 2」） |
 *
 * ## 为什么不能"每次都拿当前列表算未读"
 *
 * 任务列表接口是按**时间窗**取的（当前窗口只有十几秒）。一个任务结束 1 分钟后再刷新，
 * 它就不在返回结果里了 —— 如果未读数按"当前列表里的已结束任务"现算，
 * 角标会在刷新后**自己变回 0**，用户明明还没看过。所以未读必须是
 * **累计并持久化的**：每轮轮询把"新出现的已结束任务"记进未读集合，
 * 用户真正看过之后才移出去。
 *
 * ## 已读键的形态（任务书 §6.2 明确要求）
 *
 * ```
 * `${taskId}:${status}:${finishedAtTs ?? updatedAtTs}`
 * ```
 *
 * 三段缺一不可：
 *   - `taskId`：哪一条任务；
 *   - `status`：**最终状态**（完成 / 失败 / 取消是三种不同的结果）；
 *   - `finishedAtTs`（拿不到时退回 `updatedAtTs`）：**最终完成时间**。
 *
 * 为什么带时间和状态：同一个任务可以「重试」——重试后它会有新的结束时间（可能还有
 * 新的最终状态）。如果已读键只有 `taskId`，新的那一轮结果会被旧已读记录**误吞**，
 * 红色角标永远不亮。带上这两段之后，新一轮必然是一个新键，必然重新变成未读。
 *
 * ## 首次启用兼容（任务书 §6.2）
 *
 * **绝不能**把数据库里已有的历史结束任务一次性变成未读洪水。做法是：
 * 第一次成功拿到任务列表时，把当时已经是结束状态的任务**全部记为已读**（基线），
 * 之后才出现的新结束任务才算未读。基线只在第一次成功轮询时落一次
 * （`baselineApplied` 写进持久化状态），失败的那次不算 —— 否则网络抖一下就会
 * 把历史任务全变成未读。
 *
 * ## 持久化位置：本机（当前设备）
 *
 * 仓库里没有稳定账号体系（后端没有 users 表、任务接口不按用户区分），
 * 所以**不发明账号模型或消息系统**：已读状态存在本机 `localStorage`，并显式注明
 * 这是「**当前设备的已读状态**」——换一台设备会重新按基线处理，这是这类最小实现的
 * 已知代价，不是 bug。状态带版本号，并为两个键集合各设上限（超限丢最旧的），
 * 避免长期使用后无限膨胀。
 */

/** 已结束（终态）的三种状态。 */
export const TERMINAL_TASK_STATUSES: readonly string[] = ['succeeded', 'failed', 'cancelled']

/** 活跃（未结束）的三种状态。它们**永不**进入红色角标。 */
export const ACTIVE_TASK_STATUSES: readonly string[] = ['pending', 'running', 'streaming']

/** 本机存储键（带版本：将来改口径时可以并存，不会读到旧结构）。 */
export const TASK_READ_STORAGE_KEY = 'jellyfish_task_read_state_v1'

/** 持久化结构版本号。读到不认识的结构一律按「首次启用」处理。 */
export const TASK_READ_STATE_VERSION = 'task-read-v1'

/**
 * 两个键集合各自的**规模上限**。
 *
 * 为什么必须限制：这是长期存在的本机存储，不设上限会在几个月后变成几百 KB 的
 * 无意义字符串，而且每次写都要整串序列化。超限时丢**最旧**的（按记录顺序），
 * 丢掉一条历史已读键的代价极小（最坏情况是该任务重新显示为未读一次）。
 */
export const TASK_READ_MAX_KEYS = 500

export type TaskReadState = {
  version: string
  /** 是否已经落过「首次启用基线」 */
  baselineApplied: boolean
  /** 已读键（任务 + 最终状态 + 最终完成时间） */
  readKeys: string[]
  /** 已结束但还没被用户看过的键（**红色角标的唯一来源**） */
  unreadKeys: string[]
}

/** 构造未读逻辑需要的任务字段（结构化类型，测试里可以只给这几个字段）。 */
export type TaskReadInput = {
  task_id: string
  status: string
  finished_at_ts?: number | null
  updated_at_ts?: number | null
}

export function isTerminalTaskStatus(status: string | null | undefined): boolean {
  return TERMINAL_TASK_STATUSES.includes(String(status ?? ''))
}

export function isActiveTaskStatus(status: string | null | undefined): boolean {
  return ACTIVE_TASK_STATUSES.includes(String(status ?? ''))
}

/**
 * 已读键：任务 + 最终状态 + 最终完成时间（拿不到完成时间时退回最后更新时间）。
 *
 * 非终态任务没有键（`null`）—— 它不进红色角标，也不该在已读集合里占位。
 */
export function taskReadKey(task: TaskReadInput): string | null {
  const status = String(task?.status ?? '')
  if (!isTerminalTaskStatus(status)) return null
  const taskId = String(task?.task_id ?? '').trim()
  if (!taskId) return null
  const finished = task.finished_at_ts
  const updated = task.updated_at_ts
  const stamp = typeof finished === 'number' && Number.isFinite(finished)
    ? finished
    : typeof updated === 'number' && Number.isFinite(updated)
      ? updated
      : 0
  return `${taskId}:${status}:${stamp}`
}

/** 新建一份「什么都没读过」的状态（首次启用前）。 */
export function emptyTaskReadState(): TaskReadState {
  return {
    version: TASK_READ_STATE_VERSION,
    baselineApplied: false,
    readKeys: [],
    unreadKeys: [],
  }
}

/** 去重 + 保持插入顺序 + 截断到上限（丢最旧的）。 */
function normalizeKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  keys.forEach((key) => {
    const value = String(key ?? '')
    if (!value || seen.has(value)) return
    seen.add(value)
    out.push(value)
  })
  return out.length > TASK_READ_MAX_KEYS ? out.slice(out.length - TASK_READ_MAX_KEYS) : out
}

/**
 * 每轮成功轮询后调用：把「新出现的已结束任务」记进未读集合。
 *
 * `applyBaseline` 为 true 表示**这一次就是首次成功轮询** —— 此时列表里的结束任务
 * 全部算历史（记为已读基线），不算未读。
 *
 * 返回**新对象**（不改入参），方便在 zustand 里直接替换状态。
 */
export function syncTaskReadState(
  state: TaskReadState,
  tasks: readonly TaskReadInput[],
  options: { applyBaseline?: boolean } = {},
): TaskReadState {
  const read = new Set(state.readKeys)
  const unread = new Set(state.unreadKeys)
  let baselineApplied = state.baselineApplied

  if (!baselineApplied && options.applyBaseline === true) {
    /* 首次启用：把当下所有结束状态的任务记为已读 —— 这一条就是防「历史未读洪水」。 */
    tasks.forEach((task) => {
      const key = taskReadKey(task)
      if (key) read.add(key)
    })
    baselineApplied = true
    return {
      version: TASK_READ_STATE_VERSION,
      baselineApplied,
      readKeys: normalizeKeys(Array.from(read)),
      unreadKeys: normalizeKeys(Array.from(unread)),
    }
  }

  tasks.forEach((task) => {
    const key = taskReadKey(task)
    if (!key) return
    if (read.has(key)) return
    unread.add(key)
  })

  return {
    version: TASK_READ_STATE_VERSION,
    baselineApplied,
    readKeys: normalizeKeys(Array.from(read)),
    unreadKeys: normalizeKeys(Array.from(unread)),
  }
}

/** 红色角标的数字：**未读的已结束任务结果**数量。 */
export function unreadTaskCount(state: TaskReadState): number {
  return normalizeKeys(state.unreadKeys).length
}

/** 把指定键标为已读（点「查看」/ 打开面板时列表里那几条）。 */
export function markTaskKeysRead(state: TaskReadState, keys: readonly string[]): TaskReadState {
  const targets = new Set(keys.map((key) => String(key ?? '')).filter(Boolean))
  if (targets.size === 0) return state
  const read = new Set(state.readKeys)
  targets.forEach((key) => read.add(key))
  return {
    ...state,
    readKeys: normalizeKeys(Array.from(read)),
    unreadKeys: normalizeKeys(state.unreadKeys.filter((key) => !targets.has(key))),
  }
}

/** 「全部已读」：未读清零（已读键保留，避免同一轮结果再次变未读）。 */
export function markAllTasksRead(state: TaskReadState): TaskReadState {
  if (state.unreadKeys.length === 0) return state
  return markTaskKeysRead(state, state.unreadKeys)
}

/** 反序列化：结构不认识 / 版本不认识 → 当成首次启用（会重新落一次基线）。 */
export function parseTaskReadState(raw: string | null | undefined): TaskReadState {
  const text = String(raw ?? '').trim()
  if (!text) return emptyTaskReadState()
  try {
    const parsed = JSON.parse(text) as Partial<TaskReadState>
    if (!parsed || typeof parsed !== 'object') return emptyTaskReadState()
    if (parsed.version !== TASK_READ_STATE_VERSION) return emptyTaskReadState()
    return {
      version: TASK_READ_STATE_VERSION,
      baselineApplied: parsed.baselineApplied === true,
      readKeys: normalizeKeys(Array.isArray(parsed.readKeys) ? parsed.readKeys.map(String) : []),
      unreadKeys: normalizeKeys(Array.isArray(parsed.unreadKeys) ? parsed.unreadKeys.map(String) : []),
    }
  } catch {
    return emptyTaskReadState()
  }
}

export function serializeTaskReadState(state: TaskReadState): string {
  return JSON.stringify({
    version: TASK_READ_STATE_VERSION,
    baselineApplied: state.baselineApplied,
    readKeys: normalizeKeys(state.readKeys),
    unreadKeys: normalizeKeys(state.unreadKeys),
  })
}

/** 从本机读取（无 window / 隐私模式下安全回落空状态 —— 那就等于首次启用）。 */
export function loadTaskReadStateFrom(storage: Pick<Storage, 'getItem'> | null | undefined): TaskReadState {
  if (!storage) return emptyTaskReadState()
  try {
    return parseTaskReadState(storage.getItem(TASK_READ_STORAGE_KEY))
  } catch {
    return emptyTaskReadState()
  }
}

/** 写回本机（失败静默：存储满 / 被禁用都不该让任务中心崩掉）。 */
export function saveTaskReadStateTo(
  storage: Pick<Storage, 'setItem'> | null | undefined,
  state: TaskReadState,
): void {
  if (!storage) return
  try {
    storage.setItem(TASK_READ_STORAGE_KEY, serializeTaskReadState(state))
  } catch {
    /* 忽略：读不到只是这次没记住，不影响本轮展示 */
  }
}

/**
 * 「活跃任务」的中性文案（任务书 §6.1：活跃任务**单独**用中性/蓝色文案显示）。
 *
 * 它**不是**红色角标的一部分：角标是红的、代表"有没看过的结果"；
 * 「运行中 2」是蓝的、代表"还有事情在跑"。两者语义不同，必须分开。
 */
export function activeTaskLabel(count: number): string {
  return `运行中 ${Math.max(0, Math.trunc(count))}`
}

/** 统计活跃任务数（页面统计与按钮文案共用一份判据）。 */
export function countActiveTasks(tasks: readonly { status: string }[]): number {
  return tasks.filter((task) => isActiveTaskStatus(task.status)).length
}
