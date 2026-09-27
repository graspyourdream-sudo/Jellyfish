/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { PromptOverride } from './PromptOverride';
/**
 * **混合批量**的一项：一个资产类型 + 要出图的资产 ID（新）。
 *
 * 为什么要有它：一次提交里可以同时含 character / scene / prop / costume，
 * 后端会**逐项**按 ``asset_type`` 选通道与模板（人物/场景/道具 → 上游出图服务；
 * 服装 → Jellyfish APIMart 图片通道）。**不传 items 时仍是旧的单类型形态**
 * （顶层 ``asset_type`` + ``asset_ids``），既有调用方一个字都不用改。
 *
 * 每项只声明"生成什么类型的哪些资产"；``stage`` / 画幅 / 负面提示词 / 图片模型 /
 * attempt 等公共参数由请求顶层给出（避免同一批里出现互相矛盾的公共参数）。
 */
export type ImageSubmitItemRequest = {
    /**
     * character / scene / prop / costume
     */
    asset_type: 'character' | 'scene' | 'prop' | 'costume';
    /**
     * 为空表示项目内该类型全部资产
     */
    asset_ids?: Array<string>;
    /**
     * 该项的逐资产提示词覆盖（用 P1 生成的提示词）
     */
    prompt_overrides?: Array<PromptOverride>;
};

