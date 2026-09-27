/**
 * 全仓**唯一**的「后端枚举原值 → 中文业务说法」映射表（阶段 B ①共享基建）。
 *
 * 为什么必须有这一份：审计文档 `site/content/docs/plans/frontend-leak-audit-2026-09-26.md`
 * 的结论是「泄漏的根因不是把后端值写死在文案里，而是在渲染点把后端值直接渲出来」
 * （§5.6）。所以修法必须落在**映射层**：一处定义、全仓引用。
 * **禁止各页各写一份** —— 各写一份就会出现同一个 `partial_failed` 在三个页面三种说法，
 * 而且新增枚举时必然漏掉某一个页面（审计 §3.5「四张禁词表互不同步」就是这么来的）。
 *
 * 三条硬口径（审计 §2.1 三层信息模型 + §6 三个边界项）：
 *   1. **枚举原值绝不允许出现在主区**（含折叠区在收起态可见的标题）；
 *      原值只允许出现在默认收起的「技术详情」里。
 *   2. **未登记原值一律给中文兜底**（`unknown`），**绝不回显原值** ——
 *      这是本文件与旧散落映射表最大的区别：旧写法普遍是 `MAP[key] ?? key`，
 *      一旦后端新增一个枚举值，用户就会看到英文。
 *   3. 同一份 `values` 同时充当**禁词扫描的词源**（`ENUM_RAW_VALUES`）：
 *      新增枚举会自动被各页的「主区禁词扫描」测试纳入，不需要再去改测试词表。
 *
 * 本模块是**纯函数 + 纯数据**，不 import React / 网络模块，
 * 所以 `node --test` 能直接加载（与 `assetProduction.ts` 同一约定）。
 */

/** 一个枚举类：原值全集 + 中文映射 + 未登记时的中文兜底。 */
export type EnumSpec = {
  /**
   * 后端契约里的枚举原值全集。
   *
   * 双职责：① 声明本表覆盖了哪些原值；② 作为禁词扫描的词源
   * （`ENUM_RAW_VALUES`），保证「映射表」与「测试词表」同源。
   */
  readonly values: readonly string[]
  /** 原值 → 主区中文口径。键必须与 `values` 一一对应。 */
  readonly labels: Readonly<Record<string, string>>
  /**
   * 未登记原值时返回的中文兜底。
   *
   * **绝不允许写成原值** —— 这是「未知值不原样返回英文」这条测试的落点。
   */
  readonly unknown: string
  /** 这个枚举类叫什么（用于测试报错信息，便于定位是哪个表漏了值）。 */
  readonly name: string
}

function enumSpec(name: string, values: readonly string[], labels: Record<string, string>, unknown: string): EnumSpec {
  return { name, values, labels, unknown }
}

/**
 * 标签表的**大小写无关索引**（每个 `labels` 对象只建一次）。
 *
 * 为什么需要它：本表的规矩是「`values` 与 `labels` 的键一一对应」，所以有的枚举类
 * 键是大写（`ECU` / `DOLLY_IN`），有的是小写（`partial_failed`）。而调用方的输入
 * 两种都会出现 —— 大模型出的分镜草稿常见小写（`ecu` / `dolly_in`）。
 * 只做 `labels[key.toLowerCase()]` 只能覆盖"小写表"，大写表会把 `ecu` 判成未登记。
 * 这里按**两张表都覆盖**的索引查，命中第一个登记的写法（同一枚举类里不会有两个
 * 仅大小写不同的原值 —— `enumLabels.test.ts` 的去重/覆盖用例会把这种键拦下来）。
 */
const LABEL_LOWER_INDEX = new WeakMap<object, Map<string, string>>()

function lowerLabelIndex(labels: Readonly<Record<string, string>>): Map<string, string> {
  let index = LABEL_LOWER_INDEX.get(labels)
  if (!index) {
    index = new Map<string, string>()
    Object.entries(labels).forEach(([key, label]) => {
      const lower = key.toLowerCase()
      if (!index!.has(lower)) index!.set(lower, label)
    })
    LABEL_LOWER_INDEX.set(labels, index)
  }
  return index
}

/**
 * 原值 → 中文业务说法。
 *
 * - 空值 / `null` / `undefined` → `unknown` 兜底；
 * - 未登记原值 → `unknown` 兜底（**不是原值**）；
 * - 大小写不敏感（后端有的枚举大写、有的小写，例如 `DIALOGUE` 与 `dialogue`；
 *   大模型草稿里的大小写混写同样认）。
 */
export function labelFor(spec: EnumSpec, raw: string | null | undefined): string {
  const key = String(raw ?? '').trim()
  if (!key) return spec.unknown
  return spec.labels[key] ?? lowerLabelIndex(spec.labels).get(key.toLowerCase()) ?? spec.unknown
}

/** 原值 → 中文；**识别不了返回 null**（调用方需要自己决定业务话术时用这个）。 */
export function lookupLabel(spec: EnumSpec, raw: string | null | undefined): string | null {
  const key = String(raw ?? '').trim()
  if (!key) return null
  return spec.labels[key] ?? lowerLabelIndex(spec.labels).get(key.toLowerCase()) ?? null
}

