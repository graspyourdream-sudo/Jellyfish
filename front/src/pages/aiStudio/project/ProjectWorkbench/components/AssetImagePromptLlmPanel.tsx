/**
 * 第 3 步「图片准备」里的**大模型生成图片提示词**面板（按资产 / 可批量 / 可确认保存）。
 *
 * 为什么需要它（用户要求）：
 * 1. 第 3 步此前只有「手工填写提示词」（把用户自己的字写进 `image_prompts`），
 *    真正的"让大模型按资产画像生成图片提示词"在项目工作台上没有入口；
 * 2. 默认**只补缺失项**：已经有 `image_prompts` 的资产不碰，要覆盖必须显式打开开关；
 * 3. 生成结果必须**可编辑、确认后才保存**，且**模板/演练不得冒充大模型输出** ——
 *    只有后端回包 `meta.llm_called === true` 才允许保存；
 * 4. 批量要能**停止后续、保留已完成、重试失败项**。
 *
 * 本轮修正三件事（用户点名）：
 *   A. **槽位吃后端槽位表**（`/studio/llm/orchestration/status` 的 `image_prompt_slots`）：
 *      道具不再显示「不支持（无槽位）」——它有 `prop_image_front` 槽位，
 *      可以勾选、可以手工填写并保存；后端槽位表里还没补上时只说「正在补，先手工填写」，
 *      不再是一个死胡同（见 `assetPromptSlots.resolveAssetPromptSlot`）。
 *   B. **质量如实呈现**：这一行拿到的提示词如果不可用（空 / 外观信息不足 /
 *      只有名称+通用摄影词），页面直接给出原因与怎么修，**不显示成"提示词已就绪"**，
 *      也不许原样保存进资产（先按原因改好，改完就能存）。
 *   C. **生成依据（默认收起）**：每一行都能展开看本次用了哪些项目风格 / 资产资料 /
 *      剧本片段 / 分镜依据；后端还没返回这些字段时如实显示「本次未提供生成依据」。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Collapse, Input, Modal, Space, Table, Tag, Tooltip, message } from 'antd'
import { ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { StudioEntitiesApi } from '../../../../../services/studioEntities'
import { StudioProjectsService } from '../../../../../services/generated'
import {
  fetchImagePromptSlots,
  getAssetImagePrompts,
  saveAssetImagePrompts,
} from '../../../../../services/llmPipelineApi'
import {
  previewAssetImagePrompt,
  fetchAssetPromptBatchSaveSupport,
  fetchPromptRequestSupport,
  saveAssetImagePromptsBatch,
} from './assetProductionApi'
import { AssetGenerationBasisPanel } from './AssetGenerationBasisPanel'
import { buildRequestStructureText, type GenerationBasisExtras } from './assetGenerationBasis.ts'
import { PromptQualityAlert, PromptQualityTag } from './PromptQualityAlert'
import {
  buildPromptDifferenceLines,
  describePromptPanelRowQuality,
  describePromptSaveFailure,
  canSavePromptToAsset,
  summarizePromptDifferences,
} from './assetPromptQuality.ts'
import {
  buildBatchWriteScopeConfirmation,
  buildGlobalAssetWriteConfirmation,
  describeAssetScopeCopy,
  isGlobalAssetType,
} from './assetWriteScope.ts'
import {
  PROMPT_REQUEST_SUPPORT_NONE,
  buildAssetPromptBatchSaveBody,
  describePromptRequestDelivery,
  type PromptRequestFieldSupport,
} from './assetPromptRequestContract.ts'
import type { ProjectSignalAsset, ProjectSignalAssetType } from '../hooks/useProjectStepSignals'
import {
  ASSET_PROMPT_CATEGORY,
  ASSET_PROMPT_CATEGORY_LABEL,
  buildUnsupportedSlotAlert,
  describePromptRowAsset,
  describePromptRowExisting,
  describePromptRowGenerateHint,
  describePromptRowSlot,
  describePromptRowState,
  mergeLoadedAssetPrompts,
  resolveAssetPromptSlot,
  type AssetPromptSlotSpecLike,
} from './assetPromptSlots.ts'

/** 槽位表与文案都在 `assetPromptSlots` 里（纯逻辑，可单测）；这里只做转出，避免旧引用失效。 */
export { ASSET_PROMPT_CATEGORY, ASSET_PROMPT_CATEGORY_LABEL }

