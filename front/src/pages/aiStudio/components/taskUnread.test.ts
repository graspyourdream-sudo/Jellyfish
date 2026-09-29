/**
 * 任务中心「未读 / 已读」逻辑的回归测试（任务书 §6.3 逐条覆盖）。
 *
 * ## 这条问题线的来由
 *
 * 改前红色角标用的是 `tasks.length` —— **全部任务数**，不是未读数：
 *   - 打开面板不清零；
 *   - 活跃任务（排队 / 运行 / 处理中）也一起算进去；
 *   - 刷新后数字与"有没有新结果"毫无关系。
 *
 * 本测试钉住的是**新口径**（任务书 §6.1 / §6.2）：
 *
 * | 概念 | 定义 |
 * |---|---|
 * | 红色角标 | **未读的已结束任务结果**（完成 / 失败 / 取消）数量 |
 * | 活跃任务 | 另用中性文案（「运行中 N」）显示，**永不**进红色角标 |
 * | 已读键 | `taskId:最终状态:完成时间`（三段都要，重试才不会被旧已读误吞） |
 * | 首次启用 | 已存在的历史结束任务记为**已读基线**，不产生未读洪水 |
 *
 * 覆盖任务书点名的 8 项：首次迁移 / 活跃转结束 / 单条已读 / 打开面板已读 /
 * 全部已读 / 刷新恢复 / 同一任务重试 / 活跃任务不进红色角标。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIVE_TASK_STATUSES,
  TASK_READ_MAX_KEYS,
  TASK_READ_STATE_VERSION,
  TASK_READ_STORAGE_KEY,
  TERMINAL_TASK_STATUSES,
  activeTaskLabel,
  countActiveTasks,
  emptyTaskReadState,
  isActiveTaskStatus,
  isTerminalTaskStatus,
  loadTaskReadStateFrom,
  markAllTasksRead,
  markTaskKeysRead,
  parseTaskReadState,
  saveTaskReadStateTo,
  serializeTaskReadState,
  syncTaskReadState,
  taskReadKey,
  unreadTaskCount,
  type TaskReadInput,
  type TaskReadState,
} from './taskUnread.ts'

/** 造一条已完成任务（只给未读逻辑用得到的字段）。 */
function done(taskId: string, finishedAtTs = 1000, status = 'succeeded'): TaskReadInput {
  return { task_id: taskId, status, finished_at_ts: finishedAtTs, updated_at_ts: finishedAtTs }
}

/** 造一条正在跑的任务。 */
function running(taskId: string, updatedAtTs = 500): TaskReadInput {
  return { task_id: taskId, status: 'running', finished_at_ts: null, updated_at_ts: updatedAtTs }
}

/** 内存版 localStorage（只实现未读逻辑用到的两个方法）。 */
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => (map.has(key) ? String(map.get(key)) : null),
    setItem: (key: string, value: string) => {
      map.set(key, String(value))
    },
    snapshot: () => Object.fromEntries(map.entries()),
  }
}

/* ------------------------------------------------------------ 1. 首次迁移 */

test('首次启用：已存在的历史结束任务全部记成已读基线，不产生未读洪水', () => {
  const state = syncTaskReadState(
    emptyTaskReadState(),
    [done('t1', 100), done('t2', 200), done('t3', 300, 'failed')],
    { applyBaseline: true },
  )
  assert.equal(state.baselineApplied, true, '基线标记没有落下来')
  assert.equal(unreadTaskCount(state), 0, '首次启用就把历史结束任务算成了未读（洪水）')
  assert.equal(state.readKeys.length, 3, '三条历史结束任务都应当进入已读集合')
})

test('首次启用：第一轮里正在跑的任务不进已读集合，它结束之后才算未读', () => {
  let state = syncTaskReadState(emptyTaskReadState(), [done('t1', 100), running('t2')], {
    applyBaseline: true,
  })
  assert.equal(unreadTaskCount(state), 0)
  /* 第二轮：t2 结束了 → 新出现的结束结果，必须变成未读 */
  state = syncTaskReadState(state, [done('t1', 100), done('t2', 900)])
  assert.equal(unreadTaskCount(state), 1, '活跃任务转为结束后没有产生未读')
})

