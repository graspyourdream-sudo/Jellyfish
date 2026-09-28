/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CameraAngle } from './CameraAngle';
import type { CameraMovement } from './CameraMovement';
import type { CameraShotType } from './CameraShotType';
import type { VFXType } from './VFXType';
/**
 * 更新镜头细节的**写入**契约。
 *
 * 这里**没有** ``audio_file_id``（迁移 009 之前的逐镜声音）。理由：角色声音的唯一事实
 * 来源是人物资产，第 2 步「人物资产详情」是全站唯一绑定入口；只要这个字段还在更新契约里，
 * 普通调用方就还能新建 / 改掉一条"逐镜角色声音"，与"改人物资产的音色要让所有关联镜头
 * 自动生效"的口径直接冲突（历史快照还会把新音色顶回去）。因此：
 *
 * - 读：``ShotDetailRead`` 仍带该字段（历史数据只读展示 / 迁移对账）；
 * - 写：只剩 ``audio_opt_out`` —— 它是镜头级唯一的合法声明（本镜明确无需声音）。
 */
export type ShotDetailUpdate = {
    camera_shot?: (CameraShotType | null);
    angle?: (CameraAngle | null);
    movement?: (CameraMovement | null);
    scene_id?: (string | null);
    duration?: (number | null);
    override_video_ratio?: (string | null);
    mood_tags?: (Array<string> | null);
    atmosphere?: (string | null);
    follow_atmosphere?: (boolean | null);
    has_bgm?: (boolean | null);
    vfx_type?: (VFXType | null);
    vfx_note?: (string | null);
    action_beats?: (Array<string> | null);
    first_frame_prompt?: (string | null);
    last_frame_prompt?: (string | null);
    key_frame_prompt?: (string | null);
    video_prompt?: (string | null);
    video_prompt_source?: (string | null);
    /**
     * 本镜**明确标记**无需声音（镜头级唯一的合法声明）。置 true 时服务端同时清掉迁移前留下的逐镜声音快照：本镜的生效结论就是没有声音，覆盖角色声音继承。
     */
    audio_opt_out?: (boolean | null);
};

