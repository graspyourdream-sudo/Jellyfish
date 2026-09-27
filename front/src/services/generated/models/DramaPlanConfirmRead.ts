/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { DramaPlanNextStep } from './DramaPlanNextStep';
/**
 * 确认落库结果（materialize；**幂等**：第二次确认不新增任何镜头/资产）。
 */
export type DramaPlanConfirmRead = {
    chapter_id?: string;
    /**
     * 本次新建的镜头数（第二次确认为 0）
     */
    shots_created?: number;
    /**
     * 就地更新的镜头数（第一次确认为 0）
     */
    shots_updated?: number;
    dialog_lines_created?: number;
    /**
     * 就地更新的台词行数
     */
    dialog_lines_updated?: number;
    characters_created?: number;
    scenes_created?: number;
    product_created?: boolean;
    /**
     * 本次新建的资产总数（人物 + 场景 + 商品）
     */
    assets_created?: number;
    /**
     * 复用的既有资产数（同名即同一个资产，不重复建）
     */
    assets_reused?: number;
    /**
     * 本次登记的来源关系行数（幂等复核：第二次确认应为 0）
     */
    materials_linked?: number;
    /**
     * 带商品的镜头数（用于「至少一半镜头」核对）
     */
    shot_product_links?: number;
    shot_character_links?: number;
    warnings?: Array<string>;
    /**
     * 没落的东西 + 为什么（不静默）
     */
    skipped?: Array<string>;
    /**
     * 下一步（页面据此换按钮）
     */
    next_step?: DramaPlanNextStep;
    /**
     * 边界说明（由服务层填，路由同时放进 meta）
     */
    note?: string;
};

