/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { PromptCategory } from './PromptCategory';
/**
 * 单个槽位的图片提示词。
 */
export type ImagePromptSlotRead = {
    category: PromptCategory;
    label?: string;
    entity_name?: (string | null);
    /**
     * 分层结构：主体/动作/环境/镜头/风格/画质
     */
    layers?: Record<string, string>;
    /**
     * 拼接后的完整提示词
     */
    prompt?: string;
    /**
     * 该槽位的负面提示词
     */
    negative_prompt?: string;
    /**
     * 该槽位的**设计口径**（只读，新）：这一段提示词必须写出的具体维度。服装槽位为「服装设计口径（必须逐项写出）：穿着人物、身份时代、款式、颜色、材质、配饰、使用场合」（由 asset_profiles 的结构化字段表生成，模型与页面读同一份）；人物 / 场景 / 道具的既有口径已在各自槽位规则里，本字段为空
     */
    design_brief?: string;
    warnings?: Array<string>;
    /**
     * 是否通过后端质量拦截（false 时禁止保存 / 批量出图）
     */
    savable?: boolean;
    /**
     * 未通过的原因（结构化中文：code / message / fix / status_code）
     */
    quality_issues?: Array<Record<string, any>>;
    /**
     * 该槽位主体描述的资料来源：asset_description（资产描述）/ candidate_profile（候选结构化资料）/ request（调用方传入）/ none（没有任何资料，只剩空话兜底）
     */
    structured_source?: string;
};

