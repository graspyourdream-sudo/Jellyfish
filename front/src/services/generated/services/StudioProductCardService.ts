/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ApiResponse_ProductCardExtractRead_ } from '../models/ApiResponse_ProductCardExtractRead_';
import type { ApiResponse_ProductCardRead_ } from '../models/ApiResponse_ProductCardRead_';
import type { ProductCardExtractRequest } from '../models/ProductCardExtractRequest';
import type { ProductCardUpdate } from '../models/ProductCardUpdate';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class StudioProductCardService {
    /**
     * 读商品卡（服务端事实来源）· 免费出口：不调用模型、不产生费用
     * 读商品卡；没有卡时返回一张空卡（页面不必处理 null）。
     * @returns ApiResponse_ProductCardRead_ Successful Response
     * @throws ApiError
     */
    public static getProductCardApiV1StudioProjectsProjectIdProductCardGet({
        projectId,
    }: {
        projectId: string,
    }): CancelablePromise<ApiResponse_ProductCardRead_> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/v1/studio/projects/{project_id}/product-card',
            path: {
                'project_id': projectId,
            },
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 保存商品卡（confirmed=true 时校验必填）· 免费出口：不调用模型、不产生费用
     * 保存商品卡；必填项缺失时确认会被 409 拒绝（其余缺项保留为「待补充」）。
     * @returns ApiResponse_ProductCardRead_ Successful Response
     * @throws ApiError
     */
    public static putProductCardApiV1StudioProjectsProjectIdProductCardPut({
        projectId,
        requestBody,
    }: {
        projectId: string,
        requestBody: ProductCardUpdate,
    }): CancelablePromise<ApiResponse_ProductCardRead_> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/v1/studio/projects/{project_id}/product-card',
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
     * 从资料提取商品信息（粘贴/上传/选已有）· 付费出口：真实调用一次大模型（演练模式下不调用，返回未提取的说明）
     * 提取商品信息。**不生成剧情**：提取只写商品卡，剧情要用户确认商品卡后单独生成。
     * @returns ApiResponse_ProductCardExtractRead_ Successful Response
     * @throws ApiError
     */
    public static postProductCardExtractApiV1StudioProjectsProjectIdProductCardExtractPost({
        projectId,
        requestBody,
    }: {
        projectId: string,
        requestBody: ProductCardExtractRequest,
    }): CancelablePromise<ApiResponse_ProductCardExtractRead_> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/v1/studio/projects/{project_id}/product-card/extract',
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
