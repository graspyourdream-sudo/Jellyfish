/**
 * 缺陷 D1 的回归测试：面板拉回「已保存提示词」时必须**按 key 合并**，
 * 不能整行替换（`loaded.find(...) ?? row`）。
 *
 * 复现（改前）：任一资产已保存 `image_prompts` → 该行显示 `undefined（undefined）`、
 * 槽位变成「不支持（无槽位）」、复选框被禁用（不能勾选、不能生成）；
 * 4 项都有提示词时 4 行全坏，还误报「有 N 个资产类型没有大模型槽位」。
 *
 * 本轮追加：**道具不再显示「不支持（无槽位）」** —— 它有 `prop_image_front` 槽位，
 * 能勾选、能保存；后端槽位表里还没补上时也只说「正在补，先手工填写」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ASSET_PROMPT_CATEGORY,
  ASSET_PROMPT_CATEGORY_LABEL,
  ASSET_PROMPT_UNSUPPORTED_SLOT_TEXT,
  buildUnsupportedSlotAlert,
  describePromptRowAsset,
  describePromptRowExisting,
  describePromptRowGenerateHint,
  describePromptRowSlot,
  describePromptRowState,
  describeServerSlotPendingNote,
  findUndefinedCopy,
  mergeLoadedAssetPrompts,
  resolveAssetPromptSlot,
  type PromptSlotRowLike,
} from './assetPromptSlots.ts'
import { ASPECT_RATIO_OPTIONS } from './assetProduction.ts'

/** `front/src/pages/aiStudio/project/ProjectWorkbench/components` → 用于读后端契约源码做对拍 */
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 读后端源码做契约对拍。
 *
 * 为什么不写死 `'../../..'` 的层数：层数会随目录调整而失效（本护栏第一次就因为这个报 ENOENT），
 * 而 ENOENT 会被误读成"护栏挂了"。改为**向上找仓库根**（含该后端文件的那一层），
 * 找不到就明确报错，不静默跳过。
 */
function readBackendSource(relative: string): string {
  let dir = HERE
  for (let i = 0; i < 12; i += 1) {
    const candidate = resolve(dir, 'backend', relative)
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8')
    dir = resolve(dir, '..')
  }
  throw new Error(`找不到仓库根：从本文件向上 12 层都没有 backend/${relative}`)
}

type Row = PromptSlotRowLike & { status: string; draft: string; existingMap?: Record<string, string> }

function row(type: Row['type'], id: string, patch: Partial<Row> = {}): Row {
  const slot = resolveAssetPromptSlot(type as keyof typeof ASSET_PROMPT_CATEGORY)
  return {
    key: `${type}:${id}`,
    name: `${type}-${id}`,
    type,
    supported: slot.supported,
    category: slot.category,
    label: slot.label,
    generateSupported: slot.generateSupported,
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
  assert.equal(merged[2].category, 'prop_image_front')
  assert.equal(merged[2].supported, true)
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
      describePromptRowGenerateHint(item),
    ]
    texts.forEach((text) => {
      assert.ok(!findUndefinedCopy(text), `出现了 undefined：${text}`)
      assert.ok(!text.includes('undefined'), text)
    })
  })
  // 槽位列仍然是各自的中文槽位名（含道具）
  assert.equal(describePromptRowSlot(merged[0]), ASSET_PROMPT_CATEGORY_LABEL.character_image_front)
  assert.equal(describePromptRowSlot(merged[1]), ASSET_PROMPT_CATEGORY_LABEL.scene_image_front)
  assert.equal(describePromptRowSlot(merged[2]), ASSET_PROMPT_CATEGORY_LABEL.costume_image_front)
  assert.equal(describePromptRowSlot(merged[3]), ASSET_PROMPT_CATEGORY_LABEL.prop_image_front)
  assert.equal(describePromptRowExisting(merged[0]), '7 字')
  // 资产列用人话的类型名，不把 character 这种内部取值画到界面上
  assert.equal(describePromptRowAsset(merged[0]), 'character-c1（人物）')
})

