/**
 * 底部分镜胶片条（设计包第 11 页 `.rail`）。
 *
 * 口径（任务书第十一、十四部分）：
 * - 它是**横向滑动的卡片列表**，不是横贯整页的长通栏；每张卡 = 缩略图 + 镜号 + 标题 + 状态 + 缺项；
 * - 它同时就是**生成结果入口与批量下载入口**：卡片左上角可勾选，头部有「全选 / 已选 N 条 / 批量下载已选」；
 * - **勾选不触发镜头切换**（`onSelect` 与 `onTogglePick` 是两个独立的回调）；
 * - 批量下载走真实的 ZIP 接口（`videoDeliveryApi`），**不是**逐个打开下载窗口；
 * - 下载前显示「包含 N 条 / 排除 M 条」（由 `shotRailModel.summarizeRailSelection` 给出同一份结论）。
 */

import { useState } from 'react'

import { Button, Checkbox, Dropdown } from 'antd'
import type { MenuProps } from 'antd'

import {
  blockedReasonFor,
  countRailStates,
  isAllDeliverableSelected,
  selectAllDeliverable,
  summarizeRailSelection,
  toggleShotPick,
  type RailShotView,
} from './shotRailModel'

const TONE_CLASS: Record<RailShotView['statusTone'], string> = {
  neutral: '',
  info: 'st-tag--info',
  success: 'st-tag--success',
  warning: 'st-tag--warning',
  danger: 'st-tag--danger',
}

export type StudioShotRailProps = {
  shots: RailShotView[]
  /** 当前镜头（高亮） */
  activeShotId: string | null
  /** 已勾选（批量下载范围） */
  selectedShotIds: string[]
  onSelectedShotIdsChange: (ids: string[]) => void
  /**
   * 切换当前镜头（**勾选不会调它**）。
   *
   * 带上「在筛选结果里的序号」与鼠标事件：这样卡片仍支持
   * `Shift` 连选与 `Command/Ctrl` 加选（与改造前的左侧分镜列表逐条一致，
   * 属既有能力，不在本轮删掉）。
   */
  onSelectShot: (shotId: string, indexInFiltered: number, event: React.MouseEvent) => void
  /**
   * 拖拽调整分镜顺序（**既有能力**：改造前在左侧列表里拖，现在在胶片条上拖）。
   *
   * 传了才开启拖拽；实现仍是页面那一份（会同步写回后端 index）。
   */
  onReorder?: (sourceId: string, destId: string) => void
  /**
   * 右键菜单项（**既有能力**：改造前在左侧分镜列表上右键）。
   *
   * 返回 antd `MenuProps['items']`；返回空数组就不挂菜单。
   */
  onShotContextMenu?: (shotId: string) => MenuProps['items']
  /**
   * 批量下载已选：**实现放在外层**（`ChapterStudio`），
   * 与阶段 5 的「打包下载整集全部成片」共用同一个确认窗口与同一条出口B ZIP 链路。
   */
  onDownloadSelected: () => void
}

