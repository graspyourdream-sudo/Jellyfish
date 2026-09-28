/**
 * 工作台的资产卡片网格（参考项目 `.results` 的 `repeat(auto-fill, minmax(260px, 1fr))` 密度）。
 *
 * 口径（用户点名，来源是原项目那套已验证的信息层级）：
 *   - **同一项资产只出现一次**：卡片就是这一项资产在这一屏里的唯一落点；
 *   - 卡片正面的信息只有用户看得懂的：名称 + 业务资料摘要 + 出场分镜 + 当前图片 + 状态词；
 *   - 状态文案只给用户语言（`status.label`），内部状态 / 模型 / 编号一律不上卡片；
 *   - 动作：编辑资料 / 修改提示词 / 单项生成或重新生成；
 *     提示词需要重新生成时，正面标出来并给单项入口（**点了才会调用，不自动调用**）。
 */

import { Button, Checkbox, Empty, Tag, Tooltip } from 'antd'
import { PictureOutlined } from '@ant-design/icons'

import {
  WORKBENCH_PROMPT_REGENERATION_MAIN_TEXT,
  WORKBENCH_STATUS_TONE,
  WORKBENCH_TAB_LABEL,
  WORKBENCH_VOICE_BOUND_IN_DETAIL,
  cardActionAvailability,
  deriveCardAction,
  describeWorkbenchMissingItems,
  needsPromptRegeneration,
  workbenchItemKey,
  workbenchItemName,
  workbenchItemType,
  workbenchMissingItems,
  workbenchStatusKey,
  workbenchStatusLabel,
  workbenchStatusNotice,
} from './workbenchState.ts'
import type { AssetWorkbenchItem } from './assetWorkbenchContract.ts'

const TONE_COLOR: Record<string, string | undefined> = {
  default: undefined,
  blue: 'blue',
  green: 'green',
  red: 'red',
  gold: 'gold',
  purple: 'purple',
}

export type AssetCardGridProps = {
  items: AssetWorkbenchItem[]
  selectedKeys: string[]
  /** 本轮正在提交 / 生成：卡片上的单项按钮跟着禁用 */
  busy: boolean
  onToggleSelect: (key: string, checked: boolean) => void
  /** 打开详情抽屉（点名称、点分镜、点「详情」都走它） */
  onOpenDetail: (item: AssetWorkbenchItem, focus?: { shotIndex?: number }) => void
  onEditPrompt: (item: AssetWorkbenchItem) => void
  onGenerateOne: (item: AssetWorkbenchItem, operation: 'generate' | 'regenerate') => void
  /**
   * 打开既有资产编辑页（工作台注入）。
   *
   * 商品的图**不参与自动出图**：它在这一屏的主操作是「上传商品图 / 设为定版」，
   * 落到商品资产编辑页（复用实体 CRUD 的上传与 `is_primary`），所以卡片上给的是这个入口。
   */
  onOpenAssetEditor?: (item: AssetWorkbenchItem) => void
}

