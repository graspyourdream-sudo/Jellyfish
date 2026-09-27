// 运行时环境覆盖位（容器部署时由 Nginx / 入口脚本改写本文件）。
//
// 这里**刻意不再写死 BACKEND_URL 的默认值**。原因（真实事故级问题）：
// `src/services/openapi.ts` 的优先级是
//   window.__ENV?.BACKEND_URL ?? import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8000'
// 而本文件由 index.html 最先加载，一旦在这里写死一个值，`window.__ENV.BACKEND_URL`
// 就**永远命中**——`VITE_BACKEND_URL`（front/.env.example 里文档化推荐的那个开关）
// 变成死开关，`.env.local` / 命令行传参全部失效。
//
// 后果不是"不方便"，而是**花钱安全**问题：想指向隔离后端做验收的人
// （例如另一条并行线的 worktree、或任何独立验收环境）会**静默打到 8000 上那个后端**；
// 如果 8000 恰好是真实付费模式，点一次「生成」就会真实扣费并写进**另一个库**。
//
// 保留这个文件本身（部署仍可在容器启动时覆盖），但默认**不提供**值：
// 开发态交给 VITE_BACKEND_URL → 兜底 'http://localhost:8000'（见 openapi.ts）。
window.__ENV = window.__ENV || {}
