import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Collapse,
  Descriptions,
  Divider,
  Empty,
  Input,
  Modal,
  Row,
  Segmented,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  CloudDownloadOutlined,
  CloudUploadOutlined,
  PlusOutlined,
  ReloadOutlined,
  EyeOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import {
  OpenAPI,
  StudioChaptersService,
  StudioJuriluImportService,
  StudioProjectsService,
  StudioPromptDeliveryService,
  StudioQuickSkillService,
  StudioShotsService,
} from '../../../services/generated'
import { nextChapterIndex } from '../chapter/chapterIndexing'
import type {
  JuriluPlanRowRead,
  JuriluPreviewRead,
  PromptDeliveryRead,
  PromptDeliveryRowRead,
  QuickSkillGenerateRead,
  QuickSkillItem,
} from '../../../services/generated'

const { Text } = Typography

/**
 * 后端基址沿用生成客户端的配置（默认 http://localhost:8000，可由
 * window.__ENV.BACKEND_URL 或 VITE_BACKEND_URL 覆盖）。
 * 下载走原生 fetch 是因为要拿到原始字节（TXT 带 UTF-8 BOM），
 * 经客户端封装会被当作文本解码，BOM 可能被吃掉。
 */
const apiBase = () => OpenAPI.BASE

interface ProjectOption {
  label: string
  value: string
}
interface ChapterOption {
  label: string
  value: string
}
interface ShotOption {
  label: string
  value: string
}

/**
 * 把后端的统一错误信封渲染成可读文本。
 *
 * 后端约定：错误也走 `{ code, message, data, meta }`（见 app/main.py 的全局异常处理器）。
 * 巨日禄抓取失败的诊断信息放在 `meta.diagnostics` / `meta.warnings` 里，
 * 这里把它们展开，方便直接看出"是哪一步断了"。
 */
const renderEnvelope = (body: unknown, fallback: string): string => {
  if (!body || typeof body !== 'object') return fallback
  const envelope = body as Record<string, unknown>
  const message = String(envelope.message ?? fallback)
  const meta = (envelope.meta ?? {}) as Record<string, unknown>
  const warnings = Array.isArray(meta.warnings) ? (meta.warnings as string[]) : []
  const diagnostics = (meta.diagnostics ?? {}) as Record<string, unknown>
  const lines = Object.entries(diagnostics).map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
  const detail = envelope.detail
  if (lines.length === 0 && warnings.length === 0 && detail) {
    return typeof detail === 'string' ? detail : `${message}\n${JSON.stringify(detail)}`
  }
  return [message, ...warnings, ...lines].join('\n')
}

const describeError = (error: unknown): string => {
  const err = error as { status?: number; body?: unknown; message?: string }
  if (err?.body) return renderEnvelope(err.body, err.message ?? '请求失败')
  return err?.message ?? '请求失败'
}

/**
 * 后端分页上限是每页 100（`page_size ≤ 100`，传更大会 422），
 * 所以这里先取第一页拿到 max_page，再把剩下的页依次取回来。
 */
const PAGE_SIZE = 100

async function loadAll<T>(
  loader: (page: number, pageSize: number) => Promise<{ items: T[]; maxPage: number }>
): Promise<T[]> {
  const first = await loader(1, PAGE_SIZE)
  const all = [...first.items]
  for (let page = 2; page <= first.maxPage; page += 1) {
    const next = await loader(page, PAGE_SIZE)
    all.push(...next.items)
  }
  return all
}

/** 动作 → 展示标签与配色。 */
const ACTION_META: Record<string, { text: string; color: string }> = {
  update: { text: '写入', color: 'blue' },
  overwrite: { text: '覆盖', color: 'orange' },
  create: { text: '新建镜头', color: 'green' },
  unchanged: { text: '无变化', color: 'default' },
  conflict: { text: '冲突跳过', color: 'red' },
  skip_empty: { text: '空正文跳过', color: 'default' },
  skip_no_shot: { text: '镜头不足跳过', color: 'default' },
}