type AssetRow = {
  key: string
  id: string
  type: ProjectSignalAssetType
  name: string
  /** 有没有提示词槽位（四类资产都有；没有的类型才不能勾选） */
  supported: boolean
  /** 后端槽位表里有没有这一项（能否一键让大模型生成） */
  generateSupported: boolean
  category: string
  /** 槽位中文名（后端槽位表优先） */
  label: string
  /** 不能一键生成时的如实说明 */
  generateBlockedReason: string
  /** 已保存的提示词（生图实际读取的那一列） */
  existing: string
  /**
   * 该资产**已保存的全部槽位提示词**（打开时读一次）。
   *
   * 保存接口是"整列替换"，只发一个槽位会抹掉该资产其它槽位，所以保存时合并写回。
   */
  existingMap: Record<string, string>
  status: 'pending' | 'running' | 'generated' | 'saved' | 'failed' | 'stopped'
  draft: string
  llmCalled: boolean | null
  latencyMs: number | null
  error: string
  warnings: string[]
  /** 本次生成依据的原始回包片段（默认收起的「生成依据」面板读它） */
  basisPayload: unknown
  /** 本次质量判定的原始回包片段（后端结构化优先） */
  qualityPayload: unknown
  /** ④ 本次**真的发出去**的请求结构（脱敏后展示） */
  requestStructure: string
}

/** 默认只勾选这么多个缺失资产，放大批量必须人工点「全选缺失」。 */
const DEFAULT_SELECT_LIMIT = 3
/** 超过这个数量就要求二次确认（真实大模型调用是花钱的）。 */
const CONFIRM_THRESHOLD = 10

type AssetImagePromptLlmPanelProps = {
  projectId?: string
  assets: ProjectSignalAsset[]
  /** 保存成功后通知外层重算本步骤信号（摘要与资产表要跟着变） */
  onSaved?: () => void
}

