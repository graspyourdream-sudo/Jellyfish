/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { EntityNameExistenceItem } from './EntityNameExistenceItem';
/**
 * 批量存在性检测结果（按资产类型分组）。
 *
 * ``products`` 与其余四桶同形；响应模型是 ``extra="forbid"``，所以服务端多返回一个桶
 * 就必须在这里声明，否则整条响应校验失败（而不是多出一个字段）。
 */
export type EntityNameExistenceCheckResponse = {
    characters?: Array<EntityNameExistenceItem>;
    props?: Array<EntityNameExistenceItem>;
    scenes?: Array<EntityNameExistenceItem>;
    costumes?: Array<EntityNameExistenceItem>;
    products?: Array<EntityNameExistenceItem>;
};

