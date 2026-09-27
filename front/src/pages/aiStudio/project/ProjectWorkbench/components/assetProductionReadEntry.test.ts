/**
 * 「读取已有出图任务」入口的回归测试（本轮适配缺口）。
 *
 * 缺口：出图提交不写库，任务号只活在浏览器内存 / localStorage，而 localStorage 按
 * origin 隔离；幂等键又依赖从未落库的提示词。结果是"图在出图服务里好好的、公网也能读，
 * 页面却只能重新出图"。这里用源码级断言锁住三件事，避免以后被顺手删掉或改成会花钱的路径：
 *   1. 入口存在（可选择资产 + 填结果编号 + 读取结果）；
 *   2. 只走既有的**只读**读取接口（queryAssetImageTask），不新造请求逻辑；
 *   3. 读取处理器里**没有**任何提交出图（submitAssetImages）调用。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SOURCE = readFileSync(
  new URL('./AssetProductionArea.tsx', import.meta.url),
  'utf8',
)

/** 把「读取已有出图任务」那段处理器切出来（从注释标记到依赖数组结束）。 */
function readHandlerSource(): string {
  const start = SOURCE.indexOf('读取已有出图任务（只读）')
  assert.ok(start > -1, '必须保留「读取已有出图任务」处理器')
  const end = SOURCE.indexOf('提交一轮任务', start)
  assert.ok(end > start, '处理器之后应紧邻「提交一轮任务」分节')
  return SOURCE.slice(start, end)
}

test('入口存在：资产选择 + 任务号输入 + 读取按钮，且带稳定测试标识', () => {
  assert.match(SOURCE, /data-testid="read-existing-task"/)
  assert.match(SOURCE, /placeholder="这条结果属于哪个资产"/)
  assert.match(SOURCE, /placeholder="出图结果编号"/)
  assert.match(SOURCE, /读取结果/)
})

test('只复用既有的只读读取接口，不新造请求逻辑', () => {
  const handler = readHandlerSource()
  assert.match(handler, /queryAssetImageTask\(/, '必须走既有读取客户端')
  assert.match(handler, /resolveTaskQueryPatch\(/, '结果映射必须复用既有归一化')
  assert.ok(!/fetch\(/.test(handler), '处理器内不得直接 fetch')
  assert.ok(!/\/image-pipeline\/submit/.test(handler), '处理器内不得出现提交出图端点')
})

test('读取路径绝不重新出图：处理器内无提交/返工调用', () => {
  const handler = readHandlerSource()
  for (const forbidden of ['submitAssetImages', 'regenerateWithExistingReference', 'submitAssets']) {
    assert.ok(!handler.includes(forbidden), `读取处理器不得调用 ${forbidden}`)
  }
})

test('读取入口的结果进入既有结果卡片，采纳与定版复用既有逻辑', () => {
  const handler = readHandlerSource()
  assert.match(handler, /queuedPlaceholder\(asset\)/, '应复用既有结果行构造')
  // 采纳/定版仍由既有 setPrimary / adoptTask 提供，读数入口不另写一套
  assert.match(SOURCE, /const adoptTask = useCallback/)
  assert.match(SOURCE, /const setPrimary = useCallback/)
  assert.ok(!/adoptAssetImageResult\(/.test(handler), '读取处理器不应自己落库（采纳是用户的下一步）')
})
