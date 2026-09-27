/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ImageChannelPlanRead } from './ImageChannelPlanRead';
import type { ReferenceImageRead } from './ReferenceImageRead';
import type { SubmissionTargetRead } from './SubmissionTargetRead';
/**
 * 出图提交计划预览。
 */
export type ImagePlanPreviewRead = {
    project_id: string;
    /**
     * 单类型形态的类型；混合批量（items）时为 mixed
     */
    asset_type: string;
    stage: string;
    /**
     * 本次请求按 asset_type 分流后会**涉及**的出图通道（新）：vendor_service / apimart；一次请求同时涉及两条时为 mixed（逐项分流，不是第三条通道）。逐条目标自己的通道在 targets[].channel，整数计数在 summary.by_channel
     */
    channel?: string;
    /**
     * 本次通道的中文名（新）
     */
    channel_label?: string;
    /**
     * 通道分流的中文说明（新）：哪一类走哪条通道、为什么（服装不在上游契约内）
     */
    channel_notes?: Array<string>;
    /**
     * 逐类型分组的通道/模板口径（新，混合批量时逐组一条）
     */
    groups?: Array<ImageChannelPlanRead>;
    targets?: Array<SubmissionTargetRead>;
    references?: Array<ReferenceImageRead>;
    warnings?: Array<string>;
    summary?: Record<string, any>;
    /**
     * 本次按 asset_type 分流的出图口径（新）：result_kind / result_label / aspect_ratio / aspect_ratio_fixed / aspect_ratio_note / prompt_template / batch_reference_allowed / channel
     */
    strategy?: Record<string, any>;
    /**
     * 当前守卫状态；preview 永远不触网
     */
    dry_run?: boolean;
    /**
     * 边界说明
     */
    note?: string;
};

