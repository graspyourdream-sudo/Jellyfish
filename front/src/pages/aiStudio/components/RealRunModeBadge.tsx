/**
 * 「演练模式 / 真实模式」角标 + 被拦截时的「原因 + 怎么开」。
 *
 * 为什么挂在顶部外壳上：守卫管的是**所有**付费出口（大模型 / 出图 / 出视频 / OSS 上传），
 * 每个页面都可能踩到，放在全局壳上才不会出现「这页显示演练、那页看不出来」。
 *
 * 内容分四块（全部中文、可照做）：
 *   1. 当前模式：演练模式 / 真实模式（未确认）/ 真实模式 + 一句话说明；
 *   2. 四个出口各自放行还是拦截、拦截原因；
 *   3. 怎么切到真实模式（分步）与怎么关回演练；
 *   4. 最近被拦截的记录（后端 dry_run_audit），每条都带原因与开启入口。
 *
 * 数据来源是一个只读端点，不写库、不触网、不花钱；真实调用是否放行以后端为准。
 */

import { useCallback, useEffect, useState } from 'react'
import { Alert, Badge, Button, Popover, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { ExperimentOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import {
  ORCHESTRATION_REFRESH_EVENT,
  fetchOrchestrationStatusData,
  orchestrationStatusUrl,
} from '../../../services/orchestrationStatusApi'
import {
  describeBlockedError,
  outletTargetText,
  parseRealRunMode,
  readModePayloadOrNull,
  type BlockedErrorDetails,
  type OutletAllowState,
  type RealRunModeView,
} from './realRunModeCore'

const { Paragraph, Text } = Typography

type RealRunModeBadgeProps = {
  /** 轮询间隔（毫秒）；0 表示只在挂载/手动刷新时读取 */
  refreshIntervalMs?: number
  /** 直接把一次守卫拦截错误传进来，角标会展开显示「原因 + 怎么开」 */
  error?: unknown
  className?: string
}

/** 可复用的「守卫拦截」提示块：原因 + 怎么开（其他页面可以直接拿它展示错误）。 */
export function RealRunBlockedAlert({ details }: { details: BlockedErrorDetails }): React.ReactElement {
  const [open, setOpen] = useState(true)
  if (!details.isBlocked) {
    return (
      <Alert type="error" showIcon message={details.title} description={details.message} />
    )
  }
  return (
    <Alert
      type="warning"
      showIcon
      message={details.title}
      description={
        <div className="text-xs">
          <div>
            <Text strong>原因：</Text>
            {details.reasonText}
          </div>
          <div className="mt-1">
            <Text strong>后端原文：</Text>
            {details.message}
          </div>
          <div className="mt-1">
            <Text strong>怎么开启真实模式：</Text>
            {details.howToEnable}
          </div>
          {details.enableSteps.length ? (
            <div className="mt-1">
              <Button type="link" size="small" className="px-0" onClick={() => setOpen((value) => !value)}>
                {open ? '收起分步操作' : '展开分步操作'}
              </Button>
              {open ? (
                <ol className="ml-4 list-decimal">
                  {details.enableSteps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              ) : null}
            </div>
          ) : null}
        </div>
      }
    />
  )
}

function outletColumns() {
  return [
    {
      title: '出口',
      dataIndex: 'label',
      key: 'label',
      width: 96,
      render: (label: string, row: OutletAllowState) => (
        <Tooltip title={outletTargetText(row.outlet)}>
          <span>{label}</span>
        </Tooltip>
      ),
    },
    {
      title: '状态',
      dataIndex: 'allowed',
      key: 'allowed',
      width: 96,
      render: (allowed: boolean) =>
        allowed ? <Tag color="red">放行（会花钱）</Tag> : <Tag color="gold">拦截</Tag>,
    },
    {
      title: '原因 / 说明',
      dataIndex: 'reasonText',
      key: 'reasonText',
      render: (text: string, row: OutletAllowState) => (
        <span className="text-xs">
          {row.reason ? <Tag bordered={false}>{row.reason}</Tag> : null}
          {text}
        </span>
      ),
    },
  ]
}

export function RealRunModeBadge({
  refreshIntervalMs = 30000,
  error,
  className,
}: RealRunModeBadgeProps): React.ReactElement {
  const [view, setView] = useState<RealRunModeView | null>(null)
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchOrchestrationStatusData()
      const payload = readModePayloadOrNull(data)
      if (payload === null) {
        setView(null)
        setLoadError('状态接口没有返回 guard 字段，无法确认当前是演练还是真实模式。')
      } else {
        setView(parseRealRunMode(payload))
        setLoadError('')
      }
    } catch (exc) {
      setView(null)
      setLoadError(exc instanceof Error ? exc.message : String(exc))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!refreshIntervalMs) return undefined
    const timer = window.setInterval(() => {
      void load()
    }, refreshIntervalMs)
    return () => window.clearInterval(timer)
  }, [load, refreshIntervalMs])

  useEffect(() => {
    const handler = () => {
      void load()
    }
    window.addEventListener(ORCHESTRATION_REFRESH_EVENT, handler)
    return () => window.removeEventListener(ORCHESTRATION_REFRESH_EVENT, handler)
  }, [load])

  const blocked = error === undefined || error === null ? null : describeBlockedError(error)
  const blockedCount = view?.blockedEvents.length ?? 0

  const tagColor = view === null ? 'default' : view.mode === 'real' ? 'red' : view.mode === 'real_unconfirmed' ? 'orange' : 'gold'
  const tagIcon = view?.mode === 'real' ? <ThunderboltOutlined /> : <ExperimentOutlined />
  const tagText = loading && view === null ? '读取模式…' : view?.label ?? '模式未知'

  const content = (
    <div style={{ width: 520, maxHeight: 460, overflow: 'auto' }} data-testid="real-run-mode-detail">
      {loadError ? (
        <Alert
          type="error"
          showIcon
          message="读不到后端守卫状态"
          description={`${loadError}（端点：${orchestrationStatusUrl()}）在确认之前请按「当前不会真实调用」对待。`}
          style={{ marginBottom: 8 }}
        />
      ) : null}

      {view ? (
        <>
          <Paragraph className="mb-2 text-xs">
            <Tag color={tagColor}>{view.label}</Tag>
            {view.description}
          </Paragraph>
          <Paragraph className="mb-2 text-xs text-gray-500">
            守卫原文：{view.guardText || '（未提供）'}；开关：{view.env} / {view.confirmEnv}
            {view.restartRequired ? '；改完必须重启后端进程才生效。' : ''}
          </Paragraph>

          <Table<OutletAllowState>
            size="small"
            rowKey="outlet"
            pagination={false}
            columns={outletColumns()}
            dataSource={view.outlets}
          />

          <div className="mt-3 text-xs">
            <Text strong>{view.isRealMode ? '当前已是真实模式（仍受成本确认/限额/去重约束）' : '怎么切换到真实模式'}</Text>
            <ol className="ml-4 mt-1 list-decimal">
              {view.enableSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <Text type="secondary">{view.howToEnable}</Text>
          </div>

          <div className="mt-2 text-xs">
            <Text strong>怎么关回演练模式</Text>
            <ol className="ml-4 mt-1 list-decimal">
              {view.restoreSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        </>
      ) : null}

      {blocked ? (
        <div className="mt-3">
          <RealRunBlockedAlert details={blocked} />
        </div>
      ) : null}

      {blockedCount ? (
        <div className="mt-3 text-xs">
          <Text strong>最近被拦截的记录（{blockedCount} 条）</Text>
          <ul className="ml-4 mt-1 list-disc">
            {view?.blockedEvents.map((event, index) => (
              <li key={`${event.action}-${index}`}>
                <Tag bordered={false}>{event.actionLabel}</Tag>
                {event.detail || event.target || '（无明细）'}
                <div className="text-gray-500">{event.reasonText}</div>
              </li>
            ))}
          </ul>
          <Text type="secondary">需要真实调用时按上面的步骤开真实模式；演练模式下的拦截不是故障。</Text>
        </div>
      ) : null}

      <div className="mt-3 flex items-center justify-between">
        <Space size={6}>
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            刷新模式
          </Button>
          <Text type="secondary" className="text-xs">
            说明文档：{view?.doc ?? 'docs/real-run-mode.md'}
          </Text>
        </Space>
      </div>
    </div>
  )

  return (
    <Popover content={content} title="当前运行模式（是否真实付费）" trigger="click" placement="bottomRight">
      <span className={className} style={{ cursor: 'pointer' }} title={view?.description ?? '正在读取当前运行模式'}>
        <Badge count={blockedCount} size="small" offset={[2, -2]}>
          <Tag color={tagColor} icon={tagIcon} data-testid="real-run-mode-tag">
            {tagText}
          </Tag>
        </Badge>
      </span>
    </Popover>
  )
}

export default RealRunModeBadge
