/**
 * 资产卡片的字段口径 —— 设计包 §8「四列资产卡规则」。
 *
 * 卡面**只放 7 项**：名称 / 类型 / 关键资料摘要（最多两行）/ 出场镜头 / 缺失项 /
 * 当前状态（最多 1 个主状态标签）/ **一个**主要操作。
 * 完整结构化资料、剧本依据、提示词全文、历史结果一律进详情抽屉。
 *
 * 这里钉两件事：① 「缺失项」与「唯一动作」两个纯函数的口径；
 * ② 卡面源码确实按这套口径渲染（防有人把「编辑资料 / 编辑提示词」又平铺回卡面）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  WORKBENCH_VOICE_BOUND_IN_DETAIL,
  cardActionAvailability,
  deriveCardAction,
  describeWorkbenchMissingItems,
  workbenchMissingItems,
  type WorkbenchItemLike,
} from './workbenchState.ts'

const here = dirname(fileURLToPath(import.meta.url))

function item(overrides: Partial<WorkbenchItemLike> = {}): WorkbenchItemLike {
  return {
    asset_type: 'character',
    asset_id: 'c-1',
    name: '小林',
    profile_digest: '便利店店员，短发',
    status: null,
    prompt: { text: '正面半身，便利店夜景', quality: null, saved: true },
    image: { has_image: true, has_primary: true },
    batch_eligible: true,
    ...overrides,
  }
}

/* ------------------------------------------------------------- 缺失项 */

test('齐全时「缺失项」写「无」', () => {
  assert.deepEqual(workbenchMissingItems(item()), [])
  assert.equal(describeWorkbenchMissingItems(item()), '无')
})

test('缺资料 / 缺提示词 / 缺图片 / 缺定版图各自单独列出', () => {
  assert.equal(describeWorkbenchMissingItems(item({ profile_digest: '' })), '缺资料')
  assert.equal(describeWorkbenchMissingItems(item({ prompt: { text: '', quality: null } })), '缺图片提示词')
  assert.equal(
    describeWorkbenchMissingItems(item({ image: { has_image: false, has_primary: false } })),
    '缺图片',
  )
  assert.equal(
    describeWorkbenchMissingItems(item({ image: { has_image: true, has_primary: false } })),
    '缺定版图',
  )
})

test('多项缺失时按固定顺序合并（便于扫一眼）', () => {
  assert.equal(
    describeWorkbenchMissingItems(
      item({ profile_digest: '', prompt: { text: '' }, image: { has_image: false } }),
    ),
    '缺资料、缺图片提示词、缺图片',
  )
})

test('拿不到 ≠ 缺失：契约没给 prompt / image 时一律不判缺失', () => {
  assert.deepEqual(workbenchMissingItems(item({ prompt: null, image: null })), [])
})

/* --------------------------------------------------------- 角色声音缺项 */

test('后端没说声音时**不判**缺失（否则每个角色都会被误报）', () => {
  assert.equal(workbenchMissingItems(item()).includes('voice'), false)
  assert.equal(workbenchMissingItems(item({ voice: null })).includes('voice'), false)
  assert.equal(workbenchMissingItems(item({ voice: {} })).includes('voice'), false)
})

test('后端明确说没绑声音 → 人物出现「缺角色声音」', () => {
  assert.equal(describeWorkbenchMissingItems(item({ voice: { bound: false } })), '缺角色声音')
})

test('声音缺项的下一步写在人物资产详情里（设计包 §8/§10）', () => {
  assert.match(WORKBENCH_VOICE_BOUND_IN_DETAIL, /人物资产详情/)
  const source = readFileSync(join(here, 'AssetCardGrid.tsx'), 'utf8')
  assert.match(source, /WORKBENCH_VOICE_BOUND_IN_DETAIL/, '卡面必须把"去哪儿绑"写在声音缺项旁边')
})

test('非人物资产不出现声音缺项（声音只属于人物资产）', () => {
  assert.equal(
    workbenchMissingItems(item({ asset_type: 'scene', voice: { bound: false } })).includes('voice'),
    false,
  )
})

/* ------------------------------------------------------- 唯一主要操作 */

test('卡面动作按状态给唯一一个（设计包 §8 的动作清单）', () => {
  const cases: [Partial<WorkbenchItemLike>, string, string][] = [
    [{ image: { has_image: false }, prompt: { text: 'x' } }, 'generate', '生成图片'],
    [{ image: { has_image: true, has_primary: false } }, 'view_result', '查看结果'],
    [{ image: { has_image: true, has_primary: true } }, 'regenerate', '再生成一张'],
    /* 「待生成提示词」在兜底推导里由 `needs_regeneration` 或后端 status.key 给出
       （前端的兜底链把"没有提示词"归到「待补资料」——这是既有口径，本次不动）。 */
    [{ status: { key: 'needs_prompt' } }, 'generate_prompt', '生成提示词'],
    [{ prompt: { text: '旧提示词', quality: { needs_regeneration: true } } }, 'generate_prompt', '生成提示词'],
    [{ profile_digest: '', prompt: null, image: null }, 'supplement_profile', '补充资料'],
  ]
  cases.forEach(([overrides, kind, label]) => {
    const action = deriveCardAction(item(overrides))
    assert.equal(action.kind, kind, `期望 ${kind}`)
    assert.equal(action.label, label, `期望文案 ${label}`)
  })
})

