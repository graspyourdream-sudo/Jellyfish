/**
 * 产品品牌名的**单一来源出口**（用户可见名称 / 内部兼容代号）。
 *
 * ============================ 为什么要这个文件 ============================
 *
 * 本轮把用户可见产品名从 `Jellyfish` 改成「像素小新 / Pixel Xiaoxin」。改名**只**改
 * 品牌展示，内部兼容标识（存储键、环境变量、API 路径、数据库、幂等前缀）一律不动 ——
 * 完整口径与理由见仓库根 `docs/architecture/product-branding.md`。
 *
 * 品牌名有两个**渲染环境**，文件分工如下（不是两套相互独立的来源）：
 *
 * | 环境 | 出口 | 说明 |
 * |---|---|---|
 * | React / i18n 运行时 | `src/locales/{zh-CN,en-US}/layout.json` 的 `layout.title` | **主来源**：界面左上角名称、欢迎语、浏览器标签都取它 |
 * | 非 React / 非 i18n（首屏静态 HTML、工具脚本、守卫测试） | 本文件 | 镜像常量；与主来源**逐字相等由 `branding.test.ts` 锁定** |
 *
 * ⚠️ 两个来源不是「相互独立」：改品牌名时两边都要改，且 `branding.test.ts` 会把
 * 不一致直接判失败（防漂移）。**不要**再在组件里手写品牌名，一律走 `t('title')`
 * 或本文件的常量。
 *
 * ⚠️ `LEGACY_INTERNAL_CODENAME` **绝不允许渲染到普通用户主页面**：它只用于文档、
 * 守卫测试和内部兼容说明（`branding.test.ts` 有一条断言专门守这一点）。
 */

/**
 * 中文用户可见产品名称。
 *
 * 必须与 `src/locales/zh-CN/layout.json` 的 `layout.title` 逐字相同（守卫测试锁定）。
 */
export const PRODUCT_NAME_ZH = '像素小新'

/**
 * 英文用户可见产品名称。
 *
 * 必须与 `src/locales/en-US/layout.json` 的 `layout.title` 逐字相同（守卫测试锁定）。
 */
export const PRODUCT_NAME_EN = 'Pixel Xiaoxin'

/**
 * 中文产品说明（副标题）。产品名改了，说明可以继续用「AI 短剧工作台」。
 *
 * 必须与 `src/locales/zh-CN/layout.json` 的 `layout.subtitle` 逐字相同（守卫测试锁定）。
 */
export const PRODUCT_TAGLINE_ZH = 'AI 短剧工作台'

/**
 * 英文产品说明（副标题）。
 *
 * 必须与 `src/locales/en-US/layout.json` 的 `layout.subtitle` 逐字相同（守卫测试锁定）。
 */
export const PRODUCT_TAGLINE_EN = 'AI Short-form Studio'

/**
 * 历史内部代号（**内部兼容用，不是用户可见品牌名**）。
 *
 * 名称关系是「像素小新（原内部代号 Jellyfish）」：仓库目录、包名、环境变量
 * （`JELLYFISH_*`）、localStorage / 事件键（`jellyfish_*`）、幂等前缀（`jellyfish:`）、
 * API 路径与数据库都继续使用它，改名不动这些标识，否则会丢用户设置、让旧任务无法识别。
 *
 * 若将来真要迁移内部代号，**必须**作为独立迁移项目处理（带兼容层 + 数据迁移），
 * 不允许因为「看到内部还有 jellyfish」就顺手全仓替换。
 */
export const LEGACY_INTERNAL_CODENAME = 'Jellyfish'

/** 品牌口径文档路径（相对仓库根），由守卫测试断言其存在。 */
export const PRODUCT_BRANDING_DOC_PATH = 'docs/architecture/product-branding.md'

/**
 * 按语言给用户可见品牌名（供非 i18n 环境使用）。
 *
 * i18n 运行时**不要**用它 —— 那里一律 `t('title')`，让语言切换自然生效。
 */
export function productNameByLanguage(language: 'zh-CN' | 'en-US'): string {
  return language === 'en-US' ? PRODUCT_NAME_EN : PRODUCT_NAME_ZH
}
