/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ApiResponse_dict_str__Any__ } from '../models/ApiResponse_dict_str__Any__';
import type { ApiResponse_NoneType_ } from '../models/ApiResponse_NoneType_';
import type { ApiResponse_PaginatedData_ProjectRead__ } from '../models/ApiResponse_PaginatedData_ProjectRead__';
import type { ApiResponse_ProjectAssetReadinessRead_ } from '../models/ApiResponse_ProjectAssetReadinessRead_';
import type { ApiResponse_ProjectCreateRead_ } from '../models/ApiResponse_ProjectCreateRead_';
import type { ApiResponse_ProjectRead_ } from '../models/ApiResponse_ProjectRead_';
import type { ApiResponse_ProjectStyleOptionsRead_ } from '../models/ApiResponse_ProjectStyleOptionsRead_';
import type { ProjectCreate } from '../models/ProjectCreate';
import type { ProjectUpdate } from '../models/ProjectUpdate';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class StudioProjectsService {
    /**
     * 获取项目风格候选项
     * @returns ApiResponse_ProjectStyleOptionsRead_ Successful Response
     * @throws ApiError
     */
    public static getProjectStyleOptionsApiV1StudioProjectsStyleOptionsGet(): CancelablePromise<ApiResponse_ProjectStyleOptionsRead_> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/v1/studio/projects/style-options',
        });
    }
    /**
     * 项目列表（分页）
     * @returns ApiResponse_PaginatedData_ProjectRead__ Successful Response
     * @throws ApiError
     */
    public static listProjectsApiV1StudioProjectsGet({
        q,
        order,
        isDesc = true,
        page = 1,
        pageSize = 10,
    }: {
        /**
         * 关键字，过滤 name/description
         */
        q?: (string | null),
        /**
         * 排序字段
         */
        order?: (string | null),
        /**
         * 是否倒序（默认按创建时间倒序：最新项目在最上面）
         */
        isDesc?: boolean,
        page?: number,
        pageSize?: number,
    }): CancelablePromise<ApiResponse_PaginatedData_ProjectRead__> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/v1/studio/projects',
            query: {
                'q': q,
                'order': order,
                'is_desc': isDesc,
                'page': page,
                'page_size': pageSize,
            },
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 创建项目（kind=ad 时为剧情广告：自动建默认章节 + 登记商品资料来源 + 写好制作要求）
     * @returns ApiResponse_ProjectCreateRead_ Successful Response
     * @throws ApiError
     */
    public static createProjectApiV1StudioProjectsPost({
        requestBody,
    }: {
        requestBody: ProjectCreate,
    }): CancelablePromise<ApiResponse_ProjectCreateRead_> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/v1/studio/projects',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 获取项目
     * @returns ApiResponse_ProjectRead_ Successful Response
     * @throws ApiError
     */
    public static getProjectApiV1StudioProjectsProjectIdGet({
        projectId,
    }: {
        projectId: string,
    }): CancelablePromise<ApiResponse_ProjectRead_> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/v1/studio/projects/{project_id}',
            path: {
                'project_id': projectId,
            },
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 更新项目
     * @returns ApiResponse_ProjectRead_ Successful Response
     * @throws ApiError
     */
    public static updateProjectApiV1StudioProjectsProjectIdPatch({
        projectId,
        requestBody,
    }: {
        projectId: string,
        requestBody: ProjectUpdate,
    }): CancelablePromise<ApiResponse_ProjectRead_> {
        return __request(OpenAPI, {
            method: 'PATCH',
            url: '/api/v1/studio/projects/{project_id}',
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
    /**
     * 删除项目
     * @returns ApiResponse_NoneType_ Successful Response
     * @throws ApiError
     */
    public static deleteProjectApiV1StudioProjectsProjectIdDelete({
        projectId,
    }: {
        projectId: string,
    }): CancelablePromise<ApiResponse_NoneType_> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/v1/studio/projects/{project_id}',
            path: {
                'project_id': projectId,
            },
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 项目资产准备清单（角色/场景/道具/服装同一口径）
     * 第 2 步「资产准备」的**唯一数据源**。
     *
     * 资产表格、顶部统计与步骤判定都读这一份清单，不再各自去看
     * `project_scene_links` / `project_prop_links` 之类关联行的读模型里
     * 是否**偶然**带了 `image_prompts` —— 那正是「保存了提示词仍显示待完善」的根因。
     * @returns ApiResponse_ProjectAssetReadinessRead_ Successful Response
     * @throws ApiError
     */
    public static getProjectAssetReadinessApiV1StudioProjectsProjectIdAssetReadinessGet({
        projectId,
    }: {
        projectId: string,
    }): CancelablePromise<ApiResponse_ProjectAssetReadinessRead_> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/v1/studio/projects/{project_id}/asset-readiness',
            path: {
                'project_id': projectId,
            },
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 批量保存资产图片提示词（后端质量拦截 + 跨资产查重 + 覆盖保护）
     * 资产准备页「确认保存」的**唯一批量入口**（一次请求一个事务，全有或全无）。
     *
     * 为什么必须放在后端而不是各页面各写一遍：
     *
     * - **质量拦截**（422，结构化中文错误、可照做修）：空提示词、
     * 含「外观信息不足 / 需人工补充」这类空话、只有资产名 + 通用摄影词
     * （去掉资产名与景别/机位/背景/画质词后没有任何该资产的特征）；
     * - **跨资产查重**（409）：两个**不同**资产生成了逐字相同或高度重复的内容
     * （同一资产的正面/侧面不在此列）——这正是"一段文本给两个角色"的线上症状；
     * - **覆盖保护**（409）：已有提示词槽位默认不动，要覆盖必须显式传
     * ``confirm_replace_image_prompt=true``；
     * - **合并写入**：只写本次提交的槽位，其它槽位原样保留。
     *
     * 任何一项不合规 → 整批拒绝、库里零改动；成功返回里带每项实际写入的槽位。
     * 请求体用原始 ``dict``：这样 ``confirm_replace_image_prompt`` 这类开关字段
     * 与既有 ``primary_protection`` 的口径一致（未知字段照旧被忽略，向后兼容）。
     * @returns ApiResponse_dict_str__Any__ Successful Response
     * @throws ApiError
     */
    public static saveProjectAssetImagePromptsApiV1StudioProjectsProjectIdAssetImagePromptsPost({
        projectId,
        requestBody,
    }: {
        projectId: string,
        requestBody: Record<string, any>,
    }): CancelablePromise<ApiResponse_dict_str__Any__> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/v1/studio/projects/{project_id}/asset-image-prompts',
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
