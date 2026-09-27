/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 冲突项/指定项的人工决定（只有需要人工处理时才传）。
 */
export type ChapterAssetProfileSelection = {
    /**
     * 清单返回的 group_key（格式 类型:归一化名称）
     */
    group_key: string;
    /**
     * create_new / link_existing / skip
     */
    action: string;
    /**
     * action=link_existing 时要选用的已有资产 ID
     */
    asset_id?: (string | null);
    /**
     * 该项存在冲突时，必须显式置 true 才会写入
     */
    confirm_conflict?: boolean;
    /**
     * 人工决定的说明（可选，会原样回显在结果里）
     */
    reason?: string;
};

