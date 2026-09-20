/**
 * 章节序号的统一算法。
 *
 * 为什么单独抽出来：新建章节的 index 必须取「现有章节里最大的 index + 1」，
 * 而不是「章节数量 + 1」。当章节序号不连续时（例如手工删过章节，剩 1 和 3），
 * 用数量 + 1 会算出 3 —— 直接撞上已存在的第 3 章。
 *
 * 抽成纯函数也便于回归测试（见同目录的 chapterIndexing.test.ts）。
 */

/** 现有章节 index → 下一个可用 index（空项目从 1 开始）。 */
export function nextChapterIndex(existingIndexes: readonly (number | null | undefined)[]): number {
  const valid = (existingIndexes ?? []).filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  )
  const max = valid.length > 0 ? Math.max(...valid) : 0
  return Math.floor(max) + 1
}
