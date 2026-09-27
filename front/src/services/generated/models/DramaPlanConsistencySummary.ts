/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 一致性检查的摘要（页面顶部一行提示 + 技术详情收起时用）。
 */
export type DramaPlanConsistencySummary = {
    /**
     * error 级问题数
     */
    errors?: number;
    /**
     * warning 级问题数
     */
    warnings?: number;
    /**
     * 镜头总数
     */
    shots?: number;
    /**
     * 出现商品的镜头数
     */
    product_shots?: number;
    /**
     * 「至少一半」要求的镜头数
     */
    product_required?: number;
    /**
     * 完整剧情全文的字符数
     */
    story_chars?: number;
    /**
     * 人物表里的人物数
     */
    characters?: number;
    /**
     * 场景表里的场景数
     */
    scenes?: number;
    /**
     * 一句话总结（用户语言）
     */
    text?: string;
};

