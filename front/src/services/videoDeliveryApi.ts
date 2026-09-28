/**
 * 出口 B「视频交付 · 批量下载」的前端出入口（第 9 条）。
 *
 * ## 为什么这里必须手写两个函数
 *
 * 仓库口径是「前端调用后端接口统一走 OpenAPI 生成客户端」，但**二进制下载**是个例外：
 * 生成客户端走的是 JSON 响应处理，拿不到 ZIP 字节与 `Content-Disposition` 文件名。
 * 仓里已有同类的既有先例（`llmPipelineApi.downloadDeliveryTxt`：fetch + Blob + `<a download>`），
 * 这里沿用同一套做法与同一条纪律：
 *
 * 1. 地址强制指向 `OpenAPI.BASE`（相对地址会被 Vite 的 SPA fallback 接住 → 打开一个 404 页面
 *    却让人以为"下载成功"）；
 * 2. **不用 `window.open`**：任务书明确禁止"逐个打开多个下载窗口冒充批量下载"；
 * 3. 非 2xx **直接抛错**，由页面提示；错误文案是产品自己写的中文句子
 *    （后端 404 的那句业务结论本身就是产品口径，原样透出），
 *    状态码与响应体**不上屏**。
 *
 * 预检（包含几条 / 排除几条）走生成客户端之外的只读 JSON 端点，同样用 fetch：
 * 它和下载必须是**同一份范围参数**，放在同一个文件里才不会各写一套。
 */

import { OpenAPI } from './generated'

/** 打包范围（与出口 A 的三档一致，页面复用同一套参数） */
export type VideoBundleScope = 'current_shot' | 'episode' | 'episodes'

export type VideoBundleItem = {
  shot_id: string
  shot_code: string
  shot_title: string
  chapter_label: string
  file_name: string
  size_bytes: number
  included: boolean
  reason: string
}

export type VideoBundlePlan = {
  included_count: number
  excluded_count: number
  has_content: boolean
  scope_label: string
  items: VideoBundleItem[]
  excluded: VideoBundleItem[]
  note: string
}

function apiBase(): string {
  return String(OpenAPI.BASE ?? '').replace(/\/+$/, '')
}

/** 组装两个端点共用的查询参数（**唯一实现**：预检与下载的范围不可能不一致）。 */
export function buildVideoBundleQuery(args: {
  scope: VideoBundleScope
  chapterId?: string | null
  shotIds?: string[]
}): URLSearchParams {
  const params = new URLSearchParams()
  params.set('scope', args.scope)
  const selected = (args.shotIds ?? []).map((item) => String(item ?? '').trim()).filter(Boolean)
  if (selected.length) params.set('shot_ids', selected.join(','))
  if (args.chapterId) params.set('chapter_id', args.chapterId)
  return params
}

export function buildVideoBundleUrl(projectId: string, kind: 'plan' | 'bundle', query: URLSearchParams): string {
  const suffix = kind === 'plan' ? 'bundle/plan' : 'bundle'
  return `${apiBase()}/api/v1/studio/video-delivery/${encodeURIComponent(projectId)}/${suffix}?${query.toString()}`
}

/**
 * 下载前的只读预检：**不读视频字节**，所以可以在打开下载确认弹窗时就调。
 *
 * 失败时给中文结论（不含接口路径 / 状态码上屏）。
 */
export async function previewVideoBundle(args: {
  projectId: string
  scope: VideoBundleScope
  chapterId?: string | null
  shotIds?: string[]
}): Promise<VideoBundlePlan> {
  const url = buildVideoBundleUrl(args.projectId, 'plan', buildVideoBundleQuery(args))
  const response = await fetch(url)
  if (!response.ok) {
    await response.text().catch(() => '')
    throw new Error('读取可下载数量失败，请稍后重试')
  }
  const payload = (await response.json()) as { data?: VideoBundlePlan } | null
  const data = payload?.data
  if (!data) throw new Error('读取可下载数量失败：服务端没有返回内容，请稍后重试')
  return data
}

/**
 * 真正下载 ZIP（fetch + Blob + `<a download>`）。
 *
 * 返回文件名与字节数，供页面在成功后给出**具体**的反馈（不是一句"已下载"）。
 */
export async function downloadVideoBundleZip(args: {
  projectId: string
  scope: VideoBundleScope
  chapterId?: string | null
  shotIds?: string[]
}): Promise<{ filename: string; bytes: number; included: number; excluded: number }> {
  const url = buildVideoBundleUrl(args.projectId, 'bundle', buildVideoBundleQuery(args))
  const response = await fetch(url)
  if (!response.ok) {
    /* 404 是"这次没有可交付成片"的正常业务结论 —— 后端把它写成了自然语言，
       这里原样透出那句中文（它本身就是产品口径，不是后端调试原文）。 */
    const text = await response.text().catch(() => '')
    const message = readEnvelopeMessage(text)
    if (message) throw new Error(message)
    throw new Error('打包下载失败，请稍后重试')
  }
  const blob = await response.blob()
  if (!blob.size) throw new Error('打包下载失败：服务端返回了空文件，请稍后重试')

  const disposition = response.headers.get('content-disposition') || ''
  const filename = readFilenameFromDisposition(disposition) || '成片交付.zip'
  triggerBlobDownload(blob, filename)
  return {
    filename,
    bytes: blob.size,
    included: Number(response.headers.get('x-bundle-included') ?? 0) || 0,
    excluded: Number(response.headers.get('x-bundle-excluded') ?? 0) || 0,
  }
}

/**
 * 从 `Content-Disposition` 里取文件名。
 *
 * 先看 RFC 5987 的 `filename*`（中文名走这个），再退回 `filename="..."`；
 * 取不到时返回空串由调用方兜底 —— 绝不把一段带分隔符的原文当文件名用。
 */
export function readFilenameFromDisposition(disposition: string): string {
  const raw = String(disposition ?? '')
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(raw)
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim())
    } catch {
      // 编码坏了就继续看下一个候选
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(raw)
  return plain?.[1]?.trim() ?? ''
}

/** 从统一信封里取那句给用户看的中文结论（取不到返回空串）。 */
export function readEnvelopeMessage(rawBody: string): string {
  try {
    const parsed = JSON.parse(String(rawBody ?? '')) as { message?: unknown; detail?: unknown }
    const message = String(parsed?.message ?? '').trim()
    if (message) return message
    const detail = String(parsed?.detail ?? '').trim()
    return detail
  } catch {
    return ''
  }
}

/** 触发浏览器下载（Blob + 临时 `<a>`），并在用完后释放对象地址。 */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000)
}
