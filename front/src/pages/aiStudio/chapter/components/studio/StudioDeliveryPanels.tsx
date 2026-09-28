/**
 * 分镜工作室 · 阶段 5「生成与交付」的三块面板（设计包第 11 页 `data-od-id="delivery-*"`）。
 *
 * 分层严格按设计：① 交付就绪情况 → ② 生成任务 → ③ 交付下载。
 *
 * 硬口径（任务书第十四部分）：
 * - **快速定位第一个未完成镜头**（一键，不用自己找）；
 * - 图片 / 视频 / 声音使用**一致的状态语言**（同一份 `statusLabel` / `statusTone`）；
 * - 失败项必须回答三件事：**是否计费 / 是否保留结果 / 是否可以重试**；
 * - 支持单镜重试（这里给的是"选中该镜并去生成"的真实入口，不假装自动重试）；
 * - 下载用的是**实际生成成功并已落库**的那份文件（失败与半成品不在其中）。
 *
 * 失败三件事的口径（**不许编造金额**）：
 *   本系统只在生成成功后落库结果。因此"失败这次没有可交付文件"是我们**确知**的事实；
 *   而"上游是否计费"我们**看不到**，所以如实说明「以账单为准」，不写"未计费"这种承诺。
 */

import type { ReactNode } from 'react'

import { Button, Progress, Tooltip } from 'antd'

import { blockedReasonFor, type RailShotView } from './shotRailModel'

export type StudioDeliveryPanelsProps = {
  shots: RailShotView[]
  activeShotId: string | null
  /** 单镜重试：选中该镜并去生成（**真实入口**，不是自动重试承诺） */
  onRetryShot: (shotId: string) => void
  /** 去看某一镜（切当前镜头） */
  onLocateShot: (shotId: string) => void
  /** 下载单个已生成的镜头（走真实的文件地址） */
  onDownloadShot: (shotId: string) => void
  /** 正在下载的那一镜（按钮 loading） */
  downloadingShotId?: string | null
  /** 批量下载已选（与底部胶片条**同一份实现**） */
  onDownloadSelected: () => void
  /**
   * **整集打包下载**（不看勾选，按镜头顺序）—— 这是整集交付的**正式形态**。
   *
   * 交付物就是一个 ZIP：包内是每个镜头**生成成功并已落库**的那份成片文件，
   * 文件名自带镜号（`S001_…`），按镜头顺序排列，交给剪辑环节即可直接按序使用；
   * 包里另附「交付清单.txt」逐行写明包内文件名与排除原因。
   */
  onDownloadWholeEpisode?: () => void
  wholeEpisodeCount?: number
  selectedCount: number
  /** 下载交付清单（后端既有 TXT 出口） */
  onDownloadManifest?: () => void
  manifestDisabled?: boolean
  /** 交付清单附带的补充说明（例如"带了哪些绑定素材"） */
  manifestHint?: ReactNode
}

/** 第一个还没完成的镜头（"未完成" = 没有可交付成片），全部完成时返回 null。 */
export function firstIncompleteShot(shots: readonly RailShotView[]): RailShotView | null {
  return shots.find((shot) => !shot.hasDeliverableVideo) ?? null
}

