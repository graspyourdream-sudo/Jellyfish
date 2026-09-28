/**
 * 第 2 步「人物资产详情 · 角色声音」区块：**全站唯一的角色声音绑定入口**（设计包 §10）。
 *
 * 它为什么只在这一个地方出现：声音属于**人物资产**，不属于任何单个镜头。
 * 第 4 步「资产与声音检查」只读继承结果（见 `ShotVoiceInheritancePanel`），
 * 到第 5 步不再出现任何声音相关操作。
 *
 * 本区块提供四件事（与设计包逐字一致）：选择 · 试听 · 保存 · 更换。
 * 更换会同步到该人物已继承的全部镜头，所以**必须二次确认**，并且确认框里写清影响范围。
 *
 * 边界与安全：
 * - 只处理**角色声音（人物配音）**：配乐 / 环境音 / 音效 / 最终成片音轨不在这里，
 *   也不属于人物资产；
 * - 绑定与读取都走既有资产级声音读写口（免费，不调模型、不触图、不触视频）；
 * - 主区不出现文件编号 / 地址这类内部标识，它们只在默认收起的「技术详情」里露一次
 *   （复用全仓唯一的折叠壳实现）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Empty, Input, List, Modal, Space, Tag, Typography, message } from 'antd'
import { ReloadOutlined, SoundOutlined } from '@ant-design/icons'

import { OpenAPI, StudioAssetVoicesService, StudioFilesService } from '../../../../../../services/generated'
import { showUserError, toUserFacingText } from '../../../../components/userFacingMessage'
import { TechnicalDetailSection } from './TechnicalDetailCollapse.tsx'
import {
  VOICE_BOUND_PREFIX,
  VOICE_LOAD_FAILED,
  VOICE_OPTIONS_LOAD_FAILED,
  VOICE_PICKER_EMPTY,
  VOICE_PICKER_HINT,
  VOICE_PICKER_TITLE,
  VOICE_PREVIEW_LABEL,
  VOICE_REPLACE_LABEL,
  VOICE_SAVE_FAILED,
  VOICE_SAVE_LABEL,
  VOICE_SCOPE_HINT,
  VOICE_SECTION_TITLE,
  VOICE_SELECT_LABEL,
  VOICE_UNBOUND_HINT,
  VOICE_UNBOUND_MAIN,
  normalizeAssetVoice,
  replaceVoiceConfirmText,
  toPlayableUrl,
  voiceBindRequest,
  voiceOptionsFromFiles,
  voiceSavedText,
  type VoiceBindingView,
  type VoiceOption,
} from './voiceBindingState.ts'

export type VoiceBindingSectionProps = {
  /** 资产类型（只有人物资产才渲染本区块，判断在抽屉那一层做） */
  assetType: string
  assetId: string
  /** 人物名字（进文案：绑定 / 更换都说清是给谁配的声音） */
  assetName: string
  /** 这个人物在本章的出场镜头数（更换确认里说明影响范围） */
  inheritedShotCount?: number
  /** 项目 ID（按项目筛音频素材；拿不到就不筛） */
  projectId?: string | null
  /** 绑定或更换成功后通知宿主（工作台卡片上的缺项要跟着刷新） */
  onSaved?: () => void
}

