/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 一个资产类型分组的**通道与模板口径**（新，页面直接展示「这一组发给了谁」）。
 */
export type ImageChannelPlanRead = {
    asset_type: string;
    asset_ids?: Array<string>;
    /**
     * vendor_service / apimart
     */
    channel?: string;
    channel_label?: string;
    /**
     * 中文说明：本次用的是哪条通道、为什么
     */
    channel_note?: string;
    result_kind?: string;
    result_label?: string;
    prompt_template?: string;
    /**
     * 本组的提交目标数（整数）
     */
    target_count?: number;
    warnings?: Array<string>;
};

