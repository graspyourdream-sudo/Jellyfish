/**
 * 分镜工作室 · 阶段 3 的「生成视频」设置行（设计包第 11 页 `data-od-id="generate-block"`）。
 *
 * 四个**真实**可选项：画幅 / 模型档位 / 分辨率 / 时长。
 *
 * ## 为什么这不是"纯前端控件"
 *
 * 每个选项的取值范围都来自**后端下发的计划**（`ratio_options` / `model_options` /
 * `resolution_options` / `duration_options`，最终来自供应商能力表与模型表），
 * 选中的值随请求一起提交，后端会再校验一次：不在范围内的取值**不采纳**并在
 * `settings_notes` 里如实说明。因此不会出现"页面给 1080p、提交时被能力表拒掉"这种
 * 点了才知道的失败，也不会出现"选了但没生效"的静默漂移。
 *
 * ## 主操作只有一个
 *
 * 本组件里只有「生成视频」是主色按钮；刷新预检 / 重新生成 / 查看完整请求都是次级。
 * 全容器同屏只有一个「流程下一步」主按钮（在顶部上下文条里），两者视觉层级不同。
 */

import { Button, Select, Tooltip } from 'antd'

export type GenerationSettingsValue = {
  ratio: string
  model: string
  resolution: string
  durationSeconds: number | null
}

export type GenerationSettingsOptions = {
  ratioOptions: string[]
  modelOptions: string[]
  resolutionOptions: string[]
  durationOptions: number[]
  /** 后端给的中文结论（哪一项被采纳 / 没有被采纳） */
  notes: string[]
}

export type StudioGenerateSettingsProps = {
  value: GenerationSettingsValue
  options: GenerationSettingsOptions
  onChange: (next: GenerationSettingsValue) => void
  /** 唯一主操作：生成视频 */
  onGenerate: () => void
  /** 次级：刷新预检 */
  onRefreshPlan?: () => void
  /** 次级：重新生成（下一轮，会再产生一次费用） */
  onRegenerate?: () => void
  /** 次级：查看完整请求 */
  onInspectRequest?: () => void
  generating?: boolean
  planLoading?: boolean
  /** 不可生成时的中文原因（空串 = 可以生成） */
  blockedReason?: string
  /** 是否允许真实付费（后端守卫结论的中文说法） */
  guardLabel?: string
}

export function StudioGenerateSettings({
  value,
  options,
  onChange,
  onGenerate,
  onRefreshPlan,
  onRegenerate,
  onInspectRequest,
  generating = false,
  planLoading = false,
  blockedReason = '',
  guardLabel = '',
}: StudioGenerateSettingsProps) {
  return (
    <div className="space-y-2" data-testid="studio-generate-settings">
      {/*
        四项设置用**自适应网格**排在一行（不是写死宽度）：
        中栏在 1440 下约 515px，写死宽度要么溢出、要么把值截断成「seedance-…」。
        模型档位那一列给得更宽（值最长），其余三列按比例分剩余空间。
      */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '0.85fr 1.5fr 0.85fr 0.7fr',
          gap: 8,
          alignItems: 'end',
        }}
      >
        {(
          [
            { key: 'ratio' as const, label: '画幅', testId: 'generate-ratio', options: options.ratioOptions, unit: '' },
            { key: 'model' as const, label: '模型档位', testId: 'generate-model', options: options.modelOptions, unit: '' },
            { key: 'resolution' as const, label: '分辨率', testId: 'generate-resolution', options: options.resolutionOptions, unit: '' },
            {
              key: 'durationSeconds' as const,
              label: '时长',
              testId: 'generate-duration',
              options: options.durationOptions.map(String),
              unit: 's',
            },
          ] as const
        ).map((field) => {
          const raw = field.key === 'durationSeconds' ? value.durationSeconds : value[field.key]
          const current = raw === null || raw === undefined ? undefined : String(raw)
          const empty = field.options.length === 0
          return (
            <label key={field.key} style={{ display: 'grid', gap: 2, minWidth: 0 }}>
              <span className="st-hint">{field.label}</span>
              <Select
                size="small"
                style={{ width: '100%' }}
                value={current}
                disabled={empty}
                placeholder={empty ? '按默认' : undefined}
                onChange={(next) =>
                  onChange(
                    field.key === 'durationSeconds'
                      ? { ...value, durationSeconds: Number(next) }
                      : { ...value, [field.key]: String(next) },
                  )
                }
                options={field.options.map((item) => ({
                  value: item,
                  label: field.unit ? `${item}${field.unit}` : item,
                }))}
                data-testid={field.testId}
              />
            </label>
          )
        })}
      </div>

      {/* 动作行：唯一主操作 + 次级操作（右对齐） */}
      <div className="flex flex-wrap items-center gap-2">
        <span style={{ marginLeft: 'auto' }} />
        {onRefreshPlan ? (
          <Tooltip title="重新读一次最终请求摘要（提示词 / 参考帧 / 声音 / 时长 / 画幅）">
            <Button size="small" loading={planLoading} onClick={onRefreshPlan} data-testid="generate-refresh-plan">
              刷新预检
            </Button>
          </Tooltip>
        ) : null}
        {onInspectRequest ? (
          <Button size="small" onClick={onInspectRequest} data-testid="generate-inspect-request">
            查看完整请求
          </Button>
        ) : null}
        {onRegenerate ? (
          <Tooltip title="同一轮重复点「生成视频」只会复用已完成的任务、不会重复计费；要真的再生成一次用这个（会再产生一次费用）">
            <Button size="small" danger loading={generating} disabled={Boolean(blockedReason)} onClick={onRegenerate}>
              重新生成（下一轮）
            </Button>
          </Tooltip>
        ) : null}
        {/* 全页**唯一**主操作：生成视频 */}
        <Button
          size="small"
          type="primary"
          loading={generating}
          disabled={Boolean(blockedReason)}
          onClick={onGenerate}
          data-testid="generate-video-cta"
        >
          生成视频
        </Button>
      </div>

      {blockedReason ? (
        <div className="st-miss" data-testid="generate-blocked-reason">
          {blockedReason}
        </div>
      ) : (
        <div className="st-hint">
          这四个选项会随请求一起提交，并由服务端按该模型的允许范围再校验一次；不在范围内的取值不会被采纳。
          {guardLabel ? ` 本次${guardLabel}。` : ''}
        </div>
      )}

      {options.notes.length > 0 ? (
        <ul className="st-hint" style={{ margin: 0, paddingLeft: 16 }} data-testid="generate-settings-notes">
          {options.notes.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export default StudioGenerateSettings
