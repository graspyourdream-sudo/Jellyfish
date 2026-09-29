/**
 * 「新建广告视频」弹窗 —— **唯一**的广告项目创建组件。
 *
 * 两个入口都用它（任务书 §3.3 硬要求）：
 *   - 「广告视频」列表页（`ProjectLobby scope="ad"`）；
 *   - 「剧情策划」页在尚未选择项目时的唯一主操作。
 *
 * 因此默认值、校验、请求体、提交逻辑都来自 `adProjectCreate.ts` 那一份，
 * 这里只负责「把字段摆出来 + 管好加载态与失败恢复」。
 *
 * ## 防重复创建
 *
 * 三层，缺一不可：
 *   1. 按钮 `loading` + 全表单 `disabled`（用户看得见的反馈）；
 *   2. `submittingRef` 同步锁（**同一帧内的连点**在 React 状态更新前就会撞上它）；
 *   3. 项目 ID 在打开表单时**只生成一次**并复用（即使锁被绕过，后端也只会看到同一个 ID）。
 *
 * ## 失败恢复（任务书点名的两种）
 *
 * | 情形 | 页面表现 |
 * |---|---|
 * | 接口失败、什么都没保存 | 「项目没有创建成功」+ 失败原因 + 「项目**没有**保存，可以直接重试」 |
 * | 项目已保存、但跳转失败 | 「项目**已经保存**」+ 项目名 + 「进入策划」重试按钮（不会重复创建，也不重复建默认章节） |
 *
 * 跳转失败在浏览器里罕见，但它是**必须显式处理**的一类中间态：此时项目与默认章节
 * 都已经在库里，如果页面只说「失败」，用户就会再点一次创建，于是多出一个空项目。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, AutoComplete, Button, Col, Form, Input, InputNumber, Modal, Radio, Row, Select, Space, Upload, message } from 'antd'
import { useNavigate } from 'react-router-dom'
import {
  AD_DEFAULT_SHOT_COUNT,
  AD_PRODUCT_SOURCE_OPTIONS,
  OVERALL_STYLE_PRESETS,
  dramaPlanPath,
  resolveOverallStyleFields,
  type AdProductSourceChoice,
  type OverallStyleKey,
} from './projectStartPresets'
import { ProjectVisualStyleAndStyleFields } from './ProjectVisualStyleAndStyleFields'
import { useProjectStyleOptions } from './useProjectStyleOptions'
import { describeAdProjectCreateFailure } from './adProjectCreateFailure'
import { listProductEntities, uploadReferenceFile, type ProductEntityOption } from '../../../services/dramaPlanApi'
import {
  createAdProject,
  emptyAdProjectDraft,
  newProjectId,
  validateAdProjectDraft,
  type AdProjectDraft,
  type AdProjectCreated,
} from './adProjectCreate'

const { TextArea } = Input

export type AdProjectCreateModalProps = {
  open: boolean
  onCancel: () => void
  /** 创建并成功跳转之后回调（列表页据此把新项目并进列表 / 刷新一次） */
  onCreated?: (created: AdProjectCreated) => void
}

