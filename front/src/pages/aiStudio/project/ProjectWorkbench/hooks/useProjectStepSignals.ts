import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StudioEntitiesService, StudioPromptDeliveryService, StudioShotLinksService, StudioShotsService } from '../../../../../services/generated'
import type { ProjectStepInput } from '../projectSteps'

/**
 * 六步流程判定所需的「轻量状态快照」抓取。
 *
 * 设计目标：
 * 1. 便宜：落地一次总共约 8 个请求（下面每个常量的取舍都写在注释里）；
 * 2. 防御：任何一个请求失败都不阻塞页面，只把对应信号降级为 0/未知，
 *    `resolveProjectStep` 因此会停在更靠前的步骤，而不是抛错或跳步；
 * 3. 可解释：把原始计数与失败来源一起返回，供「开发信息」面板展示。
 */

/** 项目-章节-镜头-实体关联支持的资产类型（后端 `_link_spec`）。 */
const LINK_ENTITY_TYPES = ['scene', 'prop', 'costume'] as const
type LinkEntityType = (typeof LINK_ENTITY_TYPES)[number]

const LINK_PAGE_SIZE = 100
/** 关联行最多翻 3 页（300 行/类型），避免大项目把落地页打爆。 */
const LINK_PAGE_LIMIT = 3
/** 角色绑定抽样镜头数：`shot_character_links` 只有按镜头查询的接口，只能抽样。 */
const BINDING_SAMPLE_LIMIT = 5

export type ProjectSignalAssetType = 'character' | 'scene' | 'prop' | 'costume'

export type ProjectSignalAsset = {
  id: string
  name: string
  type: ProjectSignalAssetType
  /** 已有参考图片（后端 thumbnail 非空即视为已有图） */
  hasImage: boolean
  /** 定版/缩略图地址（空串 = 还没有图）；第 3 步「查看定版图」用它，不额外发请求。 */
  thumbnail: string
  /** 已保存图片提示词；null = 本接口载荷没有暴露 `image_prompts`，无法判定 */
  hasImagePrompt: boolean | null
}

export type ProjectStepSignalDetail = {
  chapterCount: number
  chaptersWithTextCount: number
  focusChapterId: string | null
  focusChapterShotCount: number
  focusChapterShotsWithPrompt: number
  focusChapterShotsWithLinks: number
  bindingSampleSize: number
  projectShotCount: number
  projectShotsWithPrompt: number
  assetCounts: { characters: number; scenes: number; props: number; costumes: number }
  assetImageCount: number
  assetsWithImagePromptCount: number | null
  /** 抓取失败的信号来源（中文），空数组表示全部成功 */
  failedSources: string[]
}

export type ProjectStepSignalsResult = {
  loading: boolean
  /** 直接喂给 resolveProjectStep 的入参 */
  input: ProjectStepInput
  /** 项目资产清单（第 3 步「图片准备」用） */
  assets: ProjectSignalAsset[]
  detail: ProjectStepSignalDetail
  reload: () => void
}

const EMPTY_DETAIL: ProjectStepSignalDetail = {
  chapterCount: 0,
  chaptersWithTextCount: 0,
  focusChapterId: null,
  focusChapterShotCount: 0,
  focusChapterShotsWithPrompt: 0,
  focusChapterShotsWithLinks: 0,
  bindingSampleSize: 0,
  projectShotCount: 0,
  projectShotsWithPrompt: 0,
  assetCounts: { characters: 0, scenes: 0, props: 0, costumes: 0 },
  assetImageCount: 0,
  assetsWithImagePromptCount: null,
  failedSources: [],
}

/** 把 promise 包成「失败返回 null」，让单个接口失败不影响整体判定。 */
async function safeRequest<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise
  } catch {
    return null
  }
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function hasImagePromptField(item: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(item, 'image_prompts')
}