/**
 * 原值 → **规范写法**（`values` 里登记的那一个）；识别不了返回 `null`。
 *
 * 页面上的枚举下拉必须用它：把用户/模型给的 `ecu` 换成登记的 `ECU` 再作为 `value`，
 * 否则 antd 的 `Select` 在"当前值不在选项里"时会把**原样字符串**渲染出来 ——
 * 那就是"未登记原值上屏"（审计 §2.1 判定铁律）。下游拿到的也始终是规范写法。
 */
export function canonicalEnumValue(spec: EnumSpec, raw: string | null | undefined): string | null {
  const key = String(raw ?? '').trim()
  if (!key) return null
  const matched = spec.values.find((value) => value === key) ?? spec.values.find((value) => value.toLowerCase() === key.toLowerCase())
  return matched ?? null
}

/** 原值是否已登记（供「覆盖检查」类测试使用）。 */
export function isKnownValue(spec: EnumSpec, raw: string | null | undefined): boolean {
  return lookupLabel(spec, raw) !== null
}

/* ------------------------------------------------------------ 单条结果口径 */

/**
 * 单条出图 / 出视频结果的 `outcome`。
 *
 * 口径来源：审计 §6.3 + `assetResultSummary.ts` 的 `ASSET_OUTCOME_LABEL`
 * （中文口径的**唯一事实来源**，本表与它保持一致）。
 * `partial_failed` 的业务含义是「图生成了但没进长期存储，所以采纳不了」，
 * 主区应当说的是「成没成 / 能不能用」，而不是这个词本身。
 */
export const ASSET_OUTCOME = enumSpec(
  'assetOutcome',
  ['succeeded', 'partial_failed', 'failed', 'running', 'pending', 'ok', 'dry_run', 'unknown'],
  {
    succeeded: '成功',
    partial_failed: '部分失败',
    failed: '失败',
    running: '处理中',
    pending: '处理中',
    ok: '成功',
    dry_run: '演练占位',
    unknown: '状态未识别',
  },
  '状态未识别',
)

/** `partial_failed` 的**主区单条文案**（审计 §6.3 表「单条结果」一行，固定模板）。 */
export const ASSET_OUTCOME_PARTIAL_FAILED_MAIN_TEXT = '生成失败（图片没成功保存，暂时不能采纳）'

/** `partial_failed` 的**折叠依据层**文案（审计 §6.3 表「逐条明细」一行）。 */
export const ASSET_OUTCOME_PARTIAL_FAILED_DETAIL_TEXT =
  '图已生成，但没完成长期存储，所以暂时不可用；可稍后刷新或重新生成'

/**
 * 批量结果头部的**部分失败**口径（审计 §6.3 表「批量头部」，固定模板，不得各页自创）。
 *
 * 例：`partial_failed` 且成功 3 条共 5 条 → 「部分失败（成功 3/共 5）」。
 */
export function partialFailureHeadline(succeeded: number, total: number): string {
  return `部分失败（成功 ${Math.max(0, Math.trunc(succeeded))}/共 ${Math.max(0, Math.trunc(total))}）`
}

/* ------------------------------------------------------------ 任务 / 状态 */

/** 生成任务状态（`TaskCenter` 的 `TaskStatus`）。 */
export const TASK_STATUS = enumSpec(
  'taskStatus',
  ['pending', 'queued', 'running', 'streaming', 'succeeded', 'failed', 'cancelled', 'canceled'],
  {
    pending: '排队中',
    queued: '排队中',
    running: '生成中',
    streaming: '生成中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
    canceled: '已取消',
  },
  '状态未识别',
)

/**
 * 镜头生产状态（`ShotStatus` = `pending | generating | ready`）。
 *
 * 为什么不复用 `TASK_STATUS`：它的 `pending` 是「排队中」，而镜头这里是「待确认」——
 * **同一串原值在不同业务对象上语义不同**，借用会把两处口径搅在一起。
 *
 * 标签与分镜列表页筛选器上的中文**逐字一致**（「待确认 / 生成中 / 已就绪」）：
 * 同一份数据在全仓只允许一个名字（§9.1-19）。区域 6b 曾在本文件只读期间
 * 于 `shots/shotStudioCopy.ts` 放了一张同型临时表并登记「需追加」——现按登记收敛到本文件，
 * 那边改为 import（**枚举映射一处定义、全仓引用**，§7.1-4）。
 */
export const SHOT_STATUS = enumSpec(
  'shotStatus',
  ['pending', 'generating', 'ready'],
  {
    pending: '待确认',
    generating: '生成中',
    ready: '已就绪',
  },
  '状态待确认',
)

/** 资产类型（`asset_type` 原值）。 */
export const ASSET_TYPE = enumSpec(
  'assetType',
  ['character', 'scene', 'prop', 'costume', 'actor', 'product'],
  {
    character: '角色',
    scene: '场景',
    prop: '道具',
    costume: '服装',
    actor: '演员',
    product: '商品',
  },
  '其它资产',
)

/**
 * 帧类型 code（首帧 / 尾帧 / 关键帧）。
 *
 * 审计里把这一族称作「景别 code」（§4.3 模式 3）—— 运行时可见的原文是
 * 「要求的帧：`first`」。后端 `ShotFrameType` 只有 first / last / key 三个值，
 * 这里额外收 `keyframe` / `mid` 两个历史与方言写法，避免未登记时回显英文。
 */
