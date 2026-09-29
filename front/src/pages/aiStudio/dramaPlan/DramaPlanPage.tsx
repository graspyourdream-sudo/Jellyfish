/**
 * 剧情策划页（剧情广告闭环的第 1 步，按契约「四、页面结构」五段重建）。
 *
 *   1. 商品信息卡（顶部）：字段表单 + 「从资料提取」（粘贴 / 上传 TXT·DOCX / 选已有商品）
 *      + 缺项标「待补充」+「确认商品卡」+ 参考资料（图片归档 / 文档解析成文本）；
 *   2. 剧情策划：一句话核心创意 + 受众情绪目标 → **完整剧情全文用大文本域**（可读可编辑）
 *      → 钩子 / 冲突 / 商品介入 / 高潮反转 / 结尾引导分栏；分阶段按钮（一句话 / 详细剧情 /
 *      分镜 / 一次全部），重新生成前二次确认，检测到人工编辑晚于上次生成时走 `confirm_overwrite`；
 *   3. 资产预览：人物（含关系）/ 场景 / 道具 / 商品，卡片式；
 *   4. 分镜卡片：每镜一张卡，枚举字段一律显示中文；
 *   5. 底部**唯一**主要操作：`确认策划` → 成功后变 `继续准备资产`（跳第 2 步）。
 *
 * 三条界面口径（都不给用户惊喜）：
 *
 * - **付费必须写在按钮上**：`从资料提取`、四个生成按钮都标明"将调用 1 次模型"，
 *   并且只在**后端自己回报** `meta.dry_run === true`（或提取结果的 `source_summary.llm_called === false`）
 *   时才说演练模式 —— 演练与否由后端说了算，页面不去猜环境变量。
 * - **确认之前一切都不影响正式数据**：商品卡与草稿各走各的免费保存出口，
 *   确认策划是唯一写正式产物的入口（并二次确认 + 结果回显）。
 * - **诚实**：缺项就显示「待补充」，没提取到就说"本次没有调用模型"，
 *   后端没给道具就写"本版没有道具"，**绝不编造**。
 *
 * 脏标记与离开拦截：`cardDirty`（商品卡）与 `planDirty`（剧情草稿）两个标记，
 * 刷新/关页走 `beforeunload`，页内跳转（切项目 / 进第 2 步）走 `Modal.confirm` 保存或忽略
 * （先例：`chapter/components/ChapterRawTextEditorModal.tsx:527-552`）。
 *
 * 三层信息模型：ID、接口名、数据库字段名、状态原文、来源与时间戳只出现在
 * **全仓唯一的折叠壳** `TechnicalDetailSection` 里（本文件不自建 `<details>`）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
  Upload,
  message as antdMessage,
} from 'antd'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { StudioProjectsService } from '../../../services/generated'
import {
  type DramaBrief,
  type DramaGenerateStage,
  type DramaPlan,
  type DramaPlanConsistencyRead,
  type DramaPlanRead,
  type DramaPlanShot,
  type DramaStory,
  type ProductCardFields,
  type ProductCardRead,
  type ProductEntityOption,
  type UploadedFileRead,
  confirmDramaPlan,
  emptyBrief,
  emptyProductCardFields,
  extractProductCard,
  fetchDramaPlanAvailability,
  generateDramaPlan,
  getDramaPlan,
  getProductCard,
  listProductEntities,
  parseReferenceDocument,
  resolveWorkingChapter,
  runDramaPlanConsistency,
  saveDramaBrief,
  saveProductCard,
  saveDramaDraft,
  uploadReferenceFile,
} from '../../../services/dramaPlanApi'
import { technicalTextOf, toUserFacingApiErrorText } from '../../../services/llmPipelineApi'
import { TechnicalDetailSection } from '../project/ProjectWorkbench/components/workbench/TechnicalDetailCollapse'
import StepShell from '../components/studio/StepShell'
/* 资料字段的中文标签：全仓既有实现（未登记键给中文兜底，**不回显英文键**），
   资产预览卡片直接用她，不在这里另抄一张表（审计 §4.5 模式 2）。 */
import { profileFieldLabel } from '../project/ProjectWorkbench/components/workbench/workbenchState'
import { resolveAssetPreparationPath } from '../project/projectStartPresets'
/* 广告项目的新建：**同一个组件**，与「广告视频」列表页共用同一份默认值 / 校验 / 提交逻辑。 */
import { AdProjectCreateModal } from '../project/AdProjectCreateModal'
import {
  AD_PHASE,
  CAMERA_ANGLE,
  CAMERA_MOVEMENT,
  DIALOGUE_LINE_MODE,
  PRODUCT_CARD_FIELD,
  PRODUCT_CARD_PENDING_TEXT,
  PRODUCT_CARD_SOURCE_TYPE,
  SHOT_SIZE,
  adPhaseLabel,
  canonicalEnumValue,
  computeProductCardMissingFields,
  dramaOverwriteRisk,
  dramaStaleNotices,
  labelFor,
  productCardPendingText,
} from '../components/enumLabels'
import type { EnumSpec } from '../components/enumLabels'

const { Paragraph, Text } = Typography

type Busy =
  | 'idle'
  | 'load'
  | 'card-save'
  | 'card-extract'
  | 'card-upload'
  | 'brief-save'
  | 'draft-save'
  | 'generate'
  | 'consistency'
  | 'confirm'

type ProjectOption = { id: string; name: string; kind: string; phaseLabel: string }

type ExtractSourceType = 'paste' | 'upload' | 'existing'

/* ------------------------------------------------------------------ 纯工具 */

/** 多行文本 ↔ 字符串数组（卖点 / 动作拍点 / 必含这类"一行一条"的字段）。 */
const linesToArray = (value: string): string[] =>
  value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)

const arrayToLines = (value: string[] | undefined): string => (value ?? []).join('\n')

/** 枚举 code → 下拉选项（**值是原值、显示是中文**；原值不进主区文案）。 */
const enumOptions = (spec: EnumSpec) =>
  spec.values.map((value) => ({ value, label: labelFor(spec, value) }))

const SHOT_SIZE_OPTIONS = enumOptions(SHOT_SIZE)
const ANGLE_OPTIONS = enumOptions(CAMERA_ANGLE)
const MOVEMENT_OPTIONS = enumOptions(CAMERA_MOVEMENT)
const DIALOGUE_MODE_OPTIONS = enumOptions(DIALOGUE_LINE_MODE)

const EMPTY_STORY: DramaStory = {
  full_text: '',
  hook: '',
  conflict: '',
  product_usage: '',
  climax: '',
  cta: '',
}

/** 空草稿（还没生成过任何东西时的编辑器初值；**不含任何编造内容**）。 */
function emptyPlanDraft(): DramaPlan {
  return {
    one_liner: '',
    audience_emotion: '',
    title: '',
    logline: '',
    selling_points: [],
    characters: [],
    scenes: [],
    props: [],
    product: null,
    story: { ...EMPTY_STORY },
    shots: [],
    climax: '',
    warnings: [],
  }
}

/**
 * 后端草稿 → 页面可编辑草稿。
 *
 * 只补**结构性**默认（缺 story 段、缺 shots 数组、缺 props），
 * 一个字的内容都不生成；旧版草稿的 `logline` / `climax` 原样保留，不做"迁移式"改写。
 */
function normalizePlan(raw: DramaPlan | null | undefined): DramaPlan {
  if (!raw) return emptyPlanDraft()
  const story = (raw.story ?? {}) as Partial<DramaStory>
  return {
    ...emptyPlanDraft(),
    ...raw,
    story: {
      full_text: String(story.full_text ?? ''),
      hook: String(story.hook ?? ''),
      conflict: String(story.conflict ?? ''),
      product_usage: String(story.product_usage ?? ''),
      /* 旧草稿把结尾反转放在顶层 `climax`：这里只是**显示**它，不改写后端数据。 */
      climax: String(story.climax ?? raw.climax ?? ''),
      cta: String(story.cta ?? ''),
    },
    shots: Array.isArray(raw.shots) ? raw.shots : [],
    characters: Array.isArray(raw.characters) ? raw.characters : [],
    scenes: Array.isArray(raw.scenes) ? raw.scenes : [],
    props: Array.isArray(raw.props) ? raw.props : [],
  }
}

/** 草稿快照（脏标记比对用；只比内容，不比服务端时间戳）。 */
const snapshot = (plan: DramaPlan | null): string => (plan ? JSON.stringify(plan) : '')
const cardSnapshot = (fields: ProductCardFields): string => JSON.stringify(fields)

/** 一份草稿里是否有可确认的内容（用于禁用/放行「确认策划」）。 */
function planHasContent(plan: DramaPlan | null): boolean {
  if (!plan) return false
  return Boolean(
    String(plan.one_liner ?? '').trim() ||
      String(plan.story?.full_text ?? '').trim() ||
      plan.shots.length > 0,
  )
}

/** 分镜里出现商品的镜头比例（后端按关联行判定"至少一半"）。 */
function productCoverage(plan: DramaPlan | null): { present: number; total: number; enough: boolean } {
  const shots = plan?.shots ?? []
  const present = shots.filter((shot) => Boolean(shot.product_present)).length
  const total = shots.length
  return { present, total, enough: total === 0 ? false : present * 2 >= total }
}

/** 提取结果里到底调没调模型（后端 `source_summary.llm_called`）。 */
function llmCalledInSummary(summary: Record<string, unknown> | null | undefined): boolean {
  return summary?.llm_called === true
}

const extractSourceLabel = (value: ExtractSourceType): string => {
  if (value === 'paste') return '粘贴资料'
  if (value === 'upload') return '上传资料'
  return '已有商品资料'
}

/* ------------------------------------------------------------------- 页面 */

