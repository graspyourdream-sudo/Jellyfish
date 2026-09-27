/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 结构化资产清单的生成请求（全部可空：默认只用本章剧本 + 分镜 + 模型配置）。
 */
export type ChapterAssetProfileBuildRequest = {
    /**
     * 附加要求（可选；会进提示词的「附加要求」段）
     */
    extra_instructions?: string;
    /**
     * 是否**强制重新分析**。默认 false：库里有这份清单就直接读库返回（不调用模型、不花钱）；true 才会重新调用文本模型，并把新结果逐条对账入库（已确认/人工改过的行只记待决定，不覆盖）。
     */
    refresh?: boolean;
};