export const FRAME_TYPE = enumSpec(
  'frameType',
  ['first', 'last', 'key', 'keyframe', 'mid', 'middle'],
  {
    first: '首帧',
    last: '尾帧',
    key: '关键帧',
    keyframe: '关键帧',
    mid: '中间帧',
    middle: '中间帧',
  },
  '参考帧',
)

/** 参考方式（后端 `REQUIRED_FRAMES_BY_MODE` 的键）。 */
export const REFERENCE_MODE = enumSpec(
  'referenceMode',
  ['text_only', 'first', 'last', 'key', 'first_last', 'first_last_key'],
  {
    text_only: '纯文本（不用参考帧）',
    first: '首帧',
    last: '尾帧',
    key: '关键帧',
    first_last: '首帧 + 尾帧',
    first_last_key: '首帧 + 尾帧 + 关键帧',
  },
  '未识别的参考方式',
)

/**
 * 视频准备度检查项 code（后端 `shot_video_readiness.py` 的 7 个 `_check` key）。
 *
 * 运行时泄漏形态是整排 `未通过 · extraction_ready`（审计 §5.1 R7）。
 * 口径：未登记项**隐藏整行**，而不是回显原值；这里的 `unknown` 只作为
 * 「万一真的要给一句话」时的中文兜底。
 */
export const VIDEO_READINESS_CHECK = enumSpec(
  'videoReadinessCheck',
  [
    'extraction_ready',
    'duration_ready',
    'prompt_ready',
    'reference_frames_ready',
    'video_model_ready',
    'provider_ready',
    'no_active_video_task',
  ],
  {
    extraction_ready: '已提取分镜',
    duration_ready: '时长已设置',
    prompt_ready: '提示词已就绪',
    reference_frames_ready: '参考帧齐全',
    video_model_ready: '视频模型已配置',
    provider_ready: '生成服务已就绪',
    no_active_video_task: '没有正在跑的生成',
  },
  '其它前置条件',
)

/** 生成条件（门禁）的状态。运行时泄漏形态是主区 Alert 直渲 `状态：ready`（审计 §4.4）。 */
export const GENERATION_GATE_STATE = enumSpec(
  'generationGateState',
  ['ready', 'dry_run', 'not_configured', 'unknown', 'missing_params', 'conflict', 'service_error', 'running', 'loading'],
  {
    ready: '已就绪',
    dry_run: '演练模式',
    not_configured: '未配置',
    unknown: '状态待确认',
    missing_params: '参数不完整',
    conflict: '业务冲突',
    service_error: '服务异常',
    running: '处理中',
    loading: '读取中',
  },
  '状态待确认',
)

/** 当前运行模式（真实 / 演练）。 */
export const REAL_RUN_MODE = enumSpec(
  'realRunMode',
  ['dry_run', 'real_unconfirmed', 'real', 'unknown'],
  {
    dry_run: '演练模式',
    real_unconfirmed: '真实模式（未确认）',
    real: '真实模式',
    unknown: '模式未知',
  },
  '模式未知',
)

/** 付费出口（真实调用会花钱的那几个通道）。 */
export const REAL_RUN_OUTLET = enumSpec(
  'realRunOutlet',
  ['llm', 'image', 'video', 'oss'],
  {
    llm: '大模型',
    image: '出图',
    video: '出视频',
    oss: '对象存储上传',
  },
  '其它出口',
)

/** 出站审计记录的动作 code。未登记时给「拦截记录」，不回显原值。 */
export const REAL_RUN_AUDIT_ACTION = enumSpec(
  'realRunAuditAction',
  ['blocked', 'blocked_unconfirmed', 'blocked_network', 'allowed_real', 'guard_installed'],
  {
    blocked: '被演练模式拦截',
    blocked_unconfirmed: '真实模式未确认，被拦截',
    blocked_network: '出站兜底拦截（非本机地址）',
    allowed_real: '已放行（真实调用）',
    guard_installed: '出站兜底已安装',
  },
  '拦截记录',
)

/* ------------------------------------------------ 提示词来源 / 画幅 / 模型 */

/** 视频提示词的来源（后端白名单 `jurilu` / `skill` / `llm` / `internal` 等）。 */
export const VIDEO_PROMPT_SOURCE = enumSpec(
  'videoPromptSource',
  ['jurilu', 'skill', 'llm', 'manual', 'manual_workspace', 'internal', 'shot_description'],
  {
    /* ⚠️ 全站唯一名字，不许再起别名（用户 2026-09-26 拍板）。
     *
     * `jurilu` 是**外部导入工具名**，不是模型供应商，也不是 6 类泄漏模式里的任何一类：
     * 它是本项目的业务流程名词（导航「提示词导入/交付」、抓取面板标题、审计 §4.5 的建议口径
     * 「来源：巨日禄导入」都在用它）。要隐藏的是**枚举原名 `jurilu`**，不是这个工具名。
     *
     * 历史上同一条文案出现过三种写法（本文件的「剧立方导入」、`ProjectStudioStepPanel` 的
     * 「巨量导入」、其余位置的「巨日禄导入」），同一屏里互相打架。
     * **别名漂移会导致用户以为自己在看不同的来源** —— `enumLabels.test.ts` 有一条守卫会扫全仓，
     * 再出现第二种写法即测试失败。 */
    jurilu: '巨日禄导入',
    skill: '技能生成',
    llm: '由大模型生成',
    manual: '人工编辑',
    manual_workspace: '人工编辑',
    internal: '人工编辑',
    shot_description: '按镜头描述生成',
  },
  '来源未记录',
)

