/**
 * 后端地址的**解析优先级**护栏（花钱安全相关，不是风格问题）。
 *
 * 背景（真实事故级发现）：`src/services/openapi.ts` 的优先级是
 *
 *   window.__ENV?.BACKEND_URL ?? import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8000'
 *
 * 而 `public/env.js` 被 `index.html` **最先加载**。它此前写死
 * `BACKEND_URL: 'http://localhost:8000'`，于是：
 *
 * 1. `front/.env.example` 里**文档化推荐**的 `VITE_BACKEND_URL` 变成**死开关**
 *    —— `.env.local`、命令行传参全都无效；
 * 2. 想指向隔离后端做验收的人会**静默打到 8000 上那个后端**。
 *    本机实测：一条并行线的 1440×900 走查里 **68 个请求全部打到 8000**，
 *    而 8000 当时是**真实付费模式**（`guard.dry_run=false, is_real_mode=true`）——
 *    差一步就在别的库上真实扣费。
 *
 * 因此这里同时钉两件事：
 * - `public/env.js` **只保留覆盖位**，不再提供任何后端地址默认值；
 * - `openapi.ts` 里 `VITE_BACKEND_URL` 这条线索必须存在（否则文档化的开关是空话）。
 *
 * 部署仍可在容器启动时改写 `public/env.js`（这就是该文件的用途），不受影响。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const envJsPath = join(here, '..', '..', 'public', 'env.js')
const openapiPath = join(here, 'openapi.ts')

test('public/env.js 不再写死后端地址（否则 VITE_BACKEND_URL 是死开关、且会静默打到别的后端）', () => {
  const source = readFileSync(envJsPath, 'utf-8')
  // 注释里会解释历史，所以只看**代码行**：去掉整行注释后再扫
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  assert.ok(
    !/BACKEND_URL\s*:/.test(code),
    'public/env.js 的代码里不许再出现 BACKEND_URL 赋值：它会抢在 VITE_BACKEND_URL 之前命中',
  )
  assert.ok(
    !/localhost:\d+/.test(code),
    'public/env.js 的代码里不许出现写死的本机后端地址',
  )
  // 覆盖位本身要保留：容器部署靠改写这个文件生效
  assert.match(code, /window\.__ENV\s*=\s*window\.__ENV\s*\|\|\s*\{\}/, '必须保留 window.__ENV 覆盖位')
})

test('openapi.ts 仍然保留 VITE_BACKEND_URL 这条线索（否则 .env.example 的说明是空话）', () => {
  const source = readFileSync(openapiPath, 'utf-8')
  assert.match(source, /import\.meta\.env\.VITE_BACKEND_URL/, 'openapi.ts 必须读 VITE_BACKEND_URL')
  assert.match(source, /window\.__ENV/, 'openapi.ts 仍要支持 window.__ENV 运行时覆盖')
})
