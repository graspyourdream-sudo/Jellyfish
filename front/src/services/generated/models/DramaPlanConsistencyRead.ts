/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { DramaPlanConsistencyIssue } from './DramaPlanConsistencyIssue';
import type { DramaPlanConsistencySummary } from './DramaPlanConsistencySummary';
/**
 * 一致性检查结果（**免费**出口，不调用模型）。
 */
export type DramaPlanConsistencyRead = {
    chapter_id?: string;
    /**
     * 没有任何 error 级问题 → true
     */
    ok?: boolean;
    issues?: Array<DramaPlanConsistencyIssue>;
    summary?: DramaPlanConsistencySummary;
    /**
     * 边界说明（由服务层填）
     */
    note?: string;
};

