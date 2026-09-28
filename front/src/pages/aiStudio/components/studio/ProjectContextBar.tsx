/**
 * 顶部项目上下文条（五步外壳的常驻头部）。
 *
 * 设计依据：`HANDOFF.md` §4/§5.3 与三个高保真页的 `.ctxbar`（高 56）：
 * - 回答四个问题：在哪个项目 / 哪一集 / 第几步 / 有没有保存；
 * - 右侧给**费用提示**（本步已发生的真实调用次数）与出口按钮；
 * - 切章节只换内容，不重排导航。
 *
 * ## 数据口径（不许编造）
 *
 * - 项目名：`GET /api/v1/studio/projects/{project_id}`（真实接口；读不到就不显示，
 *   不拿 id 顶替、不写死名字）；
 * - 章节名：调用方传入（已经在手上，不重复请求）；
 * - 保存状态：调用方传入（页面自己知道自己有没有在存）；
 * - 费用：本环境**没有**单价数据，所以这里只显示**真实调用次数**，并明确写
 *   「费用以账单为准」而不是编一个金额上屏。次数来自任务链接的真实查询结果。
 */

import { useEffect, useState } from 'react'

import { ArrowLeftOutlined, CheckCircleOutlined, ClockCircleOutlined, InfoCircleOutlined } from '@ant-design/icons'
import { Tooltip } from 'antd'

import { StudioProjectsService } from '../../../../services/generated'

export type ProjectContextBarProps = {
  projectId?: string | null
  chapterLabel: string
  /** 「当前步骤：第 3 步 · 整集视频提示词」这类文案 */
  stepText: string
  /** 保存中（true）/ 已保存（false）；null = 不显示保存态 */
  saving?: boolean | null
  /** 本步真实发生的调用次数（读不到时传 null，不编） */
  callCount?: number | null
  onBack?: () => void
  /** 右侧出口按钮区（进入下一步 / 预览成片） */
  actions?: React.ReactNode
}

/**
 * 项目名读取的**单一实现**（上下文条与页面共用）。
 *
 * 失败时**静默降级**为空串：上下文条少一个名字不影响干活，
 * 但绝不能把内部 id 当名字显示（审计 §4.2 模式 3 的同类问题）。
 * 因此调用方拿到的要么是真实名字，要么是空串 —— 没有第三种取值。
 */
export async function fetchProjectName(projectId: string): Promise<string> {
  try {
    const response = await StudioProjectsService.getProjectApiV1StudioProjectsProjectIdGet({ projectId })
    const data = (response as { data?: { name?: string } } | null)?.data
    return String(data?.name ?? '').trim()
  } catch {
    return ''
  }
}

/** 读项目名的 hook（只有这一处请求实现，页面不另写一份）。 */
export function useProjectName(projectId: string | null | undefined): string {
  const [name, setName] = useState('')
  useEffect(() => {
    let cancelled = false
    if (!projectId) {
      setName('')
      return
    }
    void fetchProjectName(projectId).then((value) => {
      if (!cancelled) setName(value)
    })
    return () => {
      cancelled = true
    }
  }, [projectId])
  return name
}

export function ProjectContextBar({
  projectId,
  chapterLabel,
  stepText,
  saving = null,
  callCount = null,
  onBack,
  actions,
}: ProjectContextBarProps) {
  const projectName = useProjectName(projectId)

  return (
    <header className="studio-ctx" data-testid="project-context-bar">
      {onBack ? (
        <button type="button" className="studio-ctx__back" onClick={onBack} data-testid="studio-back">
          <ArrowLeftOutlined /> 返回项目
        </button>
      ) : null}
      <div className="studio-ctx__crumb">
        {projectName ? (
          <>
            <span className="studio-ctx__proj" title={projectName}>
              {`《${projectName}》`}
            </span>
            <span className="studio-ctx__sep">/</span>
          </>
        ) : null}
        <span className="studio-ctx__chapter" title={chapterLabel}>
          {`章节：${chapterLabel || '未命名'}`}
        </span>
        <span className="studio-ctx__sep">/</span>
        <span className="studio-ctx__step" title={stepText}>
          {`当前步骤：${stepText}`}
        </span>
      </div>

      <div className="studio-ctx__meta">
        {saving === null ? null : (
          <span className={['studio-ctx__saved', saving ? 'is-saving' : ''].join(' ')} data-testid="ctx-save-state">
            {saving ? <ClockCircleOutlined /> : <CheckCircleOutlined />}
            {saving ? '自动保存中…' : '已保存'}
          </span>
        )}
        {typeof callCount === 'number' && callCount >= 0 ? (
          <Tooltip title="本集已经真实提交过的生成次数（费用以账单为准，这里不估金额）">
            <span className="studio-ctx__cost" data-testid="ctx-call-count">
              <InfoCircleOutlined />
              {`本集已提交生成 ${callCount} 次`}
            </span>
          </Tooltip>
        ) : null}
      </div>

      {actions ? <div className="studio-ctx__actions">{actions}</div> : null}
    </header>
  )
}

export default ProjectContextBar
