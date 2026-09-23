/**
 * 「大模型生成图片提示词」面板的**纯逻辑**（可 `node --test` 直接跑）。
 *
 * 抽出来的原因（缺陷 D1）：面板拉取「已保存提示词」时，用
 * `loaded.find(i => i.key === row.key) ?? row` **整行替换**了原行，
 * 而拉回来的对象只有 `{ key, existing }` —— 于是 name / type / supported / category 全丢，
 * 界面上变成「undefined（undefined）」、槽位显示「不支持（无槽位）」、复选框被禁用、不能生成，
 * 有提示词的资产有几项就坏几项，还误报「有 N 个资产类型没有大模型槽位」。
 *
 * 修法是**按 key 合并**（`{ ...row, ...found }`）。这里把合并与文案拼装都做成纯函数，
 * 于是「合并后 name / 类型 / 槽位仍保留、且不会出现 undefined 文案」可以用测试钉住，
 * 而不是只靠肉眼看界面。
 */

export type AssetPromptAssetType = 'character' | 'scene' | 'prop' | 'costume'

/** 资产类型 → 生成提示词时使用的槽位（= 生图计划读取的那一列，照后端槽位表，不硬编码猜）。 */
export const ASSET_PROMPT_CATEGORY: Partial<Record<AssetPromptAssetType, string>> = {
  character: 'character_image_front',
  scene: 'scene_image_front',
  costume: 'costume_image_front',
}

export const ASSET_PROMPT_CATEGORY_LABEL: Record<string, string> = {
  character_image_front: '角色正面图片',
  scene_image_front: '场景正面图片',
  costume_image_front: '服装正面图片',
}

export const ASSET_PROMPT_UNSUPPORTED_SLOT_TEXT = '不支持（无槽位）'
export const ASSET_PROMPT_UNSUPPORTED_STATE_TEXT = '该资产类型没有大模型槽位'
export const ASSET_PROMPT_EMPTY_EXISTING_TEXT = '—'

/**
 * 面板行的**最小形状**：合并必须保住这些字段，否则就是 D1 那个 bug。
 *
 * 泛型参数让真实行（含 status / draft / warnings …）原样透传，合并只动 `existing`。
 */
export type PromptSlotRowLike = {
  key: string
  name: string
  type: string
  supported: boolean
  category: string
  existing: string
}

/** 拉回来的「已保存提示词」补丁（只有这两个字段，**绝不能**拿来整行替换）。 */
export type LoadedAssetPrompt = {
  key: string
  existing: string
}

/**
 * 把拉回来的已保存提示词**合并**进原行（D1 的修复本体）。
 *
 * 三条不变量（有单测）：
 *   1. 行数不变、顺序不变（按 key 对齐）；
 *   2. name / type / supported / category 等原字段一个都不丢；
 *   3. 只有命中 key 的行的 `existing` 被更新，其余行原样返回。
 */
export function mergeLoadedAssetPrompts<T extends PromptSlotRowLike>(
  rows: readonly T[],
  loaded: readonly LoadedAssetPrompt[],
): T[] {
  const patchByKey = new Map<string, string>()
  loaded.forEach((item) => {
    patchByKey.set(String(item.key), String(item.existing ?? ''))
  })
  return rows.map((row) => {
    if (!patchByKey.has(row.key)) return row
    return { ...row, existing: patchByKey.get(row.key) as string }
  })
}

/** 资产列的文案：`韩虹（character）` —— 不许出现 undefined。 */
export function describePromptRowAsset(row: Pick<PromptSlotRowLike, 'name' | 'type'>): string {
  const name = String(row.name ?? '').trim() || '（未命名资产）'
  const type = String(row.type ?? '').trim() || '未知类型'
  return `${name}（${type}）`
}

/** 槽位列的文案：有槽位显示中文槽位名，没有槽位显示「不支持（无槽位）」。 */
export function describePromptRowSlot(row: Pick<PromptSlotRowLike, 'supported' | 'category'>): string {
  if (!row.supported) return ASSET_PROMPT_UNSUPPORTED_SLOT_TEXT
  const category = String(row.category ?? '').trim()
  if (!category) return ASSET_PROMPT_UNSUPPORTED_SLOT_TEXT
  return ASSET_PROMPT_CATEGORY_LABEL[category] ?? category
}

/** 「已有提示词」列的文案：N 字 / —。 */
export function describePromptRowExisting(row: Pick<PromptSlotRowLike, 'existing'>): string {
  const text = String(row.existing ?? '').trim()
  return text ? `${text.length} 字` : ASSET_PROMPT_EMPTY_EXISTING_TEXT
}

/** 状态列在「没有槽位」时的那句话。 */
export function describePromptRowState(row: Pick<PromptSlotRowLike, 'supported'>): string {
  return row.supported ? '' : ASSET_PROMPT_UNSUPPORTED_STATE_TEXT
}

export type UnsupportedSlotAlert = {
  count: number
  message: string
  description: string
}

/**
 * 「有 N 个资产类型没有大模型槽位」的提示。
 *
 * 只有**真的**没有槽位的行（道具）才计数 —— D1 的 bug 会让所有行都被误算进来。
 * 返回 null 表示不该显示这条提示。
 */
export function buildUnsupportedSlotAlert(rows: readonly Pick<PromptSlotRowLike, 'supported'>[]): UnsupportedSlotAlert | null {
  const count = rows.filter((row) => !row.supported).length
  if (count === 0) return null
  return {
    count,
    message: `有 ${count} 个资产类型没有大模型槽位（道具）`,
    description: '后端槽位表只定义了角色/场景/服装的图片提示词槽位，道具没有；这类资产请在上面用手工填写。',
  }
}

/**
 * 一行文案里是否出现了 `undefined` / `null` 这类未定义痕迹。
 *
 * 面板的 bug 表现就是「undefined（undefined）」——测试用它当断言，
 * 任何字段被整行替换掉都会被抓出来。
 */
export function findUndefinedCopy(text: string): boolean {
  return /\bundefined\b|\bnull\b|NaN/.test(String(text ?? ''))
}