test('首次启用只落一次：后续轮询不再把已有结束任务当基线', () => {
  let state = syncTaskReadState(emptyTaskReadState(), [done('t1', 100)], { applyBaseline: true })
  state = syncTaskReadState(state, [done('t1', 100), done('t9', 999)])
  assert.equal(unreadTaskCount(state), 1)
  /* 就算有人再次传 applyBaseline，也不该把已经记下的未读抹掉 */
  state = syncTaskReadState(state, [done('t1', 100), done('t9', 999)], { applyBaseline: true })
  assert.equal(unreadTaskCount(state), 1, '重复传基线标记把已有未读抹掉了')
})

/* ------------------------------------------------- 2. 活跃任务不进红色角标 */

test('活跃任务（排队 / 运行 / 处理中）永不进入红色角标', () => {
  ACTIVE_TASK_STATUSES.forEach((status) => {
    assert.ok(isActiveTaskStatus(status), `${status} 应被判定为活跃状态`)
    assert.equal(isTerminalTaskStatus(status), false, `${status} 不能被当成已结束`)
    assert.equal(
      taskReadKey({ task_id: 't1', status, finished_at_ts: 1, updated_at_ts: 1 }),
      null,
      `${status} 不该有已读键（它不给红点做任何贡献）`,
    )
  })
  const state = syncTaskReadState(emptyTaskReadState(), [running('t1'), running('t2')], {
    applyBaseline: true,
  })
  assert.equal(unreadTaskCount(state), 0, '活跃任务被算进了未读')
  assert.equal(countActiveTasks([running('t1'), running('t2')]), 2)
  assert.equal(activeTaskLabel(2), '运行中 2', '活跃任务必须另用中性文案显示')
})

test('只有完成 / 失败 / 取消三种算是"已结束"', () => {
  assert.deepEqual([...TERMINAL_TASK_STATUSES], ['succeeded', 'failed', 'cancelled'])
  TERMINAL_TASK_STATUSES.forEach((status) => {
    assert.ok(taskReadKey({ task_id: 'x', status, finished_at_ts: 7, updated_at_ts: 7 }))
  })
  assert.equal(taskReadKey({ task_id: 'x', status: 'brand_new_status', finished_at_ts: 7 }), null)
})

/* ------------------------------------------------------------ 3. 单条已读 */

test('单条已读：点「查看」只减掉那一条，其余未读不受影响', () => {
  let state = syncTaskReadState(emptyTaskReadState(), [], { applyBaseline: true })
  state = syncTaskReadState(state, [done('a', 1), done('b', 2), done('c', 3)])
  assert.equal(unreadTaskCount(state), 3)
  const keyB = taskReadKey(done('b', 2))
  assert.ok(keyB)
  state = markTaskKeysRead(state, [keyB])
  assert.equal(unreadTaskCount(state), 2, '单条已读没有把未读减到 2')
  assert.ok(state.readKeys.includes(keyB), '读过的那条没进已读集合')
  /* 再点一次（或同一轮被重复标记）不会重复计数 */
  state = markTaskKeysRead(state, [keyB])
  assert.equal(unreadTaskCount(state), 2)
})

/* ------------------------------------------------------ 4. 打开面板已读 */

test('打开面板 = 把"实际看见的"那几条标为已读（而不是全部）', () => {
  let state = syncTaskReadState(emptyTaskReadState(), [], { applyBaseline: true })
  state = syncTaskReadState(state, [done('a', 1), done('b', 2), done('c', 3), done('d', 4)])
  assert.equal(unreadTaskCount(state), 4)
  /* 面板只渲染了 3 条（每页 3 条的口径）—— 只把这 3 条标为已读 */
  const visible = [done('a', 1), done('b', 2), done('c', 3)]
    .map((task) => taskReadKey(task))
    .filter((key): key is string => !!key)
  state = markTaskKeysRead(state, visible)
  assert.equal(unreadTaskCount(state), 1, '打开面板应当只清掉"看得见"的那几条')
  assert.equal(taskReadKey(done('d', 4)) === state.unreadKeys[0], true, '没看见的那条仍是未读')
})

