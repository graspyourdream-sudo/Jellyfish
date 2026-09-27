/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 「使用已有参考图重新生成」请求（**可选返工**，不是默认主流程）。
 *
 * 默认主流程是按提示词**直接生成参考图**（``POST /image-pipeline/submit``，不传参考图也
 * 照样出图）。本请求只在「该资产已经有参考图、且用户明确要保一致性」时才用：它走
 * Jellyfish 自己的 APIMart 图片通道，把公网可用的参考图真的传进请求。
 */
export type ReferenceRegenerateRequest = {
    project_id: string;
    /**
     * character / scene / prop / costume（本端点不经过上游服务端点，所以 costume 也可用）
     */
    asset_type?: 'character' | 'scene' | 'prop' | 'costume';
    /**
     * 资产 ID
     */
    asset_id: string;
    /**
     * 留空则用该资产**已保存**的图片提示词（image_prompts 槽位）
     */
    prompt?: string;
    /**
     * 已有参考图的槽位 id（图片行 ID）。与 reference_url 二选一；都不传则用该资产的定版/首选图
     */
    reference_image_id?: (number | null);
    /**
     * 显式指定已有参考图的公网地址（http/https）。与 reference_image_id 二选一
     */
    reference_url?: string;
    /**
     * 画幅比例（APIMart 只支持 1:1 / 3:4 / 16:9）。**人物参考图固定 16:9**：人物传别的值会被忽略并如实回报（16:9 是人物参考图/设定图的画幅，不是项目最终视频画幅）；场景/道具/服装按各自既有口径，留空=16:9 默认
     */
    target_ratio?: string;
    /**
     * 输出分辨率档位
     */
    resolution_profile?: 'standard' | 'high';
    /**
     * 图片模型 ID；留空用 DB 的默认图片模型（必须是 APIMart 供应商）
     */
    model_id?: (string | null);
    /**
     * 尝试序号（语义与 POST /submit 的 attempt 一致）：同一序号＝同一轮，**重复点击不会重复付费**（同一轮直接复用上一次结果）；要真的再生成一次请 +1
     */
    attempt?: number;
    /**
     * 同步等待的墙钟上限
     */
    timeout_seconds?: number;
};

