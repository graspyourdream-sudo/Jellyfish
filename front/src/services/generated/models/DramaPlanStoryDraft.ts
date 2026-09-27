/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 完整剧情（``plan.story``，实施契约 §二 的 ``plan`` JSON 结构）。
 *
 * 为什么把"完整剧情全文"和五个结构块放在一起：页面既要一个"可读可编辑的大文本框"
 * （``full_text``，确认落库时写进 ``chapters.raw_text``），也要能分栏展示钩子/冲突/
 * 商品介入/高潮/结尾引导。两块内容来自同一次模型调用，所以放在同一个 DTO 里归一。
 *
 * 字段**缺省一律留空**（不做任何编造）：模型没给就是没给，页面据此显示"待补充"。
 */
export type DramaPlanStoryDraft = {
    /**
     * 完整剧情全文（分段的可读文本；确认时落 chapters.raw_text）
     */
    full_text?: string;
    /**
     * 开场钩子（前 3 秒的动作冲突）
     */
    hook?: string;
    /**
     * 核心冲突
     */
    conflict?: string;
    /**
     * 商品如何自然介入（不要念参数）
     */
    product_usage?: string;
    /**
     * 高潮与反转
     */
    climax?: string;
    /**
     * 结尾引导（自然的购买暗示，不是硬 CTA）
     */
    cta?: string;
};

