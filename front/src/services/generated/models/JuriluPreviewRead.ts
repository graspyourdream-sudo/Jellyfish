/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { JuriluPlanRowRead } from './JuriluPlanRowRead';
/**
 * 预览结果：将要发生什么。
 */
export type JuriluPreviewRead = {
    project_id: string;
    chapter_id: string;
    chapter_shot_count: number;
    entry_count: number;
    plan_summary: string;
    counts: Record<string, number>;
    rows: Array<JuriluPlanRowRead>;
    /**
     * 脱敏后的抓取诊断
     */
    diagnostics?: Record<string, any>;
    warnings?: Array<string>;
    jurilu_project_id?: string;
    jurilu_clip_id?: string;
    source_url?: string;
};

