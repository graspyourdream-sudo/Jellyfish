/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 一条资产级声音绑定（只读）。
 */
export type AssetVoiceRead = {
    /**
     * 资产类型：character / scene / prop / costume
     */
    asset_type: string;
    /**
     * 资产 ID
     */
    asset_id: string;
    /**
     * 资产类型的中文名（页面直接显示）
     */
    asset_label?: string;
    /**
     * 这一项是否已绑定声音
     */
    bound?: boolean;
    /**
     * 声音文件 ID（内部标识，只进技术详情层）
     */
    file_id?: string;
    /**
     * 声音文件名
     */
    file_name?: string;
    /**
     * 声音文件地址（是否可进供应商请求由生成前的准入判定负责）
     */
    url?: string;
};

