/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { BundleItemRead } from './BundleItemRead';
/**
 * 打包预检结论。
 */
export type VideoBundlePlanRead = {
    project_id: string;
    /**
     * current_shot / episode / episodes
     */
    scope: string;
    scope_label: string;
    included_count: number;
    excluded_count: number;
    /**
     * 有没有可交付的成片
     */
    has_content: boolean;
    /**
     * 范围内全部镜头（含被排除的）
     */
    items?: Array<BundleItemRead>;
    /**
     * 被排除的镜头（页面据此说明原因）
     */
    excluded?: Array<BundleItemRead>;
    /**
     * 口径说明
     */
    note?: string;
};