/* --------------------------------------------------------- 5. 全部已读 */

test('全部已读：未读清零，且已读记录保留（同一轮结果不会再次变未读）', () => {
  let state = syncTaskReadState(emptyTaskReadState(), [], { applyBaseline: true })
  state = syncTaskReadState(state, [done('a', 1), done('b', 2)])
  assert.equal(unreadTaskCount(state), 2)
  state = markAllTasksRead(state)
  assert.equal(unreadTaskCount(state), 0)
  assert.equal(state.readKeys.length, 2, '全部已读也应当把键记下来')
  /* 再轮询一次同一批任务：不许重新变成未读 */
  state = syncTaskReadState(state, [done('a', 1), done('b', 2)])
  assert.equal(unreadTaskCount(state), 0, '「全部已读」之后又被同一批结果顶成未读')
})

/* ------------------------------------------------------- 6. 刷新恢复 */

test('刷新恢复：已读状态从本机恢复（当前设备的已读状态）', () => {
  const storage = memoryStorage()
  let state = syncTaskReadState(emptyTaskReadState(), [], { applyBaseline: true })
  state = syncTaskReadState(state, [done('a', 1), done('b', 2)])
  state = markTaskKeysRead(state, [taskReadKey(done('a', 1)) as string])
  assert.equal(unreadTaskCount(state), 1)
  saveTaskReadStateTo(storage, state)

  /* 「刷新」= 重新从存储里读一份出来 */
  const restored = loadTaskReadStateFrom(storage as never)
  assert.equal(unreadTaskCount(restored), 1, '刷新后未读没有恢复')
  assert.equal(restored.baselineApplied, true, '刷新后基线标记丢了（会再吞一次历史任务）')
  assert.ok(
    storage.snapshot()[TASK_READ_STORAGE_KEY].includes(TASK_READ_STATE_VERSION),
    '存储里必须是带版本号的结构',
  )
})

test('刷新恢复：存储结构不认识 / 版本不认识时按「首次启用」重新落基线（不猜）', () => {
  assert.equal(parseTaskReadState(null).baselineApplied, false)
  assert.equal(parseTaskReadState('not json').baselineApplied, false)
  assert.equal(parseTaskReadState('{"version":"other","baselineApplied":true}').baselineApplied, false)
  assert.equal(parseTaskReadState('{"version":"other","readKeys":["a"]}').readKeys.length, 0)
  /* 正常结构能读回来 */
  const round = parseTaskReadState(serializeTaskReadState(syncTaskReadState(emptyTaskReadState(), [done('a', 1)], { applyBaseline: true })))
  assert.equal(round.baselineApplied, true)
  assert.equal(round.readKeys.length, 1)
})

test('刷新恢复：没有存储（隐私模式 / 无 window）时安全回落，不抛错', () => {
  const state = loadTaskReadStateFrom(null)
  assert.equal(unreadTaskCount(state), 0)
  assert.doesNotThrow(() => saveTaskReadStateTo(null, state))
  const throwing = {
    getItem() {
      throw new Error('blocked')
    },
    setItem() {
      throw new Error('blocked')
    },
  }
  assert.equal(unreadTaskCount(loadTaskReadStateFrom(throwing as never)), 0)
  assert.doesNotThrow(() => saveTaskReadStateTo(throwing as never, state))
})

/* --------------------------------------------------- 7. 同一任务重试 */

