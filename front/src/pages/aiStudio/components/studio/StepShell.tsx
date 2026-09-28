/**
 * 公共五步外壳（**非工作室页面**用）：顶部项目上下文 + 常驻五步导航 + 内容区。
 *
 * 为什么单独一个组件：任务书第六部分要求「公共五步框架」在所有主页面统一实现 ——
 * 顶部项目上下文（项目 / 章节 / 当前步骤 / 保存状态 / 调用次数）、固定五步导航、
 * 唯一推荐下一步。分镜工作室用的是带阶段条与胶片条的重版（`StudioShell`），
 * 剧情策划这类**单页流程**用这个轻版，两者共用同一份 `studioPhase.ts` 口径与
 * 同一批 `ProjectContextBar` / `ProductionStepper` 组件，不各写一套。
 *
 * 硬口径：
 * - 五步名称只出现一次（第 3 步仍叫「整集视频提示词」）；
 * - 点非当前步骤**不移动高亮、不切换内容**，只说明它在哪完成（原型口径）；
 * - 「流程下一步」主按钮由调用方放在 `context.actions` 里，**同屏只允许一个**。
 */

import type { ReactNode } from 'react'

import './studioShell.css'

import { ProjectContextBar, type ProjectContextBarProps } from './ProjectContextBar'
import { ProductionStepper } from './ProductionStepper'

export type StepShellProps = {
  /** 顶部上下文条（不传则不渲染头部） */
  context?: ProjectContextBarProps | null
  /** 当前全局五步序号（0 起） */
  currentStepIndex: number
  /** 已完成的步骤序号（0 起） */
  doneStepIndexes?: number[]
  onStepClick?: (index: number, label: string) => void
  stepNote?: (index: number) => string
  /** 内容区最大宽度（默认 1240，与既有页面观感一致） */
  maxWidth?: number
  children: ReactNode
}

export function StepShell({
  context,
  currentStepIndex,
  doneStepIndexes = [],
  onStepClick,
  stepNote,
  maxWidth = 1240,
  children,
}: StepShellProps) {
  return (
    <div className="studio-shell" data-testid="step-shell">
      {context ? <ProjectContextBar {...context} /> : null}
      <ProductionStepper
        currentIndex={currentStepIndex}
        doneIndexes={doneStepIndexes}
        onStepClick={onStepClick}
        stepNote={stepNote}
      />
      <div className="studio-shell__body" data-testid="step-shell-body">
        <div className="studio-shell__inner" style={{ maxWidth }}>
          {children}
        </div>
      </div>
    </div>
  )
}

export default StepShell