/** 关键帧出图的提示词来源（后端 `frame-submit` 计划里的 `prompt_source`）。 */
export const FRAME_PROMPT_SOURCE = enumSpec(
  'framePromptSource',
  ['saved', 'request', 'empty'],
  {
    saved: '镜头已保存',
    request: '本次输入',
    empty: '还没有提示词（提交会被拒）',
  },
  '来源未记录',
)

/** 画幅（`target_ratio`）是从哪来的。原值只应出现在技术详情。 */
export const TARGET_RATIO_SOURCE = enumSpec(
  'targetRatioSource',
  ['shot', 'project', 'default'],
  {
    shot: '镜头覆盖',
    project: '项目设置',
    default: '系统默认',
  },
  '同项目默认画幅',
)

/** 出图帧模式。 */
export const FRAME_MODE = enumSpec(
  'frameMode',
  ['single_frame', 'first_last_frame'],
  {
    single_frame: '单帧',
    first_last_frame: '首尾帧',
  },
  '未识别的出图帧模式',
)

/** 模型类别（后端 `models.category`）。 */
export const MODEL_CATEGORY = enumSpec(
  'modelCategory',
  ['text', 'image', 'video', 'llm'],
  {
    text: '文本',
    image: '图片',
    video: '视频',
    llm: '文本',
  },
  '其它类型',
)

/** 模型配置状态（主区只说「能不能用」，原始状态值进技术详情）。 */
export const MODEL_STATE = enumSpec(
  'modelState',
  ['configured', 'missing', 'unknown', 'dry_run'],
  {
    configured: '已配置',
    missing: '未配置',
    unknown: '状态待确认',
    dry_run: '演练模式',
  },
  '状态待确认',
)

/** 生成服务（供应商）的配置状态。 */
export const PROVIDER_STATUS = enumSpec(
  'providerStatus',
  ['active', 'testing', 'disabled', 'configured', 'unknown'],
  {
    active: '可用',
    testing: '测试中',
    disabled: '已停用',
    configured: '已配置',
    unknown: '状态未识别',
  },
  '状态未识别',
)

/**
 * 提示词质量判定状态。
 *
 * ⚠️ 注意：`unknown` 的中文口径是「还没有检查这一条」而不是「提示词质量未知」——
 * 「提示词质量未知」是主区禁词（审计 §4.5 基准禁词命中条目）。
 */
export const PROMPT_QUALITY_STATUS = enumSpec(
  'promptQualityStatus',
  ['usable', 'unusable', 'unknown'],
  {
    usable: '提示词包含外观信息',
    unusable: '提示词不可用',
    unknown: '还没有检查这一条',
  },
  '还没有检查这一条',
)

/** 交付内容的来源。未登记时给「来源未记录」，**不回显后端原值**。 */
export const DELIVERY_EXPORT_SOURCE = enumSpec(
  'deliveryExportSource',
  ['external_import'],
  {
    external_import: '外部导入',
  },
  '来源未记录',
)

/**
 * 剧本一致性检查的问题类型（`issue_type`）。
 *
 * 后端是 `Literal["character_confusion"]`（`schemas/skills/script_processing.py:202`）。
 * 运行时泄漏形态是主区直接打 `[character_confusion] Issue 1`（审计 §4.3 模式 2）。
 */
export const SCRIPT_ISSUE_TYPE = enumSpec(
  'scriptIssueType',
  ['character_confusion'],
  {
    character_confusion: '角色混淆',
  },
  '其它问题',
)

/**
 * 后台任务类型（`task_kind`）。
 *
 * 键来自 `taskCopy.ts` 的既有映射表，并补上运行时实测会漏出英文的三个
 * （审计 §4.4：`script_merge` → 「script merge」、`script_variant` → 「script variant」、
 * `video` → 「video」）。旧写法 `MAP[kind] ?? kind.split('_').join(' ')` 会把英文拼出来，
 * 这里一律给中文兜底「后台任务」。
 */
export const TASK_KIND = enumSpec(
  'taskKind',
  [
    'script_divide',
    'script_extract',
    'script_consistency',
    'script_simplify',
    'script_optimize',
    'script_character_portrait',
    'script_prop_info',
    'script_scene_info',
    'script_costume_info',
    'script_merge',
    'script_variant',
    'image_generation',
    'video_generation',
    'shot_frame_prompt',
    'video',
    'image',
  ],
  {
    script_divide: '章节划分',
    script_extract: '剧本提取',
    script_consistency: '一致性检查',
    script_simplify: '剧本精简',
    script_optimize: '剧本优化',
    script_character_portrait: '角色画像分析',
    script_prop_info: '道具信息分析',
    script_scene_info: '场景信息分析',
    script_costume_info: '服装信息分析',
    script_merge: '剧组合并',
    script_variant: '剧本变体',
    image_generation: '图片生成',
    video_generation: '视频生成',
    shot_frame_prompt: '分镜提示词生成',
    video: '视频生成',
    image: '图片生成',
  },
  '后台任务',
)

/* -------------------------------------------------- 模型方案的业务名称（§6.2） */

