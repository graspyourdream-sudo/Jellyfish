/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 准备页「关联现有资产」允许的实体类型。
 *
 * 必须与 ``ShotLinkedAssetType``（本文件上方）保持同样的覆盖面：少一类时，
 * 该类型的关联会在 **请求校验阶段** 就变成 422 —— 用户看到的是"参数错误"，
 * 而不是"这个功能不支持"，排查成本极高。
 *
 * ``product`` 是第五类资产（商品，全局资产，经 ``project_product_links`` 关联镜头）。
 */
export type ShotPreparationLinkEntityType = 'character' | 'scene' | 'prop' | 'costume' | 'product';
