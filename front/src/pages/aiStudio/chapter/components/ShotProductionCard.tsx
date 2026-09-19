/**
 * 当前镜头的「生产卡」（工作室第 6 步主操作）。
 *
 * 为什么要有它（用户 2026-09-19 第二部分要求）：
 * 集级页面确认保存之后，工作台里应该**只做逐镜检查与补漏**，并把这条镜头的两件事收在一张卡上：
 *   ① 看清楚：镜头内容 + 已确认的视频提示词（含来源）+ 本镜实际使用的图片/声音文件 + 还缺什么；
 *   ② 做决定：直接生成视频（先看最终请求摘要）或导出绑定提示词（复用既有 TXT 下载）。
 * 不允许"只显示资产名称而没有实际文件"，也不允许生成/导出读另一份临时文本。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Descriptions, Empty, Input, Select, Space, Spin, Tag, Tooltip, Typography, message } from 'antd'
import { DownloadOutlined, PlayCircleOutlined } from '@ant-design/icons'
import {
  persistGeneratedVideo,
  previewPromptDelivery,
  previewVideoSubmitPlan,
  saveShotVideoPrompt,
  submitVideo,
  type PromptDeliveryRow,
  type VideoPlanFrame,
} from '../../../../services/llmPipelineApi'
import { buildFileDownloadUrl, resolveAssetUrl } from '../../assets/utils'

/** 生成计划摘要的结构（`previewVideoSubmitPlan` 返回） */
type VideoPlanSummary = Awaited<ReturnType<typeof previewVideoSubmitPlan>>

/** 参考模式选项（与后端 REQUIRED_FRAMES_BY_MODE 一致） */
const REFERENCE_MODE_OPTIONS = [
  { value: 'first', label: 'first（首帧）' },
  { value: 'last', label: 'last（尾帧）' },
  { value: 'key', label: 'key（关键帧）' },
  { value: 'first_last', label: 'first_last（首尾帧）' },
  { value: 'first_last_key', label: 'first_last_key（首尾+关键）' },
  { value: 'text_only', label: 'text_only（纯文本）' },
]

/**
 * 计划里是否存在"有 file_id 但**供应商取不到**"的参考帧。
 *
 * 为什么按钮还要看这个：后端已经把这种帧算进 `generation_blocked`，但页面不能只依赖一个布尔值 ——
 * 一旦计划是旧数据（例如切换模式后还没刷新），按钮就可能带着不可用的帧放开。
 * 判定口径与后端 `resolve_vendor_image_ref` 一致：`usable=false` 且有 file_id = 供应商取不到。
 * text_only 不需要帧，永远不算阻断。
 */
function hasVendorUnusableFrame(plan: VideoPlanSummary | null | undefined): boolean {
  if (!plan) return false
  if (String(plan.reference_mode ?? '') === 'text_only') return false
  return (plan.frames ?? []).some((frame: VideoPlanFrame) => Boolean(frame.file_id) && frame.usable === false)
}

type ShotProductionCardProps = {
  projectId?: string
  chapterId?: string | null
  shotId: string
  /** 当前镜头已保存的视频提示词（来自 shot_details） */
  savedPrompt: string
  savedPromptSource: string
  /** 保存成功后通知外层刷新详情（保持界面与库里一致） */
  onSavedPrompt?: (prompt: string, source: string) => Promise<void> | void
  /** 打开单镜生成草稿的入口（复用工作台既有的单镜生成能力） */
  onGenerateDraft?: () => void
  /** 直接进入交付导出（第 6 步出口一） */
  onOpenExport?: () => void
}

