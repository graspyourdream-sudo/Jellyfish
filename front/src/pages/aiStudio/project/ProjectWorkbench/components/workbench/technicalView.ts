/**
 * 「技术详情」的数据装配（纯函数，可与组件分开测试）。
 *
 * 为什么单独一个文件：`TechnicalDetailCollapse.tsx` 是工作台里**唯一**允许出现
 * 内部字段名 / 模型名 / 供应商 / 任务号的组件，装配逻辑再单独放一层，
 * 既方便单测，也让"内部信息只在技术详情"这条边界一眼可见。
 */

import { ASSET_WORKBENCH_PATH_PREFIX } from './assetWorkbenchContract.ts'
import type {
  AssetWorkbenchItem,
  AssetWorkbenchResponse,
  AssetWorkbenchTechnical,
  WorkbenchLoadSource,
} from './assetWorkbenchContract.ts'

export type TechnicalViewInput = {
  data: AssetWorkbenchResponse | null
  source: WorkbenchLoadSource
  chapterId: string | null
  /** 读取失败时的原始说明（空串 = 没失败） */
  loadError?: string
}

export type TechnicalAssetLine = {
  key: string
  name: string
  assetType: string
  slot: string
  qualityVerdict: string
  profileSource: string
  fieldNames: string[]
}

export type TechnicalView = {
  endpoint: string
  sourceLabel: string
  loadError: string
  candidatesTotal: number
  candidateGroups: number
  candidateStatusLines: string[]
  matchDiagnostics: string[]
  notes: string[]
  modelLines: string[]
  slotLines: string[]
  assetLines: TechnicalAssetLine[]
}

function technicalOf(data: AssetWorkbenchResponse | null): AssetWorkbenchTechnical {
  return (
    data?.technical ?? {
      candidates_total: 0,
      candidates_by_type_status: {},
      candidate_groups: 0,
      match_diagnostics: [],
      notes: [],
    }
  )
}

/** 装配技术详情要显示的每一行（全部来自后端，缺字段就如实说没有）。 */
export function assembleTechnicalView(input: TechnicalViewInput): TechnicalView {
  const data = input.data
  const technical = technicalOf(data)
  const candidateStatusLines: string[] = []
  Object.keys(technical.candidates_by_type_status ?? {}).forEach((type) => {
    const statuses = technical.candidates_by_type_status[type] ?? {}
    const parts = Object.keys(statuses).map((status) => `${status}=${statuses[status]}`)
    candidateStatusLines.push(`${type}: ${parts.join(' ')}`)
  })
  const assetLines: TechnicalAssetLine[] = (data?.items ?? []).map((item: AssetWorkbenchItem) => ({
    key: `${item.asset_type}:${item.asset_id}`,
    name: item.name || item.asset_id,
    assetType: item.asset_type,
    slot: String(item.prompt?.slot ?? ''),
    qualityVerdict: String(item.prompt?.quality?.verdict ?? ''),
    profileSource: String(item.profile_source ?? ''),
    fieldNames: Object.keys(item.profile_fields ?? {}),
  }))
  const slotLines = Array.from(
    new Set((data?.items ?? []).map((item) => String(item.prompt?.slot ?? '')).filter(Boolean)),
  ).map((slot) => `槽位 ${slot}`)
  return {
    endpoint: input.chapterId
      ? `${ASSET_WORKBENCH_PATH_PREFIX}/{chapter_id}/asset-workbench（本章：${input.chapterId}）`
      : `${ASSET_WORKBENCH_PATH_PREFIX}/{chapter_id}/asset-workbench`,
    sourceLabel: input.source === 'contract' ? '本章资产工作台接口（契约）' : '降级视图（既有接口拼出）',
    loadError: String(input.loadError ?? ''),
    candidatesTotal: technical.candidates_total,
    candidateGroups: technical.candidate_groups,
    candidateStatusLines,
    matchDiagnostics: (technical.match_diagnostics ?? []).map((row) => `${row.name}：${row.reason}`),
    notes: technical.notes ?? [],
    modelLines: [],
    slotLines,
    assetLines,
  }
}
