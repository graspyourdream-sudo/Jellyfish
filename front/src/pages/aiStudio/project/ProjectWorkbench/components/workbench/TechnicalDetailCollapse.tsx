/**
 * 工作台的「技术详情」：**默认收起**，而且是内部信息**唯一**允许出现的地方。
 *
 * 用户点名：候选多少条、聚合多少组、检查中、槽位、项目内资产 / 全局资产、
 * 提示词质量未知、最终提示词及差异、生成依据的内部计数与字段名、每项调用哪个接口、
 * 模型 / 供应商 / 任务号 / 内部状态 / `file_id` —— 全部只在这里出现。
 *
 * 主界面组件源码的禁词测试会把这一条钉住：除本文件外，工作台其它组件里
 * 出现上述任何一个词都会直接失败（见 `workbenchState.test.ts`）。
 * 所以本文件是全目录唯一豁免文件，改动时**不要**把这里的内部字段名搬出去。
 */

import type { ReactNode } from 'react'
import { Button, Collapse, Descriptions, Space, Tag, Typography } from 'antd'

import {
  assembleTechnicalView,
  type TechnicalView,
  type TechnicalViewInput,
} from './technicalView.ts'

export type TechnicalDetailCollapseProps = {
  input: TechnicalViewInput
  /** 由工作台注入的既有「生成配置原始状态」条（模型 / 演练开关原文） */
  gateBanner?: ReactNode
  /** 保留入口：改版前的提取确认页（写入前逐条人工确认） */
  onOpenLegacyExtractConfirm?: () => void
}

function renderLines(lines: string[]): ReactNode {
  if (lines.length === 0) return <span className="text-[11px] text-gray-400">（后端没有给出内容）</span>
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-[11px] leading-5 text-gray-500">
      {lines.map((line, index) => (
        <li key={`${index}-${line}`}>{line}</li>
      ))}
    </ul>
  )
}

export function TechnicalDetailCollapse(props: TechnicalDetailCollapseProps) {
  const { input, gateBanner, onOpenLegacyExtractConfirm } = props
  const view: TechnicalView = assembleTechnicalView(input)
  return (
    <details className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2" data-testid="technical-detail">
      <summary className="cursor-pointer text-[11px] text-gray-500">
        技术详情（默认收起）
      </summary>
      <div className="mt-2 space-y-3">
        {/* 默认收起：内部维度清单放在这里，不放在收起时可见的标题上 */}
        <div className="text-[11px] text-slate-500">
          接口名、候选条数、聚合组、匹配诊断、字段名、模型 / 供应商 / 任务号 / 文件编号
        </div>
        {gateBanner}

        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="接口名">{view.endpoint}</Descriptions.Item>
          <Descriptions.Item label="数据来源">{view.sourceLabel}</Descriptions.Item>
          <Descriptions.Item label="读取失败原因">
            {view.loadError || '（没有失败）'}
          </Descriptions.Item>
          <Descriptions.Item label="候选条数 / 聚合组">
            {`${view.candidatesTotal} 条 / ${view.candidateGroups} 组`}
          </Descriptions.Item>
          <Descriptions.Item label="每类候选的关联状态">
            {view.candidateStatusLines.length > 0 ? renderLines(view.candidateStatusLines) : '（后端没有给出内容）'}
          </Descriptions.Item>
          <Descriptions.Item label="匹配诊断">
            {view.matchDiagnostics.length > 0 ? renderLines(view.matchDiagnostics) : '（后端没有给出内容）'}
          </Descriptions.Item>
          <Descriptions.Item label="后端备注">
            {view.notes.length > 0 ? renderLines(view.notes) : '（后端没有给出内容）'}
          </Descriptions.Item>
          <Descriptions.Item label="本次用到的模型 / 供应商">
            {view.modelLines.length > 0 ? renderLines(view.modelLines) : '见上面的生成配置原始状态'}
          </Descriptions.Item>
          <Descriptions.Item label="每项资产的槽位与字段名">{renderLines(view.slotLines)}</Descriptions.Item>
          <Descriptions.Item label="任务号 / 文件编号">
            每一项的原始编号在结果卡片「查看详情」里；这里不重复列，避免一屏几百个编号。
          </Descriptions.Item>
        </Descriptions>

        <Collapse
          ghost
          size="small"
          items={[
            {
              key: 'per-asset',
              label: <span className="text-[11px] text-gray-500">{`每项资产本次用的槽位与提示词质量判定（${view.assetLines.length} 项）`}</span>,
              children: (
                <div className="space-y-1">
                  {view.assetLines.length > 0 ? (
                    view.assetLines.map((row) => (
                      <div key={row.key} className="text-[11px] leading-5">
                        <span className="font-medium text-slate-700">{row.name}</span>
                        <span className="text-gray-500">{`（${row.assetType}）`}</span>
                        <div className="text-gray-500">{`槽位 ${row.slot || '（未给出）'} · 质量判定 ${row.qualityVerdict || '（未给出）'} · 资料来自 ${row.profileSource || '（未给出）'}`}</div>
                        <div className="text-gray-400">{`字段名：${row.fieldNames.length > 0 ? row.fieldNames.join(', ') : '（无）'}`}</div>
                      </div>
                    ))
                  ) : (
                    <span className="text-[11px] text-gray-400">（后端没有给出内容）</span>
                  )}
                </div>
              ),
            },
          ]}
        />

        <Space size={6} wrap>
          <Tag bordered={false}>{`asset_id / file_id / service_task_id 一律只在技术详情与结果详情里出现`}</Tag>
          {onOpenLegacyExtractConfirm ? (
            <Button size="small" onClick={onOpenLegacyExtractConfirm} data-testid="open-legacy-extract">
              打开改版前的提取确认页（写入前逐条人工确认）
            </Button>
          ) : null}
        </Space>

        <Typography.Text type="secondary" className="text-[11px]">
          这一块默认收起：日常操作（选资产 → 生成 → 看进度 → 采纳 → 定版）不需要看它。
        </Typography.Text>
      </div>
    </details>
  )
}

export default TechnicalDetailCollapse
