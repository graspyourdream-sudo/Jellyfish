/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 一个待提交给出图服务的单资产单图任务（预览用）。
 */
export type SubmissionTargetRead = {
    /**
     * 幂等键；同资产同提示词重复提交不会重复出图
     */
    source_task_id: string;
    source_asset_id: string;
    asset_type: string;
    name?: string;
    prompt?: string;
    stage?: string;
    negative_prompt?: string;
    style_tags?: Array<string>;
    /**
     * 随请求一起发出的**已有参考图**地址（定版主图）。为空＝纯提示词生成，这正是默认主流程的常态（按提示词直接生成参考图，不需要已有图）
     */
    reference_image?: string;
    generation_type?: string;
    aspect_ratio?: string;
    image_model?: string;
    object_key_template?: string;
    /**
     * 提示词来源：request（调用方显式传）/ saved（已保存的 image_prompts）/ template（确定性模板）
     */
    prompt_source?: string;
    /**
     * 本类型的结果类型标签（新，机器可读）：characterReference（**仅人物**）/ sceneAssetImage / propAssetImage / costumeDesignImage
     */
    result_kind?: string;
    /**
     * 结果类型的中文标签（新）：人物参考图 / 场景资产图 / 道具资产图 / 服装设定图
     */
    result_label?: string;
    /**
     * 本类型画幅的来源（新）：character_reference_fixed（人物参考图写死 16:9）/ request（调用方传入）/ asset_type_default（类型映射：场景 16:9、道具 1:1）/ default（管线默认）
     */
    aspect_ratio_source?: string;
    /**
     * 本类型使用的提示词模板名（新，审计用）
     */
    prompt_template?: string;
    /**
     * 本项使用的出图通道（新，机器可读，由 asset_type 分流决定）：vendor_service＝上游出图服务（人物/场景/道具）；apimart＝Jellyfish 自己的 APIMart 图片通道（服装不在上游契约内，走这条）
     */
    channel?: string;
    /**
     * 本项出图通道的中文名（新）：上游出图服务 / Jellyfish APIMart 图片通道
     */
    channel_label?: string;
    /**
     * 本次生成依据（新，只读）：项目风格 / 该资产的结构化资料（按项目 + 章节持久化保存）/ 剧本片段与出场分镜 / 资料来自哪里。页面「生成依据」面板直接读它，所以在**还没生成**的时候也能看到这份资产到底有什么资料 —— 不依赖先花一次模型调用。
     */
    generation_basis?: Record<string, any>;
    warnings?: Array<string>;
};

