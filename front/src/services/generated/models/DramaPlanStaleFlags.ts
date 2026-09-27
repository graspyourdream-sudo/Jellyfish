/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 过期标记（``drama_plan_drafts.stale_flags``）：改了上一步就标下一步过期。
 *
 * 为什么用"时间戳 + 派生布尔"而不是只存布尔：布尔只能表达"现在过期了"，
 * 时间戳还能回答"过期是怎么来的"（改过一句话、还是改过完整剧情），
 * 重生成之后布尔会自动回到 false（生成时间晚于改动时间），不需要额外的清除逻辑。
 *
 * ``model_config.extra="ignore"``：老行里可能有别的键，读到不该炸（读模型只负责下发）。
 */
export type DramaPlanStaleFlags = {
    /**
     * 一句话核心创意最后一次被改动的时间（ISO 串）
     */
    one_liner_changed_at?: string;
    /**
     * 完整剧情最后一次被改动的时间（ISO 串）
     */
    story_changed_at?: string;
    /**
     * 完整剧情最后一次由模型生成的时间（ISO 串）
     */
    story_generated_at?: string;
    /**
     * 分镜最后一次由模型生成的时间（ISO 串）
     */
    shots_generated_at?: string;
    /**
     * 一句话改过之后没重新生成完整剧情 → true
     */
    story_stale?: boolean;
    /**
     * 完整剧情改过之后没重新生成分镜 → true
     */
    shots_stale?: boolean;
    /**
     * 给用户看的中文过期原因（空 = 没有任何过期）
     */
    reasons?: Array<string>;
};

