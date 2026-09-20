import { Space, Tabs, Tag, Tooltip } from 'antd'
import {
  AppstoreOutlined,
  CheckCircleFilled,
  ExportOutlined,
  FileTextOutlined,
  LinkOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons'
import type { ReactNode } from 'react'
import {
  PROJECT_STEPS,
  getProjectStepIndex,
  isStudioProjectStep,
  type ProjectStepKey,
} from '../projectSteps'

const STEP_ICONS: Record<ProjectStepKey, ReactNode> = {
  script: <FileTextOutlined />,
  extract_assets: <AppstoreOutlined />,
  image_prep: <PictureOutlined />,
  video_prompt: <VideoCameraOutlined />,
  binding: <LinkOutlined />,
  generate_deliver: <PlayCircleOutlined />,
}

type ProjectStepNavProps = {
  /** 当前 URL/渲染对应的步骤；旧功能页（仪表盘/文件/剪辑/设置）为 null */
  activeStep: ProjectStepKey | null
  /** 判定出的当前未完成步骤，用于把前面的步骤标记为已完成 */
  resolvedStep: ProjectStepKey
  /** 进度判定中：不标「当前」也不标「已完成」，避免用空快照给出错误结论 */
  loading?: boolean
  onSelectStep: (step: ProjectStepKey) => void
}

/** 旧功能页时用的哨兵 key：不匹配任何步骤，避免 antd Tabs 退化成受控以外的默认高亮。 */
const NO_ACTIVE_STEP = '__workspace_other__'

/**
 * 项目级六步导航：外观沿用原来的 antd `Tabs`，只把 10 个平级 Tab 换成 6 步流程。
 * 第 4-6 步属于「章节工作室」内的步骤，点进去会跳到工作室路由（本轮不重建）。
 */
export function ProjectStepNav({ activeStep, resolvedStep, loading = false, onSelectStep }: ProjectStepNavProps) {
  const resolvedIndex = getProjectStepIndex(resolvedStep)

  return (
    <Tabs
      activeKey={activeStep ?? NO_ACTIVE_STEP}
      onChange={(key) => {
        const target = PROJECT_STEPS.find((step) => step.key === key)
        if (target) onSelectStep(target.key)
      }}
      size="middle"
      className="project-workbench-tabs flex-1 min-w-0"
      items={PROJECT_STEPS.map((step, index) => {
        const done = !loading && index < resolvedIndex
        const inStudio = isStudioProjectStep(step.key)
        return {
          key: step.key,
          label: (
            <Tooltip title={`${step.description}${inStudio ? '（进入章节工作室完成）' : ''}`}>
              <span className="flex items-center gap-1.5">
                {done ? <CheckCircleFilled className="text-emerald-500" /> : STEP_ICONS[step.key]}
                <span>
                  {index + 1}. {step.label}
                </span>
                {inStudio ? <ExportOutlined className="text-[10px] text-gray-400" /> : null}
                {!loading && step.key === resolvedStep ? (
                  <Tag bordered={false} color="blue" className="mr-0 ml-0.5 text-[10px] leading-4">
                    当前
                  </Tag>
                ) : null}
              </span>
            </Tooltip>
          ),
        }
      })}
      tabBarExtraContent={{
        right: (
          <Space size={4} className="hidden lg:flex text-[11px] text-gray-400 pr-1">
            <span>第 1-3 步在工作台完成，第 4-6 步在章节工作室完成</span>
          </Space>
        ),
      }}
    />
  )
}
