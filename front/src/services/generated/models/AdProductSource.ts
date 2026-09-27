/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 剧情广告项目创建时的「商品资料来源」。
 *
 * **不在创建时调用模型**：这里只把来源登记下来（原文/文件/已有商品），
 * 真正的"提取"是策划页上一个显式的付费动作（见 `POST .../product-card/extract`）。
 */
export type AdProductSource = {
    type?: 'manual' | 'paste' | 'upload' | 'existing';
    /**
     * 粘贴的商品文案（type=paste）
     */
    text?: string;
    /**
     * 上传的资料文件 ID（type=upload）
     */
    file_ids?: Array<string>;
    /**
     * 选用的已有商品资产 ID（type=existing）
     */
    product_id?: string;
};

