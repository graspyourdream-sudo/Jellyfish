/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 创建时填的「基本制作要求」（会写进该项目的策划 brief，策划页可直接看到并修改）。
 */
export type AdRequirements = {
    /**
     * 题材（留空沿用项目 style）
     */
    genre?: string;
    /**
     * 调性
     */
    tone?: string;
    /**
     * 期望镜头数
     */
    shot_count?: number;
    /**
     * 整片目标时长（秒），0=自动
     */
    duration_seconds?: number;
    /**
     * 导演备注
     */
    director_notes?: string;
    /**
     * 必须出现
     */
    mandatory_elements?: Array<string>;
    /**
     * 禁止出现
     */
    forbidden_elements?: Array<string>;
};

