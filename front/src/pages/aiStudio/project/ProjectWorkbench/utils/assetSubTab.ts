/**
 * 第 2 步的**子页签词汇**（纯逻辑，可直接 `node --test`）。
 *
 * 为什么单独一个模块：这一份词汇有**两个消费方**，以前各写一份、于是对不上：
 *
 * 1. 工作台第 2 步主界面（`AssetWorkbench`）的页签；
 * 2. 资产编辑页往返用的 `?tab=` 参数（`?step=extract_assets&tab=products`）。
 *
 * 商品成为第五类资产后，`ASSET_SUB_TABS` 里**没有** `products`，
 * 于是 `isAssetSubTab('products')` 判假 → 参数被丢掉、回落到默认页签。
 * 后果是一条完整的用户路径断掉：第 2 步商品卡片 →「上传图片 / 设为定版」→
 * 商品资产编辑页 → 返回 → **落回"人物"页签**，用户看不到自己刚编辑的那件商品
 * （而 `returnTo` 里明明白白写着 `tab=products`）。它不报错，
 * 所以只能靠测试钉住 —— `assetSubTab.test.ts` 做往返与反向两侧。
 *
 * 与 `components/workbench/workbenchState.ts` 的 `WorkbenchAssetType` 是同一条取值域
 * （character/scene/prop/costume/product），这里只做**参数名 ↔ 类型名**的换算。
 */

import type { WorkbenchAssetType } from '../components/workbench/workbenchState.ts'

/**
 * `?tab=` 认得的全部取值（URL 词汇）。
 *
 * 比 `WorkbenchAssetType` 多了两个只属于"资产库"的页签：`actors`（演员，不属于项目资产类型）
 * 与 `roles`（人物在资产库里的页签名）。三个名字指同一件事时必须只在一处定义。
 */
export const ASSET_SUB_TABS = ['roles', 'scenes', 'props', 'costumes', 'actors', 'products'] as const

export type AssetSubTab = (typeof ASSET_SUB_TABS)[number]

export const ASSET_SUB_TAB_LABELS: Record<AssetSubTab, string> = {
  roles: '角色',
  scenes: '场景',
  props: '道具',
  costumes: '服装',
  actors: '演员',
  products: '商品',
}

/** 纯类型守卫：URL 里的任意字符串 → 子页签（不认识的返回 false，由调用方回落默认值）。 */
export function isAssetSubTab(value: string | null): value is AssetSubTab {
  return value !== null && (ASSET_SUB_TABS as readonly string[]).includes(value)
}

/**
 * 子页签 → 资产准备主界面（`AssetWorkbench`）的页签。
 *
 * `actors` **刻意没有对应项**：演员不是项目资产类型，工作台里没有它的页签。
 * 用 `Partial` 把这个事实写在类型上，调用方必须自己处理"没有对应页签"，
 * 而不是像以前那样把不认识的值默默当成人物。
 */
export const ASSET_SUB_TAB_TO_WORKBENCH_TAB: Partial<Record<AssetSubTab, WorkbenchAssetType>> = {
  roles: 'character',
  scenes: 'scene',
  props: 'prop',
  costumes: 'costume',
  products: 'product',
}

/** 主界面页签 → 子页签（写回 URL 用；与上面互为逆映射）。 */
export const WORKBENCH_TAB_TO_ASSET_SUB_TAB: Record<WorkbenchAssetType, AssetSubTab> = {
  character: 'roles',
  scene: 'scenes',
  prop: 'props',
  costume: 'costumes',
  product: 'products',
}

/**
 * 默认页签（URL 没给 / 给了不认得的值时用）。与工作台既有默认一致。
 */
export const DEFAULT_ASSET_SUB_TAB: AssetSubTab = 'roles'

/** 把 URL 参数解析成工作台页签；认不出来一律落在默认页签（与既有行为一致）。 */
export function assetSubTabToWorkbenchTab(tab: string | null): WorkbenchAssetType {
  return (isAssetSubTab(tab) ? ASSET_SUB_TAB_TO_WORKBENCH_TAB[tab] : undefined) ?? 'character'
}

/**
 * 旧「提取确认页」自己那排 Segmented 能渲染的子页签。
 *
 * 为什么与 `ASSET_SUB_TABS` 分开：那一页的底部是"关联已有资产 / 新建"的**逐类资产列表**，
 * 它只有角色/场景/道具/服装/演员五栏；商品没有这一栏
 * （商品的图由人工上传并手动定版，走主界面的商品卡片）。
 * 若把它也塞进 Segmented，就会出现一个**选了却什么都没有**的空选项 —— 那比不支持更糟。
 * 写不到的那一栏由 :func:`resolveLegacyPanelSubTab` 明确回落到角色。
 */
export const LEGACY_PANEL_ASSET_SUB_TABS = ['roles', 'scenes', 'props', 'costumes', 'actors'] as const

export type LegacyPanelAssetSubTab = (typeof LEGACY_PANEL_ASSET_SUB_TABS)[number]

/** 旧提取确认页能渲染的页签；传入商品时回落 `roles`（该页没有商品那一栏）。 */
export function resolveLegacyPanelSubTab(tab: AssetSubTab): LegacyPanelAssetSubTab {
  return (LEGACY_PANEL_ASSET_SUB_TABS as readonly string[]).includes(tab)
    ? (tab as LegacyPanelAssetSubTab)
    : 'roles'
}
