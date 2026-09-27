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
     * 落库后可访问地址（资产页与实际使用的就是这个）
     */
    url: string;
    /**
     * 采纳时传入的来源地址，仅供溯源
     */
    source_url?: string;
    is_primary?: boolean;
    name?: string;
    /**
     * 落库地址是否**匿名公网可达**（新）：true=上游/浏览器都能匿名取到这张图；false=不可达（本机地址或对象未公开读，后续当参考图交给上游会被 404 拒绝）；null=未验证（演练模式，或驱动没有产出可验证的公网地址）
     */
    url_reachable?: (boolean | null);
    /**
     * 可达性验证明细（新）：http_status / probe_method / reason / how_to_fix
     */
    url_probe?: Record<string, any>;
    /**
     * 采纳过程中的如实提醒（新）：例如「已入库但匿名访问不可达」及其修法
     */
    warnings?: Array<string>;
    /**
     * 本次采纳**顶掉了哪张旧定版图**（新）：image_id（槽位 id）/ file_name（文件名）/ url_is_public（是否 OSS 公网地址）。没有替换过旧定版时为 null；摘要里不含 file_id、不含凭证、不含本机绝对路径
     */
    replaced_primary?: (Record<string, any> | null);
    /**
     * 边界说明
     */
    note?: string;
};