export function DeliveryReadinessCard({
  shots,
  onLocateFirstIncomplete,
}: {
  shots: RailShotView[]
  onLocateFirstIncomplete: (shotId: string) => void
}) {
  const total = shots.length
  const done = shots.filter((shot) => shot.hasDeliverableVideo).length
  const pendingShot = firstIncompleteShot(shots)
  const percent = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <article className="st-card" data-testid="studio-delivery-readiness">
      <div className="st-card__head">
        <span className="st-card__title">交付就绪情况</span>
        {pendingShot ? (
          <span className="st-tag st-tag--warning">{`还差 ${total - done} 镜`}</span>
        ) : (
          <span className="st-tag st-tag--success">
            {total > 0 ? '全部可交付' : '本集还没有镜头'}
          </span>
        )}
        <div className="st-card__right">
          {pendingShot ? (
            <Button
              size="small"
              onClick={() => onLocateFirstIncomplete(pendingShot.id)}
              data-testid="locate-first-incomplete"
            >
              {`定位第一个未完成镜头（${pendingShot.code}）`}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="st-card__body">
        <div className="text-[13px] leading-6">
          {total === 0
            ? '本集还没有镜头，请先在第 1 步完成分镜。'
            : `${total} 镜中 ${done} 镜已有可交付成片${pendingShot ? `；${pendingShot.code} 还没有可交付的成片。` : '，整集可以交付。'}`}
        </div>
        <Progress percent={percent} size="small" showInfo={false} style={{ marginTop: 8 }} />
        <div className="st-hint" style={{ marginTop: 6 }}>
          失败与未生成的镜头不会进交付包；失败这次不会留下半成品，也不影响其它镜头。
        </div>
      </div>
    </article>
  )
}

export function DeliveryTasksCard({
  shots,
  activeShotId,
  onRetryShot,
  onLocateShot,
  onDownloadShot,
  downloadingShotId,
}: Pick<
  StudioDeliveryPanelsProps,
  'shots' | 'activeShotId' | 'onRetryShot' | 'onLocateShot' | 'onDownloadShot' | 'downloadingShotId'
>) {
  const unfinished = shots.filter((shot) => !shot.hasDeliverableVideo)
  // 缺口优先：没成片的排前面，用户一眼看到还差什么
  const ordered = [...unfinished, ...shots.filter((shot) => shot.hasDeliverableVideo)]
  const generating = shots.filter((shot) => shot.statusTone === 'info').length

  return (
    <article className="st-card st-card--grow" data-testid="studio-delivery-tasks">
      <div className="st-card__head">
        <span className="st-card__title">生成任务</span>
        {generating > 0 ? (
          <span className="st-tag st-tag--info">{`${generating} 个进行中`}</span>
        ) : (
          <span className="st-tag">{generating === 0 ? '没有进行中的任务' : ''}</span>
        )}
      </div>
      <div className="st-card__body" style={{ overflowY: 'auto' }}>
        {ordered.length === 0 ? (
          <div className="st-hint">本集还没有镜头。</div>
        ) : (
          <div className="grid gap-2">
            {ordered.map((shot) => {
              const isActive = shot.id === activeShotId
              const isFailed = shot.statusTone === 'danger'
              return (
                <div
                  key={shot.id}
                  className="st-checkrow"
                  data-shot-row={shot.code}
                  style={
                    isActive
                      ? { borderColor: 'var(--st-accent)', background: 'var(--st-accent-soft)' }
                      : isFailed
                        ? { borderColor: 'var(--st-danger-border)', background: 'var(--st-danger-soft)' }
                        : undefined
                  }
                >
                  <span className="studio-railcard__no">{shot.code}</span>
                  <span className="st-checkrow__v">
                    <div className="font-medium">{shot.title || '未命名镜头'}</div>
                    <div className="st-hint">
                      {shot.hasDeliverableVideo
                        ? '已生成 · 可交付'
                        : isFailed
                          ? '生成失败：这次没有落库任何结果（可交付文件为空）；是否计费以账单为准；可以直接重试，其它镜头不受影响。'
                          : blockedReasonFor(shot)}
                    </div>
                  </span>
                  <span
                    className={[
                      'st-tag',
                      shot.hasDeliverableVideo
                        ? 'st-tag--success'
                        : isFailed
                          ? 'st-tag--danger'
                          : shot.statusTone === 'info'
                            ? 'st-tag--info'
                            : '',
                    ].join(' ')}
                  >
                    {shot.statusLabel}
                  </span>
                  {shot.hasDeliverableVideo ? (
                    <Tooltip title="下载这一镜**实际生成好的那份成片**（不是临时候选）">
                      <Button
                        size="small"
                        loading={downloadingShotId === shot.id}
                        onClick={() => onDownloadShot(shot.id)}
                        data-testid={`delivery-download-${shot.code}`}
                      >
                        下载
                      </Button>
                    </Tooltip>
                  ) : (
                    <Button
                      size="small"
                      type={isFailed ? 'primary' : 'default'}
                      danger={isFailed}
                      onClick={() => (isFailed ? onRetryShot(shot.id) : onLocateShot(shot.id))}
                      data-testid={`delivery-action-${shot.code}`}
                    >
                      {isFailed ? '重试' : '去生成'}
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </article>
  )
}

export function DeliveryDownloadCard({
  shots,
  selectedCount,
  onDownloadSelected,
  onDownloadWholeEpisode,
  wholeEpisodeCount,
  onDownloadManifest,
  manifestDisabled,
  manifestHint,
}: Pick<
  StudioDeliveryPanelsProps,
  | 'shots'
  | 'selectedCount'
  | 'onDownloadSelected'
  | 'onDownloadWholeEpisode'
  | 'wholeEpisodeCount'
  | 'onDownloadManifest'
  | 'manifestDisabled'
  | 'manifestHint'
>) {
  const deliverable = shots.filter((shot) => shot.hasDeliverableVideo).length
  return (
    <article className="st-card" data-testid="studio-delivery-download">
      <div className="st-card__head">
        <span className="st-card__title">交付下载</span>
        <span className="st-tag">{`可交付 ${deliverable} 条`}</span>
        <span className="st-tag st-tag--info">{`已选 ${selectedCount} 条`}</span>
      </div>
      <div className="st-card__body">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Button
            size="small"
            disabled={deliverable === 0}
            onClick={onDownloadSelected}
            data-testid="delivery-bulk-download"
          >
            下载所选成片（打包 ZIP）
          </Button>
          {onDownloadWholeEpisode ? (
            <Tooltip title="整集交付的正式形态：把本集所有已生成的成片按镜头顺序打成一个 ZIP（包内文件名自带镜号）">
              <Button
                size="small"
                disabled={(wholeEpisodeCount ?? deliverable) === 0}
                onClick={onDownloadWholeEpisode}
                data-testid="delivery-whole-episode"
              >
                {`打包下载整集全部成片（ZIP · ${wholeEpisodeCount ?? deliverable} 条）`}
              </Button>
            </Tooltip>
          ) : null}
          {onDownloadManifest ? (
            <Button
              size="small"
              type="default"
              disabled={manifestDisabled}
              onClick={onDownloadManifest}
              data-testid="delivery-download-manifest"
            >
              下载交付清单
            </Button>
          ) : null}
        </div>
        <div className="st-hint" style={{ marginTop: 8 }}>
          整集打包与勾选打包走的是**同一条**下载链路（真实 ZIP 接口），包里只含每个镜头
          <b>生成成功并已落库、且已被采用 / 定版</b>的那份成片，另附一份「交付清单.txt」逐行写明
          包内文件名与排除原因。包内是<b>按镜号命名的逐个镜头成片文件</b>，按镜头顺序排列。
          失败、未生成、以及只在本机不可用的镜头会被排除，<b>下载前会先显示排除数量</b>。
        </div>
        {manifestHint ? <div className="st-hint" style={{ marginTop: 6 }}>{manifestHint}</div> : null}
      </div>
    </article>
  )
}

/** 阶段 4 的「本集检查结果」摘要（只读）。 */
export function AssetCheckSummaryCard({
  totalShots,
  linkedShots,
  voiceMissingNote,
}: {
  totalShots: number
  linkedShots: number
  /** 声音缺项的口径说明（每镜结论来自核对表，这里只说清"去哪补"） */
  voiceMissingNote?: ReactNode
}) {
  return (
    <article className="st-card" data-testid="studio-check-summary">
      <div className="st-card__head">
        <span className="st-card__title">本集检查结果</span>
      </div>
      <div className="st-card__body">
        <div className="text-[13px] leading-6">
          {totalShots === 0
            ? '本集还没有镜头。'
            : `${totalShots} 镜中 ${linkedShots} 镜已经关联了资产；未关联的镜头在上面的核对表里逐条列出，点「去第 2 步补充」即可。`}
        </div>
        <div className="st-hint" style={{ marginTop: 6 }}>
          {voiceMissingNote ??
            '角色声音只显示继承结果与来源：缺角色声音时请回第 2 步的人物资产详情补充，本步不提供第二套选择或更换入口。'}
        </div>
      </div>
    </article>
  )
}