export function AssetCardGrid(props: AssetCardGridProps) {
  const {
    items,
    selectedKeys,
    busy,
    onToggleSelect,
    onOpenDetail,
    onEditPrompt,
    onGenerateOne,
    onOpenAssetEditor,
  } = props
  const selected = new Set(selectedKeys)

  if (items.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="这一类还没有资产：先点上面的「分析本章资产」，确认后再回到这里生产图片"
      />
    )
  }

  return (
    <div
      className="grid gap-3"
      /* 设计包 §8：`auto-fill, minmax(236px, 1fr)` + gap 12 → 1440 下每行 4 张。
         1280 时列数随宽度自然减少，不做横向滚动。 */
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(236px, 1fr))' }}
      data-testid="asset-card-grid"
    >
      {items.map((item) => {
        const key = workbenchItemKey(item)
        const bucket = workbenchItemType(item)
        /* 未登记的类型（`other`）不冒充某一类资产：卡片照旧显示，但类型名与动作都按"不认识"处理
           （类型名用的是桶自己的标签，出图动作在 `cardActionAvailability` 里按桶判定）。 */
        const statusKey = workbenchStatusKey(item)
        const label = workbenchStatusLabel(item)
        const requiresNewPrompt = needsPromptRegeneration(item)
        /* 卡面**唯一**主要操作及其可用性（设计包 §8）：状态 → 动作的映射与禁用理由
           都在 workbenchState 的纯函数里（有单测），卡面只负责渲染那一个按钮。 */
        const cardAction = deriveCardAction(item)
        const availability = cardActionAvailability(item, {
          busy,
          canOpenAssetEditor: Boolean(onOpenAssetEditor),
        })
        /* 缺失项：只列真的缺的（拿不到 ≠ 缺失），齐全时写「无」（设计包 §8） */
        const missingKinds = workbenchMissingItems(item)
        const missingText = describeWorkbenchMissingItems(item)
        const thumbnail = String(item.image?.thumbnail ?? '')
        const shotRefs = item.script_relation?.shot_refs ?? []
        /* 审计 §4.5 模式 6（`:158`）：改前这里把 `item.status?.reason` 原文渲在卡片正面
           （原文来自 `assetWorkbenchContract.ts:249-250` 的 `toText(raw.reason)`，未掩码）。
           现在卡片正面只放**按业务状态键映射出的中文结论**；后端原文不在这里渲染 ——
           它的落点是「资产详情」抽屉里默认收起的「技术详情」（`AssetDetailDrawer`）。 */
        const statusNotice = workbenchStatusNotice(item)
        /** 卡面那个唯一动作按 kind 分派（进度 / 结果 / 补充资料都在详情抽屉里） */
        const runCardAction = (target: AssetWorkbenchItem) => {
          switch (cardAction.kind) {
            case 'generate':
              onGenerateOne(target, 'generate')
              return
            case 'regenerate':
              onGenerateOne(target, 'regenerate')
              return
            case 'generate_prompt':
              onEditPrompt(target)
              return
            case 'upload_product_image':
              onOpenAssetEditor?.(target)
              return
            case 'view_progress':
            case 'view_result':
            case 'supplement_profile':
            default:
              // 完整结构化资料 / 剧本依据 / 提示词全文 / 历史结果一律进详情抽屉（设计包 §8）
              onOpenDetail(target)
          }
        }
        return (
          <article
            key={key}
            data-testid="asset-card"
            data-asset-key={key}
            data-asset-name={workbenchItemName(item)}
            className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white"
          >
            <div className="flex items-start justify-between gap-2 border-b border-slate-100 px-3 py-2">
              <div className="flex min-w-0 items-start gap-2">
                <Checkbox
                  checked={selected.has(key)}
                  onChange={(event) => onToggleSelect(key, event.target.checked)}
                  aria-label={`选择 ${workbenchItemName(item)}`}
                />
                {/*
                  名称 + 类型整块**就是抽屉入口**（设计包 §8）：悬停变色，右侧标「完整资料」。
                  卡面上因此不再放单独的「详情 / 编辑资料 / 编辑提示词」按钮 ——
                  完整结构化资料、剧本依据、提示词全文、历史结果都在抽屉里。
                */}
                <div className="group min-w-0">
                  <button
                    type="button"
                    className="flex max-w-full items-center gap-1 rounded px-0.5 text-left hover:bg-blue-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500"
                    title={`${workbenchItemName(item)} · 打开完整资料`}
                    data-testid="asset-card-detail-entry"
                    onClick={() => onOpenDetail(item)}
                  >
                    <span className="max-w-full truncate text-sm font-medium text-slate-900 group-hover:text-blue-600">
                      {workbenchItemName(item)}
                    </span>
                    <span className="shrink-0 text-[10px] text-gray-400 group-hover:text-blue-600">完整资料</span>
                  </button>
                  <div className="text-[11px] text-gray-400">{WORKBENCH_TAB_LABEL[bucket]}</div>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <Tag bordered={false} color={TONE_COLOR[WORKBENCH_STATUS_TONE[statusKey]]}>
                  {label}
                </Tag>
                {/*
                  只写「已定版」会误导：定版图是公网长期资产、还是只在本机，是另一件事。
                  真实演练里那张定版图只存在本机 —— 后续出视频的下游根本取不到它。
                  结论由后端（`asset-workbench` 契约）给，这里只如实展示，前端不猜。
                */}
                {statusKey === 'primary' && item.image?.primary_usable_for_generation !== true ? (
                  <Tooltip
                    title={
                      String(item.image?.primary_reachability_note ?? '') ||
                      '这张定版图不是公网长期地址，不能用于后续生成：出视频等下游环节取不到它。'
                    }
                  >
                    <Tag color="orange" bordered={false} className="mr-0">
                      仅本机 · 不能用于后续生成
                    </Tag>
                  </Tooltip>
                ) : null}
              </div>
            </div>

            {/* 缩略区：16/9、最高 150（设计包 §8 只在本页收紧，换取同屏一行完整卡片） */}
            <div
              className="grid w-full place-items-center overflow-hidden bg-slate-100 text-gray-400"
              style={{ aspectRatio: '16 / 9', maxHeight: 150 }}
            >
              {thumbnail ? (
                <img src={thumbnail} alt={workbenchItemName(item)} className="h-full w-full object-cover" />
              ) : (
                <span className="flex items-center gap-1 text-[11px]">
                  <PictureOutlined />
                  还没有图片
                </span>
              )}
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-1 px-3 py-2">
              {/* 关键资料摘要：**最多两行后截断**（设计包 §8），全文在详情抽屉里 */}
              <div className="line-clamp-2 text-[12px] leading-5 text-slate-700" title={item.profile_digest}>
                {item.profile_digest || '这一章还没有它的资料摘要'}
              </div>
              {/* 缺失项：只列真的缺的；齐全时写「无」（设计包 §8） */}
              <div className="flex flex-wrap items-center gap-1 text-[11px]">
                <span className="text-gray-400">缺失项</span>
                {missingKinds.length > 0 ? (
                  <span className="text-amber-700" data-testid="asset-card-missing">
                    {missingText}
                    {/* 角色声音只能在人物资产详情里绑定：把下一步动作写在这一行上 */}
                    {missingKinds.includes('voice') ? WORKBENCH_VOICE_BOUND_IN_DETAIL : ''}
                  </span>
                ) : (
                  <span className="text-gray-500" data-testid="asset-card-missing">
                    无
                  </span>
                )}
              </div>
              {shotRefs.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-[11px] text-gray-400">出场分镜</span>
                  {shotRefs.slice(0, 6).map((shot) => (
                    <Tag
                      key={`${key}-shot-${shot.shot_index}`}
                      bordered={false}
                      className="cursor-pointer"
                      onClick={() => onOpenDetail(item, { shotIndex: shot.shot_index })}
                    >
                      {`第 ${shot.shot_index} 镜`}
                    </Tag>
                  ))}
                  {shotRefs.length > 6 ? <span className="text-[11px] text-gray-400">{`等 ${shotRefs.length} 个`}</span> : null}
                </div>
              ) : null}
              {statusNotice ? <div className="text-[11px] text-red-500">{statusNotice}</div> : null}
              {requiresNewPrompt ? (
                <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-700">
                  <div>{WORKBENCH_PROMPT_REGENERATION_MAIN_TEXT}</div>
                </div>
              ) : null}
            </div>

            {/*
              操作行：**唯一**一个主要操作（设计包 §8）。
              「编辑资料」「修改提示词」不再平铺在卡面上 —— 它们在详情抽屉里
              （名称 + 类型整块就是抽屉入口，见上面），能力没有减少，只是不再抢卡面的位置。
            */}
            <div className="flex items-center gap-1 border-t border-slate-100 px-2 py-2">
              <Button
                size="small"
                type="primary"
                ghost={cardAction.kind !== 'generate' && cardAction.kind !== 'regenerate'}
                disabled={availability.disabled}
                data-testid="asset-card-action"
                data-action-kind={cardAction.kind}
                onClick={() => runCardAction(item)}
              >
                {cardAction.label}
              </Button>
              {availability.disabled && availability.reason ? (
                <Tooltip title={availability.reason}>
                  <span className="truncate text-[11px] text-gray-400" data-testid="asset-card-action-reason">
                    {availability.reason}
                  </span>
                </Tooltip>
              ) : null}
            </div>
          </article>
        )
      })}
    </div>
  )
}

export default AssetCardGrid