export function StudioShotRail({
  shots,
  activeShotId,
  selectedShotIds,
  onSelectedShotIdsChange,
  onSelectShot,
  onReorder,
  onShotContextMenu,
  onDownloadSelected,
}: StudioShotRailProps) {
  /** 拖拽排序的即时状态（只影响视觉反馈；真正的重排由 `onReorder` 负责） */
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const counts = countRailStates(shots)
  const selection = summarizeRailSelection(shots, selectedShotIds)
  const allSelected = isAllDeliverableSelected(shots, selectedShotIds)

  return (
    <>
      <div className="studio-rail__head">
        <span className="studio-rail__title">分镜列表</span>
        <span className="st-chip">{`共 ${counts.total} 镜`}</span>
        <span className="st-chip">{`可交付 ${counts.deliverable}`}</span>
        <span className="st-chip">{`生成中 ${counts.generating}`}</span>
        <span className="st-chip">{`待生成 ${counts.pending}`}</span>
        <span className="st-chip">{`失败 ${counts.failed}`}</span>
        <label className="studio-rail__all">
          <Checkbox
            checked={allSelected}
            indeterminate={!allSelected && selection.selected > 0}
            onChange={(e) => onSelectedShotIdsChange(e.target.checked ? selectAllDeliverable(shots) : [])}
            data-testid="rail-select-all"
          >
            全选
          </Checkbox>
        </label>
        <span className="st-hint" data-testid="rail-selection-summary">
          {`已选 ${selection.selected} 条`}
        </span>
        <Button
          size="small"
          style={{ marginLeft: 'auto' }}
          disabled={!selection.canDownload}
          onClick={onDownloadSelected}
          data-testid="rail-bulk-download"
        >
          {selection.selected > 0 ? `批量下载已选（${selection.deliverable}）` : '批量下载已选'}
        </Button>
      </div>

      <div className="studio-rail__scroll" data-testid="studio-rail-scroll">
        {shots.length === 0 ? (
          <div className="st-hint">本集还没有镜头。</div>
        ) : (
          shots.map((shot, indexInFiltered) => {
            const isActive = shot.id === activeShotId
            const isPicked = selectedShotIds.includes(shot.id)
            const isDragging = draggingId === shot.id
            const isDragOver = dragOverId === shot.id && draggingId !== null && draggingId !== shot.id
            return (
              <div
                key={shot.id}
                className={[
                  'studio-railcard',
                  isPicked ? 'is-selected' : '',
                  isDragOver ? 'is-drag-over' : '',
                ].join(' ')}
                data-shot-card={shot.code}
                draggable={Boolean(onReorder)}
                onDragStart={(e) => {
                  if (!onReorder) return
                  setDraggingId(shot.id)
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', shot.id)
                }}
                onDragOver={(e) => {
                  if (!onReorder) return
                  e.preventDefault()
                  if (draggingId && draggingId !== shot.id) setDragOverId(shot.id)
                }}
                onDragLeave={() => {
                  if (dragOverId === shot.id) setDragOverId(null)
                }}
                onDrop={(e) => {
                  if (!onReorder) return
                  e.preventDefault()
                  const sourceId = e.dataTransfer.getData('text/plain') || draggingId
                  setDragOverId(null)
                  setDraggingId(null)
                  if (sourceId && sourceId !== shot.id) onReorder(sourceId, shot.id)
                }}
                onDragEnd={() => {
                  setDragOverId(null)
                  setDraggingId(null)
                }}
                style={isDragging ? { opacity: 0.6 } : undefined}
              >
                <label className="studio-railcard__pick" title={shot.hasDeliverableVideo ? '加入批量下载' : blockedReasonFor(shot)}>
                  <Checkbox
                    checked={isPicked}
                    aria-label={`把 ${shot.code} 加入批量下载`}
                    onChange={() => onSelectedShotIdsChange(toggleShotPick(selectedShotIds, shot.id))}
                    data-testid={`rail-pick-${shot.code}`}
                  />
                </label>
                <Dropdown
                  trigger={['contextMenu']}
                  disabled={!onShotContextMenu}
                  menu={{ items: onShotContextMenu?.(shot.id) ?? [] }}
                >
                  <button
                    type="button"
                    className={['studio-railcard__open', isActive ? 'is-active' : ''].join(' ')}
                    onClick={(event) => onSelectShot(shot.id, indexInFiltered, event)}
                    aria-current={isActive ? 'true' : undefined}
                  >
                  <span className="studio-railcard__media">
                    {shot.thumbnail ? (
                      <img src={shot.thumbnail} alt="" loading="lazy" />
                    ) : shot.hasDeliverableVideo ? (
                      '视频缩略'
                    ) : (
                      '未生成'
                    )}
                  </span>
                  <span className="studio-railcard__body">
                    <span className="studio-railcard__row">
                      <span className="studio-railcard__no">{shot.code}</span>
                      <span className="studio-railcard__title" title={shot.title}>
                        {shot.title}
                      </span>
                    </span>
                    <span className="studio-railcard__row">
                      <span className={['st-tag', TONE_CLASS[shot.statusTone]].join(' ')}>{shot.statusLabel}</span>
                    </span>
                    <span className="studio-railcard__meta">{shot.meta}</span>
                    </span>
                  </button>
                </Dropdown>
              </div>
            )
          })
        )}
      </div>

    </>
  )
}

export default StudioShotRail
