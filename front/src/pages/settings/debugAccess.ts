/**
 * 「开发调试」页签的可见性与准入（纯逻辑，可单测）。
 *
 * ## 产品口径（本轮最终收口）
 *
 * 左侧 8 个平级入口收敛为 5 个，`模型管理` / `系统设置` / `LLM 调试台（开发）` 合并成
 * 一个一级入口「设置」，页面内分三个区域（模型与服务 / 系统设置 / 开发调试）。
 *
 * 「开发调试」是**排查工具**，不是生产能力，因此：
 *
 * | 场景 | 是否显示 / 是否可进 |
 * |---|---|
 * | 开发模式（`vite dev`，`import.meta.env.DEV === true`）**且**用户是管理员 | 显示，可进 |
 * | 生产构建 + 显式调试开关开启 **且**用户是管理员 | 显示，可进 |
 * | 普通用户（任何环境） | **不显示**；直达旧路由时安全跳到设置默认页签 |
 * | 生产构建且调试开关未开 | **不显示**（连管理员也看不到） |
 *
 * 两道门是**与**的关系：环境门（开发模式 或 显式开关）**且**权限门（管理员）。
 * 写成"或"会让开发模式下的访客也看见调试页签，与「普通用户不得显示」直接冲突。
 *
 * 「显式调试开关」是构建期环境变量 `VITE_ENABLE_DEBUG_TOOLS`：只有把它显式设成
 * `true` / `1` / `yes` 才算开启，**未设置、空串、其它值一律视为关闭**
 * （防止「随便写点什么就开了」）。
 *
 * ## 为什么权限判定也要独立成函数
 *
 * 「管理员」的判据是 store 里的**稳定角色码**（`admin`），不是显示名 —— 切一次语言
 * 显示名就变了（审计 §4.7-R24 第 3 条的先例）。因此这里只认码，不认翻译结果。
 */

/** 能进入「开发调试」的角色码（唯一管理员码）。 */
export const DEBUG_TOOLS_ADMIN_ROLE = 'admin'

/**
 * 显式调试开关的取值解析。
 *
 * 只有 `'true'` / `'1'` / `'yes'`（忽略大小写与首尾空白）算开启；其余一律关闭。
 */
export function parseExplicitDebugFlag(raw: unknown): boolean {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase()
  return value === 'true' || value === '1' || value === 'yes'
}

/**
 * 当前构建是不是**开发模式**。
 *
 * 读的是 Vite 注入的 `import.meta.env.DEV`：生产构建里它恒为 `false`，
 * 所以「普通生产环境不得显示开发调试」这一条由构建机制本身保证，
 * 不是靠运行时判断（运行时判断在生产里同样容易被改）。
 *
 * 为了让纯函数可单测，这里显式取参；浏览器侧由 `debugAccessFromEnv()` 传真实环境值。
 */
export function resolveDevModeFromEnv(env: Record<string, unknown> | undefined): boolean {
  return env?.DEV === true
}

export type DebugAccessInput = {
  /** 是否开发模式（`import.meta.env.DEV`） */
  devMode: boolean
  /** 显式调试开关的值（`import.meta.env.VITE_ENABLE_DEBUG_TOOLS`） */
  explicitDebugFlag: unknown
  /** 当前用户的稳定角色码（`admin` / `operator` / `guest`） */
  role: string | null | undefined
}

export type DebugAccessDecision = {
  /** 是否显示「开发调试」页签 */
  visible: boolean
  /** 是否允许访问 `/settings?tab=debug` 与旧 `/llm-pipeline` */
  allowed: boolean
  /** 不允许时给用户看的中文原因（空串 = 允许） */
  reason: string
}

/**
 * 「开发调试」的准入判定（**唯一实现**）。
 *
 * 页签可见性与路由准入用**同一份**结论：否则会出现「页签看不见、直达路由却能渲染」
 * 这种自相矛盾的状态。
 */
export function resolveDebugAccess(input: DebugAccessInput): DebugAccessDecision {
  const isAdmin = String(input.role ?? '').trim() === DEBUG_TOOLS_ADMIN_ROLE
  /**
   * 两道门**同时**要过（这是把任务书 §五 的两句话读通之后的结果）：
   *
   *   - 「普通用户**和**普通生产环境不得显示开发调试页签」→ 权限门；
   *   - 「只允许在开发模式，或者显式调试开关开启且用户具有管理员权限时显示」→ 环境门。
   *
   * 如果按字面把它写成 `devMode || (flag && admin)`，那么开发模式下的**访客**也会
   * 看见调试页签 —— 与第一句直接冲突（实机验收就撞上了这条）。
   * 正确的合取是：**环境门（开发模式 或 显式开关）且 权限门（管理员）**。
   *
   * 生产构建两门都不满足：`DEV` 恒为 false，而 `VITE_ENABLE_DEBUG_TOOLS` 默认没有配置，
   * 所以普通生产环境**只有管理员显式开启调试开关**才可能看到它。
   */
  const environmentOpen = input.devMode || parseExplicitDebugFlag(input.explicitDebugFlag)
  if (environmentOpen && isAdmin) {
    return { visible: true, allowed: true, reason: '' }
  }
  return {
    visible: false,
    allowed: false,
    reason: '「开发调试」只对管理员开放，并且需要处在开发模式、或由管理员显式开启调试开关。',
  }
}

/** 浏览器侧取值：把 Vite 注入的环境变量交给上面的纯函数。 */
export function debugAccessFromEnv(role: string | null | undefined): DebugAccessDecision {
  return resolveDebugAccess({
    devMode: resolveDevModeFromEnv(import.meta.env as unknown as Record<string, unknown>),
    explicitDebugFlag: (import.meta.env as unknown as Record<string, unknown>).VITE_ENABLE_DEBUG_TOOLS,
    role,
  })
}

/* ------------------------------------------------------------------ 页签键 */

/** 设置页的三个区域（顺序即页面顺序）。 */
export const SETTINGS_TABS = ['models', 'system', 'debug'] as const
export type SettingsTabKey = (typeof SETTINGS_TABS)[number]

/** 设置页的默认区域：`/settings` 不写 `?tab=` 时落这里。 */
export const SETTINGS_DEFAULT_TAB: SettingsTabKey = 'models'

/**
 * 解析 `?tab=`。
 *
 * `debug` 必须同时通过准入判定才认；否则回落默认区域 —— 这就是
 * 「无权限用户直达调试路由会安全跳转」的判据来源（页面据此 `replace` 到默认页签）。
 */
export function resolveSettingsTab(raw: string | null | undefined, debug: DebugAccessDecision): SettingsTabKey {
  const value = String(raw ?? '').trim()
  if (value === 'debug') return debug.allowed ? 'debug' : SETTINGS_DEFAULT_TAB
  if (value === 'system') return 'system'
  if (value === 'models') return 'models'
  return SETTINGS_DEFAULT_TAB
}
