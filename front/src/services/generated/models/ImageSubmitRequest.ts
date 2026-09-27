/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ImageSubmitItemRequest } from './ImageSubmitItemRequest';
import type { PromptOverride } from './PromptOverride';
/**
 * 出图提交请求（受 DRY_RUN 守卫）。
 */
export type ImageSubmitRequest = {
    project_id: string;
    /**
     * 单类型形态的资产类型。**四类都支持**：人物/场景/道具走上游出图服务，服装走 Jellyfish 自己的 APIMart 图片通道（上游契约里没有 costume）。传了 items 时本字段被忽略。
     */
    asset_type?: 'character' | 'scene' | 'prop' | 'costume';
    /**
     * **混合批量**（新，可选）：一次提交里逐项声明资产类型与资产，后端逐项按 asset_type 选通道与模板。为空时按旧的单类型形态处理（asset_type + asset_ids）
     */
    items?: Array<ImageSubmitItemRequest>;
    /**
     * character_sheet＝不随请求带参考图；reference_batch＝随请求带上已定版的参考图（两者都是按提示词直接生成参考图，不需要已有图；**参考图只对人物开放**）
     */
    stage?: 'character_sheet' | 'reference_batch';
    /**
     * 为空表示项目内该类型全部资产
     */
    asset_ids?: Array<string>;
    /**
     * 用 P1 生成的提示词覆盖
     */
    prompt_overrides?: Array<PromptOverride>;
    /**
     * reference_batch 阶段是否把定版主图作为参考图随请求发出
     */
    use_primary_reference?: boolean;
    /**
     * 出图比例，如 16:9
     */
    aspect_ratio?: string;
    /**
     * 图片模型选项（留空=默认 image2 → provider 模型 gpt-image-2）
     */
    image_model?: string;
    /**
     * 全局负面提示词
     */
    negative_prompt?: string;
    /**
     * 章节 ID（可选，新）：给了就按**该章**装配 generation_basis（章节资产资料的隔离维度）；留空则不装配生成依据，其它行为完全不变
     */
    chapter_id?: string;
    /**
     * 有界等待产物秒数；0 表示不等
     */
    wait_seconds?: number;
    /**
     * 尝试序号（新，可选，默认 0 = 首轮）。**重试失败项时把这个数 +1**：幂等键 source_task_id 会把非 0 的序号混进哈希，于是拿到一个**新的**键，上游才会真的重新出图（改动前只哈希 项目+类型+资产+提示词前 8 位，同一资产同一提示词重试永远被上游按既有失败任务去重 → 重试无效）。**同一序号重复提交＝同一个幂等键**：上游按既有任务返回，不会并发重复下单（页面侧的「在途」闸门继续负责拦住同一轮里的连点）。本次实际使用的幂等键会逐条回显在结果的 source_task_id 上
     */
    attempt?: number;
};

