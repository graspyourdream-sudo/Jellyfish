/**
 * 集级视频提示词生产页面（项目工作台第 4 步；**进入分镜工作台之前**的主入口）。
 *
 * 用户要求（2026-09-19）：一整集的视频提示词要在**集级页面**里一次做完 ——
 * 批量生成（大模型，逐镜排队、可停止）或批量导入（巨日禄 Cookie 为主入口、粘贴/上传为辅），
 * 两者都进入**同一张整集预览确认表**，用户逐条校对、调整匹配、删改后统一确认保存；
 * 未确认前**一个字节都不写正式提示词**。
 *
 * 关键设计（都有对应的后端约束兜住）：
 * - 逐镜队列：一次只请求一镜（`/prompt-board/{cid}/draft`），点「停止」就不再发下一镜，
 *   已完成草稿保留，失败项可单独重试 —— 不做异步任务系统。
 * - 来源由流程决定：大模型草稿=llm（必须带服务端 HMAC 签名令牌）、巨日禄=jurilu、
 *   其它外部导入=external_import、工作台人工修改=manual；本页只按流程分组，不自由指定 source。
 * - 演练草稿（`status=dry_run`）在表里明确标注且**不可保存**。
 * - 数量不一致 / 编号重复 / 无法匹配 → 默认阻止保存，必须显式打开「仅保存已匹配项」。
 * - 页面上**不显示"已确认数量"**（系统当前没有可靠的确认状态）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Drawer,
  Empty,
  Input,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
} from 'antd'
import { ImportOutlined, ReloadOutlined, StopOutlined, ThunderboltOutlined } from '@ant-design/icons'
import {
  draftVideoPrompt,
  fetchPromptBoard,
  parsePromptImport,
  previewJuriluImport,
  savePromptBoard,
  type PromptBoardMode,
  type PromptBoardOrigin,
  type PromptBoardShot,
} from '../../../../../services/llmPipelineApi'
import { StudioShotsService } from '../../../../../services/generated'
import { classifyGenerationFailure, failureText } from '../../../components/generationGate'

type RowStatus = 'ok' | 'draft' | 'dry_run' | 'failed' | 'skipped' | 'unmatched' | 'duplicate'

type PreviewRow = {
  key: string
  shotId: string
  code: string
  /** 镜头内容（标题 + 剧本摘录），供人工核对 */
  shotText: string
  prompt: string
  origin: PromptBoardOrigin
  /** 匹配方式：number（编号）/ order（顺序）/ manual（人工调整）/ cookie（巨日禄编号） */
  matchBy: string
  status: RowStatus
  message: string
  draftToken?: string
  /** 用户是否改过草稿正文（改过就不再算大模型原样草稿） */
  edited: boolean
  include: boolean
  regenerating?: boolean
}

const ORIGIN_META: Record<PromptBoardOrigin, { label: string; color: string }> = {
  llm_draft: { label: '大模型生成', color: 'blue' },
  jurilu_import: { label: '巨日禄导入', color: 'purple' },
  external_import: { label: '外部导入', color: 'geekblue' },
  manual: { label: '人工修改', color: 'default' },
}

const STATUS_META: Record<RowStatus, { label: string; color: string }> = {
  ok: { label: '匹配正常', color: 'green' },
  draft: { label: '草稿（未保存）', color: 'blue' },
  dry_run: { label: '演练草稿（不可保存）', color: 'gold' },
  failed: { label: '失败', color: 'red' },
  skipped: { label: '已跳过', color: 'default' },
  unmatched: { label: '无法匹配', color: 'red' },
  duplicate: { label: '编号重复', color: 'red' },
}

type EpisodeVideoPromptBoardProps = {
  projectId: string
  chapterId: string | null
  chapterLabel: string
  /** 进入分镜工作台（集级确认保存后再去逐镜绑定/生成） */
  onEnterStudio?: () => void
  /** 保存后继续第 2 步「资产准备」 */
  onContinueAssets?: () => void
  /** 已有资产，直接去第 4 步「资产与声音绑定」 */
  onGoBinding?: () => void
}