test('D1 复现：改前的整行替换确实会造出「undefined（undefined）」与「不支持（无槽位）」', () => {
  const rows = [row('character', 'c1')]
  const broken = legacyReplaceRows(rows, [{ key: 'character:c1', existing: '已保存的提示词' }])
  // 旧实现在 JSX 里直接拼 `${value}（${row.type}）`
  assert.equal(`${broken[0].name}（${broken[0].type}）`, 'undefined（undefined）')
  assert.equal(describePromptRowSlot({ supported: false, category: '', label: '' }), ASSET_PROMPT_UNSUPPORTED_SLOT_TEXT)
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
  // 四类资产都有槽位（含道具）→ 一条提示都不该有
  assert.equal(buildUnsupportedSlotAlert(merged), null)

  // 真的没有槽位的类型（例如还没进契约的类型码）才计数
  const withUnknown = [...rows, row('actor', 'a1')]
  const alert = buildUnsupportedSlotAlert(withUnknown)
  assert.ok(alert)
  assert.equal(alert?.count, 1)
  /* 旧期望是 `assert.match(description, /actor/)` —— 它把「未登记的类型码原样回显」
     钉成了期望值（审计 §4.5 模式 3 点名的映射兜底）。新口径：**绝不回显原值**，
     未登记的类型码给中文兜底，所以这里改成「不许出现原值 + 必须出现中文兜底」。 */
  assert.ok(
    !String(alert?.description).includes('actor'),
    `未登记的类型码被回显到主区了：${alert?.description}`,
  )
  assert.match(String(alert?.description), /其它类型/)

  // 全是支持的型号 → 不显示这条提示
  assert.equal(buildUnsupportedSlotAlert([row('character', 'c1'), row('scene', 's1')]), null)

  // 空的加载结果：合并等于没变化（不会把行清空）
  assert.deepEqual(mergeLoadedAssetPrompts(rows, []), rows)
})

test('合并回写：命中行带上整份已保存内容（保存是整列替换，不合并会抹掉其它槽位）', () => {
  const rows = [row('character', 'c1'), row('prop', 'p1')]
  const loaded = [
    {
      key: 'character:c1',
      existing: '韩虹，35 岁女律师，齐肩黑发',
      existingMap: { character_image_front: '韩虹，35 岁女律师，齐肩黑发', character_image_other: '韩虹，侧面，齐肩黑发' },
    },
  ]
  const merged = mergeLoadedAssetPrompts(rows, loaded)
  assert.equal(merged[0].existing, '韩虹，35 岁女律师，齐肩黑发')
  assert.deepEqual(merged[0].existingMap, {
    character_image_front: '韩虹，35 岁女律师，齐肩黑发',
    character_image_other: '韩虹，侧面，齐肩黑发',
  })
  // 没命中的行不带这份 map（不会把别人的提示词写到自己身上）
  assert.equal(merged[1].existingMap, undefined)
  // 不给 existingMap 时行为与以前一致（只更新 existing）
  const mergedTiny = mergeLoadedAssetPrompts(rows, [{ key: 'prop:p1', existing: '深棕木质法槌' }])
  assert.equal(mergedTiny[1].existing, '深棕木质法槌')
  assert.equal(mergedTiny[1].existingMap, undefined)
  assert.equal(mergedTiny[0].existing, '')
})

test('道具：槽位是 prop_image_front（不再显示「不支持（无槽位）」）', () => {
  const slot = resolveAssetPromptSlot('prop')
  assert.equal(slot.category, 'prop_image_front')
  assert.equal(slot.label, '道具正面图片')
  assert.equal(slot.supported, true)
  assert.equal(describePromptRowSlot({ supported: true, category: slot.category, label: slot.label }), '道具正面图片')
  assert.notEqual(describePromptRowSlot({ supported: true, category: slot.category, label: slot.label }), ASSET_PROMPT_UNSUPPORTED_SLOT_TEXT)
  assert.equal(describePromptRowState({ supported: true }), '')
  // 四类资产都能勾选、都能保存
  ;(['character', 'scene', 'prop', 'costume'] as const).forEach((type) => {
    assert.equal(resolveAssetPromptSlot(type).supported, true, `${type} 应该有槽位`)
  })
})

