import React, { useEffect, useMemo } from 'react'
import { Button, Card, Dropdown, Empty, Segmented, Select, Space, Tag, Tooltip } from 'antd'
import type { MenuProps } from 'antd'
import {
  PlusOutlined,
  EllipsisOutlined,
  ArrowLeftOutlined,
  VideoCameraFilled,
  RightOutlined,
  AppstoreOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons'
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { type TabKey, isTabKey } from './constants'
import { DashboardTab } from './tabs/DashboardTab'
import { ChaptersTab } from './tabs/ChaptersTab'
import { ActorsTab } from './tabs/ActorsTab'
import { RolesTab } from './tabs/RolesTab'
import { ScenesTab } from './tabs/ScenesTab'
import { CostumesTab, PropsTab } from './tabs/PropsTab'
import { FilesTab } from './tabs/FilesTab'
import { EditTab } from './tabs/EditTab'
import { SettingsTab } from './tabs/SettingsTab'
import { getChapterShotsPath, getChapterStudioPath, getProjectEditorPath } from './routes'
import { useProject, useChapters } from './hooks/useProjectData'
import { ensureHasShotsBeforeShooting } from './ensureHasShotsBeforeShooting'
import { getChapterPreparationState } from './chapterPreparation'
import {
  DEFAULT_PROJECT_STEP,
  getProjectStepIndex,
  getProjectStepMeta,
  isProjectStepKey,
  isStudioProjectStep,
  resolveProjectStep,
  type ProjectStepKey,
} from './projectSteps'
import { useProjectStepSignals } from './hooks/useProjectStepSignals'
import { ProjectStepNav } from './components/ProjectStepNav'
import { ProjectStepSummaryStrip } from './components/ProjectStepSummaryStrip'
import { ProjectExtractCandidatesPanel } from './components/ProjectExtractCandidatesPanel'
import { ProjectImagePrepPanel } from './components/ProjectImagePrepPanel'
import { ProjectStudioStepPanel } from './components/ProjectStudioStepPanel'
import { EpisodeVideoPromptBoard } from './components/EpisodeVideoPromptBoard'
import { ProjectDevInfo } from './components/ProjectDevInfo'

const STEP_PARAM = 'step'
const CHAPTER_PARAM = 'chapter'
const TAB_PARAM = 'tab'
const CREATE_PARAM = 'create'
const EDIT_PARAM = 'edit'

/**
 * 旧 `?tab=` 深链 → 六步映射。其它页面（MainLayout / ChapterPrep / ChapterStudio /
 * ChapterShotsPage / ProjectLobby / RoleDetailPage）都在用这些链接，必须继续可用：
 *   `?tab=chapters`（含 create/edit）            → 第 1 步 剧本
 *   `?tab=roles|scenes|props|costumes|actors`    → 第 2 步 提取资产（并选中对应子页签）
 */
const LEGACY_TAB_TO_STEP: Partial<Record<TabKey, ProjectStepKey>> = {
  chapters: 'script',
  roles: 'extract_assets',
  scenes: 'extract_assets',
  props: 'extract_assets',
  costumes: 'extract_assets',
  actors: 'extract_assets',
}

/** 「提取资产」的子页签沿用 `?tab=` 参数，保证 `?tab=roles&create=1` 这类旧链接继续生效。 */
const ASSET_SUB_TABS = ['roles', 'scenes', 'props', 'costumes', 'actors'] as const
type AssetSubTab = (typeof ASSET_SUB_TABS)[number]
const DEFAULT_ASSET_SUB_TAB: AssetSubTab = 'roles'
const ASSET_SUB_TAB_LABELS: Record<AssetSubTab, string> = {
  roles: '角色',
  scenes: '场景',
  props: '道具',
  costumes: '服装',
  actors: '演员',
}

function isAssetSubTab(value: string | null): value is AssetSubTab {
  return value !== null && (ASSET_SUB_TABS as readonly string[]).includes(value)
}

/** 旧功能页（原 10 个 Tab 里不参与六步流程的部分）→ 保留为「其他」下拉入口 */
const LEGACY_PANEL_TABS: { key: TabKey; label: string }[] = [
  { key: 'dashboard', label: '仪表盘' },
  { key: 'files', label: '项目文件' },
  { key: 'edit', label: '剪辑' },
  { key: 'settings', label: '设置' },
]

const ProjectWorkbench: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const stepFromUrl = searchParams.get(STEP_PARAM)
  const explicitStep: ProjectStepKey | null =
    stepFromUrl !== null && isProjectStepKey(stepFromUrl) ? stepFromUrl : null
  const tabFromUrl = searchParams.get(TAB_PARAM)
  const legacyTab: TabKey | null = tabFromUrl !== null && isTabKey(tabFromUrl) ? tabFromUrl : null
  const assetSubTab: AssetSubTab = isAssetSubTab(tabFromUrl) ? tabFromUrl : DEFAULT_ASSET_SUB_TAB
  const mappedStepFromLegacyTab: ProjectStepKey | null = legacyTab
    ? LEGACY_TAB_TO_STEP[legacyTab] ?? null
    : null
  /** 旧功能页（仪表盘/文件/剪辑/设置）：没有对应的六步，单独渲染 */
  const legacyPanelTab: TabKey | null =
    legacyTab && !LEGACY_TAB_TO_STEP[legacyTab] ? legacyTab : null

  /** URL 里显式指定的步骤（六步导航/旧链接映射）优先；否则先用默认步骤占位，等判定结果再替换 URL。 */
  const activeStep: ProjectStepKey | null =
    explicitStep ?? mappedStepFromLegacyTab ?? (legacyPanelTab ? null : DEFAULT_PROJECT_STEP)

  const { project, loading: projectLoading } = useProject(projectId)
  const { chapters } = useChapters(projectId)

  const chaptersByIndex = useMemo(
    () => [...chapters].sort((a, b) => a.index - b.index),
    [chapters],
  )

  const recommendedChapter = useMemo(() => {
    const findByState = (key: ReturnType<typeof getChapterPreparationState>['key']) =>
      chaptersByIndex.find((chapter) => getChapterPreparationState(chapter).key === key)
    return (
      findByState('edit_raw') ??
      findByState('extract_shots') ??
      findByState('prepare_shots') ??
      findByState('shoot') ??
      chaptersByIndex[0] ??
      null
    )
  }, [chaptersByIndex])

  /** 当前集：URL 里的 `?chapter=` 优先，其次沿用原来的「推荐章节」逻辑。 */
  const focusChapter = useMemo(() => {
    const fromUrl = searchParams.get(CHAPTER_PARAM)
    if (fromUrl) {
      const matched = chaptersByIndex.find((chapter) => chapter.id === fromUrl)
      if (matched) return matched
    }
    return recommendedChapter
  }, [chaptersByIndex, recommendedChapter, searchParams])

  const {
    loading: signalsLoading,
    input: stepSignals,
    assets: projectAssets,
    detail: stepDetail,
    reload: reloadSignals,
  } = useProjectStepSignals({
    projectId,
    chapters,
    focusChapterId: focusChapter?.id ?? null,
  })

  const resolution = useMemo(() => resolveProjectStep(stepSignals), [stepSignals])
  const resolvedStepMeta = getProjectStepMeta(resolution.step)

  const chapterLabel = focusChapter ? `第${focusChapter.index}集 · ${focusChapter.title}` : null

  const updateSearchParams = (mutate: (next: URLSearchParams) => void) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        mutate(next)
        return next
      },
      { replace: true },
    )
  }

  /** 切到某个步骤（第 1-3 步就地渲染；第 4-6 步由调用方决定是否跳工作室）。 */
  const openStep = (step: ProjectStepKey, subTab?: AssetSubTab | null) => {
    updateSearchParams((next) => {
      next.set(STEP_PARAM, step)
      if (step === 'extract_assets') {
        next.set(TAB_PARAM, subTab ?? assetSubTab)
      } else {
        next.delete(TAB_PARAM)
      }
      if (step !== 'script') {
        next.delete(CREATE_PARAM)
        next.delete(EDIT_PARAM)
      }
    })
  }

  /** 兼容入口：原来的 `setTabInUrl` / `onSelectTab` 语义（旧 Tab → 六步或旧功能页）。 */
  const setTabInUrl = (tab: TabKey) => {
    const mappedStep = LEGACY_TAB_TO_STEP[tab]
    updateSearchParams((next) => {
      if (mappedStep) {
        next.set(STEP_PARAM, mappedStep)
      } else {
        next.delete(STEP_PARAM)
      }
      next.set(TAB_PARAM, tab)
    })
  }

  const setAssetSubTab = (subTab: AssetSubTab) => {
    updateSearchParams((next) => {
      next.set(STEP_PARAM, 'extract_assets')
      next.set(TAB_PARAM, subTab)
    })
  }

  const setChapterInUrl = (chapterId: string) => {
    updateSearchParams((next) => {
      next.set(CHAPTER_PARAM, chapterId)
    })
  }

  /** 进入章节工作室（第 4-6 步）：带上 `?studio=<step>` 与当前集，供下一轮拆分工作室使用。 */
  const openChapterStudio = (step: ProjectStepKey) => {
    if (!projectId || !focusChapter) return
    const studioPath = getChapterStudioPath(projectId, focusChapter.id)
    navigate(`${studioPath}?studio=${step}&${CHAPTER_PARAM}=${encodeURIComponent(focusChapter.id)}`)
  }

  const handleSelectStep = (step: ProjectStepKey) => {
    if (!focusChapter) {
      // 没有可用集时：把步骤写进 URL，由第 4-6 步入口面板给出「先选/建一集」的空状态。
      openStep(step, null)
      return
    }
    if (step === 'video_prompt') {
      // 第 4 步是**集级视频提示词页面**（在工作台内就地渲染 `EpisodeVideoPromptBoard`）：
      // 批量生成 / 批量导入 / 统一确认保存都在这里，右上角「进入分镜工作台」再去逐镜检查。
      // 之前这里直接跳章节工作室，等于把集级主入口整个跳过，页面上的批量导入点不到。
      openStep(step)
      return
    }
    if (isStudioProjectStep(step)) {
      openChapterStudio(step)
      return
    }
    openStep(step)
  }

  // 未显式指定步骤时，按项目当前状态判定「第一个未完成步骤」并替换 URL（replace，避免返回时反复弹跳）。
  useEffect(() => {
    if (!projectId) return
    if (explicitStep || mappedStepFromLegacyTab || legacyPanelTab) return
    if (signalsLoading) return
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set(STEP_PARAM, resolution.step)
        return next
      },
      { replace: true },
    )
  }, [projectId, explicitStep, mappedStepFromLegacyTab, legacyPanelTab, signalsLoading, resolution.step, setSearchParams])

  const primaryCta = (() => {
    if (!projectId) {
      return {
        label: '创建第一章',
        hint: '先创建章节，再进入分镜准备流程',
        icon: <PlusOutlined />,
        onClick: () => {},
      }
    }
    if (!recommendedChapter) {
      return {
        label: '创建第一章',
        hint: '先创建章节，再进入分镜准备流程',
        icon: <PlusOutlined />,
        onClick: () => {
          setTabInUrl('chapters')
          updateSearchParams((next) => {
            next.set(CREATE_PARAM, '1')
          })
        },
      }
    }
    const state = getChapterPreparationState(recommendedChapter)
    const chapterLabel = `第${recommendedChapter.index}章`
    if (state.key === 'edit_raw') {
      return {
        label: `编辑${chapterLabel}原文`,
        hint: `${chapterLabel}还没有原文内容，建议先补章节原文`,
        icon: state.primaryIcon,
        onClick: () => {
          setTabInUrl('chapters')
          updateSearchParams((next) => {
            next.set(TAB_PARAM, 'chapters')
            next.set(EDIT_PARAM, recommendedChapter.id)
          })
        },
      }
    }
    if (state.key === 'extract_shots') {
      return {
        label: `提取${chapterLabel}分镜`,
        hint: `${chapterLabel}已有原文，下一步更适合先提取分镜`,
        icon: state.primaryIcon,
        onClick: () => navigate(getChapterShotsPath(projectId, recommendedChapter.id)),
      }
    }
    if (state.key === 'prepare_shots') {
      return {
        label: `进入${chapterLabel}分镜工作室`,
        hint: `${chapterLabel}已有分镜，建议继续补齐镜头准备`,
        icon: state.primaryIcon,
        onClick: () => navigate(getChapterStudioPath(projectId, recommendedChapter.id)),
      }
    }
    return {
      label: `进入${chapterLabel}拍摄`,
      hint: `${chapterLabel}已具备分镜，可继续进入拍摄流程`,
      icon: state.primaryIcon,
      onClick: () =>
        ensureHasShotsBeforeShooting({
          projectId,
          chapterId: recommendedChapter.id,
          storyboardCount: recommendedChapter.storyboardCount,
          navigate,
        }),
    }
  })()

  /** T3「继续」：去判定出的当前未完成步骤；若已经在该步骤，则执行该步骤的具体下一步动作。 */
  const handleContinue = () => {
    const target = resolution.step
    // 第 4 步的集级入口留在工作台内（与顶部步骤条一致），不直接跳工作室。
    if (isStudioProjectStep(target) && focusChapter && target !== 'video_prompt') {
      openChapterStudio(target)
      return
    }
    if (activeStep !== target) {
      openStep(target)
      return
    }
    // 已在目标步骤（落地步）：沿用原有的「推荐动作」，避免出现点了没反应的按钮。
    primaryCta.onClick()
  }

  const moreMenuItems: MenuProps['items'] = [
    { key: 'newActor', label: '关联演员', onClick: () => setTabInUrl('actors') },
    { key: 'newRole', label: '新建角色', onClick: () => setTabInUrl('roles') },
    { key: 'upload', label: '上传素材', onClick: () => navigate('/assets') },
    { key: 'newScene', label: '新建场景', onClick: () => setTabInUrl('scenes') },
    { key: 'newProp', label: '新建道具', onClick: () => setTabInUrl('props') },
    { key: 'newCostume', label: '新建服装', onClick: () => setTabInUrl('costumes') },
  ]

  /** 原 10 个 Tab 里未进入六步流程的入口，保留在这里，保证功能不丢。 */
  const workspaceMenuItems: MenuProps['items'] = [
    ...LEGACY_PANEL_TABS.map((item) => ({
      key: item.key,
      label: item.label,
      onClick: () => setTabInUrl(item.key),
    })),
    { type: 'divider' as const },
    { key: 'chapterList', label: '章节列表（第 1 步）', onClick: () => setTabInUrl('chapters') },
    { key: 'assetsPath', label: '资产管理', onClick: () => navigate('/assets') },
    { key: 'filesPath', label: '文件管理', onClick: () => navigate('/files') },
  ]

  if (!project && !projectLoading) {
    return (
      <Card>
        <Empty description="项目不存在" />
        <Link to="/projects">
          <Button type="link" icon={<ArrowLeftOutlined />}>
            返回项目列表
          </Button>
        </Link>
      </Card>
    )
  }

  const renderStepContent = () => {
    if (!activeStep) return null
    if (activeStep === 'script') return <ChaptersTab />
    if (activeStep === 'extract_assets') {
      return (
        <div className="h-full min-h-0 flex flex-col">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-gray-500">
              第 2 步：从剧本中提取角色、场景、道具。资产在本步建立，参考图片在第 3 步「图片准备」里补齐。
            </span>
            <Segmented
              size="small"
              value={assetSubTab}
              onChange={(value) => {
                const nextSubTab = String(value)
                if (isAssetSubTab(nextSubTab)) setAssetSubTab(nextSubTab)
              }}
              options={ASSET_SUB_TABS.map((key) => ({
                label: ASSET_SUB_TAB_LABELS[key],
                value: key,
              }))}
            />
          </div>
          {/* 第 2 步的产物概览（只读）：真实提取后的候选有多少、哪些能挂已有资产 */}
          <ProjectExtractCandidatesPanel chapterId={focusChapter?.id ?? null} chapterLabel={chapterLabel} />
          {/* 只挂载当前子页签，保持与原来 Tab 切换一致的加载行为 */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {assetSubTab === 'roles' && <RolesTab />}
            {assetSubTab === 'scenes' && <ScenesTab />}
            {assetSubTab === 'props' && <PropsTab />}
            {assetSubTab === 'costumes' && <CostumesTab />}
            {assetSubTab === 'actors' && <ActorsTab />}
          </div>
        </div>
      )
    }
    if (activeStep === 'image_prep') {
      return (
        <ProjectImagePrepPanel
          assets={projectAssets}
          detail={stepDetail}
          loading={signalsLoading}
          onReload={reloadSignals}
        />
      )
    }
    if (activeStep === 'video_prompt') {
      // 第 4 步的**主入口**：集级批量生成/导入 + 统一确认保存（进入分镜工作台之前的必经页面）。
      return (
        <EpisodeVideoPromptBoard
          projectId={projectId ?? ''}
          chapterId={focusChapter?.id ?? null}
          chapterLabel={chapterLabel ?? '未选择章节'}
          onEnterStudio={() => openChapterStudio('video_prompt')}
        />
      )
    }
    return (
      <ProjectStudioStepPanel
        step={activeStep}
        chapterLabel={chapterLabel}
        hasChapter={Boolean(focusChapter)}
        projectId={projectId}
        chapterId={focusChapter?.id ?? null}
        onEnterStudio={(step) => openChapterStudio(step)}
        onGoStep={openStep}
      />
    )
  }

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div
        className="sticky top-0 z-20 bg-white border-b border-gray-200 shadow-sm"
        style={{ margin: -5, marginBottom: 0, padding: '12px 24px 0' }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <span className="text-xs text-gray-500">当前项目</span>
            <Link to="/projects" className="font-medium truncate max-w-[220px]" title={project?.name}>
              {project?.name ?? '加载中…'}
            </Link>
            <span className="text-xs text-gray-500 ml-1">当前集</span>
            {chaptersByIndex.length > 0 ? (
              <Select
                size="small"
                className="min-w-[200px]"
                value={focusChapter?.id}
                onChange={(value: string) => setChapterInUrl(value)}
                options={chaptersByIndex.map((chapter) => ({
                  value: chapter.id,
                  label: `第${chapter.index}集 · ${chapter.title}`,
                }))}
              />
            ) : (
              <Tag bordered={false} className="text-[11px]">
                还没有章节
              </Tag>
            )}
          </div>

          <Space size="small" wrap className="shrink-0">
            <Tooltip title={resolution.reason}>
              <Button icon={<RightOutlined />} onClick={handleContinue}>
                继续：{resolution.nextActionLabel}
              </Button>
            </Tooltip>
            <Button type="primary" icon={primaryCta.icon} onClick={primaryCta.onClick}>
              {primaryCta.label}
            </Button>
            <Button
              icon={<VideoCameraFilled />}
              onClick={() => projectId && navigate(getProjectEditorPath(projectId))}
            >
              进入后期剪辑
            </Button>
            <Dropdown menu={{ items: moreMenuItems }} placement="bottomRight">
              <Button icon={<EllipsisOutlined />}>更多</Button>
            </Dropdown>
            <Dropdown menu={{ items: workspaceMenuItems }} placement="bottomRight">
              <Button icon={<AppstoreOutlined />}>其他</Button>
            </Dropdown>
          </Space>
        </div>

        <ProjectStepNav
          activeStep={activeStep}
          resolvedStep={resolution.step}
          onSelectStep={handleSelectStep}
        />

        <div className="mt-0 mb-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
          <span>{primaryCta.hint}</span>
          <span className="flex items-center gap-1">
            <InfoCircleOutlined />
            当前流程位置：第 {getProjectStepIndex(resolution.step) + 1} 步 · {resolvedStepMeta.label}
          </span>
        </div>
      </div>

      <div
        className="pt-3 animate-fadeIn flex-1 min-h-0 overflow-hidden"
        style={{ animation: 'fadeIn 0.25s ease-out' }}
      >
        {legacyPanelTab ? (
          <div className="h-full min-h-0 overflow-hidden flex flex-col">
            <Card size="small" className="mb-3" styles={{ body: { padding: '8px 12px' } }}>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-600">
                <span>
                  你正在查看工作台的其他功能页（{LEGACY_PANEL_TABS.find((item) => item.key === legacyPanelTab)?.label}），
                  它不属于六步主流程。
                </span>
                <Space size="small">
                  <Button size="small" icon={<ArrowLeftOutlined />} onClick={() => openStep(resolution.step)}>
                    回到第 {getProjectStepIndex(resolution.step) + 1} 步：{resolvedStepMeta.label}
                  </Button>
                </Space>
              </div>
            </Card>
            <div className="flex-1 min-h-0 overflow-hidden">
              {legacyPanelTab === 'dashboard' && <DashboardTab onSelectTab={setTabInUrl} />}
              {legacyPanelTab === 'files' && <FilesTab />}
              {legacyPanelTab === 'edit' && <EditTab />}
              {legacyPanelTab === 'settings' && <SettingsTab />}
            </div>
          </div>
        ) : (
          <div className="h-full min-h-0 overflow-hidden flex flex-col">
            {activeStep ? (
              <ProjectStepSummaryStrip
                step={activeStep}
                resolution={resolution}
                chapterLabel={chapterLabel}
                onGoStep={openStep}
                onContinue={handleContinue}
                devInfo={
                  <ProjectDevInfo
                    detail={stepDetail}
                    model={stepSignals}
                    resolution={resolution}
                    onReload={reloadSignals}
                  />
                }
              />
            ) : null}
            {/* 资产类子页签自带 h-full + overflow-auto；剧本/图片准备/工作室入口用外层滚动兜底 */}
            <div className="flex-1 min-h-0 overflow-auto">{renderStepContent()}</div>
          </div>
        )}
      </div>
    </div>
  )
}

export default ProjectWorkbench
