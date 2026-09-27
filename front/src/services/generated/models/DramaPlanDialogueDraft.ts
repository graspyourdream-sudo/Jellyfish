/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 一句台词（对应正式产物 ``shot_dialog_lines`` 的一行）。
 */
export type DramaPlanDialogueDraft = {
    /**
     * 说话角色名（必须出现在 characters 里）
     */
    speaker?: string;
    /**
     * 台词内容
     */
    text?: string;
    /**
     * DIALOGUE / VOICE_OVER / OFF_SCREEN / PHONE
     */
    mode?: string;
};

