import React, { useEffect, useMemo } from 'react'
import { Layout, Menu, theme, Dropdown, Space, Avatar, Select, Breadcrumb } from 'antd'
import {
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
  UserOutlined,
  FolderOutlined,
  PictureOutlined,
  FileTextOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAppStore, userRoleLabel } from '../store/useAppStore'
import { useTranslation } from 'react-i18next'
import { TaskCenter } from '../pages/aiStudio/components/TaskCenter'
import { TaskRuntimeProvider } from '../pages/aiStudio/components/TaskRuntimeProvider'
import { RealRunModeBadge } from '../pages/aiStudio/components/RealRunModeBadge'

const { Header, Sider, Content } = Layout

/**
 * 左侧导航的**最终信息架构**（五级，顺序即产品口径）。
 *
 * 原来 8 个平级入口收敛为下面 5 个：`模型管理` / `系统设置` / `LLM 调试台（开发）`
 * 合并成「设置」（页内三个区域），`提示词模板` / `提示词导入/交付` 合并成
 * 「提示词管理」（页内两个页签），`项目列表` 拆成按项目类型区分的
 * 「短剧项目」与「广告视频」。
 *
 * ⚠️ **旧裁定已被本轮推翻**：仓库里曾有多处注释 / 测试钉死「`LLM 调试台（开发）`
 * 导航名不改」（审计 §9.1 第 9 项）。本轮最终口径是它**不再是一级入口**，
 * 旧路由 `/llm-pipeline` 仍然兼容（带权限门）。相关注释与守卫测试已同批更新。
 */
const NAV_ITEMS: readonly { key: string; to: string; label: string; Icon: React.ComponentType }[] = [
  { key: 'projects', to: '/projects', label: '短剧项目', Icon: FolderOutlined },
  { key: 'ad-videos', to: '/ad-videos', label: '广告视频', Icon: VideoCameraOutlined },
  { key: 'assets', to: '/assets', label: '资产管理', Icon: PictureOutlined },
  { key: 'prompts', to: '/prompts', label: '提示词管理', Icon: FileTextOutlined },
  { key: 'settings', to: '/settings', label: '设置', Icon: SettingOutlined },
]

/**
 * 路径 → 高亮项。
 *
 * 「提示词管理」与「设置」各有**多条**旧路由要落到同一个高亮项上：
 * 左侧始终只高亮一个入口，不许出现「提示词模板」和「提示词导入/交付」同时亮着
 * 这种两个一级模块并列的旧观感。
 */
function resolveSelectedKey(pathname: string): string[] {
  if (pathname === '/projects' || pathname.startsWith('/projects/')) return ['projects']
  if (pathname.startsWith('/ad-videos')) return ['ad-videos']
  if (pathname.startsWith('/assets')) return ['assets']
  if (pathname.startsWith('/prompts') || pathname.startsWith('/prompt-flow')) return ['prompts']
  if (
    pathname.startsWith('/settings') ||
    pathname.startsWith('/models') ||
    pathname.startsWith('/llm-pipeline')
  ) {
    return ['settings']
  }
  return []
}

/**
 * 面包屑里每个路径段的中文名。
 *
 * ⚠️ 这里的键**同时**覆盖规范路由与全部兼容旧路由：旧地址被打开时面包屑也必须显示
 * 新的一级模块名，否则会出现「左侧写设置、面包屑写模型管理」这种两个体系并存的状态。
 */
const PATH_LABELS: Readonly<Record<string, string>> = {
  projects: '短剧项目',
  'ad-videos': '广告视频',
  assets: '资产管理',
  prompts: '提示词管理',
  /* 旧 `/prompt-flow` 兼容：它属于「提示词管理 · 导入与交付」，不是第二个一级模块 */
  'prompt-flow': '提示词管理',
  files: '文件管理',
  agents: '智能体管理',
  /* 旧 `/models` 兼容：它属于「设置 · 模型与服务」 */
  models: '设置',
  /* 旧 `/llm-pipeline` 兼容：它属于「设置 · 开发调试」 */
  'llm-pipeline': '设置',
  'drama-plan': '剧情策划',
  settings: '设置',
  chapters: '章节管理',
  studio: '分镜工作室',
  prep: '章节编辑',
  shots: '分镜',
  editor: '视频剪辑',
  edit: '编辑',
  /* 资产子路径（审计 §4.6-R20 运行时实测：`/assets/scenes/{id}/edit` 的面包屑里
     出现了英文段 `scenes` 与 percent-encoded 的内部 ID）。 */
  actors: '演员',
  scenes: '场景',
  props: '道具',
  costumes: '服装',
  products: '商品',
  roles: '角色',
  images: '图片',
  videos: '视频',
  audios: '声音',
}