const PromptFlowPage: React.FC = () => {
  type TabKey = 'import' | 'export' | 'skill'
  const TAB_KEYS: TabKey[] = ['import', 'export', 'skill']

  // 项目与标签页同步到 URL 查询串：链接可直接分享/收藏，也便于自动化打开。
  const [searchParams, setSearchParams] = useSearchParams()
  const [projectId, setProjectIdRaw] = useState<string | undefined>(
    searchParams.get('project') ?? undefined
  )
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [tab, setTabRaw] = useState<TabKey>(() => {
    const raw = searchParams.get('tab') ?? ''
    return (TAB_KEYS as string[]).includes(raw) ? (raw as TabKey) : 'import'
  })

  const syncQuery = useCallback(
    (nextProject?: string, nextTab?: TabKey) => {
      const params = new URLSearchParams(searchParams)
      const project = nextProject ?? projectId
      const currentTab = nextTab ?? tab
      if (project) params.set('project', project)
      else params.delete('project')
      if (currentTab === 'import') params.delete('tab')
      else params.set('tab', currentTab)
      setSearchParams(params, { replace: true })
    },
    [projectId, searchParams, setSearchParams, tab]
  )

  const setProjectId = useCallback(
    (value?: string) => {
      setProjectIdRaw(value)
      syncQuery(value, undefined)
    },
    [syncQuery]
  )

  const setTab = useCallback(
    (value: TabKey) => {
      setTabRaw(value)
      syncQuery(undefined, value)
    },
    [syncQuery]
  )

  const loadProjects = useCallback(async () => {
    setLoadingProjects(true)
    try {
      const items = await loadAll(async (page, pageSize) => {
        const res = await StudioProjectsService.listProjectsApiV1StudioProjectsGet({ page, pageSize })
        return {
          items: res.data?.items ?? [],
          maxPage: res.data?.pagination?.max_page ?? 1,
        }
      })
      setProjects(items.map((p) => ({ label: p.name, value: p.id })))
    } catch (error) {
      message.error(`加载项目失败：${describeError(error)}`)
    } finally {
      setLoadingProjects(false)
    }
  }, [])

  useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  return (
    <div style={{ padding: 16 }}>
      <Card
        title="提示词导入 / 交付"
        extra={
          <Space>
            <Select
              style={{ width: 320 }}
              placeholder="选择项目"
              value={projectId}
              onChange={setProjectId}
              options={projects}
              loading={loadingProjects}
              showSearch
              optionFilterProp="label"
            />
            <Button icon={<ReloadOutlined />} onClick={() => void loadProjects()}>
              刷新项目
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="三条链路"
          description={
            <div>
              <div>
                <b>导入</b>：粘贴巨日禄 Cookie，把分镜提示词拉下来写到指定章节的镜头上（来源标记 jurilu）。
              </div>
              <div>
                <b>交付</b>：把 jurilu 来源的提示词导出成 TXT（带 BOM），拿去其他平台生成视频。
              </div>
              <div>
                <b>生成</b>：选一个导演 Skill，填需求，让模型产出一条成品提示词；可导出 TXT，也可写回镜头（来源标记 skill）。
              </div>
            </div>
          }
        />
        <Segmented
          value={tab}
          onChange={(value) => setTab(value as TabKey)}
          options={[
            { label: '巨日禄导入', value: 'import' },
            { label: '提示词交付（出口 A）', value: 'export' },
            { label: '一键技能', value: 'skill', icon: <ThunderboltOutlined /> },
          ]}
          style={{ marginBottom: 16 }}
        />
        {tab === 'import' && <JuriluImportPanel projectId={projectId} />}
        {tab === 'export' && <PromptDeliveryPanel projectId={projectId} />}
        {tab === 'skill' && <QuickSkillPanel projectId={projectId} />}
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 标签页一：巨日禄导入                                                  */
/* ------------------------------------------------------------------ */

const JuriluImportPanel: React.FC<{ projectId?: string }> = ({ projectId }) => {
  const [chapters, setChapters] = useState<ChapterOption[]>([])
  const [chapterId, setChapterId] = useState<string>()
  const [url, setUrl] = useState('')
  const [cookie, setCookie] = useState('')
  const [authorization, setAuthorization] = useState('')
  const [authMode, setAuthMode] = useState('auto')
  // 完整 Cookie 自带 Authorization= 项时，只看 Cookie 头（与工作台导入抽屉同一口径）
  const [authModeTouched, setAuthModeTouched] = useState(false)
  const [referer, setReferer] = useState('')
  const [apiOverride, setApiOverride] = useState('')
  const [createMissing, setCreateMissing] = useState(true)
  const [overwrite, setOverwrite] = useState(false)
  const [preview, setPreview] = useState<JuriluPreviewRead>()
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [loadingApply, setLoadingApply] = useState(false)

  /** 内联新建章节：本页要求在既有章节上写提示词，缺章节时必须能就地补出来，不能只给一句灰按钮。 */
  const [createChapterOpen, setCreateChapterOpen] = useState(false)
  /** 章节原始行（含 index）：新建章节的序号要用 max(index)+1，不能只存 label/value。 */
  const [chapterRows, setChapterRows] = useState<{ id: string; title: string; index: number }[]>([])
  const [createChapterTitle, setCreateChapterTitle] = useState('')
  const [createChapterText, setCreateChapterText] = useState('')
  const [creatingChapter, setCreatingChapter] = useState(false)

  const reloadChapters = useCallback(
    async (autoSelectId?: string) => {
      if (!projectId) {
        setChapters([])
        setChapterRows([])
        return
      }
      const items = await loadAll(async (page, pageSize) => {
        const res = await StudioChaptersService.listChaptersApiV1StudioChaptersGet({
          projectId,
          page,
          pageSize,
        })
        return {
          items: res.data?.items ?? [],
          maxPage: res.data?.pagination?.max_page ?? 1,
        }
      })
      const options = items.map((c) => ({ label: c.title || c.id, value: c.id }))
      setChapterRows(
        items.map((c) => ({
          id: c.id,
          title: c.title || c.id,
          index: typeof c.index === 'number' && Number.isFinite(c.index) ? c.index : 0,
        })),
      )
      setChapters(options)
      if (autoSelectId && options.some((option) => option.value === autoSelectId)) {
        setChapterId(autoSelectId)
        setPreview(undefined)
      }
      return options
    },
    [projectId],
  )

  const handleCreateChapter = useCallback(async () => {
    if (!projectId) return
    const title = createChapterTitle.trim()
    if (!title) {
      message.warning('请填写章节标题')
      return
    }
    setCreatingChapter(true)
    try {
      // id 是 ChapterCreate 的必填字段（与工作台建章节用的是同一套字段）
      const createdId = `c_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
      // 序号口径：现有章节最大 index + 1（不是章节数量 + 1）
      const nextIndex = nextChapterIndex(chapterRows.map((row) => row.index))
      const created = await StudioChaptersService.createChapterApiV1StudioChaptersPost({
        requestBody: {
          id: createdId,
          project_id: projectId,
          index: nextIndex,
          title,
          summary: '',
          raw_text: createChapterText || undefined,
          storyboard_count: 0,
          status: 'draft',
        } as never,
      })
      const newId = String((created.data as { id?: string } | undefined)?.id ?? '')
      message.success('章节已创建，并已自动选中；现在可以预览与确认写入')
      setCreateChapterOpen(false)
      setCreateChapterTitle('')
      setCreateChapterText('')
      await reloadChapters(newId || undefined)
    } catch (error) {
      message.error(`新建章节失败：${describeError(error)}`)
    } finally {
      setCreatingChapter(false)
    }
  }, [chapterRows, createChapterText, createChapterTitle, projectId, reloadChapters])

  useEffect(() => {
    setChapterId(undefined)
    setPreview(undefined)
    if (!projectId) {
      setChapters([])
      return
    }
    void (async () => {
      try {
        const items = await loadAll(async (page, pageSize) => {
          const res = await StudioChaptersService.listChaptersApiV1StudioChaptersGet({
            projectId,
            page,
            pageSize,
          })
          return {
            items: res.data?.items ?? [],
            maxPage: res.data?.pagination?.max_page ?? 1,
          }
        })
        setChapters(items.map((c) => ({ label: c.title || c.id, value: c.id })))
      } catch (error) {
        message.error(`加载章节失败：${describeError(error)}`)
      }
    })()
  }, [projectId])

  const canSubmit = Boolean(projectId && chapterId && url.trim())

  /** 提交前的凭证填写护栏：Authorization 框只接**单个** Authorization 值，整串 Cookie 属于 Cookie 框。 */
  const juriluCredentialBlocked = useCallback(() => {
    const raw = authorization.trim()
    if (raw.includes('Authorization=') || raw.includes(';')) {
      message.error('Authorization 框收到的是整串 Cookie：请把它放进上面的 Cookie 框，Authorization 框留空（模式选「不发送（仅 Cookie）」）')
      return true
    }
    if (!referer.trim()) {
      // Referer 留空也能跑（后端会用页面 URL 兜底），这里只提示更稳的填法
      message.info('Referer 留空将默认使用上面的页面 URL（后端兜底）')
    }
    return false
  }, [authorization, referer])

  const buildRequest = () => ({
    projectId: projectId as string,
    requestBody: {
      chapter_id: chapterId as string,
      url: url.trim(),
      cookie,
      authorization,
      auth_mode: authMode,
      referer,
      api_url_override: apiOverride,
      create_missing: createMissing,
      overwrite,
    },
  })

  const handlePreview = async () => {
    if (!canSubmit) {
      message.warning('请先选择项目、章节，并填写巨日禄页面 URL')
      return
    }
    setLoadingPreview(true)
    try {
      const res = await StudioJuriluImportService.previewJuriluImportApiV1StudioJuriluImportProjectIdPreviewPost(
        buildRequest()
      )
      setPreview(res.data ?? undefined)
      message.success('预览完成，尚未写入数据库')
    } catch (error) {
      setPreview(undefined)
      message.error(describeError(error), 8)
    } finally {
      setLoadingPreview(false)
    }
  }

  const handleApply = async () => {
    if (!canSubmit) {
      message.warning('请先选择项目、章节，并填写巨日禄页面 URL')
      return
    }
    setLoadingApply(true)
    try {
      const res =
        await StudioJuriluImportService.applyJuriluImportApiV1StudioJuriluImportProjectIdApplyPost(
          buildRequest()
        )
      const data = res.data
      message.success(`写入完成：更新 ${data?.updated ?? 0} 条，新建镜头 ${data?.created ?? 0} 个`)
      await handlePreview()
    } catch (error) {
      message.error(describeError(error), 8)
    } finally {
      setLoadingApply(false)
    }
  }

  const columns: ColumnsType<JuriluPlanRowRead> = [
    {
      title: '分镜',
      dataIndex: 'order',
      width: 70,
      render: (value: number) => <Text strong>#{value}</Text>,
    },
    {
      title: '动作',
      dataIndex: 'action',
      width: 120,
      render: (value: string) => {
        const meta = ACTION_META[value] ?? { text: value, color: 'default' }
        return <Tag color={meta.color}>{meta.text}</Tag>
      },
    },
    {
      title: '目标镜头',
      dataIndex: 'index',
      width: 110,
      render: (value: number, row) =>
        row.shot_id ? (
          <Text>
            S{String(value).padStart(3, '0')} <Text type="secondary">· {row.title || '未命名'}</Text>
          </Text>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '分镜名称',
      dataIndex: 'label',
      width: 160,
      ellipsis: true,
    },
    {
      title: '提示词预览',
      dataIndex: 'prompt',
      ellipsis: true,
      render: (value: string) =>
        value ? <Text>{value.slice(0, 90)}</Text> : <Text type="secondary">（空）</Text>,
    },
    {
      title: '说明',
      dataIndex: 'reason',
      width: 220,
      ellipsis: true,
      render: (value: string) => <Text type="secondary">{value}</Text>,
    },
  ]

  const counts = preview?.counts ?? {}
  const writable =
    (counts.update ?? 0) + (counts.overwrite ?? 0) + (counts.create ?? 0)

  return (
    <>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Row gutter={16}>
        <Col span={12}>
          <Text strong>目标章节</Text>
          <Select
            style={{ width: '100%', marginTop: 4 }}
            placeholder={projectId ? '选择要写入的章节' : '请先选择项目'}
            value={chapterId}
            onChange={(value) => {
              setChapterId(value)
              setPreview(undefined)
            }}
            options={chapters}
            disabled={!projectId}
            showSearch
            optionFilterProp="label"
            notFoundContent={
              projectId ? (
                <div className="p-2 text-xs text-gray-500">
                  该项目还没有章节
                  <div className="mt-1 text-[11px] text-gray-400">
                    提示词要写到章节的镜头上，所以必须先有章节。
                  </div>
                </div>
              ) : null
            }
          />
          {projectId && chapters.length === 0 ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 8 }}
              message="该项目还没有章节"
              description={
                <span className="text-xs">
                  提示词要写到章节的镜头上，没有章节就无法继续。请先创建章节（也可以回到项目工作台第 1 步创建）。
                </span>
              }
              action={
                <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setCreateChapterOpen(true)}>
                  新建章节
                </Button>
              }
            />
          ) : null}
        </Col>
        <Col span={12}>
          <Text strong>巨日禄页面 URL</Text>
          <Input
            style={{ marginTop: 4 }}
            placeholder="https://.../agent?projectId=xxx&clipId=yyy"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            allowClear
          />
        </Col>
      </Row>

      <div>
        <Text strong>Cookie</Text>
        <Text type="secondary" style={{ marginLeft: 8 }}>
          从浏览器复制「全部 Cookie」整段粘贴。不保存、不写库、不写日志。
        </Text>
        <Input.TextArea
          style={{ marginTop: 4 }}
          rows={3}
          placeholder="粘贴整段 Cookie 字符串（应包含开头的 Authorization= 项）"
          value={cookie}
          onChange={(e) => {
            const next = e.target.value
            setCookie(next)
            if (!authModeTouched && next.includes('Authorization=')) setAuthMode('none')
            if (next && !next.includes('Authorization=')) {
              message.warning('Cookie 里没有 Authorization= 项，可能不是完整 Cookie（请用「复制全部 Cookie」）')
            }
          }}
          autoComplete="off"
        />
      </div>

      <Collapse
        size="small"
        items={[
          {
            key: 'advanced',
            label: '高级选项（Authorization / Referer / API 覆盖 / 写入开关）',
            children: (
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                <Row gutter={16}>
                  <Col span={12}>
                    <Text>Authorization（可留空）</Text>
                    <Input.Password
                      style={{ marginTop: 4 }}
                      placeholder="单个 Authorization 值（整串 Cookie 请放 Cookie 框并留空这里）"
                      value={authorization}
                      onChange={(e) => setAuthorization(e.target.value)}
                      autoComplete="off"
                    />
                  </Col>
                  <Col span={12}>
                    <Text>Authorization 模式</Text>
                    <Select
                      style={{ width: '100%', marginTop: 4 }}
                      value={authMode}
                      onChange={(value) => {
                        setAuthModeTouched(true)
                        setAuthMode(value)
                      }}
                      options={[
                        { label: '自动（有值就原样发送）', value: 'auto' },
                        { label: '不发送', value: 'none' },
                        { label: '原样发送', value: 'raw' },
                        { label: '按 Bearer 发送', value: 'bearer' },
                      ]}
                    />
                  </Col>
                </Row>
                <Row gutter={16}>
                  <Col span={12}>
                    <Text>Referer 覆盖（可留空）</Text>
                    <Input
                      style={{ marginTop: 4 }}
                      value={referer}
                      onChange={(e) => setReferer(e.target.value)}
                      allowClear
                    />
                  </Col>
                  <Col span={12}>
                    <Text>API 覆盖地址（可留空）</Text>
                    <Input
                      style={{ marginTop: 4 }}
                      placeholder="默认从页面 URL 推断"
                      value={apiOverride}
                      onChange={(e) => setApiOverride(e.target.value)}
                      allowClear
                    />
                  </Col>
                </Row>
                <Space size="large">
                  <Space>
                    <span>分镜多于镜头时新建镜头</span>
                    <Select
                      size="small"
                      style={{ width: 110 }}
                      value={createMissing}
                      onChange={setCreateMissing}
                      options={[
                        { label: '允许新建', value: true },
                        { label: '不新建', value: false },
                      ]}
                    />
                  </Space>
                  <Space>
                    <span>镜头已有提示词时</span>
                    <Select
                      size="small"
                      style={{ width: 110 }}
                      value={overwrite}
                      onChange={setOverwrite}
                      options={[
                        { label: '不覆盖', value: false },
                        { label: '允许覆盖', value: true },
                      ]}
                    />
                  </Space>
                </Space>
              </Space>
            ),
          },
        ]}
      />

      <Space>
        <Button
          type="primary"
          icon={<EyeOutlined />}
          loading={loadingPreview}
          disabled={!canSubmit}
          onClick={() => {
            if (juriluCredentialBlocked()) return
            void handlePreview()
          }}
        >
          预览（不写库）
        </Button>
        <Button
          icon={<CloudUploadOutlined />}
          loading={loadingApply}
          disabled={!canSubmit || !preview || writable === 0}
          onClick={() => {
            if (juriluCredentialBlocked()) return
            void handleApply()
          }}
        >
          确认写入
        </Button>
        {preview && (
          <Text type="secondary">
            可写入 {writable} 条 · 章节现有镜头 {preview.chapter_shot_count} 个 · 抓到分镜{' '}
            {preview.entry_count} 条
          </Text>
        )}
      </Space>

      {preview?.warnings && preview.warnings.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="抓取告警"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {preview.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          }
        />
      )}

      {preview ? (
        <>
          <Alert type="success" showIcon message={preview.plan_summary} />
          <Table<JuriluPlanRowRead>
            size="small"
            rowKey={(row) => `${row.order}-${row.action}`}
            columns={columns}
            dataSource={preview.rows}
            pagination={{ pageSize: 20, showSizeChanger: false }}
            scroll={{ x: 900 }}
          />
          {preview.diagnostics && Object.keys(preview.diagnostics).length > 0 && (
            <Collapse
              size="small"
              items={[
                {
                  key: 'diag',
                  label: '抓取诊断（已脱敏，Cookie 不会出现在这里）',
                  children: (
                    <Descriptions size="small" column={1} bordered>
                      {Object.entries(preview.diagnostics).map(([k, v]) => (
                        <Descriptions.Item key={k} label={k}>
                          <Text code>{JSON.stringify(v)}</Text>
                        </Descriptions.Item>
                      ))}
                    </Descriptions>
                  ),
                },
              ]}
            />
          )}
        </>
      ) : (
        <Empty description="还没有预览结果" />
      )}
    </Space>

    {/* 内联新建章节：本页需要在既有章节上写提示词，缺章节时不能只留一条死路 */}
    <Modal
      title="新建章节"
      open={createChapterOpen}
      onCancel={() => setCreateChapterOpen(false)}
      onOk={() => void handleCreateChapter()}
      okText="创建并选中"
      cancelText="取消"
      confirmLoading={creatingChapter}
      destroyOnClose
    >
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        <Text strong>章节标题</Text>
        <Input
          placeholder="例如：第 1 集"
          value={createChapterTitle}
          onChange={(e) => setCreateChapterTitle(e.target.value)}
        />
        <Text strong>章节内容（可粘贴剧本，选填）</Text>
        <Input.TextArea
          rows={6}
          placeholder="可留空：提示词导入只需要章节作为镜头的载体"
          value={createChapterText}
          onChange={(e) => setCreateChapterText(e.target.value)}
        />
        <Text type="secondary" className="text-xs">
          创建后会自动选中该章节并恢复「预览 / 确认写入」按钮；镜头不足时导入会按既有规则补建。
        </Text>
      </Space>
    </Modal>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* 标签页二：出口 A（仅提示词导出）                                       */
/* ------------------------------------------------------------------ */

/**
 * 交付行 + 本次后端新增的交付字段。
 *
 * `bound_assets` / `export_sources` / `include_bindings` 是后端本次新增的，
 * 而 `src/services/generated/**` 是自动产物（生成链依赖 pnpm，本机未安装），
 * 尚未包含它们——所以这里做一处局部类型扩展，而不是手改生成目录。
 */
type DeliveryRowWithBindings = PromptDeliveryRowRead & {
  bound_assets?: Record<string, string[]>
}

const BINDING_SLOT_LABELS: Array<[string, string]> = [
  ['characters', '角色'],
  ['scene', '场景'],
  ['props', '道具'],
  ['costumes', '服装'],
]

function renderBoundAssets(bound?: Record<string, string[]>): React.ReactNode {
  if (!bound) return <Text type="secondary">—</Text>
  const parts = BINDING_SLOT_LABELS.map(([key, label]) => {
    const names = bound[key] ?? []
    return names.length ? `${label}：${names.join('、')}` : ''
  }).filter(Boolean)
  if (!parts.length) return <Text type="secondary">未绑定</Text>
  return <Text>{parts.join('；')}</Text>
}

const PromptDeliveryPanel: React.FC<{ projectId?: string }> = ({ projectId }) => {
  const [scope, setScope] = useState<'episodes' | 'episode' | 'current_shot'>('episodes')
  const [chapters, setChapters] = useState<ChapterOption[]>([])
  const [chapterId, setChapterId] = useState<string>()
  const [shots, setShots] = useState<ShotOption[]>([])
  const [shotId, setShotId] = useState<string>()
  const [data, setData] = useState<PromptDeliveryRead>()
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  // 交付文本是否带出绑定资产（后端本次新增，默认开）
  const [includeBindings, setIncludeBindings] = useState(true)

  useEffect(() => {
    setChapterId(undefined)
    setShotId(undefined)
    setData(undefined)
    if (!projectId) {
      setChapters([])
      return
    }
    void (async () => {
      try {
        const items = await loadAll(async (page, pageSize) => {
          const res = await StudioChaptersService.listChaptersApiV1StudioChaptersGet({
            projectId,
            page,
            pageSize,
          })
          return {
            items: res.data?.items ?? [],
            maxPage: res.data?.pagination?.max_page ?? 1,
          }
        })
        setChapters(items.map((c) => ({ label: c.title || c.id, value: c.id })))
      } catch (error) {
        message.error(`加载章节失败：${describeError(error)}`)
      }
    })()
  }, [projectId])

  useEffect(() => {
    setShotId(undefined)
    if (!chapterId || scope !== 'current_shot') {
      setShots([])
      return
    }
    void (async () => {
      try {
        const items = await loadAll(async (page, pageSize) => {
          const res = await StudioShotsService.listShotsApiV1StudioShotsGet({
            chapterId,
            page,
            pageSize,
          })
          return {
            items: res.data?.items ?? [],
            maxPage: res.data?.pagination?.max_page ?? 1,
          }
        })
        setShots(
          items.map((s) => ({
            label: `S${String(s.index).padStart(3, '0')} · ${s.title}`,
            value: s.id,
          }))
        )
      } catch (error) {
        message.error(`加载镜头失败：${describeError(error)}`)
      }
    })()
  }, [chapterId, scope])

  const query = useMemo(() => {
    const params: { projectId: string; scope: string; chapterId?: string; shotId?: string } = {
      projectId: projectId as string,
      scope,
    }
    if (scope === 'episode' || scope === 'current_shot') params.chapterId = chapterId
    if (scope === 'current_shot') params.shotId = shotId
    return params
  }, [projectId, scope, chapterId, shotId])

  const scopeReady =
    Boolean(projectId) &&
    (scope === 'episodes' ||
      ((scope === 'episode' || scope === 'current_shot') && Boolean(chapterId)) &&
      (scope !== 'current_shot' || Boolean(shotId)))

  const handlePreview = async () => {
    if (!scopeReady) {
      message.warning('请先补全选择范围')
      return
    }
    setLoading(true)
    try {
      const res =
        await StudioPromptDeliveryService.previewPromptDeliveryApiV1StudioPromptDeliveryProjectIdGet(
          query
        )
      setData(res.data ?? undefined)
    } catch (error) {
      setData(undefined)
      message.error(describeError(error), 8)
    } finally {
      setLoading(false)
    }
  }

  const handleDownload = async () => {
    if (!scopeReady) {
      message.warning('请先补全选择范围')
      return
    }
    setDownloading(true)
    try {
      const search = new URLSearchParams()
      search.set('scope', scope)
      if (query.chapterId) search.set('chapter_id', query.chapterId)
      if (query.shotId) search.set('shot_id', query.shotId)
      search.set('include_bindings', includeBindings ? 'true' : 'false')
      const response = await fetch(
        `${apiBase()}/api/v1/studio/prompt-delivery/${encodeURIComponent(
          projectId as string
        )}/export?${search.toString()}`
      )
      if (!response.ok) {
        const text = await response.text()
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = undefined
        }
        throw new Error(renderEnvelope(parsed, text || `下载失败（HTTP ${response.status}）`))
      }
      const blob = await response.blob()
      const disposition = response.headers.get('Content-Disposition') ?? ''
      const matched = /filename="?([^"]+)"?/.exec(disposition)
      const filename = matched?.[1] ?? 'prompts.txt'
      const link = document.createElement('a')
      const objectUrl = URL.createObjectURL(blob)
      link.href = objectUrl
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(objectUrl)
      message.success(`已下载 ${filename}`)
    } catch (error) {
      message.error(describeError(error), 8)
    } finally {
      setDownloading(false)
    }
  }

  const handleCopy = async () => {
    if (!data?.text) return
    try {
      await navigator.clipboard.writeText(data.text)
      message.success('提示词正文已复制到剪贴板')
    } catch {
      message.warning('浏览器拒绝了剪贴板访问，请手动选中下方文本复制')
    }
  }

  const columns: ColumnsType<DeliveryRowWithBindings> = [
    {
      title: '镜头',
      dataIndex: 'shot_code',
      width: 100,
      render: (value: string) => <Text strong>{value}</Text>,
    },
    {
      title: '章节',
      dataIndex: 'chapter_label',
      width: 130,
      render: (value: string) => <Text>{value}</Text>,
    },
    { title: '标题', dataIndex: 'shot_title', width: 180, ellipsis: true },
    {
      title: '可交付',
      dataIndex: 'exportable',
      width: 90,
      render: (value: boolean) =>
        value ? <Tag color="green">可导出</Tag> : <Tag>跳过</Tag>,
    },
    {
      title: '提示词',
      dataIndex: 'video_prompt',
      ellipsis: true,
      render: (value: string) =>
        value ? <Text>{value.slice(0, 80)}</Text> : <Text type="secondary">（空）</Text>,
    },
    {
      title: '绑定资产',
      dataIndex: 'bound_assets',
      width: 240,
      render: (value: Record<string, string[]> | undefined) => renderBoundAssets(value),
    },
    {
      title: '说明',
      dataIndex: 'issue',
      width: 160,
      render: (value: string) =>
        value ? <Text type="secondary">{value}</Text> : <Text type="secondary">—</Text>,
    },
  ]

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Row gutter={16} align="bottom">
        <Col>
          <Text strong>导出范围</Text>
          <div style={{ marginTop: 4 }}>
            <Segmented
              value={scope}
              onChange={(value) => {
                setScope(value as 'episodes' | 'episode' | 'current_shot')
                setData(undefined)
              }}
              options={[
                { label: '整个项目', value: 'episodes' },
                { label: '指定章节', value: 'episode' },
                { label: '指定镜头', value: 'current_shot' },
              ]}
            />
          </div>
        </Col>
        {scope !== 'episodes' && (
          <Col>
            <Text strong>章节</Text>
            <Select
              style={{ width: 240, marginTop: 4 }}
              placeholder={projectId ? '选择章节' : '请先选择项目'}
              value={chapterId}
              onChange={(value) => {
                setChapterId(value)
                setData(undefined)
              }}
              options={chapters}
              disabled={!projectId}
              showSearch
              optionFilterProp="label"
            />
          </Col>
        )}
        {scope === 'current_shot' && (
          <Col>
            <Text strong>镜头</Text>
            <Select
              style={{ width: 240, marginTop: 4 }}
              placeholder={chapterId ? '选择镜头' : '请先选择章节'}
              value={shotId}
              onChange={(value) => {
                setShotId(value)
                setData(undefined)
              }}
              options={shots}
              disabled={!chapterId}
              showSearch
              optionFilterProp="label"
            />
          </Col>
        )}
        <Col>
          <Space>
            <Button
              type="primary"
              icon={<EyeOutlined />}
              loading={loading}
              disabled={!scopeReady}
              onClick={() => void handlePreview()}
            >
              预览
            </Button>
            <Checkbox
              checked={includeBindings}
              onChange={(e) => setIncludeBindings(e.target.checked)}
            >
              带出绑定资产
            </Checkbox>
            <Button
              icon={<CloudDownloadOutlined />}
              loading={downloading}
              disabled={!scopeReady}
              onClick={() => void handleDownload()}
            >
              下载 TXT
            </Button>
            <Button onClick={() => void handleCopy()} disabled={!data?.text}>
              复制正文
            </Button>
          </Space>
        </Col>
      </Row>

      {data ? (
        <>
          <Row gutter={16}>
            <Col span={6}>
              <Card size="small">
                <Statistic title="可导出" value={data.exportable_count} suffix="条" />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small">
                <Statistic title="跳过" value={data.skipped_count} suffix="条" />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small">
                <Statistic title="范围" value={data.scope_label} />
              </Card>
            </Col>
            <Col span={6}>
              <Card size="small">
                <Statistic title="来源口径" value={data.export_source} />
              </Card>
            </Col>
          </Row>

          {data.note && <Alert type="info" showIcon message={data.note} />}
          {!data.has_content && (
            <Alert
              type="warning"
              showIcon
              message="这个范围内没有可导出的提示词（只认来源为 jurilu 且有正文的）"
            />
          )}

          <Table<DeliveryRowWithBindings>
            size="small"
            rowKey="shot_id"
            columns={columns}
            dataSource={data.rows}
            pagination={{ pageSize: 20, showSizeChanger: false }}
            scroll={{ x: 900 }}
          />

          <Divider style={{ margin: '8px 0' }}>交付文本预览</Divider>
          <Input.TextArea value={data.text} readOnly rows={12} />
        </>
      ) : (
        <Empty description="选择范围后点「预览」" />
      )}
    </Space>
  )
}

/* ------------------------------------------------------------------ */
/* 标签页三：一键技能（导演 Skill 生成 + 导出 + 写回镜头）                 */
/* ------------------------------------------------------------------ */

const QuickSkillPanel: React.FC<{ projectId?: string }> = ({ projectId }) => {
  const [skills, setSkills] = useState<QuickSkillItem[]>([])
  const [skillId, setSkillId] = useState<string>()
  const [chapters, setChapters] = useState<ChapterOption[]>([])
  const [chapterId, setChapterId] = useState<string>()
  const [shots, setShots] = useState<ShotOption[]>([])
  const [shotId, setShotId] = useState<string>()
  const [request, setRequest] = useState('')
  const [extraContext, setExtraContext] = useState('')
  const [contextText, setContextText] = useState('')
  const [result, setResult] = useState<QuickSkillGenerateRead>()
  const [promptDraft, setPromptDraft] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [loadingContext, setLoadingContext] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [downloading, setDownloading] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const res = await StudioQuickSkillService.listQuickSkillsApiV1StudioQuickSkillSkillsGet()
        setSkills(res.data?.skills ?? [])
      } catch (error) {
        message.error(`加载导演 Skill 失败：${describeError(error)}`)
      }
    })()
  }, [])

  useEffect(() => {
    setChapterId(undefined)
    setShotId(undefined)
    setContextText('')
    if (!projectId) {
      setChapters([])
      return
    }
    void (async () => {
      try {
        const items = await loadAll(async (page, pageSize) => {
          const res = await StudioChaptersService.listChaptersApiV1StudioChaptersGet({
            projectId,
            page,
            pageSize,
          })
          return {
            items: res.data?.items ?? [],
            maxPage: res.data?.pagination?.max_page ?? 1,
          }
        })
        setChapters(items.map((c) => ({ label: c.title || c.id, value: c.id })))
      } catch (error) {
        message.error(`加载章节失败：${describeError(error)}`)
      }
    })()
  }, [projectId])

  useEffect(() => {
    setShotId(undefined)
    setContextText('')
    if (!chapterId) {
      setShots([])
      return
    }
    void (async () => {
      try {
        const items = await loadAll(async (page, pageSize) => {
          const res = await StudioShotsService.listShotsApiV1StudioShotsGet({
            chapterId,
            page,
            pageSize,
          })
          return {
            items: res.data?.items ?? [],
            maxPage: res.data?.pagination?.max_page ?? 1,
          }
        })
        setShots(
          items.map((s) => ({
            label: `S${String(s.index).padStart(3, '0')} · ${s.title}`,
            value: s.id,
          }))
        )
      } catch (error) {
        message.error(`加载镜头失败：${describeError(error)}`)
      }
    })()
  }, [chapterId])

  const selectedSkill = skills.find((s) => s.skill_id === skillId)
  const canGenerate = Boolean(skillId && request.trim())

  const handlePreviewContext = async () => {
    if (!shotId && !chapterId) {
      message.warning('先选章节或镜头，才能装配上下文')
      return
    }
    setLoadingContext(true)
    try {
      const res = await StudioQuickSkillService.previewQuickSkillContextApiV1StudioQuickSkillContextGet({
        chapterId,
        shotId,
      })
      setContextText(res.data?.text ?? '')
      message.success('上下文已装配（未调用模型）')
    } catch (error) {
      message.error(describeError(error), 8)
    } finally {
      setLoadingContext(false)
    }
  }

  const handleGenerate = async () => {
    if (!canGenerate) {
      message.warning('请先选择导演 Skill 并写清楚需求')
      return
    }
    setGenerating(true)
    try {
      const res =
        await StudioQuickSkillService.generateQuickSkillApiV1StudioQuickSkillGeneratePost({
          requestBody: {
            skill_id: skillId as string,
            request: request.trim(),
            context: extraContext,
            project_id: projectId,
            chapter_id: chapterId,
            shot_id: shotId,
            save_to_shot: false,
          },
        })
      const data = res.data ?? undefined
      setResult(data)
      setPromptDraft(data?.prompt ?? '')
      setContextText(data?.context ?? '')
      message.success(`生成完成（模型：${data?.model_used || '默认文字模型'}）`)
    } catch (error) {
      message.error(describeError(error), 10)
    } finally {
      setGenerating(false)
    }
  }

  const handleCopy = async () => {
    if (!promptDraft.trim()) return
    try {
      await navigator.clipboard.writeText(promptDraft)
      message.success('提示词已复制到剪贴板')
    } catch {
      message.warning('浏览器拒绝了剪贴板访问，请手动选中文本框复制')
    }
  }

  const handleDownload = async () => {
    if (!promptDraft.trim() || !skillId) {
      message.warning('还没有可导出的提示词')
      return
    }
    setDownloading(true)
    try {
      const response = await fetch(`${apiBase()}/api/v1/studio/quick-skill/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          skill_id: skillId,
          project_id: projectId ?? '',
          title: selectedSkill ? `${selectedSkill.display_name}（${selectedSkill.skill_id}）` : skillId,
          entries: [
            {
              label: shotId
                ? `S${String(shots.findIndex((s) => s.value === shotId) + 1).padStart(3, '0')} · ${
                    shots.find((s) => s.value === shotId)?.label ?? shotId
                  }`
                : selectedSkill?.display_name ?? skillId,
              prompt: promptDraft,
              note: extraContext ? `附加上下文：${extraContext.slice(0, 120)}` : '',
            },
          ],
        }),
      })
      if (!response.ok) {
        const text = await response.text()
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = undefined
        }
        throw new Error(renderEnvelope(parsed, text || `下载失败（HTTP ${response.status}）`))
      }
      const blob = await response.blob()
      const disposition = response.headers.get('Content-Disposition') ?? ''
      const matched = /filename="?([^"]+)"/.exec(disposition)
      const filename = matched?.[1] ?? 'skill-prompt.txt'
      const link = document.createElement('a')
      const objectUrl = URL.createObjectURL(blob)
      link.href = objectUrl
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(objectUrl)
      message.success(`已下载 ${filename}`)
    } catch (error) {
      message.error(describeError(error), 8)
    } finally {
      setDownloading(false)
    }
  }

  const handleSaveToShot = async () => {
    if (!shotId) {
      message.warning('先选一个镜头，才能写回')
      return
    }
    if (!promptDraft.trim()) {
      message.warning('提示词为空')
      return
    }
    setSaving(true)
    try {
      const res =
        await StudioQuickSkillService.saveQuickSkillToShotApiV1StudioQuickSkillSaveToShotPost({
          requestBody: { shot_id: shotId, prompt: promptDraft, overwrite },
        })
      const data = res.data
      if (data?.saved) {
        message.success('已写入镜头视频提示词（来源标记 skill）')
      } else {
        message.warning(data?.message || '未写入', 8)
      }
    } catch (error) {
      message.error(describeError(error), 8)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Row gutter={16} align="bottom">
        <Col span={8}>
          <Text strong>导演 Skill</Text>
          <Select
            style={{ width: '100%', marginTop: 4 }}
            placeholder="选择一个导演 Skill"
            value={skillId}
            onChange={(value) => {
              setSkillId(value)
              setResult(undefined)
              setPromptDraft('')
            }}
            options={skills.map((s) => ({
              label: `${s.display_name} · ${s.stage_label}${s.pinned ? ' ★' : ''}`,
              value: s.skill_id,
              disabled: !s.source_present,
            }))}
            showSearch
            optionFilterProp="label"
          />
        </Col>
        <Col span={8}>
          <Text strong>章节（可选，用于自动带上下文）</Text>
          <Select
            style={{ width: '100%', marginTop: 4 }}
            placeholder={projectId ? '选择章节' : '请先选择项目'}
            value={chapterId}
            onChange={setChapterId}
            options={chapters}
            disabled={!projectId}
            allowClear
            showSearch
            optionFilterProp="label"
          />
        </Col>
        <Col span={8}>
          <Text strong>镜头（可选；填了才能写回）</Text>
          <Select
            style={{ width: '100%', marginTop: 4 }}
            placeholder={chapterId ? '选择镜头' : '请先选择章节'}
            value={shotId}
            onChange={setShotId}
            options={shots}
            disabled={!chapterId}
            allowClear
            showSearch
            optionFilterProp="label"
          />
        </Col>
      </Row>

      {selectedSkill && (
        <Alert type="info" showIcon message={selectedSkill.summary} description={
          <Text type="secondary">
            规则正文 {selectedSkill.rule_chars} 字，来自 {selectedSkill.source_name}
            {selectedSkill.load_error ? `（读取异常：${selectedSkill.load_error}）` : ''}
          </Text>
        } />
      )}

      <div>
        <Text strong>本次要生成什么</Text>
        <Input.TextArea
          style={{ marginTop: 4 }}
          rows={3}
          placeholder="例如：把这一镜做成可直接提交的 5 秒视频提示词，保持人物服装不变。"
          value={request}
          onChange={(e) => setRequest(e.target.value)}
        />
      </div>

      <Collapse
        size="small"
        items={[
          {
            key: 'ctx',
            label: '附加上下文与中台上下文（可选）',
            children: (
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                <Input.TextArea
                  rows={3}
                  placeholder="补充要求，例如：人物服装保持不变、镜头不要快切、避免出现字幕。"
                  value={extraContext}
                  onChange={(e) => setExtraContext(e.target.value)}
                />
                <Space>
                  <Button
                    size="small"
                    icon={<EyeOutlined />}
                    loading={loadingContext}
                    onClick={() => void handlePreviewContext()}
                  >
                    预览中台上下文
                  </Button>
                  <Text type="secondary">从项目/章节/镜头自动装配，只读、不调模型</Text>
                </Space>
                <Input.TextArea value={contextText} readOnly rows={6} placeholder="（还没有上下文）" />
              </Space>
            ),
          },
        ]}
      />

      <Space>
        <Button
          type="primary"
          icon={<ThunderboltOutlined />}
          loading={generating}
          disabled={!canGenerate}
          onClick={() => void handleGenerate()}
        >
          生成提示词（调用文字模型）
        </Button>
        {result && (
          <Text type="secondary">
            模型：{result.model_used || '默认文字模型'} · 结果 {promptDraft.length} 字
          </Text>
        )}
      </Space>

      {result?.warnings && result.warnings.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="提示"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          }
        />
      )}

      {promptDraft ? (
        <>
          <Divider style={{ margin: '8px 0' }}>生成结果（可直接微调后再导出/写回）</Divider>
          <Input.TextArea
            value={promptDraft}
            onChange={(e) => setPromptDraft(e.target.value)}
            rows={14}
          />
          <Space wrap>
            <Button onClick={() => void handleCopy()}>复制</Button>
            <Button
              icon={<CloudDownloadOutlined />}
              loading={downloading}
              onClick={() => void handleDownload()}
            >
              下载 TXT
            </Button>
            <Button
              icon={<CloudUploadOutlined />}
              loading={saving}
              disabled={!shotId}
              onClick={() => void handleSaveToShot()}
            >
              写入镜头
            </Button>
            <Space>
              <span>镜头已有提示词时</span>
              <Select
                size="small"
                style={{ width: 110 }}
                value={overwrite}
                onChange={setOverwrite}
                options={[
                  { label: '不覆盖', value: false },
                  { label: '允许覆盖', value: true },
                ]}
              />
            </Space>
            {!shotId && <Text type="secondary">选中镜头后才能写回</Text>}
          </Space>
        </>
      ) : (
        <Empty description="选好 Skill 与镜头、写好需求后点「生成提示词」" />
      )}
    </Space>
  )
}

export default PromptFlowPage