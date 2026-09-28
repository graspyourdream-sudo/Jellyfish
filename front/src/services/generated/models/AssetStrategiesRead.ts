/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AssetStrategyRead } from './AssetStrategyRead';
/**
 * 按资产类型下发的出图口径集合（**画幅分流的唯一读口**）。
 */
export type AssetStrategiesRead = {
    /**
     * 逐类型的出图口径（含不参与自动出图的商品）
     */
    strategies?: Array<AssetStrategyRead>;
    /**
     * 中文说明（通道分流原因等）
     */
    notes?: Array<string>;
    /**
     * 类型 → 默认画幅（**唯一事实来源**的只读镜像，仅供展示核对）
     */
    ratio_map?: Record<string, string>;
};

