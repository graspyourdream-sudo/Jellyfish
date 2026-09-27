/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
/**
 * 一条一致性问题（消息用用户语言，``fix`` 是他能做的动作）。
 */
export type DramaPlanConsistencyIssue = {
    /**
     * 机器可读代号（例如 product_coverage_low）
     */
    code: string;
    /**
     * error（会挡住确认落库）/ warning（提示但不挡）
     */
    level?: string;
    /**
     * 给用户看的中文说明（不带字段名与接口名）
     */
    message?: string;
    /**
     * 建议怎么改
     */
    fix?: string;
};

