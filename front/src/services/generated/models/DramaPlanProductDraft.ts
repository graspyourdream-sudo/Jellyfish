/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 商品草稿（比角色/场景多一个外观描述，直接落 products.description）。
 */
export type DramaPlanProductDraft = {
    /**
     * 名称（正式产物里是 name 列）
     */
    name: string;
    /**
     * 人物关系（角色专用：与主角/其他人的关系；场景/商品留空）
     */
    relation?: string;
    /**
     * 结构化资料（键见 asset_profiles）
     */
    profile?: Record<string, string>;
    /**
     * 出现在哪些镜头（仅草稿信息）
     */
    shot_indexes?: Array<number>;
    /**
     * 商品外观描述
     */
    description?: string;
};

