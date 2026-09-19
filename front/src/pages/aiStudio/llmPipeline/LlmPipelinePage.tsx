import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Divider,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd'
import { OpenAPI } from '../../../services/generated'

/**
 * LLM 编排 / 资产绑定 / 出图管线 的一体化操作页。
 *
 * 为什么直接用 fetch 而不是 `src/services/generated`：
 * - 生成客户端由 `npm run openapi:update` 产出，而那条链依赖 pnpm（本机未安装），
 *   且本次新增的 12 个接口尚未进入生成物；
 * - 生成目录是自动产物，不应手改。
 * 因此这里按 PromptFlowPage 里已有的做法，用 `OpenAPI.BASE` 拼绝对地址直接 fetch。
 * 后端返回统一信封 {code, message, data, meta}，本页手动解包 data、失败时读 meta.error。
 */

const API_BASE = () => OpenAPI.BASE

type AnyRecord = Record<string, any>

async function callApi<T = AnyRecord>(path: string, body?: AnyRecord): Promise<T> {
  const response = await fetch(`${API_BASE()}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let payload: AnyRecord | undefined
  try {
    payload = text ? (JSON.parse(text) as AnyRecord) : undefined
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    const meta = (payload?.meta ?? {}) as AnyRecord
    const error = (meta.error ?? {}) as AnyRecord
    const detail = payload?.detail
    const suffix = detail ? `（${typeof detail === 'string' ? detail : JSON.stringify(detail)}）` : ''
    throw new Error(
      String(error.message ?? payload?.message ?? text ?? `HTTP ${response.status}`) + suffix
    )
  }
  return (payload?.data ?? null) as T
}

function Warnings({ items, title = '提示' }: { items?: string[]; title?: string }) {
  if (!items || items.length === 0) return null
  return (
    <Alert
      type="warning"
      showIcon
      className="mb-3"
      message={title}
      description={
        <ul className="pl-4 mb-0 list-disc">
          {items.map((text, index) => (
            <li key={`${index}-${text.slice(0, 12)}`}>{text}</li>
          ))}
        </ul>
      }
    />
  )
}

function JsonBlock({ value, rows = 10 }: { value: unknown; rows?: number }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return (
    <pre className="mt-2 p-3 bg-gray-50 rounded text-xs overflow-auto" style={{ maxHeight: rows * 22 }}>
      {text}
    </pre>
  )
}

function ErrorLine({ error }: { error: string }) {
  if (!error) return null
  return <Alert type="error" showIcon className="mb-3" message={error} />
}

function GuardTag({ dryRun }: { dryRun?: boolean }) {
  return dryRun ? (
    <Tag color="orange">DRY_RUN 占位（未真实调用）</Tag>
  ) : (
    <Tag color="red">真实调用已开启</Tag>
  )
}

/* ------------------------------------------------------------------ 概览 */

function OverviewTab() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [guard, setGuard] = useState<AnyRecord | null>(null)
  const [pipeline, setPipeline] = useState<AnyRecord | null>(null)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [guardData, pipelineData] = await Promise.all([
        callApi('/api/v1/studio/llm/orchestration/status'),
        callApi('/api/v1/studio/image-pipeline/status'),
      ])
      setGuard(guardData)
      setPipeline(pipelineData)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const guardInfo = (guard?.guard ?? {}) as AnyRecord
  const pipelineGuard = (pipeline?.guard ?? {}) as AnyRecord

  return (
    <Space direction="vertical" className="w-full" size="middle">
      <Space>
        <Button type="primary" onClick={() => void load()} loading={loading}>
          刷新状态
        </Button>
        <GuardTag dryRun={Boolean(guardInfo.dry_run)} />
      </Space>
      <ErrorLine error={error} />
      <Card title="付费出口守卫" size="small" loading={loading}>
        <Descriptions column={2} size="small">
          <Descriptions.Item label="状态文案">{String(guard?.guard_status_text ?? '—')}</Descriptions.Item>
          <Descriptions.Item label="DRY_RUN 开关">{String(guardInfo.env ?? '—')}</Descriptions.Item>
          <Descriptions.Item label="真实调用确认">{String(guardInfo.confirm_env ?? '—')}</Descriptions.Item>
          <Descriptions.Item label="已确认">
            {guardInfo.real_call_confirmed ? '是' : '否'}
          </Descriptions.Item>
          <Descriptions.Item label="被拦截次数">{String(guardInfo.blocked_count ?? '—')}</Descriptions.Item>
          <Descriptions.Item label="出口清单">
            {(guardInfo.outlets as string[] | undefined)?.join(' / ') ?? '—'}
          </Descriptions.Item>
        </Descriptions>
        <div className="mt-3 text-xs text-neutral-500">已纳管的付费出口（新旧链路同一套闸门）：</div>
        <JsonBlock value={guard?.paid_outlet_guards ?? {}} rows={6} />
      </Card>
      <Card title="确定性词表" size="small" loading={loading}>
        <Descriptions column={1} size="small">
          <Descriptions.Item label="实体类型白名单">
            {(guard?.entity_type_whitelist as string[] | undefined)?.join(' / ') ?? '—'}
          </Descriptions.Item>
          <Descriptions.Item label="标准运镜词库">
            {(guard?.camera_movement_keys as string[] | undefined)?.join(' / ') ?? '—'}
          </Descriptions.Item>
          <Descriptions.Item label="确认写库端点">
            <JsonBlock value={guard?.binding_confirm_endpoints ?? {}} rows={5} />
          </Descriptions.Item>
        </Descriptions>
      </Card>
      <Card title="出图服务对接" size="small" loading={loading}>
        <Descriptions column={2} size="small">
          <Descriptions.Item label="服务基址">{String(pipeline?.base_url ?? '—')}</Descriptions.Item>
          <Descriptions.Item label="环境变量">{String(pipeline?.configured_env ?? '—')}</Descriptions.Item>
          <Descriptions.Item label="支持的资产类型">
            {(pipeline?.service_asset_types as string[] | undefined)?.join(' / ') ?? '—'}
          </Descriptions.Item>
          <Descriptions.Item label="出图守卫">
            {String(pipelineGuard.dry_run) === 'true' ? 'DRY_RUN' : '真实'}
          </Descriptions.Item>
          <Descriptions.Item label="健康探测">
            {pipeline?.probe ? '已探测' : String(pipeline?.probe_skipped_reason ?? '—')}
          </Descriptions.Item>
        </Descriptions>
      </Card>
      {guard?.dry_run_audit ? (
        <Card title="最近守卫事件" size="small" loading={loading}>
          <JsonBlock value={guard.dry_run_audit} rows={8} />
        </Card>
      ) : null}
    </Space>
  )
}

/* ------------------------------------------------------------ 实体提取 */

function EntityExtractionTab() {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<AnyRecord | null>(null)

  const submit = async (values: AnyRecord) => {
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const candidates = String(values.candidate_names ?? '')
        .split(/[,，\s]+/)
        .filter(Boolean)
      const data = await callApi('/api/v1/studio/llm/entity-extraction/preview', {
        chapter_id: values.chapter_id || null,
        chapter_text: values.chapter_text || null,
        candidate_names: candidates,
        max_items: values.max_items ?? 40,
      })
      setResult(data)
      message.success(`提取完成：${(data.items as unknown[] | undefined)?.length ?? 0} 条草稿`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const items = (result?.items ?? []) as AnyRecord[]
  const dropped = (result?.dropped ?? []) as AnyRecord[]

  return (
    <Space direction="vertical" className="w-full" size="middle">
      <Card size="small" title="输入（chapter_id 与原文至少给一个）">
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => void submit(values)}
          initialValues={{ max_items: 40 }}
        >
          <Form.Item name="chapter_id" label="章节 ID（留空则用下面的原文）">
            <Input placeholder="例如 script_xxx_EP01" allowClear />
          </Form.Item>
          <Form.Item name="chapter_text" label="剧本 / 章节原文">
            <Input.TextArea rows={6} placeholder="直接粘贴剧本原文…" />
          </Form.Item>
          <Form.Item name="candidate_names" label="候选实体名（逗号分隔，可留空）">
            <Input placeholder="姜岁欢, 将军府庭院, 拐杖" />
          </Form.Item>
          <Form.Item name="max_items" label="最多返回条数">
            <InputNumber min={1} max={200} />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={loading}>
              提取实体草稿
            </Button>
            <GuardTag />
          </Space>
        </Form>
      </Card>
      <ErrorLine error={error} />
      {result ? (
        <>
          <Warnings items={result.warnings as string[]} />
          <Card size="small" title={`草稿（${items.length} 条，仅预览不建实体）`}>
            <Space className="mb-2">
              <Tag>dry_run：{String((result.meta as AnyRecord)?.dry_run)}</Tag>
              <Tag>llm_called：{String((result.meta as AnyRecord)?.llm_called)}</Tag>
              <Tag>模型：{String(((result.meta as AnyRecord)?.target as AnyRecord)?.model_name ?? '—')}</Tag>
            </Space>
            <Table
              rowKey={(row) => String(row.name)}
              size="small"
              pagination={false}
              dataSource={items}
              columns={[
                { title: '名称', dataIndex: 'name' },
                {
                  title: '类型',
                  dataIndex: 'entity_type',
                  width: 100,
                  render: (v: string) => <Tag color="blue">{v}</Tag>,
                },
                { title: '画像', dataIndex: 'profile', ellipsis: true },
                { title: '别名', dataIndex: 'aliases', width: 160, render: (v: string[]) => (v ?? []).join('、') || '—' },
                { title: '置信度', dataIndex: 'confidence', width: 90 },
              ]}
            />
          </Card>
          {dropped.length > 0 ? (
            <Card size="small" title={`被后校验丢弃（${dropped.length} 条）`}>
              <Table
                rowKey={(row, index) => `${row.name}-${index}`}
                size="small"
                pagination={false}
                dataSource={dropped}
                columns={[
                  { title: '名称', dataIndex: 'name' },
                  { title: '类型', dataIndex: 'entity_type', width: 120 },
                  { title: '原因', dataIndex: 'reason' },
                ]}
              />
            </Card>
          ) : null}
        </>
      ) : null}
    </Space>
  )
}

/* ---------------------------------------------------------- 图片提示词 */

function ImagePromptTab() {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<AnyRecord | null>(null)

  const submit = async (values: AnyRecord) => {
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const profiles = String(values.entity_profiles ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name, entity_type, ...rest] = line.split('|').map((part) => part.trim())
          return { name, entity_type: entity_type || 'character', profile: rest.join('|') }
        })
      const data = await callApi('/api/v1/studio/llm/image-prompt/preview', {
        shot_id: values.shot_id || null,
        shot_text: values.shot_text || null,
        entity_profiles: profiles,
      })
      setResult(data)
      message.success(`已生成 ${(data.slots as unknown[] | undefined)?.length ?? 0} 个槽位`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const slots = (result?.slots ?? []) as AnyRecord[]

  return (
    <Space direction="vertical" className="w-full" size="middle">
      <Card size="small" title="输入（shot_id 与镜头文本至少给一个）">
        <Form form={form} layout="vertical" onFinish={(values) => void submit(values)}>
          <Form.Item name="shot_id" label="镜头 ID（可留空）">
            <Input placeholder="留空则只用下面的镜头文本" allowClear />
          </Form.Item>
          <Form.Item name="shot_text" label="镜头文本">
            <Input.TextArea rows={4} placeholder="姜岁欢跪在庭院中央抬头，秦老夫人拄拐俯视…" />
          </Form.Item>
          <Form.Item
            name="entity_profiles"
            label="实体画像（每行一条：名称|类型|画像）"
            extra="类型可选 character / scene / prop / costume"
          >
            <Input.TextArea rows={3} placeholder={'姜岁欢|character|清冷少女，素色襦裙\n将军府庭院|scene|青石板庭院'} />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={loading}>
              生成九槽位提示词
            </Button>
            <GuardTag />
          </Space>
        </Form>
      </Card>
      <ErrorLine error={error} />
      {result ? (
        <>
          <Warnings items={result.warnings as string[]} />
          <Card size="small" title={`槽位（${slots.length} 个）`}>
            <Space direction="vertical" className="w-full">
              {slots.map((slot) => (
                <Card
                  key={String(slot.category)}
                  size="small"
                  title={
                    <Space>
                      <Tag color="blue">{String(slot.category)}</Tag>
                      <span>{String(slot.label ?? '')}</span>
                      {slot.entity_name ? <Tag>{String(slot.entity_name)}</Tag> : null}
                    </Space>
                  }
                >
                  <Typography.Paragraph className="mb-2">{String(slot.prompt ?? '')}</Typography.Paragraph>
                  <JsonBlock value={slot.layers ?? {}} rows={6} />
                  <Typography.Text type="secondary" className="text-xs">
                    负面词：{String(slot.negative_prompt ?? '—')}
                  </Typography.Text>
                </Card>
              ))}
            </Space>
          </Card>
        </>
      ) : null}
    </Space>
  )
}

/* ---------------------------------------------------------- 视频提示词 */

function VideoPromptTab() {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<AnyRecord | null>(null)

  const submit = async (values: AnyRecord) => {
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const data = await callApi('/api/v1/studio/llm/video-prompt/preview', {
        shot_id: values.shot_id || null,
        shot_text: values.shot_text || null,
        camera_movement: values.camera_movement || null,
        duration_seconds: values.duration_seconds ?? null,
        frame_mode: values.frame_mode ?? 'single_frame',
      })
      setResult(data)
      message.success('视频提示词已生成')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Space direction="vertical" className="w-full" size="middle">
      <Card size="small" title="输入">
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => void submit(values)}
          initialValues={{ camera_movement: '推', frame_mode: 'single_frame', duration_seconds: 5 }}
        >
          <Form.Item name="shot_id" label="镜头 ID（可留空）">
            <Input allowClear placeholder="留空则只用镜头文本" />
          </Form.Item>
          <Form.Item name="shot_text" label="镜头文本">
            <Input.TextArea rows={4} />
          </Form.Item>
          <Space size="large" wrap>
            <Form.Item name="camera_movement" label="运镜（标准词库）">
              <Select
                style={{ width: 160 }}
                options={['固定', '推', '拉', '摇', '上下摇', '移', '跟', '环绕'].map((k) => ({
                  label: k,
                  value: k,
                }))}
              />
            </Form.Item>
            <Form.Item name="duration_seconds" label="时长（秒）">
              <Select
                style={{ width: 120 }}
                options={[4, 5, 8, 10, 12, 15].map((v) => ({ label: `${v}s`, value: v }))}
              />
            </Form.Item>
            <Form.Item name="frame_mode" label="帧模式">
              <Select
                style={{ width: 180 }}
                options={[
                  { label: '单帧（single_frame）', value: 'single_frame' },
                  { label: '首尾帧（first_last_frame）', value: 'first_last_frame' },
                ]}
              />
            </Form.Item>
          </Space>
          <Space>
            <Button type="primary" htmlType="submit" loading={loading}>
              生成视频提示词
            </Button>
            <GuardTag />
          </Space>
        </Form>
      </Card>
      <ErrorLine error={error} />
      {result ? (
        <>
          <Warnings items={result.warnings as string[]} />
          <Card size="small" title="结果">
            <Descriptions column={2} size="small">
              <Descriptions.Item label="运镜">
                {String((result.camera_movement as AnyRecord)?.label ?? '—')}（
                {String((result.camera_movement as AnyRecord)?.enum_code ?? '无对应枚举')}）
              </Descriptions.Item>
              <Descriptions.Item label="时长">{String(result.duration_seconds)}s</Descriptions.Item>
              <Descriptions.Item label="帧模式">{String(result.frame_mode)}</Descriptions.Item>
              <Descriptions.Item label="模型">
                {String(((result.meta as AnyRecord)?.target as AnyRecord)?.model_name ?? '—')}
              </Descriptions.Item>
            </Descriptions>
            <Divider className="my-2" />
            <Typography.Paragraph copyable className="mb-0">
              {String(result.final_prompt ?? '')}
            </Typography.Paragraph>
          </Card>
          <Card size="small" title="完整结构（对齐 shot_video_prompt_pack）">
            <JsonBlock value={result} rows={14} />
          </Card>
        </>
      ) : null}
    </Space>
  )
}

/* ---------------------------------------------------------- 资产绑定 */

function AssetBindingTab() {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<AnyRecord | null>(null)

  const submit = async (values: AnyRecord) => {
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const data = await callApi('/api/v1/studio/llm/asset-binding/preview', {
        project_id: values.project_id,
        shot_ids: String(values.shot_ids ?? '')
          .split(/[,，\s]+/)
          .filter(Boolean),
        batch_size: values.batch_size ?? 8,
        max_shots: values.max_shots ?? 40,
      })
      setResult(data)
      message.success('绑定建议已生成')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const shots = (result?.shots ?? []) as AnyRecord[]

  return (
    <Space direction="vertical" className="w-full" size="middle">
      <Card size="small" title="输入">
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => void submit(values)}
          initialValues={{ batch_size: 8, max_shots: 40 }}
        >
          <Form.Item name="project_id" label="项目 ID" rules={[{ required: true }]}>
            <Input placeholder="必填" />
          </Form.Item>
          <Form.Item name="shot_ids" label="指定镜头（逗号分隔，留空=整个项目）">
            <Input allowClear />
          </Form.Item>
          <Space size="large">
            <Form.Item name="batch_size" label="每批镜头数">
              <InputNumber min={1} max={20} />
            </Form.Item>
            <Form.Item name="max_shots" label="最多处理镜头数">
              <InputNumber min={1} max={200} />
            </Form.Item>
          </Space>
          <Space>
            <Button type="primary" htmlType="submit" loading={loading}>
              生成绑定建议
            </Button>
            <GuardTag />
          </Space>
        </Form>
      </Card>
      <ErrorLine error={error} />
      {result ? (
        <>
          <Warnings items={result.parse_warnings as string[]} />
          <Card size="small" title="概览">
            <Space wrap>
              <Tag>候选资产：{String((result.catalog as unknown[] | undefined)?.length ?? 0)}</Tag>
              <Tag>镜头：{shots.length}</Tag>
              <Tag>批次：{String(result.batch_count)}</Tag>
              <Tag color="green">auto：{String((result.tier_summary as AnyRecord)?.auto ?? 0)}</Tag>
              <Tag color="gold">review：{String((result.tier_summary as AnyRecord)?.review ?? 0)}</Tag>
              <Tag>discard：{String((result.tier_summary as AnyRecord)?.discard ?? 0)}</Tag>
            </Space>
            <Typography.Paragraph type="secondary" className="mt-2 mb-0 text-xs">
              {String(result.cost_note ?? '')}
            </Typography.Paragraph>
          </Card>
          {shots.map((shot) => {
            const suggestions = (shot.suggestions ?? []) as AnyRecord[]
            return (
              <Card
                key={String(shot.shot_id)}
                size="small"
                title={`[${String(shot.index)}] ${String(shot.shot_id)} · ${String(shot.title ?? '')}`}
              >
                <Typography.Paragraph type="secondary" className="text-xs">
                  {String(shot.script_excerpt ?? '')}
                </Typography.Paragraph>
                <Table
                  rowKey={(row) => `${row.slot}-${row.asset_id}-${row.agreement}`}
                  size="small"
                  pagination={false}
                  dataSource={suggestions}
                  columns={[
                    { title: '槽位', dataIndex: 'slot', width: 100 },
                    { title: '资产', dataIndex: 'asset_id', width: 180 },
                    {
                      title: '层级',
                      dataIndex: 'tier',
                      width: 90,
                      render: (v: string) => (
                        <Tag color={v === 'auto' ? 'green' : v === 'review' ? 'gold' : 'default'}>{v}</Tag>
                      ),
                    },
                    {
                      title: '对账',
                      dataIndex: 'agreement',
                      width: 120,
                      render: (v: string) => (
                        <Tag color={v === 'both' ? 'green' : v === 'conflict' ? 'red' : 'blue'}>{v}</Tag>
                      ),
                    },
                    { title: '置信度', dataIndex: 'confidence', width: 80 },
                    { title: '已绑定', dataIndex: 'already_bound', width: 80, render: (v: boolean) => (v ? '是' : '否') },
                    { title: '理由', dataIndex: 'reason', ellipsis: true },
                  ]}
                />
                <Typography.Text type="secondary" className="text-xs">
                  确认写库端点：{suggestions[0] ? String(suggestions[0].confirm_endpoint) : '—'}
                  （本页不写库，需你手动调用）
                </Typography.Text>
              </Card>
            )
          })}
        </>
      ) : null}
    </Space>
  )
}

/* -------------------------------------------------------------- 出图 */

function ImagePipelineTab() {
  const [planForm] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [plan, setPlan] = useState<AnyRecord | null>(null)
  const [submitResult, setSubmitResult] = useState<AnyRecord | null>(null)
  const [taskDetail, setTaskDetail] = useState<AnyRecord | null>(null)

  const payloadFrom = (values: AnyRecord) => ({
    project_id: values.project_id,
    asset_type: values.asset_type ?? 'character',
    stage: values.stage ?? 'character_sheet',
    asset_ids: String(values.asset_ids ?? '')
      .split(/[,，\s]+/)
      .filter(Boolean),
    aspect_ratio: values.aspect_ratio || '',
    image_model: values.image_model || '',
  })

  const doPlan = async (values: AnyRecord) => {
    setLoading(true)
    setError('')
    setPlan(null)
    setSubmitResult(null)
    setTaskDetail(null)
    try {
      const data = await callApi('/api/v1/studio/image-pipeline/plan/preview', payloadFrom(values))
      setPlan(data)
      message.success(`计划已生成：${String((data.summary as AnyRecord)?.target_count ?? 0)} 个目标`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const doSubmit = async () => {
    setSubmitting(true)
    setError('')
    try {
      const values = await planForm.validateFields()
      const data = await callApi('/api/v1/studio/image-pipeline/submit', payloadFrom(values))
      setSubmitResult(data)
      message.success('提交完成（DRY_RUN 下为占位结果）')
      const results = (data.results ?? []) as AnyRecord[]
      const first = results.find((item) => item.service_task_id)
      if (first) {
        const detail = await callApi(`/api/v1/studio/image-pipeline/task/${String(first.service_task_id)}`)
        setTaskDetail(detail)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const targets = (plan?.targets ?? []) as AnyRecord[]

  return (
    <Space direction="vertical" className="w-full" size="middle">
      <Card size="small" title="提交计划（定妆照 / 垫图批量，不触网）">
        <Form
          form={planForm}
          layout="vertical"
          onFinish={(values) => void doPlan(values)}
          initialValues={{
            asset_type: 'character',
            stage: 'character_sheet',
            aspect_ratio: '16:9',
            image_model: 'image2',
          }}
        >
          <Form.Item name="project_id" label="项目 ID" rules={[{ required: true }]}>
            <Input placeholder="必填" />
          </Form.Item>
          <Space size="large" wrap>
            <Form.Item name="asset_type" label="资产类型">
              <Select
                style={{ width: 160 }}
                options={[
                  { label: '角色 character', value: 'character' },
                  { label: '场景 scene', value: 'scene' },
                  { label: '道具 prop', value: 'prop' },
                ]}
              />
            </Form.Item>
            <Form.Item name="stage" label="阶段">
              <Select
                style={{ width: 200 }}
                options={[
                  { label: '定妆照（不垫图）', value: 'character_sheet' },
                  { label: '垫图批量（用定版主图）', value: 'reference_batch' },
                ]}
              />
            </Form.Item>
            <Form.Item name="image_model" label="图片模型">
              <Select
                style={{ width: 200 }}
                options={[
                  { label: 'image2（→ gpt-image-2）', value: 'image2' },
                  { label: 'Midjourney', value: 'midjourney' },
                  { label: 'Nano Banana 2', value: 'nano-banana-2-ext' },
                ]}
              />
            </Form.Item>
            <Form.Item name="aspect_ratio" label="比例">
              <Select
                style={{ width: 120 }}
                options={['16:9', '9:16', '1:1'].map((v) => ({ label: v, value: v }))}
              />
            </Form.Item>
          </Space>
          <Form.Item name="asset_ids" label="指定资产 ID（逗号分隔，留空=项目内全部该类型资产）">
            <Input allowClear />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={loading}>
              生成计划
            </Button>
            <Button onClick={() => void doSubmit()} loading={submitting} danger>
              提交出图
            </Button>
            <GuardTag />
          </Space>
        </Form>
      </Card>
      <ErrorLine error={error} />
      {plan ? (
        <>
          <Warnings items={plan.warnings as string[]} />
          <Card size="small" title="计划明细">
            <Table
              rowKey={(row) => String(row.source_task_id)}
              size="small"
              pagination={false}
              dataSource={targets}
              columns={[
                { title: '资产', dataIndex: 'name', width: 140 },
                { title: '模型', dataIndex: 'image_model', width: 120 },
                { title: 'generation_type', dataIndex: 'generation_type', width: 140 },
                { title: '幂等键', dataIndex: 'source_task_id', ellipsis: true },
                {
                  title: '垫图',
                  dataIndex: 'reference_image',
                  width: 100,
                  render: (v: string) => (v ? <Tag color="green">已带</Tag> : <Tag>无</Tag>),
                },
              ]}
            />
            <Typography.Paragraph className="mt-2 mb-0 text-xs">
              首个提示词：{String(targets[0]?.prompt ?? '—')}
            </Typography.Paragraph>
          </Card>
        </>
      ) : null}
      {submitResult ? (
        <>
          <Warnings items={submitResult.warnings as string[]} />
          <Card size="small" title="提交结果">
            <Space wrap className="mb-2">
              <Tag color={String((submitResult.summary as AnyRecord)?.dry_run) === 'true' ? 'orange' : 'red'}>
                {String(submitResult.guard_status ?? '')}
              </Tag>
            </Space>
            <Table
              rowKey={(row) => String(row.source_task_id)}
              size="small"
              pagination={false}
              dataSource={(submitResult.results ?? []) as AnyRecord[]}
              columns={[
                { title: '资产', dataIndex: 'source_asset_id', width: 140 },
                { title: 'service_task_id', dataIndex: 'service_task_id', width: 200 },
                { title: '状态', dataIndex: 'status', width: 100 },
                {
                  title: 'OSS 地址',
                  dataIndex: 'oss_url',
                  render: (v: string) => v || <Typography.Text type="secondary">（DRY_RUN 无）</Typography.Text>,
                },
              ]}
            />
            {taskDetail ? (
              <>
                <Divider className="my-2" />
                <JsonBlock value={taskDetail} rows={6} />
              </>
            ) : null}
          </Card>
        </>
      ) : null}
    </Space>
  )
}

/* ------------------------------------------------------------ 出视频 */

function VideoSubmitTab() {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [plan, setPlan] = useState<AnyRecord | null>(null)
  const [result, setResult] = useState<AnyRecord | null>(null)

  const payloadFrom = (values: AnyRecord) => ({
    shot_id: values.shot_id,
    reference_mode: values.reference_mode ?? 'text_only',
    ratio: values.ratio || '16:9',
    duration_seconds: values.duration_seconds ?? 5,
  })

  const doPlan = async (values: AnyRecord) => {
    setLoading(true)
    setError('')
    setPlan(null)
    setResult(null)
    try {
      const data = await callApi('/api/v1/studio/image-pipeline/video-plan/preview', payloadFrom(values))
      setPlan(data)
      message.success('视频计划已生成')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const doSubmit = async () => {
    setSubmitting(true)
    setError('')
    try {
      const values = await form.validateFields()
      const data = await callApi('/api/v1/studio/image-pipeline/video-submit', payloadFrom(values))
      setResult(data)
      message.success(`提交返回：${String(data.status)}`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Space direction="vertical" className="w-full" size="middle">
      <Alert
        type="info"
        showIcon
        message="固定策略：出视频只用 seedance-2.0-mini + 480p，提交前会强制写回这几个参数"
        description="按你的要求，测试只出最短时长（5 秒，模型下限）。请求里的模型/分辨率/时长改不掉它们。"
      />
      <Card size="small" title="输入">
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => void doPlan(values)}
          initialValues={{ reference_mode: 'text_only', ratio: '16:9', duration_seconds: 5 }}
        >
          <Form.Item name="shot_id" label="镜头 ID" rules={[{ required: true }]}>
            <Input placeholder="必填" />
          </Form.Item>
          <Space size="large" wrap>
            <Form.Item name="reference_mode" label="参考图模式">
              <Select
                style={{ width: 200 }}
                options={[
                  { label: 'text_only（无参考图）', value: 'text_only' },
                  { label: 'first（首帧）', value: 'first' },
                  { label: 'first_last（首尾帧）', value: 'first_last' },
                  { label: 'key（关键帧）', value: 'key' },
                ]}
              />
            </Form.Item>
            <Form.Item name="ratio" label="比例">
              <Select
                style={{ width: 120 }}
                options={['16:9', '9:16', '1:1'].map((v) => ({ label: v, value: v }))}
              />
            </Form.Item>
            <Form.Item name="duration_seconds" label="时长（秒）">
              <Select
                style={{ width: 140 }}
                options={[5, 8, 10, 15].map((v) => ({ label: `${v}s`, value: v }))}
              />
            </Form.Item>
          </Space>
          <Space>
            <Button type="primary" htmlType="submit" loading={loading}>
              生成计划
            </Button>
            <Button onClick={() => void doSubmit()} loading={submitting} danger>
              提交出视频
            </Button>
          </Space>
        </Form>
      </Card>
      <ErrorLine error={error} />
      {plan ? (
        <>
          <Warnings items={plan.warnings as string[]} />
          <Card size="small" title="计划">
            <Descriptions column={2} size="small">
              <Descriptions.Item label="provider">{String(plan.provider)}</Descriptions.Item>
              <Descriptions.Item label="模型">
                {String(plan.model_name)}{' '}
                {plan.model_pinned ? <Tag color="green">命中固定策略</Tag> : <Tag color="red">未命中</Tag>}
              </Descriptions.Item>
              <Descriptions.Item label="分辨率">{String(plan.resolution)}</Descriptions.Item>
              <Descriptions.Item label="时长">{String(plan.seconds)}s</Descriptions.Item>
              <Descriptions.Item label="参考图数">{String(plan.reference_image_count)}</Descriptions.Item>
              <Descriptions.Item label="prompt 来源">{String(plan.prompt_source)}</Descriptions.Item>
            </Descriptions>
            <Divider className="my-2" />
            <Typography.Paragraph copyable className="mb-0">
              {String(plan.prompt ?? '')}
            </Typography.Paragraph>
          </Card>
        </>
      ) : null}
      {result ? (
        <Card size="small" title="提交结果">
          <Descriptions column={2} size="small">
            <Descriptions.Item label="状态">
              <Tag color={result.status === 'succeeded' ? 'green' : result.status === 'dry_run' ? 'orange' : 'red'}>
                {String(result.status)}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="provider_task_id">{String(result.provider_task_id || '—')}</Descriptions.Item>
            <Descriptions.Item label="耗时">{String(result.elapsed_ms)}ms</Descriptions.Item>
            <Descriptions.Item label="落库">{result.file_persisted ? '是' : '否'}</Descriptions.Item>
          </Descriptions>
          {result.url ? (
            <Typography.Paragraph copyable className="mb-0">
              {String(result.url)}
            </Typography.Paragraph>
          ) : null}
          {result.error ? <ErrorLine error={String(result.error)} /> : null}
          <Warnings items={result.warnings as string[]} />
        </Card>
      ) : null}
    </Space>
  )
}

/* ---------------------------------------------------------- 提示词包 */

function PromptPackageTab() {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<AnyRecord | null>(null)

  const submit = async (values: AnyRecord) => {
    setLoading(true)
    setError('')
    setResult(null)
    try {
      const data = await callApi('/api/v1/studio/image-pipeline/prompt-package', {
        project_id: values.project_id,
        shot_ids: [],
        max_shots: values.max_shots ?? 5,
        include_image_prompts: values.include_image_prompts !== false,
        include_video_prompts: values.include_video_prompts !== false,
        include_bindings: true,
        format: 'markdown',
      })
      setResult(data)
      message.success('提示词包已生成')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const meta = (result?.meta ?? {}) as AnyRecord

  return (
    <Space direction="vertical" className="w-full" size="middle">
      <Card size="small" title="导出（只读，不出图不出视频）">
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => void submit(values)}
          initialValues={{ max_shots: 5 }}
        >
          <Form.Item name="project_id" label="项目 ID" rules={[{ required: true }]}>
            <Input placeholder="必填" />
          </Form.Item>
          <Form.Item name="max_shots" label="最多导出镜头数">
            <InputNumber min={1} max={100} />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={loading}>
              生成提示词包
            </Button>
            <GuardTag />
          </Space>
        </Form>
      </Card>
      <ErrorLine error={error} />
      {result ? (
        <>
          <Warnings items={result.warnings as string[]} />
          <Card size="small" title="概览">
            <Space wrap>
              <Tag>镜头：{String(meta.shot_count ?? 0)}</Tag>
              <Tag>图片提示词：{String(meta.image_prompt_count ?? 0)}</Tag>
              <Tag>视频提示词：{String(meta.video_prompt_count ?? 0)}</Tag>
              <Tag>画像卡：{String(meta.entity_card_count ?? 0)}</Tag>
              <Tag color={meta.dry_run ? 'orange' : 'red'}>
                {meta.dry_run ? 'DRY_RUN 占位' : '真实模型输出'}
              </Tag>
            </Space>
          </Card>
          <Card
            size="small"
            title="Markdown"
            extra={
              <Button
                size="small"
                onClick={() => {
                  void navigator.clipboard?.writeText(String(result.rendered_markdown ?? ''))
                  message.success('已复制')
                }}
              >
                复制
              </Button>
            }
          >
            <pre className="p-3 bg-gray-50 rounded text-xs overflow-auto" style={{ maxHeight: 420 }}>
              {String(result.rendered_markdown ?? '')}
            </pre>
          </Card>
        </>
      ) : null}
    </Space>
  )
}

/* ------------------------------------------------------------------ 页面 */

/**
 * 开发调试台，**不是生产入口**。
 *
 * 正常生产流程里，这些能力已经嵌入到对应步骤的页面中（见下面的对照表）。
 * 本页保留的用途：
 * - 不依赖具体项目/章节/镜头时，快速验证后端编排层与守卫状态；
 * - 排查「某个步骤里生成结果不对」时，绕开页面状态直接看原始返回结构。
 *
 * 因此：① 菜单里单独标为调试项；② 页面顶部明确告知生产入口在哪。
 */
export default function LlmPipelinePage() {
  return (
    <div className="flex-1 overflow-auto p-6 bg-gray-50">
      <Alert
        type="warning"
        showIcon
        className="mb-4"
        message="这是开发调试工具，不是正常用户的生产入口"
        description={
          <div className="text-sm">
            <div className="mb-1">
              下面的能力都已经嵌进生产流程的对应步骤里，日常生产请从「项目列表」进入项目后按步骤操作：
            </div>
            <ul className="pl-4 mb-1 list-disc">
              <li>剧本/章节：AI 拆分镜、提取人物/场景/道具 —— 项目工作台「章节」页 / 分镜列表页 / 分镜编辑页</li>
              <li>资产准备：生成画像、生成图片提示词、设为定版、用定版垫图出图 —— 资产管理 → 资产编辑页</li>
              <li>分镜编辑：AI 推荐资产关联、确认绑定 —— 分镜编辑页「AI 推荐关联」页签</li>
              <li>分镜工作室：生成/保存视频提示词、生成视频、查看结果 —— 章节 → 分镜工作室</li>
              <li>交付：读取已保存提示词与绑定资产、导出 —— 提示词导入/交付 → 提示词交付（出口 A）</li>
            </ul>
            <div>
              本页仅用于不依赖具体项目时验证后端编排层、以及排查原始返回结构。
              <b>不要把本页当作全链路已完成的验收依据。</b>
            </div>
          </div>
        }
      />
      <Typography.Title level={4} className="mt-0">
        LLM 编排调试台
      </Typography.Title>
      <Typography.Paragraph type="secondary" className="text-sm">
        实体提取 → 图片提示词 → 视频提示词 → 资产绑定 → 出图 → 出视频 → 提示词包。所有结果只作预览，
        写库仍需手动调用对应端点（在正式页面里由「确认」按钮完成）。默认 DRY_RUN，页面顶部标签会如实显示当前是否真实调用。
      </Typography.Paragraph>
      <Tabs
        defaultActiveKey="overview"
        items={[
          { key: 'overview', label: '总览 / 守卫', children: <OverviewTab /> },
          { key: 'entity', label: '实体提取', children: <EntityExtractionTab /> },
          { key: 'image-prompt', label: '图片提示词', children: <ImagePromptTab /> },
          { key: 'video-prompt', label: '视频提示词', children: <VideoPromptTab /> },
          { key: 'binding', label: '资产绑定', children: <AssetBindingTab /> },
          { key: 'image', label: '出图', children: <ImagePipelineTab /> },
          { key: 'video', label: '出视频', children: <VideoSubmitTab /> },
          { key: 'package', label: '提示词包', children: <PromptPackageTab /> },
        ]}
      />
    </div>
  )
}
