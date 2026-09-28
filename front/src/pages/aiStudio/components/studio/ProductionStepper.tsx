/**
 * 公共五步导航（常驻）。
 *
 * 设计依据：`HANDOFF.md` §4/§5.4 与 `storyboard-studio.html` 顶部 `.stepper`：
 * - 五步顺序固定、名称**只出现一次**；
 * - 只高亮**真实**当前步骤；点其它步骤**不移动高亮、不切换内容**，
 *   只给该步骤的解锁原因（原型口径，不许做假跳转）；
 * - 未解锁的步骤 `aria-disabled="true"`；
 * - 右侧常驻「第 N 步 · 名称」，任何滚动位置都能回答"我在第几步"。
 *
 * 为什么不复用项目工作台的 `ProjectStepNav`：那一版是 antd `Tabs`（页签外观、
 * 自身带路由跳转语义），工作室要的是**只读进度指示 + 解锁原因提示**，
 * 语义不同；两者都读同一份 `DISPLAY_STEPS` 口径（见 `studioPhase.ts` 的 `GLOBAL_STEPS`）。
 */

import { Tooltip } from 'antd'

import { CheckOutlined } from '@ant-design/icons'

import { getStudioPhase, STUDIO_CONTAINER_LABEL, type StudioPhaseKey } from './studioPhase'

export type ProductionStepperProps = {
  /** 当前所在的全局五步序号（0 起）。工作室里由阶段推出来。 */
  currentIndex: number
  /** 已经完成的步骤序号集合（按全局序号，0 起） */
  doneIndexes?: number[]
  /** 第 1 步在第 3 步之后仍然可见（工作室里"在分镜工作室做"） */
  studioPhase?: StudioPhaseKey | null
  /** 点击某个步骤：给解锁原因 / 提示，**不切换内容**（由调用方决定） */
  onStepClick?: (index: number, label: string) => void
  /** 该步骤的解锁原因 / 补充说明（返回空串表示"就是当前步"） */
  stepNote?: (index: number) => string
  /** 右侧常驻区（默认渲染「第 N 步 · 名称」） */
  right?: React.ReactNode
}

/** 全局五步名称（与 `studioPhase.ts` 的 `GLOBAL_STEPS` 保持同一份口径）。 */
const STEP_LABELS = ['剧本与分镜', '资产准备', '整集视频提示词', '资产与声音检查', '生成与交付']

export function ProductionStepper({
  currentIndex,
  doneIndexes = [],
  studioPhase = null,
  onStepClick,
  stepNote,
  right,
}: ProductionStepperProps) {
  const safeIndex = Math.min(Math.max(currentIndex, 0), STEP_LABELS.length - 1)
  const currentLabel = STEP_LABELS[safeIndex]

  return (
    <nav className="studio-stepper" aria-label="制作步骤" data-testid="production-stepper">
      <div className="studio-stepper__steps">
        {STEP_LABELS.map((label, index) => {
          const isActive = index === safeIndex
          const isDone = !isActive && doneIndexes.includes(index)
          // 第 3-5 步共用分镜工作室：点它们不跳页，只说明"在分镜工作室里做"。
          const note =
            stepNote?.(index) ||
            (isActive
              ? `第 ${index + 1} 步 · 当前步骤`
              : studioPhase && index >= 2
                ? `第 ${index + 1} 步 · 在「${STUDIO_CONTAINER_LABEL}」里做`
                : `第 ${index + 1} 步 · 未解锁`)
          return (
            <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {index > 0 ? <span className="studio-stepper__arrow">›</span> : null}
              <Tooltip title={note}>
                <button
                  type="button"
                  className={['studio-step', isActive ? 'is-active' : '', isDone ? 'is-done' : ''].join(' ')}
                  data-step={index + 1}
                  aria-current={isActive ? 'step' : undefined}
                  aria-disabled={!isActive}
                  onClick={() => onStepClick?.(index, label)}
                >
                  <span className="studio-step__no">{isDone ? <CheckOutlined /> : index + 1}</span>
                  <span className="studio-step__label">{label}</span>
                </button>
              </Tooltip>
            </span>
          )
        })}
      </div>
      <div className="studio-stepper__right">
        {right ?? (
          <>
            <span className="studio-stepper__current" data-testid="current-step-label">
              {`第 ${safeIndex + 1} 步 · ${currentLabel}`}
            </span>
            {studioPhase ? (
              <span className="st-hint">
                {`${STUDIO_CONTAINER_LABEL} · ${getStudioPhase(studioPhase).stepLabel}`}
              </span>
            ) : null}
          </>
        )}
      </div>
    </nav>
  )
}

export default ProductionStepper
