/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * **一个资产类型**的出图口径（画幅 / 模板 / 结果类型 / 通道 / 是否自动出图）。
 */
export type AssetStrategyRead = {
    /**
     * 资产类型：character / scene / prop / costume / product
     */
    asset_type: string;
    /**
     * 类型中文名（页面直接展示）
     */
    asset_zh: string;
    /**
     * 提示词槽位（内部标识，仅供排障）
     */
    prompt_slot?: string;
    /**
     * 该类型使用的出图模板名（内部标识，仅供排障）
     */
    prompt_template?: string;
    /**
     * 结果类型标签（机器可读）
     */
    result_kind?: string;
    /**
     * 结果类型标签（中文，页面直接展示）
     */
    result_label?: string;
    /**
     * 不传画幅时这次会用什么比例；空串 = 没有比例口径
     */
    aspect_ratio?: string;
    /**
     * true = 连调用方显式传入也不采纳（人物参考图专有）
     */
    aspect_ratio_fixed?: boolean;
    /**
     * 为什么是这个比例（中文，可直接上屏）
     */
    aspect_ratio_note?: string;
    /**
     * 是否允许「按定版参考图批量出图」
     */
    batch_reference_allowed?: boolean;
    /**
     * 上游服务契约里的 generation_type（内部标识）
     */
    generation_type?: string;
    /**
     * 出图通道（机器可读）
     */
    channel?: string;
    /**
     * 出图通道中文名
     */
    channel_label?: string;
    /**
     * 是否参与自动出图；**商品是唯一 false 的类型**（人工上传 + 手动定版）
     */
    auto_generate?: boolean;
};

