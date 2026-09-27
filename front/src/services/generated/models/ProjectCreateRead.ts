/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ProjectStartMode } from './ProjectStartMode';
import type { ProjectVisualStyle } from './ProjectVisualStyle';
/**
 * 创建项目后的响应：多一个 `chapter_id`。
 *
 * 为什么需要它：剧情广告创建后要**直接进剧情策划页**，而策划页是章节级的；
 * 让创建接口把"刚建好的默认章节"回给前端，页面就不必再猜/再查一次
 * （少一次往返，也避免创建成功却进不去策划页的中间态）。
 */
export type ProjectCreateRead = {
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
    id: string;
    /**
     * 创建时间
     */
    created_at?: (string | null);
    /**
     * 最后更新时间
     */
    updated_at?: (string | null);
    /**
     * 剧情广告阶段（仅 kind=ad）：product/story/storyboard/ready/confirmed
     */
    ad_phase?: string;
    /**
     * 剧情广告阶段的中文说明（页面直接用）
     */
    ad_phase_label?: string;
    /**
     * 自动建立的默认章节 ID（kind=ad 时必定有值）
     */
    chapter_id?: string;
};

