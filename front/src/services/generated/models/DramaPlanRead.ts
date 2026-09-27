/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { DramaBrief } from './DramaBrief';
import type { DramaPlanConsistencyRead } from './DramaPlanConsistencyRead';
import type { DramaPlanDraft } from './DramaPlanDraft';
import type { DramaPlanStaleFlags } from './DramaPlanStaleFlags';
/**
 * 草稿读取（``GET`` 与 ``generate`` 共用同一形状）。
 */
export type DramaPlanRead = {
    chapter_id?: string;
    project_id?: string;
    /**
     * 是否已保存过 brief（即草稿行是否存在）
     */
    has_draft?: boolean;
    /**
     * ""（未生成）/ running / ok / failed
     */
    status?: string;
    brief?: DramaBrief;
    /**
     * 归一化后的草稿；未生成过则为 null
     */
    plan?: (DramaPlanDraft | null);
    /**
     * 过期标记（一句话/完整剧情改过之后的提示依据）
     */
    stale_flags?: DramaPlanStaleFlags;
    /**
     * 一致性检查摘要（免费、确定性；空草稿时为 null）
     */
    consistency?: (DramaPlanConsistencyRead | null);
    /**
     * 失败原因
     */
    error?: string;
    /**
     * 本次生成使用的模型名
     */
    model?: string;
    /**
     * 运行元信息（不含任何密钥）
     */
    meta?: Record<string, any>;
    /**
     * 生成中租约的到期时间（ISO 串，空 = 无租约）
     */
    claim_expires_at?: string;
    /**
     * 草稿行最后更新时间（ISO 串）
     */
    updated_at?: string;
    /**
     * 策划确认状态：none=未确认 / draft=人工改过未确认 / confirmed=已确认
     */
    story_status?: string;
    /**
     * 策划确认时间（ISO 串，空 = 未确认）
     */
    confirmed_at?: string;
    /**
     * 落库时间（ISO 串，空 = 未落库）
     */
    materialized_at?: string;
    /**
     * 落库统计（镜头/资产/关联行/跳过项），页面刷新后回显
     */
    materialize_summary?: Record<string, any>;
    /**
     * 边界说明
     */
    note?: string;
};

