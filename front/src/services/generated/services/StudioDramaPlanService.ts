/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ApiResponse_DramaPlanConfirmRead_ } from '../models/ApiResponse_DramaPlanConfirmRead_';
import type { ApiResponse_DramaPlanConsistencyRead_ } from '../models/ApiResponse_DramaPlanConsistencyRead_';
import type { ApiResponse_DramaPlanRead_ } from '../models/ApiResponse_DramaPlanRead_';
import type { DramaBrief } from '../models/DramaBrief';
import type { DramaPlanGenerateRequest } from '../models/DramaPlanGenerateRequest';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class StudioDramaPlanService {
    /**
     * 读取剧情方案草稿（brief + 草稿 + 状态）· 免费出口：不调用模型、不产生费用
     * 只读：返回 brief 与草稿。**永不调用模型**。
     * @returns ApiResponse_DramaPlanRead_ Successful Response
     * @throws ApiError
     */
    public static getDramaPlanApiV1StudioChaptersChapterIdDramaPlanGet({
        chapterId,
    }: {
        chapterId: string,
    }): CancelablePromise<ApiResponse_DramaPlanRead_> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/v1/studio/chapters/{chapter_id}/drama-plan',
            path: {
                'chapter_id': chapterId,
            },
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 保存商品信息 brief · 免费出口：不调用模型、不产生费用
     * 保存 brief：**绝不触发模型调用**，也不动已生成的草稿。
     * @returns ApiResponse_DramaPlanRead_ Successful Response
     * @throws ApiError
     */
    public static putDramaPlanBriefApiV1StudioChaptersChapterIdDramaPlanBriefPut({
        chapterId,
        requestBody,
    }: {
        chapterId: string,
        requestBody: DramaBrief,
    }): CancelablePromise<ApiResponse_DramaPlanRead_> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/v1/studio/chapters/{chapter_id}/drama-plan/brief',
            path: {
                'chapter_id': chapterId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 保存人工编辑后的草稿（只写草稿列）· 免费出口：不调用模型、不产生费用
     * 保存手改的草稿：**免费**，只写 ``drama_plan_drafts.plan``，正式行一行都不碰。
     * @returns ApiResponse_DramaPlanRead_ Successful Response
     * @throws ApiError
     */
    public static putDramaPlanDraftApiV1StudioChaptersChapterIdDramaPlanDraftPut({
        chapterId,
        requestBody,
    }: {
        chapterId: string,
        requestBody: Record<string, any>,
    }): CancelablePromise<ApiResponse_DramaPlanRead_> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/v1/studio/chapters/{chapter_id}/drama-plan/draft',
            path: {
                'chapter_id': chapterId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 生成剧情方案草稿（按 stage 分层生成，一次模型调用）· 付费出口：真实调用一次大模型（租约防重复；演练模式下返回占位且不落草稿）
     * 生成草稿：抢租约 → 一次调用 → 只落草稿列（确认之前不写任何正式行）。
     *
     * 请求体可省略（默认 ``stage="all"``，与加 stage 之前的行为完全一致）。
     * ``stage`` 决定这次生成哪一段：``one_liner`` / ``story`` / ``storyboard`` / ``all``；
     * 人工编辑晚于上次生成时，必须带 ``confirm_overwrite=true``，否则 409。
     * @returns ApiResponse_DramaPlanRead_ Successful Response
     * @throws ApiError
     */
    public static postDramaPlanGenerateApiV1StudioChaptersChapterIdDramaPlanGeneratePost({
        chapterId,
        requestBody,
    }: {
        chapterId: string,
        requestBody?: (DramaPlanGenerateRequest | null),
    }): CancelablePromise<ApiResponse_DramaPlanRead_> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/v1/studio/chapters/{chapter_id}/drama-plan/generate',
            path: {
                'chapter_id': chapterId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 一致性检查（商品覆盖 / 未知角色与资产 / 剧情长度）· 免费出口：不调用模型、不产生费用
     * 一致性检查：**免费**，一次模型都不调，只做确定性的计数与文本核对。
     *
     * 没有草稿内容时返回 200 + ``ok=false``（"还没有内容"本身就是诊断结果），
     * 章节不存在才 404。
     * @returns ApiResponse_DramaPlanConsistencyRead_ Successful Response
     * @throws ApiError
     */
    public static postDramaPlanConsistencyApiV1StudioChaptersChapterIdDramaPlanConsistencyPost({
        chapterId,
    }: {
        chapterId: string,
    }): CancelablePromise<ApiResponse_DramaPlanConsistencyRead_> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/v1/studio/chapters/{chapter_id}/drama-plan/consistency',
            path: {
                'chapter_id': chapterId,
            },
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 确认落库（materialize，一个事务）· 免费出口：不调用模型、不产生费用
     * 把草稿落成正式产物；失败整体回滚，不会留下半个章节。
     * @returns ApiResponse_DramaPlanConfirmRead_ Successful Response
     * @throws ApiError
     */
    public static postDramaPlanConfirmApiV1StudioChaptersChapterIdDramaPlanConfirmPost({
        chapterId,
    }: {
        chapterId: string,
    }): CancelablePromise<ApiResponse_DramaPlanConfirmRead_> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/v1/studio/chapters/{chapter_id}/drama-plan/confirm',
            path: {
                'chapter_id': chapterId,
            },
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 取一个可用空章节（没有就建一个）· 免费出口：不调用模型、不产生费用
     * 项目级入口：返回该项目的"可用空章节"（优先复用，没有就按商品名建一个）。
     * @returns any Successful Response
     * @throws ApiError
     */
    public static postDramaPlanChapterApiV1StudioProjectsProjectIdDramaPlanChapterPost({
        projectId,
        requestBody,
    }: {
        projectId: string,
        requestBody?: (Record<string, any> | null),
    }): CancelablePromise<any> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/v1/studio/projects/{project_id}/drama-plan/chapter',
            path: {
                'project_id': projectId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                422: `Validation Error`,
            },
        });
    }
}
