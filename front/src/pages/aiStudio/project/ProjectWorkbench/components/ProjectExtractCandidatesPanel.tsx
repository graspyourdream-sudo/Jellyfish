/**
 * 第 2 步「提取资产」的就地工作面板。
 *
 * 本轮要解决的问题：第 2 步以前只有只读统计 + 「刷新候选」，用户看不到任何可执行动作，
 * 也不知道「大模型提取」到底接没接通。现在这里提供：
 *   1. 点击前的状态条：模型是否配置、是否被 DRY_RUN 演练门禁阻止（复用 GenerationGateBanner）；
 *   2. 「开始提取 / 重新提取」：调**已有的**同步提取接口（`POST /script-processing/extract`），
 *      不新建任何提取后端；
 *   3. 提取结果的**候选预览**（角色 / 场景 / 道具 / 服装，按名称聚合），
 *      再由用户**确认写入**：复用既有「存在性检测 + 就地新建实体 + 关联镜头候选」三件套；
 *   4. 确认/忽略都写回候选状态，步骤判定（resolveProjectStep）随之推进。
 *
 * 提取规则与 Prompt 的完整配置属于第二部分，本部分只把现有能力接进主流程。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Empty, Space, Spin, Table, Tag, Tooltip, Typography, message } from 'antd'
import type { TableColumnsType } from 'antd'
import { CheckCircleOutlined, ReloadOutlined, StopOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { useParams } from 'react-router-dom'
import { ScriptProcessingService, StudioEntitiesService, StudioShotsService } from '../../../../../services/generated'
import type { EntityNameExistenceItem, ShotExtractedCandidateRead } from '../../../../../services/generated'
import type { AnyRecord } from '../../../../../services/llmPipelineApi'
import {
  classifyGenerationFailure,
  failureText,
  useGenerationGate,
  type GenerationFailure,
} from '../../../components/generationGate'
import { GenerationGateBanner } from '../../../components/GenerationGateBanner'
import { StudioEntitiesApi } from '../../../../../services/studioEntities'

type ProjectExtractPanelProps = {
  projectId: string | null
  chapterId: string | null
  chapterLabel: string | null
  /** 确认/忽略/提取之后重算六步信号（摘要条与资产表要跟着变） */
  onReload?: () => void
}

type AssetKind = 'character' | 'scene' | 'prop' | 'costume'

type ExtractGroup = {
  key: string
  kind: AssetKind
  name: string
  typeLabel: string
  candidateIds: number[]
  shotIds: string[]
  statuses: Record<string, number>
  linkedEntityId: string | null
}

const KIND_META: Record<AssetKind, { label: string; color: string }> = {
  character: { label: '角色', color: 'purple' },
  scene: { label: '场景', color: 'blue' },
  prop: { label: '道具', color: 'gold' },
  costume: { label: '服装', color: 'cyan' },
}

const STATUS_META: Record<string, { label: string; color: string }> = {
  pending: { label: '待确认', color: 'gold' },
  linked: { label: '已写入', color: 'green' },
  ignored: { label: '已忽略', color: 'default' },
}

const EXTRACT_LOADING_KEY = 'project-extract-loading'

function isAssetKind(value: string): value is AssetKind {
  return value === 'character' || value === 'scene' || value === 'prop' || value === 'costume'
}