test('同一任务重试：新的结束轮次不会被旧已读记录误吞', () => {
  let state = syncTaskReadState(emptyTaskReadState(), [], { applyBaseline: true })
  state = syncTaskReadState(state, [done('retry-1', 100)])
  assert.equal(unreadTaskCount(state), 1)
  state = markAllTasksRead(state)
  assert.equal(unreadTaskCount(state), 0)

  /* 用户点「重新生成」→ 同一个任务换了一轮，完成时间变了（可能状态也变了） */
  state = syncTaskReadState(state, [done('retry-1', 200)])
  assert.equal(unreadTaskCount(state), 1, '重试后的新结束结果被旧已读吞掉了')

  /* 状态从成功变失败（同一次重试也可能是这个形态）同样是新的一轮 */
  let state2 = syncTaskReadState(emptyTaskReadState(), [], { applyBaseline: true })
  state2 = syncTaskReadState(state2, [done('r2', 300, 'succeeded')])
  state2 = markAllTasksRead(state2)
  state2 = syncTaskReadState(state2, [done('r2', 300, 'failed')])
  assert.equal(unreadTaskCount(state2), 1, '同一任务换成失败结果不算新未读')
})

test('已读键确实区分任务 / 最终状态 / 最终完成时间（三段都参与）', () => {
  assert.equal(taskReadKey(done('a', 1)), 'a:succeeded:1')
  assert.notEqual(taskReadKey(done('a', 1)), taskReadKey(done('b', 1)))
  assert.notEqual(taskReadKey(done('a', 1)), taskReadKey(done('a', 2)))
  assert.notEqual(taskReadKey(done('a', 1, 'succeeded')), taskReadKey(done('a', 1, 'failed')))
  /* 拿不到完成时间时退回最后更新时间（仍然是一个稳定值，重试照样会变） */
  assert.equal(
    taskReadKey({ task_id: 'a', status: 'cancelled', finished_at_ts: null, updated_at_ts: 42 }),
    'a:cancelled:42',
  )
  assert.equal(taskReadKey({ task_id: '', status: 'succeeded', finished_at_ts: 1 }), null)
})

/* ------------------------------------------------- 8. 规模限制与清理 */

test('已读记录有规模上限（超限丢最旧的，长期使用不会无限膨胀）', () => {
  const tasks = Array.from({ length: TASK_READ_MAX_KEYS + 50 }, (_, index) => done(`t${index}`, index))
  const state = syncTaskReadState(emptyTaskReadState(), tasks, { applyBaseline: true })
  assert.equal(state.readKeys.length, TASK_READ_MAX_KEYS, '已读集合没有被截断到上限')
  /* 截断丢的是**最旧**的：最后一条一定还在 */
  assert.ok(state.readKeys.includes(`t${TASK_READ_MAX_KEYS + 49}:succeeded:${TASK_READ_MAX_KEYS + 49}`))
  /* 未读集合同样有上限 */
  let unread = syncTaskReadState(emptyTaskReadState(), [], { applyBaseline: true })
  unread = syncTaskReadState(unread, tasks)
  assert.equal(unread.unreadKeys.length, TASK_READ_MAX_KEYS)
})

test('已读集合去重：同一轮里同一条任务出现两次只算一个键', () => {
  const state = syncTaskReadState(emptyTaskReadState(), [done('a', 1), done('a', 1)], {
    applyBaseline: true,
  })
  assert.equal(state.readKeys.length, 1)
  let unread = syncTaskReadState(emptyTaskReadState(), [], { applyBaseline: true })
  unread = syncTaskReadState(unread, [done('a', 1), done('a', 1), done('a', 1)])
  assert.equal(unreadTaskCount(unread), 1)
})

test('纯函数不改入参（zustand 里可以直接替换状态）', () => {
  const base: TaskReadState = emptyTaskReadState()
  const before = JSON.stringify(base)
  syncTaskReadState(base, [done('a', 1)], { applyBaseline: true })
  markTaskKeysRead(base, ['a:succeeded:1'])
  markAllTasksRead(base)
  assert.equal(JSON.stringify(base), before, '入参被就地改了')
})
