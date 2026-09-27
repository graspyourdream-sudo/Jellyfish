/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 单条"内容已变化"的处置决定。
 */
export type ChapterAssetProfileDecision = {
    /**
     * 资料行的 group_key（格式 类型:归一化名称）
     */
    group_key: string;
    /**
     * overwrite（覆盖）/ merge（合并）/ keep（保留）
     */
    action: string;
};

