/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { DramaPlanDialogueDraft } from './DramaPlanDialogueDraft';
/**
 * 一个镜头（对应正式产物 ``shots`` + ``shot_details`` + ``shot_dialog_lines``）。
 */
export type DramaPlanShotDraft = {
    /**
     * 镜头序号（章节内唯一）
     */
    index?: number;
    /**
     * 镜头标题
     */
    title?: string;
    /**
     * 本镜出场角色名（必须出现在 characters 里；决定建哪些镜头↔角色关联）
     */
    characters?: Array<string>;
    /**
     * 剧本摘录（写进 shots.script_excerpt）
     */
    script_excerpt?: string;
    /**
     * 镜头整体描述（写进 shot_details.description）
     */
    description?: string;
    /**
     * 时长（秒，已归一到允许档位）
     */
    duration?: number;
    /**
     * 景别 code（ECU/CU/MCU/MS/MLS/LS/ELS）
     */
    camera_shot?: string;
    /**
     * 机位 code（EYE_LEVEL/HIGH_ANGLE/...）
     */
    angle?: string;
    /**
     * 运镜 code（STATIC/PAN/...）
     */
    movement?: string;
    /**
     * 动作拍点（按时间顺序）
     */
    action_beats?: Array<string>;
    /**
     * 本镜台词
     */
    dialogue?: Array<DramaPlanDialogueDraft>;
    /**
     * 本镜是否出现商品（决定是否建 shot 档关联行）
     */
    product_present?: boolean;
};

