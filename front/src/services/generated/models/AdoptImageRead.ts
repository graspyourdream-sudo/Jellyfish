/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 采纳结果。
 */
export type AdoptImageRead = {
    entity_type: string;
    entity_id: string;
    image_id: number;
    file_id: string;
    /**
     * 落库后可访问地址（资产页与垫图实际使用的就是这个）
     */
    url: string;
    /**
     * 采纳时传入的来源地址，仅供溯源
     */
    source_url?: string;
    is_primary?: boolean;
    name?: string;
    /**
     * 边界说明
     */
    note?: string;
};

