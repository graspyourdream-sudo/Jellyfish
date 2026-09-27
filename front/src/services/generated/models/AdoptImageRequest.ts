/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 把生成出来的图片采纳进资产图片槽位（断点③：刷新后仍在）。
 */
export type AdoptImageRequest = {
    /**
     * 资产类型：character / scene / prop / costume / actor
     */
    entity_type: string;
    /**
     * 资产 ID
     */
    entity_id: string;
    /**
     * 生成图片的可访问地址（不能是 DRY_RUN 占位地址）
     */
    url: string;
    /**
     * 目标图片槽位 ID；为空则复用该资产第一个槽位，没有就新建
     */
    image_id?: (number | null);
    /**
     * 是否同时设为定版主图。**默认 false**（改动前默认 true）：不传就不会设版——因为不传 image_id 时复用的是第一个槽位，而它常常就是当前定版那一行，旧默认值会让「再采纳一次」静默把定版图换掉
     */
    set_primary?: boolean;
    /**
     * 显式确认替换定版图。该资产**已有定版图**（is_primary 且已绑图）而本次会顶掉它时必须传 true，否则返回结构化 409（meta.error 里带将被替换那张图的只读摘要）；没有定版图 / 不碰定版那一行时可以一直不传
     */
    confirm_replace_primary?: boolean;
    /**
     * 入库文件名（可空）
     */
    name?: string;
};

