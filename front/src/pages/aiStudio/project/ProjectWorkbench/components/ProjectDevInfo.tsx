import { useEffect, useMemo, useState } from 'react'
import { Button, Descriptions, Tag } from 'antd'
import { OpenAPI } from '../../../../../services/generated'
import { useGenerationGate } from '../../../components/generationGate'
import type { GenerationOutlet } from '../../../components/generationGate'
import type { ProjectStepInput, ProjectStepResolution } from '../projectSteps'
import type { ProjectStepSignalDetail } from '../hooks/useProjectStepSignals'
import {
  TechnicalDetailSection,
  TechnicalIdBlock,
  TechnicalModelProviderBlock,
} from './workbench/TechnicalDetailCollapse'

const SIGNAL_ENDPOINTS = [
  ['章节与原文', 'GET /api/v1/studio/chapters?project_id=…（字段 shot_count / raw_text）'],
  ['镜头与视频提示词', 'GET /api/v1/studio/prompt-delivery/{project_id}?scope=episodes（字段 shot_id / chapter_id / video_prompt）'],
  ['项目角色', 'GET /api/v1/studio/entities/character?page_size=100（字段 project_id / thumbnail / image_prompts）'],
  ['项目场景/道具/服装', 'GET /api/v1/studio/shot-links/{scene|prop|costume}?project_id=…（字段 shot_id / chapter_id / thumbnail）'],
  ['角色镜头绑定', 'GET /api/v1/studio/shots/{shot_id}/preparation-state（字段 assets_overview.summary.linked_count，按镜头抽样）'],
]

const STEP_PRECEDENCE = [
  '1. 没有章节或没有任何章节原文            → script（剧本）',
  '2. 有章节原文但当前集分镜数为 0           → script（剧本）',
  '3. 已有分镜但项目资产（角色/场景/道具）为空 → extract_assets（提取资产）',
  '4. 有资产但没有参考图片/图片提示词        → image_prep（图片准备）',
  '5. 有图片但当前集镜头都没有 video_prompt  → video_prompt（视频提示词）',
  '6. 有提示词但当前集镜头都没有关联资产      → binding（关联绑定）',
  '7. 以上都满足                            → generate_deliver（生成与交付）',
].join('\n')

/** 出口 → 默认模型字段（与后端 model-settings 的字段名一一对应）。 */
const DEFAULT_MODEL_KEYS: Record<GenerationOutlet, string> = {
  llm: 'default_text_model_id',
  image: 'default_image_model_id',
  video: 'default_video_model_id',
}

const OUTLET_LABEL: Record<GenerationOutlet, string> = {
  llm: '文本（提示词）',
  image: '图片（出图）',
  video: '视频',
}

/**
 * 外部传入的补充技术字段。
 *
 * 「任务编号 / 文件编号」只有在真的有任务或文件时才有值，所以做成可选：
 * 调用方拿到就传进来，由「技术详情」统一展示，普通页面上一律不出现。
 */
export type ProjectTechnicalExtras = {
  /** 本次操作相关的任务编号（例如批量出图任务） */
  taskIds?: string[]
  /** 本次操作相关的内部文件编号 */
  fileIds?: string[]
}

type ProjectDevInfoProps = {
  detail: ProjectStepSignalDetail
  model: ProjectStepInput
  resolution: ProjectStepResolution
  onReload: () => void
  /** 可选：任务编号 / 文件编号等内部标识，统一收进「技术详情」 */
  technical?: ProjectTechnicalExtras
}

type ModelRow = { id: string; name: string; category: string; providerId: string }
type ProviderRow = { id: string; name: string; status: string }

