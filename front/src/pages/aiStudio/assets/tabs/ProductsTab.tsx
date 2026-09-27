import { AssetTypeTab } from './AssetTypeTab'
import { useNavigate } from 'react-router-dom'
import { StudioEntitiesApi } from '../../../../services/studioEntities'

/**
 * 商品资产页签（第五类资产，契约 §六）。
 *
 * 与场景 / 道具 / 服装**完全同构**：同一套实体 CRUD（`StudioEntitiesApi` 的
 * `product` 分支）、同一个列表组件、同一套「编辑」跳转。
 * 差别只有一处：商品图的「上传 + 设为定版」在编辑页里做（商品不走出图通道），
 * 所以这一页的编辑入口就是闭环第 2 步里商品卡片的落点。
 */
export function ProductsTab() {
  const navigate = useNavigate()

  return (
    <AssetTypeTab
      label="商品"
      tabKey="product"
      listAssets={async ({ q, page, pageSize }) => {
        const res = await StudioEntitiesApi.list('product', { q: q ?? null, page, pageSize })
        return { items: (res.data?.items ?? []) as any[], total: res.data?.pagination.total ?? 0 }
      }}
      createAsset={async (payload) => {
        const res = await StudioEntitiesApi.create('product', payload as Record<string, unknown>)
        if (!res.data) throw new Error('empty product')
        return res.data as any
      }}
      updateAsset={async (id, payload) => {
        const res = await StudioEntitiesApi.update('product', id, payload as Record<string, unknown>)
        if (!res.data) throw new Error('empty product')
        return res.data as any
      }}
      deleteAsset={async (id) => {
        await StudioEntitiesApi.remove('product', id)
      }}
      onEditAsset={(asset) => {
        navigate(`/assets/products/${asset.id}/edit`)
      }}
    />
  )
}
