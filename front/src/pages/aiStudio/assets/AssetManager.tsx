import { useEffect, useState } from 'react'
import { Card, Tabs } from 'antd'
import { useSearchParams } from 'react-router-dom'
import { ActorsTab } from './tabs/ActorsTab'
import { ScenesTab } from './tabs/ScenesTab'
import { PropsTab } from './tabs/PropsTab'
import { CostumesTab } from './tabs/CostumesTab'
import { ProductsTab } from './tabs/ProductsTab'

const TAB_PARAM = 'tab'
type AssetTabKey = 'actor' | 'scene' | 'prop' | 'costume' | 'product'

function isValidTab(tab: string | null): tab is AssetTabKey {
  return (
    tab === 'actor' || tab === 'scene' || tab === 'prop' || tab === 'costume' || tab === 'product'
  )
}

const AssetManager = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabFromUrl = searchParams.get(TAB_PARAM)

  const [activeTab, setActiveTab] = useState<AssetTabKey>(() => (isValidTab(tabFromUrl) ? tabFromUrl : 'actor'))

  useEffect(() => {
    if (isValidTab(tabFromUrl)) {
      setActiveTab(tabFromUrl)
    } else if (tabFromUrl === null || tabFromUrl === '') {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set(TAB_PARAM, 'actor')
          return next
        },
        { replace: true },
      )
    }
  }, [tabFromUrl, setSearchParams])

  const setTabInUrl = (tab: AssetTabKey) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set(TAB_PARAM, tab)
        return next
      },
      { replace: true },
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <Tabs
          activeKey={activeTab}
          onChange={(k) => {
            if (isValidTab(k)) setTabInUrl(k)
          }}
          items={[
            { key: 'actor', label: '演员', children: <ActorsTab /> },
            { key: 'scene', label: '场景', children: <ScenesTab /> },
            { key: 'prop', label: '道具', children: <PropsTab /> },
            { key: 'costume', label: '服装', children: <CostumesTab /> },
            /* 商品是第五类资产：它的图**不走出图通道**，所以这一页的「编辑」入口就是
               「上传图片 + 设为定版」的落点（复用实体 CRUD，不新增接口）。 */
            { key: 'product', label: '商品', children: <ProductsTab /> },
          ]}
        />
      </Card>
    </div>
  )
}

export default AssetManager
