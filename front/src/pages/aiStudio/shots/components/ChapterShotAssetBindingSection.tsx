/**
 * 镜头准备页「AI 推荐关联」标签页内容。
 *
 * 职责边界：
 * - 推荐结果来自 `POST /api/v1/studio/llm/asset-binding/preview`（**只建议、不写库**）；
 * - 保存勾选项时复用既有写库端点（角色 / 场景 / 道具 / 服装四类 link 端点），
 *   不新增后端接口、不直接写库；
 * - DRY_RUN 守卫开启时后端不会真实调用大模型，此时建议仅来自确定性启发式规则，
 *   页面必须显式展示这一点，不能假装是模型判断。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Empty, Progress, Space, Table, Tag, Typography, message } from 'antd'
import type { TableColumnsType, TableProps } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { StudioShotCharacterLinksService, StudioShotLinksService } from '../../../../services/generated'
import { previewAssetBinding } from '../../../../services/llmPipelineApi'
import type { AssetBindingPreviewResult, AssetBindingShot, BindingSuggestion } from '../../../../services/llmPipelineApi'
import { defaultTaskActionErrorMessage } from '../../components/taskActionHelpers'

type ChapterShotAssetBindingSectionProps = {
  projectId: string
  chapterId: string
  shotId: string
  /** 保存成功后回读页面的准备状态（由页面传入 loadPreparationState）。 */
  onReloadPreparationState: () => Promise<unknown>
}

type UnmatchedNameRow = {
  shot_id?: string
  name?: string
  guessed_type?: string
  evidence?: string
}

type SaveFailure = {
  label: string
  reason: string
}

const SLOT_LABELS: Record<string, string> = {
  characters: '角色',
  scene: '场景',
  props: '道具',
  costumes: '服装',
}

const ASSET_TYPE_LABELS: Record<string, string> = {
  character: '角色',
  scene: '场景',
  prop: '道具',
  costume: '服装',
}

function slotLabel(slot: string): string {
  return SLOT_LABELS[slot] ?? slot
}

function assetTypeLabel(assetType: string): string {
  return ASSET_TYPE_LABELS[assetType] ?? assetType
}

/** 资产名缺失时回退显示 asset_id（启发式-only 行后端不带 asset_name）。 */
function assetLabel(row: BindingSuggestion): string {
  const name = (row.asset_name ?? '').trim()
  return name || row.asset_id
}

function suggestionKey(row: BindingSuggestion): string {
  return `${row.slot}:${row.asset_id}`
}

/** 默认勾选规则（与页面帮助文案必须保持一致）：仅「预选」且尚未绑定。 */
function isDefaultChecked(row: BindingSuggestion): boolean {
  return row.tier === 'auto' && !row.already_bound
}

function renderTierTag(tier: BindingSuggestion['tier']) {
  if (tier === 'auto') return <Tag color="green">预选</Tag>
  if (tier === 'review') return <Tag color="gold">需复核</Tag>
  return <Tag>已丢弃</Tag>
}

function renderAgreementTag(agreement: BindingSuggestion['agreement']) {
  if (agreement === 'both') return <Tag color="green">规则+模型一致</Tag>
  if (agreement === 'conflict') return <Tag color="red">与现有绑定冲突</Tag>
  if (agreement === 'heuristic_only') return <Tag color="blue">仅规则命中</Tag>
  return <Tag color="blue">仅模型命中</Tag>
}

