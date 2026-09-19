/**
 * 第 2 步「提取资产」的只读候选概览。
 *
 * 为什么需要：真实跑过第 2 步之后，`shot_extracted_candidates` 会产生成百条候选
 * （本项目实测 294 条 → 聚合 80 组），但工作台的第 2 步此前只显示"已建立的资产"，用户
 * 看不到"还有多少候选等着确认"，也不知道哪些能直接挂到已有资产、哪些需要新建。
 *
 * 数据来自只读聚合接口 `/chapters/{id}/asset-candidates`：不建资产、不写库、不触网。
 * 确认动作仍由用户在章节工作室的「资产绑定 / 确认诊断」里逐条做（本组件只摆事实，不代替决策）。
 */

import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Collapse, Empty, Space, Table, Tag, Typography } from 'antd'
import type { CollapseProps, TableColumnsType } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import {
  fetchChapterAssetCandidates,
  type ChapterAssetCandidateItem,
  type ChapterAssetCandidates,
} from '../../../../../services/llmPipelineApi'

type ProjectExtractCandidatesPanelProps = {
  chapterId: string | null
  chapterLabel: string | null
}

const TYPE_COLOR: Record<string, string> = {
  character: 'purple',
  scene: 'blue',
  prop: 'gold',
  costume: 'cyan',
}

export function ProjectExtractCandidatesPanel({
  chapterId,
  chapterLabel,
}: ProjectExtractCandidatesPanelProps) {
  const [data, setData] = useState<ChapterAssetCandidates | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!chapterId) return
    setLoading(true)
    setError('')
    try {
      setData(await fetchChapterAssetCandidates(chapterId))
    } catch (e) {
      setError((e as Error)?.message || '提取候选加载失败')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [chapterId])

  useEffect(() => {
    void load()
  }, [load])

  if (!chapterId) return null

  const summary = data?.summary ?? {}
  const items = data?.items ?? []
  const linkExisting = Number(summary.link_existing_count ?? 0)
  const createNew = Number(summary.create_new_count ?? 0)
  // 候选处理状态：全部确认完之后再标「待确认」就是误导，所以按状态分开显示。
  const byStatus = (summary.by_status ?? {}) as Record<string, number>
  const pendingCount = Number(byStatus.pending ?? 0)
  const handledCount = Object.entries(byStatus)
    .filter(([key]) => key !== 'pending')
    .reduce((sum, [, value]) => sum + Number(value ?? 0), 0)

  const columns: TableColumnsType<ChapterAssetCandidateItem> = [
    {
      title: '候选',
      dataIndex: 'name',
      ellipsis: true,
      render: (name: string, row) => (
        <span className="flex items-center gap-2 min-w-0">
          <Tag color={TYPE_COLOR[row.candidate_type] ?? 'default'} className="mr-0">
            {row.type_label || row.candidate_type}
          </Tag>
          <span className="truncate" title={name}>
            {name}
          </span>
          {(row.aliases ?? []).length > 0 ? (
            <span className="text-xs text-gray-400">{`(${row.aliases.join('、')})`}</span>
          ) : null}
        </span>
      ),
    },
    {
      title: '出现镜头',
      dataIndex: 'shot_count',
      width: 96,
      render: (count: number) => <Tag bordered={false}>{`${count} 镜`}</Tag>,
    },
    {
      title: '对账结果',
      key: 'reconcile',
      width: 210,
      render: (_: unknown, row) =>
        row.recommendation === 'link_existing' ? (
          <Space size={4} wrap>
            <Tag color="green" bordered={false}>
              可挂已有资产
            </Tag>
            <span className="text-xs text-gray-500 font-mono">{row.existing_asset_id}</span>
          </Space>
        ) : (
          <Tag color="gold" bordered={false}>
            尚无同名资产（需新建）
          </Tag>
        ),
    },
    {
      title: '关联状态',
      key: 'linked',
      width: 150,
      render: (_: unknown, row) => (
        <Space size={4} wrap>
          <Tag color={row.linked_to_project ? 'blue' : 'default'} bordered={false}>
            {row.linked_to_project ? '已进项目' : '未进项目'}
          </Tag>
          <Tag color={row.linked_to_shot ? 'blue' : 'default'} bordered={false}>
            {row.linked_to_shot ? '已绑镜头' : '未绑镜头'}
          </Tag>
        </Space>
      ),
    },
  ]

  const collapseItems: CollapseProps['items'] = [
    {
      key: 'candidates',
      label: (
        <Space size={8} wrap>
          <span className="text-sm font-medium">
            {`本集提取候选（第 2 步产物${pendingCount > 0 ? '，待确认' : '，已确认'}）`}
          </span>
          <Tag color="blue" bordered={false}>{`候选 ${summary.total_candidates ?? 0} 条`}</Tag>
          <Tag bordered={false}>{`聚合 ${summary.merged_groups ?? 0} 组`}</Tag>
          {pendingCount > 0 ? (
            <Tag color="gold" bordered={false}>{`待确认 ${pendingCount} 条`}</Tag>
          ) : (
            <Tag color="green" bordered={false}>{`已确认 ${handledCount} 条`}</Tag>
          )}
          <Tag color={linkExisting > 0 ? 'green' : 'default'} bordered={false}>
            {`可挂已有资产 ${linkExisting} 组`}
          </Tag>
          <Tag color={createNew > 0 ? 'gold' : 'default'} bordered={false}>
            {`需新建 ${createNew} 组`}
          </Tag>
        </Space>
      ),
      children: (
        <div className="space-y-3">
          {error ? <Alert type="error" showIcon message="加载失败" description={error} /> : null}
          {items.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span className="text-xs text-gray-500">
                  本集还没有提取候选（第 2 步尚未真实跑过；真实调用大模型后才会产生）。
                </span>
              }
            />
          ) : (
            <>
              <Typography.Text type="secondary" className="text-[11px]">
                {`${chapterLabel ?? '当前集'} 共 ${data?.shot_total ?? 0} 镜，其中 ${data?.shot_with_candidates ?? 0} 镜有候选。`}
                「可挂已有资产」表示项目里已有同名资产，确认时直接关联即可；其余需要新建资产。
              </Typography.Text>
              <Table<ChapterAssetCandidateItem>
                rowKey={(row) => `${row.candidate_type}:${row.name}`}
                size="small"
                loading={loading}
                columns={columns}
                dataSource={items}
                pagination={{ pageSize: 8, size: 'small' }}
              />
              {(data?.notes ?? []).length > 0 ? (
                <div className="text-[11px] text-gray-400 space-y-0.5">
                  {data?.notes.map((note) => (
                    <div key={note}>{note}</div>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      ),
    },
  ]

  return (
    <Card
      size="small"
      className="mb-2"
      styles={{ body: { paddingTop: 8, paddingBottom: 8 } }}
      extra={
        <Button size="small" type="text" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          刷新候选
        </Button>
      }
    >
      {/* 默认收起：候选列表长达 80 行，展开会把下面的资产网格顶下去；
          需要看细节时点标题展开即可（数据在挂载时就已加载好）。 */}
      <Collapse ghost items={collapseItems} />
    </Card>
  )
}

export default ProjectExtractCandidatesPanel
