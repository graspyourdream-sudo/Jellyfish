/**
 * 「资产准备清单」手写类型 ↔ 生成客户端的**契约对拍**护栏。
 *
 * 为什么需要它（这不是风格问题，是一条真实漂移）：
 * `src/services/projectAssetReadiness.ts` 的 `ProjectAssetReadinessType` 是**手写**的，
 * 而 `src/services/generated/models/ProjectAssetReadinessItem.ts` 是**生成**的。
 * 商品成为第五类资产后，后端 `project_asset_readiness._build_specs()` 已经会返回
 * `asset_type="product"` 的行，但手写联合还停在四类 —— 页面读到的行数是 5 而类型说 4，
 * **不报错、不掉页**，只是商品的准备状态在 TS 侧"看不见"。
 *
 * 三条一起钉住：
 * 1. **类型级对拍**（编译期）：两侧必须互相可赋值，多一个或漏一个都编译不过；
 * 2. **源码对拍**（运行期，`node --test` 直接跑）：从**两个真实文件**里各抽出字面量集合逐值比较
 *    —— 手写那一侧的取值域不在这里再抄一遍，避免护栏自己成为第三个漂移点；
 * 3. **反向自检**：两个集合都必须非空且含 `product`，并证明"少一类"真的会让对拍失败
 *    （防止这条护栏永远为真的假绿）。
 *
 * 为什么不 import 被测模块：`projectAssetReadiness.ts` 会拉进 `llmPipelineApi` →
 * 浏览器侧 HTTP 客户端，`node --test` 解析不了（本仓库的纯逻辑测试都只 import 纯模块）。
 * 所以这里只用 `import type`（编译期擦除）+ 读源码，运行时零依赖。
 *
 * 与仓库既有护栏同源：`services/backendUrlPrecedence.test.ts` 也是"扫源码 + 断言关键线索"。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import type { ProjectAssetReadinessType } from './projectAssetReadiness.ts'
import type { ProjectAssetReadinessItem as GeneratedReadinessItem } from './generated/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const handWrittenPath = join(here, 'projectAssetReadiness.ts')
const generatedModelPath = join(here, 'generated', 'models', 'ProjectAssetReadinessItem.ts')

/* ------------------------------------------------------------------ 1. 类型级对拍 */

/** 两侧互相可赋值才算相等：`A extends B` 且 `B extends A`。 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/**
 * 编译期断言：手写联合 == 生成客户端的 `asset_type` 联合。
 *
 * 少写 `'product'`，或生成客户端换成别的取值域，这里都会**编译失败**
 * （`tsc --noEmit` 是验收的必经步骤），而不是等到页面上静默少一行。
 */
const typesMatchGeneratedContract: MutuallyAssignable<
  ProjectAssetReadinessType,
  GeneratedReadinessItem['asset_type']
> = true

test('类型级对拍：手写 ProjectAssetReadinessType 与生成客户端的 asset_type 互相可赋值', () => {
  assert.equal(typesMatchGeneratedContract, true)
})

/* ------------------------------------------------------------- 2. 两个真实文件对拍 */

/** 从一段源码里按 `键 =`（或 `键:` 声明）抽出字面量联合（两侧都固定写成 `'a' | 'b'`）。 */
function readUnionLiterals(source: string, key: string, where: string): string[] {
  const match =
    source.match(new RegExp(`${key}\\s*=\\s*([^\\n;]+)`)) ?? source.match(new RegExp(`${key}:\\s*([^\\n;]+)`))
  assert.ok(match, `在 ${where} 里没找到 ${key} 的声明`)
  const values = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.ok(values.length >= 2, `${where} 的 ${key} 扫描结果太少，可能是正则失效：${JSON.stringify(values)}`)
  return values
}

const handWrittenTypes = readUnionLiterals(
  readFileSync(handWrittenPath, 'utf-8'),
  'ProjectAssetReadinessType',
  'projectAssetReadiness.ts',
)
const generatedTypes = readUnionLiterals(
  readFileSync(generatedModelPath, 'utf-8'),
  'asset_type',
  'generated/models/ProjectAssetReadinessItem.ts',
)

test('源码对拍：手写集合与生成客户端的 asset_type 集合逐值相同（含商品）', () => {
  assert.deepEqual(
    [...handWrittenTypes].sort(),
    [...generatedTypes].sort(),
    '两侧资产类型集合不一致：少一个只会让页面静默少一行，所以必须红',
  )
})

test('反向自检：两个集合都真的读到了东西，且都含 product（防假绿）', () => {
  assert.ok(handWrittenTypes.includes('product'), `手写侧缺商品：${JSON.stringify(handWrittenTypes)}`)
  assert.ok(generatedTypes.includes('product'), `生成侧缺商品：${JSON.stringify(generatedTypes)}`)
  assert.ok(handWrittenTypes.length >= 5, `手写侧取值域过窄：${JSON.stringify(handWrittenTypes)}`)
  assert.ok(generatedTypes.length >= 5, `生成侧取值域过窄：${JSON.stringify(generatedTypes)}`)
})

test('护栏本身有效：把 product 去掉后两个集合就不相等（不是永远为真）', () => {
  const withoutProduct = handWrittenTypes.filter((value) => value !== 'product')
  assert.notDeepEqual(
    [...withoutProduct].sort(),
    [...generatedTypes].sort(),
    '这个用例证明"少一类"确实会让上面的对拍失败',
  )
})
