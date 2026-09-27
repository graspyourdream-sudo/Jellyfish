/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AdProductSource } from './AdProductSource';
import type { AdRequirements } from './AdRequirements';
import type { ProjectStartMode } from './ProjectStartMode';
import type { ProjectVisualStyle } from './ProjectVisualStyle';
export type ProjectCreate = {
    /**
     * 项目名称
     */
    name: string;
    /**
     * 项目简介
     */
    description?: string;
    /**
     * 题材/风格（可用预设值，也可自定义）
     */
    style: string;
    /**
     * 画面表现形式
     */
    visual_style?: ProjectVisualStyle;
    /**
     * 随机种子
     */
    seed?: number;
    /**
     * 是否统一风格
     */
    unify_style?: boolean;
    /**
     * 进度百分比（0-100）
     */
    progress?: number;
    /**
     * 项目级默认视频比例；分镜未覆盖时生效
     */
    default_video_ratio?: (string | null);
    /**
     * 项目起点：script=从剧本开始；prompts=从视频提示词开始
     */
    start_mode?: ProjectStartMode;
    /**
     * 项目类型：drama=普通短剧；ad=剧情广告（先做商品卡与剧情策划）
     */
    kind?: 'drama' | 'ad';
    /**
     * 聚合统计（JSON）
     */
    stats?: Record<string, any>;
    /**
     * 项目 ID
     */
    id: string;
    /**
     * 商品资料来源（仅 kind=ad）
     */
    ad_product_source?: (AdProductSource | null);
    /**
     * 基本制作要求（仅 kind=ad）
     */
    ad_requirements?: (AdRequirements | null);
};

