/**
 * 出图结果卡片（要求 11）。
 *
 * 只展示用户能决定的东西：生成图、资产名称与类型、当前状态、以及
 * 「查看详情 / 编辑提示词 / 重新生成 / 采纳 / 设为定版 / 已定版标识」这几个动作。
 * 任务号、归一化状态、模型名、供应商一律**不在这里出现**（它们在默认收起的「技术详情」里）。
 */

import { useState } from 'react'
import { Alert, Button, Card, Space, Tag, Tooltip, Typography } from 'antd'
import {
  CheckCircleFilled,
  PictureOutlined,
  ReloadOutlined,
  SyncOutlined,
} from '@ant-design/icons'
import {
  ASSET_TYPE_LABEL,
  describeTaskStatus,
  type ProductionAsset,
  type ProductionTask,
} from './assetProduction'

const TONE_COLOR: Record<string, string> = {
  green: 'green',
  red: 'red',
  blue: 'blue',
  gold: 'gold',
  default: 'default',
}

export type AssetResultCardProps = {
  task: ProductionTask
  asset?: ProductionAsset
  /** 该卡片上的某个动作正在执行 */
  busy: boolean
  onViewDetail: (task: ProductionTask) => void
  onEditPrompt: (task: ProductionTask) => void
  onRegenerate: (task: ProductionTask) => void
  onRetry: (task: ProductionTask) => void
  onAdopt: (task: ProductionTask) => void
  onSetPrimary: (task: ProductionTask) => void
  onRefresh: (task: ProductionTask) => void
}

export function AssetResultCard(props: AssetResultCardProps) {
  const { task, asset, busy } = props
  const [imageBroken, setImageBroken] = useState(false)
  const status = describeTaskStatus(task.status)
  const previewUrl = task.adoptedUrl || task.ossUrl || task.imageUrl
  const canAdopt = task.status === 'done' && !task.adoptedImageId
  // 「设为定版」在结果可用时就可以点：它内部会先把这张保存进资产、再设为定版；
  // 资产已有定版时会先弹二次确认（硬边界 B），不会静默替换。
  const canSetPrimary = task.status === 'done' && !task.isPrimary
  const canRetry = task.status === 'failed'
  const canRefresh = task.status === 'generating' || task.status === 'submitting'

  return (
    <Card size="small" className="h-full" styles={{ body: { padding: 12 } }}>
      <div className="flex gap-3">
        <div className="h-[96px] w-[96px] shrink-0 overflow-hidden rounded-md border border-slate-200 bg-slate-50 flex items-center justify-center">
          {previewUrl && !imageBroken ? (
            <img
              src={previewUrl}
              alt={task.assetName}
              className="h-full w-full object-cover"
              onError={() => setImageBroken(true)}
            />
          ) : (
            <span className="flex flex-col items-center gap-1 text-[11px] text-gray-400">
              <PictureOutlined />
              {task.status === 'dry_run' ? '演练占位（非真实图片）' : '暂无图片'}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1">
            <Tag color="purple" className="mr-0" bordered={false}>
              {ASSET_TYPE_LABEL[task.assetType]}
            </Tag>
            <span className="truncate text-sm font-medium text-slate-900" title={task.assetName}>
              {task.assetName}
            </span>
            <Tag color={TONE_COLOR[status.tone]} bordered={false} className="mr-0">
              {status.label}
            </Tag>
            {task.isPrimary ? (
              <Tag color="green" bordered={false} className="mr-0">
                <CheckCircleFilled /> 已定版
              </Tag>
            ) : asset?.hasPrimary ? (
              <Tooltip title="该资产已有定版图；这张只是本次生成的结果，要换定版需要你手动确认">
                <Tag bordered={false} className="mr-0 text-gray-400">
                  未定版（资产已有定版）
                </Tag>
              </Tooltip>
            ) : null}
            {task.adoptedImageId !== null ? (
              <Tag color="blue" bordered={false} className="mr-0">
                已保存进资产
              </Tag>
            ) : null}
          </div>

          {task.errorMessage ? (
            <Alert
              type="error"
              showIcon
              banner
              style={{ padding: '2px 8px' }}
              message={<span className="text-[11px]">{task.errorMessage}</span>}
            />
          ) : task.note ? (
            <div className="text-[11px] text-slate-500">{task.note}</div>
          ) : null}

          <Typography.Paragraph
            className="!mb-0 text-[11px] text-gray-500"
            ellipsis={{ rows: 2, tooltip: task.prompt || '（还没有提示词）' }}
          >
            {task.prompt || '（还没有提示词）'}
          </Typography.Paragraph>

          <Space size={4} wrap>
            {canAdopt ? (
              <Tooltip title="把这张图存进该资产的图片里（不会自动改定版）">
                <Button size="small" type="primary" loading={busy} onClick={() => props.onAdopt(task)}>
                  采纳
                </Button>
              </Tooltip>
            ) : null}
            {canSetPrimary ? (
              <Tooltip title="把这张设为该资产的定版图（会先保存进资产）；资产已有定版时会先与你确认">
                <Button size="small" loading={busy} onClick={() => props.onSetPrimary(task)}>
                  设为定版
                </Button>
              </Tooltip>
            ) : null}
            <Button size="small" onClick={() => props.onEditPrompt(task)}>
              编辑提示词
            </Button>
            <Button size="small" icon={<ReloadOutlined />} loading={busy} onClick={() => props.onRegenerate(task)}>
              重新生成
            </Button>
            {canRetry ? (
              <Button size="small" onClick={() => props.onRetry(task)}>
                重试这一项
              </Button>
            ) : null}
            {canRefresh ? (
              <Button size="small" icon={<SyncOutlined />} onClick={() => props.onRefresh(task)}>
                刷新进度
              </Button>
            ) : null}
            <Button size="small" type="link" className="!px-1" onClick={() => props.onViewDetail(task)}>
              查看详情
            </Button>
          </Space>
        </div>
      </div>
    </Card>
  )
}

export default AssetResultCard