test('道具：后端槽位表补上后，槽位名与「能一键生成」按后端表走', () => {
  const serverSpecs = [
    { category: 'character_image_front', label: '角色正面图片', entity_type: 'character' },
    { category: 'prop_image_front', label: '道具正面图片（正视图）', entity_type: 'prop' },
  ]
  const prop = resolveAssetPromptSlot('prop', serverSpecs)
  assert.equal(prop.category, 'prop_image_front')
  assert.equal(prop.label, '道具正面图片（正视图）')
  assert.equal(prop.fromServer, true)
  assert.equal(prop.generateSupported, true)
  assert.equal(describePromptRowGenerateHint({ supported: true, generateSupported: true }), '')

  // 表里没有这一项时：可以手工填写并保存，但如实说明"还不能一键生成"
  const scene = resolveAssetPromptSlot('scene', serverSpecs)
  assert.equal(scene.category, 'scene_image_front')
  assert.equal(scene.generateSupported, false)
  const hint = describePromptRowGenerateHint(scene)
  assert.match(hint, /这一类暂时还不能一键生成/)
  assert.match(hint, /手工填写/)
  assert.ok(!hint.includes(ASSET_PROMPT_UNSUPPORTED_SLOT_TEXT))
  // 提示里带上类型名（人话），并且四类都不出现「不支持」
  assert.match(describeServerSlotPendingNote([{ type: 'scene', supported: true, generateSupported: false }]), /场景/)
  assert.equal(describeServerSlotPendingNote([{ type: 'prop', supported: true, generateSupported: true }]), '')
})

/* ------------------------------------------------------------------ */
/* 画幅白名单：前端可选值必须与后端白名单逐值相同（需求清单第 2 条）      */
/* ------------------------------------------------------------------ */

test('画面比例可选值 ⊆ 后端白名单（前端不许给出后端会拒的值）', () => {
  /*
   * 后端 `asset_strategies.ASSET_ASPECT_RATIO_ALLOWED` 是画幅的**唯一事实来源**：
   * 调用方传入不在集合内的比例会被**明确拒绝（422）**。前端下拉里多出一个值，
   * 用户选中后就会拿到一个 422 —— 这正是"点下去才知道不行"的失败形态。
   *
   * 这里从**两个真实文件**各抽一次取值集合逐值比较，而不是在测试里再抄一份
   * （抄一份就等于又造了一个漂移点，与本仓库既有的契约对拍护栏同源做法）。
   */
  const backend = readBackendSource('app/services/studio/image_pipeline/asset_strategies.py')
  const allowedBlock = /ASSET_ASPECT_RATIO_ALLOWED[^=]*=\s*\(([^)]*)\)/.exec(backend)
  assert.ok(allowedBlock, '后端找不到 ASSET_ASPECT_RATIO_ALLOWED')
  // 引号风格两种都认（Python 源码里既有单引号也有双引号；只认一种会把护栏变成假红）
  const backendAllowed = new Set(
    Array.from(allowedBlock[1].matchAll(/(['"])([^'"]+)\1/g)).map((m) => m[2]),
  )

  const frontendOptions = new Set(ASPECT_RATIO_OPTIONS.map((item) => item.value))

  assert.ok(backendAllowed.size > 0, '后端白名单解析为空（护栏可能没扫到正确文件）')
  assert.ok(frontendOptions.size > 0, '前端可选值解析为空')

  const offenders = [...frontendOptions].filter((value) => !backendAllowed.has(value))
  assert.deepEqual(
    offenders,
    [],
    `前端给了后端会拒绝的画幅：${offenders.join('、')}（后端允许：${[...backendAllowed].join(' / ')}）`,
  )

  /* 反向自检：把后端白名单临时"收窄一格"必须能让上面那条判定变红（防止护栏恒真）。 */
  const narrowed = new Set([...backendAllowed].filter((item) => item !== '3:4'))
  assert.ok(
    [...frontendOptions].some((value) => !narrowed.has(value)),
    '反向自检失败：收窄后端白名单竟然没有命中任何前端取值，说明这条护栏是恒真的',
  )
})
