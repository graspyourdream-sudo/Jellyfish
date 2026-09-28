/**
 * 资产出图口径（含**按类型的画面比例**）的只读读取（第 2 条第 3 项）。
 *
 * ## 为什么是"读后端"而不是前端写一张比例表
 *
 * 「人物 16:9 / 场景 16:9 / 道具 1:1 / 商品不参与自动出图」的**唯一事实来源**在
 * 后端的 `asset_strategies.ASSET_TYPE_ASPECT_RATIOS`，提交出图时也由同一张表解析比例。
 * 前端如果自己再写一份，就会出现"卡片上写 1:1、实际请求发 16:9"这种用户无法察觉的漂移。
 * 所以这里只做一件事：把后端下发的口径读回来给页面展示。
 *
 * ## 契约与降级
 *
 * - 素材来自 `GET /api/v1/studio/image-pipeline/asset-strategies`（纯读、不触网、不花钱）；
 * - 读不到时**不猜比例**：`ratioFor()` 返回空串，页面就不显示比例 chip。
 *   宁可少显示一个标签，也不能让用户按一个错误的比例去理解出图结果。
 */

import { useCallback, useEffect, useState } from 'react'

import { StudioImagePipelineService, type AssetStrategyRead } from '../../../services/generated'
import { toUserFacingText } from '../components/userFacingMessage'

export type AssetStrategyMap = {
  /** 类型 → 口径（含不参与自动出图的商品） */
  byType: Record<string, AssetStrategyRead>
  /** 类型 → 默认画幅（仅含**真的由业务规定**了比例的类型） */
  ratioByType: Record<string, string>
  loading: boolean
  /** 读不到时的中文说明（空串 = 读取正常） */
  error: string
}

const EMPTY: AssetStrategyMap = { byType: {}, ratioByType: {}, loading: true, error: '' }

export function useAssetStrategies(): AssetStrategyMap {
  const [state, setState] = useState<AssetStrategyMap>(EMPTY)

  const load = useCallback(async () => {
    try {
      const response = await StudioImagePipelineService.getAssetStrategiesApiV1StudioImagePipelineAssetStrategiesGet()
      const data = response.data
      const byType: Record<string, AssetStrategyRead> = {}
      for (const item of data?.strategies ?? []) {
        if (item?.asset_type) byType[item.asset_type] = item
      }
      setState({
        byType,
        // ratio_map 是后端**业务比例表**的只读镜像：服装不在里面，因此不会被套上别人的比例
        ratioByType: { ...(data?.ratio_map ?? {}) },
        loading: false,
        error: '',
      })
    } catch (error) {
      setState({
        byType: {},
        ratioByType: {},
        loading: false,
        error: toUserFacingText(error, '暂时读不到各资产类型的出图口径'),
      })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return state
}

/**
 * 该资产类型的**业务比例**（人物 16:9 / 场景 16:9 / 道具 1:1）。
 *
 * 表里没有的类型（服装 / 商品 / 未知类型）返回空串 —— **不替它拍板**：
 * 服装沿用管线既有默认，商品根本不参与自动出图。
 */
export function ratioFor(state: AssetStrategyMap, assetType: string | null | undefined): string {
  const key = String(assetType ?? '').trim().toLowerCase()
  if (!key) return ''
  return String(state.ratioByType[key] ?? '')
}

/** 该类型是否参与自动出图（商品是唯一 false 的类型）。 */
export function autoGenerates(state: AssetStrategyMap, assetType: string | null | undefined): boolean {
  const key = String(assetType ?? '').trim().toLowerCase()
  const item = state.byType[key]
  // 读不到口径时按**参与**处理：不能让信息缺失把正常的出图入口藏起来
  return item ? item.auto_generate !== false : true
}

/** 比例的中文说明（为什么是这个比例）——读不到时给空串，页面不编理由。 */
export function ratioNoteFor(state: AssetStrategyMap, assetType: string | null | undefined): string {
  const key = String(assetType ?? '').trim().toLowerCase()
  return String(state.byType[key]?.aspect_ratio_note ?? '')
}