/** 只读取数：模型设置 / 模型表 / 生成服务表（不写库、不触网付费、不打印任何密钥）。 */
async function fetchJson(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${OpenAPI.BASE}${path}`)
  const text = await response.text()
  if (!response.ok) throw new Error(`GET ${path} 失败（HTTP ${response.status}）`)
  const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  return (payload?.data ?? {}) as Record<string, unknown>
}

async function fetchAllRows(path: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = []
  let page = 1
  let maxPage = 1
  do {
    const data = await fetchJson(`${path}${path.includes('?') ? '&' : '?'}page=${page}&page_size=100`)
    const items = Array.isArray(data?.items) ? (data.items as Record<string, unknown>[]) : []
    rows.push(...items)
    const pagination = (data?.pagination ?? {}) as { max_page?: number }
    maxPage = typeof pagination.max_page === 'number' && pagination.max_page > 0 ? pagination.max_page : 1
    page += 1
  } while (page <= maxPage && rows.length < 500)
  return rows
}

function readText(source: Record<string, unknown>, key: string): string {
  const value = source?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 「技术详情」折叠区（原名「开发信息」，默认收起）。
 *
 * 普通页面上只留用户能看懂的状态（能不能做、下一步做什么、失败原因、费用提示）；
 * 接口路径、字段口径、判定优先级、**模型与生成服务、原始状态值、任务编号 / 文件编号**
 * 一律收进这里，用户想排查时再展开，不干扰正常流程。
 *
 * 安全口径：这里只显示模型名 / 生成服务名 / 状态值这类**标识性**字段，
 * 任何密钥、令牌、Authorization 头都不取、不存、不显示。
 */
export function ProjectDevInfo({ detail, model, resolution, onReload, technical }: ProjectDevInfoProps) {
  const assetCounts = detail.assetCounts
  const gate = useGenerationGate()
  const [defaultModelIds, setDefaultModelIds] = useState<Record<string, string>>({})
  const [models, setModels] = useState<ModelRow[]>([])
  const [providers, setProviders] = useState<ProviderRow[]>([])
  const [modelLoadError, setModelLoadError] = useState('')

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const [settings, modelRows, providerRows] = await Promise.all([
          fetchJson('/api/v1/llm/model-settings'),
          fetchAllRows('/api/v1/llm/models'),
          fetchAllRows('/api/v1/llm/providers'),
        ])
        if (cancelled) return
        const ids: Record<string, string> = {}
        ;(Object.keys(DEFAULT_MODEL_KEYS) as GenerationOutlet[]).forEach((outlet) => {
          ids[outlet] = readText(settings, DEFAULT_MODEL_KEYS[outlet])
        })
        setDefaultModelIds(ids)
        setModels(
          modelRows.map((row) => ({
            id: readText(row, 'id'),
            name: readText(row, 'name'),
            category: readText(row, 'category'),
            providerId: readText(row, 'provider_id'),
          })),
        )
        setProviders(
          providerRows.map((row) => ({
            id: readText(row, 'id'),
            name: readText(row, 'name'),
            status: readText(row, 'status'),
          })),
        )
        setModelLoadError('')
      } catch (error) {
        if (cancelled) return
        setModelLoadError((error as Error)?.message || '模型与生成服务信息读取失败')
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  /** 出口 → 默认模型 / 生成服务 / 页面状态条给出的原始状态值。 */
  const modelRows = useMemo(
    () =>
      (Object.keys(DEFAULT_MODEL_KEYS) as GenerationOutlet[]).map((outlet) => {
        const modelId = defaultModelIds[outlet] ?? ''
        const modelRow = models.find((row) => row.id === modelId)
        const provider = modelRow?.providerId ? providers.find((row) => row.id === modelRow.providerId) : undefined
        return {
          outlet,
          outletLabel: OUTLET_LABEL[outlet],
          modelId,
          modelName: modelRow?.name || modelId || '（未配置）',
          providerName: provider?.name || modelRow?.providerId || '（未解析）',
          providerStatus: provider?.status || '',
          rawState: gate.models?.[outlet]?.state ?? 'unknown',
          rawReason: gate.models?.[outlet]?.reason ?? '',
        }
      }),
    [defaultModelIds, gate.models, models, providers],
  )

  const taskIds = technical?.taskIds ?? []
  const fileIds = technical?.fileIds ?? []

  /**
   * 技术详情里「模型 / 生成服务 / 原始状态值」那一组的数据。
   *
   * 注意：**标签文案不在这里** ——「模型与生成服务」「原始状态值」这类内部说法
   * 统一由 `workbench/TechnicalDetailCollapse.tsx` 渲染（阶段 B ①：三处自建
   * 折叠区合并到那一个文件，源码级禁词测试只给那一个文件开口子）。
   * 本组件只负责把数据取出来。
   */
  const modelRowData = modelRows.map((row) => ({
    outletLabel: row.outletLabel,
    modelName: row.modelName,
    modelId: row.modelId,
    providerName: row.providerName,
    providerStatus: row.providerStatus,
    rawState: row.rawState,
    rawReason: row.rawReason,
  }))

  return (
    <TechnicalDetailSection
      testId="project-dev-info"
      hint="这里放的是排查问题用的内部信息；普通流程不需要看，默认收起，不影响操作。"
    >
      <div className="space-y-3 text-xs text-gray-600">
        <TechnicalModelProviderBlock rows={modelRowData} loadError={modelLoadError} />

        <TechnicalIdBlock taskIds={taskIds} fileIds={fileIds} />

          <Descriptions size="small" column={2} bordered={false} colon={false}>
            <Descriptions.Item label="章节数">{detail.chapterCount}</Descriptions.Item>
            <Descriptions.Item label="已有原文章节">{detail.chaptersWithTextCount}</Descriptions.Item>
            <Descriptions.Item label="判定用当前集分镜数">
              {detail.focusChapterShotCount}
              {detail.focusChapterId ? `（chapter=${detail.focusChapterId}）` : '（未选定当前集）'}
            </Descriptions.Item>
            <Descriptions.Item label="当前集已填视频提示词">{detail.focusChapterShotsWithPrompt}</Descriptions.Item>
            <Descriptions.Item label="当前集已关联资产镜头">
              {detail.focusChapterShotsWithLinks}
              {detail.bindingSampleSize > 0 ? `（角色绑定按前 ${detail.bindingSampleSize} 个镜头抽样）` : ''}
            </Descriptions.Item>
            <Descriptions.Item label="项目镜头总数 / 已填提示词">
              {detail.projectShotCount} / {detail.projectShotsWithPrompt}
            </Descriptions.Item>
            <Descriptions.Item label="资产数量（角色/场景/道具/服装）">
              {assetCounts.characters} / {assetCounts.scenes} / {assetCounts.props} / {assetCounts.costumes}
            </Descriptions.Item>
            <Descriptions.Item label="已有参考图片资产数">{detail.assetImageCount}</Descriptions.Item>
            <Descriptions.Item label="已保存图片提示词资产数">
              {detail.assetsWithImagePromptCount === null
                ? '暂时读不到这一项（内部字段名见下方「信号来源接口」）'
                : detail.assetsWithImagePromptCount}
            </Descriptions.Item>
          </Descriptions>

          <div className="flex flex-wrap items-center gap-2">
            <span>判定结果：</span>
            <Tag color="blue" className="mr-0">
              {resolution.step}
            </Tag>
            <span>{resolution.reason}</span>
            <Button size="small" type="link" className="px-1" onClick={onReload}>
              重新判定
            </Button>
          </div>

              <div>
                <div className="mb-1 font-medium text-gray-500">resolveProjectStep 入参（原始计数）</div>
                <pre className="m-0 overflow-x-auto rounded bg-gray-50 p-2 text-[11px] leading-5">
                  {JSON.stringify(model, null, 2)}
                </pre>
              </div>

              <div>
                <div className="mb-1 font-medium text-gray-500">步骤判定优先级（内部 6 个 key → 用户可见 5 步）</div>
                <pre className="m-0 overflow-x-auto rounded bg-gray-50 p-2 text-[11px] leading-5">
                  {STEP_PRECEDENCE}
                </pre>
              </div>

              <div>
                <div className="mb-1 font-medium text-gray-500">信号来源接口</div>
                <ul className="m-0 list-disc pl-4 space-y-0.5">
                  {SIGNAL_ENDPOINTS.map(([name, endpoint]) => (
                    <li key={name}>
                      <span className="text-gray-500">{name}：</span>
                      <code>{endpoint}</code>
                    </li>
                  ))}
                </ul>
              </div>

              {detail.failedSources.length > 0 ? (
                <div className="text-amber-600">
                  未取到的信号（已按 0/未知降级，判定会停在更靠前的步骤）：
                  {detail.failedSources.join('、')}
                </div>
              ) : (
                <div className="text-emerald-600">全部信号抓取成功。</div>
              )}
      </div>
    </TechnicalDetailSection>
  )
}
