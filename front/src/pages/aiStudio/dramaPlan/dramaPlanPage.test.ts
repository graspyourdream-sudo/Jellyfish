/**
 * 剧情策划页的**源码级**守卫（不跑浏览器，只钉结构与口径）。
 *
 * 为什么不渲染：这个页面要真跑起来需要后端、路由与登录态；而这一批要求里
 * 有几条是**结构性**的（五段结构、技术详情必须复用全仓唯一的折叠壳、
 * 枚举中文只能来自 `enumLabels.ts`、付费按钮必须写明会调用模型），
 * 这些用源码断言就能钉死，而且不会随渲染细节漂移。
 *
 * 覆盖：
 *   1. 契约「四、页面结构」的五段依次存在；
 *   2. 技术详情走 `<TechnicalDetailSection>`，本文件**不自建** `<details>`；
 *   3. 四个分镜/台词枚举一律从 `enumLabels.ts` 取中文，页面里不再手抄枚举表；
 *   4. 付费动作（提取 + 四个生成按钮）的文案都写明「将调用 1 次模型」；
 *   5. 未保存改动拦截（`beforeunload` + `Modal.confirm`）与过期提示的推导都在。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 去注释：历史沿革的注释里必然要提到旧写法，用注释当"证据"会得出错误结论。 */
function stripComments(source: string): string {
  const out: string[] = []
  let inBlock = false
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false
      out.push('')
      continue
    }
    if (trimmed.startsWith('/*') || trimmed.startsWith('{/*')) {
      if (!trimmed.includes('*/')) inBlock = true
      out.push('')
      continue
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
      out.push('')
      continue
    }
    out.push(line.replace(/(^|[^:])\/\/.*$/, '$1'))
  }
  return out.join('\n')
}

const PAGE_SOURCE = readFileSync(resolve(HERE, 'DramaPlanPage.tsx'), 'utf8')
const PAGE_CODE = stripComments(PAGE_SOURCE)

test('五段结构按契约顺序存在（商品卡 → 剧情策划 → 资产预览 → 分镜卡片 → 底部唯一主操作）', () => {
  /* 前四段各是一个带序号的卡片标题；第五段是底部操作区（没有序号，靠"在分镜之后"判定）。 */
  const titles = ['1. 商品信息卡', '2. 剧情策划', '3. 资产预览', '4. 分镜卡片']
  const positions = titles.map((title) => {
    const at = PAGE_CODE.indexOf(title)
    assert.ok(at >= 0, `页面里找不到「${title}」这一段`)
    return at
  })
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), '四段的出现顺序与契约不一致')

  const footerAt = PAGE_CODE.indexOf('继续准备资产')
  assert.ok(footerAt > positions[3], '底部主操作必须排在分镜卡片之后')
  /* 用 lastIndexOf：顶部说明句里也提到过「确认策划」，真正的主按钮在页面最底部那一段。 */
  assert.ok(PAGE_CODE.lastIndexOf('确认策划') > positions[3], '底部主操作里找不到「确认策划」')
  assert.match(PAGE_CODE, /okText: '确认策划'/, '确认落库前缺少二次确认')
  assert.match(PAGE_CODE, /okText: '继续准备资产'|继续准备资产\n/, '确认成功后没有变成「继续准备资产」入口')
})

test('技术详情复用全仓唯一的折叠壳，且不自建第二套折叠实现', () => {
  assert.ok(
    /import \{ TechnicalDetailSection \} from '\.\.\/project\/ProjectWorkbench\/components\/workbench\/TechnicalDetailCollapse'/.test(
      PAGE_CODE,
    ),
    '必须从全仓唯一的 TechnicalDetailCollapse 导入 TechnicalDetailSection',
  )
  assert.ok(/<TechnicalDetailSection/.test(PAGE_CODE), '没有渲染 TechnicalDetailSection')
  assert.ok(!/<details/.test(PAGE_CODE), '自建了 <details>：第三层内容只能走共享折叠壳')
  /* 收起态可见的标题文案由共享壳自己给，页面不许复制。 */
  assert.ok(!PAGE_CODE.includes('技术详情（默认收起）'), '复制了共享壳的标题文案')
  /* 技术详情里必须真的有 ID / 接口名 / 字段名 / 状态原文 / 来源与更新时间这几类内容。 */
  for (const label of ['项目 / 章节编号', '接口名', '数据库字段', '状态原文', '来源与更新时间']) {
    assert.ok(PAGE_CODE.includes(label), `技术详情里缺少「${label}」`)
  }
})

