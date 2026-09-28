/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { VideoAudioPlanRead } from './VideoAudioPlanRead';
import type { VideoPlanFrameRead } from './VideoPlanFrameRead';
/**
 * 直提出视频的计划预览。
 */
export type VideoSubmitPlanRead = {
    shot_id: string;
    provider?: string;
    model_id?: string;
    model_name?: string;
    base_url?: string;
    api_key_configured?: boolean;
    reference_mode?: string;
    reference_image_count?: number;
    prompt?: string;
    /**
     * request / llm_orchestration
     */
    prompt_source?: string;
    ratio?: string;
    seconds?: (number | null);
    /**
     * 分辨率档位；固定策略默认 480p
     */
    resolution?: string;
    /**
     * 当前参考模式要求的帧类型（first/last/key）
     */
    required_frame_types?: Array<string>;
    /**
     * 本次请求实际使用的参考帧（file_id 级）
     */
    frames?: Array<VideoPlanFrameRead>;
    /**
     * 当前模式下**槽位没有 file_id** 的帧类型；非空时不允许真实生成
     */
    missing_frame_types?: Array<string>;
    /**
     * 有 file_id 但**供应商取不到**的帧类型（例如本地地址只能变 data URL，而 APIMart 只收 http(s):// / asset://）；与 missing 一样会阻止生成，需在前端区分提示
     */
    unusable_frame_types?: Array<string>;
    /**
     * 是否被参考帧拦截（缺帧或帧供应商不可用；页面据此禁用真实生成）
     */
    generation_blocked?: boolean;
    blocked_reason?: string;
    /**
     * 本次请求携带的音频 file_id（空表示未携带）
     */
    audio_file_id?: string;
    /**
     * 音频地址（仅公网地址会被发送给供应商）
     */
    audio_url?: string;
    /**
     * 本镜是否明确标记无需声音
     */
    audio_opt_out?: boolean;
    /**
     * bound（已绑且可用）/ bound_not_public / missing / opt_out
     */
    audio_state?: string;
    /**
     * 参考音频审计（只增字段）：included / file_id / url / excluded_reason —— 本次请求是否携带音频、带的是哪个地址、没带是为什么
     */
    audio?: VideoAudioPlanRead;
    /**
     * 是否命中固定模型策略（seedance-2.0-mini）
     */
    model_pinned?: boolean;
    /**
     * 该模型允许的画幅（来自供应商能力表）
     */
    ratio_options?: Array<string>;
    /**
     * 可选的视频模型名（模型表里 category=video 的全部模型）
     */
    model_options?: Array<string>;
    /**
     * 该模型允许的分辨率档位（来自供应商能力表）
     */
    resolution_options?: Array<string>;
    /**
     * 该模型允许的时长秒数（能力表的上下限 ∩ 业务白名单）
     */
    duration_options?: Array<number>;
    /**
     * 四项设置的**中文结论**：哪一项被采纳、哪一项因为不在能力表内没有被采纳；页面直接展示它，不展示能力表原值
     */
    settings_notes?: Array<string>;
    /**
     * provider 是否在既有的 openai/volcengine/apimart 白名单内
     */
    provider_supported?: boolean;
    warnings?: Array<string>;
    guard_status?: string;
    note?: string;
};