/**
 * 视频出口的模型方案业务名。
 *
 * 口径来源：审计 §6.2 ——「用户要判断的是这套方案贵不贵、够不够快、能不能出我要的效果，
 * 而不是厂商叫什么」；原始 provider / 模型 ID / 模型名一律进技术详情。
 * 现成先例是 `chapter/components/useShotRequestPlan.ts` 的 `videoModelBusinessName()`，
 * 本表按同一模式把它以及**文本出口 / 图片出口**收敛到一处（审计 §6.2 要求「各补一张同型表」）。
 */
export const VIDEO_MODEL_BUSINESS_NAMES: Readonly<Record<string, string>> = {
  'seedance-2.0-mini': '短视频标准方案',
  'seedance-2.0': '短视频标准方案',
  'seedance-1.0-pro': '短视频高清方案',
}

/** 文本（提示词）出口的模型方案业务名。原始模型名只在技术详情里出现。 */
export const TEXT_MODEL_BUSINESS_NAMES: Readonly<Record<string, string>> = {
  'deepseek-chat': '文本标准方案',
  'deepseek-reasoner': '文本深度思考方案',
}

/** 图片出口的模型方案业务名。 */
export const IMAGE_MODEL_BUSINESS_NAMES: Readonly<Record<string, string>> = {
  'gpt-image-2': '图片标准方案',
  image2: '图片标准方案',
  'nano-banana-2-ext': '图片高清方案',
}

/** 三个出口的业务名兜底。**绝不允许回显模型原名 / provider 名。** */
export const MODEL_BUSINESS_NAME_FALLBACK: Readonly<Record<string, string>> = {
  video: '当前视频方案',
  text: '当前文本方案',
  image: '当前图片方案',
}

export type ModelOutlet = 'text' | 'image' | 'video'

const MODEL_BUSINESS_NAME_TABLE: Readonly<Record<ModelOutlet, Readonly<Record<string, string>>>> = {
  text: TEXT_MODEL_BUSINESS_NAMES,
  image: IMAGE_MODEL_BUSINESS_NAMES,
  video: VIDEO_MODEL_BUSINESS_NAMES,
}

/**
 * 原始模型名 → 主区业务说法（三出口各一张表）。
 *
 * 与旧 `videoModelBusinessName()` 的关键区别：旧实现的兜底是 `?? key`，
 * 也就是**未登记的模型名会原样上屏** —— 那正是模式 5 泄漏。
 * 这里未登记时给「当前 XXX 方案」，原始名只进技术详情。
 */
export function modelBusinessName(outlet: ModelOutlet, modelName: string | null | undefined): string {
  const key = String(modelName ?? '').trim()
  if (!key) return MODEL_BUSINESS_NAME_FALLBACK[outlet]
  const table = MODEL_BUSINESS_NAME_TABLE[outlet]
  return table[key] ?? table[key.toLowerCase()] ?? MODEL_BUSINESS_NAME_FALLBACK[outlet]
}

/** 视频出口（保留旧名，调用点可平滑替换）。 */
export function videoModelBusinessName(modelName: string | null | undefined): string {
  return modelBusinessName('video', modelName)
}

/** 文本出口。 */
export function textModelBusinessName(modelName: string | null | undefined): string {
  return modelBusinessName('text', modelName)
}

/** 图片出口。 */
export function imageModelBusinessName(modelName: string | null | undefined): string {
  return modelBusinessName('image', modelName)
}

/* ------------------------------- §4.3 ChapterStudio：几个带兜底的出口（单一定义） */

/** 中文字符判定（用于「已经是中文就别再套映射」的场景）。 */
const CJK_RE = /[\u4e00-\u9fff]/

/**
 * 视频提示词来源 → 主区中文（审计 §4.3 模式 3）。
 *
 * 与 `labelFor` 的唯一区别：**空值返回空串**，让调用方可以用
 * `` `来源：${videoPromptSourceLabel(src) || '未标记'}` `` 这种写法保留自己的兜底口径
 * （审计 §4.3 给的就是这个口径）。未登记原值仍然**绝不回显**。
 */
export function videoPromptSourceLabel(source: string | null | undefined): string {
  const key = String(source ?? '').trim()
  if (!key) return ''
  return labelFor(VIDEO_PROMPT_SOURCE, key)
}

/** 关键帧出图的提示词来源 → 主区中文（空值返回空串，口径同上）。 */
export function framePromptSourceLabel(source: string | null | undefined): string {
  const key = String(source ?? '').trim()
  if (!key) return ''
  return labelFor(FRAME_PROMPT_SOURCE, key)
}

/**
 * 视频准备度检查项 code → 主区中文；**未登记返回 `null`**。
 *
 * 返回 `null` 而不是中文兜底，是因为审计 §4.3 的口径是
 * 「未登记项**隐藏整行**，而不是回显原值」（运行时形态：整排 `未通过 · extraction_ready`）。
 * 调用方拿到 `null` 时必须跳过这一行，不许把 `key` 打出来。
 */
export function videoReadinessCheckLabel(raw: string | null | undefined): string | null {
  return lookupLabel(VIDEO_READINESS_CHECK, raw)
}

/**
 * 生成任务状态 → 主区中文。
 *
 * 与 `labelFor(TASK_STATUS, …)` 的区别：页面里有的状态是**前端自己写的中文**
 * （例如生成成功后 `setVideoTaskStatus('已生成')`），这些要原样保留而不是变成
 * 「状态未识别」；只有「不是中文、又不是已登记原值」才走中文兜底。
 */
