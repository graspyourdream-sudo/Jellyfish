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
 * 槽位口径（照后端 `image_prompt_slot_specs()`，不硬编码猜）：
 * LLM 编排层只定义了**角色 / 场景 / 服装**的正/侧槽位（外加三个帧槽位），
 * **道具没有槽位**，所以道具在这里会明确标成"不支持"，而不是静默跳过或拿模板顶上。
 * 保存的位置是生图实际读取的那一列：`<entities>.image_prompts[<type>_image_front]`。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Input, Modal, Space, Table, Tag, message } from 'antd'
import { ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { StudioEntitiesApi } from '../../../../../services/studioEntities'
import {
  getAssetImagePrompts,
  previewImagePrompts,
  saveAssetImagePrompts,
  type ImagePromptSlot,
} from '../../../../../services/llmPipelineApi'
import type { ProjectSignalAsset, ProjectSignalAssetType } from '../hooks/useProjectStepSignals'

/** 资产类型 → 生成提示词时使用的槽位（= 生图计划读取的那一列）。 */
export const ASSET_PROMPT_CATEGORY: Partial<Record<ProjectSignalAssetType, string>> = {
  character: 'character_image_front',
  scene: 'scene_image_front',
  costume: 'costume_image_front',
}

export const ASSET_PROMPT_CATEGORY_LABEL: Record<string, string> = {
  character_image_front: '角色正面图片',
  scene_image_front: '场景正面图片',
  costume_image_front: '服装正面图片',
}

type AssetRow = {
  key: string
  id: string
  type: ProjectSignalAssetType
  name: string
  /** 大模型槽位表里是否有这个资产类型（道具没有） */
  supported: boolean
  category: string
  /** 已保存的提示词（生图实际读取的那一列） */
  existing: string
  status: 'pending' | 'running' | 'generated' | 'saved' | 'failed'
  draft: string
  llmCalled: boolean | null
  latencyMs: number | null
  error: string
  warnings: string[]
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

  /** 把步骤信号里的资产转换成面板行；`existing` 需要拉一次实体详情（步骤信号不带描述与提示词）。 */
  const loadRows = useCallback(async () => {
    const next: AssetRow[] = []
    for (const asset of assets) {
      const category = ASSET_PROMPT_CATEGORY[asset.type] ?? ''
      next.push({
        key: `${asset.type}:${asset.id}`,
        id: asset.id,
        type: asset.type,
        name: asset.name || asset.id,
        supported: Boolean(category),
        category,
        existing: '',
        status: 'pending',
        draft: '',
        llmCalled: null,
        latencyMs: null,
        error: '',
        warnings: [],
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
          return { key: row.key, existing: String(prompts[row.category] ?? '').trim() }
        } catch {
          return { key: row.key, existing: '' }
        }
      }),
    )
    if (loaded.length) {
      setRows((prev) => prev.map((row) => loaded.find((item) => item.key === row.key) ?? row) as AssetRow[])
    }
  }, [assets])

  useEffect(() => {
    void loadRows()
  }, [loadRows])

  const plannedRows = useMemo(
    () =>
      rows.filter((row) => {
        if (!row.supported) return false
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
    const preview = await previewImagePrompts({
      project_id: projectId ?? null,
      entity_profiles: [
        {
          name: String(entity.name ?? row.name),
          entity_type: row.type,
          profile: String(entity.description ?? ''),
        },
      ],
      categories: [row.category],
    })
    const slots: ImagePromptSlot[] = Array.isArray(preview?.slots) ? preview.slots : []
    const matched = slots.find((slot) => String(slot?.category ?? '') === row.category) ?? slots[0]
    setRows((prev) =>
      prev.map((item) =>
        item.key === row.key
          ? {
              ...item,
              status: 'generated',
              draft: String(matched?.prompt ?? '').trim(),
              llmCalled: Boolean(preview?.meta?.llm_called),
              latencyMs: preview?.meta?.latency_ms ?? null,
              warnings: Array.isArray(preview?.warnings) ? preview.warnings : [],
              error: '',
            }
          : item,
      ),
    )
  }

  const runBatch = async (targets: AssetRow[]) => {
    if (!targets.length) return
    stopRef.current = false
    setRunning(true)
    for (const target of targets) {
      if (stopRef.current) {
        setRows((prev) => prev.map((item) => (item.key === target.key && item.status === 'pending' ? { ...item, status: 'failed', error: '已按你的要求停止后续任务' } : item)))
        continue
      }
      setRows((prev) => prev.map((item) => (item.key === target.key ? { ...item, status: 'running' } : item)))
      try {
        // 串行：一次只打一个 LLM 请求，避免并发把配额打满、也便于"停止后续"立刻生效
        // eslint-disable-next-line no-await-in-loop
        await generateOne(target)
      } catch (error) {
        setRows((prev) =>
          prev.map((item) => (item.key === target.key ? { ...item, status: 'failed', error: error instanceof Error ? error.message : '生成失败' } : item)),
        )
      }
    }
    setRunning(false)
    stopRef.current = false
  }

  const saveOne = async (row: AssetRow): Promise<boolean> => {
    const text = String(row.draft ?? '').trim()
    if (!text) {
      message.warning('提示词为空，未保存')
      return false
    }
    if (!row.llmCalled) {
      message.error('这次后端没有真正调用大模型（演练/模板），不能按大模型结果保存为正式产物。')
      return false
    }
    setSavingKey(row.key)
    try {
      await saveAssetImagePrompts(row.type as 'character' | 'scene' | 'prop' | 'costume', row.id, { [row.category]: text })
      setRows((prev) => prev.map((item) => (item.key === row.key ? { ...item, status: 'saved', existing: text } : item)))
      onSaved?.()
      return true
    } catch (error) {
      message.error(`保存失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    } finally {
      setSavingKey('')
    }
  }

  const saveAll = async () => {
    const pending = rows.filter((row) => row.status === 'generated' && row.llmCalled && row.draft.trim())
    if (!pending.length) {
      message.warning('没有可保存的生成结果')
      return
    }
    let saved = 0
    for (const row of pending) {
      // eslint-disable-next-line no-await-in-loop
      if (await saveOne(row)) saved += 1
    }
    if (saved) message.success(`已保存 ${saved} 个资产的图片提示词（生图会立刻读它们）`)
  }

  const unsupported = rows.filter((row) => !row.supported)
  const dryRunRows = rows.filter((row) => row.status === 'generated' && row.llmCalled === false)
  const failedCount = rows.filter((row) => row.status === 'failed').length

  return (
    <div className="space-y-3">
      <div className="cs-group-title">
        <ThunderboltOutlined /> 大模型生成图片提示词
      </div>
      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-600">
        这里的「生成」调用后端的 LLM 编排接口（/studio/llm/image-prompt/preview），真的会调用大模型。
        保存的位置是生图实际读取的那一列（&lt;entities&gt;.image_prompts），保存后上面的「生图计划预览」会把提示词来源标成「已保存提示词」——
        用它能当场验证这一步确认保存的内容真的被生图使用了。
      </div>

      <Space wrap size={12} align="center">
        <Checkbox checked={onlyMissing} onChange={(event) => setOnlyMissing(event.target.checked)}>
          只补缺失项（已有提示词与已定版资产不动）
        </Checkbox>
        <Checkbox checked={includeExisting} disabled={!onlyMissing} onChange={(event) => setIncludeExisting(event.target.checked)}>
          连已有提示词的资产一起生成（会覆盖）
        </Checkbox>
        <Button
          size="small"
          onClick={() =>
            setSelectedKeys(rows.filter((row) => row.supported && (includeExisting || !row.existing)).map((row) => row.key))
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

      {unsupported.length ? (
        <Alert
          type="info"
          showIcon
          message={`有 ${unsupported.length} 个资产类型没有大模型槽位（道具）`}
          description="后端槽位表只定义了角色/场景/服装的图片提示词槽位，道具没有；这类资产请在上面用手工填写。"
        />
      ) : null}

      <div className="text-[11px] text-gray-500">
        {`已选 ${plannedRows.length} 个资产待生成`}
        {onlyMissing && !includeExisting ? '（已有提示词的会被跳过）' : ''}
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
          { title: '资产', dataIndex: 'name', width: 150, render: (value: string, row) => `${value}（${row.type}）` },
          { title: '槽位', dataIndex: 'category', width: 130, render: (value: string, row) => (row.supported ? ASSET_PROMPT_CATEGORY_LABEL[value] ?? value : '不支持（无槽位）') },
          { title: '已有提示词', dataIndex: 'existing', width: 140, render: (value: string) => (value ? `${value.length} 字` : '—') },
          {
            title: '状态 / 生成结果（可编辑）',
            dataIndex: 'draft',
            render: (value: string, row) => {
              if (!row.supported) return <span className="text-[11px] text-gray-400">该资产类型没有大模型槽位</span>
              const label =
                row.status === 'saved'
                  ? '已保存'
                  : row.status === 'failed'
                    ? '失败'
                    : row.status === 'running'
                      ? '生成中'
                      : row.status === 'generated'
                        ? '已生成'
                        : '待生成'
              const color = row.status === 'saved' ? 'green' : row.status === 'failed' ? 'red' : row.status === 'running' ? 'blue' : 'gold'
              return (
                <div className="space-y-1">
                  <Tag color={color}>{label}</Tag>
                  {row.error ? <span className="text-[11px] text-red-500">{row.error}</span> : null}
                  <Input.TextArea
                    rows={3}
                    value={value}
                    disabled={row.status === 'failed'}
                    placeholder="点上面的「生成图片提示词」后在这里检查/修改"
                    onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) =>
                      setRows((prev) => prev.map((item) => (item.key === row.key ? { ...item, draft: event.target.value } : item)))
                    }
                  />
                  <Space size={8}>
                    <Button
                      size="small"
                      type="primary"
                      loading={savingKey === row.key}
                      disabled={row.status !== 'generated' || !row.llmCalled || !row.draft.trim()}
                      onClick={() => void saveOne(row)}
                    >
                      保存到资产
                    </Button>
                    {row.status === 'generated' && !row.llmCalled ? (
                      <span className="text-[11px] text-amber-600">演练结果：未调用大模型，不可保存</span>
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
