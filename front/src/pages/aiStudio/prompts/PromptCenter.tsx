/**
 * 「提示词管理」一级入口（本轮最终收口：提示词模板 + 提示词导入 / 交付 二合一）。
 *
 * ## 页面结构（两个页签）
 *
 * 1. **模板管理** —— 复用既有 `PromptTemplateManager`（查询 / 创建 / 编辑 / 删除）；
 * 2. **导入与交付** —— 复用既有 `PromptFlowPage`（巨日禄导入 / 提示词交付 / 一键技能）。
 *
 * ## 为什么只是「统一导航与页面外壳」
 *
 * 两类能力的**数据模型完全不同**（一边是 `prompt_templates` 的模板行，另一边是
 * 章节镜头上的提示词与导入 / 交付记录），所以这里只做一层页签外壳，
 * **不合并任何数据结构、不搬任何请求** —— 两个页面组件原样复用，各自的接口一个字节不改。
 *
 * ## 页签与 URL 双向绑定
 *
 * 规范路由 `/prompts?tab=templates|delivery`：
 *   - 旧 `/prompts` 不写 `?tab=` → 进**模板管理**（旧行为不变）；
 *   - 旧 `/prompt-flow` → `PromptDeliveryTabRoute` 重定向进 **导入与交付**；
 *   - 刷新 / 前进 / 后退都按 URL 恢复当前页签（页签状态不放在组件里）。
 *
 * 左侧菜单只有「提示词管理」一个入口，两个页签都高亮它（见 `MainLayout` 的 `selectedKeys`）。
 */

import { useMemo } from 'react'
import { Layout, Tabs } from 'antd'
import { Navigate, useSearchParams } from 'react-router-dom'
import PromptTemplateManager from './PromptTemplateManager'
import PromptFlowPage from '../promptFlow/PromptFlowPage'

/** 提示词管理的两个页签（顺序即页面顺序）。 */
export const PROMPT_TABS = ['templates', 'delivery'] as const
export type PromptTabKey = (typeof PROMPT_TABS)[number]

/** 不写 `?tab=` 时的默认页签：保持旧 `/prompts` 的落点（模板管理）。 */
export const PROMPT_DEFAULT_TAB: PromptTabKey = 'templates'

/** 解析 `?tab=`：未登记的值回落默认页签（不回显、不报错）。 */
export function resolvePromptTab(raw: string | null | undefined): PromptTabKey {
  return String(raw ?? '').trim() === 'delivery' ? 'delivery' : PROMPT_DEFAULT_TAB
}

export default function PromptCenter() {
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab = resolvePromptTab(searchParams.get('tab'))

  const items = useMemo(
    () => [
      { key: 'templates', label: '模板管理' },
      { key: 'delivery', label: '导入与交付' },
    ],
    [],
  )

  return (
    <Layout className="h-full flex flex-col" style={{ minHeight: 0 }}>
      <div className="flex-shrink-0 px-4 pt-3 border-b border-gray-200 bg-white">
        <Tabs
          activeKey={activeTab}
          /* 切页签写进 URL（replace）：刷新与后退都能恢复到同一页签，
             同时不往历史里堆「上一个页签」这种噪音条目。 */
          onChange={(key) => setSearchParams({ tab: key }, { replace: true })}
          size="small"
          items={items}
        />
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {activeTab === 'templates' && <PromptTemplateManager />}
        {activeTab === 'delivery' && <PromptFlowPage />}
      </div>
    </Layout>
  )
}

/**
 * 旧 `/prompt-flow` 的兼容路由：重定向进「导入与交付」页签。
 *
 * 旧收藏链接与文档里的 `/prompt-flow` 因此不会 404，也不会落到模板页签
 * （用户点进来想看的是导入 / 交付，把他丢到模板管理等于改变了他的意图）。
 */
export function PromptDeliveryTabRoute() {
  return <Navigate to="/prompts?tab=delivery" replace />
}
