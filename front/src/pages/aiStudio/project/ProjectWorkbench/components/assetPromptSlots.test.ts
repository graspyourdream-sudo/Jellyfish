/**
 * 缺陷 D1 的回归测试：面板拉回「已保存提示词」时必须**按 key 合并**，
 * 不能整行替换（`loaded.find(...) ?? row`）。
 *
 * 复现（改前）：任一资产已保存 `image_prompts` → 该行显示 `undefined（undefined）`、
 * 槽位变成「不支持（无槽位）」、复选框被禁用（不能勾选、不能生成）；
 * 4 项都有提示词时 4 行全坏，还误报「有 N 个资产类型没有大模型槽位」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ASSET_PROMPT_CATEGORY,
  ASSET_PROMPT_CATEGORY_LABEL,
  ASSET_PROMPT_UNSUPPORTED_SLOT_TEXT,
  buildUnsupportedSlotAlert,
  describePromptRowAsset,
  describePromptRowExisting,
  describePromptRowSlot,
  describePromptRowState,
  findUndefinedCopy,
  mergeLoadedAssetPrompts,
  type PromptSlotRowLike,
} from './assetPromptSlots.ts'

type Row = PromptSlotRowLike & { status: string; draft: string }

function row(type: Row['type'], id: string, patch: Partial<Row> = {}): Row {
  const category = ASSET_PROMPT_CATEGORY[type as keyof typeof ASSET_PROMPT_CATEGORY] ?? ''
  return {
    key: `${type}:${id}`,
    name: `${type}-${id}`,
    type,
    supported: Boolean(category),
    category,
    existing: '',
    status: 'pending',
    draft: '',
    ...patch,
  }
}

/** 复刻改前的错误实现，用于把 bug 钉在测试里（它必须仍然是坏的）。 */
function legacyReplaceRows(rows: readonly Row[], loaded: readonly { key: string; existing: string }[]): Row[] {
  return rows.map((item) => (loaded.find((patch) => patch.key === item.key) ?? item) as Row)
}

test('D1：已保存提示词的行合并后仍保留 name / 类型 / 槽位（不再整行替换）', () => {
  const rows = [row('character', 'c1'), row('scene', 's1'), row('prop', 'p1')]
  const merged = mergeLoadedAssetPrompts(rows, [
    { key: 'character:c1', existing: '韩虹，35 岁女律师，正面半身，纯白背景' },
    { key: 'scene:s1', existing: '老式法院走廊，冷色调，广角' },
  ])

  // 行与顺序都不变
  assert.deepEqual(merged.map((item) => item.key), rows.map((item) => item.key))

  const character = merged[0]
  assert.equal(character.name, 'character-c1')
  assert.equal(character.type, 'character')
  assert.equal(character.supported, true)
  assert.equal(character.category, 'character_image_front')
  assert.equal(character.existing, '韩虹，35 岁女律师，正面半身，纯白背景')
  // 非补丁字段原样保留
  assert.equal(character.status, 'pending')
  assert.equal(character.draft, '')

  // 没被命中的行一个字都不改
  assert.equal(merged[2].existing, '')
  assert.equal(merged[2].supported, false)
  assert.equal(merged[2].category, '')
})

test('D1：合并后界面文案里不出现 undefined（资产名 / 槽位 / 已有提示词三列）', () => {
  const rows = [
    row('character', 'c1', { existing: '有提示词的角色' }),
    row('scene', 's1', { existing: '有提示词的场景' }),
    row('costume', 'k1', { existing: '有提示词的服装' }),
    row('prop', 'p1', { existing: '有提示词的道具' }),
  ]
  const merged = mergeLoadedAssetPrompts(
    rows,
    rows.map((item) => ({ key: item.key, existing: item.existing })),
  )
  merged.forEach((item) => {
    const texts = [
      describePromptRowAsset(item),
      describePromptRowSlot(item),
      describePromptRowExisting(item),
      describePromptRowState(item),
    ]
    texts.forEach((text) => {
      assert.ok(!findUndefinedCopy(text), `出现了 undefined：${text}`)
      assert.ok(!text.includes('undefined'), text)
    })
  })
  // 槽位列仍然是各自的中文槽位名
  assert.equal(describePromptRowSlot(merged[0]), ASSET_PROMPT_CATEGORY_LABEL.character_image_front)
  assert.equal(describePromptRowSlot(merged[1]), ASSET_PROMPT_CATEGORY_LABEL.scene_image_front)
  assert.equal(describePromptRowSlot(merged[2]), ASSET_PROMPT_CATEGORY_LABEL.costume_image_front)
  assert.equal(describePromptRowExisting(merged[0]), '7 字')
})

test('D1 复现：改前的整行替换确实会造出「undefined（undefined）」与「不支持（无槽位）」', () => {
  const rows = [row('character', 'c1')]
  const broken = legacyReplaceRows(rows, [{ key: 'character:c1', existing: '已保存的提示词' }])
  // 旧实现在 JSX 里直接拼 `${value}（${row.type}）`
  assert.equal(`${broken[0].name}（${broken[0].type}）`, 'undefined（undefined）')
  assert.equal(describePromptRowSlot(broken[0]), ASSET_PROMPT_UNSUPPORTED_SLOT_TEXT)
  assert.equal(broken[0].supported, undefined as unknown as boolean)
  assert.ok(findUndefinedCopy(`${broken[0].name}（${broken[0].type}）`))
})

test('D1：误报的「没有大模型槽位」提示只按真实无槽位的类型计数', () => {
  const rows = [
    row('character', 'c1', { existing: 'a' }),
    row('scene', 's1', { existing: 'b' }),
    row('costume', 'k1', { existing: 'c' }),
    row('prop', 'p1', { existing: 'd' }),
  ]
  const merged = mergeLoadedAssetPrompts(
    rows,
    rows.map((item) => ({ key: item.key, existing: item.existing })),
  )
  const alert = buildUnsupportedSlotAlert(merged)
  assert.ok(alert)
  // 只有道具没有槽位：改前这里会是 4
  assert.equal(alert?.count, 1)
  assert.equal(alert?.message, '有 1 个资产类型没有大模型槽位（道具）')

  // 全是支持的型号 → 不显示这条提示
  assert.equal(buildUnsupportedSlotAlert([row('character', 'c1'), row('scene', 's1')]), null)

  // 空的加载结果：合并等于没变化（不会把行清空）
  assert.deepEqual(mergeLoadedAssetPrompts(rows, []), rows)
})