export function taskStatusLabel(status: string | null | undefined): string {
  const key = String(status ?? '').trim()
  if (!key) return ''
  const known = lookupLabel(TASK_STATUS, key)
  if (known) return known
  return CJK_RE.test(key) ? key : TASK_STATUS.unknown
}

/**
 * 是否允许真实付费：后端 `guard_status` → 中文结论（审计 §4.3 模式 3 / §6 边界项）。
 *
 * `guard_status` 来自后端 `dry_run.short_status()`，是**自由文本**（可能是
 * `DRY_RUN=开（JELLYFISH_DRY_RUN，未发起真实调用）` 这种带环境变量名的原话），
 * 所以这里按语义归类成中文结论；原话只留在默认收起的「技术详情」里。
 *
 * ⚠️ 旧实现（`ChapterStudio.tsx` 内的 `describeGuardStatus`）用的是
 * `/DRY_RUN\s*=\s*开|dry_run/i` —— 因为 `i` 标志，`dry_run` 会命中任何含
 * `DRY_RUN` 的句子，于是**「DRY_RUN=关且已确认（真实付费链路）」也会被判成
 * 「不允许（当前是演练模式）」**（真实模式下主区出现错误结论）。这里按
 * 「先判开、再判未确认、最后判已确认」重写，并去掉那条过宽的 `dry_run` 分支。
 */
export function guardStatusLabel(raw: string | null | undefined): string {
  const text = String(raw ?? '').trim()
  if (!text) return '待确认'
  if (/DRY_RUN\s*[=:：]?\s*开/.test(text) || /演练/.test(text)) return '不允许（当前是演练模式）'
  if (/未确认|not_confirmed|unconfirmed/i.test(text) || /DRY_RUN\s*[=:：]?\s*关但/.test(text)) {
    return '不允许（真实调用还没有确认）'
  }
  if (/已确认|真实付费|DRY_RUN\s*[=:：]?\s*关/.test(text)) return '允许'
  if (/真实|real/i.test(text)) return '允许'
  return '待确认（原始状态见「技术详情」）'
}

/* ==========================================================================
 * 剧情广告流程（策划页）：分镜专业枚举 + 商品卡字段 + 阶段口径
 * ==========================================================================
 *
 * 为什么这一族也放本文件：
 *   1. 分镜的景别 / 机位 / 运镜 / 说话方式是**后端枚举原值**（`schemas/skills/common.py`
 *      的 `SHOT_TYPE_ZH` / `CAMERA_ANGLE_ZH` / `CAMERA_MOVEMENT_ZH` / `DIALOGUE_LINE_MODE_ZH`），
 *      与其它枚举同一类东西 —— 分镜卡片上必须显示中文，原值只进「技术详情」；
 *   2. 商品卡字段名、广告阶段码同理：页面上的「待补充」与阶段文案都要有**唯一**中文口径，
 *      不许策划页自己再抄一份（审计 §9.1-19「同一份数据全仓只允许一个名字」）；
 *   3. 下面几个 `…Notice` / `…Missing…` 纯函数是**同一批中文口径的派生**（与既有的
 *      `partialFailureHeadline` / `guardStatusLabel` 同一角色）：它们必须与映射表同源，
 *      拆到别处就会出现「映射表改了、提示句没改」。
 *     ⚠️ 本模块**不 import React / 网络模块**，`node --test` 能直接加载（文件头既有约定）。
 */

/** 景别（`shot_details.camera_shot`）：对齐后端 `SHOT_TYPE_ZH`。 */
export const SHOT_SIZE = enumSpec(
  'shotSize',
  ['ECU', 'CU', 'MCU', 'MS', 'MLS', 'LS', 'ELS'],
  {
    ECU: '大特写',
    CU: '特写',
    MCU: '中近景',
    MS: '中景',
    MLS: '中远景',
    LS: '远景',
    ELS: '大远景',
  },
  '景别未识别',
)

/** 机位 / 角度（`shot_details.angle`）：对齐后端 `CAMERA_ANGLE_ZH`。 */
export const CAMERA_ANGLE = enumSpec(
  'cameraAngle',
  ['EYE_LEVEL', 'HIGH_ANGLE', 'LOW_ANGLE', 'BIRD_EYE', 'DUTCH', 'OVER_SHOULDER'],
  {
    EYE_LEVEL: '平视',
    HIGH_ANGLE: '俯拍',
    LOW_ANGLE: '仰拍',
    BIRD_EYE: '鸟瞰',
    DUTCH: '荷兰角',
    OVER_SHOULDER: '过肩',
  },
  '机位未识别',
)

/** 运镜（`shot_details.movement`）：对齐后端 `CAMERA_MOVEMENT_ZH`。 */
export const CAMERA_MOVEMENT = enumSpec(
  'cameraMovement',
  [
    'STATIC',
    'PAN',
    'TILT',
    'DOLLY_IN',
    'DOLLY_OUT',
    'TRACK',
    'CRANE',
    'HANDHELD',
    'STEADICAM',
    'ZOOM_IN',
    'ZOOM_OUT',
  ],
  {
    STATIC: '固定',
    PAN: '横摇',
    TILT: '俯仰',
    DOLLY_IN: '推轨',
    DOLLY_OUT: '拉轨',
    TRACK: '跟拍',
    CRANE: '升降',
    HANDHELD: '手持',
    STEADICAM: '斯坦尼康',
    ZOOM_IN: '变焦推进',
    ZOOM_OUT: '变焦拉远',
  },
  '运镜未识别',
)

