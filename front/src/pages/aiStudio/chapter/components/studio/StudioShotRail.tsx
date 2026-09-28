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

import { Button, Checkbox, Dropdown, Modal, message } from 'antd'
import type { MenuProps } from 'antd'

import {
  downloadVideoBundleZip,
  previewVideoBundle,
  type VideoBundlePlan,
} from '../../../../../services/videoDeliveryApi'
import {
  blockedReasonFor,
  countRailStates,
  isAllDeliverableSelected,
  selectAllDeliverable,
  summarizeRailSelection,
  toggleShotPick,
  type RailShotView,
} from './shotRailModel'
import type { StudioPhaseKey } from '../../../components/studio/studioPhase'
import { toUserFacingText } from '../../../components/userFacingMessage'

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
  projectId?: string | null
  chapterId?: string | null
  /** 当前阶段（下载确认窗口里说明范围时用） */
  phase: StudioPhaseKey
}

export function StudioShotRail({
  shots,
  activeShotId,
  selectedShotIds,
  onSelectedShotIdsChange,
  onSelectShot,
  onReorder,
  onShotContextMenu,
  projectId,
  chapterId,
  phase,
}: StudioShotRailProps) {
  const [downloading, setDownloading] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  /**
   * 后端预检结论（**权威**的"包含几条 / 排除几条"）。
   *
   * 本地那份 `summarizeRailSelection` 是即时反馈（勾选时立刻更新按钮与文案），
   * 打开确认窗口时再读一次后端预检：真正会不会进包由后端按"镜头是否已有成片"判定，
   * 页面不替它下结论。
   */
  const [plan, setPlan] = useState<VideoBundlePlan | null>(null)
  const [planLoading, setPlanLoading] = useState(false)
  /** 拖拽排序的即时状态（只影响视觉反馈；真正的重排由 `onReorder` 负责） */
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const counts = countRailStates(shots)
  const selection = summarizeRailSelection(shots, selectedShotIds)
  const allSelected = isAllDeliverableSelected(shots, selectedShotIds)

  /** 打开下载确认：先读一次预检（**不读字节**），把"包含几条 / 排除几条"摆在用户面前。 */
  const openConfirm = () => {
    if (!projectId) {
      void message.warning('还没有读到项目信息，暂时不能打包下载')
      return
    }
    if (!selection.canDownload) {
      void message.warning(selection.message)
      return
    }
    setPlan(null)
    setConfirmOpen(true)
    setPlanLoading(true)
    void previewVideoBundle({
      projectId,
      scope: 'episode',
      chapterId,
      shotIds: selectedShotIds,
    })
      .then((value) => setPlan(value))
      .catch((error) => void message.error(toUserFacingText(error, '读取可下载数量失败，请稍后重试')))
      .finally(() => setPlanLoading(false))
  }

  const doDownload = async () => {
    if (!projectId) return
    setDownloading(true)
    try {
      const result = await downloadVideoBundleZip({
        projectId,
        scope: 'episode',
        chapterId,
        shotIds: selectedShotIds,
      })
      void message.success(
        result.excluded > 0
          ? `已打包下载 ${result.included} 条成片（另有 ${result.excluded} 个镜头没有可交付成片，未包含）：${result.filename}`
          : `已打包下载 ${result.included} 条成片：${result.filename}`,
      )
      setConfirmOpen(false)
    } catch (error) {
      // 错误文案是产品自己的中文句子（404 的业务结论由后端给），这里原样透出
      void message.error(toUserFacingText(error, '打包下载失败，请稍后重试'))
    } finally {
      setDownloading(false)
    }
  }

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
          loading={downloading}
          onClick={openConfirm}
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

      <Modal
        title="确认批量下载"
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onOk={() => void doDownload()}
        okText={`下载已选（${plan?.included_count ?? selection.deliverable} 条）`}
        cancelText="取消"
        okButtonProps={{ disabled: !(plan ? plan.has_content : selection.canDownload) }}
        confirmLoading={downloading}
        width={520}
        destroyOnHidden
      >
        <div className="space-y-2 text-sm">
          <div>
            {plan
              ? `本次会打包 ${plan.included_count} 条成片${plan.excluded_count > 0 ? `；另有 ${plan.excluded_count} 个镜头没有可交付成片，未包含。` : '。'}`
              : selection.message}
          </div>
          {planLoading ? <div className="text-xs text-gray-400">正在核对可交付数量…</div> : null}
          {plan && plan.excluded.length > 0 ? (
            <div className="rounded border border-solid border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
              <div className="font-medium">被排除的镜头</div>
              <ul className="mt-1 list-disc pl-4">
                {plan.excluded.map((item) => (
                  <li key={item.shot_id}>{`${item.shot_code} · ${item.shot_title}：${item.reason}`}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {!plan && !planLoading && selection.blockedShots.length > 0 ? (
            <div className="rounded border border-solid border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
              <div className="font-medium">被排除的镜头</div>
              <ul className="mt-1 list-disc pl-4">
                {selection.blockedShots.map((shot) => (
                  <li key={shot.id}>{`${shot.code} · ${shot.title}：${blockedReasonFor(shot)}`}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="text-xs leading-5 text-gray-500">
            包里是每个镜头**生成成功并已落库**的那份成片（失败与半成品不会进包），
            另外附一份「交付清单.txt」写明每个镜头对应的文件名与排除原因。本操作只读，不产生任何生成费用。
          </div>
          <div className="text-xs text-gray-400">{`当前阶段：${phase === 'deliver' ? '5 生成与交付' : phase === 'binding' ? '4 资产与声音检查' : '3 整集视频提示词'}`}</div>
        </div>
      </Modal>
    </>
  )
}

export default StudioShotRail
