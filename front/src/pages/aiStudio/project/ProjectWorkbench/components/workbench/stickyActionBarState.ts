/**
 * 第 2 步资产工作台**底部固定操作条**（`StickyActionBar`）的计数与文案（纯逻辑，可单测）。
 *
 * 这一层只做一件事：把**工作台契约里已有的真实数字**翻译成那一行文案。
 * 它自己不产生任何数字，也没有任何默认值可供"编" —— 每个入参都必须由调用方
 * 从真实数据源传进来（见 `AssetWorkbench.tsx` 的传参处）。
 *
 * 四个数字各自的唯一来源（**任何一处都不许另立第二套算法**）：
 *
 * ====================  ==========================================================
 * 资产就绪 N / M        `../../assetPrepStatus.resolveAssetPrepStatus`
 *                       （与结果区 `AssetProductionArea` 的就绪判定同一份口径）
 * 待补资料 N 项          `./workbenchState.countByStatus(items).needs_profile`
 * 生成失败 N 项          本轮任务进度（`taskProgress.TaskProgressSummary.failed`）
 * 待处理 N 项           `待处理清单的长度` + `./workbenchState.describePendingReview`
 * ====================  ==========================================================
 *
 * 「就绪」的口径刻意**不在这里重写**：`assetPrepInputFromReadiness` 把契约字段映射成
 * 业务状态入参，`resolveAssetPrepStatus` 给出结论（有提示词 + 有图片 + 已定版 = 已就绪）。
 * 这两个函数是全仓唯一的就绪判定处，本模块只是把它们跑在契约 `items` 上。
 *
 * ⚠️ 本文件虽然不进入主区禁词扫描面（扫描面是 `workbench/**` 的 `.tsx`），
 * 但这里的**导出文案会原样渲染到主区**，所以文案口径与组件保持一致：
 * 只说用户看得懂的话，不放内部字段名与原始状态值。
 */

import {
  assetPrepInputFromReadiness,
  resolveAssetPrepStatus,
} from '../../assetPrepStatus.ts'
import { countByStatus, describePendingReview, type WorkbenchItemLike } from './workbenchState.ts'

/** 固定条高度（设计包 §6：56px；1440×900 下不许挡住结果区折叠面板的底部内容）。 */
export const STICKY_ACTION_BAR_HEIGHT = 56

/** 就绪度进度条宽度（设计包原型里那一小条，120px）。 */
export const STICKY_ACTION_BAR_PROGRESS_WIDTH = 120

export const READINESS_LABEL = '资产就绪：'
export const NEEDS_PROFILE_LABEL = '待补资料：'
export const FAILED_LABEL = '生成失败：'
/** 付费前二次确认：这是承诺，不是一个可点的动作，所以只作为说明文字 */
export const PAYMENT_CONFIRM_NOTE = '付费前会二次确认'

export type StickyActionBarCounts = {
  /** 已就绪（有提示词 + 有图片 + 已定版） */
  ready: number
  /** 工作台这一屏列出的资产总数（同一份契约清单） */
  total: number
  /** 就绪度百分比（0-100，整除；总数为 0 时为 0，不显示假进度） */
  readyPercent: number
  /** 待补资料 */
  needsProfile: number
  /** 本轮生成失败 */
  failed: number
  /** 待处理（需要人决定的项） */
  pendingReview: number
}

/**
 * 契约项能否算作「已就绪」—— 与结果区**同一份**判定。
 *
 * 四个标志的取法与 `AssetWorkbench.toSignalAssets` 对同一批契约项做的取法逐字相同，
 * 且调用 `resolveAssetPrepStatus` 时同样**不传**提示词质量那一格 —— 否则同屏两处会
 * 对同一项资产给出不同结论（这正是「判定口径必须完全一致」要防的事）。
 */
export function isWorkbenchItemReady(item: WorkbenchItemLike): boolean {
  return (
    resolveAssetPrepStatus(
      assetPrepInputFromReadiness({
        /* 已经在工作台清单里的资产都是**已进项目**的资产：还没有确认写入的项
           不进 `items`（它们只在待处理清单里），所以这里恒为 false —— 与结果区
           `toSignalAssets` 给同一批契约项填的值完全一致。 */
        has_pending_candidate: false,
        has_image_prompt: Boolean(String(item.prompt?.text ?? '').trim()),
        has_image: item.image?.has_image === true,
        has_primary: item.image?.has_primary === true,
      }),
    ).key === 'done'
  )
}

/**
 * 把真实数据源汇成固定条要显示的四个数字。
 *
 * `failed` / `pendingReview` 由调用方从**已经存在**的来源传入（本轮任务进度、
 * 待处理清单长度），这里不做任何估算、也不提供默认值以外的分支。
 */
export function resolveStickyActionBarCounts(input: {
  items: readonly WorkbenchItemLike[]
  /** 本轮任务进度里的失败数（`TaskProgressSummary.failed`） */
  failed: number
  /** 待处理清单长度（`pending_review.length`） */
  pendingReview: number
}): StickyActionBarCounts {
  const { items, failed, pendingReview } = input
  const total = items.length
  let ready = 0
  items.forEach((item) => {
    if (isWorkbenchItemReady(item)) ready += 1
  })
  return {
    ready,
    total,
    readyPercent: total > 0 ? Math.round((ready / total) * 100) : 0,
    needsProfile: countByStatus(items).needs_profile,
    failed: Math.max(0, Math.trunc(failed)),
    pendingReview: Math.max(0, Math.trunc(pendingReview)),
  }
}

/** 就绪度取值文案：`7 / 15`（就绪在前、总数在后，与设计包一致）。 */
export function describeReadinessValue(counts: {
  ready: number
  total: number
}): string {
  return `${counts.ready} / ${counts.total}`
}

/** 计数文案：`2 项`。 */
export function describeCountValue(count: number): string {
  return `${Math.max(0, Math.trunc(count))} 项`
}

/**
 * 「待处理」入口按钮的文案。
 *
 * 直接复用 `workbenchState.describePendingReview`：顶部批量区上的那颗按钮与这里
 * 说的是**同一句话**（同一份数字、同一个函数），不另写一个格式。
 */
export function describeActionBarPendingReview(pendingReview: number): string {
  return describePendingReview(Math.max(0, Math.trunc(pendingReview)))
}
