/**
 * 「新建广告视频（剧情广告）项目」的**唯一一份**创建逻辑。
 *
 * ## 为什么必须只有一个实现
 *
 * 用户有**两个**入口要新建广告项目：
 *   1. 「广告视频」列表页右上角的「新建广告视频」；
 *   2. 「剧情策划」页在没有项目时的唯一主操作「新建广告视频」。
 *
 * 产品口径要求这两处复用**同一个组件、同一份默认值、同一套校验、同一条提交逻辑**
 * （任务书 §3.3）。所以本模块把下面四件事全部收敛到一处：
 *
 * | 能力 | 实现 |
 * |---|---|
 * | 默认值 | `emptyAdProjectDraft()` |
 * | 校验 | `validateAdProjectDraft()`（**唯一**判据，组件只做展示） |
 * | 请求体 | `buildAdProjectCreateBody()` |
 * | 提交 | `createAdProject()` |
 *
 * ## 固定创建 `kind=ad`
 *
 * 这两个入口**不可能**建出普通短剧：起点被硬编成 `drama_ad`，
 * 由 `buildAdProjectCreateFields()` 换算出 `kind: 'ad'` + `ad_product_source` + `ad_requirements`，
 * 而 `start_mode` 仍走既有的 `toBackendStartMode('drama_ad')` → `'script'`。
 * 页面里**不显示**「生产方式」三选一，也就没有误建普通短剧的路径。
 *
 * ## 不新增第二套接口
 *
 * 提交仍然打在既有的 `POST /api/v1/studio/projects`，字段与列表页原来那套**逐字相同**
 * （`buildAdProjectCreateFields` 未改动）。默认章节仍然由后端在同一事务里建，
 * 前端只是把响应里的 `chapter_id` 用起来。
 */

import { StudioProjectsService } from '../../../services/generated'
import type { ProjectCreate } from '../../../services/generated'
/* 视觉表现的**真实**取值域：生成客户端里的 `ProjectVisualStyle` 是过期的（只有 '现实'），
   项目实际支持「现实 / 动漫」，所以这里用页面侧那份同口径的类型（与项目大厅一致）。 */
import type { ProjectVisualStyleChoice } from './ProjectVisualStyleAndStyleFields'
import {
  AD_DEFAULT_SHOT_COUNT,
  OVERALL_STYLE_PRESETS,
  buildAdProjectCreateFields,
  resolveOverallStyleFields,
  resolveProjectVideoRatio,
  toBackendStartMode,
  type AdProductSourceChoice,
  type OverallStyleKey,
} from './projectStartPresets'

/**
 * 广告项目新建表单的字段集。
 *
 * 与需求逐条对应：项目名称 / 项目简介 / 商品资料来源 / 整体风格 / 默认画幅 /
 * 基本制作要求（题材、调性、镜头数、时长、导演备注、必含、禁含）。
 */
export type AdProjectDraft = {
  name: string
  description: string
  productSource: AdProductSourceChoice
  productText: string
  productFileIds: string[]
  productId: string
  overallStyle: OverallStyleKey
  /** 「其他自定义」时用户自填的视觉表现与题材风格 */
  visualStyle: ProjectVisualStyleChoice
  style: string
  unifyStyle: boolean
  defaultVideoRatio: string
  genre: string
  tone: string
  shotCount: number
  durationSeconds: number
  directorNotes: string
  mandatoryElements: string
  forbiddenElements: string
}

/** 整体风格的默认预设（与既有「剧情广告」起点一致：真人竖屏）。 */
export const AD_DEFAULT_OVERALL_STYLE: OverallStyleKey = 'live_portrait'

/**
 * 两个入口共用的**同一份默认值**。
 *
 * 每次打开表单都从它开始（不保留上一次的残留），所以「同一个入口点两次」
 * 拿到的初始状态完全一致。
 */
export function emptyAdProjectDraft(): AdProjectDraft {
  return {
    name: '',
    description: '',
    productSource: 'paste',
    productText: '',
    productFileIds: [],
    productId: '',
    overallStyle: AD_DEFAULT_OVERALL_STYLE,
    visualStyle: '现实',
    style: OVERALL_STYLE_PRESETS[0]?.style ?? '真人都市',
    unifyStyle: true,
    /* 画幅的初值就是该风格的预设画幅（用户仍可改）—— 与项目大厅原实现同口径。 */
    defaultVideoRatio: resolveOverallStyleFields(AD_DEFAULT_OVERALL_STYLE)?.default_video_ratio ?? '',
    genre: '',
    tone: '',
    shotCount: AD_DEFAULT_SHOT_COUNT,
    durationSeconds: 0,
    directorNotes: '',
    mandatoryElements: '',
    forbiddenElements: '',
  }
}

