/**
 * 生成入口的「点击前状态条」。
 *
 * 统一显示五类状态里的当前一类：已配置但被 DRY_RUN 阻止 / 模型未配置 /
 * 参数缺失 / 服务错误 / 正在处理。默认显示门禁与模型配置，
 * 调用方传入 `failure` 时改为显示本次失败的真实原因（不再出现 `status=unknown` 这种空话）。
 */

import { Alert, Space, Tag } from 'antd'
import type { GenerationFailure, GenerationGateInfo, GenerationGateSnapshot } from './generationGate'
import { classifyGenerationFailure, describeGenerationGate } from './generationGate'
import type { GenerationOutlet } from './generationGate'

type GenerationGateBannerProps = {
  gate: GenerationGateSnapshot
  outlet: GenerationOutlet
  /** 正在处理中（请求已发出） */
  running?: boolean
  runningText?: string
  /** 本次失败的分类结果；传了就优先显示失败原因 */
  failure?: GenerationFailure | null
  /** 失败时的原始异常（没传 failure 时由它自动分类） */
  error?: unknown
  compact?: boolean
}

export function GenerationGateBanner({
  gate,
  outlet,
  running = false,
  runningText,
  failure,
  error,
  compact = false,
}: GenerationGateBannerProps) {
  const resolvedFailure = failure ?? (error ? classifyGenerationFailure(error, outlet) : null)
  const info: GenerationGateInfo =
    resolvedFailure !== null
      ? {
          state: resolvedFailure.state,
          tone: resolvedFailure.tone,
          label: resolvedFailure.title,
          description: `真实原因：${resolvedFailure.reason}`,
        }
      : describeGenerationGate(gate, outlet, { running, runningText })

  const toneToAlert: Record<string, 'success' | 'warning' | 'error' | 'info'> = {
    success: 'success',
    warning: 'warning',
    error: 'error',
    info: 'info',
  }

  return (
    <Alert
      type={toneToAlert[info.tone] ?? 'info'}
      showIcon
      message={
        <Space size={6} wrap>
          <span className="text-xs font-medium">{info.label}</span>
          <Tag bordered={false} className="mr-0 text-[10px]">
            状态：{info.state}
          </Tag>
        </Space>
      }
      description={compact ? undefined : <span className="text-xs">{info.description}</span>}
      style={{ marginBottom: compact ? 0 : 8 }}
    />
  )
}

export default GenerationGateBanner
