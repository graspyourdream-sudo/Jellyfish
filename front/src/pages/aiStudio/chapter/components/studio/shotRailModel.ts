/**
 * 底部分镜胶片条（`StudioShotRail`）的**纯逻辑**：卡片视图、勾选、批量下载范围判定。
 *
 * 为什么单独一个 `.ts`：这些判定是任务书第 9 条（批量下载）与第十一部分
 * （胶片条 = 生成结果与批量下载入口）的硬口径，必须能被 `node --test` 直接跑：
 *
 * 1. **失败 / 未生成 / 仅本机不可用**的镜头不能混进可交付包 —— 勾选前就要说清；
 * 2. 下载前显示**包含数量与被排除数量**；
 * 3. 空选择时给自然语言错误，不做假下载；
 * 4. 勾选**不触发镜头切换**（选择与"当前镜头"是两个独立状态）。
 *
 * 这里不猜后端结论：`hasDeliverableVideo` 来自真实数据（镜头上的成片文件），
 * 拿不到就按"不可交付"处理（保守：宁可少打包，也不给一个坏包）。
 */

/** 胶片条上一张卡片需要的全部数据（页面从真实镜头数据组装）。 */
export type RailShotView = {
  id: string
  /** 镜头号（集内顺序，1 起） */
  index: number
  /** 镜头编号展示（`S001` / `SH-01`） */
  code: string
  title: string
  /** 缩略图地址（没有则空串 → 卡片显示占位） */
  thumbnail: string
  /** 业务状态文案（自然语言，来自同一份状态口径） */
  statusLabel: string
  /** 状态语气（决定标签颜色槽位） */
  statusTone: 'neutral' | 'info' | 'success' | 'warning' | 'danger'
  /** 卡片副行（时长 · 画幅 · 缺项） */
  meta: string
  /** 是否已有可交付成片（**决定能不能进批量下载包**） */
  hasDeliverableVideo: boolean
  /** 不可交付时的中文原因（空串 = 可以交付） */
  blockedReason: string
}

export type RailSelectionSummary = {
  /** 勾选总数 */
  selected: number
  /** 其中真的可交付的数量（= 会进包的数量） */
  deliverable: number
  /** 勾了但不可交付的数量 */
  blocked: number
  /** 被排除的镜头（用于逐条说明原因） */
  blockedShots: RailShotView[]
  /** 能不能真的下载 */
  canDownload: boolean
  /** 主区一句自然语言（含数量；空选择时是明确的错误说法） */
  message: string
}

/** 相机镜头号 → `S001`（与后端交付清单同一编号口径，页面不做第二套编号）。 */
export function railShotCode(index: number): string {
  const value = Number.isFinite(index) ? Math.trunc(index) : 0
  return `S${String(Math.max(0, value)).padStart(3, '0')}`
}

/** 勾选 / 取消勾选一个镜头（**只动选择集合**，绝不改当前镜头）。 */
export function toggleShotPick(selected: readonly string[], shotId: string): string[] {
  const id = String(shotId ?? '').trim()
  if (!id) return [...selected]
  return selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]
}

/**
 * 「全选」的口径：**只勾可交付的镜头**。
 *
 * 为什么不勾全部：批量下载的语义是"把能交付的成片一次拿走"，
 * 把没有成片的镜头也勾上只会让用户在下载时看到一堆排除项。
 */
export function selectAllDeliverable(shots: readonly RailShotView[]): string[] {
  return shots.filter((shot) => shot.hasDeliverableVideo).map((shot) => shot.id)
}

/** 是否已经全选（用于「全选」复选框的选中态；一个可交付的都没有时视为未全选）。 */
export function isAllDeliverableSelected(shots: readonly RailShotView[], selected: readonly string[]): boolean {
  const deliverable = shots.filter((shot) => shot.hasDeliverableVideo).map((shot) => shot.id)
  if (deliverable.length === 0) return false
  return deliverable.every((id) => selected.includes(id))
}

/**
 * 下载前的范围结论（页面据此显示「包含 N 条 / 排除 M 条」并决定按钮能否点）。
 *
 * 文案是产品自己写的句子（不含镜头内部标识、不含状态码）。
 */
export function summarizeRailSelection(
  shots: readonly RailShotView[],
  selected: readonly string[],
): RailSelectionSummary {
  const byId = new Map(shots.map((shot) => [shot.id, shot]))
  const picked = selected.map((id) => String(id ?? '').trim()).filter(Boolean)
  const blockedShots: RailShotView[] = []
  let deliverable = 0
  for (const id of picked) {
    const shot = byId.get(id)
    if (!shot) continue
    if (shot.hasDeliverableVideo) deliverable += 1
    else blockedShots.push(shot)
  }
  const selectedCount = picked.length
  const canDownload = deliverable > 0

  let message: string
  if (selectedCount === 0) {
    message = '还没有勾选镜头。在下面的分镜卡片左上角勾选要交付的镜头，或用「全选」一键勾上所有已有成片的镜头。'
  } else if (!canDownload) {
    message = `已勾选 ${selectedCount} 个镜头，但它们都还没有可交付的成片（失败与未生成的镜头不会进包）。请先生成，或改勾已经生成好的镜头。`
  } else {
    message = `本次会打包 ${deliverable} 条成片`
    message += blockedShots.length
      ? `；另有 ${blockedShots.length} 个已勾选镜头被排除（还没有可交付的成片）。`
      : '。'
  }

  return {
    selected: selectedCount,
    deliverable,
    blocked: blockedShots.length,
    blockedShots,
    canDownload,
    message,
  }
}

/**
 * 单个镜头被排除的原因（胶片条卡片与下载确认里共用同一句话）。
 *
 * 口径：说清**发生了什么**与**下一步怎么做**，不出现内部标识与状态码。
 */
export function blockedReasonFor(shot: RailShotView): string {
  const given = String(shot.blockedReason ?? '').trim()
  if (given) return given
  return '这个镜头还没有生成成功的成片，不能进交付包。'
}

/** 胶片条头部的计数（已完成 / 生成中 / 待生成 / 失败）。 */
export function countRailStates(shots: readonly RailShotView[]): {
  total: number
  deliverable: number
  generating: number
  pending: number
  failed: number
} {
  let deliverable = 0
  let generating = 0
  let pending = 0
  let failed = 0
  for (const shot of shots) {
    if (shot.hasDeliverableVideo) deliverable += 1
    else if (shot.statusTone === 'info') generating += 1
    else if (shot.statusTone === 'danger') failed += 1
    else pending += 1
  }
  return { total: shots.length, deliverable, generating, pending, failed }
}
