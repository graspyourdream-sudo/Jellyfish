/**
 * 分镜工作室 · 页面容器（第 3–5 步共用）。
 *
 * 设计依据：`storyboard-studio.html`（第 11 页，最高优先级视觉依据）与 `HANDOFF.md` §4。
 *
 * 布局（1440×900 不整页长滚动，各区域局部滚动）：
 *
 * ```
 * ├─ ProjectContextBar   项目 · 章节 · 当前步骤 · 保存状态 · 调用次数 · 出口
 * ├─ ProductionStepper    常驻五步（只高亮真实当前步）
 * ├─ StudioPhaseBar       分镜工作室 + 阶段条 3/4/5 + 当前镜头
 * ├─ StudioBody
 * │   ├─ StudioSide       引用素材（合并成一份）+ 资产与声音（只读摘要）
 * │   ├─ StudioMid        当前阶段主工作区（唯一主操作在这里）
 * │   └─ StudioPreview    本镜预览与结果
 * └─ StudioRail           底部分镜胶片条（横向滑动卡片 + 勾选 + 批量下载）
 * ```
 *
 * **切换阶段不离开分镜工作室**：整个容器只换中栏内容，左右栏与底部胶片条原地不动，
 * 当前镜头与已选集合都不重置（阶段条自己只改 `?studio=` 参数）。
 */

import type { ReactNode } from 'react'

import './studioShell.css'

import { ProjectContextBar, type ProjectContextBarProps } from './ProjectContextBar'
import { ProductionStepper } from './ProductionStepper'
import {
  getStudioPhase,
  STUDIO_CONTAINER_LABEL,
  STUDIO_PHASES,
  type StudioPhaseKey,
} from './studioPhase'

export type StudioShellProps = {
  /** 顶部上下文条（不传则不渲染整个头部，便于单测/嵌入） */
  context?: ProjectContextBarProps | null
  /** 当前全局五步序号（0 起） */
  currentStepIndex: number
  doneStepIndexes?: number[]
  onStepClick?: (index: number, label: string) => void
  stepNote?: (index: number) => string
  /** 当前阶段 */
  phase: StudioPhaseKey
  onPhaseChange: (phase: StudioPhaseKey) => void
  /** 当前镜头的展示名（「SH-03 · 现榨动作 · 特写」） */
  currentShotLabel: string
  /** 阶段条右侧提示（默认是"切阶段不离开分镜工作室"） */
  phaseHint?: ReactNode
  side: ReactNode
  /** 中栏：当前阶段的主工作区 */
  center: ReactNode
  preview: ReactNode
  rail: ReactNode
}

export function StudioShell({
  context,
  currentStepIndex,
  doneStepIndexes = [],
  onStepClick,
  stepNote,
  phase,
  onPhaseChange,
  currentShotLabel,
  phaseHint,
  side,
  center,
  preview,
  rail,
}: StudioShellProps) {
  return (
    <div className="studio-shell" data-testid="studio-shell">
      {context ? (
        <ProjectContextBar
          {...context}
          stepText={context.stepText || `第 ${currentStepIndex + 1} 步 · ${getStudioPhase(phase).stepLabel}`}
        />
      ) : null}

      <ProductionStepper
        currentIndex={currentStepIndex}
        doneIndexes={doneStepIndexes}
        studioPhase={phase}
        onStepClick={onStepClick}
        stepNote={stepNote}
      />

      <div className="studio-phasebar" data-testid="studio-phase-bar">
        <span className="studio-phasebar__name">{STUDIO_CONTAINER_LABEL}</span>
        <span className="studio-seg" role="tablist" aria-label="工作室阶段">
          {STUDIO_PHASES.map((item) => {
            const isActive = item.key === phase
            return (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={['studio-seg__btn', isActive ? 'is-active' : ''].join(' ')}
                data-studio-phase={item.key}
                onClick={() => onPhaseChange(item.key)}
              >
                {item.label}
              </button>
            )
          })}
        </span>
        <span className="studio-phasebar__shot">
          当前镜头：<b data-testid="studio-current-shot">{currentShotLabel || '未选择'}</b>
        </span>
        <span className="studio-phasebar__hint" data-testid="studio-phase-hint">
          {phaseHint ?? '切换阶段不离开分镜工作室 —— 当前镜头与滚动位置保持不变'}
        </span>
      </div>

      {/* 阶段面板**按阶段挂载**：只换中栏，左右栏与底部胶片条原地不动，
          当前镜头与已选集合都不会被重置（切阶段不丢镜头的关键）。 */}
      <div className="studio-body">
        <aside className="studio-side" data-testid="studio-side">
          <div className="studio-side__scroll">{side}</div>
        </aside>
        <section className="studio-mid" data-testid="studio-mid">
          {center}
        </section>
        <aside className="studio-preview" data-testid="studio-preview">
          <div className="studio-preview__scroll">{preview}</div>
        </aside>
      </div>

      <div className="studio-rail" data-testid="studio-rail">
        {rail}
      </div>
    </div>
  )
}

export default StudioShell
