import type { ReactNode } from 'react'
import { Button, Card, Space, Tag, Tooltip } from 'antd'
import { ArrowLeftOutlined, InfoCircleOutlined, RightOutlined } from '@ant-design/icons'
import {
  getPrevProjectStepKey,
  getProjectStepIndex,
  getProjectStepMeta,
  PROJECT_STEPS,
  type ProjectStepKey,
  type ProjectStepResolution,
} from '../projectSteps'

type ProjectStepSummaryStripProps = {
  /** 当前渲染的步骤 */
  step: ProjectStepKey
  /** resolveProjectStep 的结果 */
  resolution: ProjectStepResolution
  /** 当前集显示名，例如「第1集 出租屋里的争吵」 */
  chapterLabel: string | null
  /** 「返回修改」：回到上一步 */
  onGoStep: (step: ProjectStepKey) => void
  /** 「继续」：进入判定出的下一步/当前未完成步骤 */
  onContinue: () => void
  /** 折叠起来的「开发信息」节点 */
  devInfo?: ReactNode
}

/**
 * 六步流程摘要条（T3/T4）：
 * - 当前步骤 + 描述；
 * - 完成当前步骤还缺什么（与 resolveProjectStep 同源）；
 * - 主行动按钮「继续」与「返回修改」；
 * 刻意做得很薄——这是摘要条，不是仪表盘。
 */
export function ProjectStepSummaryStrip({
  step,
  resolution,
  chapterLabel,
  onGoStep,
  onContinue,
  devInfo,
}: ProjectStepSummaryStripProps) {
  const meta = getProjectStepMeta(step)
  const index = getProjectStepIndex(step)
  const prevStep = getPrevProjectStepKey(step)
  const onResolvedStep = step === resolution.step
  const isLastStep = index === PROJECT_STEPS.length - 1

  return (
    <Card size="small" className="mb-3" styles={{ body: { padding: '8px 12px' } }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Tag color="blue" className="mr-0">
              第 {index + 1} 步 / 共 {PROJECT_STEPS.length} 步
            </Tag>
            <span className="font-medium">{meta.label}</span>
            <span className="text-xs text-gray-500 truncate">{meta.description}</span>
            {chapterLabel ? (
              <Tag bordered={false} className="mr-0 text-[11px]">
                当前集：{chapterLabel}
              </Tag>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-gray-600">
            <span className="text-gray-500">
              {onResolvedStep ? '当前缺失：' : `当前未完成步骤：第 ${getProjectStepIndex(resolution.step) + 1} 步 ${resolution.label} ·`}
            </span>
            {resolution.missing.length > 0 ? (
              resolution.missing.map((item) => (
                <Tag key={item} color="gold" bordered={false} className="mr-0 text-[11px]">
                  {item}
                </Tag>
              ))
            ) : (
              <Tag color="green" bordered={false} className="mr-0 text-[11px]">
                没有阻塞项
              </Tag>
            )}
            {!onResolvedStep ? (
              <Tooltip title={resolution.reason}>
                <InfoCircleOutlined className="text-gray-400" />
              </Tooltip>
            ) : null}
          </div>
        </div>

        <Space size="small" className="shrink-0">
          {prevStep ? (
            <Button size="small" type="text" icon={<ArrowLeftOutlined />} onClick={() => onGoStep(prevStep)}>
              返回修改
            </Button>
          ) : null}
          <Button size="small" type="primary" icon={<RightOutlined />} onClick={onContinue}>
            {isLastStep && onResolvedStep ? '生成与交付' : `继续：${resolution.nextActionLabel}`}
          </Button>
        </Space>
      </div>

      {devInfo ? <div className="mt-2">{devInfo}</div> : null}
    </Card>
  )
}
