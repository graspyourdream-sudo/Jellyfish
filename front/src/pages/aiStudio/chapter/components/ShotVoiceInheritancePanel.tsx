/**
 * 第 4 步「资产与声音检查」· 角色声音（**只读**）。
 *
 * 设计包 §10 的硬约束：
 *   - 已绑定 → 显示继承结果与来源（「音色名 · 继承自人物资产」）；
 *   - 未绑定 → 标为声音缺项，并给「返回人物资产补充」；
 *   - **不在第 4 步提供第二套选择 / 更换入口**，也不回写。
 *
 * 所以本组件只有两件事：读一次只读结论（免费、不写库）、把结论与来源显示出来。
 * 这里**没有**任何写入调用，界面上也没有"绑定 / 解绑 / 换一个"的按钮 —— 要改声音请去
 * 第 2 步人物资产详情（全站唯一的绑定入口）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Space, Tag, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { Link } from 'react-router-dom'

import { OpenAPI, StudioAssetVoicesService } from '../../../../services/generated'
import { toUserFacingText } from '../../components/userFacingMessage'
import { TechnicalDetailSection } from '../../project/ProjectWorkbench/components/workbench/TechnicalDetailCollapse'
import {
  SHOT_VOICE_COMPLETE_ACTION,
  SHOT_VOICE_PREVIEW_LABEL,
  SHOT_VOICE_READONLY_NOTE,
  SHOT_VOICE_SECTION_TITLE,
  assetCompletionPath,
  describeShotVoiceInheritance,
  type ShotVoiceCheckView,
} from './shotVoiceInheritance'

export type ShotVoiceInheritancePanelProps = {
  shotId: string
  projectId?: string | null
  chapterId?: string | null
}

/** 播放器只在有地址时出现（相对地址补成可播放地址）。 */
function toPlayableUrl(url: string, base: string): string {
  const raw = String(url ?? '').trim()
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  const prefix = String(base ?? '').replace(/\/+$/, '')
  return `${prefix}${raw.startsWith('/') ? '' : '/'}${raw}`
}

export function ShotVoiceInheritancePanel(props: ShotVoiceInheritancePanelProps) {
  const { shotId, projectId, chapterId } = props
  const [view, setView] = useState<ShotVoiceCheckView | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  /** 读一次本镜的角色声音结论（只读、免费、不写库）。 */
  const load = useCallback(async () => {
    if (!shotId) return
    setLoading(true)
    try {
      const res = await StudioAssetVoicesService.getShotVoiceInheritanceApiV1StudioAssetVoicesShotsShotIdInheritanceGet({
        shotId,
      })
      setView(describeShotVoiceInheritance(res.data))
      setError('')
    } catch (e) {
      setError(toUserFacingText(e, '角色声音检查失败'))
    } finally {
      setLoading(false)
    }
  }, [shotId])

  useEffect(() => {
    void load()
  }, [load])

  const completionPath = useMemo(
    () => assetCompletionPath(projectId ?? '', chapterId ?? ''),
    [chapterId, projectId],
  )

  return (
    <div className="space-y-2" data-testid="shot-voice-inheritance-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-slate-900">{SHOT_VOICE_SECTION_TITLE}</div>
          <Typography.Text type="secondary" className="text-[11px]">
            {SHOT_VOICE_READONLY_NOTE}
          </Typography.Text>
        </div>
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
          刷新
        </Button>
      </div>

      {error ? <Alert type="error" showIcon message="角色声音检查失败" description={error} /> : null}

      {view ? (
        <Alert
          type={view.missing ? 'warning' : view.needsAssetCompletion ? 'info' : 'success'}
          showIcon
          message={view.headline}
          description={
            <div className="space-y-2">
              <div className="text-xs text-slate-600">{view.detail}</div>
              {view.multiVoicedNames.length > 0 ? (
                <Space size={8} wrap>
                  {view.multiVoicedNames.map((name) => (
                    <Tag key={name} bordered={false}>
                      {name}
                    </Tag>
                  ))}
                </Space>
              ) : null}
              {view.audioUrl ? (
                <div>
                  <div className="mb-1 text-[11px] text-slate-500">{SHOT_VOICE_PREVIEW_LABEL}</div>
                  <audio
                    controls
                    preload="none"
                    className="h-8 w-full max-w-sm"
                    src={toPlayableUrl(view.audioUrl, OpenAPI.BASE)}
                  />
                </div>
              ) : null}
              {view.needsAssetCompletion && completionPath ? (
                <Link to={completionPath}>
                  <Button size="small" type="primary">
                    {SHOT_VOICE_COMPLETE_ACTION}
                  </Button>
                </Link>
              ) : null}
            </div>
          }
        />
      ) : null}

      {/* 技术详情（默认收起）：内部编号只在这里出现。 */}
      {view && (view.refs.voiceRef || view.refs.sourceRef || view.refs.snapshotRef) ? (
        <TechnicalDetailSection testId="shot-voice-technical-detail" hint="这一段结论读的是哪几条记录">
          <div className="space-y-0.5 break-all text-[11px]">
            {view.refs.voiceRef ? <div>{`生效的声音文件编号：${view.refs.voiceRef}`}</div> : null}
            {view.refs.sourceRef ? <div>{`来源人物资产编号：${view.refs.sourceRef}`}</div> : null}
            {view.refs.snapshotRef ? <div>{`历史声音文件编号：${view.refs.snapshotRef}`}</div> : null}
          </div>
        </TechnicalDetailSection>
      ) : null}
    </div>
  )
}

export default ShotVoiceInheritancePanel
