/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * **第 4 步「资产与声音检查」**里某镜「角色声音」的只读结论。
 *
 * 为什么是只读契约、而且没有对应的写接口（设计包 §10）：
 * 声音的唯一事实来源是**人物资产**（第 2 步人物资产详情是全站唯一绑定入口），
 * 第 4 步只做检查 —— 显示继承结果与来源、缺项时提示回人物资产补充。
 * "第 4 步能改声音"这件事在结构上就不该存在：这里没有 PUT / PATCH，
 * 字段也不足以驱动一次写入。
 *
 * ``state`` 是**机器可读**结论（页面负责翻成中文；主区不出现原值）：
 *
 * - ``inherited``：恰好一个角色绑了声音，这一镜继承它；
 * - ``ambiguous``：多个角色都绑了声音，系统**不替用户挑**，``candidates`` 列出候选；
 * - ``legacy_snapshot``：角色没绑，但这一镜还留着迁移前的逐镜声音（只读快照）；
 * - ``opt_out``：本镜已明确标记「无需声音」；
 * - ``missing``：角色没绑、也没有历史声音 → 缺项，应提示「返回人物资产补充」。
 */
export type ShotVoiceInheritanceRead = {
    /**
     * 镜头 ID
     */
    shot_id: string;
    /**
     * 只读结论（inherited / ambiguous / legacy_snapshot / opt_out / missing）
     */
    state: string;
    /**
     * 生效的声音文件 ID（内部标识，只进技术详情层）
     */
    file_id?: string;
    /**
     * 生效的声音文件名（页面直接显示）
     */
    file_name?: string;
    /**
     * 生效的声音地址（试听用；能否进供应商请求由生成前准入判定）
     */
    url?: string;
    /**
     * 来源人物资产类型（character）
     */
    source_asset_type?: string;
    /**
     * 来源人物资产 ID（内部标识，只进技术详情层）
     */
    source_asset_id?: string;
    /**
     * 来源人物资产名称（页面显示「继承自……」）
     */
    source_asset_name?: string;
    /**
     * 这一镜关联的人物资产数量
     */
    character_count?: number;
    /**
     * 其中已经绑定声音的数量
     */
    voice_asset_count?: number;
    /**
     * ambiguous 时的候选人物资产名称
     */
    candidates?: Array<string>;
    /**
     * 迁移前的逐镜声音文件 ID（只读快照）
     */
    legacy_file_id?: string;
    /**
     * 迁移前的逐镜声音文件名（只读快照）
     */
    legacy_file_name?: string;
    /**
     * 快照记录的继承来源（<资产类型>:<资产ID>）
     */
    legacy_inherited_from?: string;
};

