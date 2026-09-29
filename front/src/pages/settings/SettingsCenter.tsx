/**
 * 「设置」一级入口（本轮最终收口：模型管理 + 系统设置 + LLM 调试台 三合一）。
 *
 * ## 页面结构（顺序固定）
 *
 * 1. **模型与服务** —— 复用既有模型管理能力（供应商 / 模型 / 默认设置三个子页签）；
 * 2. **系统设置** —— 复用既有昵称 / 角色 / 界面设置；
 * 3. **开发调试** —— 复用既有 LLM 调试台，**按权限显示**（见 `debugAccess.ts`）。
 *
 * ## 页签与 URL 是**双向绑定**的
 *
 * 规范路由是 `/settings?tab=models|system|debug`。页签状态存在 URL 里而不是组件状态里，
 * 于是浏览器前进 / 后退 / 刷新都会回到同一区域（用组件状态做不到这一点）。
 * 切页签走 `{ replace: true }`：后退键应当回上一个**页面**，而不是上一个页签。
 *
 * ## 无权限直达调试路由怎么办
 *
 * - `/settings?tab=debug`：`resolveSettingsTab` 直接给出默认区域并 `replace` 收敛 URL，
 *   **调试内容一个字节都不会渲染**（不是渲染了再藏起来）；
 * - 旧 `/llm-pipeline`：`DebugTabRoute` 先判权限，允许则进 `?tab=debug`，
 *   不允许则进默认页签 —— 两条分支都不会渲染调试内容。
 */

import { useEffect, useMemo } from 'react'
import { Layout, Tabs } from 'antd'
import { Navigate, useSearchParams } from 'react-router-dom'
import { useAppStore } from '../../store/useAppStore'
import ModelManagement from '../aiStudio/models/ModelManagement'
import LlmPipelinePage from '../aiStudio/llmPipeline/LlmPipelinePage'
import Settings from '../Settings'
import {
  SETTINGS_DEFAULT_TAB,
  debugAccessFromEnv,
  resolveSettingsTab,
  type DebugAccessDecision,
  type SettingsTabKey,
} from './debugAccess'

/** 读一次当前用户的「开发调试」准入结论（角色码来自 store）。 */
export function useDebugAccess(): DebugAccessDecision {
  const role = useAppStore((state) => state.user.role)
  return useMemo(() => debugAccessFromEnv(role), [role])
}

export default function SettingsCenter() {
  const [searchParams, setSearchParams] = useSearchParams()
  const debugAccess = useDebugAccess()

  const requestedTab = searchParams.get('tab')
  const activeTab = resolveSettingsTab(requestedTab, debugAccess)

  /* 无权限用户带着 `?tab=debug` 进来时，立刻把 URL 收敛到默认区域。
     用 `replace` 是为了不把「被拒绝的地址」留在历史里 —— 否则按后退会再次被拒绝。 */
  useEffect(() => {
    if (String(requestedTab ?? '').trim() === 'debug' && activeTab !== 'debug') {
      setSearchParams({ tab: SETTINGS_DEFAULT_TAB }, { replace: true })
    }
  }, [activeTab, requestedTab, setSearchParams])

  const items = useMemo(() => {
    const list: { key: SettingsTabKey; label: string }[] = [
      { key: 'models', label: '模型与服务' },
      { key: 'system', label: '系统设置' },
    ]
    /* 「开发调试」只在准入通过时才进 items —— 普通用户的 DOM 里根本没有这个页签 */
    if (debugAccess.visible) list.push({ key: 'debug', label: '开发调试' })
    return list
  }, [debugAccess.visible])

  return (
    <Layout className="h-full flex flex-col" style={{ minHeight: 0 }}>
      <div className="flex-shrink-0 px-4 pt-3 border-b border-gray-200 bg-white">
        <Tabs
          activeKey={activeTab}
          onChange={(key) => setSearchParams({ tab: key }, { replace: true })}
          size="small"
          items={items}
        />
      </div>

      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {activeTab === 'models' && <ModelManagement />}
        {activeTab === 'system' && <Settings />}
        {activeTab === 'debug' && debugAccess.allowed && <LlmPipelinePage />}
      </div>
    </Layout>
  )
}

/**
 * 旧 `/llm-pipeline` 的兼容路由：**进入「开发调试」页签**。
 *
 * 这是一个**声明式**入口（不是「渲染设置页再纠正」）：
 *   - 有权限 → `/settings?tab=debug`；
 *   - 无权限 → `/settings?tab=models`（设置默认页签）。
 *
 * 无论如何都不会渲染关于调试的组件 —— 无权限用户在 `Navigate` 生效前
 * 只看到一次重定向，看不到任何调试内容。
 */
export function DebugTabRoute() {
  const debugAccess = useDebugAccess()
  const target = debugAccess.allowed ? 'debug' : SETTINGS_DEFAULT_TAB
  return <Navigate to={`/settings?tab=${target}`} replace />
}
