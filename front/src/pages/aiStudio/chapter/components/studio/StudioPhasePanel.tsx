/**
 * 分镜工作室 · 中栏「阶段面板」（第 3 / 4 / 5 阶段各自的排版）。
 *
 * 设计依据：`storyboard-studio.html` 的中栏（`.mid`）。
 *
 * 三个阶段的**排版差别**只在这里，业务内容全部由 `ChapterStudio` 通过节点传入
 * （`promptSaved` / `promptEditor` / `generate` … 都是既有 Inspector 里那几块，
 * 不重写业务逻辑，也不复制一份请求）。
 *
 * 每个阶段**只有一个主操作**（任务书第六部分）：
 * - 阶段 3：生成视频（唯一主色按钮）；
 * - 阶段 4：没有主操作（只读核对，出向按钮都是"去别处处理"的次级按钮）；
 * - 阶段 5：没有主操作（生成任务的重试/停止是危险/次级按钮，下载是次级按钮）。
 *
 * 技术详情**不放在本面板的任何默认可见位置**：由调用方决定它进不进阶段 5 的收起区。
 */

import type { ReactNode } from 'react'

import type { StudioPhaseKey } from '../../../components/studio/studioPhase'
import { getStudioPhase } from '../../../components/studio/studioPhase'

/** 阶段 3 的区块（全部沿用既有实现，见 `StudioPhasePanelProps.parts` 的说明）。 */
export type StudioPhaseParts = {
  /** 已保存的提示词与来源（只读回显） */
  promptSaved?: ReactNode
  /** 提示词编辑区（含重新生成 / 保存） */
  promptEditor?: ReactNode
  /** 绑定与参考帧（编辑入口） */
  binding?: ReactNode
  /** 本次请求实际使用的帧（只读预检） */
  requestFrames?: ReactNode
  /** 本镜还缺什么 */
  gaps?: ReactNode
  /** 生成视频（唯一主操作在这里） */
  generate?: ReactNode
  /** 导出绑定提示词 */
  exportBlock?: ReactNode
  /** 提示词来源摘要（紧凑操作行左侧） */
  promptSourceSummary?: ReactNode
  /** 提示词操作（重新生成 / 保存） */
  promptActions?: ReactNode
  /**
   * 整集批量工具（批量生成提示词 / 批量导入 / 服务端草稿）。
   *
   * 任务书要求：原「分镜提示词中转页」**不再是第 3 步的主页面**，
   * 但它已有的真实能力必须留在工作室内 —— 这里就是那个落点（默认收起，展开时真实可用）。
   */
  batchTools?: ReactNode
  /** 对白与镜头内容（没有对白时为 null） */
  dialogue?: ReactNode | null
  /** 技术详情（默认收起） */
  technical?: ReactNode
}

/** 阶段 4 / 5 的区块（由页面构建，见 `StudioPhasePanelProps.extras` 的说明）。 */
export type StudioPhaseExtras = {
  /** 阶段 4：逐镜只读核对表 */
  checklist?: ReactNode
  /** 阶段 4：本集检查结果摘要 */
  checkSummary?: ReactNode
  /** 阶段 5：交付就绪情况 */
  deliveryReadiness?: ReactNode
  /** 阶段 5：生成任务 */
  deliveryTasks?: ReactNode
  /** 阶段 5：交付下载 */
  deliveryDownload?: ReactNode
}

export type StudioPhasePanelProps = {
  phase: StudioPhaseKey
  /** 当前镜头展示名（「SH-03 · 现榨动作 · 特写」） */
  currentShotLabel: string

  /**
   * 阶段 4 / 5 的区块由**页面**（`ChapterStudio`）构建后传进来。
   *
   * 为什么不让本组件自己去取数：这两块读的是「本集逐镜的就绪与生成结果」，
   * 数据在 `ChapterStudio` 手上（同一份判定也供底部胶片条使用）。
   * 让面板再取一次就会变成第二套口径 —— 那正是"一镜试通就显示整集已就绪"的成因。
   */
  extras?: StudioPhaseExtras

  /**
   * 阶段 3 的区块（由 `ChapterStudio` 的 Inspector 传入）。
   *
   * 这些区块就是既有实现本身（提示词编辑、绑定与参考帧、生成预检与提交、导出），
   * 这里只负责**排版**，不复制任何请求。
   */
  parts?: StudioPhaseParts

  /** 本镜业务状态（与外层列表同一份判定） */
  shotStatus?: { label: string; tone: 'default' | 'gold' | 'blue' | 'green' | 'red'; nextAction: string }
  /** 范围就绪摘要（勾选优先，否则整集） */
  scopeSummary?: ReactNode

  /* ---------------- 阶段 3 · 整集视频提示词 ---------------- */
  /** 分镜提示词卡：来源摘要（运行时 + 谁改过） */
  promptSourceSummary?: ReactNode
  /** 分镜提示词卡：重新生成 / 保存（紧凑操作行右侧） */
  promptActions?: ReactNode
  /** 已保存提示词与来源（只读回显） */
  promptSaved?: ReactNode
  /** 提示词正文编辑区 */
  promptEditor?: ReactNode
  /** 缺项提示（直接写在提示词区下面） */
  missingNotice?: ReactNode
  /** 生成视频卡内容（画幅 / 模型档位 / 分辨率 / 时长 + 唯一主操作） */
  generate?: ReactNode
  /** 对白与镜头内容（有对白时才有） */
  dialogue?: ReactNode | null

  /* ---------------- 阶段 4 · 资产与声音检查（只读） ---------------- */
  checklist?: ReactNode
  /** 本集检查结果摘要 */
  checkSummary?: ReactNode

  /* ---------------- 阶段 5 · 生成与交付 ---------------- */
  deliveryReadiness?: ReactNode
  deliveryTasks?: ReactNode
  deliveryDownload?: ReactNode

  /** 默认收起的技术详情（**只在阶段 5 渲染**，且由调用方决定是否传） */
  technical?: ReactNode
}

