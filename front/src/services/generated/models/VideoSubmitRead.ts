/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 直提出视频结果。
 */
export type VideoSubmitRead = {
    shot_id: string;
    provider?: string;
    status?: string;
    provider_task_id?: string;
    /**
     * 视频地址（临时地址，长期资产需落 OSS）
     */
    url?: string;
    /**
     * 本次调用是否已把视频落库（直接提交路径不落库）
     */
    file_persisted?: boolean;
    elapsed_ms?: number;
    error?: string;
    warnings?: Array<string>;
    guard_status?: string;
    /**
     * 本次使用的尝试序号（与请求一致）
     */
    attempt?: number;
    /**
     * true ＝ **没有**调用供应商：命中了同一轮（同一镜头＋同一参数＋同一 attempt）已存在的视频任务，直接复用它的结果/状态。用于刷新恢复与防重复计费
     */
    deduplicated?: boolean;
    /**
     * 本轮幂等键（同一轮重复提交是**同一个**键；点「重新生成」后会变成新键）。不含任何凭证，可安全展示/记录
     */
    source_task_id?: string;
    /**
     * 本轮落库的 generation_tasks.id（页面刷新后按它恢复任务状态）
     */
    task_id?: string;
    note?: string;
};