/**
 * 表单校验（**唯一**判据）。
 *
 * 返回中文错误说明；返回空串表示可以提交。组件层的 `rules` 只是让用户更早看到提示，
 * 真正的判据在这里 —— 否则「按钮能点但后端 422」这类不一致会重新出现。
 */
export function validateAdProjectDraft(draft: AdProjectDraft): string {
  if (!String(draft.name ?? '').trim()) return '请填写项目名称。'
  return ''
}

/** 多行文本 → 一行一条的数组（必含 / 禁含）。与项目大厅原实现同口径。 */
export function linesToArray(value: string): string[] {
  return String(value ?? '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
}

/** 客户端生成的项目 ID（与项目大厅原来那份实现逐字相同，收敛到一处）。 */
export function newProjectId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `p_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

/**
 * 草稿 → 创建请求体。
 *
 * `kind` 恒为 `ad`（由 `buildAdProjectCreateFields` 保证），起点恒为 `drama_ad`。
 * 返回类型就是生成客户端的 `ProjectCreate`，字段名写错会直接编译失败。
 */
export function buildAdProjectCreateBody(draft: AdProjectDraft, projectId: string): ProjectCreate {
  const preset = resolveOverallStyleFields(draft.overallStyle)
  const adFields = buildAdProjectCreateFields({
    startMode: 'drama_ad',
    productSource: {
      choice: draft.productSource,
      text: draft.productText,
      fileIds: draft.productFileIds,
      productId: draft.productId,
    },
    requirements: {
      genre: draft.genre,
      tone: draft.tone,
      shotCount: draft.shotCount,
      durationSeconds: draft.durationSeconds,
      directorNotes: draft.directorNotes,
      mandatoryElements: linesToArray(draft.mandatoryElements),
      forbiddenElements: linesToArray(draft.forbiddenElements),
    },
  })
  if (!adFields) {
    /* 不可达：起点是硬编的 `drama_ad`。留成显式抛错而不是静默降级，
       否则真出现分支漂移时会悄悄建出一个普通短剧项目。 */
    throw new Error('ad project create fields missing')
  }
  return {
    id: projectId,
    name: draft.name.trim(),
    description: draft.description ?? '',
    style: preset?.style ?? draft.style,
    /* ⚠️ 这里的 `as any` 与 `start_mode` 那条**不是同一类问题**：
       生成客户端里的 `ProjectVisualStyle` 是过期的（只有 '现实' 一个字面量），
       而项目实际支持「现实 / 动漫」。是否重新生成 OpenAPI 由总控决定，
       本批不动生成物（见 `services/dramaPlanApi.ts` 文件头的同一条说明）。 */
    visual_style: (preset?.visual_style ?? draft.visualStyle) as any,
    unify_style: draft.unifyStyle,
    default_video_ratio: resolveProjectVideoRatio(draft.overallStyle, draft.defaultVideoRatio),
    start_mode: toBackendStartMode('drama_ad'),
    progress: 0,
    ...adFields,
  }
}

/** 创建成功的结果：项目编号 + **后端建好的默认章节编号**。 */
export type AdProjectCreated = {
  projectId: string
  chapterId: string
  projectName: string
}

/**
 * 真正提交（两个入口共用这一条）。
 *
 * `id` 由调用方传入并在**整个提交过程里保持不变**：这样「连续点击」即使漏过了
 * 前端的提交锁，后端看到的也是同一个项目 ID（幂等），不会建出两个项目。
 */
export async function createAdProject(
  draft: AdProjectDraft,
  projectId: string,
): Promise<AdProjectCreated> {
  const res = await StudioProjectsService.createProjectApiV1StudioProjectsPost({
    requestBody: buildAdProjectCreateBody(draft, projectId),
  })
  const created = res.data
  if (!created) throw new Error('empty project')
  /* 剧情广告的默认章节是**后端在同一事务里建的**，响应里的 `chapter_id` 必须用上：
     策划页是章节级的，不带它就会退化成再建一集（多一集空章节）。 */
  const chapterId = String((created as unknown as Record<string, unknown>).chapter_id ?? '')
  return { projectId: String(created.id ?? projectId), chapterId, projectName: String(created.name ?? draft.name) }
}
