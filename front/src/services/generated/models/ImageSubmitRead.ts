/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ImageChannelPlanRead } from './ImageChannelPlanRead';
import type { ImageTaskResultRead } from './ImageTaskResultRead';
/**
 * 出图提交结果。
 */
export type ImageSubmitRead = {
    project_id: string;
    /**
     * 单类型形态的类型；混合批量（items）时为 mixed
     */
    asset_type: string;
    stage: string;
    /**
     * 本次请求按 asset_type 分流后会**涉及**的出图通道（新）：vendor_service / apimart / mixed（同时涉及两条）。**实际产出的**每条结果各自带 channel，整数计数在 summary.by_channel —— 混批时以逐条结果为准
     */
    channel?: string;
    /**
     * 本次通道的中文名（新）
     */
    channel_label?: string;
    /**
     * 通道分流的中文说明（新）
     */
    channel_notes?: Array<string>;
    /**
     * 逐类型分组的通道/模板口径（新）
     */
    groups?: Array<ImageChannelPlanRead>;
    results?: Array<ImageTaskResultRead>;
    summary?: Record<string, any>;
    /**
     * 本次提交的整体归一化口径（新）：ok（全部成功）/ partial_failed（有成功也有失败，或存在图片已生成但 OSS 未就绪）/ failed（全部失败）/ running（还有未完成）/ dry_run / empty
     */
    outcome?: string;
    warnings?: Array<string>;
    guard_status?: string;
    /**
     * 边界说明
     */
    note?: string;
};

