/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 一个镜头在交付包里的状态。
 */
export type BundleItemRead = {
    /**
     * 镜头 ID（页面内部用；主区不展示）
     */
    shot_id: string;
    /**
     * 镜头编号，例如 SH-01
     */
    shot_code: string;
    /**
     * 镜头标题
     */
    shot_title: string;
    /**
     * 所属章节的展示标签
     */
    chapter_label: string;
    /**
     * 包内文件名；不进包时为空串
     */
    file_name?: string;
    /**
     * 文件字节数；预检时为 0（预检不读字节）
     */
    size_bytes?: number;
    /**
     * 是否进包
     */
    included: boolean;
    /**
     * 不进包时的中文原因
     */
    reason?: string;
};

