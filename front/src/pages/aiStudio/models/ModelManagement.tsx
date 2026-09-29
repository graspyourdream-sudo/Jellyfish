import { useState } from 'react'
import { Layout, Tabs } from 'antd'
import ProvidersTab from './ProvidersTab'
import ModelsTab from './ModelsTab'
import SettingsTab from './SettingsTab'

/**
 * 「设置 → 模型与服务」区域。
 *
 * 本轮口径变化：
 *   - 页面标题从「模型管理」改成**「模型与服务」** —— 它现在是设置里的一个区域，
 *     继续叫「模型管理」会和左侧新的一级入口「设置」并列成两个同级概念；
 *   - 第三个子页签从「设置」改成**「默认设置」** —— 页面外层已经叫「设置」了，
 *     内层再出现一个光秃秃的「设置」会让用户看不懂点它会发生什么（同名不同层是歧义）。
 *
 * 三个子页签的能力一个都没动：供应商 / 模型 / 默认设置仍然是既有实现原样复用。
 */
export default function ModelManagement() {
  const [activeTab, setActiveTab] = useState<string>('providers')

  return (
    <Layout className="h-full flex flex-col" style={{ minHeight: 0 }}>
      <div className="flex-shrink-0 px-4 py-3 border-b border-gray-200 bg-white space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold text-gray-800">模型与服务</span>
        </div>
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          size="small"
          items={[
            { key: 'providers', label: '供应商' },
            { key: 'models', label: '模型' },
            { key: 'settings', label: '默认设置' },
          ]}
        />
      </div>

      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {activeTab === 'providers' && <ProvidersTab />}
        {activeTab === 'models' && <ModelsTab />}
        {activeTab === 'settings' && <SettingsTab />}
      </div>
    </Layout>
  )
}
