import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { FilmService } from '../../../services/generated'
import { useTaskUiStore } from './taskUiStore'

const TASK_POLL_INTERVAL_MS = 4000
const TASK_RECENT_SECONDS = 15
const TASK_PAGE_SIZE = 50

type TaskRuntimeProviderProps = {
  children: ReactNode
}

export function TaskRuntimeProvider({ children }: TaskRuntimeProviderProps) {
  const setServerTasks = useTaskUiStore((state) => state.setServerTasks)
  const applyTaskReadBaseline = useTaskUiStore((state) => state.applyTaskReadBaseline)
  const observeTasksForUnread = useTaskUiStore((state) => state.observeTasksForUnread)

  useEffect(() => {
    let cancelled = false
    let timer: number | null = null
    /**
     * 是否已经落过「首次启用基线」。
     *
     * ⚠️ **只有成功的一次轮询**才能落基线。失败时列表是空的，若把"空列表"当成
     * 基线，紧接着的第一次成功轮询就会把里面的历史结束任务全部报成未读 ——
     * 那正是任务书 §6.2 明令禁止的「历史未读洪水」。
     */
    let baselinePending = true

    const load = async () => {
      try {
        const res = await FilmService.listTasksApiV1FilmTasksGet({
          recentSeconds: TASK_RECENT_SECONDS,
          page: 1,
          pageSize: TASK_PAGE_SIZE,
        })
        if (cancelled) return
        const items = res.data?.items ?? []
        setServerTasks(items)
        if (baselinePending) {
          /* 第一次成功拿到列表：当时已经是结束状态的任务全部算历史（记为已读基线）。 */
          applyTaskReadBaseline(items)
          baselinePending = false
        }
        /* 之后每轮：把本轮新出现的已结束任务记成未读（红点靠它累计，不靠现算）。 */
        observeTasksForUnread(items)
      } catch {
        if (!cancelled) {
          setServerTasks([])
        }
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(() => {
            void load()
          }, TASK_POLL_INTERVAL_MS)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [applyTaskReadBaseline, observeTasksForUnread, setServerTasks])

  return <>{children}</>
}