test('镜头与台词枚举只从 enumLabels 取中文，页面里不再手抄枚举表', () => {
  for (const name of ['SHOT_SIZE', 'CAMERA_ANGLE', 'CAMERA_MOVEMENT', 'DIALOGUE_LINE_MODE']) {
    assert.ok(
      new RegExp(`\\b${name}\\b`).test(PAGE_CODE),
      `${name} 没有从 enumLabels 取（枚举中文必须一处定义、全仓引用）`,
    )
  }
  /* 旧实现在页面里写死过 `['ECU', 'CU', …]` 这种表；出现即视为回退。 */
  assert.ok(!/\[\s*'ECU'/.test(PAGE_CODE), '页面里又出现了手抄的景别枚举表')
  assert.ok(!/'EYE_LEVEL'/.test(PAGE_CODE), '页面里又出现了手抄的机位枚举表')
  assert.ok(!/'STEADICAM'/.test(PAGE_CODE), '页面里又出现了手抄的运镜枚举表')
})

test('付费动作都写明「将调用 1 次模型」（提取 + 四个分层生成按钮）', () => {
  const paidLabels = PAGE_CODE.match(/将调用 1 次模型/g) ?? []
  assert.ok(paidLabels.length >= 5, `付费按钮文案只有 ${paidLabels.length} 处，少于 5 处（提取 1 + 生成 4）`)
  for (const stage of ['one_liner', 'story', 'storyboard', 'all']) {
    assert.ok(
      new RegExp(`onGenerateStage\\('${stage}'\\)`).test(PAGE_CODE),
      `缺少分阶段按钮：${stage}`,
    )
  }
  assert.ok(/onOpenExtract/.test(PAGE_CODE), '缺少「从资料提取」入口')
})

test('演练模式不谎报：提取结果按 source_summary.llm_called 决定措辞', () => {
  assert.ok(/llm_called/.test(PAGE_CODE), '没有读取后端回报的 llm_called，无法判断这次到底调没调模型')
  assert.ok(/没有调用模型/.test(PAGE_CODE), '缺少"本次没有调用模型"的如实说明')
  assert.ok(/没有回填任何字段/.test(PAGE_CODE), '演练/无资料时没有如实说明字段没有被回填')
})

test('未保存改动拦截：脏标记 + 离开前 Modal.confirm 保存/忽略 + 刷新拦截', () => {
  assert.ok(/cardDirty/.test(PAGE_CODE) && /planDirty/.test(PAGE_CODE), '缺少脏标记')
  assert.ok(/beforeunload/.test(PAGE_CODE), '缺少刷新/关页拦截')
  assert.ok(/Modal\.confirm\(\{/.test(PAGE_CODE), '缺少离开前的保存/忽略确认')
  assert.ok(/okText: '保存'/.test(PAGE_CODE) && /cancelText: '忽略'/.test(PAGE_CODE), '保存/忽略文案与既有先例不一致')
})

test('过期提示与覆盖确认走同一套推导（stale_flags → 提示句 / confirm_overwrite）', () => {
  assert.ok(/dramaStaleNotices/.test(PAGE_CODE), '过期提示没有用共享推导')
  assert.ok(/dramaOverwriteRisk/.test(PAGE_CODE), '覆盖风险没有用共享推导')
  assert.ok(/confirm_overwrite|confirmOverwrite/.test(PAGE_SOURCE), '重新生成没有走 confirm_overwrite')
  assert.ok(/runGenerate\(stage, overwriteRisk\.needsConfirm/.test(PAGE_CODE), '二次确认后没有把覆盖确认传给生成接口')
})

test('缺项显示「待补充」且文案取自共享常量（不自造第二种说法）', () => {
  assert.ok(/PRODUCT_CARD_PENDING_TEXT/.test(PAGE_CODE), '「待补充」没有用共享常量')
  assert.ok(/computeProductCardMissingFields/.test(PAGE_CODE), '缺项没有用共享推导（实时标缺项靠它）')
  assert.ok(!/待完善|未填写完整/.test(PAGE_CODE), '出现了第二种"缺项"说法')
})

/* ------------------------------------------------------------------ */
/* 公共五步外壳 + 唯一主操作（任务书第六、七部分）                       */
/* ------------------------------------------------------------------ */

test('公共五步外壳：本页读的是共享实现，不自己拼一套步骤条/上下文条', () => {
  assert.ok(
    /import StepShell from '\.\.\/components\/studio\/StepShell'/.test(PAGE_CODE),
    '必须复用共享的 StepShell（公共五步外壳）',
  )
  assert.ok(/<StepShell/.test(PAGE_CODE), '没有渲染 StepShell')
  assert.ok(/currentStepIndex=\{0\}/.test(PAGE_CODE), '剧情策划对应全局第 1 步')
  assert.ok(!/className="stepper"/.test(PAGE_CODE), '自建了第二套步骤条')
})

test('唯一主操作：全页只剩「确认策划 / 继续准备资产」一个主色按钮', () => {
  /*
   * 设计包 §5.4「一个操作区只允许一个主色按钮」+ 任务书第七部分
   *「确认策划是策划阶段唯一主要操作」。
   * 正文区的「确认商品卡」与「一次生成全部」都必须是次级按钮。
   */
  const primaryCount = (PAGE_CODE.match(/type="primary"/g) ?? []).length
  assert.equal(primaryCount, 2, `主色按钮应只有底部那两个（确认策划 / 继续准备资产），实际 ${primaryCount} 个`)
  assert.ok(!/type="primary" ghost/.test(PAGE_CODE), '「一次生成全部」不该是主色按钮')
  /* 付费动作仍然要写明会调用模型（原有口径不回退） */
  assert.ok(PAGE_CODE.includes('一次生成全部（将调用 1 次模型）'))
})

test('深链自动落位：只有 projectId 时自动取一集可用的空章节', () => {
  assert.ok(/autoOpenedRef/.test(PAGE_CODE), '缺少"只打开过一次"的守卫，会在每次渲染重复取章节')
  assert.ok(
    /void openChapter\(projectId, cardDraft\.name\)/.test(PAGE_CODE),
    '没有复用与下拉选项目同一个 openChapter（会变成第二套章节选择口径）',
  )
})