/** 说话方式（台词行 `mode`）：对齐后端 `DIALOGUE_LINE_MODE_ZH`。 */
export const DIALOGUE_LINE_MODE = enumSpec(
  'dialogueLineMode',
  ['DIALOGUE', 'VOICE_OVER', 'OFF_SCREEN', 'PHONE'],
  {
    DIALOGUE: '对白',
    VOICE_OVER: '旁白',
    OFF_SCREEN: '画外音',
    PHONE: '电话声',
  },
  '表述方式未标注',
)

/**
 * 剧情广告项目阶段（`projects.ad_phase`，后端派生）。
 *
 * 中文口径**逐字**取自后端 `ad_flow_service.AD_PHASE_LABELS`（后端同时下发
 * `ad_phase_label`，页面优先用它；这里只作为「后端没给 label」时的同一套兜底）。
 */
export const AD_PHASE = enumSpec(
  'adPhase',
  ['product', 'story', 'storyboard', 'ready', 'confirmed', 'production'],
  {
    product: '待补充商品资料',
    story: '待生成详细剧情',
    storyboard: '待生成分镜',
    ready: '待确认策划',
    confirmed: '已确认策划，可进入资产准备',
    production: '已进入生产',
  },
  '阶段待确认',
)

/** 商品卡字段（`product_cards` 列名）：缺项标「待补充」时用它换中文。 */
export const PRODUCT_CARD_FIELD = enumSpec(
  'productCardField',
  [
    'name',
    'category',
    'brand',
    'selling_points',
    'audience',
    'scenarios',
    'price_info',
    'compliance',
    'notes',
    'reference_files',
  ],
  {
    name: '商品名称',
    category: '品类',
    brand: '品牌',
    selling_points: '核心卖点',
    audience: '目标人群',
    scenarios: '使用场景',
    price_info: '价格或促销信息',
    compliance: '禁止表达与合规要求',
    notes: '用户补充说明',
    reference_files: '商品图片或参考资料',
  },
  '其它字段',
)

/** 商品资料来源（`product_cards.source_type`）。 */
export const PRODUCT_CARD_SOURCE_TYPE = enumSpec(
  'productCardSourceType',
  ['manual', 'paste', 'upload', 'existing'],
  {
    manual: '手工填写',
    paste: '粘贴资料',
    upload: '上传资料',
    existing: '已有商品资料',
  },
  '来源未记录',
)

/** 商品卡缺项的固定显示词（用户拍板口径：缺就是缺，**不编造**）。 */
export const PRODUCT_CARD_PENDING_TEXT = '待补充'

/** 后端必填的商品卡字段（与 `product_card.REQUIRED_CARD_FIELDS` 一致：只有名称）。 */
export const PRODUCT_CARD_REQUIRED_FIELDS: readonly string[] = ['name']

/**
 * 商品卡某个字段是否为空。
 *
 * 与后端 `_is_blank` 同口径：`null` / 空串 / 全空白字符串 / 空数组都算空。
 * 布尔与数字不参与缺项判定（`confirmed` 不是资料字段）。
 */
export function isProductCardFieldBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'string') return value.trim() === ''
  return false
}

/**
 * 按缺项规则算出还缺哪些字段（键序与 `PRODUCT_CARD_FIELD.values` 一致）。
 *
 * 为什么前端也要算：后端 `missing_fields` 是事实来源（页面优先用它），
 * 但用户在页面上**刚改完还没保存**时，界面上的「待补充」必须跟着输入实时消失/出现 ——
 * 那一步不能靠再请求一次接口。两套判定都从这里取同一张字段表，口径不会漂。
 */
export function computeProductCardMissingFields(
  card: Readonly<Record<string, unknown>> | null | undefined,
): string[] {
  if (!card) return [...PRODUCT_CARD_FIELD.values]
  return PRODUCT_CARD_FIELD.values.filter((key) => isProductCardFieldBlank(card[key]))
}

/** 缺项键 → 中文名（未登记给「其它字段」，**不回显列名**）。 */
export function productCardMissingLabels(keys: readonly string[] | null | undefined): string[] {
  return (keys ?? []).map((key) => labelFor(PRODUCT_CARD_FIELD, key))
}

/** 「待补充」那一行的整句口径：`待补充：商品名称、品类`。空缺项返回空串。 */
export function productCardPendingText(keys: readonly string[] | null | undefined): string {
  const labels = productCardMissingLabels(keys)
  if (labels.length === 0) return ''
  return `${PRODUCT_CARD_PENDING_TEXT}：${labels.join('、')}`
}

/** 广告阶段 → 中文（后端给了 `ad_phase_label` 时页面优先用它，这里是同一套兜底）。 */
export function adPhaseLabel(raw: string | null | undefined): string {
  return labelFor(AD_PHASE, raw)
}

/**
 * `drama_plan_drafts.stale_flags` 的形状（后端 JSON 列）。
 *
 * 允许字段缺失：字段没给就是「不知道」，不推断、不编造过期结论。
 */
export type DramaStaleFlags = {
  one_liner_changed_at?: string
  story_changed_at?: string
  story_generated_at?: string
  shots_generated_at?: string
  story_stale?: boolean
  shots_stale?: boolean
  reasons?: readonly string[]
  /* 兼容位：后端目前不下发这两个时间戳（覆盖判定在服务端做），读到就用、读不到不猜。 */
  manual_edited_at?: string
  generated_at?: string
}

