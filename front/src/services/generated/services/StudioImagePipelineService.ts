/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AdoptImageRequest } from '../models/AdoptImageRequest';
import type { ApiResponse_AdoptImageRead_ } from '../models/ApiResponse_AdoptImageRead_';
import type { ApiResponse_FrameSubmitPlanRead_ } from '../models/ApiResponse_FrameSubmitPlanRead_';
import type { ApiResponse_FrameSubmitRead_ } from '../models/ApiResponse_FrameSubmitRead_';
import type { ApiResponse_ImagePlanPreviewRead_ } from '../models/ApiResponse_ImagePlanPreviewRead_';
import type { ApiResponse_ImageServiceStatusRead_ } from '../models/ApiResponse_ImageServiceStatusRead_';
import type { ApiResponse_ImageSubmitRead_ } from '../models/ApiResponse_ImageSubmitRead_';
import type { ApiResponse_ImageTaskQueryRead_ } from '../models/ApiResponse_ImageTaskQueryRead_';
import type { ApiResponse_PromptPackageRead_ } from '../models/ApiResponse_PromptPackageRead_';
import type { ApiResponse_ReferenceRegenerateRead_ } from '../models/ApiResponse_ReferenceRegenerateRead_';
import type { ApiResponse_VideoSubmitPlanRead_ } from '../models/ApiResponse_VideoSubmitPlanRead_';
import type { ApiResponse_VideoSubmitRead_ } from '../models/ApiResponse_VideoSubmitRead_';
import type { FrameSubmitPlanRequest } from '../models/FrameSubmitPlanRequest';
import type { FrameSubmitRequest } from '../models/FrameSubmitRequest';
import type { ImagePlanPreviewRequest } from '../models/ImagePlanPreviewRequest';
import type { ImageSubmitRequest } from '../models/ImageSubmitRequest';
import type { PromptPackageRequest } from '../models/PromptPackageRequest';
import type { ReferenceRegenerateRequest } from '../models/ReferenceRegenerateRequest';
import type { VideoSubmitPlanRequest } from '../models/VideoSubmitPlanRequest';
import type { VideoSubmitRequest } from '../models/VideoSubmitRequest';
import type { CancelablePromise } from '../core/CancelablePromise';
import { OpenAPI } from '../core/OpenAPI';
import { request as __request } from '../core/request';
export class StudioImagePipelineService {
    /**
     * 出图服务对接状态（DRY_RUN 下不探测）
     * 返回出图服务基址、守卫状态与契约能力；DRY_RUN 下**不发起健康探测**。
     *
     * 新增 ``channels``：资产类型 → 出图通道。人物/场景/道具走上游出图服务；
     * **服装走 Jellyfish 自己的 APIMart 图片通道**（上游契约里没有 costume），
     * 页面据此说明「服装为什么不在上游服务里」，不需要自己硬编码。
     * @returns ApiResponse_ImageServiceStatusRead_ Successful Response
     * @throws ApiError
     */
    public static getImagePipelineStatusApiV1StudioImagePipelineStatusGet(): CancelablePromise<ApiResponse_ImageServiceStatusRead_> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/v1/studio/image-pipeline/status',
        });
    }
    /**
     * 出图提交计划预览（定妆照 / 参考图批量，不触网）
     * 组装提交计划：幂等键、参考图来源、OSS 对象键模板、**通道**，全部只读。
     *
     * 默认主流程是**按提示词直接生成参考图**（不给参考图也能出图）；
     * ``reference_batch`` 只是额外把该资产已定版的那张图随请求带上去（**只对人物开放**）。
     *
     * **按 asset_type 分通道**（逐项分流，不静默）：人物/场景/道具 → 上游出图服务；
     * 服装（costume）→ Jellyfish 自己的 APIMart 图片通道（上游契约里没有 costume）。
     * 本接口传 ``items`` 就是混合批量：一次预览四类资产的通道与模板。
     * @returns ApiResponse_ImagePlanPreviewRead_ Successful Response
     * @throws ApiError
     */
    public static previewImagePlanApiV1StudioImagePipelinePlanPreviewPost({
        requestBody,
    }: {
        requestBody: ImagePlanPreviewRequest,
    }): CancelablePromise<ApiResponse_ImagePlanPreviewRead_> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/v1/studio/image-pipeline/plan/preview',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 提交出图任务（DRY_RUN 下返回占位结果，不触网）
     * 受守卫的出图提交。默认 DRY_RUN：返回占位 task_id 与不可达占位地址。
     *
     * **按 asset_type 逐项分流通道**（不静默）：人物/场景/道具 → 上游出图服务；
     * 服装（costume）→ Jellyfish 自己的 APIMart 图片通道（上游契约里没有 costume，
     * 把服装当人物/场景发过去正是「套模板」）。每条结果都带 ``channel`` 如实回报，
     * 汇总里另有 ``by_channel`` 整数计数。
     *
     * 一次提交里同时含多类资产（``items``）时为**混合批量**：逐项按类型选通道与模板，
     * 任一项失败只影响它自己那一条结果，不会污染其它项的结论。
     *
     * 提交前会逐张探活每一条参考图 URL（``preflight_guard``）：不可达就**一个请求都不提交**，
     * 返回结构化中文错误（哪张图 / 哪个资产 / 实际状态码 / 怎么修），且不产生任何付费调用。
     * @returns ApiResponse_ImageSubmitRead_ Successful Response
     * @throws ApiError
     */
    public static submitImagePlanApiV1StudioImagePipelineSubmitPost({
        requestBody,
    }: {
        requestBody: ImageSubmitRequest,
    }): CancelablePromise<ApiResponse_ImageSubmitRead_> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/v1/studio/image-pipeline/submit',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 查询出图任务（回读 OSS 地址）
     * 查询出图任务状态与产物地址。DRY_RUN 下不触网，直接返回未创建说明。
     * @returns ApiResponse_ImageTaskQueryRead_ Successful Response
     * @throws ApiError
     */
    public static queryImageTaskApiV1StudioImagePipelineTaskServiceTaskIdGet({
        serviceTaskId,
    }: {
        serviceTaskId: string,
    }): CancelablePromise<ApiResponse_ImageTaskQueryRead_> {
        return __request(OpenAPI, {
            method: 'GET',
            url: '/api/v1/studio/image-pipeline/task/{service_task_id}',
            path: {
                'service_task_id': serviceTaskId,
            },
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 使用已有参考图重新生成（可选返工；默认主流程是按提示词直接生成）
     * 用该资产**已有的参考图**重新生成一张图。
     *
     * 与默认主流程的分工：
     *
     * - **默认主流程**：``POST /image-pipeline/submit`` —— 按提示词**直接生成参考图**：
     * 不传参考图照样出图，前端文案也不要把它描述成需要已有图的工作流；
     * - **本端点（可选返工 = 使用已有参考图重新生成）**：只有该资产已经有参考图、
     * 且用户明确要保一致性时才用。它走 **Jellyfish 自己的 APIMart 图片通道**
     * （参考图字段 ``image_urls``），把**公网可用**的那张参考图真的传进请求；
     * **不**把参考图交给上游服务端点（那个端点对带参考图的生成有已知限制）。
     *
     * 安全口径：
     *
     * - 参考图必须是公网地址：本机相对路径 / 内网地址在这里就判死（409）；
     * - 提交前逐张匿名探活（``preflight_guard``）：不可达 → 409 + 结构化中文错误
     * （哪个资产、真实状态码、怎么修、``paid_call_made:false``），**不提交、不写库、不出网**；
     * - 受付费守卫约束：DRY_RUN 下返回占位结果、一个字节都不出网；
     * - 幂等键复用 ``build_source_task_id``（含 ``attempt``）：同一轮重复点击**不会重复付费**
     * （同一轮直接复用上一轮结果，``deduplicated=true``）。
     * @returns ApiResponse_ReferenceRegenerateRead_ Successful Response
     * @throws ApiError
     */
    public static regenerateWithExistingReferenceRouteApiV1StudioImagePipelineReferenceRegeneratePost({
        requestBody,
    }: {
        requestBody: ReferenceRegenerateRequest,
    }): CancelablePromise<ApiResponse_ReferenceRegenerateRead_> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/v1/studio/image-pipeline/reference-regenerate',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 直提出视频的计划预览（不建任务、不触网）
     * 解析供应商/模型/参考图/提示词，如实标注会踩的坑，但不提交任何任务。
     * @returns ApiResponse_VideoSubmitPlanRead_ Successful Response
     * @throws ApiError
     */
    public static previewVideoSubmitPlanApiV1StudioImagePipelineVideoPlanPreviewPost({
        requestBody,
    }: {
        requestBody: VideoSubmitPlanRequest,
    }): CancelablePromise<ApiResponse_VideoSubmitPlanRead_> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/v1/studio/image-pipeline/video-plan/preview',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 直提出视频（默认被 DRY_RUN 拦截，不产生费用）
     * 同步提交一次视频生成；DRY_RUN 开启时返回 dry_run 占位结果，不发任何请求。
     *
     * 真实提交前会做**第二层可达性复核**（``preflight_guard``）：本次真正发往供应商的
     * 首/尾/关键帧参考图与参考音频地址，逐张匿名探活；不可达就不发请求、不产生费用
     * （真实故障 A 就是这里把只在本机可读的地址交给了上游）。
     * @returns ApiResponse_VideoSubmitRead_ Successful Response
     * @throws ApiError
     */
    public static submitVideoRouteApiV1StudioImagePipelineVideoSubmitPost({
        requestBody,
    }: {
        requestBody: VideoSubmitRequest,
    }): CancelablePromise<ApiResponse_VideoSubmitRead_> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/v1/studio/image-pipeline/video-submit',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 关键帧出图计划预览（不触网、不建任务、不写库）
     * 如实展示「这一帧会用什么提示词、带哪些参考图、什么画幅」——全部只读。
     * @returns ApiResponse_FrameSubmitPlanRead_ Successful Response
     * @throws ApiError
     */
    public static previewFramePlanApiV1StudioImagePipelineFramePlanPreviewPost({
        requestBody,
    }: {
        requestBody: FrameSubmitPlanRequest,
    }): CancelablePromise<ApiResponse_FrameSubmitPlanRead_> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/v1/studio/image-pipeline/frame-plan/preview',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 关键帧出图（同进程内联执行；DRY_RUN 下只回计划不写库）
     * 在**同一个进程内**跑完一次关键帧出图，并把结果写进 ``shot_frame_images.file_id``。
     *
     * 为什么不用队列：本机没有 broker/worker，队列路径只会留下一条永远不执行的「排队中」，
     * 用户看到的就是「点了生成什么也没发生」。同进程内联执行是 P3 直提端点既有的做法。
     *
     * 提交前会逐张探活参考图（``preflight_guard``）：不可达就在**写库/建任务之前**拒绝，
     * 返回结构化中文错误，一次付费调用都不产生。
     * @returns ApiResponse_FrameSubmitRead_ Successful Response
     * @throws ApiError
     */
    public static submitFrameRouteApiV1StudioImagePipelineFrameSubmitPost({
        requestBody,
    }: {
        requestBody: FrameSubmitRequest,
    }): CancelablePromise<ApiResponse_FrameSubmitRead_> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/v1/studio/image-pipeline/frame-submit',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 采纳生成的图片到资产图片槽位（落库，刷新后仍在）
     * 把出图结果（oss_url / local_path）下载入库并写回图片槽位。
     *
     * 这是断点③的落点：出图提交本身不写库，必须由用户显式"采纳"才落正式产物。
     * DRY_RUN 占位地址会被拒绝。
     *
     * **不静默替换定版**：``set_primary`` 默认 false；该资产已有定版图而本次会顶掉它时，
     * 必须显式传 ``confirm_replace_primary=true``，否则返回结构化 409
     * （``meta.error.existing_primary`` 里带将被替换那张图的只读摘要：槽位 id / 文件名 /
     * 是否 OSS 公网地址），并且**一行都不会改**（判定发生在下载入库之前）。
     * @returns ApiResponse_AdoptImageRead_ Successful Response
     * @throws ApiError
     */
    public static adoptGeneratedImageRouteApiV1StudioImagePipelineAdoptPost({
        requestBody,
    }: {
        requestBody: AdoptImageRequest,
    }): CancelablePromise<ApiResponse_AdoptImageRead_> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/v1/studio/image-pipeline/adopt',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                422: `Validation Error`,
            },
        });
    }
    /**
     * 提示词包导出（图片 + 视频 + 绑定资产 + 参考图，只读）
     * 把一个项目/一批镜头打成提示词包（json + text + markdown），不写库、不出图。
     * @returns ApiResponse_PromptPackageRead_ Successful Response
     * @throws ApiError
     */
    public static exportPromptPackageApiV1StudioImagePipelinePromptPackagePost({
        requestBody,
    }: {
        requestBody: PromptPackageRequest,
    }): CancelablePromise<ApiResponse_PromptPackageRead_> {
        return __request(OpenAPI, {
            method: 'POST',
            url: '/api/v1/studio/image-pipeline/prompt-package',
            body: requestBody,
            mediaType: 'application/json',
            errors: {
                422: `Validation Error`,
            },
        });
    }
}
