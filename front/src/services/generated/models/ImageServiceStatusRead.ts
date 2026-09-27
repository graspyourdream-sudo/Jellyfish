/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 出图服务对接状态。
 */
export type ImageServiceStatusRead = {
    base_url: string;
    configured_env: string;
    guard: Record<string, any>;
    service_asset_types: Array<string>;
    generation_types: Record<string, string>;
    /**
     * 资产类型 → 出图通道（新）：character/scene/prop＝vendor_service（上游出图服务），costume＝apimart（Jellyfish 自己的 APIMart 图片通道）。页面据此说明「服装为什么不在上游服务里」
     */
    channels?: Record<string, string>;
    /**
     * 通道分流的中文说明（新）
     */
    channel_notes?: Array<string>;
    /**
     * 真实健康探测结果；DRY_RUN 下为 null
     */
    probe?: (Record<string, any> | null);
    /**
     * 未探测的原因
     */
    probe_skipped_reason?: string;
};

