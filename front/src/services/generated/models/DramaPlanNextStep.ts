/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 确认策划之后的**下一个主操作**（契约 §三.5：页面据此把按钮换成「继续准备资产」）。
 *
 * 为什么给两个 URL：契约里写的 ``url`` 不带章节参数，而第 2 步的工作台按**章节**取镜头资产，
 * 少了参数它会自己再找一次章节（找到的可能不是刚确认的这一集）。所以 ``url`` 保持契约原文，
 * ``chapter_url`` 是带上刚确认这一章的那一份，页面优先用它。
 */
export type DramaPlanNextStep = {
    /**
     * 按钮文字（例如「继续准备资产」）
     */
    label?: string;
    /**
     * 契约口径的下一步 URL（不带章节参数）
     */
    url?: string;
    /**
     * 带 chapter 参数的下一步 URL（页面优先用这个）
     */
    chapter_url?: string;
};