export function AdProjectCreateModal({ open, onCancel, onCreated }: AdProjectCreateModalProps) {
  const navigate = useNavigate()
  const { options: projectStyleOptions, videoRatioOptions } = useProjectStyleOptions()
  const [form] = Form.useForm()

  const [draft, setDraft] = useState<AdProjectDraft>(() => emptyAdProjectDraft())
  const [submitting, setSubmitting] = useState(false)
  /** 创建失败（**没有保存**）时的中文说明 */
  const [errorText, setErrorText] = useState('')
  /** 项目已保存、但跳转没成功时的中间态 */
  const [saved, setSaved] = useState<AdProjectCreated | null>(null)

  /**
   * 同步提交锁。
   *
   * 为什么 state 不够：React 的 `setSubmitting(true)` 是异步的，
   * 用户在同一个事件循环里连点两次（或双击）时，第二次拿到的还是旧的 `submitting=false`。
   */
  const submittingRef = useRef(false)
  /** 本次打开表单的项目 ID（只生成一次：同一份草稿无论提交几次都是同一个项目） */
  const projectIdRef = useRef('')

  const [adSource, setAdSource] = useState<AdProductSourceChoice>('paste')
  const [adProducts, setAdProducts] = useState<ProductEntityOption[]>([])
  const [adProductsNote, setAdProductsNote] = useState('')
  const [adUploading, setAdUploading] = useState(false)

  /** 打开时重置到统一默认值：两个入口、每次打开看到的初始状态完全一致。 */
  useEffect(() => {
    if (!open) return
    const next = emptyAdProjectDraft()
    setDraft(next)
    setAdSource(next.productSource)
    setErrorText('')
    setSaved(null)
    setSubmitting(false)
    submittingRef.current = false
    projectIdRef.current = newProjectId()
    form.setFieldsValue({
      name: next.name,
      description: next.description,
      overallStyle: next.overallStyle,
      default_video_ratio: next.defaultVideoRatio,
      visual_style: next.visualStyle,
      style: next.style,
      unifyStyle: next.unifyStyle,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const patch = useCallback((next: Partial<AdProjectDraft>) => {
    setDraft((current) => ({ ...current, ...next }))
  }, [])

  /** 选「已有商品」时才拉一次商品列表（免费、只读）。 */
  const loadAdProducts = useCallback(async () => {
    if (adProducts.length > 0) return
    try {
      setAdProducts(await listProductEntities())
      setAdProductsNote('')
    } catch {
      setAdProductsNote('读不到已有商品列表：可以改用粘贴或上传资料，或先建项目再到策划页补商品卡。')
    }
  }, [adProducts.length])

  const handleUpload = useCallback(async (file: File) => {
    setAdUploading(true)
    try {
      const uploaded = await uploadReferenceFile(file)
      setDraft((current) => ({
        ...current,
        productFileIds: [...current.productFileIds, uploaded.id],
      }))
      message.success(`已上传《${uploaded.name || file.name}》`)
    } catch {
      message.error('资料上传失败，请稍后重试（也可以先在向导里选「暂无商品资料」，创建后到策划页再补）')
    } finally {
      setAdUploading(false)
    }
  }, [])

  /** 跳转到该项目的商品资料与剧情策划工作台（带真实 projectId + chapterId）。 */
  const enterPlan = useCallback(
    (created: AdProjectCreated, options: { keepOnFailure: boolean }) => {
      const path = dramaPlanPath(created.projectId, created.chapterId || null)
      try {
        navigate(path)
        return true
      } catch {
        /* 跳转失败：项目与默认章节**都已经在库里**。绝不能只说「失败」——
           用户会再点一次创建，于是多出一个空项目。这里把「已保存」这个事实说清楚，
           并给一个只做跳转的入口（不会再发创建请求）。 */
        if (options.keepOnFailure) {
          setSaved(created)
          setErrorText('')
          message.warning('项目已经保存，但页面没能自动打开策划页；请点「进入策划」继续。')
        }
        return false
      }
    },
    [navigate],
  )

  const handleSubmit = useCallback(async () => {
    if (submittingRef.current) return
    /**
     * ⚠️ 锁必须在**任何 `await` 之前**置位。
     *
     * 为什么：`form.validateFields()` 是异步的。如果先校验再上锁，两次点击都会
     * 在锁还是 false 的时候通过检查，于是各提交一次 —— 这正是"连点产生两个项目"的形态
     * （真机复现过）。校验失败时再把锁放掉，用户仍然可以直接重试。
     */
    submittingRef.current = true
    setSubmitting(true)
    try {
      /* 已经保存过（跳转失败那一步）时，再点主按钮**不再创建**，只重试跳转。 */
      if (saved) {
        enterPlan(saved, { keepOnFailure: true })
        return
      }
      let values: { name?: string; description?: string; default_video_ratio?: string }
      try {
        await form.validateFields()
        values = form.getFieldsValue()
      } catch {
        return
      }
      const pending: AdProjectDraft = {
        ...draft,
        name: String(values?.name ?? draft.name ?? ''),
        description: String(values?.description ?? draft.description ?? ''),
        defaultVideoRatio: String(values?.default_video_ratio ?? draft.defaultVideoRatio ?? ''),
      }
      const invalid = validateAdProjectDraft(pending)
      if (invalid) {
        setErrorText(invalid)
        return
      }
      setErrorText('')
      const created = await createAdProject(pending, projectIdRef.current)
      onCreated?.(created)
      /* 项目 + 默认章节都由后端在同一事务里建好：这里只跳转一次，
         不会因为重试再建一次默认章节。 */
      enterPlan(created, { keepOnFailure: true })
    } catch (exc) {
      /* 失败文案必须回答三件事：发生了什么 / 项目有没有保存 / 接下来怎么办。
         「原因 / 下一步」两行由 `describeAdProjectCreateFailure` 给 —— 它会把
         「请求根本没送到服务」和「服务应答了但失败」分开，前者不会只给一句
         `Failed to fetch`，而是点名正在连的后端地址并给出启动服务的做法。 */
      const { reasonLine, nextStepLine } = describeAdProjectCreateFailure(exc)
      setErrorText(
        ['项目**没有**创建成功，也没有保存任何内容。', reasonLine, nextStepLine].join('\n'),
      )
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }, [draft, enterPlan, form, onCreated, saved])

  const presetHint = useMemo(() => {
    const preset = OVERALL_STYLE_PRESETS.find((item) => item.key === draft.overallStyle)
    return preset?.description ?? ''
  }, [draft.overallStyle])

  return (
    <Modal
      title="新建广告视频"
      open={open}
      onCancel={() => {
        if (submitting) return
        onCancel()
      }}
      maskClosable={!submitting}
      footer={null}
      width={640}
      destroyOnHidden
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="这里创建的固定是剧情广告项目"
        description="创建后会自动建立默认章节，并直接进入商品资料与剧情策划：商品资料 → 一句话核心创意 → 完整剧情 → 分镜 → 确认策划 → 资产准备。"
      />

      {saved ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="ad-create-saved"
          message="项目已经保存"
          description={
            <div>
              <div>
                《{saved.projectName || '未命名项目'}》已经创建成功，默认章节也已经建好（
                {saved.chapterId ? '不会重复创建' : '章节目录为空'}）。
              </div>
              <div style={{ marginTop: 6 }}>
                刚才只是没能自动打开策划页。点下面的「进入策划」继续；**不要再点一次创建**，否则会多出一个空项目。
              </div>
            </div>
          }
        />
      ) : null}

      {errorText ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          data-testid="ad-create-error"
          message="创建广告项目失败"
          description={<span style={{ whiteSpace: 'pre-wrap' }}>{errorText.replace(/\*\*/g, '')}</span>}
        />
      ) : null}

      <Form form={form} layout="vertical" disabled={submitting}>
        <Form.Item name="name" label="项目名称" rules={[{ required: true, message: '请输入项目名称' }]}>
          <Input placeholder="例如：秋季新品保温杯 · 剧情广告" />
        </Form.Item>
        <Form.Item name="description" label="项目简介（选填）">
          <TextArea rows={3} placeholder="这条广告想讲什么、给谁看、投在哪里" />
        </Form.Item>

        <div className="mb-3 rounded border border-purple-100 bg-purple-50/40 p-3">
          <div className="mb-2 text-sm font-medium text-gray-700">商品资料来源</div>
          <Space wrap size={4} className="mb-2">
            {AD_PRODUCT_SOURCE_OPTIONS.map((option) => (
              <Radio.Button
                key={option.key}
                checked={adSource === option.key}
                onChange={() => {
                  setAdSource(option.key)
                  patch({ productSource: option.key })
                  if (option.key === 'existing') void loadAdProducts()
                }}
              >
                {option.label}
              </Radio.Button>
            ))}
          </Space>
          <div className="mb-2 text-[11px] text-gray-500">
            {AD_PRODUCT_SOURCE_OPTIONS.find((option) => option.key === adSource)?.hint}
          </div>
          {adSource === 'paste' && (
            <TextArea
              rows={4}
              value={draft.productText}
              placeholder="把商品详情、卖点、人群、价格等资料贴在这里（创建后可在策划页一键提取）"
              onChange={(event) => patch({ productText: event.target.value })}
            />
          )}
          {adSource === 'upload' && (
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Upload
                multiple
                showUploadList={false}
                accept=".txt,.md,.docx,image/png,image/jpeg,image/webp,image/gif"
                beforeUpload={(file) => {
                  void handleUpload(file as unknown as File)
                  return false
                }}
              >
                <Button size="small" loading={adUploading}>
                  上传资料文件（TXT / DOCX / 图片）
                </Button>
              </Upload>
              {draft.productFileIds.length > 0 && (
                <div className="text-[11px] text-gray-500">已上传 {draft.productFileIds.length} 个文件</div>
              )}
              <div className="text-[11px] text-gray-500">
                创建后到策划页做「从资料提取」：文档会被解析成文字，图片只作为参考资料归档。
              </div>
            </Space>
          )}
          {adSource === 'existing' && (
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              {adProductsNote ? (
                <div className="text-[11px] text-amber-600">{adProductsNote}</div>
              ) : (
                <Select
                  style={{ width: '100%' }}
                  placeholder="选一个已有的商品资料"
                  value={draft.productId || undefined}
                  options={adProducts.map((item) => ({
                    value: item.id,
                    label: item.name || item.description || '未命名商品',
                  }))}
                  onChange={(value) => patch({ productId: String(value) })}
                />
              )}
            </Space>
          )}
          {adSource === 'none' && (
            <div className="text-[11px] text-gray-500">
              先建项目：商品卡留到策划页手工填写，缺项会标「待补充」，不会被编造。
            </div>
          )}

          <div className="mt-3 mb-2 text-sm font-medium text-gray-700">基本制作要求</div>
          <Row gutter={8}>
            <Col span={8}>
              <div className="mb-1 text-[11px] text-gray-500">题材</div>
              <Input
                value={draft.genre}
                placeholder="留空沿用项目风格"
                onChange={(event) => patch({ genre: event.target.value })}
              />
            </Col>
            <Col span={8}>
              <div className="mb-1 text-[11px] text-gray-500">调性</div>
              <Input
                value={draft.tone}
                placeholder="例：一本正经地荒诞"
                onChange={(event) => patch({ tone: event.target.value })}
              />
            </Col>
            <Col span={4}>
              <div className="mb-1 text-[11px] text-gray-500">镜头数</div>
              <InputNumber
                min={1}
                max={16}
                style={{ width: '100%' }}
                value={draft.shotCount}
                onChange={(value) => patch({ shotCount: Number(value ?? AD_DEFAULT_SHOT_COUNT) })}
              />
            </Col>
            <Col span={4}>
              <div className="mb-1 text-[11px] text-gray-500">时长（秒）</div>
              <InputNumber
                min={0}
                max={600}
                style={{ width: '100%' }}
                value={draft.durationSeconds}
                onChange={(value) => patch({ durationSeconds: Number(value ?? 0) })}
              />
            </Col>
            <Col span={24}>
              <div className="mb-1 mt-2 text-[11px] text-gray-500">导演备注</div>
              <Input
                value={draft.directorNotes}
                placeholder="例：不要旁白、结尾不要硬引导"
                onChange={(event) => patch({ directorNotes: event.target.value })}
              />
            </Col>
            <Col span={12}>
              <div className="mb-1 mt-2 text-[11px] text-gray-500">必须出现（一行一条）</div>
              <TextArea
                rows={2}
                value={draft.mandatoryElements}
                onChange={(event) => patch({ mandatoryElements: event.target.value })}
              />
            </Col>
            <Col span={12}>
              <div className="mb-1 mt-2 text-[11px] text-gray-500">禁止出现（一行一条）</div>
              <TextArea
                rows={2}
                value={draft.forbiddenElements}
                onChange={(event) => patch({ forbiddenElements: event.target.value })}
              />
            </Col>
          </Row>
        </div>

        <Form.Item name="overallStyle" label="整体风格" rules={[{ required: true }]}>
          <Radio.Group
            className="w-full"
            onChange={(event) => {
              /* 选风格 = 把该风格的预设画幅自动填进下面的输入框（用户仍可改成别的） */
              const key = event.target.value as OverallStyleKey
              const preset = resolveOverallStyleFields(key)
              patch({
                overallStyle: key,
                ...(preset?.default_video_ratio ? { defaultVideoRatio: preset.default_video_ratio } : {}),
                ...(preset ? { visualStyle: preset.visual_style, style: preset.style } : {}),
              })
              if (preset?.default_video_ratio) {
                form.setFieldValue('default_video_ratio', preset.default_video_ratio)
              }
            }}
          >
            <Space wrap size={6}>
              {OVERALL_STYLE_PRESETS.map((preset) => (
                <Radio.Button key={preset.key} value={preset.key}>
                  {preset.label}
                </Radio.Button>
              ))}
            </Space>
          </Radio.Group>
        </Form.Item>
        <Form.Item shouldUpdate noStyle>
          {() =>
            form.getFieldValue('overallStyle') === 'custom' ? (
              <ProjectVisualStyleAndStyleFields form={form} options={projectStyleOptions} />
            ) : (
              <div className="mb-3 text-[11px] text-gray-500">
                {presetHint}（画幅会按风格自动带入，需要别的比例可以直接改；如需自己指定视觉风格 / 视频风格，请选「其他自定义」）
              </div>
            )
          }
        </Form.Item>
        <Form.Item
          name="default_video_ratio"
          label="默认画幅"
          tooltip="可选预设，也可直接输入自定义比例（格式如 9:16）；留空则由系统默认画幅决定"
        >
          <AutoComplete
            allowClear
            placeholder="选择或输入比例，如 9:16"
            options={videoRatioOptions}
            onChange={(value) => patch({ defaultVideoRatio: String(value ?? '') })}
          />
        </Form.Item>

        <Form.Item className="mb-0">
          <Space>
            <Button onClick={onCancel} disabled={submitting}>
              取消
            </Button>
            <Button
              type="primary"
              htmlType="button"
              loading={submitting}
              onClick={() => void handleSubmit()}
              data-testid="ad-create-submit"
            >
              {saved ? '进入策划' : '创建并进入策划'}
            </Button>
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  )
}

export default AdProjectCreateModal