export function AssetImagePromptLlmPanel({ projectId, assets, onSaved }: AssetImagePromptLlmPanelProps) {
  const [rows, setRows] = useState<AssetRow[]>([])
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [onlyMissing, setOnlyMissing] = useState(true)
  const [includeExisting, setIncludeExisting] = useState(false)
  const [running, setRunning] = useState(false)
  const [savingKey, setSavingKey] = useState('')
  const stopRef = useRef(false)
  /** 后端槽位表：道具槽位补上后这里会自动出现它（前端不再硬编码"道具没有槽位"） */
  const [slotSpecs, setSlotSpecs] = useState<AssetPromptSlotSpecLike[]>([])
  /** 这次批量生成时**对所有选中资产**的补充要求（④ 项依据；后端声明了对应字段才会真的发出去） */
  const [userSupplement, setUserSupplement] = useState('')
  /** 请求字段能力（读后端接口清单得到；读不到就一个额外字段都不发） */
  const [requestSupport, setRequestSupport] = useState<PromptRequestFieldSupport>(PROMPT_REQUEST_SUPPORT_NONE)
  /** 项目整体风格（① 项依据） */
  const [projectStyleHint, setProjectStyleHint] = useState('')
  /**
   * 批量保存入口是否已上线（读接口清单）。
   *
   * 上线后走它（一次事务 + 跨资产查重 + 合并写入）；没上线就退回逐资产保存（今天的口径）。
   */
  const [batchSaveAvailable, setBatchSaveAvailable] = useState(false)

  /** 只读：后端槽位表 + 请求字段能力 + 项目整体风格（都不触发任何生成） */
  useEffect(() => {
    let cancelled = false
    void fetchImagePromptSlots()
      .then((specs) => {
        if (!cancelled) setSlotSpecs(Array.isArray(specs) ? specs : [])
      })
      .catch(() => {
        if (!cancelled) setSlotSpecs([])
      })
    void fetchPromptRequestSupport().then((support) => {
      if (!cancelled) setRequestSupport(support)
    })
    void fetchAssetPromptBatchSaveSupport().then((support) => {
      if (!cancelled) setBatchSaveAvailable(support.available)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    void (async () => {
      try {
        const res = await StudioProjectsService.getProjectApiV1StudioProjectsProjectIdGet({ projectId })
        const project = (res?.data ?? {}) as { visual_style?: string | null; style?: string | null }
        const parts = [project.visual_style, project.style]
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter((item) => item.length > 0)
        if (!cancelled) setProjectStyleHint(Array.from(new Set(parts)).join('，'))
      } catch {
        if (!cancelled) setProjectStyleHint('')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectId])

  /** 把步骤信号里的资产转换成面板行；`existing` 需要拉一次实体详情（步骤信号不带描述与提示词）。 */
  const loadRows = useCallback(async () => {
    const next: AssetRow[] = []
    for (const asset of assets) {
      // 槽位**吃后端槽位表**（读不到就退回内置表，四类资产都有槽位）
      const slot = resolveAssetPromptSlot(asset.type, slotSpecs)
      next.push({
        key: `${asset.type}:${asset.id}`,
        id: asset.id,
        type: asset.type,
        name: asset.name || asset.id,
        supported: slot.supported,
        generateSupported: slot.generateSupported,
        category: slot.category,
        label: slot.label,
        generateBlockedReason: slot.generateBlockedReason,
        existing: '',
        existingMap: {},
        status: 'pending',
        draft: '',
        llmCalled: null,
        latencyMs: null,
        error: '',
        warnings: [],
        basisPayload: null,
        qualityPayload: null,
        requestStructure: '',
      })
    }
    setRows(next)
    // 缺失项默认只勾**前 3 个**（`hasImagePrompt !== true` 视为缺失）：
    // 一次几十个资产就是几十次真实大模型调用，默认全勾等于把按钮做成"一键烧钱"。
    const missing = next.filter((row) => row.supported && assets.find((a) => a.id === row.id)?.hasImagePrompt !== true)
    setSelectedKeys(missing.slice(0, DEFAULT_SELECT_LIMIT).map((row) => row.key))
    // 已有内容的资产：拉一次详情，把已保存的提示词显示出来（用于对照与"不覆盖"判断）
    const withExisting = next.filter((row) => assets.find((a) => a.id === row.id)?.hasImagePrompt === true)
    const loaded = await Promise.all(
      withExisting.map(async (row) => {
        try {
          const res = await StudioEntitiesApi.get(row.type as 'character' | 'scene' | 'prop' | 'costume', row.id)
          const prompts = getAssetImagePrompts(res.data as Record<string, unknown>)
          const map = Object.fromEntries(
            Object.entries(prompts)
              .map(([slot, value]) => [slot, String(value ?? '').trim()])
              .filter(([, value]) => Boolean(value)),
          )
          return { key: row.key, existing: String(prompts[row.category] ?? '').trim(), existingMap: map }
        } catch {
          return { key: row.key, existing: '', existingMap: {} }
        }
      }),
    )
    if (loaded.length) {
      /**
       * **按 key 合并**，不是整行替换（缺陷 D1 的修复）。
       *
       * `loaded` 里的每一项只有 `{ key, existing }`；以前写的是
       * `prev.map(row => loaded.find(...) ?? row)` —— 命中的行会被这个两字段对象**整行替换**，
       * name / type / supported / category 全部丢失，界面立刻变成
       * 「undefined（undefined）」+「不支持（无槽位）」+ 复选框禁用（不能勾选、不能生成），
       * 有几项已保存提示词就有几行坏掉，还误报「有 N 个资产类型没有大模型槽位」。
       */
      setRows((prev) => mergeLoadedAssetPrompts(prev, loaded))
    }
  }, [assets, slotSpecs])

  useEffect(() => {
    void loadRows()
  }, [loadRows])

  const plannedRows = useMemo(
    () =>
      rows.filter((row) => {
        // 一键生成要求后端槽位表里有这一项（没补上时只能手工填写并保存，不当成"不支持"）
        if (!row.supported || !row.generateSupported) return false
        if (!selectedKeys.includes(row.key)) return false
        if (!onlyMissing || includeExisting) return true
        return !row.existing
      }),
    [includeExisting, onlyMissing, rows, selectedKeys],
  )

  const generateOne = async (row: AssetRow): Promise<void> => {
    // 画像卡：把该资产的描述交给编排层，保证"提示词是照这个资产写的"
    const detail = await StudioEntitiesApi.get(row.type as 'character' | 'scene' | 'prop' | 'costume', row.id)
    const entity = (detail.data ?? {}) as Record<string, unknown>
    const preview = await previewAssetImagePrompt({
      projectId: projectId ?? null,
      assetType: row.type,
      assetId: row.id,
      name: String(entity.name ?? row.name),
      description: String(entity.description ?? ''),
      category: row.category,
      // ① 项目整体风格 + ④ 本次补充要求（后端没声明对应字段时不会发出去，页面会说明）
      styleHint: projectStyleHint,
      userSupplement,
      requestSupport,
    })
    setRows((prev) =>
      prev.map((item) =>
        item.key === row.key
          ? {
              ...item,
              status: 'generated',
              draft: preview.prompt,
              llmCalled: preview.llmCalled,
              latencyMs: preview.latencyMs,
              warnings: preview.warnings,
              basisPayload: preview.basisPayload,
              qualityPayload: preview.qualityPayload,
              requestStructure: buildRequestStructureText(preview.requestBody),
              error: preview.slotMissing
                ? '后端这次没有返回这个类型的槽位（槽位表可能还在补）：可以手工填写后保存到资产。'
                : '',
            }
          : item,
      ),
    )
  }

  const runBatch = async (targets: AssetRow[]) => {
    if (!targets.length) return
    stopRef.current = false
    setRunning(true)
    /** 剩下的还没开始的项（失败/停止后要如实回显"它们没有开始"） */
    const remaining: AssetRow[] = []
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index]
      if (stopRef.current) {
        remaining.push(target)
        continue
      }
      setRows((prev) => prev.map((item) => (item.key === target.key ? { ...item, status: 'running' } : item)))
      try {
        // 串行：一次只打一个 LLM 请求，避免并发把配额打满、也便于"停止后续"立刻生效
        // eslint-disable-next-line no-await-in-loop
        await generateOne(target)
      } catch (error) {
        setRows((prev) =>
          prev.map((item) =>
            item.key === target.key
              ? { ...item, status: 'failed', error: error instanceof Error ? error.message : '生成失败' }
              : item,
          ),
        )
        /**
         * **失败立即停止、不自动重试**（用户口径：真实调用是按次数授权的，
         * 任何一次失败都要停下来由人决定，不能让页面自己接着烧次数）。
         */
        remaining.push(...targets.slice(index + 1))
        break
      }
    }
    if (remaining.length > 0) {
      const stopped = stopRef.current ? '已按你的要求停止' : '上一次调用失败后已自动停止（不会重试）'
      setRows((prev) =>
        prev.map((item) => (item.status === 'pending' ? { ...item, status: 'stopped', error: `${stopped}：这一项没有开始` } : item)),
      )
      message.info(`${stopped}：剩余 ${remaining.length} 项没有开始。确认后可点「生成图片提示词」继续，页面不会自动重试。`)
    }
    setRunning(false)
    stopRef.current = false
  }

  const saveOne = async (row: AssetRow, options: { skipConfirm?: boolean } = {}): Promise<boolean> => {
    const text = String(row.draft ?? '').trim()
    if (!text) {
      message.warning('提示词为空，未保存')
      return false
    }
    if (!row.llmCalled) {
      message.error('这次后端没有真正调用大模型（演练/模板），不能按大模型结果保存为正式产物。')
      return false
    }
    // 质量不可用的提示词**不许原样存进资产**（否则它会被后面的出图当成可用提示词）
    const verdict = describePromptPanelRowQuality(row, { serverQuality: row.qualityPayload, serverWarnings: row.warnings })
    if (!canSavePromptToAsset(verdict, text)) {
      message.error(`这一行不能保存：${verdict.reason}${verdict.fixes[0] ? `；怎么修：${verdict.fixes[0]}` : ''}`)
      return false
    }
    // 合并写回：只改这一行那一个槽位，该资产其它槽位原样保留（保存接口是整列替换）
    const nextPrompts: Record<string, string> = { ...row.existingMap, [row.category]: text }
    /**
     * 写入范围确认：全局资产（场景/道具/服装）**一律**先确认"这会写回全局资产库"+差异；
     * 角色（项目内资产）只在会替换已有内容时确认。
     */
    const writeScope = buildGlobalAssetWriteConfirmation({
      assetType: row.type,
      assetName: row.name,
      existing: row.existingMap,
      incoming: nextPrompts,
    })
    const replacedSlots = writeScope.replacedSlots
    const doSave = async (): Promise<boolean> => {
      setSavingKey(row.key)
      try {
        // 覆盖已有提示词必须**显式确认**（后端默认不动；确认后带 confirm_replace_image_prompt=true）
        await saveAssetImagePrompts(
          row.type as 'character' | 'scene' | 'prop' | 'costume',
          row.id,
          nextPrompts,
          replacedSlots.length > 0 ? { confirm_replace_image_prompt: true } : {},
        )
        setRows((prev) => prev.map((item) => (item.key === row.key ? { ...item, status: 'saved', existing: text } : item)))
        onSaved?.()
        return true
      } catch (error) {
        // 后端的结构化中文错误（409 质量冲突 / 422 质量拦截）优先原样展示
        const failure = describePromptSaveFailure(error)
        message.error(failure.fix ? `${failure.message}（${failure.fix}）` : failure.message)
        return false
      } finally {
        setSavingKey('')
      }
    }
    // 保护既有的人工提示词：覆盖前先确认（不会静默盖掉）；全局资产还要说明"写回全局"
    // （批量回退路径已经**一次性**确认过整批的范围与差异，这里不重复弹框）
    if (writeScope.required && options.skipConfirm !== true) {
      return await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: writeScope.title,
          width: 600,
          okText: writeScope.okText,
          cancelText: writeScope.cancelText,
          content: (
            <ul className="list-disc pl-5 text-xs leading-5">
              {writeScope.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ),
          onOk: () => {
            void doSave().then(resolve)
          },
          onCancel: () => resolve(false),
        })
      })
    }
    return await doSave()
  }

  const saveAll = async () => {
    const pending = rows.filter((row) => row.status === 'generated' && row.llmCalled && row.draft.trim())
    if (!pending.length) {
      message.warning('没有可保存的生成结果')
      return
    }
    let saved = 0
    let skipped = 0
    const saveable: AssetRow[] = []
    for (const row of pending) {
      const verdict = describePromptPanelRowQuality(row, {
        serverQuality: row.qualityPayload,
        serverWarnings: row.warnings,
      })
      if (!canSavePromptToAsset(verdict, String(row.draft ?? ''))) {
        skipped += 1
        continue
      }
      saveable.push(row)
    }
    /**
     * **后端批量入口优先**（本轮后端新增，读接口清单确认已上线）。
     *
     * 它一次事务内做：逐资产质量拦截 + **跨资产查重** + 覆盖保护 + 合并写入；
     * 逐资产 PATCH 看不到"两个角色拿到同一段提示词"，还会部分成功。
     */
    if (batchSaveAvailable && projectId && saveable.length > 0) {
      const items = saveable.map((row) => ({
        assetType: row.type,
        assetId: row.id,
        // 合并写回：只改这一行那一个槽位，该资产其它槽位原样保留
        imagePrompts: { ...row.existingMap, [row.category]: String(row.draft ?? '').trim() } as Record<string, string>,
      }))
      const writeScope = buildBatchWriteScopeConfirmation(
        saveable.map((row) => ({
          assetType: row.type,
          assetName: row.name,
          existing: row.existingMap,
          incoming: { ...row.existingMap, [row.category]: String(row.draft ?? '').trim() },
        })),
      )
      const needsConfirm = writeScope.required && (writeScope.globalCount > 0 || writeScope.replacedSlots > 0)
      const doBatch = async (confirmedReplace: boolean) => {
        setSavingKey('__batch__')
        try {
          const body = buildAssetPromptBatchSaveBody({ items, confirmedReplace })
          await saveAssetImagePromptsBatch(projectId, body)
          const savedKeys = new Set(saveable.map((row) => row.key))
          setRows((prev) =>
            prev.map((item) =>
              savedKeys.has(item.key)
                ? { ...item, status: 'saved', existing: String(item.draft ?? '').trim(), existingMap: { ...item.existingMap, [item.category]: String(item.draft ?? '').trim() } }
                : item,
            ),
          )
          onSaved?.()
          message.success(`已保存 ${saveable.length} 个资产的图片提示词（生图会立刻读它们）`)
        } catch (error) {
          const failure = describePromptSaveFailure(error)
          message.error(failure.fix ? `${failure.message}（${failure.fix}）` : failure.message)
        } finally {
          setSavingKey('')
        }
      }
      if (needsConfirm) {
        Modal.confirm({
          title: writeScope.title,
          width: 620,
          okText: writeScope.okText,
          cancelText: writeScope.cancelText,
          content: (
            <ul className="list-disc pl-5 text-xs leading-5">
              {writeScope.lines.split('\n').map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ),
          onOk: () => void doBatch(writeScope.replacedSlots > 0),
        })
        if (skipped) message.warning(`有 ${skipped} 个资产的提示词判定不可用，已跳过；按每行的原因补好后再保存。`)
        return
      }
      await doBatch(false)
      if (skipped) message.warning(`有 ${skipped} 个资产的提示词判定不可用，已跳过；按每行的原因补好后再保存。`)
      return
    }

    // 批量入口没上线：退回逐资产保存（今天的口径，逐项给出结果）
    const fallbackScope = buildBatchWriteScopeConfirmation(
      saveable.map((row) => ({
        assetType: row.type,
        assetName: row.name,
        existing: row.existingMap,
        incoming: { ...row.existingMap, [row.category]: String(row.draft ?? '').trim() },
      })),
    )
    const runFallback = async (skipConfirm: boolean) => {
      for (const row of saveable) {
        // eslint-disable-next-line no-await-in-loop
        if (await saveOne(row, { skipConfirm })) saved += 1
      }
      if (saved) message.success(`已保存 ${saved} 个资产的图片提示词（生图会立刻读它们）`)
      if (skipped) message.warning(`有 ${skipped} 个资产的提示词判定不可用，已跳过；按每行的原因补好后再保存。`)
    }
    if (fallbackScope.required) {
      // 一次性把整批的写入范围（含"哪几项会写回全局资产库"）与差异确认清楚
      Modal.confirm({
        title: fallbackScope.title,
        width: 620,
        okText: fallbackScope.okText,
        cancelText: fallbackScope.cancelText,
        content: (
          <ul className="list-disc pl-5 text-xs leading-5">
            {fallbackScope.lines.split('\n').map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ),
        onOk: () => void runFallback(true),
      })
      return
    }
    await runFallback(false)
  }

  /**
   * ⑤「最终提示词及差异」：把每行**本次真的会用**的那条提示词并排比。
   *
   * 单看一条提示词看不出"两个角色是不是拿到了同一段内容"，必须放在一起比
   * （相似度达到阈值就点名"高度重复"，这也是后端 409 跨资产查重的前置提示）。
   */
  const promptDifferences = useMemo(
    () =>
      summarizePromptDifferences(
        rows.map((row) => ({
          key: row.key,
          name: row.name,
          type: row.type,
          prompt: String(row.draft ?? '').trim() || String(row.existing ?? '').trim(),
        })),
      ),
    [rows],
  )
  const differenceLineByKey = useMemo(
    () => new Map(promptDifferences.map((row) => [row.key, row.diffLine])),
    [promptDifferences],
  )
  /** 这一行的 ④⑤ 证据（前端自己知道的）：喂给「生成依据」面板 */
  const basisExtrasFor = useCallback(
    (row: AssetRow): GenerationBasisExtras => ({
      requestStructure: row.requestStructure,
      finalPrompt: String(row.draft ?? '').trim() || String(row.existing ?? '').trim(),
      promptDifferences: differenceLineByKey.has(row.key) ? [differenceLineByKey.get(row.key) as string] : [],
      globalAsset: isGlobalAssetType(row.type),
    }),
    [differenceLineByKey],
  )

  const unsupportedAlert = buildUnsupportedSlotAlert(rows)
  const dryRunRows = rows.filter((row) => row.status === 'generated' && row.llmCalled === false)
  const failedCount = rows.filter((row) => row.status === 'failed').length
  /**
   * 勾选了、但**后端槽位表里还没有这一项**所以本次不会生成的资产（未补槽位前的道具）。
   *
   * 不静默跳过：生成前把名字列出来并说明走哪条路（手工填写 + 保存）。
   */
  const checkedWithoutSlot = rows.filter(
    (row) => selectedKeys.includes(row.key) && row.supported && !row.generateSupported,
  )

  return (
    <div className="space-y-3">
      <div className="cs-group-title">
        <ThunderboltOutlined /> 大模型生成图片提示词
      </div>
      {/* 日常操作区只说用户语言；接口路径/编排实现等内部信息收进默认收起的「技术详情」 */}
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-600">
        根据项目风格、资产资料和本章剧情生成图片提示词。每项会调用一次文本模型，保存前可以检查和修改结果；
        保存的位置就是生图实际读取的那份资产提示词。
      </div>
      <Collapse
        size="small"
        ghost
        items={[
          {
            key: 'prompt-gen-tech',
            label: '技术详情：这一屏怎么工作的',
            children: (
              <div className="space-y-1 text-[11px] leading-5 text-slate-500">
                <div>提示词生成走后端 LLM 编排接口（`POST /studio/llm/image-prompt/preview`），每项一次调用。</div>
                <div>保存后「生图计划预览」会把提示词来源标成「已保存提示词」—— 用它可当场验证保存内容真的被生图使用。</div>
                <div>失败即停、不自动重试；被质量拦截的提示词不会保存。</div>
              </div>
            ),
          },
        ]}
      />

      <Space wrap size={12} align="center">
        <Checkbox checked={onlyMissing} onChange={(event) => setOnlyMissing(event.target.checked)}>
          只补缺失项（已有提示词与已定版资产不动）
        </Checkbox>
        <Checkbox checked={includeExisting} disabled={!onlyMissing} onChange={(event) => setIncludeExisting(event.target.checked)}>
          连已有提示词的资产一起生成（保存时会覆盖确认）
        </Checkbox>
        <Button
          size="small"
          onClick={() =>
            setSelectedKeys(rows.filter((row) => row.supported && row.generateSupported && (includeExisting || !row.existing)).map((row) => row.key))
          }
        >
          全选缺失
        </Button>
        <Button size="small" onClick={() => setSelectedKeys([])}>
          清空选择
        </Button>
        <Button size="small" icon={<ReloadOutlined />} onClick={() => void loadRows()}>
          重载资产清单
        </Button>
      </Space>

      <div className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
        <div className="text-[11px] text-slate-600">本次补充要求（会作为「你的补充/修改」一起交给提示词生成）</div>
        <Input.TextArea
          rows={2}
          value={userSupplement}
          onChange={(event) => setUserSupplement(event.target.value)}
          placeholder="例如：正面半身，纯白背景；道具要显示材质与比例"
        />
        <div className="text-[11px] text-gray-500">
          {describePromptRequestDelivery(requestSupport, Boolean(userSupplement.trim()))}
        </div>
      </div>

      {/*
        ⑤ 最终提示词及差异：验收要核对"四个资产的提示词确实不同"——
        单看一条看不出来，必须并排比；达到 90% 相似度就点名"高度重复"。
      */}
      <Collapse
        ghost
        size="small"
        items={[
          {
            key: 'prompt-diffs',
            label: (
              <span className="text-xs text-slate-600">
                {`⑤ 最终提示词及差异（${promptDifferences.filter((row) => row.prompt).length} 条有内容）`}
              </span>
            ),
            children: (
              <div className="space-y-2">
                {promptDifferences.every((row) => !row.prompt) ? (
                  <div className="text-[11px] text-gray-400">
                    还没有可对比的提示词：生成后这里会列出每个资产最终会用的那一条，以及与其它资产的相似度。
                  </div>
                ) : (
                  promptDifferences.map((row) => (
                    <div key={row.key} className="text-[11px] leading-5">
                      <span className="font-medium text-slate-700">{`${row.name}（${row.typeLabel}）`}</span>
                      <span className={row.duplicated ? 'text-red-500' : 'text-gray-500'}>{`：${row.diffLine}`}</span>
                      <div className="text-gray-400" style={{ wordBreak: 'break-all' }}>
                        {row.prompt || '（还没有提示词）'}
                      </div>
                    </div>
                  ))
                )}
                {promptDifferences.some((row) => row.duplicated) ? (
                  <Alert
                    type="error"
                    showIcon
                    message={<span className="text-xs">有资产之间的提示词高度重复（≥90%）：按它出图会把不同资产画成同一个</span>}
                    description={
                      <ul className="list-disc pl-5 text-[11px]">
                        {buildPromptDifferenceLines(promptDifferences.filter((row) => row.duplicated)).map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    }
                  />
                ) : null}
              </div>
            ),
          },
        ]}
      />

      {/* 用户语言：说清"点一次 = 花一次钱"，不写接口名、不写模型 ID、不写状态码 */}
      <div className="text-[11px] text-gray-500">
        每项会调用一次文本模型（按次计费，会花钱）；
        <span className="text-slate-700">任何一次失败都会立即停止且不自动重试</span>
        ，剩余项会标成「未开始」由你决定要不要继续。
      </div>

      {unsupportedAlert ? (
        <Alert
          type="info"
          showIcon
          message={unsupportedAlert.message}
          description={unsupportedAlert.description}
        />
      ) : null}

      <div className="text-[11px] text-gray-500">
        {`已选 ${plannedRows.length} 个资产待生成`}
        {onlyMissing && !includeExisting ? '（已有提示词的会被跳过）' : ''}
        {checkedWithoutSlot.length > 0
          ? `；另有 ${checkedWithoutSlot.length} 项（${checkedWithoutSlot
              .map((row) => row.name)
              .join('、')}）后端槽位表里还没有槽位，本次不会生成，可以手工填写并保存`
          : ''}
      </div>

      <Space wrap size={8}>
        <Button
          type="primary"
          size="small"
          loading={running}
          disabled={!plannedRows.length}
          onClick={() => {
            // 大批量先二次确认：真实大模型调用按资产数计费，误点代价是钱
            if (plannedRows.length > CONFIRM_THRESHOLD) {
              Modal.confirm({
                title: `确认对 ${plannedRows.length} 个资产调用大模型生成提示词？`,
                content: '每个资产一次大模型调用（会花钱）。演练模式下不会真的调用，也不会产生费用。',
                okText: '开始生成',
                cancelText: '取消',
                onOk: () => void runBatch(plannedRows),
              })
              return
            }
            void runBatch(plannedRows)
          }}
        >
          {`生成图片提示词（${plannedRows.length} 个资产）`}
        </Button>
        <Button
          size="small"
          danger
          disabled={!running}
          onClick={() => {
            stopRef.current = true
            message.info('已请求停止：当前这个资产会跑完，后续不再开始')
          }}
        >
          停止后续
        </Button>
        <Button size="small" disabled={!failedCount} onClick={() => void runBatch(rows.filter((row) => row.status === 'failed'))}>
          {`重试失败项（${failedCount}）`}
        </Button>
        <Button size="small" disabled={!rows.some((row) => row.status === 'generated')} onClick={() => void saveAll()}>
          保存全部已生成
        </Button>
      </Space>

      {dryRunRows.length ? (
        <Alert
          type="warning"
          showIcon
          message={`有 ${dryRunRows.length} 个资产拿到的是演练结果（后端未调用大模型），不能保存`}
          description="演练模式（DRY_RUN）下后端不会真的调用大模型、也不花钱；要拿到可保存的结果需要先确认真实调用。"
        />
      ) : null}

      <Table<AssetRow>
        size="small"
        rowKey="key"
        pagination={false}
        dataSource={rows}
        rowSelection={{
          selectedRowKeys: selectedKeys,
          onChange: (keys) => setSelectedKeys(keys.map((key) => String(key))),
          getCheckboxProps: (row) => ({ disabled: !row.supported }),
        }}
        columns={[
          {
            title: '资产',
            dataIndex: 'name',
            width: 190,
            render: (_: unknown, row) => (
              <span className="flex flex-wrap items-center gap-1">
                <span>{describePromptRowAsset(row)}</span>
                {isGlobalAssetType(row.type) ? (
                  <Tooltip title={describeAssetScopeCopy(row.type).statement}>
                    <Tag color="geekblue" bordered={false} className="mr-0">
                      全局资产
                    </Tag>
                  </Tooltip>
                ) : (
                  <Tooltip title={describeAssetScopeCopy(row.type).statement}>
                    <Tag bordered={false} className="mr-0 text-gray-400">
                      项目内资产
                    </Tag>
                  </Tooltip>
                )}
              </span>
            ),
          },
          { title: '槽位', dataIndex: 'category', width: 130, render: (_: unknown, row) => describePromptRowSlot(row) },
          { title: '已有提示词', dataIndex: 'existing', width: 120, render: (_: unknown, row) => describePromptRowExisting(row) },
          {
            title: '质量 / 生成结果（可编辑）',
            dataIndex: 'draft',
            render: (value: string, row) => {
              const unsupportedState = describePromptRowState(row)
              if (unsupportedState) return <span className="text-[11px] text-gray-400">{unsupportedState}</span>
              const label =
                row.status === 'saved'
                  ? '已保存'
                  : row.status === 'failed'
                    ? '失败'
                    : row.status === 'stopped'
                      ? '未开始（已停止）'
                      : row.status === 'running'
                        ? '生成中'
                        : row.status === 'generated'
                          ? '已生成'
                          : '待生成'
              const color =
                row.status === 'saved'
                  ? 'green'
                  : row.status === 'failed'
                    ? 'red'
                    : row.status === 'stopped'
                      ? 'default'
                      : row.status === 'running'
                        ? 'blue'
                        : 'gold'
              // 这一行**实际会用**的提示词（本次草稿优先，其次已保存的那条）：质量按它判
              const verdict = describePromptPanelRowQuality(row, {
                serverQuality: row.qualityPayload,
                serverWarnings: row.warnings,
              })
              const generateHint = describePromptRowGenerateHint(row)
              return (
                <div className="space-y-1">
                  <Space size={4} wrap>
                    <Tag color={color}>{label}</Tag>
                    <PromptQualityTag verdict={verdict} />
                    {row.error ? <span className="text-[11px] text-amber-600">{row.error}</span> : null}
                  </Space>
                  {generateHint ? <div className="text-[11px] text-gray-500">{generateHint}</div> : null}
                  <Input.TextArea
                    rows={3}
                    value={value}
                    disabled={row.status === 'failed'}
                    placeholder="点上面的「生成图片提示词」后在这里检查/修改"
                    onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
                      setRows((prev) => prev.map((item) => (item.key === row.key ? { ...item, draft: event.target.value } : item)))
                    }
                  />
                  {/* 质量不可用时给真实原因与怎么修（与批量出图的拦截用的是同一份文案） */}
                  {row.draft.trim() ? <PromptQualityAlert verdict={verdict} /> : null}
                  <Space size={8} wrap>
                    <Button
                      size="small"
                      type="primary"
                      loading={savingKey === row.key}
                      disabled={row.status !== 'generated' || !row.llmCalled || !canSavePromptToAsset(verdict, row.draft)}
                      onClick={() => void saveOne(row)}
                    >
                      保存到资产
                    </Button>
                    {row.status === 'generated' && !row.llmCalled ? (
                      <span className="text-[11px] text-amber-600">演练结果：未调用大模型，不可保存</span>
                    ) : null}
                    {row.status === 'generated' && row.llmCalled && !canSavePromptToAsset(verdict, row.draft) ? (
                      <span className="text-[11px] text-red-500">提示词不可用：先按上面的原因改好再保存</span>
                    ) : null}
                    {row.latencyMs ? <span className="text-[11px] text-gray-400">{`${row.latencyMs} ms`}</span> : null}
                  </Space>
                  {row.warnings?.length ? (
                    <ul className="list-disc pl-5 text-[11px] text-amber-600">
                      {row.warnings.slice(0, 2).map((warning, index) => (
                        <li key={`${row.key}-warn-${index}`}>{warning}</li>
                      ))}
                    </ul>
                  ) : null}
                  {/* 生成依据（默认收起）：这一行本次实际用到了什么 */}
                  <AssetGenerationBasisPanel
                    payload={row.basisPayload}
                    extras={basisExtrasFor(row)}
                    caption={`针对「${row.name}」`}
                  />
                </div>
              )
            },
          },
        ]}
      />
    </div>
  )
}

export default AssetImagePromptLlmPanel
