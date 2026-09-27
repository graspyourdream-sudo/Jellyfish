/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ImageTaskResultRead } from './ImageTaskResultRead';
/**
 * 「使用已有参考图重新生成」结果。
 *
 * ``results`` / ``summary`` / ``outcome`` / ``warnings`` / ``guard_status`` 与默认主流程
 * （``ImageSubmitRead``）**同名同形**，前端可以复用同一套结果卡片。
 */
export type ReferenceRegenerateRead = {
    project_id: string;
    asset_type: string;
    asset_id: string;
    asset_name?: string;
    prompt?: string;
    /**
     * request（请求里传的）/ saved（该资产已保存的提示词）
     */
    prompt_source?: string;
    /**
     * 用到的参考图槽位 id（按资产首选图解析时为空）
     */
    reference_image_id?: (number | null);
    /**
     * **真正送进请求**的公网参考图地址（会进 image_urls）
     */
    reference_url?: string;
    /**
     * 参考图的可读名（页面文案用这个；不含 file_id）
     */
    reference_label?: string;
    /**
     * 参考图来源：slot（指定槽位）/ explicit_url（显式地址）/ asset_primary（该资产定版图）/ asset_fallback
     */
    reference_source?: string;
    attempt?: number;
    /**
     * 同一轮（同一 source_task_id）重复点击 → 直接复用上一轮结果，没有再次调用供应商、没有再次计费
     */
    deduplicated?: boolean;
    /**
     * 本次（或复用的上一轮）的幂等键
     */
    source_task_id?: string;
    provider?: string;
    model_id?: string;
    model_name?: string;
    base_url?: string;
    api_key_configured?: boolean;
    /**
     * 本次结果类型标签（新，机器可读，按 asset_type 分流）：characterReference（**仅人物**）/ sceneAssetImage / propAssetImage / costumeDesignImage
     */
    result_kind?: string;
    /**
     * 本次结果类型的中文标签（新）：人物参考图 / 场景资产图 / 道具资产图 / 服装设定图
     */
    result_label?: string;
    /**
     * 本次使用的画幅（新）：人物/场景 16:9、道具 1:1（人物参考图固定 16:9，不是项目最终视频画幅）
     */
    aspect_ratio?: string;
    /**
     * 画幅来源（新）：character_reference_fixed / request / asset_type_default / default
     */
    aspect_ratio_source?: string;
    /**
     * 本次使用的提示词模板名（新，审计用）
     */
    prompt_template?: string;
    /**
     * 与默认主流程同形的单条出图结果
     */
    results?: Array<ImageTaskResultRead>;
    summary?: Record<string, any>;
    outcome?: string;
    warnings?: Array<string>;
    guard_status?: string;
    /**
     * 本次是否真的发出了供应商调用（演练 / 被拦 / 复用上一轮时为 false）
     */
    paid_call_made?: boolean;
    /**
     * 边界说明
     */
    note?: string;
};