export function ProjectExtractCandidatesPanel({
  projectId,
  chapterId,
  chapterLabel,
  onReload,
}: ProjectExtractPanelProps) {
  const params = useParams<{ projectId?: string }>()
  const effectiveProjectId = projectId ?? params.projectId ?? null

  const gate = useGenerationGate()
  const [rows, setRows] = useState<ShotExtractedCandidateRead[]>([])
  const [shotCount, setShotCount] = useState(0)
  const [existence, setExistence] = useState<Record<string, EntityNameExistenceItem>>({})
  const [loading, setLoading] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [busyKeys, setBusyKeys] = useState<Record<string, boolean>>({})
  const [failure, setFailure] = useState<GenerationFailure | null>(null)
  const [loadError, setLoadError] = useState('')

  /** 拉取本集全部镜头 + 每个镜头的提取候选，按「类型:名称」聚合。 */
  const load = useCallback(async () => {
    if (!chapterId) {
      setRows([])
      setShotCount(0)
      return
    }
    setLoading(true)
    setLoadError('')
    try {
      const shotsRes = await StudioShotsService.listShotsApiV1StudioShotsGet({
        chapterId,
        page: 1,
        pageSize: 100,
        order: 'index',
        isDesc: false,
      })
      const shots = shotsRes.data?.items ?? []
      setShotCount(shots.length)
      const candidateLists = await Promise.all(
        shots.map((shot) =>
          StudioShotsService.getShotExtractedCandidatesApiV1StudioShotsShotIdExtractedCandidatesGet({
            shotId: shot.id,
          })
            .then((res) => (res.data ?? []) as ShotExtractedCandidateRead[])
            .catch(() => [] as ShotExtractedCandidateRead[]),
        ),
      )
      setRows(candidateLists.flat())
    } catch (error) {
      setLoadError((error as Error)?.message || '提取候选加载失败')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [chapterId])

  useEffect(() => {
    void load()
  }, [load])

  const groups = useMemo<ExtractGroup[]>(() => {
    const map = new Map<string, ExtractGroup>()
    rows.forEach((row) => {
      const kind = String(row.candidate_type)
      if (!isAssetKind(kind)) return
      const name = String(row.candidate_name ?? '').trim()
      if (!name) return
      const key = `${kind}:${name}`
      const existing = map.get(key)
      const status = String(row.candidate_status ?? 'pending')
      if (existing) {
        existing.candidateIds.push(row.id)
        if (!existing.shotIds.includes(row.shot_id)) existing.shotIds.push(row.shot_id)
        existing.statuses[status] = (existing.statuses[status] ?? 0) + 1
        existing.linkedEntityId = existing.linkedEntityId ?? row.linked_entity_id ?? null
        return
      }
      map.set(key, {
        key,
        kind,
        name,
        typeLabel: KIND_META[kind].label,
        candidateIds: [row.id],
        shotIds: [row.shot_id],
        statuses: { [status]: 1 },
        linkedEntityId: row.linked_entity_id ?? null,
      })
    })
    return Array.from(map.values()).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
  }, [rows])

  /** 对账：项目里 / 资产库里有没有同名资产，决定「确认写入」是关联还是新建。 */
  const refreshExistence = useCallback(
    async (targets: ExtractGroup[]) => {
      if (!effectiveProjectId || targets.length === 0) return
      const byKind: Record<AssetKind, string[]> = { character: [], scene: [], prop: [], costume: [] }
      targets.forEach((group) => {
        if (group.statuses.linked) return
        byKind[group.kind].push(group.name)
      })
      const body: AnyRecord = { project_id: effectiveProjectId }
      if (byKind.character.length) body.character_names = byKind.character
      if (byKind.scene.length) body.scene_names = byKind.scene
      if (byKind.prop.length) body.prop_names = byKind.prop
      if (byKind.costume.length) body.costume_names = byKind.costume
      if (
        !byKind.character.length &&
        !byKind.scene.length &&
        !byKind.prop.length &&
        !byKind.costume.length
      ) {
        return
      }
      try {
        const res = await StudioEntitiesService.checkEntityNamesExistenceApiV1StudioEntitiesExistenceCheckPost({
          requestBody: body as never,
        })
        const data = res.data
        const next: Record<string, EntityNameExistenceItem> = {}
        const buckets: [AssetKind, EntityNameExistenceItem[] | undefined][] = [
          ['character', data?.characters],
          ['scene', data?.scenes],
          ['prop', data?.props],
          ['costume', data?.costumes],
        ]
        buckets.forEach(([kind, list]) => {
          ;(list ?? []).forEach((item) => {
            const name = String(item?.name ?? '').trim()
            if (name) next[`${kind}:${name}`] = item
          })
        })
        setExistence(next)
      } catch (error) {
        setFailure(classifyGenerationFailure(error, 'llm'))
      }
    },
    [effectiveProjectId],
  )

  useEffect(() => {
    void refreshExistence(groups)
  }, [groups, refreshExistence])

  /** 是否已经真跑过提取（有候选即视为跑过）。 */
  const hasExtracted = rows.length > 0
  const pendingGroups = groups.filter((group) => (group.statuses.pending ?? 0) > 0)
  const summary = useMemo(() => {
    const byStatus: Record<string, number> = {}
    rows.forEach((row) => {
      const status = String(row.candidate_status ?? 'pending')
      byStatus[status] = (byStatus[status] ?? 0) + 1
    })
    return byStatus
  }, [rows])

  /** 开始提取 / 重新提取：复用已有同步提取接口（写回 shot_extracted_candidates）。 */
  const runExtract = useCallback(async () => {
    if (!effectiveProjectId || !chapterId) return
    setFailure(null)
    setExtracting(true)
    message.loading({ content: '正在同步提取（本进程内跑完，通常需要数十秒）…', key: EXTRACT_LOADING_KEY, duration: 0 })
    try {
      const shotsRes = await StudioShotsService.listShotsApiV1StudioShotsGet({
        chapterId,
        page: 1,
        pageSize: 100,
        order: 'index',
        isDesc: false,
      })
      const shots = shotsRes.data?.items ?? []
      if (shots.length === 0) {
        message.destroy(EXTRACT_LOADING_KEY)
        message.warning('本集还没有分镜，请先在第 1 步提取分镜')
        return
      }
      const scriptDivision = {
        total_shots: shots.length,
        shots: shots.map((shot) => ({
          index: shot.index,
          start_line: 1,
          end_line: 1,
          script_excerpt: shot.script_excerpt ?? '',
          shot_name: shot.title ?? '',
        })),
      }
      await ScriptProcessingService.extractScriptApiV1ScriptProcessingExtractPost({
        requestBody: {
          project_id: effectiveProjectId,
          chapter_id: chapterId,
          script_division: scriptDivision as never,
          consistency: undefined,
          refresh_cache: true,
        } as never,
      })
      message.destroy(EXTRACT_LOADING_KEY)
      message.success('提取完成，候选已刷新；请在下方确认后再写入项目资产')
      await load()
      onReload?.()
    } catch (error) {
      message.destroy(EXTRACT_LOADING_KEY)
      const classified = classifyGenerationFailure(error, 'llm')
      setFailure(classified)
      message.error(failureText(classified))
    } finally {
      setExtracting(false)
    }
  }, [chapterId, effectiveProjectId, load, onReload])

  /** 确认写入：先保证实体在项目里（关联已有 / 就地新建），再把候选项标为已关联。 */
  const confirmGroup = useCallback(
    async (group: ExtractGroup) => {
      if (!effectiveProjectId || !chapterId) return
      if (busyKeys[group.key]) return
      setBusyKeys((prev) => ({ ...prev, [group.key]: true }))
      setFailure(null)
      try {
        const item = existence[group.key]
        let linkedEntityId = item?.asset_id ?? group.linkedEntityId ?? ''

        if (item?.exists && item.asset_id && item.linked_to_project) {
          linkedEntityId = item.asset_id
        } else if (item?.exists && item.asset_id && !item.linked_to_project) {
          // 资产库里有同名资产但没进本项目：复用「关联已有资产」端点，把它挂到项目/章节/镜头。
          await Promise.all(
            group.shotIds.map((shotId) =>
              StudioShotsService.linkExistingAssetForPreparationApiApiV1StudioShotsShotIdPreparationLinkPost({
                shotId,
                requestBody: {
                  project_id: effectiveProjectId,
                  chapter_id: chapterId,
                  entity_type: group.kind,
                  linked_entity_id: item.asset_id as string,
                } as never,
              }),
            ),
          )
          linkedEntityId = item.asset_id
        } else {
          // 项目里没有：就地新建（带上 project/chapter 会自动建立关联）。
          const created = await StudioEntitiesApi.create(group.kind, {
            id: `asset_${Date.now()}`,
            name: group.name,
            description: '',
            tags: [],
            thumbnail: '',
            project_id: effectiveProjectId,
            chapter_id: chapterId,
          })
          linkedEntityId = String((created.data as { id?: string } | undefined)?.id ?? '')
          if (!linkedEntityId) throw new Error('新建资产失败：接口没有返回 id')
        }

        // 候选项逐条确认：这是既有端点，会同时把镜头状态重算为 ready。
        await Promise.all(
          group.candidateIds.map((candidateId) =>
            StudioShotsService.linkExtractedCandidateApiV1StudioShotsExtractedCandidatesCandidateIdLinkPatch({
              candidateId,
              requestBody: { linked_entity_id: linkedEntityId },
            }),
          ),
        )
        message.success(`已写入「${group.name}」（${KIND_META[group.kind].label}）`)
        await load()
        onReload?.()
      } catch (error) {
        const classified = classifyGenerationFailure(error, 'llm')
        setFailure(classified)
        message.error(failureText(classified))
      } finally {
        setBusyKeys((prev) => ({ ...prev, [group.key]: false }))
      }
    },
    [busyKeys, chapterId, effectiveProjectId, existence, load, onReload]
  )

  const ignoreGroup = useCallback(
    async (group: ExtractGroup) => {
      if (busyKeys[group.key]) return
      setBusyKeys((prev) => ({ ...prev, [group.key]: true }))
      setFailure(null)
      try {
        await Promise.all(
          group.candidateIds.map((candidateId) =>
            StudioShotsService.ignoreExtractedCandidateApiV1StudioShotsExtractedCandidatesCandidateIdIgnorePatch({
              candidateId,
            }),
          ),
        )
        message.success(`已忽略「${group.name}」`)
        await load()
        onReload?.()
      } catch (error) {
        const classified = classifyGenerationFailure(error, 'llm')
        setFailure(classified)
        message.error(failureText(classified))
      } finally {
        setBusyKeys((prev) => ({ ...prev, [group.key]: false }))
      }
    },
    [busyKeys, load, onReload]
  )

  const columns: TableColumnsType<ExtractGroup> = [
    {
      title: '候选',
      key: 'name',
      render: (_: unknown, group) => (
        <Space size={6} wrap>
          <Tag color={KIND_META[group.kind].color} className="mr-0">
            {KIND_META[group.kind].label}
          </Tag>
          <span className="truncate font-medium" title={group.name}>
            {group.name}
          </span>
        </Space>
      ),
    },
    {
      title: '出现镜头',
      key: 'shots',
      width: 96,
      render: (_: unknown, group) => <Tag bordered={false}>{`${group.shotIds.length} 镜`}</Tag>,
    },
    {
      title: '对账结果',
      key: 'existence',
      width: 190,
      render: (_: unknown, group) => {
        const item = existence[group.key]
        if (!item) return <Tag bordered={false}>检查中…</Tag>
        if (item.exists && item.linked_to_project) return <Tag color="green" bordered={false}>项目内已有同名资产</Tag>
        if (item.exists) return <Tag color="blue" bordered={false}>资产库已有，可关联</Tag>
        return <Tag color="gold" bordered={false}>尚无同名资产（将新建）</Tag>
      },
    },
    {
      title: '候选状态',
      key: 'status',
      width: 150,
      render: (_: unknown, group) => (
        <Space size={4} wrap>
          {Object.entries(group.statuses).map(([status, count]) => (
            <Tag key={status} color={STATUS_META[status]?.color ?? 'default'} bordered={false}>
              {`${STATUS_META[status]?.label ?? status} ${count}`}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 180,
      render: (_: unknown, group) => (
        <Space size={4}>
          <Button
            size="small"
            type="primary"
            loading={busyKeys[group.key]}
            disabled={(group.statuses.linked ?? 0) === group.candidateIds.length}
            onClick={() => void confirmGroup(group)}
          >
            确认写入
          </Button>
          <Tooltip title="这些候选不是资产，忽略后不再阻塞本步">
            <Button
              size="small"
              type="text"
              danger
              icon={<StopOutlined />}
              disabled={(group.statuses.pending ?? 0) === 0}
              onClick={() => void ignoreGroup(group)}
            />
          </Tooltip>
        </Space>
      ),
    },
  ]

  if (!chapterId) {
    return (
      <Card size="small" className="mb-2">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<span className="text-xs text-gray-500">请先选择一集，再进行资产提取</span>}
        />
      </Card>
    )
  }

  return (
    <Card
      size="small"
      className="mb-2"
      styles={{ body: { paddingTop: 10, paddingBottom: 10 } }}
      title={
        <Space size={8} wrap>
          <span className="text-sm font-medium">第 2 步 · 提取资产</span>
          <Tag bordered={false}>{`本集 ${shotCount} 镜`}</Tag>
          {rows.length > 0 ? (
            <Tag color="blue" bordered={false}>{`候选 ${rows.length} 条`}</Tag>
          ) : null}
          {rows.length > 0 ? (
            <Tag bordered={false}>{`聚合 ${groups.length} 组`}</Tag>
          ) : null}
          {(summary.pending ?? 0) > 0 ? (
            <Tag color="gold" bordered={false}>{`待确认 ${summary.pending}`}</Tag>
          ) : rows.length > 0 ? (
            <Tag color="green" bordered={false}>{`已处理 ${rows.length - (summary.pending ?? 0)}`}</Tag>
          ) : null}
        </Space>
      }
      extra={
        <Space size={6}>
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            刷新候选
          </Button>
          <Button
            size="small"
            type="primary"
            icon={<ThunderboltOutlined />}
            loading={extracting}
            disabled={shotCount === 0}
            onClick={() => void runExtract()}
          >
            {hasExtracted ? '重新提取' : '开始提取'}
          </Button>
        </Space>
      }
    >
      {/* 点击前就把「模型 + 门禁」状态摆出来：被 DRY_RUN 拦住不等于接口没接通。 */}
      <GenerationGateBanner gate={gate} outlet="llm" failure={failure} running={extracting} runningText="正在同步提取…" />

      {loadError ? (
        <Alert type="error" showIcon message="候选加载失败" description={loadError} style={{ marginBottom: 8 }} />
      ) : null}

      {shotCount === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<span className="text-xs text-gray-500">本集还没有分镜，请先在第 1 步提取分镜</span>}
        />
      ) : rows.length === 0 && !loading ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span className="text-xs text-gray-500">
              {chapterLabel ?? '本集'} 还没有提取候选：点右上角「开始提取」按剧本提取角色 / 场景 / 道具。
              {gate.dryRun ? '（演练门禁开着时不会真实调用大模型）' : ''}
            </span>
          }
        />
      ) : loading && rows.length === 0 ? (
        <div className="py-6 text-center">
          <Spin />
          <div className="mt-2 text-xs text-gray-500">正在读取提取候选…</div>
        </div>
      ) : (
        <>
          <Typography.Text type="secondary" className="text-[11px]">
            「确认写入」= 关联已有资产或就地新建，并把这批候选项标为已写入；确认后本步才算完成。
          </Typography.Text>
          <Table<ExtractGroup>
            className="mt-2"
            rowKey="key"
            size="small"
            loading={loading}
            columns={columns}
            dataSource={groups}
            pagination={{ pageSize: 8, size: 'small' }}
          />
          {pendingGroups.length > 0 ? (
            <div className="mt-2 text-[11px] text-gray-500">
              {`还有 ${pendingGroups.length} 组候选未确认。`}
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-1 text-[11px] text-emerald-600">
              <CheckCircleOutlined />
              本集候选已全部处理，可以继续下一步「图片准备」。
            </div>
          )}
        </>
      )}
    </Card>
  )
}

export default ProjectExtractCandidatesPanel
