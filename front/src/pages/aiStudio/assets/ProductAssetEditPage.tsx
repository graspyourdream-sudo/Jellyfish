import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { AssetEditPageBase } from './components/AssetEditPageBase'
import { assetAdapters } from './assetAdapters'
import { decodeAssetEditReturnTo } from '../project/ProjectWorkbench/utils/workbenchAssetReturnTo'

/**
 * 商品资产编辑页（第五类资产）。
 *
 * 这一页就是闭环第 2 步里商品卡片的落点：**上传图片 + 手动「设为定版」**。
 * 两件事都走既有实体 CRUD（`StudioEntitiesApi` 的 `product` 分支 → 商品图片端点），
 * 没有新接口、也没有新的出图通道 —— 商品图**不**走出图链路（契约 §六）。
 */
export default function ProductAssetEditPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { productId } = useParams<{ productId: string }>()
  const adapter = assetAdapters.product
  const backTo = decodeAssetEditReturnTo(searchParams.get('returnTo'), adapter.backTo)

  return (
    <AssetEditPageBase<any, any>
      assetId={productId}
      onNavigate={(to, replace) => navigate(to, replace ? { replace: true } : undefined)}
      {...adapter}
      backTo={backTo}
    />
  )
}