const MainLayout: React.FC = () => {
  /* 角色的中文显示名在 `settings` 命名空间里（`roleOptions`），
     所以这里显式把两个命名空间都挂上，用 `settings:` 前缀取键 —— 避免把
     「系统管理员」这份中文口径在代码里再手写一份（审计 §4.7 模式 3）。 */
  const { t, i18n } = useTranslation(['layout', 'settings'])
  const location = useLocation()
  const navigate = useNavigate()
  const { token } = theme.useToken()

  const collapsed = useAppStore((state) => state.siderCollapsed)
  const toggleCollapsed = useAppStore((state) => state.toggleSider)
  const user = useAppStore((state) => state.user)
  const language = useAppStore((state) => state.language)
  const setLanguage = useAppStore((state) => state.setLanguage)

  const selectedKeys = useMemo(() => resolveSelectedKey(location.pathname), [location.pathname])

  /* 浏览器标签（`document.title`）的用户可见品牌名：**跟随当前语言**，取值只有一个来源
     —— `layout` 命名空间的 `title`（中文「像素小新」/ 英文「Pixel Xiaoxin」）。
     `index.html` 里那份静态 `<title>像素小新</title>` 只是首屏渲染前的兜底。
     品牌口径与「为什么内部仍叫 Jellyfish」见 `docs/architecture/product-branding.md`。 */
  useEffect(() => {
    document.title = t('title')
  }, [t, language])

  const breadcrumbItems = useMemo(() => {
    const path = location.pathname.replace(/^\/+/, '').split('/').filter(Boolean)
    if (path.length === 0) return [{ title: t('title') }]
    const items: { title: React.ReactNode; key: string }[] = []
    path.forEach((segment, i) => {
      // 特殊：/projects/:projectId/chapters/:chapterId/* 中的 chapterId 段不展示（避免出现“章节”这一层）
      if (path[0] === 'projects' && path[2] === 'chapters' && i === 3) {
        return
      }

      // 默认：按原始路径逐段拼接
      let href = path.slice(0, i + 1).join('/')
      href = `/${href}`

      // 特殊：章节相关的中间路径段在路由里不存在，需映射到有效地址
      // /projects/:projectId/chapters/:chapterId/*
      if (path[0] === 'projects' && path[2] === 'chapters') {
        const projectId = path[1]
        const chapterId = path[3]
        if (segment === 'chapters' && i === 2) {
          // “章节管理”实际在项目工作台页
          href = `/projects/${projectId}?tab=chapters`
        } else if (i === 3) {
          // 章节 ID 段没有对应独立页面，跳到分镜页（存在路由）
          href = `/projects/${projectId}/chapters/${chapterId}/shots`
        }
      }

      const isLast = i === path.length - 1
      let label = PATH_LABELS[segment]
      if (label === undefined) {
        if (path[0] === 'projects' && i === 1) label = '项目工作台'
        else if (path[2] === 'chapters' && i === 3) label = '章节'
        /* 兜底**禁止回落 URL 段原样**（审计 §4.6-R20 / §7.2 序 4 点名）：
           `/assets/scenes/{id}/edit` 的 `{id}` 段是 percent-encoded 的内部 ID，
           未登记的英文段（`actors` / `roles` …）也会原样上屏 —— 两者都是 §2.3 模式 1/2。
           未登记段一律说「详情」；已登记的路由段在 `PATH_LABELS` 里补中文名。 */
        else label = '详情'
      }
      items.push({
        key: href,
        title: isLast ? label : <Link to={href}>{label}</Link>,
      })
    })
    return items
  }, [location.pathname, t])

  const menuItems = NAV_ITEMS.map(({ key, to, label, Icon }) => ({
    key,
    icon: <Icon />,
    label: <Link to={to}>{label}</Link>,
  }))

  const userMenuItems = [
    {
      key: 'profile',
      label: t('user.profile'),
      onClick: () => navigate('/settings'),
    },
    {
      type: 'divider' as const,
    },
    {
      key: 'logout',
      label: t('user.logout'),
      onClick: () => {
        // 这里保留占位，实际项目中可接入登录逻辑
      },
    },
  ]

  return (
    <Layout
      style={{
        height: '100vh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'row',
      }}
    >
      <Sider
        trigger={null}
        collapsible
        collapsed={collapsed}
        width={220}
        style={{
          flexShrink: 0,
          background: token.colorBgContainer,
          borderRight: `1px solid ${token.colorBorderSecondary}`,
          overflow: 'auto',
        }}
      >
        <div className="flex items-center h-16 px-4 border-b border-solid" style={{ borderColor: token.colorBorderSecondary }}>
          <Link to="/projects" className="flex items-center gap-2 min-w-0">
            {/* 图标本轮沿用现有 `logo.svg`（不重做图形）；替代文本取**当前语言的品牌名**
                （`layout.title`：中文「像素小新」/ 英文「Pixel Xiaoxin」），不再写死旧代号。 */}
            <img src="/logo.svg" alt={t('title')} className="w-8 h-8 shrink-0" />
            {!collapsed && (
              <div className="min-w-0">
                <div className="text-base font-semibold text-gray-900 truncate">
                  {t('title')}
                </div>
                <div className="text-xs text-gray-500 truncate">
                  {t('subtitle')}
                </div>
              </div>
            )}
          </Link>
        </div>

        <Menu
          mode="inline"
          selectedKeys={selectedKeys}
          items={menuItems}
          style={{ borderRight: 'none', paddingTop: 8 }}
        />
      </Sider>

      <Layout
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <Header
          className="flex items-center justify-between px-4"
          style={{
            flexShrink: 0,
            background: token.colorBgContainer,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <Space size="middle" className="flex-1 min-w-0">
            <span
              className="cursor-pointer text-xl shrink-0"
              onClick={toggleCollapsed}
            >
              {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            </span>
            <Breadcrumb
              items={breadcrumbItems}
              className="hidden sm:block"
              style={{ lineHeight: '32px' }}
            />
          </Space>

          <Space size="middle">
            {/* 当前是「演练模式」还是「真实模式」：点开有各出口放行状态与中文开启步骤。
                演练模式下被守卫拦住的记录也会在这里显示原因与开启办法。 */}
            <RealRunModeBadge />
            <Select
              size="small"
              value={language}
              style={{ width: 120 }}
              onChange={(value) => {
                setLanguage(value)
                void i18n.changeLanguage(value)
                window.localStorage.setItem('jellyfish_language', value)
                document.documentElement.lang = value === 'en-US' ? 'en' : 'zh-CN'
              }}
              options={[
                { label: t('lang.zh'), value: 'zh-CN' },
                { label: t('lang.en'), value: 'en-US' },
              ]}
            />

            <Dropdown
              menu={{
                items: userMenuItems,
              }}
              placement="bottomRight"
            >
              <div className="flex items-center gap-2 cursor-pointer">
                <Avatar size={32} icon={<UserOutlined />} />
                <div className="hidden md:flex flex-col leading-tight">
                  <span className="text-sm font-medium text-gray-800">{user.name}</span>
                  {/* 角色存的是稳定码（`admin` / `operator` / `guest`），显示走 i18n；
                      未登记的码给「未知角色」兜底，**绝不把码本身渲到右上角**（审计 §4.7-R24 第 3 条）。 */}
                  <span className="text-xs text-gray-500">{userRoleLabel(user.role, t)}</span>
                </div>
              </div>
            </Dropdown>
          </Space>
        </Header>

        <TaskRuntimeProvider>
          <Content
            style={{
              margin: 0,
              padding: 5,
              background: token.colorBgLayout,
              flex: 1,
              minHeight: 0,
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div className="w-full h-full min-h-0 overflow-hidden flex flex-col">
              <Outlet />
            </div>
          </Content>
          <TaskCenter />
        </TaskRuntimeProvider>
      </Layout>
    </Layout>
  )
}

export default MainLayout
