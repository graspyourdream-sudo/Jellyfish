/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { DramaPlanNamedAssetDraft } from './DramaPlanNamedAssetDraft';
import type { DramaPlanProductDraft } from './DramaPlanProductDraft';
import type { DramaPlanShotDraft } from './DramaPlanShotDraft';
import type { DramaPlanStoryDraft } from './DramaPlanStoryDraft';
/**
 * 模型产物归一化后的完整草稿。
 */
export type DramaPlanDraft = {
    /**
     * 标题（落 chapters.title）
     */
    title?: string;
    /**
     * 一句话主线（落 chapters.summary）
     */
    logline?: string;
    /**
     * 一句话核心创意（分层生成的第 1 步产物）
     */
    one_liner?: string;
    /**
     * 想让目标受众产生的情绪（分层生成第 1 步的产物）
     */
    audience_emotion?: string;
    /**
     * 完整剧情（分层生成第 2 步产物；缺字段留空）
     */
    story?: DramaPlanStoryDraft;
    /**
     * 被剧情化后的卖点
     */
    selling_points?: Array<string>;
    characters?: Array<DramaPlanNamedAssetDraft>;
    scenes?: Array<DramaPlanNamedAssetDraft>;
    /**
     * 商品（缺省 = 本次没有商品）
     */
    product?: (DramaPlanProductDraft | null);
    shots?: Array<DramaPlanShotDraft>;
    /**
     * 结尾反转 / 高潮
     */
    climax?: string;
    /**
     * 归一化过程中的如实警告
     */
    warnings?: Array<string>;
};

