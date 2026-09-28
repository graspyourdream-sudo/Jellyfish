/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CameraAngle } from './CameraAngle';
import type { CameraMovement } from './CameraMovement';
import type { CameraShotType } from './CameraShotType';
import type { VFXType } from './VFXType';
export type ShotDetailRead = {
    /**
     * 镜头 ID（与 shots.id 共享主键）
     */
    id: string;
    /**
     * 景别
     */
    camera_shot: CameraShotType;
    /**
     * 机位角度
     */
    angle: CameraAngle;
    /**
     * 运镜方式
     */
    movement: CameraMovement;
    /**
     * 关联场景 ID（可空）
     */
    scene_id?: (string | null);
    /**
     * 时长（秒）
     */
    duration?: number;
    /**
     * 分镜级视频比例覆盖；为空表示继承项目默认
     */
    override_video_ratio?: (string | null);
    /**
     * 情绪标签
     */
    mood_tags?: Array<string>;
    /**
     * 氛围描述
     */
    atmosphere?: string;
    /**
     * 是否沿用氛围
     */
    follow_atmosphere?: boolean;
    /**
     * 是否包含 BGM
     */
    has_bgm?: boolean;
    /**
     * 视效类型
     */
    vfx_type?: VFXType;
    /**
     * 视效说明
     */
    vfx_note?: string;
    /**
     * 动作拍点（按时间顺序排列）
     */
    action_beats?: Array<string>;
    /**
     * 镜头分镜首帧提示词
     */
    first_frame_prompt?: string;
    /**
     * 镜头分镜尾帧提示词
     */
    last_frame_prompt?: string;
    /**
     * 镜头分镜关键帧提示词
     */
    key_frame_prompt?: string;
    /**
     * **只读兼容快照**（迁移 009 之前的逐镜声音）：仅出现在读取契约里，供历史数据展示与迁移对账。角色声音的唯一事实来源是人物资产（PUT /studio/asset-voices/character/{id}，第 2 步人物资产详情）；生成侧只在人物资产没有音色时用它兜底，**永不覆盖**人物资产的音色。写入契约（ShotDetailCreate / ShotDetailUpdate）里没有这个字段。
     */
    audio_file_id?: (string | null);
    /**
     * 本镜的**无需声音**声明（镜头级唯一的合法声音字段）。true = 本镜明确无需声音，**覆盖**角色声音继承（本镜不带声音）；false = **未表态**，照常继承人物资产的声音。置 true 只改变生效优先级，**不会清空**迁移前留下的历史兼容快照。
     */
    audio_opt_out?: boolean;
    /**
     * 镜头视频提示词（文生视频用；与帧图片提示词分离，可由外部平台导入）
     */
    video_prompt?: string;
    /**
     * 视频提示词来源标记（jurilu / external / manual / internal；空表示未知）
     */
    video_prompt_source?: string;
};

