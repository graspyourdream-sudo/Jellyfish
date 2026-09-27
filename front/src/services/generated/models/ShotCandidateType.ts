/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 镜头提取候选类型。
 *
 * ``product`` 是剧情广告流程里的**第五类资产**。它必须在这里（而不是只存在于
 * ``asset_profiles.ASSET_TYPES``）：``mark_linked_by_name`` 等回写路径会对传入类型做
 * ``ShotCandidateType(str(...))``，枚举里少一个成员就会把"新建商品并关联到镜头"
 * 变成 ``ValueError`` —— 枚举是那些路径的类型闸，不是提示性清单。
 */
export type ShotCandidateType = 'character' | 'scene' | 'prop' | 'costume' | 'product';