function imagePromptCount(item: Record<string, unknown>): number {
  const prompts = item['image_prompts']
  if (!prompts || typeof prompts !== 'object') return 0
  return Object.values(prompts as Record<string, unknown>).filter((value) => toText(value) !== '').length
}

/**
 * 拉取某类实体与项目/章节/镜头的全部关联行（分页，最多 3 页）。
 * 返回 null 表示接口失败（调用方降级处理）。
 */
async function fetchProjectLinkRows(
  entityType: LinkEntityType,
  projectId: string,
): Promise<Record<string, unknown>[] | null> {
  const rows: Record<string, unknown>[] = []
  let page = 1
  let total = Number.POSITIVE_INFINITY
  while (page <= LINK_PAGE_LIMIT && rows.length < total) {
    const res = await StudioShotLinksService.listProjectEntityLinksApiV1StudioShotLinksEntityTypeGet({
      entityType,
      projectId,
      chapterId: null,
      shotId: null,
      assetId: null,
      order: null,
      isDesc: false,
      page,
      pageSize: LINK_PAGE_SIZE,
    })
    const items = (res.data?.items ?? []) as Record<string, unknown>[]
    const reportedTotal = res.data?.pagination?.total
    total = typeof reportedTotal === 'number' && Number.isFinite(reportedTotal) ? reportedTotal : items.length
    rows.push(...items)
    if (items.length === 0) break
    page += 1
  }
  return rows
}

function linkAssetId(entityType: LinkEntityType, row: Record<string, unknown>): string {
  if (entityType === 'scene') return toText(row.scene_id)
  if (entityType === 'prop') return toText(row.prop_id)
  return toText(row.costume_id)
}

const ASSET_TYPE_LABEL: Record<ProjectSignalAssetType, string> = {
  character: '角色',
  scene: '场景',
  prop: '道具',
  costume: '服装',
}

export function getProjectSignalAssetTypeLabel(type: ProjectSignalAssetType): string {
  return ASSET_TYPE_LABEL[type]
}

