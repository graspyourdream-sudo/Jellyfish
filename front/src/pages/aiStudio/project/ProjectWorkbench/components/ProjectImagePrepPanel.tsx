import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Dropdown,
  Empty,
  Input,
  Modal,
  Segmented,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import type { TableColumnsType } from 'antd'
import {
  ArrowRightOutlined,
  MoreOutlined,
  PictureOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import { useNavigate, useParams } from 'react-router-dom'
import { StudioEntitiesApi } from '../../../../../services/studioEntities'
import {
  fetchImagePromptSlots,
  getAssetImagePrompts,
  previewImagePlan,
  saveAssetImagePrompts,
  type ImagePlanTarget,
  type ImagePromptSlotSpec,
} from '../../../../../services/llmPipelineApi'
import {
  getProjectSignalAssetTypeLabel,
  type ProjectSignalAsset,
  type ProjectSignalAssetType,
  type ProjectStepSignalDetail,
} from '../hooks/useProjectStepSignals'
import { AssetImagePromptLlmPanel } from './AssetImagePromptLlmPanel'
import { GenerationGateBanner } from '../../../components/GenerationGateBanner'
import { useGenerationGate } from '../../../components/generationGate'
import { classifyGenerationFailure, failureText } from '../../../components/generationGate'
import { StudioEntitiesService } from '../../../../../services/generated'
import {
  ASSET_PREP_STATUSES,
  assetPrepInputFromReadiness,
  describeAssetPrepSummary,
  resolveAssetPrepStatus,
  summarizeAssetPrep,
} from '../assetPrepStatus'

/** 提示词来源的展示口径（与后端 `prompt_source` 一一对应）。 */
const PROMPT_SOURCE_META: Record<string, { label: string; color: string; hint: string }> = {
  saved: {
    label: '已保存提示词',
    color: 'green',
    hint: '第 2 步「资产准备」在资产上保存的提示词 —— 这一环确认保存的产物正在被生图实际使用',
  },
  template: {
    label: '模板拼装',
    color: 'gold',
    hint: '该资产还没有保存过图片提示词，本次用确定性模板 + 资产描述拼装',
  },
  request: { label: '本次显式指定', color: 'blue', hint: '调用方传了 prompt_overrides，优先级最高' },
}

const PLAN_ASSET_TYPES = [
  { label: '角色', value: 'character' as const },
  { label: '场景', value: 'scene' as const },
  { label: '道具', value: 'prop' as const },
]

const TYPE_COLOR: Record<ProjectSignalAssetType, string> = {
  character: 'purple',
  scene: 'blue',
  prop: 'gold',
  costume: 'cyan',
}

function assetKey(asset: ProjectSignalAsset): string {
  return `${asset.type}:${asset.id}`
}

/**
 * 第 3 步「图片准备」的入口页。
 *
 * 说明（本轮实现选择）：项目资产的图片与图片提示词是在**已有的资产编辑页**里完成的
 * （角色 → `/projects/:projectId/roles/:id/edit`，场景/道具/服装 → `/assets/.../:id/edit`），
 * 全局资产管理页 `/assets` 只覆盖演员/场景/道具/服装、且不区分项目。
 * 所以这里做成「项目资产图片清单 + 逐个跳到已有编辑页」的就地入口，
 * 而不是简单把人扔到 `/assets`；顶部再给一个「前往资产库」的次要入口。
 */
type ProjectImagePrepPanelProps = {
  assets: ProjectSignalAsset[]
  detail: ProjectStepSignalDetail
  loading: boolean
  /** 保存图片提示词后重算本步骤信号（摘要条与资产表要跟着变，不能只刷新我自己的预览）。 */
  onReload?: () => void
}

export function ProjectImagePrepPanel({ assets, detail, loading, onReload }: ProjectImagePrepPanelProps) {
  const navigate = useNavigate()
  const { projectId } = useParams<{ projectId: string }>()

  /**
   * 打开资产编辑页。
   *
   * `generate=true` 时带上 `?generate=1`：资产编辑页会自动打开该资产的出图确认弹窗，
   * 这样「生成」入口就不是把用户扔到一个还要再点两下的页面。
   * 两条路径都带项目作用域（character 走项目角色路由，其余带 returnTo），
   * 避免出现「从资产库进入 → 缺项目作用域 → 出图静默失败」。
   */
  const openAssetEditor = (asset: ProjectSignalAsset, options?: { generate?: boolean }) => {
    if (!projectId) return
    const assetType = asset.type
    const generateParam = options?.generate ? '?generate=1' : ''
    if (assetType === 'character') {
      navigate(`/projects/${projectId}/roles/${asset.id}/edit${generateParam}`)
      return
    }
    const tabByType: Record<Exclude<ProjectSignalAssetType, 'character'>, 'scenes' | 'props' | 'costumes'> = {
      scene: 'scenes',
      prop: 'props',
      costume: 'costumes',
    }
    const segment = assetType === 'scene' ? 'scenes' : assetType === 'prop' ? 'props' : 'costumes'
    // 回到第 3 步（图片准备），而不是退回旧的资产 Tab 链接。
    const returnTo = encodeURIComponent(`/projects/${projectId}?step=image_prep&tab=${tabByType[assetType]}`)
    const separator = '?'
    navigate(`/assets/${segment}/${asset.id}/edit${separator}returnTo=${returnTo}${options?.generate ? '&generate=1' : ''}`)
  }

  /**
   * 每行资产的业务状态与顶部统计**共用同一个映射**
   * （`assetPrepInputFromReadiness` ← 统一数据源 `asset-readiness`）。
   */
  const prepInputs = useMemo(
    () =>
      assets.map((asset) =>
        assetPrepInputFromReadiness({
          has_pending_candidate: asset.hasPendingCandidate,
          has_image_prompt: asset.hasImagePrompt,
          has_image: asset.hasImage,
          has_primary: asset.hasPrimary,
        }),
      ),
    [assets],
  )

  const statusByAsset = useMemo(() => {
    const map = new Map<string, ReturnType<typeof resolveAssetPrepStatus>>()
    assets.forEach((asset, index) => {
      map.set(assetKey(asset), resolveAssetPrepStatus(prepInputs[index]))
    })
    return map
  }, [assets, prepInputs])

  const prepSummary = useMemo(() => summarizeAssetPrep(prepInputs), [prepInputs])

  const pending = useMemo(
    () => assets.filter((asset) => asset.hasPendingCandidate || !asset.hasImage || !asset.hasImagePrompt),
    [assets],
  )

  // ---- 生图计划预览（只读端点，永不触网、不花钱）----
  // 这一步存在的意义：让「第 3 步保存的图片提示词」在**生产流程里**能当场看到
  // 被生图计划读取（prompt_source=saved），而不是只能靠接口测试或肉眼看文本。
  const [planType, setPlanType] = useState<'character' | 'scene' | 'prop'>('character')
  const [planStage, setPlanStage] = useState<'character_sheet' | 'reference_batch'>('character_sheet')
  const [plan, setPlan] = useState<{
    targets: ImagePlanTarget[]
    warnings: string[]
    summary: Record<string, unknown>
  } | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  const [planError, setPlanError] = useState('')
  /** 「查看定版图」预览的资产 */
  const [previewAsset, setPreviewAsset] = useState<ProjectSignalAsset | null>(null)
  /** 提取面板锚点：「待确认」状态的主操作把用户送回上面的确认写入区域 */
  const extractPanelRef = useRef<HTMLDivElement | null>(null)
  /** 正在设为定版的资产 key */
  const [settingPrimaryKey, setSettingPrimaryKey] = useState('')

  /**
   * 「设为定版」：每个资产只有**唯一主操作**——把该资产已有图片里的一张设为 `is_primary`。
   * 复用既有的实体图片 PATCH 接口，不新建链路、不复制文件。
   * 目标图片 ID 由统一数据源（`asset-readiness`）给出：它同时是缩略图用的那张。
   */
  const handleSetPrimary = async (asset: ProjectSignalAsset) => {
    const imageId = asset.imageId
    if (!imageId) {
      message.warning('该资产还没有图片，请先上传或生成图片')
      return
    }
    setSettingPrimaryKey(assetKey(asset))
    try {
      await StudioEntitiesService.updateEntityImageApiV1StudioEntitiesEntityTypeEntityIdImagesImageIdPatch({
        entityType: asset.type,
        entityId: asset.id,
        imageId,
        requestBody: { is_primary: true } as never,
      })
      message.success(`已把「${asset.name}」的这张图设为定版`)
      onReload?.()
    } catch (error) {
      const failure = classifyGenerationFailure(error, 'image')
      message.error(failureText(failure))
    } finally {
      setSettingPrimaryKey('')
    }
  }
  /** 出图门禁/模型状态（点击前显示：被 DRY_RUN 拦住 ≠ 接口没接通） */
  const gate = useGenerationGate()

  const loadPlan = useCallback(async () => {
    if (!projectId) return
    setPlanLoading(true)
    setPlanError('')
    try {
      const data = await previewImagePlan({
        project_id: projectId,
        asset_type: planType,
        stage: planStage,
        use_primary_reference: true,
      })
      setPlan({ targets: data.targets ?? [], warnings: data.warnings ?? [], summary: data.summary ?? {} })
    } catch (e) {
      setPlanError((e as Error)?.message || '生图计划预览失败')
      setPlan(null)
    } finally {
      setPlanLoading(false)
    }
  }, [planStage, planType, projectId])

  useEffect(() => {
    if (assets.length === 0) return
    void loadPlan()
  }, [assets.length, loadPlan])

  const planColumns: TableColumnsType<ImagePlanTarget> = [
    {
      title: '资产',
      dataIndex: 'name',
      ellipsis: true,
      render: (name: string, row) => (
        <span className="flex items-center gap-2 min-w-0">
          <Tag color={TYPE_COLOR[row.asset_type as ProjectSignalAssetType] ?? 'default'} className="mr-0">
            {getProjectSignalAssetTypeLabel(row.asset_type as ProjectSignalAssetType)}
          </Tag>
          <span className="truncate" title={name}>
            {name || row.source_asset_id}
          </span>
        </span>
      ),
    },
    {
      title: '提示词来源',
      dataIndex: 'prompt_source',
      width: 132,
      render: (source: string) => {
        const meta = PROMPT_SOURCE_META[String(source ?? '')] ?? PROMPT_SOURCE_META.template
        return (
          <Tooltip title={meta.hint}>
            <Tag color={meta.color} bordered={false}>
              {meta.label}
            </Tag>
          </Tooltip>
        )
      },
    },
    {
      title: '本次使用的提示词',
      dataIndex: 'prompt',
      ellipsis: true,
      render: (prompt: string) => (
        <Tooltip title={<div className="max-w-[420px] whitespace-pre-wrap">{prompt}</div>}>
          <span className="text-xs text-gray-600">{prompt || '—'}</span>
        </Tooltip>
      ),
    },
    {
      title: '垫图（定版主图）',
      dataIndex: 'reference_image',
      width: 150,
      render: (url: string) => {
        const text = String(url ?? '')
        if (!text) return <Tag bordered={false} className="text-gray-400">{planStage === 'reference_batch' ? '无可用垫图' : '定妆照不带垫图'}</Tag>
        const fileId = text.split('/').pop() ?? text
        return (
          <Tooltip title={text}>
            <Tag color="blue" bordered={false}>
              {fileId.length > 18 ? `${fileId.slice(0, 14)}…` : fileId}
            </Tag>
          </Tooltip>
        )
      },
    },
  ]

  const planSavedCount = (plan?.targets ?? []).filter((t) => t.prompt_source === 'saved').length
  const planReferenceCount = (plan?.targets ?? []).filter((t) => Boolean(t.reference_image)).length

  // ---- 手工填写图片提示词（DRY_RUN 下也能把"自己的"提示词写进 image_prompts）----
  const [slotSpecs, setSlotSpecs] = useState<ImagePromptSlotSpec[]>([])
  const [editorAsset, setEditorAsset] = useState<ProjectSignalAsset | null>(null)
  const [editorDraft, setEditorDraft] = useState<Record<string, string>>({})
  const [editorLoading, setEditorLoading] = useState(false)
  const [editorSaving, setEditorSaving] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        setSlotSpecs(await fetchImagePromptSlots())
      } catch {
        setSlotSpecs([])
      }
    })()
  }, [])

  const editorSlots = useMemo(
    () => slotSpecs.filter((slot) => slot.entity_type === editorAsset?.type),
    [editorAsset, slotSpecs],
  )

  const openPromptEditor = useCallback(async (asset: ProjectSignalAsset) => {
    setEditorAsset(asset)
    setEditorDraft({})
    setEditorLoading(true)
    try {
      const res = await StudioEntitiesApi.get(asset.type, asset.id)
      setEditorDraft(getAssetImagePrompts(res.data as Record<string, unknown> | null))
    } catch {
      setEditorDraft({})
    } finally {
      setEditorLoading(false)
    }
  }, [])

  const savePromptEditor = useCallback(async () => {
    if (!editorAsset) return
    const cleaned = Object.fromEntries(
      Object.entries(editorDraft).filter(([, value]) => String(value ?? '').trim() !== ''),
    )
    setEditorSaving(true)
    try {
      // 合并写入：只覆盖本次填写的类别，不丢掉其它已保存类别。
      await saveAssetImagePrompts(
        editorAsset.type,
        editorAsset.id,
        cleaned as Record<string, string>,
      )
      message.success(`已保存 ${Object.keys(cleaned).length} 个槽位的图片提示词`)
      setEditorAsset(null)
      // 先重算步骤信号（摘要条/资产表的「图片提示词」列），再刷新生图计划
      onReload?.()
      await loadPlan()
    } catch (e) {
      message.error((e as Error)?.message || '保存图片提示词失败')
    } finally {
      setEditorSaving(false)
    }
  }, [editorAsset, editorDraft, loadPlan, onReload])

  /**
   * 表格里的资产名直接来自统一数据源（`asset-readiness`）：
   * 四类资产都带 `name`，不再需要为场景/道具/服装补抓一次详情。
   */
  const displayName = (asset: ProjectSignalAsset) => asset.name || asset.id

  const orderedAssets = useMemo(() => {
    const rest = assets.filter((asset) => !pending.includes(asset))
    return [...pending, ...rest]
  }, [assets, pending])

  const columns: TableColumnsType<ProjectSignalAsset> = [
    {
      title: '业务状态',
      key: 'prepStatus',
      width: 190,
      render: (_: unknown, record) => {
        const status = statusByAsset.get(assetKey(record)) ?? ASSET_PREP_STATUSES.pending_candidate
        const color = status.tone === 'green' ? 'green' : status.tone === 'blue' ? 'blue' : status.tone === 'gold' ? 'gold' : 'default'
        return (
          <Space size={4} wrap>
            <Tag color={color} bordered={false}>
              {status.label}
            </Tag>
            <span className="text-[11px] text-gray-400">{`下一步：${status.nextActionLabel}`}</span>
          </Space>
        )
      },
    },
    {
      title: '资产',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
      render: (_: string, record) => (
        <span className="flex items-center gap-2 min-w-0">
          <Tag color={TYPE_COLOR[record.type]} className="mr-0">
            {getProjectSignalAssetTypeLabel(record.type)}
          </Tag>
          <span className="truncate" title={displayName(record)}>
            {displayName(record)}
          </span>
        </span>
      ),
    },
    {
      title: '参考图片',
      key: 'image',
      width: 110,
      render: (_, record) =>
        record.hasImage ? (
          <Tag color="green" bordered={false}>
            已有
          </Tag>
        ) : (
          <Tag color="gold" bordered={false}>
            待准备
          </Tag>
        ),
    },
    {
      title: '图片提示词',
      key: 'prompt',
      width: 130,
      render: (_, record) =>
        record.hasImagePrompt ? (
          <Tag color="green" bordered={false}>
            已保存
          </Tag>
        ) : (
          <Tag color="gold" bordered={false}>
            待生成
          </Tag>
        ),
    },
    {
      title: '定版图',
      key: 'primary',
      width: 92,
      render: (_, record) =>
        record.hasImage ? (
          <Button size="small" type="link" className="!px-0" onClick={() => setPreviewAsset(record)}>
            查看
          </Button>
        ) : (
          <Tooltip title="该资产还没有参考图/定版图">
            <Tag bordered={false} className="text-gray-400">
              未生成
            </Tag>
          </Tooltip>
        ),
    },
    {
      title: '下一步（唯一主操作）',
      key: 'action',
      width: 260,
      render: (_: unknown, record) => {
        const status = statusByAsset.get(assetKey(record)) ?? ASSET_PREP_STATUSES.pending_candidate
        const busy = settingPrimaryKey === assetKey(record)
        // 每个状态只给一个主按钮，其余入口退到次要位置（编辑 / 填提示词 / 查看）
        const primaryButton = (() => {
          switch (status.key) {
            case 'pending_candidate':
              return (
                <Button size="small" type="primary" onClick={() => extractPanelRef.current?.scrollIntoView({ behavior: 'smooth' })}>
                  确认写入
                </Button>
              )
            case 'linked_prompt_todo':
              return (
                <Button size="small" type="primary" loading={editorLoading} onClick={() => void openPromptEditor(record)}>
                  填提示词
                </Button>
              )
            case 'prompt_ready_image_todo':
              return (
                <Tooltip title="进入资产编辑页并直接打开出图确认（复用既有 image-pipeline）">
                  <Button size="small" type="primary" icon={<PictureOutlined />} onClick={() => openAssetEditor(record, { generate: true })}>
                    生成图片
                  </Button>
                </Tooltip>
              )
            case 'image_ready_primary_todo':
              return (
                <Tooltip title="把该资产已有的一张图片设为定版">
                  <Button size="small" type="primary" loading={busy} onClick={() => void handleSetPrimary(record)}>
                    设为定版
                  </Button>
                </Tooltip>
              )
            default:
              return (
                <Button size="small" type="primary" onClick={() => setPreviewAsset(record)}>
                  查看定版图
                </Button>
              )
          }
        })()

        return (
          <Space size={4} wrap>
            {primaryButton}
            <Dropdown
              menu={{
                items: [
                  { key: 'edit', label: '编辑资产', onClick: () => openAssetEditor(record) },
                  { key: 'prompt', label: '填/改图片提示词', onClick: () => void openPromptEditor(record) },
                  { key: 'generate', label: '进入出图确认', onClick: () => openAssetEditor(record, { generate: true }) },
                  { key: 'primary', label: '设为定版', disabled: !record.imageId, onClick: () => void handleSetPrimary(record) },
                ],
              }}
            >
              <Button size="small" icon={<MoreOutlined />} />
            </Dropdown>
          </Space>
        )
      },
    },
  ]

  const summaryTags = (
    <Space size={4} wrap>
      <Tag bordered={false}>角色 {detail.assetCounts.characters}</Tag>
      <Tag bordered={false}>场景 {detail.assetCounts.scenes}</Tag>
      <Tag bordered={false}>道具 {detail.assetCounts.props}</Tag>
      <Tag bordered={false}>服装 {detail.assetCounts.costumes}</Tag>
      <Tag color={detail.assetImageCount > 0 ? 'green' : 'gold'} bordered={false}>
        已有参考图 {detail.assetImageCount}
      </Tag>
    </Space>
  )

  return (
    <Card
      title="资产图片与定版"
      extra={
        <Space>
          {summaryTags}
          <Button icon={<ArrowRightOutlined />} onClick={() => navigate('/assets')}>
            前往资产库
          </Button>
        </Space>
      }
    >
      <div className="mb-3 text-xs text-gray-500">
        为角色、场景、道具准备参考图片与图片提示词。每行都可以直接「生成」（进入既有出图链路）、「编辑」
        或「查看定版图」；参考图直接决定后续镜头画面的统一性。
      </div>

      {/* 点击前先讲清楚：模型有没有配置、是否被 DRY_RUN 演练门禁挡住 */}
      <GenerationGateBanner gate={gate} outlet="image" />

      {/* 各状态数量：只有范围内资产全部「已定版」才显示就绪 */}
      <Alert
        type={prepSummary.allDone ? 'success' : 'info'}
        showIcon
        style={{ marginBottom: 8 }}
        message={
          prepSummary.allDone
            ? `资产准备已就绪（${prepSummary.total}/${prepSummary.total} 已定版）`
            : `资产准备未就绪（${prepSummary.done}/${prepSummary.total} 已定版）`
        }
        description={<span className="text-xs">{describeAssetPrepSummary(prepSummary)}</span>}
      />

      <Spin spinning={loading}>
        {assets.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="项目还没有角色/场景/道具资产：请先在第 2 步「资产准备」里确认提取候选（关联已有资产或新建）"
          >
            <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate(`/projects/${projectId}?step=extract_assets`)}>
              去提取资产
            </Button>
          </Empty>
        ) : (
          <Table<ProjectSignalAsset>
            rowKey={assetKey}
            size="small"
            columns={columns}
            dataSource={orderedAssets}
            pagination={orderedAssets.length > 10 ? { pageSize: 10 } : false}
          />
        )}
      </Spin>

      {assets.length > 0 ? (
        <div className="mt-4 border-t border-slate-200 pt-4">
          {/* 大模型生成图片提示词（单项 / 选中项 / 只补缺失 / 可停止与重试 / 确认后保存） */}
          <AssetImagePromptLlmPanel projectId={projectId} assets={assets} onSaved={onReload} />
        </div>
      ) : null}

      {assets.length > 0 ? (
        <div className="mt-4 border-t border-slate-200 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-900">生图计划预览（只读）</div>
              <Typography.Text type="secondary" className="text-[11px]">
                展示「如果现在出图，会用什么提示词、用哪张垫图」。本预览不触网、不建任务、不花钱；
                <span className="font-medium">提示词来源标记为「已保存提示词」时，说明这一步保存的提示词正在被生图读取</span>。
              </Typography.Text>
            </div>
            <Space size={8} wrap>
              <Segmented
                size="small"
                value={planType}
                onChange={(value) => setPlanType(value as 'character' | 'scene' | 'prop')}
                options={PLAN_ASSET_TYPES}
              />
              <Segmented
                size="small"
                value={planStage}
                onChange={(value) => setPlanStage(value as 'character_sheet' | 'reference_batch')}
                options={[
                  { label: '定妆照（不带垫图）', value: 'character_sheet' },
                  { label: '垫图批量（带定版垫图）', value: 'reference_batch' },
                ]}
              />
              <Button size="small" icon={<ReloadOutlined />} loading={planLoading} onClick={() => void loadPlan()}>
                刷新计划
              </Button>
            </Space>
          </div>

          {planError ? (
            <Alert className="mt-3" type="error" showIcon message="生图计划预览失败" description={planError} />
          ) : null}

          {plan ? (
            <div className="mt-3 space-y-3">
              <Space size={8} wrap>
                <Tag color="blue" bordered={false}>{`目标 ${plan.targets.length} 条`}</Tag>
                <Tag color={planSavedCount > 0 ? 'green' : 'gold'} bordered={false}>
                  {`用已保存提示词 ${planSavedCount} 条`}
                </Tag>
                <Tag color={planReferenceCount > 0 ? 'blue' : 'default'} bordered={false}>
                  {`带垫图 ${planReferenceCount} 条`}
                </Tag>
                {planStage === 'reference_batch' && plan.targets.length > planReferenceCount ? (
                  <Tag color="orange" bordered={false}>
                    {`${plan.targets.length - planReferenceCount} 条没有可用垫图（会退化为纯文本出图）`}
                  </Tag>
                ) : null}
              </Space>
              {plan.warnings.length > 0 ? (
                <Alert
                  type="info"
                  showIcon
                  message="后端提示"
                  description={
                    <ul className="list-disc pl-4 space-y-0.5 text-xs">
                      {plan.warnings.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  }
                />
              ) : null}
              <Table<ImagePlanTarget>
                rowKey="source_task_id"
                size="small"
                loading={planLoading}
                columns={planColumns}
                dataSource={plan.targets}
                pagination={plan.targets.length > 8 ? { pageSize: 8, size: 'small' } : false}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <Modal
        title={editorAsset ? `填写图片提示词 · ${displayName(editorAsset)}` : '填写图片提示词'}
        open={Boolean(editorAsset)}
        onCancel={() => setEditorAsset(null)}
        width={860}
        footer={
          <Space>
            <Button disabled={editorSaving} onClick={() => setEditorAsset(null)}>
              取消
            </Button>
            <Button type="primary" loading={editorSaving} disabled={editorLoading} onClick={() => void savePromptEditor()}>
              保存到资产
            </Button>
          </Space>
        }
      >
        <div className="space-y-3">
          <Alert
            type="info"
            showIcon
            message="这是一条不花钱的填写入口"
            description="保存后即写进该资产的提示词，生图计划会立刻把提示词来源标成「已保存提示词」——用它能当场验证第 2 步「资产准备」的保存结果真的被生图读取。留空的槽位不会覆盖原有内容；已保存的槽位会预填，可直接修改。"
          />
          <Spin spinning={editorLoading}>
            {editorSlots.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配该资产类型的提示词槽位" />
            ) : (
              editorSlots.map((slot) => (
                <div key={slot.category} className="rounded-md border border-gray-200 p-3 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Tag color="blue" className="mr-0">
                      {slot.label || slot.category}
                    </Tag>
                    <span className="text-xs text-gray-500">{slot.category}</span>
                    {slot.view_hint ? <span className="text-xs text-gray-400">{slot.view_hint}</span> : null}
                  </div>
                  <Input.TextArea
                    rows={3}
                    placeholder="例如：韩虹，35 岁女律师，齐肩黑发，深灰西装，正脸半身，纯白背景"
                    value={editorDraft[slot.category] ?? ''}
                    onChange={(e) =>
                      setEditorDraft((prev) => ({ ...prev, [slot.category]: e.target.value }))
                    }
                  />
                </div>
              ))
            )}
          </Spin>
        </div>
      </Modal>

      {/* 「查看定版图」：直接看这张定版参考图，不用再进编辑页翻槽位 */}
      <Modal
        title={previewAsset ? `定版图 · ${previewAsset.name}` : '定版图'}
        open={Boolean(previewAsset)}
        onCancel={() => setPreviewAsset(null)}
        footer={null}
        width={560}
      >
        {previewAsset?.thumbnail ? (
          <img
            src={previewAsset.thumbnail}
            alt={previewAsset.name}
            style={{ width: '100%', borderRadius: 8 }}
          />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该资产还没有参考图" />
        )}
      </Modal>
    </Card>
  )
}
