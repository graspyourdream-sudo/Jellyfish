/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 商品参考资料的一条（图片或文档）。
 */
export type ProductReferenceFile = {
    /**
     * files.id（可为空：只登记名称的外部资料）
     */
    file_id?: string;
    /**
     * 文件名或说明
     */
    name?: string;
    /**
     * image / document / other
     */
    kind?: string;
};