export function ShotProductionCard({
  projectId,
  chapterId,
  shotId,
  savedPrompt,
  savedPromptSource,
  onSavedPrompt,
  onGenerateDraft,
  onOpenExport,
}: ShotProductionCardProps) {
  const [row, setRow] = useState<PromptDeliveryRow | null>(null)
  const [loading, setLoading] = useState(false)
  const [draft, setDraft] = useState(savedPrompt)
  const [saving, setSaving] = useState(false)
  const [plan, setPlan] = useState<VideoPlanSummary | null>(null)
  /** 参考模式：由页面显式选择，计划与生成**共用同一份参数** */
  const [referenceMode, setReferenceMode] = useState('first')
  const [planLoading, setPlanLoading] = useState(false)
  const [generating, setGenerating] = useState(false)

  const load = useCallback(async () => {
    if (!projectId || !shotId) return
    setLoading(true)
    try {
      const data = await previewPromptDelivery(projectId, chapterId, 'episode', [shotId])
      setRow((data?.rows ?? []).find((item) => item.shot_id === shotId) ?? null)
    } catch {
      setRow(null)
    } finally {
      setLoading(false)
    }
  }, [chapterId, projectId, shotId])

  useEffect(() => {
    setDraft(savedPrompt)
  }, [savedPrompt, shotId])

  useEffect(() => {
    void load()
  }, [load])

  // 参考模式一变，旧计划立即失效（按钮必须先禁用，避免用陈旧参数提交）
  useEffect(() => {
    setPlan(null)
  }, [referenceMode])

  // 自动预检：进入生产卡 / 切换镜头 / 切换参考模式都自动拉一次计划
  useEffect(() => {
    if (!shotId) return
    let active = true
    setPlanLoading(true)
    void (async () => {
      try {
        const data = await previewVideoSubmitPlan({
          shot_id: shotId,
          reference_mode: referenceMode,
          // 摘要必须与真实提交同参：`doGenerate()` 提交的就是这份「已保存提示词」，
          // 不带 prompt 的预览会走后端模板拼装，于是摘要里显示的正文跟真正发出去的
          // 不是同一份（用户核对的对象就错了）。
          prompt: savedPrompt.trim() || undefined,
        })
        if (active) setPlan(data)
      } catch (error) {
        if (active) {
          setPlan(null)
          message.warning(error instanceof Error ? error.message : '读取生成计划失败')
        }
      } finally {
        if (active) setPlanLoading(false)
      }
    })()
    return () => {
      active = false
    }
    // savedPrompt 参与依赖：镜头详情是异步到的，首帧渲染时它还是空串，
    // 少了这个依赖，摘要会一直停在"模板拼装提示词"，与实际提交内容不符。
  }, [shotId, referenceMode, savedPrompt])

  /** 本镜实际使用的文件（图片按槽位分组 + 声音单列） */
  const files = row?.bound_files ?? []
  const imageFiles = files.filter((item) => String(item.slot ?? '') !== 'audio')
  const audioFile = files.find((item) => String(item.slot ?? '') === 'audio')
  const missingImages = imageFiles.filter((item) => !item.usable)

  const gaps = useMemo(() => {
    const list: string[] = []
    if (!savedPrompt.trim()) list.push('还没有已保存的视频提示词（可在本卡编辑后保存，或用单镜生成草稿）')
    if (!imageFiles.length) list.push('还没有绑定任何图片资产（第 5 步绑定后这里会列出实际文件）')
    if (missingImages.length) list.push(`上游素材里 ${missingImages.length} 个绑定资产没有可用图片文件（未定版或缺图）`)
    if (plan?.generation_blocked) list.push(`视频请求缺少参考模式「${plan.reference_mode}」要求的帧：${(plan.missing_frame_types ?? []).join('、')}（可在②处补齐或换模式）`)
    if (!audioFile) list.push('还没有声音：需要配音就绑定音频，不需要就点「本镜无需声音」明确说明')
    return list
  }, [audioFile, imageFiles.length, missingImages.length, plan, savedPrompt])

  const doSavePrompt = async () => {
    if (!draft.trim()) {
      message.warning('提示词为空，未保存')
      return
    }
    setSaving(true)
    try {
      // 工作台内人工修改 → 来源固定记 manual（与集级页面的来源口径一致）
      await saveShotVideoPrompt(shotId, draft.trim(), 'manual')
      await onSavedPrompt?.(draft.trim(), 'manual')
      message.success('已保存到本镜（来源：人工修改）')
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const loadPlan = async () => {
    setPlanLoading(true)
    try {
      // 摘要读的是"这次真的要发出去的东西"：已保存提示词 + 当前绑定文件
      const data = await previewVideoSubmitPlan({
        shot_id: shotId,
        reference_mode: referenceMode,
        prompt: savedPrompt.trim() || undefined,
      })
      setPlan(data)
    } catch (error) {
      message.error(error instanceof Error ? error.message : '读取生成计划失败')
    } finally {
      setPlanLoading(false)
    }
  }

  const doGenerate = async () => {
    // 再次校验这份计划：plan 为空（还没加载/已因换模式失效）绝不带默认参数提交
    if (!plan) {
      message.error('生成计划尚未就绪：请等计划加载完成（或点上方「刷新」）后再生成。')
      return
    }
    if (plan.generation_blocked) {
      message.error(plan.blocked_reason || '当前参考模式缺少必需帧，已阻止生成。')
      return
    }
    // 与后端同一口径的第二道自检：供应商取不到的参考帧绝不让请求发出去。
    if (hasVendorUnusableFrame(plan)) {
      message.error(
        '参考帧供应商无法访问：帧文件是本机/相对地址，只能解析成本机 data URL，'
          + '而当前供应商只接受 http(s):// 或 asset://。请把帧图片放到公网后重新设为该帧，或改用 text_only。',
      )
      return
    }
    if (!savedPrompt.trim()) {
      message.error('本镜还没有已保存的提示词：先保存提示词再生成（生成读的就是这一份）')
      return
    }
    setGenerating(true)
    try {
      // 生成用**同一份计划参数**：参考模式、比例、提示词都取自刚才那份计划/已保存内容
      const result = await submitVideo({
        shot_id: shotId,
        reference_mode: plan.reference_mode || referenceMode,
        prompt: savedPrompt.trim(),
        images: [],
        ratio: plan.ratio || '16:9',
        duration_seconds: plan.seconds ?? undefined,
        timeout_seconds: 900,
      })
      if (result.status === 'dry_run') {
        message.info('演练模式：只展示计划，不会产生正式视频，也未写入任何库')
        return
      }
      if (result.status !== 'completed' || !result.url) {
        message.error(result.error || `视频生成未完成（status=${result.status}）`)
        return
      }
      const fileId = await persistGeneratedVideo(shotId, result.url, '镜头视频（直提）')
      message.success(`已生成并挂到本镜（file_id=${fileId}）`)
      await load()
    } catch (error) {
      message.error(error instanceof Error ? error.message : '生成失败')
    } finally {
      setGenerating(false)
    }
  }

  if (!shotId) return <Empty description="请先选择一条分镜" />

  return (
    <Spin spinning={loading}>
      <div className="space-y-3">
        {/* ① 上方：镜头内容 + 已确认的视频提示词 */}
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium text-slate-900">已保存的视频提示词（生成与导出读的就是这一份）</div>
            <Space size={6}>
              <Tag color={savedPrompt ? 'green' : 'gold'}>{savedPrompt ? `来源：${savedPromptSource || '未标记'}` : '尚未保存'}</Tag>
              {onGenerateDraft ? (
                <Button size="small" onClick={onGenerateDraft}>
                  单镜生成草稿
                </Button>
              ) : null}
            </Space>
          </div>
          <Input.TextArea rows={4} value={draft} onChange={(event) => setDraft(event.target.value)} />
          <Space className="mt-2">
            <Button size="small" type="primary" loading={saving} disabled={!draft.trim()} onClick={() => void doSavePrompt()}>
              保存到本镜（来源：人工修改）
            </Button>
            <Button size="small" disabled={draft === savedPrompt} onClick={() => setDraft(savedPrompt)}>
              还原为已保存内容
            </Button>
            <Typography.Text type="secondary" className="text-[11px]">
              {`${draft.trim().length} 字${draft.trim() === savedPrompt ? '（与已保存一致）' : '（与已保存不一致）'}`}
            </Typography.Text>
          </Space>
        </div>

        {/* ② 中间：三类内容分开——上游绑定素材 / 本次请求实际使用的参考帧 / 声音 */}
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="mb-1 text-sm font-medium text-slate-900">① 上游素材：前面资产步骤绑定的定版图片</div>
          <div className="mb-2 text-[11px] text-gray-500">
            这些是**生成参考帧的上游素材**，不是视频请求里真正发出去的文件；改它们要去第 5 步「关联绑定」。
          </div>
          {imageFiles.length ? (
            <div className="space-y-2">
              {imageFiles.map((item) => {
                const src = item.url ? resolveAssetUrl(item.url) : item.file_id ? buildFileDownloadUrl(item.file_id) : ''
                return (
                  <div key={`${item.slot}-${item.asset_id}`} className="flex items-start gap-2">
                    {src ? (
                      <img src={src} alt="" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 6, border: '1px solid #e2e8f0' }} />
                    ) : (
                      <div className="flex h-11 w-11 items-center justify-center rounded border border-dashed border-slate-300 text-[10px] text-gray-400">无图</div>
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-1">
                        <span className="text-xs">{item.asset_name || item.asset_id}</span>
                        <Tag color={item.is_primary ? 'green' : item.usable ? 'gold' : 'red'} style={{ marginInlineEnd: 0 }}>
                          {item.is_primary ? '定版' : item.usable ? '非定版' : '无可用文件'}
                        </Tag>
                      </div>
                      <div className="text-[10px] text-gray-500">{item.slot_label || item.slot}</div>
                      <div className="break-all font-mono text-[10px] text-gray-600">{item.file_id || '（无）'}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="text-[11px] text-gray-500">这一镜还没有绑定图片资产（请回第 5 步「关联绑定」）</div>
          )}
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="mb-1 flex items-center justify-between">
            <div className="text-sm font-medium text-slate-900">② 本次视频请求实际使用的参考帧</div>
            <Space size={6}>
              <span className="text-[11px] text-gray-500">参考模式</span>
              <Select
                size="small"
                style={{ width: 150 }}
                value={referenceMode}
                onChange={(value) => {
                  setReferenceMode(value)
                  setPlan(null)
                }}
                options={REFERENCE_MODE_OPTIONS}
              />
              <Button size="small" loading={planLoading} onClick={() => void loadPlan()}>
                {plan ? '刷新' : '加载计划'}
              </Button>
            </Space>
          </div>
          <div className="mb-2 text-[11px] text-gray-500">
            真正发给视频模型的是这些 **分镜帧文件**（首帧/尾帧/关键帧），与上面的绑定素材是上下游关系。
          </div>
          {plan ? (
            <div className="space-y-2">
              <div className="text-[11px] text-gray-600">
                {`参考模式：${plan.reference_mode || referenceMode} · 要求帧：${(plan.required_frame_types ?? []).join('、') || '无（纯文本）'}`}
              </div>
              {(plan.frames ?? []).length ? (
                (plan.frames ?? []).map((frame: VideoPlanFrame) => (
                  <div key={`${frame.frame_type}-${frame.file_id}`} className="flex items-start gap-2">
                    {frame.url ? (
                      <img src={resolveAssetUrl(frame.url)} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6, border: '1px solid #e2e8f0' }} />
                    ) : (
                      <div className="flex h-10 w-10 items-center justify-center rounded border border-dashed border-slate-300 text-[10px] text-gray-400">缺</div>
                    )}
                    <div className="min-w-0">
                      <Tag color={frame.usable ? 'green' : 'red'} style={{ marginInlineEnd: 4 }}>
                        {frame.frame_type}
                      </Tag>
                      {frame.file_id && !frame.usable ? (
                        <Tag color="orange" style={{ marginInlineEnd: 4 }}>
                          帧已存在，但供应商无法访问
                        </Tag>
                      ) : null}
                      <span className="break-all font-mono text-[10px] text-gray-600">{frame.file_id || '（缺帧）'}</span>
                      {frame.reason ? (
                        <div className="mt-0.5 max-w-[520px] text-[10px] leading-4 text-orange-600">{frame.reason}</div>
                      ) : null}
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-[11px] text-gray-500">该模式不需要帧文件（纯文本生成）。</div>
              )}
              {plan.generation_blocked ? (
                <Alert
                  type="error"
                  showIcon
                  message={plan.blocked_reason || `缺少参考模式要求的帧：${(plan.missing_frame_types ?? []).join('、')}`}
                  description={
                    <Space direction="vertical" size={2}>
                      {(plan.unusable_frame_types ?? []).length ? (
                        <span>
                          {`其中 ${(plan.unusable_frame_types ?? []).join('、')} 是"已上传但供应商取不到"：`}
                          本机/相对地址只能解析成本机 data URL，供应商只接受 http(s):// 或 asset://。
                          把帧图片放到公网（OSS 等）后重新设为该帧即可；不想用参考帧就切到 text_only。
                        </span>
                      ) : (
                        <span>请到「关键帧与参考图」补齐这一帧，或把参考模式切换到模型支持的其他模式。</span>
                      )}
                      <Space size={6}>
                        <Button size="small" onClick={onGenerateDraft}>
                          去补齐关键帧
                        </Button>
                      </Space>
                    </Space>
                  }
                />
              ) : null}
            </div>
          ) : (
            <div className="text-[11px] text-gray-500">点右上「刷新」读取本次请求实际使用的帧（只读计划，不触网、不花钱）。</div>
          )}
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="mb-1 text-sm font-medium text-slate-900">③ 声音</div>
          {plan ? (
            <div className="text-xs">
              <Tag color={plan.audio_opt_out ? 'default' : plan.audio_state === 'bound' ? 'cyan' : 'gold'} style={{ marginInlineEnd: 4 }}>
                {plan.audio_opt_out ? '本镜明确无需声音' : plan.audio_state === 'bound' ? '已绑定（公网可用）' : plan.audio_state === 'bound_not_public' ? '已绑定但地址非公网' : '未绑定'}
              </Tag>
              {plan.audio_file_id ? <span className="font-mono text-[10px] text-gray-600">{plan.audio_file_id}</span> : null}
              {plan.audio_url ? <div className="break-all text-[10px] text-gray-500">{plan.audio_url}</div> : null}
            </div>
          ) : (
            <div className="text-[11px] text-gray-500">读取计划后会显示本镜实际携带的音频文件 / 无需声音状态。</div>
          )}
        </div>

        {/* ③ 缺什么 */}
        {gaps.length ? (
          <Alert
            type="warning"
            showIcon
            message={`本镜还缺 ${gaps.length} 项`}
            description={<ul className="list-disc pl-4 text-[11px]">{gaps.map((item, index) => <li key={`gap-${index}`}>{item}</li>)}</ul>}
          />
        ) : (
          <Alert type="success" showIcon message="本镜已具备生成与导出的条件" />
        )}

        {/* ④ 下方：两个出口 */}
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="mb-2 text-sm font-medium text-slate-900">出口</div>
          <Space wrap>
            <Tooltip title="先看最终请求摘要（提示词/参考图/声音/模型/时长/画幅），确认后再发请求">
              <Button size="small" loading={planLoading} onClick={() => void loadPlan()}>
                查看生成请求摘要
              </Button>
            </Tooltip>
            <Button
              size="small"
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={generating}
              // 参考帧判定：缺帧 或 "帧已存在但供应商取不到" 都禁用（口径来自后端同一份判定，
              // 这里再按 frames[].usable 兜一层，避免任何一条路径漏掉）。
              disabled={
                !plan ||
                planLoading ||
                Boolean(plan?.generation_blocked) ||
                hasVendorUnusableFrame(plan) ||
                !savedPrompt.trim()
              }
              onClick={() => void doGenerate()}
            >
              直接生成视频
            </Button>
            <Button size="small" icon={<DownloadOutlined />} onClick={onOpenExport}>
              导出绑定提示词
            </Button>
          </Space>
          {plan ? (
            <Descriptions size="small" column={1} className="mt-3" bordered>
              <Descriptions.Item label="提示词来源">{plan.prompt_source || '—'}</Descriptions.Item>
              <Descriptions.Item label="提示词">{String(plan.prompt ?? '').slice(0, 120) || '（空）'}</Descriptions.Item>
              <Descriptions.Item label="参考图数量">{plan.reference_image_count}</Descriptions.Item>
              <Descriptions.Item label="模型 / 分辨率">{`${plan.model_name || '—'} / ${plan.resolution || '—'}`}</Descriptions.Item>
              <Descriptions.Item label="时长 / 画幅">{`${plan.seconds ?? '—'}s / ${plan.ratio || '—'}`}</Descriptions.Item>
              <Descriptions.Item label="是否需要关键帧">
                {String(plan.reference_mode || '').includes('first') ? '需要关键帧/首帧' : '不需要'}
              </Descriptions.Item>
              {plan.warnings?.length ? (
                <Descriptions.Item label="提醒">
                  <ul className="list-disc pl-4 text-[11px]">
                    {plan.warnings.slice(0, 4).map((warning: string, index: number) => (
                      <li key={`plan-warning-${index}`}>{warning}</li>
                    ))}
                  </ul>
                </Descriptions.Item>
              ) : null}
            </Descriptions>
          ) : null}
        </div>
      </div>
    </Spin>
  )
}

export default ShotProductionCard
