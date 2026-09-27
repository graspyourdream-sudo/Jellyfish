/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 调用方传入的实体画像（画像卡输入）。
 */
export type EntityProfileInput = {
    /**
     * 实体名称
     */
    name: string;
    /**
     * 实体类型
     */
    entity_type?: string;
    /**
     * 实体画像描述
     */
    profile?: string;
    /**
     * 已有资产基础提示词（可空）
     */
    base_prompt?: string;
    /**
     * 已有资产图片提示词（可空）
     */
    image_prompt?: string;
    /**
     * 画像资料的来源（由装载方如实填写，供前端说明「这段描述是从哪来的」）：asset_description=资产描述；candidate_profile=候选结构化资料；request=调用方直接传入；none=没有任何资料
     */
    profile_source?: string;
};

