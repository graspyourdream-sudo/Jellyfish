/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 从资料里提取商品信息（**付费一次调用**）。
 *
 * 三种来源（契约要求至少三种）：`paste`（粘贴文案）、`upload`（上传 TXT/DOCX/图片，
 * 传 `file_ids`）、`existing`（选已有商品资料，传 `existing_product_id`）。
 */
export type ProductCardExtractRequest = {
    source_type?: 'manual' | 'paste' | 'upload' | 'existing';
    /**
     * source_type=paste 时的商品文案
     */
    text?: string;
    /**
     * source_type=upload 时的文件 ID 列表
     */
    file_ids?: Array<string>;
    /**
     * source_type=existing 时的商品资产 ID
     */
    existing_product_id?: string;
    /**
     * 补充要求（参与提示词，不影响字段集合）
     */
    extra_instructions?: string;
};

