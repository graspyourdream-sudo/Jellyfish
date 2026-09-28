/**
 * 分镜工作室 · 批量/整集打包下载的**确认窗口**（唯一实现）。
 *
 * 为什么抽成独立组件：下载入口有两个 —— 底部胶片条的「批量下载已选」与阶段 5 交付下载区的
 * 「打包下载整集全部成片（ZIP）」。两个入口必须**下载前显示包含数量与排除数量**，且文案一致；
 * 各写一个弹窗就会出现"一处说 3 条被排除、另一处没说"的分叉。
 *
 * 数据来自出口B 的**只读预检**（`GET /studio/video-delivery/{id}/bundle/plan`，不读文件字节）：
 * 只有后端知道某个镜头是否真的有可交付成片，页面不替它下结论。
 *
 * 交付形态（已拍板）：整集打包下载 ZIP 就是**正式交付形态**，包内是按镜号命名的逐个镜头成片文件；
 * 失败 / 未生成 / 仅本机不可用的镜头会被排除。
 */

import { Modal } from 'antd'

import type { VideoBundlePlan } from '../../../../../services/videoDeliveryApi'

export type BundleDownloadScope = 'selected' | 'episode'

export type BundleDownloadConfirmProps = {
  open: boolean
  scope: BundleDownloadScope
  /** 后端预检结论（null = 还在读） */
  plan: VideoBundlePlan | null
  loading: boolean
  downloading: boolean
  /** 预检读不到时的本地兜底（来自页面手上那份同一口径的判定） */
  fallbackIncluded: number
  fallbackMessage: string
  fallbackExcluded: { code: string; title: string; reason: string }[]
  onCancel: () => void
  onConfirm: () => void
}

export function BundleDownloadConfirm({
  open,
  scope,
  plan,
  loading,
  downloading,
  fallbackIncluded,
  fallbackMessage,
  fallbackExcluded,
  onCancel,
  onConfirm,
}: BundleDownloadConfirmProps) {
  const included = plan ? plan.included_count : fallbackIncluded
  const summary = plan
    ? `本次会打包 ${plan.included_count} 条成片${
        plan.excluded_count > 0 ? `；另有 ${plan.excluded_count} 个镜头没有可交付成片，未包含。` : '。'
      }`
    : fallbackMessage

  return (
    <Modal
      title={scope === 'episode' ? '确认打包下载整集全部成片（ZIP）' : '确认批量下载已选'}
      open={open}
      onCancel={onCancel}
      onOk={onConfirm}
      okText={`打包下载（${included} 条）`}
      cancelText="取消"
      okButtonProps={{ disabled: included === 0 }}
      confirmLoading={downloading}
      width={520}
      destroyOnHidden
      data-testid="bundle-download-confirm"
    >
      <div className="space-y-2 text-sm">
        <div data-testid="bundle-download-summary">{summary}</div>
        {loading ? <div className="text-xs text-gray-400">正在核对可交付数量…</div> : null}

        {plan && plan.excluded.length > 0 ? (
          <div className="rounded border border-solid border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
            <div className="font-medium">被排除的镜头</div>
            <ul className="mt-1 list-disc pl-4">
              {plan.excluded.map((item) => (
                <li key={item.shot_id}>{`${item.shot_code} · ${item.shot_title}：${item.reason}`}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {!plan && !loading && fallbackExcluded.length > 0 ? (
          <div className="rounded border border-solid border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
            <div className="font-medium">被排除的镜头</div>
            <ul className="mt-1 list-disc pl-4">
              {fallbackExcluded.map((item) => (
                <li key={item.code}>{`${item.code} · ${item.title}：${item.reason}`}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="text-xs leading-5 text-gray-500">
          包里是每个镜头<b>生成成功并已落库、且已被采用 / 定版</b>的那份成片，文件名自带镜号并按镜头顺序排列，
          另附一份「交付清单.txt」逐行写明包内文件名与排除原因。
          失败、未生成、以及只在本机不可用的镜头会被排除，不会混进交付包。
          本操作只读，不产生任何生成费用。
        </div>
      </div>
    </Modal>
  )
}

export default BundleDownloadConfirm
