/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 一次出图提交的结果。
 */
export type ImageTaskResultRead = {
    source_task_id: string;
    source_asset_id: string;
    asset_type?: string;
    stage?: string;
    service_task_id?: string;
    status?: string;
    ok?: boolean;
    dry_run?: boolean;
    /**
     * 出图服务的本地/临时地址（非长期资产）
     */
    image_url?: string;
    /**
     * 长期资产地址；DRY_RUN 下为空
     */
    oss_url?: string;
    message?: string;
};