export function StudioPhasePanel({
  phase,
  currentShotLabel,
  extras,
  parts,
  shotStatus,
  scopeSummary,
  promptSourceSummary,
  promptActions,
  promptSaved,
  promptEditor,
  missingNotice,
  generate,
  dialogue,
  checklist,
  checkSummary,
  deliveryReadiness,
  deliveryTasks,
  deliveryDownload,
  technical,
}: StudioPhasePanelProps) {
  const meta = getStudioPhase(phase)

  if (phase === 'video_prompt') {
    return (
      <div className="studio-mid__phases" data-scene="video_prompt">
        <article className="st-card st-card--grow" data-testid="studio-prompt-card">
          <div className="st-card__head">
            <span className="st-card__title">分镜提示词</span>
            <span className="st-tag st-tag--info">{currentShotLabel || '未选择镜头'}</span>
            {shotStatus ? (
              <span className="st-tag" title={shotStatus.nextAction}>
                {`${shotStatus.label} · ${shotStatus.nextAction}`}
              </span>
            ) : null}
            <div className="st-card__right">
              {parts?.promptSourceSummary ?? promptSourceSummary}
              {parts?.promptActions ?? promptActions}
            </div>
          </div>
          {scopeSummary ? (
            <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--st-border)' }}>{scopeSummary}</div>
          ) : null}
          <div className="st-card__body" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {parts?.promptSaved ?? promptSaved}
            {parts?.promptEditor ?? promptEditor}
            {parts?.gaps ?? missingNotice}
          </div>
        </article>

        <article className="st-card" data-testid="studio-generate-card">
          <div className="st-card__head">
            <span className="st-card__title">生成视频</span>
            <div className="st-card__right">
              <span className="st-hint">失败不计费 · 结果保留在右侧预览与底部分镜列表</span>
            </div>
          </div>
          <div className="st-card__body">{parts?.generate ?? generate}</div>
        </article>

        {parts?.batchTools ? (
          <article className="st-card" data-testid="studio-batch-tools">
            <div className="st-card__head">
              <span className="st-card__title">整集批量</span>
              <div className="st-card__right">
                <span className="st-hint">批量生成 / 批量导入 / 服务端草稿（展开后可用）</span>
              </div>
            </div>
            <div className="st-card__body">{parts.batchTools}</div>
          </article>
        ) : null}

        {parts?.dialogue ?? dialogue ? <div className="mt-2">{parts?.dialogue ?? dialogue}</div> : null}
      </div>
    )
  }

  if (phase === 'binding') {
    return (
      <div className="studio-mid__phases" data-scene="binding">
        <article className="st-card st-card--grow" data-testid="studio-check-card">
          <div className="st-card__head">
            <span className="st-card__title">资产与声音检查</span>
            <span className="st-tag">只读</span>
            <div className="st-card__right">
              <span className="st-hint">按镜头核对 · 角色声音继承自第 2 步人物资产</span>
            </div>
          </div>
          <div className="st-card__body" style={{ overflowY: 'auto' }}>{extras?.checklist ?? checklist}</div>
        </article>
        {extras?.checkSummary ?? checkSummary}
      </div>
    )
  }

  return (
    <div className="studio-mid__phases" data-scene="deliver">
      {extras?.deliveryReadiness ?? deliveryReadiness}
      {extras?.deliveryTasks ?? (
        <article className="st-card st-card--grow" data-testid="studio-delivery-tasks">
          <div className="st-card__head">
            <span className="st-card__title">生成任务</span>
            <span className="st-tag st-tag--info">{`${meta.stepLabel} · ${currentShotLabel || '未选择镜头'}`}</span>
          </div>
          <div className="st-card__body" style={{ overflowY: 'auto' }}>
            {deliveryTasks}
          </div>
        </article>
      )}
      {extras?.deliveryDownload ?? deliveryDownload}
      {technical}
    </div>
  )
}

export default StudioPhasePanel
