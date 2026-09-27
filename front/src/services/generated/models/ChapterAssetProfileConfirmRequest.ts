/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChapterAssetProfileSelection } from './ChapterAssetProfileSelection';
/**
 * 结构化资产清单的确认落库请求。
 */
export type ChapterAssetProfileConfirmRequest = {
    /**
     * 无冲突项是否直接确认（true 时不需要逐个点；冲突项一律仍需人工决定）
     */
    auto_confirm_unconflicted?: boolean;
    /**
     * 是否整体接受本次 selections 里冲突项的人工决定
     */
    confirm_conflict?: boolean;
    /**
     * 需要人工处理时的逐项决定（无冲突项不必出现在这里）
     */
    selections?: Array<ChapterAssetProfileSelection>;
    /**
     * 与生成本清单时**完全一致**的附加要求（内容签名要对得上，否则会要求重新生成）
     */
    extra_instructions?: string;
};