export function EpisodeVideoPromptBoard({
  projectId,
  chapterId,
  chapterLabel,
  onEnterStudio,
  onContinueAssets,
  onGoBinding,
}: EpisodeVideoPromptBoardProps) {
  const [shots, setShots] = useState<PromptBoardShot[]>([])
  const [rows, setRows] = useState<PreviewRow[]>([])
  const [loading, setLoading] = useState(false)
  const [creatingShots, setCreatingShots] = useState(false)
  /** 建镜的在途闸门：状态更新是异步的，靠 state 挡不住连点 */
  const createShotsInFlightRef = useRef(false)
  const [mode, setMode] = useState<PromptBoardMode>('fill_empty')
  const [selectedShotIds, setSelectedShotIds] = useState<string[]>([])
  const [allowPartial, setAllowPartial] = useState(false)
  const [issues, setIssues] = useState<string[]>([])
  const [countMismatch, setCountMismatch] = useState(false)
  const [running, setRunning] = useState(false)
  const [saving, setSaving] = useState(false)
  const stopRef = useRef(false)

  // 导入抽屉（巨日禄 Cookie 主入口 + 其它外部平台粘贴/上传）
  const [importOpen, setImportOpen] = useState(false)
  const [importTab, setImportTab] = useState<'jurilu' | 'other'>('jurilu')
  const [juriluUrl, setJuriluUrl] = useState('')
  const [juriluCookie, setJuriluCookie] = useState('')
  const [juriluAuthorization, setJuriluAuthorization] = useState('')
  const [juriluAuthMode, setJuriluAuthMode] = useState('auto')
  const [juriluReferer, setJuriluReferer] = useState('')

  /** Cookie / Authorization 只在本次抓取内存里存活：抓取结束、关抽屉、取消、离开页面立即清空。 */
  const clearJuriluCredentials = useCallback(() => {
    setJuriluCookie('')
    setJuriluAuthorization('')
    setJuriluReferer('')
  }, [])
  const [juriluFetching, setJuriluFetching] = useState(false)
  const [otherText, setOtherText] = useState('')
  const [parsing, setParsing] = useState(false)

  const shotById = useMemo(() => new Map(shots.map((shot) => [shot.shot_id, shot])), [shots])

  const loadBoard = useCallback(async () => {
    if (!chapterId) return
    setLoading(true)
    try {
      const data = await fetchPromptBoard(chapterId)
      setShots(data.shots ?? [])
      setSelectedShotIds((data.shots ?? []).map((shot) => shot.shot_id))
    } catch (error) {
      message.error(error instanceof Error ? error.message : '读取本集镜头失败')
    } finally {
      setLoading(false)
    }
  }, [chapterId])

  useEffect(() => {
    void loadBoard()
  }, [loadBoard])

  // 离开页面（含切换步骤/关闭标签）时清空敏感输入
  useEffect(() => () => clearJuriluCredentials(), [clearJuriluCredentials])

  /** 整表唯一性：被勾选的行里，同一个镜头只能被一条记录占用。 */
  const findConflictingRow = useCallback(
    (shotId: string, ignoreKey: string): PreviewRow | null =>
      rows.find((row) => row.key !== ignoreKey && row.include && row.shotId && row.shotId === shotId) ?? null,
    [rows],
  )

  /** 保存前的整表唯一性校验（**在按来源分组之前**做，避免不同来源先后写同一镜头）。 */
  const validateTableUnique = useCallback(
    (candidateRows: PreviewRow[]): string | null => {
      const seen = new Map<string, string>()
      for (const row of candidateRows) {
        if (!row.include || !row.prompt.trim() || !row.shotId) continue
        const code = row.code || row.shotId
        const other = seen.get(row.shotId)
        if (other) return `镜头 ${code} 被两条记录指向（${other} 与 ${row.origin}）：请先删掉或改开其中一条。`
        seen.set(row.shotId, row.origin)
      }
      return null
    },
    [],
  )

  const updateRow = useCallback((key: string, patch: Partial<PreviewRow>) => {
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }, [])

  const toRow = useCallback(
    (input: {
      shotId: string
      prompt: string
      origin: PromptBoardOrigin
      matchBy: string
      status: RowStatus
      message?: string
      draftToken?: string
      edited?: boolean
    }): PreviewRow => {
      const shot = shotById.get(input.shotId)
      return {
        key: `${input.origin}:${input.shotId}:${Math.random().toString(36).slice(2, 8)}`,
        shotId: input.shotId,
        code: shot?.code ?? '',
        shotText: shot ? `${shot.title}${shot.script_excerpt ? `｜${shot.script_excerpt.slice(0, 40)}` : ''}` : '（未匹配）',
        prompt: input.prompt,
        origin: input.origin,
        matchBy: input.matchBy,
        status: input.status,
        message: input.message ?? '',
        draftToken: input.draftToken,
        edited: Boolean(input.edited),
        include: input.status !== 'unmatched' && input.status !== 'duplicate' && input.status !== 'dry_run',
      }
    },
    [shotById],
  )

  /** 逐镜队列：一次只请求一镜；停止后不再发下一镜，已完成草稿保留。 */
  const runGenerate = useCallback(
    async (targetShotIds: string[]) => {
      if (!chapterId || !targetShotIds.length) return
      stopRef.current = false
      setRunning(true)
      for (const shotId of targetShotIds) {
        if (stopRef.current) {
          message.info('已停止：后续镜头不再请求，已完成草稿保留在表里')
          break
        }
        const shot = shotById.get(shotId)
        const pendingRow = toRow({
          shotId,
          prompt: '',
          origin: 'llm_draft',
          matchBy: 'generate',
          status: 'skipped',
          message: '生成中…',
        })
        setRows((prev) => [...prev.filter((row) => row.shotId !== shotId || row.origin !== 'llm_draft'), pendingRow])
        try {
          // 一次一镜：请求之间就是用户可中断的边界
          // eslint-disable-next-line no-await-in-loop
          const result = await draftVideoPrompt(chapterId, { shot_id: shotId, mode })
          const status: RowStatus =
            result.status === 'draft'
              ? 'draft'
              : result.status === 'dry_run'
                ? 'dry_run'
                : result.status === 'skipped'
                  ? 'skipped'
                  : 'failed'
          setRows((prev) => [
            ...prev.filter((row) => row.key !== pendingRow.key),
            toRow({
              shotId,
              prompt: String(result.prompt ?? ''),
              origin: 'llm_draft',
              matchBy: 'generate',
              status,
              message: result.reason ?? '',
              draftToken: result.draft_token,
            }),
          ])
        } catch (error) {
          setRows((prev) => [
            ...prev.filter((row) => row.key !== pendingRow.key),
            toRow({
              shotId,
              prompt: '',
              origin: 'llm_draft',
              matchBy: 'generate',
              status: 'failed',
              message: error instanceof Error ? error.message : '生成失败',
            }),
          ])
        }
        void shot
      }
      setRunning(false)
    },
    [chapterId, mode, shotById, toRow],
  )

  const generateTargets = useMemo(() => {
    if (mode === 'overwrite_selected') return selectedShotIds
    return selectedShotIds.filter((shotId) => !(shotById.get(shotId)?.has_prompt ?? false))
  }, [mode, selectedShotIds, shotById])

  /**
   * 对某一行"重新生成"：**替换这一行**（key 不变），来源变为 `llm_draft`。
   *
   * 注意不是"再插一行"：导入来的行被重新生成后，原行就代表这份新草稿，
   * 否则同一镜头会出现两条记录（预览表整体唯一性也会立刻被破坏）。
   */
  const regenerateRow = useCallback(
    async (row: PreviewRow) => {
      if (!chapterId || !row.shotId) return
      updateRow(row.key, { regenerating: true })
      try {
        const result = await draftVideoPrompt(chapterId, { shot_id: row.shotId, mode })
        const status: RowStatus =
          result.status === 'draft' ? 'draft' : result.status === 'dry_run' ? 'dry_run' : result.status === 'skipped' ? 'skipped' : 'failed'
        updateRow(row.key, {
          prompt: String(result.prompt ?? ''),
          origin: 'llm_draft',
          matchBy: 'generate',
          status,
          message: result.reason ?? '已用新的大模型草稿替换本行',
          draftToken: result.draft_token,
          edited: false,
          include: status === 'draft',
          regenerating: false,
        })
      } catch (error) {
        updateRow(row.key, {
          regenerating: false,
          status: 'failed',
          message: error instanceof Error ? error.message : '重新生成失败',
        })
      }
    },
    [chapterId, mode, updateRow],
  )

  const retryFailed = useCallback(() => {
    const failed = rows.filter((row) => row.status === 'failed').map((row) => row.shotId)
    if (!failed.length) {
      message.warning('没有失败项')
      return
    }
    void runGenerate(failed)
  }, [rows, runGenerate])

  const applyImportPreview = useCallback(
    (
      entries: Array<{ prompt: string; shot_id: string; matched_by: string; status: string; message: string }>,
      origin: PromptBoardOrigin,
    ) => {
      const next = entries.map((entry) =>
        toRow({
          shotId: entry.shot_id,
          prompt: entry.prompt,
          origin,
          matchBy: entry.matched_by || 'none',
          status: entry.status === 'ok' ? 'ok' : entry.status === 'duplicate' ? 'duplicate' : 'unmatched',
          message: entry.message,
          edited: false,
        }),
      )
      setRows(next)
    },
    [toRow],
  )

  /**
   * 「提示词起步」的关键补位：本集还没有镜头（或镜头少于导入条数）时，
   * 按导入顺序**创建缺失镜头**，然后重新解析一次让预览表把提示词匹配到新镜头上，
   * 最后仍由用户点「确认保存」才写库。
   *
   * 为什么不做成自动保存：保存是写库动作，必须由用户在预览表里确认过。
   */
  /**
   * 粘贴文本里有多少「条目」。
   *
   * 为什么要在这里估：本集还没有镜头时，后端 `import-parse` 会直接拒绝解析
   * （「该集还没有镜头，无法导入」），于是预览表是空的、也就没有「匹配到第几镜」可言。
   * 但「提示词起步」的正常顺序就是先有提示词再补镜头，所以要用文本段数推出要建几个镜头。
   */
  const pendingBlockCount = useMemo(() => {
    const text = otherText.trim()
    if (!text) return 0
    const blocks = text
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .filter(Boolean)
    return blocks.length > 0 ? blocks.length : 1
  }, [otherText])

  /** 还需要创建几个镜头（取「预览行数」与「文本段数」的较大者）。 */
  const missingShotCount = Math.max(rows.length, pendingBlockCount) - shots.length

  const doCreateMissingShots = useCallback(async () => {
    if (!chapterId) return
    // 防重复点击：按钮 loading/disabled 之外再加一道同步闸门（状态更新是异步的）
    if (createShotsInFlightRef.current) return
    createShotsInFlightRef.current = true
    setCreatingShots(true)
    try {
      // 以**数据库现状**为准计算缺口，而不是用可能过期的本地状态：
      // 这样即使上一次部分失败/用户在别处建过镜头，也不会重复创建或撞序号。
      const latest = await fetchPromptBoard(chapterId)
      const latestShots = latest.shots ?? []
      const target = Math.max(rows.length, pendingBlockCount)
      const missing = target - latestShots.length
      if (missing <= 0) {
        message.info('当前镜头数已经不少于导入条数，无需创建')
        await loadBoard()
        return
      }
      const baseIndex = latestShots.reduce((max, shot) => Math.max(max, Number(shot.index) || 0), 0)
      let created = 0
      const failures: string[] = []
      for (let offset = 1; offset <= missing; offset += 1) {
        const row = rows[latestShots.length + offset - 1]
        const blocks = otherText
          .split(/\n\s*\n/)
          .map((block) => block.trim())
          .filter(Boolean)
        const prompt = (row?.prompt ?? blocks[latestShots.length + offset - 1] ?? '').trim()
        const index = baseIndex + offset
        try {
          await StudioShotsService.createShotApiV1StudioShotsPost({
            requestBody: {
              // id 是 ShotCreate 的必填字段：用「章节 + 序号 + 时间戳」保证唯一且可排查
              id: `shot_${chapterId}_${index}_${Date.now()}`,
              chapter_id: chapterId,
              index,
              title: prompt.slice(0, 20) || `镜头 ${index}`,
              script_excerpt: prompt,
            } as never,
          })
          created += 1
        } catch (error) {
          // 单个失败不中断其余：SQLite 唯一约束下更可能是序号冲突，跳过继续
          failures.push(`第 ${index} 个：${(error as Error)?.message ?? '创建失败'}`)
        }
      }
      if (created > 0) {
        message.success(`已创建 ${created} 个镜头${failures.length ? `（${failures.length} 个失败，可再次点击补齐）` : ''}`)
      } else {
        message.error(`镜头创建失败：${failures[0] ?? '未知原因'}`)
      }
      // 关键：立刻刷新镜头列表并按新镜头重新匹配，预览表马上显示正确的编号/内容/状态
      await loadBoard()
      if (otherText.trim()) {
        const preview = await parsePromptImport(chapterId, otherText)
        setIssues(preview.issues ?? [])
        setCountMismatch(Boolean(preview.count_mismatch))
        applyImportPreview(preview.entries ?? [], 'external_import')
      }
    } catch (error) {
      const failure = classifyGenerationFailure(error, 'llm')
      message.error(failureText(failure))
    } finally {
      createShotsInFlightRef.current = false
      setCreatingShots(false)
    }
  }, [applyImportPreview, chapterId, loadBoard, otherText, pendingBlockCount, rows])

  const doParseOtherImport = useCallback(async () => {
    if (!chapterId) return
    setParsing(true)
    try {
      const preview = await parsePromptImport(chapterId, otherText)
      setIssues(preview.issues ?? [])
      setCountMismatch(Boolean(preview.count_mismatch))
      setAllowPartial(false)
      applyImportPreview(preview.entries ?? [], 'external_import')
      message.success(`已解析 ${preview.entries?.length ?? 0} 条，请在预览表中校对`)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '解析失败')
    } finally {
      setParsing(false)
    }
  }, [applyImportPreview, chapterId, otherText])

  const doJuriluPreview = useCallback(async () => {
    if (!projectId || !chapterId) return
    if (!juriluUrl.trim()) {
      message.warning('请填写巨日禄页面 URL')
      return
    }
    setJuriluFetching(true)
    try {
      const preview = await previewJuriluImport(projectId, {
        chapter_id: chapterId,
        url: juriluUrl.trim(),
        cookie: juriluCookie,
        authorization: juriluAuthorization,
        auth_mode: juriluAuthMode,
        referer: juriluReferer,
        create_missing: false,
        overwrite: false,
      })
      // 抓取结果**不落库**：只映射进统一预览表，等用户确认
      const entries = (preview.rows ?? []).map((row) => ({
        prompt: row.prompt,
        shot_id: String(row.shot_id ?? ''),
        matched_by: row.shot_id ? 'cookie' : 'none',
        status: row.shot_id ? 'ok' : 'unmatched',
        message: row.reason || (row.shot_id ? '' : '巨日禄这条没有匹配到镜头'),
      }))
      setIssues(preview.warnings ?? [])
      setCountMismatch((preview.chapter_shot_count ?? 0) !== entries.length)
      setAllowPartial(false)
      applyImportPreview(entries, 'jurilu_import')
      message.success(`已抓取 ${entries.length} 条巨日禄提示词，请在预览表中校对后确认保存`)
      setImportOpen(false)
    } catch (error) {
      // 错误信息只透出后端的文案，绝不回显 Cookie / Authorization
      message.error(error instanceof Error ? error.message : '巨日禄抓取失败（Cookie 是否有效？）')
    } finally {
      setJuriluFetching(false)
      clearJuriluCredentials()
    }
  }, [applyImportPreview, chapterId, juriluAuthorization, juriluAuthMode, juriluCookie, juriluReferer, juriluUrl, projectId])

  /** 分组保存：同一张表里允许存在多种来源，按 origin 分组调用。 */
  const doSave = useCallback(async () => {
    if (!chapterId) return
    const included = rows.filter((row) => row.include && row.prompt.trim())
    if (!included.length) {
      message.warning('没有勾选任何要保存的提示词')
      return
    }
    if (countMismatch && !allowPartial) {
      message.error('数量不一致：默认不允许保存，请先确认「仅保存已匹配项」')
      return
    }
    // 整表唯一性：必须在**按来源分组之前**校验，否则不同来源会分两次调用先后写同一镜头
    const uniqueError = validateTableUnique(rows)
    if (uniqueError) {
      message.error(uniqueError)
      return
    }
    setSaving(true)
    try {
      const groups = new Map<PromptBoardOrigin, PreviewRow[]>()
      for (const row of included) {
        // 用户改过大模型草稿 → 按人工修改记录（令牌失配，不能再算 llm）
        const origin: PromptBoardOrigin = row.origin === 'llm_draft' && row.edited ? 'manual' : row.origin
        groups.set(origin, [...(groups.get(origin) ?? []), row])
      }
      let applied = 0
      const failures: string[] = []
      for (const [origin, groupRows] of groups) {
        // eslint-disable-next-line no-await-in-loop
        const result = await savePromptBoard(chapterId, {
          entries: groupRows.map((row) => ({
            shot_id: row.shotId,
            prompt: row.prompt.trim(),
            draft_token: origin === 'llm_draft' ? row.draftToken : undefined,
          })),
          mode,
          origin,
          selected_shot_ids: selectedShotIds,
          allow_partial: countMismatch ? allowPartial : true,
        })
        applied += result.applied_count ?? 0
        for (const item of result.results ?? []) {
          if (!item.applied) failures.push(`${item.code || item.shot_id}：${item.reason}`)
        }
        if (result.error) failures.push(result.error)
      }
      if (applied) message.success(`已保存 ${applied} 条到镜头`)
      if (failures.length) message.warning(`有 ${failures.length} 条未写入：${failures.slice(0, 3).join('；')}`)
      await loadBoard()
      setRows([])
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [allowPartial, chapterId, countMismatch, loadBoard, mode, rows, selectedShotIds, validateTableUnique])

  const includedCount = rows.filter((row) => row.include && row.prompt.trim()).length

  if (!chapterId) {
    return <Card title="集级视频提示词"><Empty description="请先在顶部选择一集" /></Card>
  }

  return (
    <Card
      title={`集级视频提示词 · ${chapterLabel}`}
      extra={
        <Space>
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void loadBoard()}>
            刷新镜头
          </Button>
          {/* 提示词确认保存之后的两个业务出口（顺序与五步流程一致） */}
          {onContinueAssets ? (
            <Button size="small" type="link" onClick={onContinueAssets}>
              继续准备资产 →
            </Button>
          ) : null}
          {onGoBinding ? (
            <Button size="small" type="link" onClick={onGoBinding}>
              已有资产，直接进入绑定 →
            </Button>
          ) : null}
          {onEnterStudio ? (
            <Button size="small" type="link" onClick={onEnterStudio}>
              进入分镜工作台 →
            </Button>
          ) : null}
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        className="mb-3"
        message="整集提示词在这里一次做完再进工作台"
        description="批量生成或批量导入都会先进入下面这张预览确认表；只有点「确认保存」才会写入镜头（未确认前不写库）。工作台只用于逐镜检查与补漏。"
      />

      <Space wrap size={12} className="mb-3">
        <Radio.Group
          size="small"
          value={mode}
          onChange={(event) => setMode(event.target.value as PromptBoardMode)}
          optionType="button"
          options={[
            { value: 'fill_empty', label: '只填充空白镜头' },
            { value: 'overwrite_selected', label: '覆盖选中镜头' },
          ]}
        />
        <Button
          size="small"
          onClick={() => setSelectedShotIds(shots.map((shot) => shot.shot_id))}
          disabled={!shots.length}
        >
          选中本集全部镜头
        </Button>
        <Button size="small" onClick={() => setSelectedShotIds([])}>
          清空选择
        </Button>
        <Typography.Text type="secondary" className="text-[11px]">
          {`本集 ${shots.length} 镜 · 已选 ${selectedShotIds.length} 镜 · 本次将生成 ${generateTargets.length} 镜`}
        </Typography.Text>
      </Space>

      <Space wrap size={8} className="mb-3">
        <Tooltip title="逐镜请求，一次一镜；点停止后不再请求下一镜">
          <Button
            type="primary"
            size="small"
            icon={<ThunderboltOutlined />}
            loading={running}
            disabled={!generateTargets.length}
            onClick={() => void runGenerate(generateTargets)}
          >
            {`批量生成草稿（${generateTargets.length} 镜）`}
          </Button>
        </Tooltip>
        <Button
          size="small"
          danger
          icon={<StopOutlined />}
          disabled={!running}
          onClick={() => {
            stopRef.current = true
          }}
        >
          停止
        </Button>
        <Button size="small" disabled={!rows.some((row) => row.status === 'failed')} onClick={retryFailed}>
          {`重试失败项（${rows.filter((row) => row.status === 'failed').length}）`}
        </Button>
        <Button size="small" icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>
          批量导入（巨日禄 Cookie / 其他平台）
        </Button>
        <Button
          size="small"
          onClick={() => {
            setRows([])
            setIssues([])
            setCountMismatch(false)
            clearJuriluCredentials()
          }}
          disabled={!rows.length}
        >
          取消本次操作
        </Button>
      </Space>

      {countMismatch ? (
        <Alert
          type="warning"
          showIcon
          className="mb-2"
          message="数量与镜头不一致：默认阻止保存"
          description={
            <Space direction="vertical" size={4}>
              <span>请先核对下面的匹配关系；确需只保存已匹配的条目，请显式打开开关。</span>
              <Checkbox checked={allowPartial} onChange={(event) => setAllowPartial(event.target.checked)}>
                仅保存已匹配项（允许部分保存）
              </Checkbox>
            </Space>
          }
        />
      ) : null}

      {issues.length ? (
        <Alert
          type="warning"
          showIcon
          className="mb-2"
          message={`发现 ${issues.length} 个问题`}
          description={
            <ul className="list-disc pl-4 text-[11px]">
              {issues.slice(0, 6).map((issue, index) => (
                <li key={`issue-${index}`}>{issue}</li>
              ))}
            </ul>
          }
        />
      ) : null}

      <Table<PreviewRow>
        size="small"
        rowKey="key"
        loading={loading}
        dataSource={rows}
        pagination={false}
        locale={{ emptyText: '还没有草稿：点「批量生成草稿」或「批量导入」开始' }}
        rowSelection={{
          selectedRowKeys: rows.filter((row) => row.include).map((row) => row.key),
          onChange: (keys) => {
            const wanted = new Set(keys.map(String))
            setRows((prev) => prev.map((row) => ({ ...row, include: wanted.has(row.key) })))
          },
          getCheckboxProps: (row) => ({ disabled: row.status === 'dry_run' }),
        }}
        columns={[
          { title: '编号', dataIndex: 'code', width: 70 },
          { title: '镜头内容', dataIndex: 'shotText', width: 220, ellipsis: true },
          {
            title: '提示词',
            dataIndex: 'prompt',
            render: (value: string, row) => (
              <Input.TextArea
                rows={2}
                value={value}
                placeholder={row.status === 'failed' ? row.message : '（空）'}
                onChange={(event) =>
                  updateRow(row.key, {
                    prompt: event.target.value,
                    edited: row.origin === 'llm_draft' ? event.target.value.trim() !== '' : row.edited,
                  })
                }
              />
            ),
          },
          {
            title: '来源',
            dataIndex: 'origin',
            width: 110,
            render: (_value, row) => {
              const meta = ORIGIN_META[row.origin === 'llm_draft' && row.edited ? 'manual' : row.origin]
              return <Tag color={meta.color}>{meta.label}</Tag>
            },
          },
          { title: '匹配方式', dataIndex: 'matchBy', width: 90 },
          {
            title: '匹配状态 / 原因',
            dataIndex: 'status',
            width: 190,
            render: (_value, row) => (
              <div>
                <Tag color={STATUS_META[row.status].color}>{STATUS_META[row.status].label}</Tag>
                {row.message ? <div className="text-[11px] text-gray-500">{row.message}</div> : null}
              </div>
            ),
          },
          {
            title: '操作',
            key: 'actions',
            width: 200,
            render: (_value, row) => (
              <Space size={4} wrap>
                <Select
                  size="small"
                  style={{ width: 96 }}
                  placeholder="改镜头"
                  value={row.shotId || undefined}
                  options={shots.map((shot) => ({ value: shot.shot_id, label: shot.code }))}
                  onChange={(value) => {
                    const nextShotId = String(value)
                    // 同一镜头已经有另一条勾选记录 → 立即提示冲突并**拒绝这次选择**
                    const conflict = findConflictingRow(nextShotId, row.key)
                    if (conflict) {
                      message.error(
                        `镜头 ${shotById.get(nextShotId)?.code ?? nextShotId} 已被另一条记录占用（来源：${ORIGIN_META[conflict.origin].label}），请先删掉那一条再改。`,
                      )
                      return
                    }
                    const shot = shotById.get(nextShotId)
                    updateRow(row.key, {
                      shotId: nextShotId,
                      code: shot?.code ?? '',
                      shotText: shot ? `${shot.title}｜${shot.script_excerpt.slice(0, 40)}` : '',
                      matchBy: 'manual',
                      status: 'ok',
                      message: '已人工调整匹配的镜头',
                      include: true,
                    })
                  }}
                />
                <Button
                  size="small"
                  loading={row.regenerating}
                  disabled={!row.shotId || !chapterId}
                  onClick={() => void regenerateRow(row)}
                >
                  重新生成
                </Button>
                <Button size="small" danger onClick={() => setRows((prev) => prev.filter((item) => item.key !== row.key))}>
                  删除
                </Button>
              </Space>
            ),
          },
        ]}
      />

      <Space className="mt-3">
        {missingShotCount > 0 && (rows.length > 0 || pendingBlockCount > 0) ? (
          <Tooltip title="按导入顺序补齐本集缺失的镜头，再用同一批提示词重新匹配（建完仍需你点「确认保存」）">
            <Button
              loading={creatingShots}
              disabled={creatingShots}
              data-testid="prompt-board-create-shots"
              onClick={() => void doCreateMissingShots()}
            >
              {`创建缺失镜头（${missingShotCount} 个）并重新匹配`}
            </Button>
          </Tooltip>
        ) : null}
        <Button
          type="primary"
          loading={saving}
          disabled={!includedCount || creatingShots}
          data-testid="prompt-board-save"
          onClick={() => void doSave()}
        >
          {`确认保存（${includedCount} 条）`}
        </Button>
        <Typography.Text type="secondary" className="text-[11px]">
          保存后即写入各镜的 <span className="font-mono">video_prompt</span>；工作台与交付导出读的就是这一列。
        </Typography.Text>
      </Space>

      <Drawer
        title="批量导入视频提示词"
        open={importOpen}
        onClose={() => {
          setImportOpen(false)
          clearJuriluCredentials()
        }}
        width={640}
        destroyOnClose
      >
        <Radio.Group
          value={importTab}
          onChange={(event) => setImportTab(event.target.value as 'jurilu' | 'other')}
          optionType="button"
          className="mb-3"
          data-testid="prompt-import-source"
          options={[
            { value: 'jurilu', label: '巨日禄 Cookie 导入（主入口）' },
            { value: 'other', label: '其他外部平台（粘贴 / 上传）' },
          ]}
        />
        {importTab === 'jurilu' ? (
          <Space direction="vertical" className="w-full" size="small">
            <Alert
              type="info"
              showIcon
              message="Cookie 只用于本次抓取：不保存、不回显、不写日志"
              description="抓取结果不会直接落库，会先进入统一预览确认表，由你核对匹配关系后确认保存。"
            />
            <Input placeholder="巨日禄页面 URL（含 projectId / clipId）" value={juriluUrl} onChange={(e) => setJuriluUrl(e.target.value)} />
            <Input.Password
              placeholder="粘贴巨日禄「复制全部 Cookie」（掩码显示，仅本次抓取使用）"
              value={juriluCookie}
              onChange={(e) => setJuriluCookie(e.target.value)}
            />
            <Space>
              <Input.Password placeholder="Authorization（可留空，掩码显示）" value={juriluAuthorization} onChange={(e) => setJuriluAuthorization(e.target.value)} />
              <Select
                size="middle"
                value={juriluAuthMode}
                style={{ width: 140 }}
                onChange={setJuriluAuthMode}
                options={[
                  { value: 'auto', label: '自动' },
                  { value: 'none', label: '不发送' },
                  { value: 'raw', label: '原样发送' },
                  { value: 'bearer', label: 'Bearer' },
                ]}
              />
            </Space>
            <Input placeholder="Referer（可留空）" value={juriluReferer} onChange={(e) => setJuriluReferer(e.target.value)} />
            <Button type="primary" loading={juriluFetching} onClick={() => void doJuriluPreview()}>
              获取整集提示词（预览，不写库）
            </Button>
          </Space>
        ) : (
          <Space direction="vertical" className="w-full" size="small">
            <Upload
              accept=".txt,.md,.csv,.json"
              showUploadList={false}
              beforeUpload={(file) => {
                void file.text().then((text) => setOtherText(text))
                return false
              }}
            >
              <Button>上传文本文件（.txt/.md/.csv/.json）</Button>
            </Upload>
            <Input.TextArea
              rows={10}
              aria-label="批量提示词文本"
              data-testid="prompt-import-text"
              placeholder={'整段粘贴：每条之间空行；支持 S001 / #1 / 1. 这类编号，没有编号就按顺序匹配'}
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
            />
            <Button
              type="primary"
              loading={parsing}
              data-testid="prompt-import-parse"
              onClick={() => void doParseOtherImport()}
            >
              解析并进入预览表（不写库）
            </Button>
          </Space>
        )}
      </Drawer>
    </Card>
  )
}

export default EpisodeVideoPromptBoard
