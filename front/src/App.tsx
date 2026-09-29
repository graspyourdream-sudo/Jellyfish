import type React from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import MainLayout from './layouts/MainLayout'
import SettingsCenter from './pages/settings/SettingsCenter'
import NotFound from './pages/NotFound'
import ProjectLobby from './pages/aiStudio/project/ProjectLobby'
import ProjectWorkbench from './pages/aiStudio/project/ProjectWorkbench'
import RoleDetailPage from './pages/aiStudio/project/ProjectWorkbench/RoleDetailPage'
import ChapterStudio from './pages/aiStudio/chapter/ChapterStudio'
import AssetManager from './pages/aiStudio/assets/AssetManager'
import ActorAssetEditPage from './pages/aiStudio/assets/ActorAssetEditPage.tsx'
import SceneAssetEditPage from './pages/aiStudio/assets/SceneAssetEditPage.tsx'
import PropAssetEditPage from './pages/aiStudio/assets/PropAssetEditPage.tsx'
import CostumeAssetEditPage from './pages/aiStudio/assets/CostumeAssetEditPage.tsx'
import ProductAssetEditPage from './pages/aiStudio/assets/ProductAssetEditPage.tsx'
import PromptCenter from './pages/aiStudio/prompts/PromptCenter'
import FileManager from './pages/aiStudio/files/FileManager'
import VideoEditor from './pages/aiStudio/editor/VideoEditor'
import AgentManagement from './pages/aiStudio/agents/AgentManagement'
import AgentEdit from './pages/aiStudio/agents/AgentEdit.tsx'
import { ChapterShotsPage } from './pages/aiStudio/shots/ChapterShotsPage'
import { ChapterShotEditPage } from './pages/aiStudio/shots/ChapterShotEditPage'
import DramaPlanPage from './pages/aiStudio/dramaPlan/DramaPlanPage'
import { PromptDeliveryTabRoute } from './pages/aiStudio/prompts/PromptCenter'
import { DebugTabRoute } from './pages/settings/SettingsCenter'
import './App.css'

/**
 * 路由表（左侧 5 个普通入口各对应一条规范路由）。
 *
 * ## 五个一级入口与它们的路由
 *
 * | 左侧入口 | 规范路由 | 说明 |
 * |---|---|---|
 * | 短剧项目 | `/projects` | `kind=drama` 的普通短剧项目列表（默认落点） |
 * | 广告视频 | `/ad-videos` | `kind=ad` 的剧情广告项目列表 |
 * | 资产管理 | `/assets` | 人物 / 场景 / 道具 / 服装 / 商品 |
 * | 提示词管理 | `/prompts` | 页签：模板管理 / 导入与交付 |
 * | 设置 | `/settings` | 页签：模型与服务 / 系统设置 /（按权限）开发调试 |
 *
 * ## 旧路由一律兼容（不许 404）
 *
 * - `/prompt-flow` → `/prompts?tab=delivery`（旧收藏链接仍然可用）；
 * - `/models` → `/settings?tab=models`；
 * - `/llm-pipeline` → `/settings?tab=debug`，但**调试页签本身有权限门**：
 *   没有权限时该路由安全跳到设置的默认页签，不渲染任何调试内容。
 *
 * 项目 / 章节 / 工作室的深链（`/projects/:projectId/...`）与刷新恢复语义本轮**不变**。
 */
const App: React.FC = () => {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<MainLayout />}>
          <Route index element={<Navigate to="/projects" replace />} />
          {/* 短剧项目：只显示 kind=drama 的普通短剧 */}
          <Route path="projects" element={<ProjectLobby scope="drama" />} />
          {/* 广告视频：只显示 kind=ad 的剧情广告项目 */}
          <Route path="ad-videos" element={<ProjectLobby scope="ad" />} />
          <Route path="projects/:projectId" element={<ProjectWorkbench />} />
          <Route path="projects/:projectId/roles/:characterId/edit" element={<RoleDetailPage />} />
          <Route path="projects/:projectId/chapters/:chapterId/prep/*" element={<Navigate to="../shots" replace />} />
          <Route path="projects/:projectId/chapters/:chapterId/studio" element={<ChapterStudio />} />
          <Route path="projects/:projectId/chapters/:chapterId/shots/:shotId/edit" element={<ChapterShotEditPage />} />
          <Route path="projects/:projectId/chapters/:chapterId/shots" element={<ChapterShotsPage />} />
          <Route path="projects/:projectId/chapters/:chapterId/prep-drafts" element={<Navigate to="../shots" replace />} />
          <Route path="projects/:projectId/editor" element={<VideoEditor />} />
          <Route path="assets" element={<AssetManager />} />
          <Route path="assets/actors/:actorImageId/edit" element={<ActorAssetEditPage />} />
          <Route path="assets/scenes/:sceneId/edit" element={<SceneAssetEditPage />} />
          <Route path="assets/props/:propId/edit" element={<PropAssetEditPage />} />
          <Route path="assets/costumes/:costumeId/edit" element={<CostumeAssetEditPage />} />
          <Route path="assets/products/:productId/edit" element={<ProductAssetEditPage />} />
          {/* 提示词管理：模板管理（默认页签） + 导入与交付（两个页签，一套导航一个高亮） */}
          <Route path="prompts" element={<PromptCenter />} />
          <Route path="prompt-flow" element={<PromptDeliveryTabRoute />} />
          <Route path="files" element={<FileManager />} />
          <Route path="agents/:id/edit" element={<AgentEdit />} />
          <Route path="agents" element={<AgentManagement />} />
          {/* 设置中心：模型与服务（默认页签） + 系统设置 + 按权限的开发调试 */}
          <Route path="settings" element={<SettingsCenter />} />
          <Route path="models" element={<Navigate to="/settings?tab=models" replace />} />
          <Route path="llm-pipeline" element={<DebugTabRoute />} />
          <Route path="drama-plan" element={<DramaPlanPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
