/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ApiResponse_VideoBundlePlanRead_ } from '../models/ApiResponse_VideoBundlePlanRead_';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class StudioVideoDeliveryService {
    /**
     * 出口B 批量下载预检（包含几条 / 排除几条，不读文件字节）
     * @returns ApiResponse_VideoBundlePlanRead_ Successful Response
     * @throws ApiError
     */
    public static previewVideoBundleApiV1StudioVideoDeliveryProjectIdBundlePlanGet({
        projectId,
        scope = 'episodes',
        chapterId,
        shotId,
        shotIds,
    }: {
        projectId: string,
        /**
         * 范围：current_shot / episode / episodes
         */
        scope?: string,
        /**
         * 当前集范围时的章节 ID
         */
        chapterId?: (string | null),
        /**
         * 当前镜头范围时的镜头 ID
         */
        shotId?: (string | null),
        /**
         * 选中镜头范围：逗号分隔的镜头 ID（优先于 chapter_id）
         */
        shotIds?: (string | null),
    }): CancelablePromise<ApiResponse_VideoBundlePlanRead_> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/v1/studio/video-delivery/{project_id}/bundle/plan',
            path: {
                'project_id': projectId,
            },
            query: {
                'scope': scope,
                'chapter_id': chapterId,
                'shot_id': shotId,
                'shot_ids': shotIds,
            },
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 出口B 批量下载成片 ZIP（仅含生成成功的成片 + 交付清单）
     * @returns any Successful Response
     * @throws ApiError
     */
    public static downloadVideoBundleApiV1StudioVideoDeliveryProjectIdBundleGet({
        projectId,
        scope = 'episodes',
        chapterId,
        shotId,
        shotIds,
    }: {
        projectId: string,
        /**
         * 范围：current_shot / episode / episodes
         */
        scope?: string,
        /**
         * 当前集范围时的章节 ID
         */
        chapterId?: (string | null),
        /**
         * 当前镜头范围时的镜头 ID
         */
        shotId?: (string | null),
        /**
         * 选中镜头范围：逗号分隔的镜头 ID
         */
        shotIds?: (string | null),
    }): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/v1/studio/video-delivery/{project_id}/bundle',
            path: {
                'project_id': projectId,
            },
            query: {
                'scope': scope,
                'chapter_id': chapterId,
                'shot_id': shotId,
                'shot_ids': shotIds,
            },
            errors: {
                422: `Validation Error`,
            },
        });
    }
}