export function ChapterShotAssetBindingSection({
  projectId,
  chapterId,
  shotId,
  onReloadPreparationState,
}: ChapterShotAssetBindingSectionProps) {
  const [preview, setPreview] = useState<AssetBindingPreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [saveProgress, setSaveProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 })
  const [saveFailures, setSaveFailures] = useState<SaveFailure[]>([])
  const previewSeqRef = useRef(0)

  // 切换镜头时清空上一镜头的推荐结果，避免把 A 镜头的建议保存到 B 镜头上。
  // 递增 seq 后，上一镜头仍在飞行的响应会被丢弃（含它的 loading 收尾），所以这里要自己复位 loading。
  useEffect(() => {
    previewSeqRef.current += 1
    setPreview(null)
    setPreviewError(null)
    setSelectedKeys([])
    setSaveFailures([])
    setSaveProgress({ done: 0, total: 0 })
    setPreviewLoading(false)
    setSaving(false)
  }, [shotId])

  const previewShot: AssetBindingShot | null = useMemo(() => {
    if (!preview) return null
    return preview.shots.find((item) => item.shot_id === shotId) ?? preview.shots[0] ?? null
  }, [preview, shotId])

  const suggestions = previewShot?.suggestions ?? []

  const warningList = useMemo(() => {
    const list = [...(preview?.parse_warnings ?? []), ...(previewShot?.warnings ?? [])]
    return Array.from(new Set(list.map((item) => String(item).trim()).filter(Boolean)))
  }, [preview, previewShot])

  const unmatchedRows = (preview?.unmatched_names ?? []) as UnmatchedNameRow[]

  const checkedRows = useMemo(
    () => suggestions.filter((row) => selectedKeys.includes(suggestionKey(row))),
    [selectedKeys, suggestions],
  )

  const runPreview = useCallback(async () => {
    if (!projectId || !shotId) return
    const seq = previewSeqRef.current + 1
    previewSeqRef.current = seq
    setPreviewLoading(true)
    setPreviewError(null)
    try {
      const data = await previewAssetBinding({
        project_id: projectId,
        shot_ids: [shotId],
        batch_size: 1,
        max_shots: 1,
      })
      if (previewSeqRef.current !== seq) return
      setPreview(data)
      const target = data.shots.find((item) => item.shot_id === shotId) ?? data.shots[0] ?? null
      setSelectedKeys((target?.suggestions ?? []).filter(isDefaultChecked).map(suggestionKey))
      if (!target) {
        message.warning('本次推荐结果里没有当前镜头的条目，请确认镜头归属后重试')
      }
    } catch (error) {
      if (previewSeqRef.current !== seq) return
      setPreview(null)
      setSelectedKeys([])
      setPreviewError(defaultTaskActionErrorMessage(error, 'AI 推荐资产关联失败'))
    } finally {
      if (previewSeqRef.current === seq) {
        setPreviewLoading(false)
      }
    }
  }, [projectId, shotId])

  /** 单个建议 → 既有写库端点（与 ChapterStudio 的调用形状保持一致）。 */
  const linkSuggestion = useCallback(
    async (row: BindingSuggestion, characterIndex: number) => {
      if (row.asset_type === 'character') {
        await StudioShotCharacterLinksService.upsertShotCharacterLinkApiV1StudioShotCharacterLinksPost({
          requestBody: { shot_id: shotId, character_id: row.asset_id, index: characterIndex, note: '' },
        })
        return
      }
      if (row.asset_type === 'scene') {
        await StudioShotLinksService.createProjectSceneLinkApiV1StudioShotLinksScenePost({
          requestBody: { project_id: projectId, chapter_id: chapterId, shot_id: shotId, asset_id: row.asset_id },
        })
        return
      }
      if (row.asset_type === 'prop') {
        await StudioShotLinksService.createProjectPropLinkApiV1StudioShotLinksPropPost({
          requestBody: { project_id: projectId, chapter_id: chapterId, shot_id: shotId, asset_id: row.asset_id },
        })
        return
      }
      if (row.asset_type === 'costume') {
        await StudioShotLinksService.createProjectCostumeLinkApiV1StudioShotLinksCostumePost({
          requestBody: { project_id: projectId, chapter_id: chapterId, shot_id: shotId, asset_id: row.asset_id },
        })
        return
      }
      throw new Error(`不支持的资产类型：${row.asset_type}`)
    },
    [chapterId, projectId, shotId],
  )

  const saveChecked = useCallback(async () => {
    if (saving) return
    if (checkedRows.length === 0) {
      message.warning('请先勾选需要保存的关联项')
      return
    }
    setSaving(true)
    setSaveFailures([])
    setSaveProgress({ done: 0, total: checkedRows.length })

    // 角色关联按 index 排序，这里从现有条数之后追加，避免挤掉已有顺序。
    let characterBaseIndex = 0
    if (checkedRows.some((row) => row.asset_type === 'character')) {
      try {
        const res = await StudioShotCharacterLinksService.listShotCharacterLinksApiV1StudioShotCharacterLinksGet({
          shotId,
        })
        characterBaseIndex = (res.data ?? []).length
      } catch {
        characterBaseIndex = 0
      }
    }

    let okCount = 0
    let characterAdded = 0
    const failures: SaveFailure[] = []
    for (const [index, row] of checkedRows.entries()) {
      try {
        await linkSuggestion(row, characterBaseIndex + characterAdded)
        if (row.asset_type === 'character') characterAdded += 1
        okCount += 1
      } catch (error) {
        // 逐条容错：单条失败不中断整批，最后统一给出明细。
        failures.push({
          label: `${slotLabel(row.slot)} · ${assetLabel(row)}`,
          reason: defaultTaskActionErrorMessage(error, '保存失败'),
        })
      }
      setSaveProgress({ done: index + 1, total: checkedRows.length })
    }

    setSaveFailures(failures)
    if (failures.length === 0) {
      message.success(`已保存 ${okCount} 条资产关联`)
    } else if (okCount > 0) {
      message.warning(`已保存 ${okCount} 条，${failures.length} 条失败，详见下方失败明细`)
    } else {
      message.error('全部保存失败，详见下方失败明细')
    }

    // 1) 回读准备状态（左侧就绪度、资产概览会同步刷新）
    try {
      await onReloadPreparationState()
    } catch {
      // 刷新失败不影响后续重算
    }
    // 2) 重新推荐，让 already_bound 反映真实绑定情况
    await runPreview()
    setSaving(false)
  }, [checkedRows, linkSuggestion, onReloadPreparationState, runPreview, saving, shotId])

  const columns: TableColumnsType<BindingSuggestion> = [
    {
      title: '槽位',
      dataIndex: 'slot',
      width: 76,
      render: (slot: string) => <Tag>{slotLabel(slot)}</Tag>,
    },
    {
      title: '资产',
      key: 'asset',
      ellipsis: true,
      render: (_: unknown, row: BindingSuggestion) => (
        <div className="min-w-0">
          <div className="truncate">{assetLabel(row)}</div>
          {row.asset_name?.trim() ? (
            <div className="truncate text-[11px] text-slate-400">{row.asset_id}</div>
          ) : null}
        </div>
      ),
    },
    {
      title: '层级',
      dataIndex: 'tier',
      width: 92,
      render: (tier: BindingSuggestion['tier']) => renderTierTag(tier),
    },
    {
      title: '对账',
      dataIndex: 'agreement',
      width: 120,
      render: (agreement: BindingSuggestion['agreement']) => renderAgreementTag(agreement),
    },
    {
      title: '置信度',
      dataIndex: 'confidence',
      width: 84,
      render: (confidence: number) => (typeof confidence === 'number' ? confidence.toFixed(2) : '—'),
    },
    {
      title: '已绑定',
      dataIndex: 'already_bound',
      width: 84,
      render: (alreadyBound: boolean) =>
        alreadyBound ? <Tag color="blue">已绑定</Tag> : <span className="text-slate-400">未绑定</span>,
    },
    {
      title: '理由',
      dataIndex: 'reason',
      render: (reason: string) => <span className="text-xs text-slate-600">{reason?.trim() ? reason : '—'}</span>,
    },
  ]

  const rowSelection: TableProps<BindingSuggestion>['rowSelection'] = {
    selectedRowKeys: selectedKeys,
    onChange: (keys) => setSelectedKeys(keys.map((key) => String(key))),
    getCheckboxProps: () => ({ disabled: saving }),
  }

  const meta = preview?.meta ?? null
  const tierSummary = preview?.tier_summary ?? {}
  const progressPercent =
    saveProgress.total > 0 ? Math.round((saveProgress.done / saveProgress.total) * 100) : 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-slate-900">AI 推荐资产关联</div>
          <Typography.Text type="secondary" className="text-[11px]">
            先让系统给出「角色 / 场景 / 道具 / 服装」四类槽位的关联建议，人工勾选后再写入关联关系。
            推荐接口只读不写库，保存时才会调用既有写入接口。
          </Typography.Text>
        </div>
        <Space size={8}>
          <Button
            type="primary"
            size="small"
            loading={previewLoading}
            disabled={saving}
            onClick={() => void runPreview()}
          >
            AI 推荐资产关联
          </Button>
          <Button
            size="small"
            type="primary"
            ghost
            loading={saving}
            disabled={previewLoading || checkedRows.length === 0}
            onClick={() => void saveChecked()}
          >
            {`确认并保存勾选项${checkedRows.length > 0 ? `（${checkedRows.length}）` : ''}`}
          </Button>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            disabled={previewLoading || saving || !preview}
            onClick={() => void runPreview()}
          >
            重新推荐
          </Button>
        </Space>
      </div>

      {previewError ? (
        <Alert
          type="error"
          showIcon
          message="推荐失败"
          description={
            <div className="space-y-1">
              <div>{previewError}</div>
              <div className="text-[11px] text-slate-500">
                若提示项目内没有可绑定资产，请先在资产库创建角色 / 场景 / 道具 / 服装。
              </div>
            </div>
          }
        />
      ) : null}

      {meta?.dry_run ? (
        <Alert
          type="warning"
          showIcon
          message="当前处于 DRY_RUN 守卫状态：本次没有真实调用大模型"
          description={
            <div className="space-y-1">
              <div>
                {meta.dry_run_reason || 'JELLYFISH_DRY_RUN 未关闭或缺少真实付费确认。'}
                下方建议来自确定性启发式规则的占位结果，不是模型判断，请谨慎勾选。
              </div>
              <div className="text-[11px] text-slate-500">
                {`llm_called=${String(meta.llm_called)}；目标模型=${meta.target?.model_name ?? '未解析'}`}
              </div>
            </div>
          }
        />
      ) : null}

      {warningList.length > 0 ? (
        <Alert
          type="info"
          showIcon
          message="后端提示"
          description={
            <ul className="list-disc pl-4 space-y-0.5 text-xs">
              {warningList.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          }
        />
      ) : null}

      {saveFailures.length > 0 ? (
        <Alert
          type="error"
          showIcon
          message={`${saveFailures.length} 条关联保存失败（其余已保存成功）`}
          description={
            <ul className="list-disc pl-4 space-y-0.5 text-xs">
              {saveFailures.map((item) => (
                <li key={`${item.label}-${item.reason}`}>
                  {`${item.label}：${item.reason}`}
                </li>
              ))}
            </ul>
          }
        />
      ) : null}

      {saving ? (
        <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
          <Progress percent={progressPercent} size="small" status="active" />
          <div className="text-[11px] text-slate-500">
            {`正在逐条保存：${saveProgress.done}/${saveProgress.total}（串行调用写入接口，请勿关闭页面）`}
          </div>
        </div>
      ) : null}

      {preview ? (
        <div className="space-y-3">
          <Space size={[6, 6]} wrap>
            <Tag>{`候选资产数 ${preview.catalog.length}`}</Tag>
            <Tag>{`批次 ${preview.batch_count}`}</Tag>
            <Tag>{`本次建议 ${suggestions.length}`}</Tag>
            <Tag color="green">{`预选 ${tierSummary.auto ?? 0}`}</Tag>
            <Tag color="gold">{`需复核 ${tierSummary.review ?? 0}`}</Tag>
            <Tag>{`已丢弃 ${tierSummary.discard ?? 0}`}</Tag>
          </Space>
          {preview.cost_note ? (
            <div className="text-[11px] text-slate-500">{preview.cost_note}</div>
          ) : null}

          <Alert
            type="info"
            showIcon
            message="默认勾选规则"
            description={
              <div className="text-xs">
                {'只自动勾选「层级 = 预选（auto）」且「已绑定 = 否」的候选；'}
                「需复核」「已丢弃」以及已经绑定过的候选一律默认不勾选，需要你人工判断后再勾。
                勾选后点击「确认并保存勾选项」才会真正写入关联。
              </div>
            }
          />

          <Table<BindingSuggestion>
            size="small"
            rowKey={suggestionKey}
            rowSelection={rowSelection}
            columns={columns}
            dataSource={suggestions}
            pagination={false}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前镜头没有推荐条目" /> }}
          />

          <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
            <div className="text-xs font-medium text-slate-800">
              {`模型看到但候选清单里没有的实体（${unmatchedRows.length}）`}
            </div>
            <div className="mt-1 text-[11px] text-slate-500">
              这些名称只做只读展示，系统不会自动创建资产；如需使用请先到资产库手动创建，再回来重新推荐。
            </div>
            {unmatchedRows.length === 0 ? (
              <div className="mt-2 text-[11px] text-slate-400">无</div>
            ) : (
              <ul className="mt-2 space-y-1 text-xs text-slate-700">
                {unmatchedRows.map((item, index) => (
                  <li key={`${item.name ?? 'unknown'}-${index}`} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{item.name?.trim() ? item.name : '未命名'}</span>
                    {item.guessed_type ? <Tag>{assetTypeLabel(item.guessed_type)}</Tag> : null}
                    {item.evidence ? (
                      <span className="text-[11px] text-slate-500">{`依据：${item.evidence}`}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : !previewLoading && !previewError ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有推荐结果，点击「AI 推荐资产关联」开始"
        />
      ) : null}
    </div>
  )
}