export function useProjectStepSignals(args: {
  projectId: string | undefined
  chapters: { id: string; rawText?: string; storyboardCount?: number }[]
  focusChapterId: string | null
  /** 项目起点：prompts 时判定跳过剧本/分镜前置，直接落在整集提示词看板 */
  startMode?: 'script' | 'prompts'
}): ProjectStepSignalsResult {
  const { projectId, chapters, focusChapterId, startMode = 'script' } = args
  // 初值必须为 true：落地判定要等第一轮信号抓完，否则工作台会拿着空快照先跳到「剧本」。
  const [loading, setLoading] = useState(true)
  const [assets, setAssets] = useState<ProjectSignalAsset[]>([])
  const [detail, setDetail] = useState<ProjectStepSignalDetail>(EMPTY_DETAIL)
  const [input, setInput] = useState<ProjectStepInput>(() => ({
    chapterCount: 0,
    chaptersWithTextCount: 0,
  }))
  const [reloadToken, setReloadToken] = useState(0)

  // chapters 数组每次加载都是新对象，这里用「内容指纹」当依赖，避免无谓重抓。
  const chaptersKey = useMemo(
    () =>
      chapters
        .map((chapter) => `${chapter.id}:${chapter.rawText?.trim() ? 1 : 0}:${chapter.storyboardCount ?? 0}`)
        .join('|'),
    [chapters],
  )
  const projectIdRef = useRef(projectId)
  projectIdRef.current = projectId
  // chapters 只通过「内容指纹」参与依赖，这里用 ref 读最新值，避免数组身份变化导致重复抓取。
  const chaptersRef = useRef(chapters)
  chaptersRef.current = chapters

  useEffect(() => {
    let cancelled = false
    const chapterList = chaptersRef.current

    if (!projectId) {
      setAssets([])
      setDetail(EMPTY_DETAIL)
      setInput({ chapterCount: 0, chaptersWithTextCount: 0 })
      setLoading(false)
      return () => {
        cancelled = true
      }
    }

    const load = async () => {
      setLoading(true)
      const failedSources: string[] = []

      // —— 章节口径（本地已有数据，不额外发请求）——
      const chapterCount = chapterList.length
      const chaptersWithTextCount = chapterList.filter((chapter) => toText(chapter.rawText) !== '').length

      // —— 镜头 / 视频提示词：一次拿到项目全部镜头的 video_prompt（出口A 交付清单）——
      const deliveryRes = await safeRequest(
        StudioPromptDeliveryService.previewPromptDeliveryApiV1StudioPromptDeliveryProjectIdGet({
          projectId,
          scope: 'episodes',
        }),
      )
      if (!deliveryRes) failedSources.push('交付清单接口（镜头与视频提示词）')

      const deliveryRows = (deliveryRes?.data?.rows ?? []) as { shot_id?: string; chapter_id?: string; video_prompt?: string }[]
      const projectShotCount = deliveryRows.length
      const projectShotsWithPrompt = deliveryRows.filter((row) => toText(row.video_prompt) !== '').length
      const focusRows = focusChapterId
        ? deliveryRows.filter((row) => toText(row.chapter_id) === focusChapterId)
        : []
      // 交付清单拿不到时退回到章节自带的 storyboardCount，保证「有没有分镜」还可判定。
      const fallbackFocusShotCount = focusChapterId
        ? chapterList.find((chapter) => chapter.id === focusChapterId)?.storyboardCount ?? 0
        : chapterList.reduce((sum, chapter) => sum + (chapter.storyboardCount ?? 0), 0)
      const focusChapterShotCount = deliveryRes ? focusRows.length : fallbackFocusShotCount
      const focusChapterShotsWithPrompt = focusRows.filter((row) => toText(row.video_prompt) !== '').length
      const focusShotIds = new Set(focusRows.map((row) => toText(row.shot_id)).filter(Boolean))

      // —— 项目资产：角色挂在实体 project_id 上，场景/道具/服装挂在 project_*_links 上 ——
      const characterRes = await safeRequest(
        StudioEntitiesService.listEntitiesApiV1StudioEntitiesEntityTypeGet({
          entityType: 'character',
          q: null,
          page: 1,
          pageSize: 100,
        }),
      )
      if (!characterRes) failedSources.push('角色列表接口')

      const characterItems = ((characterRes?.data?.items ?? []) as Record<string, unknown>[]).filter(
        (item) => toText(item.project_id) === projectId,
      )

      const linkResults = await Promise.all(
        LINK_ENTITY_TYPES.map(async (entityType) => {
          const rows = await safeRequest(fetchProjectLinkRows(entityType, projectId))
          if (!rows) failedSources.push(`${ASSET_TYPE_LABEL[entityType]}关联接口`)
          return [entityType, rows ?? []] as const
        }),
      )

      const nextAssets: ProjectSignalAsset[] = []
      let promptFieldExposed = false

      characterItems.forEach((item) => {
        const id = toText(item.id)
        if (!id) return
        const exposed = hasImagePromptField(item)
        if (exposed) promptFieldExposed = true
        nextAssets.push({
          id,
          name: toText(item.name) || id,
          type: 'character',
          hasImage: toText(item.thumbnail) !== '',
          thumbnail: toText(item.thumbnail),
          hasImagePrompt: exposed ? imagePromptCount(item) > 0 : null,
        })
      })

      /** 镜头级关联（用于「关联绑定」判定）：shot_id 非空的行 */
      const shotIdsWithLinks = new Set<string>()

      linkResults.forEach(([entityType, rows]) => {
        const seen = new Set<string>()
        rows.forEach((row) => {
          const shotId = toText(row.shot_id)
          if (shotId) shotIdsWithLinks.add(shotId)
          // 资产口径：不论关联行挂在哪一层（项目级 shot_id 为空 / 镜头级），
          // 只要被本项目引用过就算「项目已有该资产」，否则迁移项目会被误判成「还没提取资产」。
          const assetId = linkAssetId(entityType, row)
          if (!assetId || seen.has(assetId)) return
          seen.add(assetId)
          const exposed = hasImagePromptField(row)
          if (exposed) promptFieldExposed = true
          nextAssets.push({
            id: assetId,
            name: toText(row.name) || assetId,
            type: entityType,
            hasImage: toText(row.thumbnail) !== '',
            thumbnail: toText(row.thumbnail),
            hasImagePrompt: exposed ? imagePromptCount(row) > 0 : null,
          })
        })
      })

      const assetCounts = {
        characters: nextAssets.filter((asset) => asset.type === 'character').length,
        scenes: nextAssets.filter((asset) => asset.type === 'scene').length,
        props: nextAssets.filter((asset) => asset.type === 'prop').length,
        costumes: nextAssets.filter((asset) => asset.type === 'costume').length,
      }
      const assetImageCount = nextAssets.filter((asset) => asset.hasImage).length
      const assetsWithImagePromptCount = promptFieldExposed
        ? nextAssets.filter((asset) => asset.hasImagePrompt === true).length
        : null

      // —— 角色绑定：后端只有按镜头查询的 shot_character_links，
      //    这里对当前集的前若干镜头抽样 `镜头准备聚合状态`（含 assets_overview.linked_count），
      //    仅当当前集已有视频提示词（说明已走到第 4 步之后）才值得花这几个请求。 ——
      let bindingSampleSize = 0
      if (focusChapterShotsWithPrompt > 0 && focusRows.length > 0) {
        const sampleShotIds = focusRows
          .map((row) => toText(row.shot_id))
          .filter(Boolean)
          .slice(0, BINDING_SAMPLE_LIMIT)
        bindingSampleSize = sampleShotIds.length
        const prepStates = await Promise.all(
          sampleShotIds.map((shotId) =>
            safeRequest(
              StudioShotsService.getShotPreparationStateApiApiV1StudioShotsShotIdPreparationStateGet({ shotId }),
            ),
          ),
        )
        if (prepStates.some((state) => state === null)) failedSources.push('镜头准备聚合状态接口')
        prepStates.forEach((state) => {
          const shotId = toText(state?.data?.shot?.id)
          const linkedCount = state?.data?.assets_overview?.summary?.linked_count ?? 0
          if (shotId && linkedCount > 0) shotIdsWithLinks.add(shotId)
        })
      }

      const focusChapterShotsWithLinks = focusShotIds.size
        ? Array.from(focusShotIds).filter((shotId) => shotIdsWithLinks.has(shotId)).length
        : 0

      if (cancelled || projectIdRef.current !== projectId) return

      setAssets(nextAssets)
      setDetail({
        chapterCount,
        chaptersWithTextCount,
        focusChapterId: focusChapterId ?? null,
        focusChapterShotCount,
        focusChapterShotsWithPrompt,
        focusChapterShotsWithLinks,
        bindingSampleSize,
        projectShotCount,
        projectShotsWithPrompt,
        assetCounts,
        assetImageCount,
        assetsWithImagePromptCount,
        failedSources,
      })
      setInput({
        startMode,
        chapterCount,
        chaptersWithTextCount,
        // 第 1-2 步与当前集绑定，镜头类信号按当前集口径传。
        shotCount: focusChapterShotCount,
        assetCounts,
        assetImageCount,
        assetsWithImagePromptCount,
        shotsWithVideoPromptCount: focusChapterShotsWithPrompt,
        shotsWithAssetLinkCount: focusChapterShotsWithLinks,
      })
      setLoading(false)
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [projectId, chaptersKey, focusChapterId, reloadToken, startMode])

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])

  return { loading, input, assets, detail, reload }
}
