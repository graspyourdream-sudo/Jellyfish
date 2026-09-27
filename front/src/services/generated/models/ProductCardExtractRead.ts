/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ProductCardUpdate } from './ProductCardUpdate';
/**
 * 提取结果：**结构化字段 + 缺项 + 来源**，不落库，由用户确认后再 PUT。
 */
export type ProductCardExtractRead = {
    fields?: ProductCardUpdate;
    missing_fields?: Array<string>;
    missing_labels?: Array<string>;
    source_summary?: Record<string, any>;
    warnings?: Array<string>;
    note?: string;
};

