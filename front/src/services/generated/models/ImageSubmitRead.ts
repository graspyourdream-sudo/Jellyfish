/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ImageTaskResultRead } from './ImageTaskResultRead';
/**
 * 出图提交结果。
 */
export type ImageSubmitRead = {
    project_id: string;
    asset_type: string;
    stage: string;
    results?: Array<ImageTaskResultRead>;
    summary?: Record<string, any>;
    warnings?: Array<string>;
    guard_status?: string;
    /**
     * 边界说明
     */
    note?: string;
};