test('正在生成的人物 → 「查看进度」；商品 → 「上传商品图 / 设为定版」', () => {
  const generating = deriveCardAction(item({ status: { key: 'generating' } }))
  assert.equal(generating.kind, 'view_progress')
  const product = deriveCardAction(item({ asset_type: 'product', image: { has_image: false } }))
  assert.equal(product.kind, 'upload_product_image')
  assert.equal(product.label, '上传商品图 / 设为定版')
})

test('失败项按有没有图分别给「重试」的两条通道', () => {
  const withImage = deriveCardAction(item({ image: { has_image: true, has_primary: false }, status: { key: 'failed' } }))
  assert.equal(withImage.kind, 'regenerate')
  assert.equal(withImage.label, '重试')
  const withoutImage = deriveCardAction(item({ image: { has_image: false }, status: { key: 'failed' } }))
  assert.equal(withoutImage.kind, 'generate')
  assert.equal(withoutImage.label, '重试')
})

test('未登记的类型 → 出图动作禁用并说明（不给点了没反应的按钮）', () => {
  /* 注意「服装」按本仓库既有口径**仍算支持**（`WORKBENCH_SUBMITTABLE_TYPES` 含 costume，
     见 workbenchState 里那行注释），所以真正不可出图的是**未登记的类型**（`other`）。 */
  const result = cardActionAvailability(item({ asset_type: 'faction', image: { has_image: false } }), {
    busy: false,
    canOpenAssetEditor: true,
  })
  assert.equal(result.disabled, true)
  assert.match(result.reason, /不认识/)
})

test('服装按既有口径仍算支持 → 出图动作可点（口径没被这次改动作映射改掉）', () => {
  const result = cardActionAvailability(item({ asset_type: 'costume', image: { has_image: false } }), {
    busy: false,
    canOpenAssetEditor: true,
  })
  assert.equal(result.disabled, false)
})

test('查看进度 / 查看结果 / 补充资料不花钱，永远可点', () => {
  ;['view_progress', 'view_result', 'supplement_profile'].forEach((kind) => {
    const target =
      kind === 'view_progress'
        ? item({ status: { key: 'generating' } })
        : kind === 'view_result'
          ? item({ image: { has_image: true, has_primary: false } })
          : item({ profile_digest: '', prompt: null, image: null })
    assert.equal(deriveCardAction(target).kind, kind, `前置条件不成立：${kind}`)
    const result = cardActionAvailability(target, { busy: false, canOpenAssetEditor: true })
    assert.equal(result.disabled, false, `${kind} 不该被禁用`)
  })
})

/* ----------------------------------------------------------- 卡面源码守卫 */

test('卡面：摘要两行截断、网格 236、缩略区最高 150', () => {
  const source = readFileSync(join(here, 'AssetCardGrid.tsx'), 'utf8')
  assert.match(source, /line-clamp-2/, '资料摘要必须最多两行后截断（设计包 §8）')
  assert.equal(source.includes('line-clamp-3'), false, '旧的 3 行截断不许回来')
  assert.match(source, /minmax\(236px, 1fr\)/, '网格必须是 minmax(236px,1fr)（1440 下每行 4 张）')
  assert.match(source, /maxHeight: 150/, '缩略区最高 150（设计包 §8）')
})

test('卡面：名称 + 类型整块是抽屉入口，且不再平铺「编辑资料 / 编辑提示词」', () => {
  const source = readFileSync(join(here, 'AssetCardGrid.tsx'), 'utf8')
  assert.match(source, /完整资料/, '抽屉入口必须标出「完整资料」')
  assert.match(source, /data-testid="asset-card-detail-entry"/)
  // 编辑资料入口已从卡面移除（它在详情抽屉里renderProfileEditor）
  assert.equal(source.includes('renderProfileEditor'), false, '卡面不许再挂资料编辑入口')
})

test('卡面：整个卡片只有一个主要动作按钮', () => {
  const source = readFileSync(join(here, 'AssetCardGrid.tsx'), 'utf8')
  const primaryButtons = source.match(/type="primary"/g) ?? []
  assert.equal(primaryButtons.length, 1, `卡面只允许一个主色按钮，实际 ${primaryButtons.length} 个`)
})
