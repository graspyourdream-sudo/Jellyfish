/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ApiResponse_AssetVoiceClearRead_ } from '../models/ApiResponse_AssetVoiceClearRead_';
import type { ApiResponse_AssetVoiceRead_ } from '../models/ApiResponse_AssetVoiceRead_';
import type { ApiResponse_list_AssetVoiceRead__ } from '../models/ApiResponse_list_AssetVoiceRead__';
import type { AssetVoiceBindRequest } from '../models/AssetVoiceBindRequest';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class StudioAssetVoicesService {
    /**
     * 列出项目下全部资产声音绑定（只读、免费）
     * 一次取回整个项目的资产声音：资产准备页一屏几十项，逐项查会变成 N 次请求。
     * @returns ApiResponse_list_AssetVoiceRead__ Successful Response
     * @throws ApiError
     */
    public static listAssetVoicesApiV1StudioAssetVoicesGet({
        projectId,
    }: {
        /**
         * 项目 ID
         */
        projectId: string,
    }): CancelablePromise<ApiResponse_list_AssetVoiceRead__> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/v1/studio/asset-voices',
            query: {
                'project_id': projectId,
            },
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 读取某个资产的资产声音（只读、免费）
     * @returns ApiResponse_AssetVoiceRead_ Successful Response
     * @throws ApiError
     */
    public static getAssetVoiceApiV1StudioAssetVoicesAssetTypeAssetIdGet({
        assetType,
        assetId,
    }: {
        assetType: string,
        assetId: string,
    }): CancelablePromise<ApiResponse_AssetVoiceRead_> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/v1/studio/asset-voices/{asset_type}/{asset_id}',
            path: {
                'asset_type': assetType,
                'asset_id': assetId,
            },
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 给资产绑定声音（免费；同一事务内保证一个资产只有一个生效声音）
     * 绑定资产声音。
     *
     * 服务层在**同一事务**里先删该资产的旧 ``asset_voice`` 行再插新行，
     * 所以这里不会出现"一个资产两个生效声音"的中间态。
     * @returns ApiResponse_AssetVoiceRead_ Successful Response
     * @throws ApiError
     */
    public static putAssetVoiceApiV1StudioAssetVoicesAssetTypeAssetIdPut({
        assetType,
        assetId,
        requestBody,
    }: {
        assetType: string,
        assetId: string,
        requestBody: AssetVoiceBindRequest,
    }): CancelablePromise<ApiResponse_AssetVoiceRead_> {
        return __request(OpenAPI, {
            method: 'PUT',
            url: '/api/v1/studio/asset-voices/{asset_type}/{asset_id}',
            path: {
                'asset_type': assetType,
                'asset_id': assetId,
            },
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 解绑资产的资产声音（免费）
     * @returns ApiResponse_AssetVoiceClearRead_ Successful Response
     * @throws ApiError
     */
    public static deleteAssetVoiceApiV1StudioAssetVoicesAssetTypeAssetIdDelete({
        assetType,
        assetId,
    }: {
        assetType: string,
        assetId: string,
    }): CancelablePromise<ApiResponse_AssetVoiceClearRead_> {
        return __request(OpenAPI, {
            method: 'DELETE',
            url: '/api/v1/studio/asset-voices/{asset_type}/{asset_id}',
            path: {
                'asset_type': assetType,
                'asset_id': assetId,
            },
            errors: {
                422: `Validation Error`,
            },
        });
    }
}
