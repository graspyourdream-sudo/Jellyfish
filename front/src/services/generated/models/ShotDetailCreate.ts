/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CameraAngle } from './CameraAngle';
import type { CameraMovement } from './CameraMovement';
import type { CameraShotType } from './CameraShotType';
import type { VFXType } from './VFXType';
/**
 * 创建镜头细节的**写入**契约。
 *
 * 刻意**不**从 ``ShotDetailBase`` 继承：那会连带把只读兼容快照
 * ``audio_file_id`` 变成创建时的可写字段 —— 那等于留下第二套"逐镜声音绑定"入口
 * （口径：角色声音只绑在**人物资产**上，第 2 步「人物资产详情」是全站唯一入口）。
 * 这里逐字段列出可写字段，行为与 ``ShotDetailUpdate`` 的可写集合保持一致。
 */
export type ShotDetailCreate = {
    /**
     * 镜头细节 ID（与镜头 1:1 共享主键）
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

