/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { EntityProfileInput } from './EntityProfileInput';
import type { PromptCategory } from './PromptCategory';
/**
 * 图片提示词预览请求。
 *
 * ``shot_id`` 与 ``shot_text`` 至少给一个；``entity_profiles`` 为空时按
 * ``project_id``（或镜头所属项目）自动装载实体画像。
 */
export type ImagePromptPreviewRequest = {
    /**
     * 镜头 ID（用于装载镜头文本与项目实体）
     */
    shot_id?: (string | null);
    /**
     * 直接传入的镜头文本
     */
    shot_text?: (string | null);
    /**
     * 项目 ID（用于装载实体画像）
     */
    project_id?: (string | null);
    /**
     * 章节 ID（资产级常用）：装载实体画像时只读**本章**的章节资料（overlay）。场景/道具/服装是全局资产，本章的剧情身份、出场依据、临时补充按章节隔离保存，给上 chapter_id 才不会串到别的章节。
     */
    chapter_id?: (string | null);
    /**
     * 实体画像（覆盖自动装载）
     */
    entity_profiles?: Array<EntityProfileInput>;
    /**
     * 只保留这些名称的实体（在自动装载的画像卡上过滤）。页面「逐资产生成」用它把一次请求收窄到一个资产，同时仍然享受 chapter_id 的章节资料加载。
     */
    entity_names?: Array<string>;
    /**
     * 需要生成的槽位类别；为空时生成全部默认槽位
     */
    categories?: (Array<PromptCategory> | null);
    /**
     * 风格提示
     */
    style_hint?: string;
    /**
     * 全局负面提示词
     */
    negative_prompt?: string;
    /**
     * 附加要求（可选）
     */
    extra_instructions?: string;
};

