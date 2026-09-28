/**
 * 分镜工作室 · 阶段 4「资产与声音检查」的**只读**核对表（设计包 §10 / 任务书第十三部分）。
 *
 * 这一块**只做展示**，出现的每个按钮都是"去别的地方处理"，没有一个写入口：
 *
 * | 行 | 内容 | 缺项时的去处 |
 * |---|---|---|
 * | 人物 / 场景 / 道具 / 服装 / 商品 | 本镜已关联的资产名（来自「出现镜头」） | 去第 2 步资产准备 |
 * | 角色声音 | 继承结果与来源（「音色名 · 继承自人物资产」） | 返回人物资产补充 |
 *
 * 硬约束（有测试钉住）：
 * - 这里**没有**选择音色 / 试听 / 更换 / 保存的入口，也不回写任何数据；
 * - 不把角色声音与配乐、环境音、音效或成片音轨混在一起（那些不属于人物资产）；
 * - 「本镜无需声音」只是镜头生成规则，不修改人物资产的声音绑定；
 * - 不显示内部标识（镜头 id / 文件 id / 接口路径）。
 */

import type { ReactNode } from 'react'

import { Button, Tooltip } from 'antd'

import type { ShotAssetOverviewItem } from '../../../../../services/generated'

/** 五类资产在核对表里的顺序与文案（**业务顺序**，与第 2 步页签一致）。 */
const ASSET_ROWS: Array<{ type: ShotAssetOverviewItem['type']; label: string; missingHint: string }> = [
  { type: 'character', label: '人物', missingHint: '本镜还没有关联人物资产' },
  { type: 'scene', label: '场景', missingHint: '本镜还没有关联场景资产' },
  { type: 'prop', label: '道具', missingHint: '本镜还没有关联道具资产' },
  { type: 'costume', label: '服装', missingHint: '本镜还没有关联服装资产' },
  { type: 'product', label: '商品', missingHint: '本镜还没有关联商品资产' },
]

/** 第 2 步页签（缺哪个类型就落到哪个页签，不让用户自己找）。 */
const TAB_BY_TYPE: Record<ShotAssetOverviewItem['type'], string> = {
  character: 'roles',
  scene: 'scenes',
  prop: 'props',
  costume: 'costumes',
  product: 'products',
}

export type ShotAssetChecklistProps = {
  items: ShotAssetOverviewItem[]
  /** 跳第 2 步资产准备（**必传**：缺项必须有明确的下一步去处，不给死按钮） */
  onGoAssetPrep: (tab: string) => void
  /** 角色声音只读区块（`ShotVoiceInheritancePanel`） */
  voicePanel?: ReactNode
}

export function ShotAssetChecklist({ items, onGoAssetPrep, voicePanel }: ShotAssetChecklistProps) {
  const linkedByType = new Map<ShotAssetOverviewItem['type'], ShotAssetOverviewItem[]>()
  for (const item of items) {
    // **只认已关联的**：候选项还没确认，不算"本镜已有这个资产"
    if (item.source === 'candidate') continue
    const list = linkedByType.get(item.type) ?? []
    list.push(item)
    linkedByType.set(item.type, list)
  }

  return (
    <div className="space-y-2" data-testid="shot-asset-checklist">
      <div className="grid gap-2">
        {ASSET_ROWS.map((row) => {
          const linked = linkedByType.get(row.type) ?? []
          const ready = linked.length > 0
          const names = linked.map((item) => item.name).filter(Boolean)
          return (
            <div key={row.type} className={['st-checkrow', ready ? '' : 'is-miss'].join(' ')}>
              <span className="st-checkrow__k">{row.label}</span>
              <span className="st-checkrow__v">
                {ready ? (
                  <Tooltip title={names.join(' / ')}>
                    {`${names.length} 项：${names.slice(0, 3).join('、')}${names.length > 3 ? '…' : ''}`}
                  </Tooltip>
                ) : (
                  row.missingHint
                )}
              </span>
              {ready ? (
                <span className="st-tag st-tag--success">已就绪</span>
              ) : (
                <Button size="small" onClick={() => onGoAssetPrep(TAB_BY_TYPE[row.type])} data-testid={`go-asset-prep-${row.type}`}>
                  去第 2 步补充
                </Button>
              )}
            </div>
          )
        })}

        {/* 角色声音：只读继承结果 + 缺项时的唯一去处（人物资产） */}
        <div className="st-checkrow" data-testid="shot-voice-row">
          <span className="st-checkrow__k">声音</span>
          <span className="st-checkrow__v">{voicePanel}</span>
        </div>
      </div>
      <div className="st-miss">
        本步只核对：<b>不提供选择、试听、更换或保存入口</b>，也不支持按镜头覆盖声音。要改声音，请回第 2 步人物资产详情绑定后回到本页核对。
      </div>
    </div>
  )
}

export default ShotAssetChecklist
