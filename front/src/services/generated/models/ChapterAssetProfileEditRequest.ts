/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 人工修改 / 用户补充（写进 ``manual_overrides`` 与 ``user_notes``，模型结果永不覆盖）。
 */
export type ChapterAssetProfileEditRequest = {
    /**
     * 按字段键覆盖的结构化资料（键见清单的 field_labels；只覆盖给出的键）
     */
    fields?: Record<string, any>;
    /**
     * 用户补充条目（追加，自动去重）
     */
    notes?: Array<string>;
    /**
     * 补充别名（并入现有别名集合）
     */
    aliases?: Array<string>;
};