export function VoiceBindingSection(props: VoiceBindingSectionProps) {
  const { assetType, assetId, assetName, inheritedShotCount = 0, projectId, onSaved } = props

  const [view, setView] = useState<VoiceBindingView | null>(null)
  const [files, setFiles] = useState<readonly unknown[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [filesError, setFilesError] = useState('')
  /** 已经挑好、但还没保存的音色（未绑定时是"将绑定"，已绑定时是"将更换"） */
  const [pending, setPending] = useState<VoiceOption | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [keyword, setKeyword] = useState('')

  /** 读当前绑定（只读、免费）。 */
  const loadVoice = useCallback(async () => {
    setLoading(true)
    try {
      const res = await StudioAssetVoicesService.getAssetVoiceApiV1StudioAssetVoicesAssetTypeAssetIdGet({
        assetType,
        assetId,
      })
      setView(normalizeAssetVoice(res.data))
      setLoadError('')
    } catch (e) {
      setLoadError(toUserFacingText(e, VOICE_LOAD_FAILED))
    } finally {
      setLoading(false)
    }
  }, [assetId, assetType])

  /** 拉素材库里的音频（音色的来源：项目里的音频素材）。 */
  const loadFiles = useCallback(async () => {
    try {
      const res = await StudioFilesService.listFilesApiApiV1StudioFilesGet({
        page: 1,
        pageSize: 100,
        order: 'created_at',
        isDesc: true,
        projectId: projectId ?? null,
      })
      setFiles((res.data?.items ?? []) as unknown as unknown[])
      setFilesError('')
    } catch (e) {
      setFilesError(toUserFacingText(e, VOICE_OPTIONS_LOAD_FAILED))
    }
  }, [projectId])

  useEffect(() => {
    void loadVoice()
  }, [loadVoice])

  useEffect(() => {
    void loadFiles()
  }, [loadFiles])

  const options = useMemo(() => voiceOptionsFromFiles(files, keyword), [files, keyword])
  const bound = view?.bound === true
  const actionLabel = bound ? VOICE_REPLACE_LABEL : VOICE_SELECT_LABEL

  /** 写入绑定：未绑定时是"保存"，已绑定时是"更换"（调用前必须已经二次确认）。 */
  const applyVoice = useCallback(
    async (option: VoiceOption) => {
      setSaving(true)
      try {
        await StudioAssetVoicesService.putAssetVoiceApiV1StudioAssetVoicesAssetTypeAssetIdPut({
          assetType,
          assetId,
          requestBody: voiceBindRequest(option),
        })
        await loadVoice()
        setPending(null)
        message.success(voiceSavedText(assetName, option.name))
        onSaved?.()
      } catch (e) {
        void showUserError(e, VOICE_SAVE_FAILED)
      } finally {
        setSaving(false)
      }
    },
    [assetId, assetName, assetType, loadVoice, onSaved],
  )

  /** 点「保存」：已绑定时先二次确认（更换会同步到该人物已继承的全部镜头）。 */
  const handleSave = useCallback(() => {
    if (!pending) return
    const currentName = view?.bound ? view.voiceName : ''
    if (!currentName) {
      void applyVoice(pending)
      return
    }
    const text = replaceVoiceConfirmText(assetName, currentName, pending.name, inheritedShotCount)
    Modal.confirm({
      title: text.title,
      content: text.content,
      okText: '确认更换',
      cancelText: '再想想',
      onOk: async () => {
        await applyVoice(pending)
      },
    })
  }, [applyVoice, assetName, inheritedShotCount, pending, view])

  const pick = useCallback((option: VoiceOption) => {
    setPending(option)
    setPickerOpen(false)
    // 挑好不等于保存：主区会显示"将要绑定 / 将要更换"和保存按钮，避免误点即生效。
  }, [])

  const pendingName = pending?.name ?? ''
  const pendingActionText = bound ? `将更换为：${pendingName}` : `将绑定：${pendingName}`

  return (
    <section data-testid="voice-binding-section">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-700">{VOICE_SECTION_TITLE}</span>
        <Space size={8}>
          <Button
            size="small"
            type={pending ? 'default' : 'primary'}
            icon={<SoundOutlined />}
            disabled={saving}
            onClick={() => setPickerOpen(true)}
          >
            {actionLabel}
          </Button>
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void loadVoice()}>
            刷新
          </Button>
        </Space>
      </div>

      <Typography.Text type="secondary" className="text-[11px]">{VOICE_SCOPE_HINT}</Typography.Text>

      {loadError ? (
        <Alert className="mt-2" type="error" showIcon message={VOICE_LOAD_FAILED} description={loadError} />
      ) : null}

      <div className="mt-2 rounded border border-slate-200 bg-slate-50 px-2 py-2">
        {bound ? (
          <div className="space-y-1">
            <div className="text-[12px] text-slate-700">
              <Tag bordered={false} color="blue">
                {VOICE_BOUND_PREFIX}
              </Tag>
              {view?.voiceName || '（未命名）'}
            </div>
            {view?.audioUrl ? (
              <div>
                <div className="mb-1 text-[11px] text-slate-500">{VOICE_PREVIEW_LABEL}</div>
                <audio
                  controls
                  preload="none"
                  className="h-8 w-full"
                  src={toPlayableUrl(view.audioUrl, OpenAPI.BASE)}
                />
              </div>
            ) : (
              <div className="text-[11px] text-slate-400">这一段音色还没有可播放的地址。</div>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            <div className="text-[12px] text-slate-700">{VOICE_UNBOUND_MAIN}</div>
            <div className="text-[11px] text-slate-500">{VOICE_UNBOUND_HINT}</div>
          </div>
        )}
      </div>

      {pending ? (
        <div className="mt-2 rounded border border-blue-200 bg-blue-50 px-2 py-2">
          <div className="text-[12px] text-slate-700">{pendingActionText}</div>
          <Space size={8} className="mt-1">
            <Button
              size="small"
              type="primary"
              loading={saving}
              onClick={() => {
                handleSave()
              }}
            >
              {VOICE_SAVE_LABEL}
            </Button>
            <Button size="small" disabled={saving} onClick={() => setPending(null)}>
              取消
            </Button>
          </Space>
        </div>
      ) : null}

      {/* 技术详情（默认收起）：文件编号这类内部标识只在这里出现。 */}
      {view?.voiceRef ? (
        <TechnicalDetailSection testId="asset-voice-technical-detail" hint="这段音色在系统里的编号">
          <div className="break-all text-[11px]">{`文件编号：${view.voiceRef}`}</div>
        </TechnicalDetailSection>
      ) : null}

      <Modal
        title={VOICE_PICKER_TITLE}
        open={pickerOpen}
        footer={null}
        onCancel={() => setPickerOpen(false)}
        width={640}
      >
        <Space direction="vertical" className="w-full" size="middle">
          <Input
            allowClear
            placeholder="按名称筛选"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <div className="text-[11px] text-slate-500">{VOICE_PICKER_HINT}</div>
          {filesError ? <Alert type="error" showIcon message={VOICE_OPTIONS_LOAD_FAILED} description={filesError} /> : null}
          {options.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={VOICE_PICKER_EMPTY} />
          ) : (
            <List
              size="small"
              dataSource={options}
              renderItem={(option) => (
                <List.Item
                  actions={[
                    <Button key="pick" size="small" type="link" onClick={() => pick(option)}>
                      用这一段
                    </Button>,
                  ]}
                >
                  <div className="w-full">
                    <div className="text-[12px] text-slate-700">{option.name}</div>
                    {option.audioUrl ? (
                      <audio
                        controls
                        preload="none"
                        className="mt-1 h-8 w-full"
                        src={toPlayableUrl(option.audioUrl, OpenAPI.BASE)}
                      />
                    ) : null}
                  </div>
                </List.Item>
              )}
            />
          )}
        </Space>
      </Modal>
    </section>
  )
}

export default VoiceBindingSection
