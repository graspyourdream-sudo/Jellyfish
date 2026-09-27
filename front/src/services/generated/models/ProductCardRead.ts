/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ProductReferenceFile } from './ProductReferenceFile';
/**
 * 商品卡 + 服务端算出来的缺项与来源。
 */
export type ProductCardRead = {
    project_id?: string;
    name?: string;
    category?: string;
    brand?: string;
    selling_points?: Array<string>;
    audience?: string;
    scenarios?: Array<string>;
    price_info?: string;
    compliance?: string;
    notes?: string;
    reference_files?: Array<ProductReferenceFile>;
    source_type?: 'manual' | 'paste' | 'upload' | 'existing';
    confirmed?: boolean;
    missing_fields?: Array<string>;
    missing_labels?: Array<string>;
    source_summary?: Record<string, any>;
    /**
     * 最后更新时间（ISO 串）
     */
    updated_at?: string;
    note?: string;
};

