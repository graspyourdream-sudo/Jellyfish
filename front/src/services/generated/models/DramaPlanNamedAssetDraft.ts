/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 角色 / 场景 / 商品共用的草稿形状。
 */
export type DramaPlanNamedAssetDraft = {
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
};

