/**
 * 资产详情抽屉：**只讲这一项资产的事**。
 *
 * 内容顺序（参考项目 `detailModal` 的信息层级，按 Jellyfish 的数据口径重排）：
 *   ① 规范化资产资料（按类型的中文标签）；② 相关剧本片段；
 *   ③ 出场分镜（点某镜看那一段原文）；④ 本次图片提示词；⑤ 用户补充。
 *
 * 用户点名：内部字段名 / 编号 / 资料行 ID 不上主界面；这里只显示中文标签与内容。
 */

import type { ReactNode } from 'react'
import { Button, Descriptions, Divider, Drawer, Empty, Space, Tag, Typography } from 'antd'

import { profileFieldLabel, workbenchItemName, workbenchItemType, workbenchStatusLabel, WORKBENCH_TAB_LABEL } from './workbenchState.ts'
import type { AssetWorkbenchItem } from './assetWorkbenchContract.ts'

export type AssetDetailDrawerProps = {
  open: boolean
  item: AssetWorkbenchItem | null
  /** 从卡片上的某个分镜点进来：抽屉打开后高亮这一镜 */
  focusShotIndex?: number | null
  onClose: () => void
  onEditPrompt: (item: AssetWorkbenchItem) => void
  renderProfileEditor: (item: AssetWorkbenchItem) => ReactNode
}

/** 资料区块：优先显示人工改过的（用户最关心自己填的那部分）。 */
function profileRows(item: AssetWorkbenchItem): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = []
  const push = (source: Record<string, string>, suffix: string) => {
    Object.keys(source).forEach((key) => {
      const value = String(source[key] ?? '').trim()
      if (!value) return
      rows.push({ label: `${profileFieldLabel(key)}${suffix}`, value })
    })
  }
  push(item.manual_overrides ?? {}, '（人工填写）')
  push(item.profile_fields ?? {}, '')
  return rows
}

export function AssetDetailDrawer(props: AssetDetailDrawerProps) {
  const { open, item, focusShotIndex, onClose, onEditPrompt, renderProfileEditor } = props
  const rows = item ? profileRows(item) : []
  const shotRefs = item?.script_relation?.shot_refs ?? []
  const evidence = item?.script_relation?.evidence ?? []
  const promptText = String(item?.prompt?.text ?? '').trim()

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={560}
      title={item ? `${workbenchItemName(item)} · ${WORKBENCH_TAB_LABEL[workbenchItemType(item)]}` : '资产详情'}
      data-testid="asset-detail-drawer"
    >
      {!item ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有选中资产" />
      ) : (
        <div className="space-y-4">
          <Space size={8} wrap>
            <Tag bordered={false}>{workbenchStatusLabel(item)}</Tag>
            {item.status?.reason ? <span className="text-[11px] text-red-500">{item.status.reason}</span> : null}
          </Space>

          <section>
            <div className="mb-1 text-xs font-medium text-slate-700">资产资料</div>
            {rows.length > 0 ? (
              <Descriptions size="small" column={1} bordered>
                {rows.map((row) => (
                  <Descriptions.Item key={`${row.label}-${row.value}`} label={row.label}>
                    <span className="text-[12px]">{row.value}</span>
                  </Descriptions.Item>
                ))}
              </Descriptions>
            ) : (
              <Typography.Text type="secondary" className="text-[11px]">
                这一章还没有它的资料：可以点下面的「编辑资料」手工补，或重新分析本章资产。
              </Typography.Text>
            )}
            <div className="mt-2">{renderProfileEditor(item)}</div>
          </section>

          <section>
            <div className="mb-1 text-xs font-medium text-slate-700">相关剧本片段</div>
            {item.script_relation?.plot_identity ? (
              <div className="mb-1 text-[12px] text-slate-700">{item.script_relation.plot_identity}</div>
            ) : null}
            {evidence.length > 0 ? (
              <ul className="list-disc space-y-1 pl-5 text-[12px] leading-5 text-slate-600">
                {evidence.map((row, index) => (
                  <li key={`${index}-${row.snippet}`}>
                    {row.snippet}
                    {row.grounded ? null : <span className="ml-1 text-[11px] text-amber-600">（剧本里没找到对应原文）</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <Typography.Text type="secondary" className="text-[11px]">还没有找到与它直接相关的剧本原文。</Typography.Text>
            )}
          </section>

          <section>
            <div className="mb-1 text-xs font-medium text-slate-700">{`出场分镜（${shotRefs.length}）`}</div>
            {shotRefs.length > 0 ? (
              <div className="space-y-2">
                {shotRefs.map((shot) => (
                  <div
                    key={`shot-${shot.shot_index}`}
                    className={`rounded border px-2 py-1 ${
                      focusShotIndex === shot.shot_index ? 'border-blue-300 bg-blue-50' : 'border-slate-200'
                    }`}
                  >
                    <div className="text-[12px] font-medium text-slate-700">{`第 ${shot.shot_index} 镜 · ${shot.title || '未命名'}`}</div>
                    {shot.script_excerpt ? (
                      <div className="whitespace-pre-wrap text-[11px] leading-5 text-slate-600">{shot.script_excerpt}</div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <Typography.Text type="secondary" className="text-[11px]">本章还没有它的出场分镜。</Typography.Text>
            )}
          </section>

          <section>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-700">本次图片提示词</span>
              <Button size="small" onClick={() => onEditPrompt(item)}>
                {item.prompt?.quality?.needs_regeneration ? '重新生成提示词' : '修改提示词'}
              </Button>
            </div>
            {item.prompt?.quality?.needs_regeneration ? (
              <div className="mb-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-700">
                {`提示词需要重新生成：${(item.prompt.quality.reasons ?? []).filter(Boolean).join('；') || '这条提示词不足以出图'}`}
              </div>
            ) : null}
            <div className="whitespace-pre-wrap rounded bg-slate-50 px-2 py-2 text-[12px] leading-5 text-slate-700">
              {promptText || '还没有保存过提示词'}
            </div>
          </section>

          <section>
            <div className="mb-1 text-xs font-medium text-slate-700">用户补充</div>
            {(item.user_notes ?? []).length > 0 ? (
              <ul className="list-disc space-y-1 pl-5 text-[12px] text-slate-600">
                {(item.user_notes ?? []).map((note, index) => (
                  <li key={`${index}-${note}`}>{note}</li>
                ))}
              </ul>
            ) : (
              <Typography.Text type="secondary" className="text-[11px]">还没有补充内容。</Typography.Text>
            )}
          </section>

          <Divider className="!my-2" />
          <Typography.Text type="secondary" className="text-[11px]">
            这里的资料来自本章剧本与你的补充；重新分析不会覆盖你手工填过的内容。
          </Typography.Text>
        </div>
      )}
    </Drawer>
  )
}

export default AssetDetailDrawer
