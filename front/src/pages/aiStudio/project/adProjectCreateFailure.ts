/**
 * 广告项目创建失败时的**用户可见说明**（纯函数，便于单测）。
 *
 * ## 为什么单独抽出来
 *
 * 真机反馈：点「创建并进入策划」弹的是
 *
 * ```
 * 原因：Failed to fetch
 * 下一步：确认网络后直接再点一次「创建并进入策划」；如果一直失败，请稍后再试或联系管理员。
 * ```
 *
 * 这段文案有两个问题，都会让用户**越试越糊涂**：
 *
 * 1. `Failed to fetch` 是浏览器抛的英文原文，用户看不懂，而且它**不是**"网络不稳定"——
 *    它意味着请求根本没送到服务（后端没在运行 / 地址不对 / 被 CORS 拦下）。
 *    这种情况**重试同一个操作永远不会变好**，光读文案的人会一直点。
 * 2. 文案里没有**任何地址**。本机同时开着多个 worktree 时，"到底在连哪个后端"
 *    是排查的第一信息（8000 上可能是另一个 worktree 的服务，甚至是真实模式）。
 *
 * ## 判据（与图片/视频链路同一口径）
 *
 * 「有没有拿到 HTTP 状态码」是这两件事的分界线，见
 * `pages/aiStudio/components/generationStatusCore.ts` 里 `status === null` 那条分支：
 *
 * - **拿不到状态码** → 请求没送到（本模块 `isBackendUnreachable` 为 true）；
 * - 拿到了 4xx/5xx → 请求送到了、服务自己失败（保持原有文案，不动）。
 */

/* ⚠️ 这里必须带 `.ts` 扩展名：本模块被单测直接引入，`node --test` 的 ESM 解析
   不做扩展名补全（本仓同类模块的既有写法，见 `assetProduction.ts`）。 */
import { OpenAPI } from '../../../services/generated/core/OpenAPI.ts'

/** 从异常里读 HTTP 状态码（生成客户端的 `ApiError` 带 `.status`）。 */
function readHttpStatus(exc: unknown): number | null {
  const value = (exc as { status?: unknown } | null | undefined)?.status
  return typeof value === 'number' ? value : null
}

/**
 * 当前后端基址，仅供**展示**。
 *
 * 取值就是生成客户端的 `OpenAPI.BASE`（由 `services/openapi.ts` 按
 * `window.__ENV.BACKEND_URL → VITE_BACKEND_URL → 默认值` 初始化）。
 * 同源部署时它是空串 —— 那时不显示地址，也不显示一对空括号。
 */
export function backendBaseUrlLabel(): string {
  return String(OpenAPI.BASE ?? '')
    .trim()
    .replace(/\/+$/, '')
}

/**
 * 请求是否**根本没送到服务**。
 *
 * `false` 只说明"不是这种情况"，不代表创建一定失败 —— 调用方只用它选文案。
 */
export function isBackendUnreachable(exc: unknown): boolean {
  /* 有状态码 = 服务应答过 = 送到了，不属于"连不上"。 */
  if (readHttpStatus(exc) !== null) return false
  const message = exc instanceof Error ? exc.message : typeof exc === 'string' ? exc : ''
  /* 各浏览器/平台对"送不到"的原文不同：Chrome/Edge 是 `Failed to fetch`，
     Safari 是 `Load failed`，Firefox 是 `NetworkError when attempting to fetch resource.`，
     React Native / 各类 polyfill 是 `Network request failed`。 */
  return /failed to fetch|networkerror|load failed|network request failed|err_connection|err_network|err_address_unreachable/i.test(
    message,
  )
}

/**
 * 创建失败的「原因」+「下一步」两行（第一行"有没有保存"由弹窗自己给）。
 *
 * 三件事口径（与弹窗一致）：发生了什么 / 项目有没有保存 / 接下来怎么办。
 */
export function describeAdProjectCreateFailure(exc: unknown): {
  reasonLine: string
  nextStepLine: string
} {
  const base = backendBaseUrlLabel()
  if (isBackendUnreachable(exc)) {
    return {
      reasonLine: `原因：连不上后端服务${base ? `（${base}）` : ''} —— 请求没有送到服务，这不是数据问题。`,
      nextStepLine:
        '下一步：先把后端服务跑起来（双击项目根目录的「启动像素小新.command」），' +
        '确认右上角不再是「模式未知」，再点一次「创建并进入策划」。',
    }
  }
  const raw = exc instanceof Error && exc.message ? exc.message : ''
  return {
    /* `empty project` 是 `createAdProject` 自己的内部标记，对它只说结论、不回显。 */
    reasonLine:
      raw && raw !== 'empty project'
        ? `原因：${raw}`
        : '原因：创建接口这次没有成功（可能是网络或服务暂时不可用）。',
    nextStepLine: '下一步：确认网络后直接再点一次「创建并进入策划」；如果一直失败，请稍后再试或联系管理员。',
  }
}
