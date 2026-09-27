/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 商品与导演要求（用户填写）。
 */
export type DramaBrief = {
    /**
     * 商品名称（同时用作自动建章节时的标题）
     */
    product_name?: string;
    /**
     * 商品外观描述（会作为商品资产的外观描述）
     */
    product_description?: string;
    /**
     * 卖点列表
     */
    selling_points?: Array<string>;
    /**
     * 目标人群
     */
    target_audience?: string;
    /**
     * 题材（与项目 style 对齐，缺省沿用项目）
     */
    genre?: string;
    /**
     * 调性（例如：一本正经地荒诞 / 温情 / 爽感）
     */
    tone?: string;
    /**
     * 整片目标时长（秒），0 = 由镜头数与档位推算
     */
    duration_seconds?: number;
    /**
     * 期望镜头数
     */
    shot_count?: number;
    /**
     * 品牌调性 / 品牌规则
     */
    brand_voice?: string;
    /**
     * 必须出现的内容
     */
    mandatory_elements?: Array<string>;
    /**
     * 禁止出现的内容
     */
    forbidden_elements?: Array<string>;
    /**
     * 导演备注（本次的额外要求）
     */
    director_notes?: string;
};