const DramaPlanPage: React.FC = () => {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [available, setAvailable] = useState<boolean | null>(null)
  const [projectId, setProjectId] = useState(searchParams.get('projectId') ?? '')
  const [chapterId, setChapterId] = useState(searchParams.get('chapterId') ?? '')
  const [chapterTitle, setChapterTitle] = useState('')

  const [read, setRead] = useState<DramaPlanRead | null>(null)
  const [card, setCard] = useState<ProductCardRead | null>(null)
  const [cardDraft, setCardDraft] = useState<ProductCardFields>(emptyProductCardFields())
  const [cardSaved, setCardSaved] = useState<ProductCardFields>(emptyProductCardFields())

  const [plan, setPlan] = useState<DramaPlan | null>(null)
  const [planSavedSnapshot, setPlanSavedSnapshot] = useState('')
  const [brief, setBrief] = useState<DramaBrief>(emptyBrief())

  const [busy, setBusy] = useState<Busy>('idle')
  const [error, setError] = useState('')
  const [errorRaw, setErrorRaw] = useState('')
  /* 后端给的长说明（提取/生成失败边界、演练模式说明等）：**只进技术详情**。
     它们可能带环境变量名、接口路径这类第三层内容，主区只说我们能自己负责的中文结论。 */
  const [noteRaw, setNoteRaw] = useState('')
  const [notice, setNotice] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [confirmResult, setConfirmResult] = useState<Record<string, unknown> | null>(null)
  const [consistency, setConsistency] = useState<DramaPlanConsistencyRead | null>(null)

  /* 「新建广告视频」弹窗：本页在没有可用项目时的唯一主操作（不会再要求用户离开本页）。 */
  const [adCreateOpen, setAdCreateOpen] = useState(false)

  /* 「从资料提取」弹窗 */
  const [extractOpen, setExtractOpen] = useState(false)
  const [extractSource, setExtractSource] = useState<ExtractSourceType>('paste')
  const [extractText, setExtractText] = useState('')
  const [extractFileName, setExtractFileName] = useState('')
  const [extractFileIds, setExtractFileIds] = useState<string[]>([])
  const [extractUploadNames, setExtractUploadNames] = useState<string[]>([])
  const [extractExistingId, setExtractExistingId] = useState('')
  const [extractInstructions, setExtractInstructions] = useState('')
  const [productOptions, setProductOptions] = useState<ProductEntityOption[]>([])
  const [productOptionsError, setProductOptionsError] = useState('')

  const generating = (read?.status ?? 'none') === 'running'
  const cardMissingKeys = useMemo(() => computeProductCardMissingFields(cardDraft), [cardDraft])
  const cardPending = productCardPendingText(cardMissingKeys)
  /** 字段标签：缺这一项就在标签上标出来（缺就是缺，不编造）。 */
  const cardLabel = (key: string, label: string): string =>
    cardMissingKeys.includes(key) ? `${label}（${PRODUCT_CARD_PENDING_TEXT}）` : label
  const cardDirty = cardSnapshot(cardDraft) !== cardSnapshot(cardSaved)
  const planDirty = Boolean(plan) && snapshot(plan) !== planSavedSnapshot
  const dirty = cardDirty || planDirty

  const staleNotices = useMemo(() => dramaStaleNotices(read?.stale_flags), [read?.stale_flags])
  const overwriteRisk = useMemo(() => dramaOverwriteRisk(read?.stale_flags), [read?.stale_flags])
  const cardConfirmed = Boolean(card?.confirmed) && !cardDirty
  const coverage = useMemo(() => productCoverage(plan), [plan])
  /* 确认结果回显：本次刚确认用响应原文；刷新后读草稿里的落库统计，页面不会"忘了刚确认过"。 */
  const storedSummary = (read?.materialize_summary ?? null) as Record<string, unknown> | null
  const confirmSummary =
    confirmResult ?? (storedSummary && Object.keys(storedSummary).length ? storedSummary : null)
  /* ⚠️ 判"这条草稿确认过没有"必须看 `story_status` 与非空的落库统计，**不能用 `Boolean(对象)`**：
     后端 `materialize_summary` 的默认值是空对象 `{}`，而 JS 里 `Boolean({}) === true` ——
     于是任何一条**没确认过**的草稿都会被当成"已确认"，页面直接走确认后的分支，
     「确认策划」按钮根本不出现（真机验收就卡在这里：按钮不存在，用户无法确认策划落库）。
     判据只认服务端事实：`story_status === 'confirmed'`、本次刚返回的确认响应、
     或服务端写下的**非空**落库统计。 */
  const confirmedAlready =
    read?.story_status === 'confirmed' ||
    Boolean(confirmResult) ||
    Boolean(storedSummary && Object.keys(storedSummary).length)
  /* 下一步落点：后端 `next_step` 优先（它认识自己的工作台路由），
     `chapter_url` 带上刚确认的这一集；本地兜底与它同口径（同样的查询参数）。 */
  const backendNextStep = (confirmSummary?.next_step ?? null) as
    | { label?: string; url?: string; chapter_url?: string }
    | null
  const nextStepPath =
    String(backendNextStep?.chapter_url || backendNextStep?.url || '').trim() ||
    (projectId && chapterId ? resolveAssetPreparationPath(projectId, chapterId) : '')

  const applyCard = useCallback((payload: ProductCardRead) => {
    setCard(payload)
    const fields: ProductCardFields = {
      name: payload.name ?? '',
      category: payload.category ?? '',
      brand: payload.brand ?? '',
      selling_points: payload.selling_points ?? [],
      audience: payload.audience ?? '',
      scenarios: payload.scenarios ?? [],
      price_info: payload.price_info ?? '',
      compliance: payload.compliance ?? '',
      notes: payload.notes ?? '',
      reference_files: payload.reference_files ?? [],
    }
    setCardDraft(fields)
    setCardSaved(fields)
  }, [])

  const applyRead = useCallback((payload: DramaPlanRead) => {
    setRead(payload)
    const nextPlan = normalizePlan(payload.plan)
    setPlan(nextPlan)
    /* 快照必须与当前编辑值逐字一致，否则刚读回来就显示「未保存」。
       未生成过草稿时用空草稿的快照（用户打下第一个字才算脏）。 */
    setPlanSavedSnapshot(snapshot(nextPlan))
    setBrief({ ...emptyBrief(), ...payload.brief })
    setConsistency(payload.consistency ?? null)
    setWarnings(payload.plan?.warnings ?? [])
  }, [])

  const run = async (kind: Busy, action: () => Promise<void>) => {
    setBusy(kind)
    setError('')
    setErrorRaw('')
    setNotice('')
    try {
      await action()
    } catch (exc) {
      setError(toUserFacingApiErrorText(exc, '这一步没有成功，请稍后重试'))
      setErrorRaw(technicalTextOf(exc))
    } finally {
      setBusy('idle')
    }
  }

  /* ---------------- 项目列表 + 端点可用性（读 /openapi.json 判断，不试调） ---------------- */
  useEffect(() => {
    let alive = true
    void (async () => {
      const ok = await fetchDramaPlanAvailability()
      if (alive) setAvailable(ok)
      try {
        const resp = await StudioProjectsService.listProjectsApiV1StudioProjectsGet({ page: 1, pageSize: 100 })
        if (!alive) return
        setProjects(
          (resp.data?.items ?? []).map((item) => {
            /* `kind` / `ad_phase_label` 是本轮新增列，已提交的生成客户端里还没有，
               所以按结构化读取（不重新生成 OpenAPI，见 `dramaPlanApi.ts` 文件头）。 */
            const raw = item as unknown as Record<string, unknown>
            const kind = String(raw.kind ?? 'drama')
            const phaseLabel = String(raw.ad_phase_label ?? '') || adPhaseLabel(String(raw.ad_phase ?? ''))
            return { id: String(item.id), name: String(item.name ?? ''), kind, phaseLabel }
          }),
        )
      } catch {
        /* 列表失败不阻断：用户仍可直接用 URL 里的 projectId */
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  /* ---------------- 选项目 / 带 chapterId 直接进页面 ---------------- */
  const openChapter = useCallback(
    async (nextProjectId: string, productName: string) => {
      setBusy('load')
      setError('')
      try {
        const working = await resolveWorkingChapter(nextProjectId, productName)
        setChapterId(working.chapter_id)
        setChapterTitle(working.title)
        setSearchParams({ projectId: nextProjectId, chapterId: working.chapter_id }, { replace: true })
        const [planPayload, cardPayload] = await Promise.all([
          getDramaPlan(working.chapter_id),
          getProductCard(nextProjectId),
        ])
        applyRead(planPayload)
        applyCard(cardPayload)
      } catch (exc) {
        setError(toUserFacingApiErrorText(exc, '读取失败，请稍后重试'))
        setErrorRaw(technicalTextOf(exc))
      } finally {
        setBusy('idle')
      }
    },
    [applyCard, applyRead, setSearchParams],
  )

  /**
   * URL → 状态同步（**唯一真相是 URL**）。
   *
   * 为什么必须有：`projectId` / `chapterId` 原来只在挂载时从 `searchParams` 读一次。
   * 于是「在本页新建项目 → 页面自己跳到带 `projectId`+`chapterId` 的地址」这一跳
   * （组件并没有卸载，React Router 只换了查询参数）不会更新状态，页面会停在空态 ——
   * 表现就是"创建成功了但什么都没发生"。浏览器前进 / 后退同理。
   *
   * 只认**URL 真的变了**这一次（用 ref 记住上一次的值），避免和 `openChapter`
   * 自己写 URL 的动作打架：那条路径写进去的就是同一份值，同步一次是幂等的。
   */
  const lastUrlKeyRef = useRef('')
  useEffect(() => {
    const urlProjectId = searchParams.get('projectId') ?? ''
    const urlChapterId = searchParams.get('chapterId') ?? ''
    const key = `${urlProjectId}|${urlChapterId}`
    if (lastUrlKeyRef.current === key) return
    lastUrlKeyRef.current = key
    if (urlProjectId === projectId && urlChapterId === chapterId) return
    setProjectId(urlProjectId)
    setChapterId(urlChapterId)
    setConfirmResult(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  /**
   * 深链自动落位：URL 里只有 `?projectId=` 时**自动取一集可用的空章节**。
   *
   * 为什么必须有：从项目工作台 / 收藏夹直接打开 `?projectId=…` 时，页面原来一直停在
   * "先选一个项目"的空状态 —— 明明已经选了项目，用户却被要求再选一次。
   * 这里复用与"下拉选项目"**同一个** `openChapter`（同一个章节选择口径），不另写一套。
   */
  const autoOpenedRef = useRef(false)
  useEffect(() => {
    if (autoOpenedRef.current) return
    if (!projectId || chapterId) return
    autoOpenedRef.current = true
    void openChapter(projectId, cardDraft.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, chapterId])

  useEffect(() => {
    if (!chapterId) return
    let alive = true
    setBusy('load')
    void (async () => {
      try {
        const planPayload = await getDramaPlan(chapterId)
        if (alive) applyRead(planPayload)
      } catch (exc) {
        if (alive) {
          setError(toUserFacingApiErrorText(exc, '读取失败，请稍后重试'))
          setErrorRaw(technicalTextOf(exc))
        }
      } finally {
        if (alive) setBusy('idle')
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId])

  useEffect(() => {
    if (!projectId) return
    let alive = true
    void (async () => {
      try {
        const payload = await getProductCard(projectId)
        if (alive) applyCard(payload)
      } catch {
        /* 商品卡读不到时保持空表单：后面的保存会给出明确结论 */
      }
    })()
    return () => {
      alive = false
    }
  }, [applyCard, projectId])

  /* ---------------------------------- 未保存改动：刷新/关页拦截 -------------------------------- */
  useEffect(() => {
    if (!dirty) return
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      /* 现代浏览器只认 returnValue 的"是否为空"；文案由浏览器自己给。 */
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [dirty])

  /** 页内跳转前的保存/忽略确认（先例：ChapterRawTextEditorModal 的 handleRequestClose）。 */
  const confirmLeaveThen = (after: () => void) => {
    if (!dirty) {
      after()
      return
    }
    Modal.confirm({
      title: '检测到未保存变更',
      content: '商品信息卡或剧情草稿有未保存的修改，离开前请选择操作。',
      okText: '保存',
      cancelText: '忽略',
      onOk: async () => {
        const ok = await saveEverything()
        if (ok) after()
      },
      onCancel: () => after(),
    })
  }

  /* ------------------------------------------- 保存（两处，都免费） ------------------------------------------- */
  const saveCardOnly = async (confirmed: boolean): Promise<boolean> => {
    if (!projectId) return false
    try {
      const payload = await saveProductCard(projectId, cardDraft, confirmed)
      applyCard(payload)
      antdMessage.success(confirmed ? '商品卡已确认并保存' : '商品信息卡已保存（没有调用模型）')
      return true
    } catch (exc) {
      const failure = exc as { status?: number; detail?: { code?: string; message?: string } }
      const code = failure?.detail?.code
      if (failure?.status === 409 && code === 'product_card_required_missing') {
        antdMessage.error('还不能确认：商品名称还没填，填好后再点「确认商品卡」。')
      } else {
        antdMessage.error(toUserFacingApiErrorText(exc, '保存商品卡失败，请稍后重试'))
      }
      setError(toUserFacingApiErrorText(exc, '保存商品卡失败，请稍后重试'))
      setErrorRaw(technicalTextOf(exc))
      return false
    }
  }

  const savePlanDraft = async (): Promise<boolean> => {
    if (!chapterId || !plan) return false
    try {
      const payload = await saveDramaDraft(chapterId, plan)
      applyRead(payload)
      antdMessage.success('剧情草稿已保存（免费）')
      return true
    } catch (exc) {
      setError(toUserFacingApiErrorText(exc, '保存草稿失败，请稍后重试'))
      setErrorRaw(technicalTextOf(exc))
      antdMessage.error(toUserFacingApiErrorText(exc, '保存草稿失败，请稍后重试'))
      return false
    }
  }

  /** 保存所有脏内容（离开前用）。 */
  const saveEverything = async (): Promise<boolean> => {
    let ok = true
    if (cardDirty) ok = (await saveCardOnly(Boolean(card?.confirmed))) && ok
    if (planDirty) ok = (await savePlanDraft()) && ok
    return ok
  }

  /* ------------------------------------------------- 商品卡：提取 ------------------------------------------- */
  const onOpenExtract = () => {
    setExtractOpen(true)
    setProductOptionsError('')
    if (productOptions.length === 0) {
      void (async () => {
        try {
          setProductOptions(await listProductEntities())
        } catch (exc) {
          setProductOptionsError(toUserFacingApiErrorText(exc, '读不到已有商品列表，可改用粘贴或上传资料'))
        }
      })()
    }
  }

  const onParseDocument = async (file: File) => {
    setBusy('card-upload')
    setError('')
    setNotice('')
    try {
      const parsed = await parseReferenceDocument(file)
      setExtractText(parsed.text)
      setExtractFileName(parsed.filename)
      /* 解析出的是**文字**，所以提取按"粘贴资料"走（解析接口不落文件记录）。 */
      setExtractSource('paste')
      setNotice(
        `已解析《${parsed.filename}》：${parsed.char_count} 字、${parsed.paragraph_count} 段。` +
          '解析结果已填进下面的资料正文，可以继续编辑或直接提取。',
      )
      if (parsed.warnings.length > 0) setWarnings(parsed.warnings)
    } catch (exc) {
      setError(toUserFacingApiErrorText(exc, '资料解析失败，请确认文件是 TXT / MD / DOCX 后重试'))
      setErrorRaw(technicalTextOf(exc))
    } finally {
      setBusy('idle')
    }
  }

  const onUploadReferenceImage = async (file: File) => {
    setBusy('card-upload')
    setError('')
    setNotice('')
    try {
      const uploaded: UploadedFileRead = await uploadReferenceFile(file, { projectId })
      const entry = { file_id: uploaded.id, name: uploaded.name || file.name, kind: 'image' }
      setCardDraft((current) => ({ ...current, reference_files: [...current.reference_files, entry] }))
      setNotice(
        `已归档参考图《${entry.name}》：保存商品卡后会一起存下来（当前还没保存，记得点「保存商品卡」）。`,
      )
      if (uploaded.url_reachable === false) {
        setWarnings(['这张参考图的公网地址没能验证通过：绑定给上游前请先确认它可被匿名访问。'])
      }
    } catch (exc) {
      setError(toUserFacingApiErrorText(exc, '图片上传失败，请稍后重试'))
      setErrorRaw(technicalTextOf(exc))
    } finally {
      setBusy('idle')
    }
  }

  /** 「上传资料」里的文档：**归档**成文件记录，提取时后端按 file_id 解析 TXT / DOCX 正文。 */
  const onUploadExtractDocument = async (file: File) => {
    setBusy('card-upload')
    setError('')
    setErrorRaw('')
    setNotice('')
    try {
      const uploaded = await uploadReferenceFile(file, { projectId, usageKind: 'upload' })
      setExtractFileIds((current) => [...current, uploaded.id])
      setExtractUploadNames((current) => [...current, uploaded.name || file.name])
      setNotice(`已上传资料《${uploaded.name || file.name}》：点「开始提取」后由后端解析正文（读不出的部分不会被编造）。`)
    } catch (exc) {
      setError(toUserFacingApiErrorText(exc, '资料上传失败，请稍后重试'))
      setErrorRaw(technicalTextOf(exc))
    } finally {
      setBusy('idle')
    }
  }

  /** 「上传资料」里的图片：只归档成参考资料（读不出文字，如实说明）。 */
  const onUploadExtractImage = async (file: File) => {
    setBusy('card-upload')
    setError('')
    setErrorRaw('')
    setNotice('')
    try {
      const uploaded = await uploadReferenceFile(file, { projectId, usageKind: 'upload' })
      if (uploaded.id) setExtractFileIds((current) => [...current, uploaded.id])
      setExtractUploadNames((current) => [...current, uploaded.name || file.name])
      setCardDraft((current) => ({
        ...current,
        reference_files: [
          ...current.reference_files,
          { file_id: uploaded.id, name: uploaded.name || file.name, kind: 'image' },
        ],
      }))
      setNotice('图片已归档为商品参考资料（图片读不出文字，提取不会用到它）。')
    } catch (exc) {
      setError(toUserFacingApiErrorText(exc, '图片上传失败，请稍后重试'))
      setErrorRaw(technicalTextOf(exc))
    } finally {
      setBusy('idle')
    }
  }

  const onExtract = () => {
    /* 先在本地把"必然会被后端拒绝"的两种输入挡掉：省一次往返，也省一次付费出口的调用风险。 */
    if (extractSource === 'paste' && !extractText.trim()) {
      antdMessage.warning('粘贴资料还是空的：先贴商品文案，或上传 TXT / DOCX 解析成文本。')
      return
    }
    if (extractSource === 'existing' && !extractExistingId) {
      antdMessage.warning('还没有选已有商品：先在上面的下拉里选一个。')
      return
    }
    if (extractSource === 'upload' && extractFileIds.length === 0) {
      antdMessage.warning('还没有上传任何资料：先上传 TXT / DOCX 资料或商品图片。')
      return
    }
    void run('card-extract', async () => {
      if (!projectId) return
      const payload = await extractProductCard(projectId, {
        source_type: extractSource,
        text: extractSource === 'paste' ? extractText : undefined,
        file_ids: extractSource === 'upload' ? extractFileIds : undefined,
        existing_product_id: extractSource === 'existing' ? extractExistingId : undefined,
        extra_instructions: extractInstructions,
      })
      const called = llmCalledInSummary(payload.source_summary)
      const filled: ProductCardFields = { ...emptyProductCardFields(), ...payload.fields }
      /* 提取结果**只回填表单**：落库仍要用户点「确认商品卡」。
         演练/无文字资料时后端一个字段都不给，这时**不改动**用户已经填好的内容。 */
      const hasAnyField = Object.entries(filled).some(([key, value]) =>
        key === 'reference_files' ? (value as unknown[]).length > 0 : String(value ?? '').trim() !== '',
      )
      if (hasAnyField) {
        const keepFiles = cardDraft.reference_files
        const mergedFiles = [
          ...filled.reference_files,
          ...keepFiles.filter((item) => !filled.reference_files.some((other) => other.file_id === item.file_id)),
        ]
        setCardDraft({ ...filled, reference_files: mergedFiles })
      }
      setWarnings(payload.warnings ?? [])
      setNoteRaw(payload.note ?? '')
      setExtractOpen(false)
      setNotice(
        called
          ? `已提取（调用 1 次模型）：字段已回填到上面的表单，${PRODUCT_CARD_PENDING_TEXT}的项请补齐，` +
            '核对后点「确认商品卡」才会保存。'
          : '本次没有调用模型，所以没有回填任何字段（表单保持原样）：可以手工填写后再确认商品卡。',
      )
    })
  }

  /* ------------------------------------------- 制作要求（brief，免费保存） ---------------------------------- */
  const onSaveBrief = () =>
    run('brief-save', async () => {
      if (!chapterId) return
      const payload = await saveDramaBrief(chapterId, brief)
      applyRead(payload)
      setNotice('制作要求已保存（没有调用模型）。')
    })

  /* ------------------------------------------------- 剧情：分层生成 ------------------------------------------- */
  const stageGate = (stage: DramaGenerateStage): string => {
    if (stage === 'story' && !String(plan?.one_liner ?? '').trim()) {
      return '先生成或填写「一句话核心创意」并保存，再生成详细剧情（详细剧情必须基于已确认的一句话）。'
    }
    if (stage === 'storyboard' && !String(plan?.story?.full_text ?? '').trim()) {
      return '先生成或填写「完整剧情全文」并保存，再生成分镜（分镜必须基于当前完整剧情）。'
    }
    /* 上一层的改动还没保存时先拦住：否则会按**库里那份旧内容**生成，用户会以为白改了。 */
    if (stage === 'story' && planDirty) {
      return '「一句话核心创意」刚改过还没保存：先点「保存剧情草稿」，再生成详细剧情。'
    }
    if (stage === 'storyboard' && planDirty) {
      return '「完整剧情全文」刚改过还没保存：先点「保存剧情草稿」，再生成分镜。'
    }
    return ''
  }

  /** 这一层**已经**有内容时会走"重新生成"路径（必须二次确认）。 */
  const existingForStage = (stage: DramaGenerateStage): boolean => {
    if (stage === 'one_liner') return Boolean(String(plan?.one_liner ?? '').trim())
    if (stage === 'story') return Boolean(String(plan?.story?.full_text ?? '').trim())
    if (stage === 'storyboard') return (plan?.shots.length ?? 0) > 0
    return planHasContent(plan)
  }

  const runGenerate = (stage: DramaGenerateStage, confirmOverwrite: boolean) =>
    run('generate', async () => {
      if (!chapterId) return
      let payload: DramaPlanRead
      try {
        payload = await generateDramaPlan(chapterId, stage, confirmOverwrite)
      } catch (exc) {
        /* 后端按**它库里的**人工编辑时间判定要覆盖确认，而我们本地看到的标记可能已经过时
           （另一标签页改过、或换了设备）。这时不把 409 干瘪地丢给用户，而是把"要不要覆盖"
           再问一次 —— 用户点确认后带 `confirm_overwrite=true` 重试。 */
        const status = (exc as { status?: number } | null)?.status
        if (status === 409 && !confirmOverwrite) {
          Modal.confirm({
            title: '这次生成需要先确认覆盖',
            content:
              '服务端记录到你的手工修改晚于上一次生成：继续会用新的生成结果覆盖这些修改。' +
              '确认后重新生成（本次调用 1 次模型）。',
            okText: '确认覆盖并重新生成',
            cancelText: '取消',
            onOk: () => runGenerate(stage, true),
          })
          return
        }
        throw exc
      }
      applyRead(payload)
      if (payload.plan) {
        setNotice(
          confirmOverwrite
            ? '已按你的确认重新生成，并覆盖了手工修改（本次调用 1 次模型）。'
            : '已生成（调用 1 次模型）：下面是新的草稿，改完记得保存。',
        )
      } else {
        setNotice('本次没有生成草稿（通常是演练模式：后端没有真实调用模型，也没有编造内容）。')
        setNoteRaw(payload.note ?? '')
      }
    })

  const onGenerateStage = (stage: DramaGenerateStage) => {
    if (!cardConfirmed) {
      antdMessage.warning('还没有确认商品卡：请先补齐「商品名称」并点「确认商品卡」，再生成剧情。')
      return
    }
    const blocked = stageGate(stage)
    if (blocked) {
      antdMessage.warning(blocked)
      return
    }
    const hasExisting = existingForStage(stage)
    if (!hasExisting) {
      void runGenerate(stage, false)
      return
    }
    /* 重新生成前**必须二次确认**；检测到人工编辑晚于上次生成时，明确说会覆盖修改。 */
    Modal.confirm({
      title: stage === 'storyboard' ? '重新生成分镜？' : '重新生成这一层？',
      content: `${overwriteRisk.message}（本次调用 1 次模型，重新生成后可以继续编辑。）`,
      okText: '确认重新生成',
      cancelText: '取消',
      onOk: () => runGenerate(stage, overwriteRisk.needsConfirm || planDirty),
    })
  }

  /* ---------------------------------------------------- 一致性检查 / 确认 ------------------------------------ */
  const onCheckConsistency = () =>
    run('consistency', async () => {
      if (!chapterId) return
      const payload = await runDramaPlanConsistency(chapterId)
      setConsistency(payload)
      const issues = payload.issues ?? []
      const summary = payload.summary
      const counts = summary
        ? `镜头 ${summary.shots ?? 0} 个（出现商品 ${summary.product_shots ?? 0} 个，要求至少 ${summary.product_required ?? 0} 个）、` +
          `人物 ${summary.characters ?? 0} 个、场景 ${summary.scenes ?? 0} 个。`
        : ''
      setNotice(
        issues.length === 0
          ? `一致性检查通过。${counts}`
          : `一致性检查发现问题 ${issues.length} 条（错误 ${summary?.errors ?? 0} 条、提示 ${summary?.warnings ?? 0} 条）。${counts}`,
      )
    })

  const onConfirmPlan = () =>
    run('confirm', async () => {
      if (!chapterId) return
      const result = (await confirmDramaPlan(chapterId)) as unknown as Record<string, unknown>
      setConfirmResult(result)
      setNotice('策划已确认落库（镜头、资产与关联行都已写入正式数据）。')
      const refreshed = await getDramaPlan(chapterId)
      applyRead(refreshed)
    })

  const goNextStep = () => {
    if (!nextStepPath) return
    confirmLeaveThen(() => navigate(nextStepPath))
  }

  /* -------------------------------------------------------- 分镜编辑 -------------------------------------------------- */
  const updateShot = (index: number, patch: Partial<DramaPlanShot>) => {
    setPlan((current) => {
      if (!current) return current
      return {
        ...current,
        shots: current.shots.map((shot) => (shot.index === index ? { ...shot, ...patch } : shot)),
      }
    })
  }

  const updateStory = (patch: Partial<DramaStory>) => {
    setPlan((current) => {
      const base = current ?? emptyPlanDraft()
      const story = { ...(base.story ?? EMPTY_STORY), ...patch }
      return { ...base, story, climax: story.climax }
    })
  }

  const updateOneLiner = (value: string) => {
    setPlan((current) => {
      const base = current ?? emptyPlanDraft()
      /* `one_liner` 与旧的 `logline` 是同一件事（一句话主线，落章节摘要），
         这里同步写入，避免新旧后端各读一个字段时页面与库里不一致。 */
      return { ...base, one_liner: value, logline: value }
    })
  }

  const characterNames = useMemo(() => (plan?.characters ?? []).map((item) => item.name), [plan])
  const projectOptions = useMemo(
    () =>
      projects.map((item) => ({
        value: item.id,
        label:
          item.kind === 'ad'
            ? `${item.name || item.id}（剧情广告${item.phaseLabel ? ` · ${item.phaseLabel}` : ''}）`
            : item.name || item.id,
      })),
    [projects],
  )

  return (
    <>
    <AdProjectCreateModal
      open={adCreateOpen}
      onCancel={() => setAdCreateOpen(false)}
      /* 创建成功：弹窗自己会跳到 `?projectId=…&chapterId=…`（与列表页同一条落点）。
         这里额外把状态同步一次 —— 组件不卸载的情况下 URL 变了，上面的 URL→状态
         同步 effect 固然会处理，但显式同步能让「进入策划」这一跳更快、也更明确。 */
      onCreated={(created) => {
        setAdCreateOpen(false)
        setProjectId(created.projectId)
        setChapterId(created.chapterId)
        lastUrlKeyRef.current = `${created.projectId}|${created.chapterId}`
      }}
    />
    <StepShell
      context={{
        projectId,
        chapterLabel: chapterTitle || '未选择章节',
        stepText: '第 1 步 · 剧本与分镜（剧情广告策划）',
        // 有没有未保存的改动是用户最需要一眼看到的：有脏标记就是"保存中"，否则"已保存"
        saving: dirty,
        callCount: null,
        actions: (
          <Button
            size="small"
            onClick={() => navigate(projectId ? `/projects/${projectId}` : '/ad-videos')}
            data-testid="drama-plan-back"
          >
            {projectId ? '返回项目工作台' : '返回广告视频'}
          </Button>
        ),
      }}
      currentStepIndex={0}
      onStepClick={(index: number, label: string) => {
        /* 原型口径：点非当前步骤不移动高亮、不切换内容，只说明它在哪完成。 */
        void antdMessage.info(
          index === 1
            ? `第 2 步「${label}」在项目工作台的资产准备里完成；本页确认策划后底部按钮即可进入。`
            : `第 ${index + 1} 步「${label}」在项目工作台 / 分镜工作室里完成；这里只显示进度，不切换页面。`,
        )
      }}
      stepNote={(index: number) =>
        index === 0 ? '第 1 步 · 当前步骤（剧情广告策划）' : `第 ${index + 1} 步 · 未解锁（先确认策划）`
      }
    >
      <Paragraph type="secondary" style={{ marginBottom: 16 }}>
        商品信息卡 → 一句话核心创意 → 完整剧情 → 分镜 → 确认策划（落库后进入第 2 步资产准备）。
        <Text strong> 确认之前不会改动章节、分镜与任何资产。</Text>
      </Paragraph>

      {available === false && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="后端还没有这组接口"
          description="当前部署的后端接口清单里没有剧情策划与商品卡这组路径。请先升级后端（或确认新表已迁移）后再用本页。"
        />
      )}

      <Card size="small" style={{ marginBottom: 16 }}>
        <Space wrap align="end">
          <div>
            <div style={{ marginBottom: 4 }}>项目</div>
            <Select
              style={{ width: 320 }}
              placeholder="选择一个项目"
              value={projectId || undefined}
              options={projectOptions}
              onChange={(value) => {
                const next = String(value)
                confirmLeaveThen(() => {
                  setProjectId(next)
                  setChapterId('')
                  setRead(null)
                  setPlan(null)
                  setConfirmResult(null)
                  void openChapter(next, cardDraft.name)
                })
              }}
            />
          </div>
          {chapterId && <Text type="secondary">当前集：{chapterTitle || '未命名'}（章节编号见下方技术详情）</Text>}
          {read?.ad_phase_label && <Tag color="blue">{read.ad_phase_label}</Tag>}
          {read?.meta?.dry_run === true && <Tag color="orange">演练模式：本页不会真实调用模型</Tag>}
          {/*
            项目选择卡里的「新建广告视频」是**次级**按钮：本页的主色按钮只有一个，
            并且落在"还没有项目"那时的空态里（任务书 §3.3 要求的唯一明确主操作）。
            这里用次级是为了不出现两个同义的主色按钮抢注意力。
          */}
          <Button
            data-testid="drama-plan-create-ad-project"
            onClick={() => setAdCreateOpen(true)}
          >
            新建广告视频
          </Button>
        </Space>
      </Card>

      {error && <Alert type="error" showIcon style={{ marginBottom: 16 }} message="出错了" description={error} />}
      {notice && <Alert type="success" showIcon style={{ marginBottom: 16 }} message={notice} />}
      {staleNotices.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="有一部分内容可能已经过期"
          description={
            <ul style={{ marginBottom: 0 }}>
              {staleNotices.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          }
        />
      )}
      {(read?.error || '').trim() !== '' && (
        <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="上次生成失败" description={read?.error} />
      )}

      {!chapterId ? (
        /*
          本轮收口（任务书 §3.3）：原来这里只有一句 Empty，没有项目时用户**必须离开本页**
          才能建项目。现在给出唯一明确主操作「新建广告视频」——
          它复用与「广告视频」列表页完全相同的创建组件（同默认值、同校验、同一条提交逻辑），
          固定创建 `kind=ad`，创建成功后自动建默认章节并回到本页的策划工作台。
        */
        <Card data-testid="drama-plan-empty">
          <div className="py-6 text-center">
            <div className="mb-1 text-base font-medium text-gray-800">还没有可策划的广告项目</div>
            <div className="mb-4 text-xs text-gray-500">
              剧情策划是章节级的：先有一个广告项目（会自动建立默认章节），再从商品资料开始做。
              如果你已经有广告项目，直接在上面的「项目」里选一个即可（会自动取一集没有分镜的空章节）。
            </div>
            <Button
              type="primary"
              size="large"
              data-testid="drama-plan-empty-create"
              onClick={() => setAdCreateOpen(true)}
            >
              新建广告视频
            </Button>
          </div>
        </Card>
      ) : (
        <Spin spinning={busy !== 'idle'}>
          {/* ============================ 1. 商品信息卡 ============================ */}
          <Card
            title="1. 商品信息卡"
            size="small"
            style={{ marginBottom: 16 }}
            extra={
              <Space wrap>
                {card?.confirmed && !cardDirty ? (
                  <Tag color="green">已确认</Tag>
                ) : (
                  <Tag color="gold">未确认</Tag>
                )}
                <Text type="secondary">保存与确认都是免费的</Text>
              </Space>
            }
          >
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message={
                cardPending
                  ? `${cardPending}（缺项不会被编造，补齐后可随时再保存）`
                  : '必填项已齐：可以确认商品卡'
              }
            />
            <Form layout="vertical">
              <Row gutter={12}>
                <Col xs={24} md={8}>
                  <Form.Item label={cardLabel('name', '商品名称（必填）')} required>
                    <Input
                      value={cardDraft.name}
                      placeholder="例：紧致焕颜精华"
                      onChange={(event) => setCardDraft({ ...cardDraft, name: event.target.value })}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={8}>
                  <Form.Item label={cardLabel('category', '品类')}>
                    <Input
                      value={cardDraft.category}
                      placeholder="例：护肤精华"
                      onChange={(event) => setCardDraft({ ...cardDraft, category: event.target.value })}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={8}>
                  <Form.Item label={cardLabel('brand', '品牌')}>
                    <Input
                      value={cardDraft.brand}
                      onChange={(event) => setCardDraft({ ...cardDraft, brand: event.target.value })}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label={cardLabel('selling_points', '核心卖点（一行一条）')}>
                    <Input.TextArea
                      rows={3}
                      value={arrayToLines(cardDraft.selling_points)}
                      placeholder={'例：7 天见效果\n成分温和不刺激'}
                      onChange={(event) =>
                        setCardDraft({ ...cardDraft, selling_points: linesToArray(event.target.value) })
                      }
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label={cardLabel('scenarios', '使用场景（一行一条）')}>
                    <Input.TextArea
                      rows={3}
                      value={arrayToLines(cardDraft.scenarios)}
                      placeholder={'例：通勤地铁上补妆\n熬夜加班后急救'}
                      onChange={(event) => setCardDraft({ ...cardDraft, scenarios: linesToArray(event.target.value) })}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label={cardLabel('audience', '目标人群')}>
                    <Input
                      value={cardDraft.audience}
                      placeholder="例：25-35 岁通勤女性"
                      onChange={(event) => setCardDraft({ ...cardDraft, audience: event.target.value })}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label={cardLabel('price_info', '价格或促销信息')}>
                    <Input
                      value={cardDraft.price_info}
                      placeholder="例：首发 199 元，买一送一"
                      onChange={(event) => setCardDraft({ ...cardDraft, price_info: event.target.value })}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label={cardLabel('compliance', '禁止表达与合规要求')}>
                    <Input.TextArea
                      rows={2}
                      value={cardDraft.compliance}
                      placeholder="例：不得出现「根治」「最有效」等绝对化用语"
                      onChange={(event) => setCardDraft({ ...cardDraft, compliance: event.target.value })}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label={cardLabel('notes', '补充说明')}>
                    <Input.TextArea
                      rows={2}
                      value={cardDraft.notes}
                      placeholder="其它需要知道的背景、口径或参考资料要点"
                      onChange={(event) => setCardDraft({ ...cardDraft, notes: event.target.value })}
                    />
                  </Form.Item>
                </Col>
              </Row>

              <Divider style={{ margin: '4px 0 12px' }}>参考资料</Divider>
              <Space wrap size="middle" align="start">
                <Upload
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  showUploadList={false}
                  beforeUpload={(file) => {
                    void onUploadReferenceImage(file as unknown as File)
                    return false
                  }}
                >
                  <Button loading={busy === 'card-upload'}>上传商品图片（归档）</Button>
                </Upload>
                <Upload
                  accept=".txt,.md,.docx"
                  showUploadList={false}
                  beforeUpload={(file) => {
                    void onParseDocument(file as unknown as File)
                    return false
                  }}
                >
                  <Button loading={busy === 'card-upload'}>上传文档解析成文本（TXT / MD / DOCX）</Button>
                </Upload>
                <Text type="secondary">
                  图片走归档（保存后进入商品卡参考资料）；文档只解析出文字，不会上传存储。
                </Text>
              </Space>
              {cardDraft.reference_files.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <Space wrap size={4}>
                    {cardDraft.reference_files.map((item) => (
                      <Tag
                        key={`${item.file_id}-${item.name}`}
                        closable
                        onClose={() =>
                          setCardDraft({
                            ...cardDraft,
                            reference_files: cardDraft.reference_files.filter((other) => other !== item),
                          })
                        }
                      >
                        {item.name || '未命名参考资料'}
                      </Tag>
                    ))}
                  </Space>
                </div>
              )}

              <Divider style={{ margin: '12px 0' }} />
              <Space wrap>
                <Button
                  onClick={() => void run('card-save', async () => {
                    const ok = await saveCardOnly(Boolean(card?.confirmed))
                    if (ok) setNotice('商品信息卡已保存（没有调用模型）。')
                  })}
                  disabled={busy !== 'idle' || !cardDirty}
                >
                  保存商品卡
                </Button>
                <Button
                  /* 次级按钮：本页的**唯一主操作**是底部的「确认策划」（设计包 §5.4：一个操作区只允许一个主色按钮，
                     而任务书第七部分明确「确认策划是策划阶段唯一主要操作」） */
                  disabled={busy !== 'idle' || !cardDraft.name.trim() || (card?.confirmed === true && !cardDirty)}
                  onClick={() => void run('card-save', async () => {
                    const ok = await saveCardOnly(true)
                    if (ok) setNotice('商品卡已确认：现在可以生成剧情了。')
                  })}
                >
                  {cardDirty ? '保存并确认商品卡' : '确认商品卡'}
                </Button>
                <Button onClick={onOpenExtract} disabled={busy !== 'idle'}>
                  从资料提取（将调用 1 次模型）
                </Button>
                {warnings.length > 0 && <Tag color="orange">{`本次有 ${warnings.length} 条提示`}</Tag>}
              </Space>

              <TechnicalDetailSection
                testId="product-card-technical-detail"
                hint="资料来源、原文字数、提取时间与最后更新时间"
              >
                <Descriptions size="small" column={1} bordered>
                  <Descriptions.Item label="商品卡接口">
                    {`GET / PUT /api/v1/studio/projects/{项目}/product-card；提取 POST …/product-card/extract`}
                  </Descriptions.Item>
                  <Descriptions.Item label="数据库字段">
                    商品卡表：name / category / brand / selling_points / audience / scenarios / price_info /
                    compliance / notes / reference_files / source_type / source_summary / missing_fields /
                    missing_labels / confirmed / updated_at
                  </Descriptions.Item>
                  <Descriptions.Item label="资料来源原始值">
                    {String(card?.source_type ?? '') || '（未记录）'}
                  </Descriptions.Item>
                  <Descriptions.Item label="缺项原始键">
                    {(card?.missing_fields ?? []).join('、') || '（没有缺项）'}
                  </Descriptions.Item>
                  <Descriptions.Item label="确认状态原文">
                    {card?.confirmed ? 'confirmed=true' : 'confirmed=false'}
                  </Descriptions.Item>
                  <Descriptions.Item label="来源与更新时间">
                    {String(card?.updated_at ?? '') || '（后端没有给出更新时间）'}
                  </Descriptions.Item>
                  <Descriptions.Item label="来源明细原文">
                    <pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap' }}>
                      {JSON.stringify(card?.source_summary ?? {}, null, 2)}
                    </pre>
                  </Descriptions.Item>
                  <Descriptions.Item label="后端备注原文">{card?.note || '（没有备注）'}</Descriptions.Item>
                </Descriptions>
              </TechnicalDetailSection>
            </Form>
          </Card>

          {/* ============================ 2. 剧情策划 ============================ */}
          <Card title="2. 剧情策划（分层生成：一句话 → 完整剧情 → 分镜）" size="small" style={{ marginBottom: 16 }}>
            <Form layout="vertical">
              <Row gutter={12}>
                <Col xs={24} md={14}>
                  <Form.Item label="一句话核心创意">
                    <Input
                      value={plan?.one_liner ?? ''}
                      placeholder="例：加班女孩在地铁里被一瓶精华救回了体面"
                      onChange={(event) => updateOneLiner(event.target.value)}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={10}>
                  <Form.Item label="受众情绪目标">
                    <Input
                      value={plan?.audience_emotion ?? ''}
                      placeholder="例：先共情疲惫，再爽感反转"
                      onChange={(event) =>
                        setPlan((current) => ({
                          ...(current ?? emptyPlanDraft()),
                          audience_emotion: event.target.value,
                        }))
                      }
                    />
                  </Form.Item>
                </Col>
              </Row>

              <Form.Item label="完整剧情全文（可读可编辑；确认策划后写进章节原文）">
                <Input.TextArea
                  rows={10}
                  value={plan?.story?.full_text ?? ''}
                  placeholder="完整剧情正文。未生成时可以自己写；生成后这里就是全文，直接改。"
                  onChange={(event) => updateStory({ full_text: event.target.value })}
                />
              </Form.Item>

              <Row gutter={12}>
                <Col xs={24} md={8}>
                  <Form.Item label="钩子（前 3 秒）">
                    <Input.TextArea rows={3} value={plan?.story?.hook ?? ''} onChange={(event) => updateStory({ hook: event.target.value })} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={8}>
                  <Form.Item label="冲突">
                    <Input.TextArea rows={3} value={plan?.story?.conflict ?? ''} onChange={(event) => updateStory({ conflict: event.target.value })} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={8}>
                  <Form.Item label="商品介入">
                    <Input.TextArea
                      rows={3}
                      value={plan?.story?.product_usage ?? ''}
                      onChange={(event) => updateStory({ product_usage: event.target.value })}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label="高潮反转">
                    <Input.TextArea rows={3} value={plan?.story?.climax ?? ''} onChange={(event) => updateStory({ climax: event.target.value })} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label="结尾引导">
                    <Input.TextArea rows={3} value={plan?.story?.cta ?? ''} onChange={(event) => updateStory({ cta: event.target.value })} />
                  </Form.Item>
                </Col>
              </Row>

              <Divider style={{ margin: '0 0 12px' }}>制作要求（新建项目时填过，这里可以调整；保存免费）</Divider>
              <Row gutter={12}>
                <Col xs={24} md={6}>
                  <Form.Item label="题材">
                    <Input
                      value={brief.genre}
                      placeholder="留空沿用项目"
                      onChange={(event) => setBrief({ ...brief, genre: event.target.value })}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={6}>
                  <Form.Item label="调性">
                    <Input
                      value={brief.tone}
                      placeholder="例：一本正经地荒诞"
                      onChange={(event) => setBrief({ ...brief, tone: event.target.value })}
                    />
                  </Form.Item>
                </Col>
                <Col xs={12} md={3}>
                  <Form.Item label="镜头数">
                    <InputNumber
                      min={1}
                      max={16}
                      value={brief.shot_count}
                      onChange={(value) => setBrief({ ...brief, shot_count: Number(value ?? 6) })}
                    />
                  </Form.Item>
                </Col>
                <Col xs={12} md={3}>
                  <Form.Item label="时长（秒，0=自动）">
                    <InputNumber
                      min={0}
                      max={600}
                      value={brief.duration_seconds}
                      onChange={(value) => setBrief({ ...brief, duration_seconds: Number(value ?? 0) })}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={6}>
                  <Form.Item label="导演备注">
                    <Input
                      value={brief.director_notes}
                      placeholder="例：不要旁白、结尾不要硬引导"
                      onChange={(event) => setBrief({ ...brief, director_notes: event.target.value })}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={6}>
                  <Form.Item label="必须出现（一行一条）">
                    <Input.TextArea
                      rows={2}
                      value={arrayToLines(brief.mandatory_elements)}
                      onChange={(event) => setBrief({ ...brief, mandatory_elements: linesToArray(event.target.value) })}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={6}>
                  <Form.Item label="禁止出现（一行一条）">
                    <Input.TextArea
                      rows={2}
                      value={arrayToLines(brief.forbidden_elements)}
                      onChange={(event) => setBrief({ ...brief, forbidden_elements: linesToArray(event.target.value) })}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item label=" ">
                    <Button onClick={() => void onSaveBrief()} disabled={busy !== 'idle'}>
                      保存制作要求（免费）
                    </Button>
                  </Form.Item>
                </Col>
              </Row>

              <Space wrap>
                <Button onClick={() => onGenerateStage('one_liner')} disabled={busy !== 'idle' || generating}>
                  生成一句话（将调用 1 次模型）
                </Button>
                <Button onClick={() => onGenerateStage('story')} disabled={busy !== 'idle' || generating}>
                  生成详细剧情（将调用 1 次模型）
                </Button>
                <Button onClick={() => onGenerateStage('storyboard')} disabled={busy !== 'idle' || generating}>
                  生成分镜（将调用 1 次模型）
                </Button>
                <Button ghost onClick={() => onGenerateStage('all')} disabled={busy !== 'idle' || generating}>
                  一次生成全部（将调用 1 次模型）
                </Button>
                <Button
                  onClick={() => void run('draft-save', async () => {
                    const ok = await savePlanDraft()
                    if (ok) setNotice('剧情草稿已保存（免费）。刷新或换设备回来还能看到。')
                  })}
                  disabled={busy !== 'idle' || !planDirty}
                >
                  保存剧情草稿
                </Button>
                <Button onClick={() => void onCheckConsistency()} disabled={busy !== 'idle' || !planHasContent(plan)}>
                  一致性检查（免费）
                </Button>
              </Space>
              <div style={{ marginTop: 8 }}>
                <Text type="secondary">
                  分阶段规则：详细剧情必须基于已填写的一句话；分镜必须基于当前完整剧情。
                  重新生成前会二次确认，检测到人工编辑晚于上次生成时会提示「会覆盖你的修改」。
                </Text>
              </div>

              {consistency && (
                <Alert
                  style={{ marginTop: 12 }}
                  type={(consistency.issues ?? []).length > 0 ? 'warning' : 'success'}
                  showIcon
                  message={consistency.summary?.text || '一致性检查'}
                  description={
                    (consistency.issues ?? []).length > 0 ? (
                      <ul style={{ marginBottom: 0 }}>
                        {(consistency.issues ?? []).map((issue, index) => (
                          <li key={`${index}-${String(issue.code ?? issue.message ?? '')}`}>
                            {String(issue.message || '这一条检查没有中文说明，见下方技术详情')}
                            {issue.fix ? `（建议：${String(issue.fix)}）` : ''}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      '没有发现问题（商品覆盖、人物、冲突与结局、分镜引用都通过）。'
                    )
                  }
                />
              )}

              {warnings.length > 0 && (
                <Alert
                  style={{ marginTop: 12 }}
                  type="info"
                  showIcon
                  message="生成与提取过程中的提示"
                  description={
                    <ul style={{ marginBottom: 0 }}>
                      {warnings.map((item, index) => (
                        <li key={`${index}-${item}`}>{item}</li>
                      ))}
                    </ul>
                  }
                />
              )}
            </Form>
          </Card>

          {/* ============================ 3. 资产预览 ============================ */}
          <Card title="3. 资产预览（确认策划后落成正式资产）" size="small" style={{ marginBottom: 16 }}>
            <Text type="secondary">
              商品会作为正式资产落库；商品必须出现在至少一半镜头里，否则确认会被拒绝。
              当前分镜里出现商品 {coverage.present}/{coverage.total} 个镜头
              {coverage.total === 0 ? '（还没有分镜）' : coverage.enough ? '，够一半' : '，还不够一半'}。
            </Text>
            <Divider style={{ margin: '12px 0' }} />
            <Row gutter={[12, 12]}>
              {(plan?.characters ?? []).map((item) => (
                <Col xs={24} sm={12} md={8} key={`character-${item.name}`}>
                  <Card size="small" title={`人物 · ${item.name}`}>
                    <div>关系：{item.relation || '未标注'}</div>
                    <div style={{ marginTop: 4 }}>
                      {Object.entries(item.profile ?? {}).slice(0, 3).map(([key, value]) => (
                        <div key={key} style={{ fontSize: 12 }}>
                          {profileFieldLabel(key)}：{String(value)}
                        </div>
                      ))}
                    </div>
                  </Card>
                </Col>
              ))}
              {(plan?.scenes ?? []).map((item) => (
                <Col xs={24} sm={12} md={8} key={`scene-${item.name}`}>
                  <Card size="small" title={`场景 · ${item.name}`}>
                    <div>{Object.entries(item.profile ?? {}).slice(0, 3).map(([key, value]) => `${profileFieldLabel(key)}：${String(value)}`).join('；') || '资料待补充'}</div>
                  </Card>
                </Col>
              ))}
              {(plan?.props ?? []).map((item) => (
                <Col xs={24} sm={12} md={8} key={`prop-${item.name}`}>
                  <Card size="small" title={`道具 · ${item.name}`}>
                    <div>{Object.entries(item.profile ?? {}).slice(0, 3).map(([key, value]) => `${profileFieldLabel(key)}：${String(value)}`).join('；') || '资料待补充'}</div>
                  </Card>
                </Col>
              ))}
              {plan?.product && (
                <Col xs={24} sm={12} md={8}>
                  <Card size="small" title={`商品 · ${plan.product.name}`}>
                    <div>{plan.product.description || '外观描述待补充'}</div>
                  </Card>
                </Col>
              )}
              {!(plan?.characters ?? []).length && !(plan?.scenes ?? []).length && !plan?.product && (
                <Col span={24}>
                  <Empty description="还没有可预览的资产：先确认商品卡，再生成剧情与分镜" />
                </Col>
              )}
            </Row>
            {!(plan?.props ?? []).length && (
              <div style={{ marginTop: 8 }}>
                <Text type="secondary">本版剧情方案里没有道具（后端没有给出道具清单，不另行编造）。</Text>
              </div>
            )}
          </Card>

          {/* ============================ 4. 分镜卡片 ============================ */}
          <Card title={`4. 分镜卡片（${plan?.shots.length ?? 0} 镜，可直接编辑）`} size="small" style={{ marginBottom: 16 }}>
            {!(plan?.shots ?? []).length ? (
              <Empty description="还没有分镜：先有完整剧情，再点「生成分镜」" />
            ) : (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                {(plan?.shots ?? []).map((shot) => (
                  <Card
                    key={shot.index}
                    size="small"
                    title={`第 ${shot.index} 镜 · ${shot.title || '未命名'}`}
                    extra={shot.product_present ? <Tag color="gold">出现商品</Tag> : <Tag>不出现商品</Tag>}
                  >
                    <Row gutter={12}>
                      <Col xs={24} md={8}>
                        <div style={{ marginBottom: 4 }}>标题</div>
                        <Input value={shot.title} onChange={(event) => updateShot(shot.index, { title: event.target.value })} />
                      </Col>
                      <Col xs={24} md={8}>
                        <div style={{ marginBottom: 4 }}>出场角色</div>
                        <Select
                          mode="multiple"
                          style={{ width: '100%' }}
                          value={shot.characters}
                          options={characterNames.map((name) => ({ value: name, label: name }))}
                          onChange={(value) => updateShot(shot.index, { characters: value })}
                        />
                      </Col>
                      <Col xs={6} md={2}>
                        <div style={{ marginBottom: 4 }}>时长(秒)</div>
                        <InputNumber
                          min={1}
                          max={60}
                          value={shot.duration}
                          onChange={(value) => updateShot(shot.index, { duration: Number(value ?? 0) })}
                        />
                      </Col>
                      <Col xs={6} md={2}>
                        <div style={{ marginBottom: 4 }}>景别</div>
                        <Select
                          style={{ width: '100%' }}
                          value={canonicalEnumValue(SHOT_SIZE, shot.camera_shot) ?? undefined}
                          options={SHOT_SIZE_OPTIONS}
                          placeholder={labelFor(SHOT_SIZE, shot.camera_shot)}
                          onChange={(value) => updateShot(shot.index, { camera_shot: value })}
                        />
                      </Col>
                      <Col xs={6} md={2}>
                        <div style={{ marginBottom: 4 }}>机位</div>
                        <Select
                          style={{ width: '100%' }}
                          value={canonicalEnumValue(CAMERA_ANGLE, shot.angle) ?? undefined}
                          options={ANGLE_OPTIONS}
                          placeholder={labelFor(CAMERA_ANGLE, shot.angle)}
                          onChange={(value) => updateShot(shot.index, { angle: value })}
                        />
                      </Col>
                      <Col xs={6} md={2}>
                        <div style={{ marginBottom: 4 }}>运镜</div>
                        <Select
                          style={{ width: '100%' }}
                          value={canonicalEnumValue(CAMERA_MOVEMENT, shot.movement) ?? undefined}
                          options={MOVEMENT_OPTIONS}
                          placeholder={labelFor(CAMERA_MOVEMENT, shot.movement)}
                          onChange={(value) => updateShot(shot.index, { movement: value })}
                        />
                      </Col>
                    </Row>
                    <Row gutter={12} style={{ marginTop: 8 }}>
                      <Col xs={24} md={12}>
                        <div style={{ marginBottom: 4 }}>动作（一行一拍）</div>
                        <Input.TextArea
                          rows={3}
                          value={arrayToLines(shot.action_beats)}
                          onChange={(event) => updateShot(shot.index, { action_beats: linesToArray(event.target.value) })}
                        />
                      </Col>
                      <Col xs={24} md={12}>
                        <div style={{ marginBottom: 4 }}>台词（可加行、可改表述方式）</div>
                        <Space direction="vertical" size={4} style={{ width: '100%' }}>
                          {shot.dialogue.map((line, lineIndex) => (
                            <Space key={`${shot.index}-${lineIndex}`} wrap size={4}>
                              <Input
                                style={{ width: 110 }}
                                value={line.speaker}
                                placeholder="说话人"
                                onChange={(event) =>
                                  updateShot(shot.index, {
                                    dialogue: shot.dialogue.map((item, index) =>
                                      index === lineIndex ? { ...item, speaker: event.target.value } : item,
                                    ),
                                  })
                                }
                              />
                              <Select
                                style={{ width: 120 }}
                                value={canonicalEnumValue(DIALOGUE_LINE_MODE, line.mode) ?? undefined}
                                options={DIALOGUE_MODE_OPTIONS}
                                placeholder={labelFor(DIALOGUE_LINE_MODE, line.mode)}
                                onChange={(value) =>
                                  updateShot(shot.index, {
                                    dialogue: shot.dialogue.map((item, index) =>
                                      index === lineIndex ? { ...item, mode: value } : item,
                                    ),
                                  })
                                }
                              />
                              <Input
                                style={{ width: 320 }}
                                value={line.text}
                                placeholder="台词内容"
                                onChange={(event) =>
                                  updateShot(shot.index, {
                                    dialogue: shot.dialogue.map((item, index) =>
                                      index === lineIndex ? { ...item, text: event.target.value } : item,
                                    ),
                                  })
                                }
                              />
                              <Button
                                size="small"
                                type="text"
                                danger
                                onClick={() =>
                                  updateShot(shot.index, {
                                    dialogue: shot.dialogue.filter((_item, index) => index !== lineIndex),
                                  })
                                }
                              >
                                删除
                              </Button>
                            </Space>
                          ))}
                          <Button
                            size="small"
                            onClick={() =>
                              updateShot(shot.index, {
                                dialogue: [...shot.dialogue, { speaker: '', text: '', mode: 'DIALOGUE' }],
                              })
                            }
                          >
                            加一句台词
                          </Button>
                        </Space>
                      </Col>
                    </Row>
                    <Row gutter={12} style={{ marginTop: 8 }} align="middle">
                      <Col>
                        <Space>
                          <span>本镜出现商品</span>
                          <Switch
                            checked={shot.product_present}
                            onChange={(checked) => updateShot(shot.index, { product_present: checked })}
                          />
                        </Space>
                      </Col>
                      <Col flex="auto">
                        <Text type="secondary">
                          画面描述：{shot.description || '（未填写）'}｜剧本摘录：{shot.script_excerpt || '（未填写）'}
                        </Text>
                      </Col>
                    </Row>
                  </Card>
                ))}
              </Space>
            )}
            <Divider style={{ margin: '12px 0' }} />
            <Text type="secondary">
              枚举字段（景别 / 机位 / 运镜 / 表述方式）一律显示中文；下游按原始编码执行，
              编码只出现在下方技术详情与生成记录里。
            </Text>
          </Card>

          {/* ============================ 5. 底部唯一主要操作 ============================ */}
          <Card size="small" style={{ marginBottom: 16 }}>
            {confirmedAlready ? (
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                <Space wrap>
                  <Text strong>策划已确认</Text>
                  <Tag color="green">
                    {`镜头 ${String(confirmSummary?.shots_created ?? 0)} 个 · 资产 ${String(
                      confirmSummary?.assets_created ?? '—',
                    )} 个 · 关联 ${String(confirmSummary?.materials_linked ?? confirmSummary?.shot_product_links ?? 0)} 行`}
                  </Tag>
                </Space>
                {confirmSummary && (
                  <Descriptions size="small" column={2} bordered>
                    <Descriptions.Item label="新建镜头">{String(confirmSummary.shots_created ?? 0)}</Descriptions.Item>
                    <Descriptions.Item label="更新镜头">{String(confirmSummary.shots_updated ?? 0)}</Descriptions.Item>
                    <Descriptions.Item label="新建资产">
                      {String(confirmSummary.assets_created ?? '（后端未给出）')}
                    </Descriptions.Item>
                    <Descriptions.Item label="关联记录">
                      {String(confirmSummary.materials_linked ?? '（后端未给出）')}
                    </Descriptions.Item>
                    <Descriptions.Item label="带商品镜头">
                      {String(confirmSummary.shot_product_links ?? 0)}
                    </Descriptions.Item>
                    <Descriptions.Item label="角色关联镜头">
                      {String(confirmSummary.shot_character_links ?? 0)}
                    </Descriptions.Item>
                    <Descriptions.Item label="跳过项">
                      {(confirmSummary.skipped as string[] | undefined)?.join('、') || '（没有跳过项）'}
                    </Descriptions.Item>
                    <Descriptions.Item label="警告">
                      {(confirmSummary.warnings as string[] | undefined)?.join('、') || '（没有警告）'}
                    </Descriptions.Item>
                  </Descriptions>
                )}
                <Space wrap>
                  <Button type="primary" size="large" onClick={goNextStep} disabled={!nextStepPath}>
                    继续准备资产
                  </Button>
                  <Button
                    size="large"
                    disabled={busy !== 'idle' || !cardConfirmed || generating}
                    onClick={() =>
                      Modal.confirm({
                        title: '再确认一次策划？',
                        content: '重复确认是幂等的：已有的镜头与资产不会重复新建，只会按策划内容更新。',
                        okText: '重新确认策划',
                        cancelText: '取消',
                        onOk: () => onConfirmPlan(),
                      })
                    }
                  >
                    重新确认策划
                  </Button>
                  <Text type="secondary">进入第 2 步：为这一集准备人物 / 场景 / 道具 / 商品资产。</Text>
                </Space>
              </Space>
            ) : (
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                <Space wrap>
                  <Button
                    type="primary"
                    size="large"
                    disabled={busy !== 'idle' || !cardConfirmed || !planHasContent(plan) || generating}
                    onClick={() =>
                      Modal.confirm({
                        title: '确认策划并落库？',
                        content:
                          '确认后会把完整剧情写入章节、把镜头与资产落成正式数据（重复确认不会重复新建）。' +
                          '确认之前的一切都还只是草稿。',
                        okText: '确认策划',
                        cancelText: '再改改',
                        onOk: () => onConfirmPlan(),
                      })
                    }
                  >
                    确认策划
                  </Button>
                  <Text type="secondary">
                    {!cardConfirmed
                      ? '先确认商品卡（必填项要齐）才能确认策划。'
                      : !planHasContent(plan)
                        ? '还没有可确认的剧情：先生成或填写一句话、完整剧情或分镜。'
                        : `确认后进入第 2 步资产准备（当前商品覆盖 ${coverage.present}/${coverage.total} 镜）。`}
                  </Text>
                </Space>
                {planDirty && <Text type="warning">草稿有未保存修改：建议先「保存剧情草稿」再确认。</Text>}
              </Space>
            )}
          </Card>

          {/* ============================ 技术详情（全仓唯一折叠壳） ============================ */}
          <TechnicalDetailSection testId="drama-plan-technical-detail" hint="编号、接口名、字段名、状态原文与更新时间">
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="项目 / 章节编号">
                {`project_id=${projectId || '（未选择）'}；chapter_id=${chapterId || '（未取到）'}；chapter_title=${chapterTitle || '（未取到）'}`}
              </Descriptions.Item>
              <Descriptions.Item label="接口名">
                {`GET /api/v1/studio/chapters/{章节}/drama-plan；POST …/drama-plan/generate {stage, confirm_overwrite}；`}
                {`PUT …/drama-plan/draft；POST …/drama-plan/consistency；POST …/drama-plan/confirm；`}
                {`POST /api/v1/studio/projects/{项目}/drama-plan/chapter；GET /api/v1/studio/entities/product`}
              </Descriptions.Item>
              <Descriptions.Item label="数据库字段">
                草稿表：plan / brief / status / story_status / stale_flags / manual_edited_at / confirmed_at /
                materialized_at / materialize_summary；落库后写章节表、镜头表、镜头明细表、台词表、资产表与
                drama_plan_materials（entity_type / entity_id / source）
              </Descriptions.Item>
              <Descriptions.Item label="状态原文">
                {`status=${read?.status ?? ''}；story_status=${read?.story_status ?? ''}；ad_phase=${read?.ad_phase ?? ''}；`}
                {`confirmed=${String(card?.confirmed ?? false)}；generating=${String(generating)}`}
              </Descriptions.Item>
              <Descriptions.Item label="过期标记原文">
                <pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap' }}>
                  {JSON.stringify(read?.stale_flags ?? {}, null, 2)}
                </pre>
              </Descriptions.Item>
              <Descriptions.Item label="来源与更新时间">
                {`草稿更新时间=${read?.updated_at || '（未给出）'}；商品卡更新时间=${card?.updated_at || '（未给出）'}；`}
                {`章节原文长度=${String((plan?.story?.full_text ?? '').length)} 字`}
              </Descriptions.Item>
              <Descriptions.Item label="生成元信息原文">
                <pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap' }}>
                  {JSON.stringify(read?.meta ?? {}, null, 2)}
                </pre>
              </Descriptions.Item>
              <Descriptions.Item label="一致性检查原文">
                <pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap' }}>
                  {JSON.stringify(consistency ?? {}, null, 2)}
                </pre>
              </Descriptions.Item>
              <Descriptions.Item label="确认结果原文">
                <pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap' }}>
                  {JSON.stringify(confirmSummary ?? {}, null, 2)}
                </pre>
              </Descriptions.Item>
              <Descriptions.Item label="后端备注原文">
                <pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap' }}>{noteRaw || '（没有备注）'}</pre>
              </Descriptions.Item>
              <Descriptions.Item label="提示原文">
                <pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap' }}>
                  {JSON.stringify(warnings, null, 2)}
                </pre>
              </Descriptions.Item>
              <Descriptions.Item label="最近一次失败原文">
                <pre style={{ margin: 0, fontSize: 11, whiteSpace: 'pre-wrap' }}>{errorRaw || '（没有失败）'}</pre>
              </Descriptions.Item>
              <Descriptions.Item label="枚举编码（分镜）">
                {`景别=${SHOT_SIZE.values.join('/')}；机位=${CAMERA_ANGLE.values.join('/')}；`}
                {`运镜=${CAMERA_MOVEMENT.values.join('/')}；表述方式=${DIALOGUE_LINE_MODE.values.join('/')}`}
              </Descriptions.Item>
              <Descriptions.Item label="商品卡字段与阶段编码">
                {`字段=${PRODUCT_CARD_FIELD.values.join('/')}；来源=${PRODUCT_CARD_SOURCE_TYPE.values.join('/')}；`}
                {`阶段=${AD_PHASE.values.join('/')}`}
              </Descriptions.Item>
            </Descriptions>
          </TechnicalDetailSection>
        </Spin>
      )}

      {/* ---------------------------- 「从资料提取」弹窗 ---------------------------- */}
      <Modal
        title="从资料提取商品信息"
        open={extractOpen}
        onCancel={() => setExtractOpen(false)}
        onOk={() => void onExtract()}
        okText="开始提取（将调用 1 次模型）"
        cancelText="取消"
        confirmLoading={busy === 'card-extract'}
        width={640}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="这一步会调用 1 次模型（付费出口）"
          description="提取结果只回填表单、不落库：核对后要点「确认商品卡」才会保存。演练模式下不会真实调用，也不会有字段被编造。"
        />
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Select
            style={{ width: '100%' }}
            value={extractSource}
            options={[
              { value: 'paste', label: '粘贴资料' },
              { value: 'upload', label: '上传资料（TXT / DOCX）' },
              { value: 'existing', label: '选已有商品' },
            ]}
            onChange={(value) => setExtractSource(value as ExtractSourceType)}
          />
          <Text type="secondary">当前来源：{extractSourceLabel(extractSource)}</Text>

          {extractSource === 'paste' && (
            <>
              <Input.TextArea
                rows={8}
                value={extractText}
                placeholder="把商品详情、卖点、人群、价格等资料贴在这里"
                onChange={(event) => setExtractText(event.target.value)}
              />
              <Upload
                accept=".txt,.md,.docx"
                showUploadList={false}
                beforeUpload={(file) => {
                  void onParseDocument(file as unknown as File)
                  return false
                }}
              >
                <Button size="small" loading={busy === 'card-upload'}>
                  上传 TXT / MD / DOCX 解析成文本
                </Button>
              </Upload>
              {extractFileName && <Text type="secondary">已解析文件：{extractFileName}</Text>}
            </>
          )}

          {extractSource === 'upload' && (
            <>
              <Alert
                type="info"
                showIcon
                message="上传资料文件（TXT / MD / DOCX）或商品图片"
                description="文档会被后端解析出正文再提取；图片读不出文字，只作为商品参考资料归档（会一起存进商品卡）。也可以改用「粘贴资料」把正文先解析出来、确认无误后再提取。"
              />
              <Space wrap>
                <Upload
                  accept=".txt,.md,.docx"
                  showUploadList={false}
                  beforeUpload={(file) => {
                    void onUploadExtractDocument(file as unknown as File)
                    return false
                  }}
                >
                  <Button size="small" loading={busy === 'card-upload'}>
                    上传资料文件（TXT / DOCX）
                  </Button>
                </Upload>
                <Upload
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  showUploadList={false}
                  beforeUpload={(file) => {
                    void onUploadExtractImage(file as unknown as File)
                    return false
                  }}
                >
                  <Button size="small" loading={busy === 'card-upload'}>
                    上传商品参考图
                  </Button>
                </Upload>
              </Space>
              {extractUploadNames.length > 0 && (
                <Text type="secondary">已上传：{extractUploadNames.join('、')}</Text>
              )}
            </>
          )}

          {extractSource === 'existing' && (
            <>
              {productOptionsError ? (
                <Alert type="warning" showIcon message={productOptionsError} />
              ) : (
                <Select
                  style={{ width: '100%' }}
                  placeholder="选一个已有的商品资料"
                  value={extractExistingId || undefined}
                  options={productOptions.map((item) => ({
                    value: item.id,
                    label: item.name || item.description || '未命名商品',
                  }))}
                  onChange={(value) => setExtractExistingId(String(value))}
                />
              )}
            </>
          )}

          <Input
            value={extractInstructions}
            placeholder="补充要求（可选，例如：只关注卖点与人群，不要推断价格）"
            onChange={(event) => setExtractInstructions(event.target.value)}
          />
        </Space>
      </Modal>
    </StepShell>
    </>
  )
}

export default DramaPlanPage
