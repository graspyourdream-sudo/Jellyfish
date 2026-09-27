/**
 * 第 2 步的资产类型切换**必须真的能切**。
 *
 * 实测发现的缺口：四个类型计数标签是纯展示的 `Tag`（没有 onClick），
 * `onSelectTab` 作为 prop 收进来了却**从没被调用** —— 于是资产网格永远只显示「人物」，
 * 场景/道具/服装只有计数、点不动，用户没法给它们生成图片或设为定版，
 * 而这一步自己的说明写的是「整理人物、场景、道具、服装 → … → 生成或上传图片 → 设为定版」。
 *
 * 这个测试按源码扫一遍，防止回调被再次摘掉（这类"属性收到了但没人用"的缺口，
 * 单测很难从行为上发现，源码守卫最直接）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'WorkbenchCommandBar.tsx'), 'utf8')

test('类型计数标签接上了切换回调（不再只是展示）', () => {
  assert.match(source, /onClick=\{\(\) => onSelectTab\(tab\)\}/, '类型标签必须调用 onSelectTab')
})

test('切换仍然按类型过滤（四个类型都在清单里）', () => {
  assert.match(source, /WORKBENCH_TABS\.map/)
  assert.match(source, /WORKBENCH_TAB_LABEL\[tab\]/)
})