/** `stale_flags` 的**过期提示句**（主区显示用）。没有过期就不返回任何句子。 */
export function dramaStaleNotices(flags: DramaStaleFlags | null | undefined): string[] {
  if (!flags) return []
  const notices: string[] = []
  if (flags.story_stale) notices.push('一句话核心创意改过了：下面的详细剧情可能已经过期，需要重新生成。')
  if (flags.shots_stale) notices.push('完整剧情改过了：分镜可能已经过期，需要重新生成。')
  return notices
}

/**
 * 重新生成前的**覆盖风险**口径。
 *
 * 后端规则（`drama_plan_service.needs_overwrite_confirmation`）：人工编辑晚于上次生成时，
 * `generate` 必须带 `confirm_overwrite=true`，否则 409。页面要在按钮上先说清楚
 * 「这一次会覆盖你的修改」，而不是让用户撞一次 409。
 *
 * 判定按**后端实际下发的信号**来，两级：
 *   1. 有 `manual_edited_at` 与生成时间戳且前者更晚 → 确定会覆盖（时间戳是 ISO 串，
 *      字典序即时间序）；
 *   2. 否则看 `story_stale` / `shots_stale`：它们正是"上一步被（人工）改过、
 *      下一步还没重生成"，重生成就是把改动覆盖掉 → **同样要问一次**。
 *
 * ⚠️ 这两个信号都可能因为"另一标签页刚改过"而过时 —— 服务端才是权威：
 * 真撞上 409 时页面会再问一次覆盖（见策划页 `runGenerate`）。
 */
export function dramaOverwriteRisk(
  flags: DramaStaleFlags | null | undefined,
): { needsConfirm: boolean; message: string } {
  const manual = String(flags?.manual_edited_at ?? '').trim()
  const generated = String(
    flags?.generated_at ?? flags?.story_generated_at ?? flags?.shots_generated_at ?? '',
  ).trim()
  if (manual && generated && manual > generated) {
    return {
      needsConfirm: true,
      message: '你在上次生成之后手工改过内容：重新生成会覆盖你的修改，确认后才会继续。',
    }
  }
  if (flags?.story_stale || flags?.shots_stale) {
    return {
      needsConfirm: true,
      message: '上一次生成之后内容被改过（一句话或完整剧情）：重新生成会覆盖这些改动，确认后才会继续。',
    }
  }
  return {
    needsConfirm: false,
    message: '重新生成会用新的结果替换当前内容（会再调用 1 次模型）。',
  }
}

/* ---------------------------------------------------------- 扫描词源 / 自检 */

/** 本文件里全部枚举类（顺序固定，便于测试报错定位）。 */
export const ALL_ENUM_SPECS: readonly EnumSpec[] = [
  ASSET_OUTCOME,
  TASK_STATUS,
  SHOT_STATUS,
  ASSET_TYPE,
  FRAME_TYPE,
  REFERENCE_MODE,
  VIDEO_READINESS_CHECK,
  GENERATION_GATE_STATE,
  REAL_RUN_MODE,
  REAL_RUN_OUTLET,
  REAL_RUN_AUDIT_ACTION,
  VIDEO_PROMPT_SOURCE,
  FRAME_PROMPT_SOURCE,
  TARGET_RATIO_SOURCE,
  FRAME_MODE,
  MODEL_CATEGORY,
  MODEL_STATE,
  PROVIDER_STATUS,
  PROMPT_QUALITY_STATUS,
  DELIVERY_EXPORT_SOURCE,
  TASK_KIND,
  SCRIPT_ISSUE_TYPE,
  /* 剧情广告流程（策划页）：分镜专业枚举 + 商品卡字段 + 项目阶段 */
  SHOT_SIZE,
  CAMERA_ANGLE,
  CAMERA_MOVEMENT,
  DIALOGUE_LINE_MODE,
  AD_PHASE,
  PRODUCT_CARD_FIELD,
  PRODUCT_CARD_SOURCE_TYPE,
]

/**
 * 全部枚举原值（去重、排序）。
 *
 * 供各页的「主区禁词扫描」测试**直接 import**（审计 §8.1 第 2 点）：
 * 映射表与测试词表同源，将来新增枚举会自动纳入扫描，不需要手工同步词表。
 */
export const ENUM_RAW_VALUES: readonly string[] = Array.from(
  new Set(ALL_ENUM_SPECS.flatMap((spec) => spec.values.map((value) => value.toLowerCase()))),
).sort()

/** 全部模型原名（模式 5 的扫描词源，审计 §8.1 第 4 点）。 */
export const MODEL_RAW_NAMES: readonly string[] = Array.from(
  new Set(
    [VIDEO_MODEL_BUSINESS_NAMES, TEXT_MODEL_BUSINESS_NAMES, IMAGE_MODEL_BUSINESS_NAMES].flatMap((table) =>
      Object.keys(table).map((key) => key.toLowerCase()),
    ),
  ),
).sort()

/**
 * 本表覆盖的原值总数（用于验收报告里报数，也用于测试断言「不是空表」）。
 */
export function countCoveredRawValues(): number {
  return ALL_ENUM_SPECS.reduce((total, spec) => total + spec.values.length, 0)
}
