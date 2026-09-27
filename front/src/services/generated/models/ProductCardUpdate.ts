/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ProductReferenceFile } from './ProductReferenceFile';
/**
 * 保存商品卡（免费出口）。
 *
 * 只允许出现 :data:`EDITABLE_CARD_FIELDS` 里的键：`extra="forbid"` 让前端写错字段时
 * 立刻 422，而不是静默忽略（静默忽略正是"用户改了没生效"这类问题的温床）。
 */
export type ProductCardUpdate = {
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
    confirmed?: boolean;
};

