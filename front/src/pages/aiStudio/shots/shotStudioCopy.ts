/**
 * `shots/**`（分镜列表 / 分镜编辑 / 绑定区）的区域级文案口径。
 *
 * ## 为什么这里有一张本地枚举表（审计 §7.1-4 的例外说明）
 *
 * §7.1-4 要求「枚举映射**一处定义、全仓引用**」，唯一事实来源是
 * `pages/aiStudio/components/enumLabels.ts`。但该文件在本批**只读**（不许改），
 * 而镜头生产状态（`ShotStatus` = `pending | generating | ready`）在共享表里**没有**
 * 对应的 `EnumSpec`（`TASK_STATUS` 的 `pending` 是「排队中」，语义不同，不能借用）。
 *
 * 所以这里按**同一套 `EnumSpec` 契约**定义一张临时表，并登记：
 * **需追加 —— `components/enumLabels.ts` 应新增 `SHOT_STATUS`（本表届时删除并改为 import）。**
 *
 * `unknown` 是中文兜底：未登记的状态**绝不回显原值**（审计 §7.4 兜底口径）。
 *
 * 标签与分镜列表页筛选器上的中文逐字一致（「待确认 / 生成中 / 已就绪」），
 * 避免同一屏里同一状态出现两种说法（同一份数据全仓只允许一个名字，§9.1-19）。
 */

import { labelFor, type EnumSpec } from '../components/enumLabels.ts'

/** 镜头状态原值 → 中文（口径与列表页筛选器一致）。 */
export const SHOT_STATUS: EnumSpec = {
  name: 'shotStatus',
  values: ['pending', 'generating', 'ready'],
  labels: {
    pending: '待确认',
    generating: '生成中',
    ready: '已就绪',
  },
  unknown: '状态待确认',
}

/** 镜头状态 → 主区中文（**未登记给中文兜底**）。 */
export function shotStatusLabel(raw: string | null | undefined): string {
  return labelFor(SHOT_STATUS, raw)
}
