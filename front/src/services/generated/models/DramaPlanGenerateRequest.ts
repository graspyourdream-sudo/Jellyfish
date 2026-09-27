/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * ``POST .../drama-plan/generate`` 的请求体（两个字段都有默认值：**向后兼容**）。
 */
export type DramaPlanGenerateRequest = {
    /**
     * 生成阶段：one_liner / story / storyboard / all
     */
    stage?: 'one_liner' | 'story' | 'storyboard' | 'all';
    /**
     * 人工编辑晚于上次生成时，必须显式传 true 才允许覆盖（否则 409）
     */
    confirm_overwrite?: boolean;
};

