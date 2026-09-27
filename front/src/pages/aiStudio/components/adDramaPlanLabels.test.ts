/**
 * 剧情广告（剧情策划页）用到的映射与派生口径的回归测试。
 *
 * 覆盖四件事（都是纯函数，不需要网络、不依赖 React）：
 *   1. **镜头枚举的中文映射**：景别 / 机位 / 运镜 / 说话方式 —— 逐值与后端权威表
 *      `backend/app/schemas/skills/common.py:89-142`（`SHOT_TYPE_ZH` / `CAMERA_ANGLE_ZH` /
 *      `CAMERA_MOVEMENT_ZH` / `DIALOGUE_LINE_MODE_ZH`）对齐；未登记一律给中文兜底。
 *   2. **广告项目阶段文案**：与后端 `ad_flow_service.AD_PHASE_LABELS` 逐字一致。
 *   3. **商品卡缺项与「待补充」**：空串 / 全空白 / 空数组都算缺；缺项一律有中文名。
 *   4. **过期标记推导**：只按后端给的 `stale_flags` 说话，不推断、不编造。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AD_PHASE,
  CAMERA_ANGLE,
  CAMERA_MOVEMENT,
  DIALOGUE_LINE_MODE,
  PRODUCT_CARD_FIELD,
  PRODUCT_CARD_PENDING_TEXT,
  PRODUCT_CARD_SOURCE_TYPE,
  SHOT_SIZE,
  adPhaseLabel,
  computeProductCardMissingFields,
  dramaOverwriteRisk,
  dramaStaleNotices,
  isProductCardFieldBlank,
  canonicalEnumValue,
  labelFor,
  productCardMissingLabels,
  productCardPendingText,
} from './enumLabels.ts'

const CJK_RE = /[\u4e00-\u9fff]/

/* ------------------------------------------------ ① 镜头四张专业映射表 */

test('景别：七个原值逐字对齐后端权威表（ECU 大特写 … ELS 大远景）', () => {
  assert.deepEqual(
    { ...SHOT_SIZE.labels },
    {
      ECU: '大特写',
      CU: '特写',
      MCU: '中近景',
      MS: '中景',
      MLS: '中远景',
      LS: '远景',
      ELS: '大远景',
    },
  )
  assert.deepEqual([...SHOT_SIZE.values], ['ECU', 'CU', 'MCU', 'MS', 'MLS', 'LS', 'ELS'])
})

test('机位：六个原值逐字对齐后端权威表', () => {
  assert.deepEqual(
    { ...CAMERA_ANGLE.labels },
    {
      EYE_LEVEL: '平视',
      HIGH_ANGLE: '俯拍',
      LOW_ANGLE: '仰拍',
      BIRD_EYE: '鸟瞰',
      DUTCH: '荷兰角',
      OVER_SHOULDER: '过肩',
    },
  )
})

test('运镜：十一个原值逐字对齐后端权威表', () => {
  assert.deepEqual(
    { ...CAMERA_MOVEMENT.labels },
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
  )
})

test('说话方式：四个原值逐字对齐后端权威表（含电话声）', () => {
  assert.deepEqual(
    { ...DIALOGUE_LINE_MODE.labels },
    { DIALOGUE: '对白', VOICE_OVER: '旁白', OFF_SCREEN: '画外音', PHONE: '电话声' },
  )
})

test('大小写不敏感：AI 出的草稿写小写，页面照样给中文', () => {
  assert.equal(labelFor(SHOT_SIZE, 'ecu'), '大特写')
  assert.equal(labelFor(CAMERA_MOVEMENT, 'dolly_in'), '推轨')
  assert.equal(labelFor(DIALOGUE_LINE_MODE, 'voice_over'), '旁白')
})

test('下拉用的规范写法：任何大小写都换回登记的那个原值，未登记返回 null', () => {
  /* 为什么必须换：antd 的 Select 在"当前值不在选项里"时会把原样字符串渲染出来，
     那等于把未登记原值端到主区。 */
  assert.equal(canonicalEnumValue(SHOT_SIZE, 'ecu'), 'ECU')
  assert.equal(canonicalEnumValue(CAMERA_ANGLE, 'over_shoulder'), 'OVER_SHOULDER')
  assert.equal(canonicalEnumValue(CAMERA_MOVEMENT, 'DOLLY_IN'), 'DOLLY_IN')
  assert.equal(canonicalEnumValue(DIALOGUE_LINE_MODE, 'Phone'), 'PHONE')
  assert.equal(canonicalEnumValue(SHOT_SIZE, 'EXTREME_NEW'), null)
  assert.equal(canonicalEnumValue(SHOT_SIZE, ''), null)
  assert.equal(canonicalEnumValue(SHOT_SIZE, null), null)
})

test('未登记 / 空值都回中文兜底，绝不上屏英文原值', () => {
  const specs = [SHOT_SIZE, CAMERA_ANGLE, CAMERA_MOVEMENT, DIALOGUE_LINE_MODE]
  for (const spec of specs) {
    for (const probe of ['EXTREME_WIDE_NEW', '', '   ', null, undefined]) {
      const label = labelFor(spec, probe as string | null | undefined)
      assert.ok(CJK_RE.test(label), `${spec.name}：「${String(probe)}」的中文兜底缺失（${label}）`)
      assert.notEqual(label.toLowerCase(), String(probe ?? '').toLowerCase())
    }
  }
})

/* ------------------------------------------------------ ② 广告阶段文案 */

test('广告阶段：六个阶段的中文与后端 `ad_flow_service.AD_PHASE_LABELS` 逐字一致', () => {
  assert.deepEqual(
    { ...AD_PHASE.labels },
    {
      product: '待补充商品资料',
      story: '待生成详细剧情',
      storyboard: '待生成分镜',
      ready: '待确认策划',
      confirmed: '已确认策划，可进入资产准备',
      production: '已进入生产',
    },
  )
})

test('广告阶段：后端没给中文标签时按同一套映射兜底；完全未知的阶段说「阶段待确认」', () => {
  assert.equal(adPhaseLabel('product'), '待补充商品资料')
  assert.equal(adPhaseLabel('confirmed'), '已确认策划，可进入资产准备')
  assert.equal(adPhaseLabel(''), '阶段待确认')
  assert.equal(adPhaseLabel(null), '阶段待确认')
  assert.equal(adPhaseLabel('brand_new_phase'), '阶段待确认')
})

/* --------------------------------------------- ③ 商品卡缺项与「待补充」 */

test('商品卡缺项：十个字段的键序与中文名固定（页面「待补充」那一行靠它）', () => {
  assert.deepEqual(
    [...PRODUCT_CARD_FIELD.values],
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
  )
  assert.equal(labelFor(PRODUCT_CARD_FIELD, 'selling_points'), '核心卖点')
  assert.equal(labelFor(PRODUCT_CARD_FIELD, 'reference_files'), '商品图片或参考资料')
  /* 未登记的列名不许原样上屏。 */
  assert.equal(labelFor(PRODUCT_CARD_FIELD, 'future_column'), '其它字段')
})

test('空卡：十项全缺；缺项顺序与字段表一致（页面逐项标「待补充」）', () => {
  const missing = computeProductCardMissingFields({})
  assert.equal(missing.length, 10)
  assert.deepEqual(missing, [...PRODUCT_CARD_FIELD.values])
  assert.equal(computeProductCardMissingFields(null).length, 10)
})

test('缺项判定：空串 / 全空白 / 空数组算缺；有内容就不算缺', () => {
  assert.equal(isProductCardFieldBlank(''), true)
  assert.equal(isProductCardFieldBlank('   '), true)
  assert.equal(isProductCardFieldBlank([]), true)
  assert.equal(isProductCardFieldBlank(null), true)
  assert.equal(isProductCardFieldBlank(undefined), true)
  assert.equal(isProductCardFieldBlank('不编造'), false)
  assert.equal(isProductCardFieldBlank(['卖点']), false)
  assert.equal(isProductCardFieldBlank(false), false)

  const card = {
    name: '紧致焕颜精华',
    category: '   ',
    brand: '',
    selling_points: ['7 天见效果'],
    audience: '25-35 岁通勤女性',
    scenarios: [],
    price_info: '',
    compliance: '不得绝对化用语',
    notes: '   ',
    reference_files: [{ file_id: 'f1', name: '正面图.png', kind: 'image' }],
  }
  assert.deepEqual(computeProductCardMissingFields(card), [
    'category',
    'brand',
    'scenarios',
    'price_info',
    'notes',
  ])
})

test('「待补充」整句口径：缺项全列出来；没有缺项返回空串（不出现空标签）', () => {
  assert.equal(
    productCardPendingText(['name', 'category']),
    `${PRODUCT_CARD_PENDING_TEXT}：商品名称、品类`,
  )
  assert.equal(productCardPendingText(['name']), '待补充：商品名称')
  assert.equal(productCardPendingText([]), '')
  assert.equal(productCardPendingText(null), '')
  /* 未登记键给中文，不上屏英文列名。 */
  assert.deepEqual(productCardMissingLabels(['future_column']), ['其它字段'])
})

test('商品资料来源：四个原值都有中文，未登记给「来源未记录」', () => {
  assert.deepEqual(
    { ...PRODUCT_CARD_SOURCE_TYPE.labels },
    { manual: '手工填写', paste: '粘贴资料', upload: '上传资料', existing: '已有商品资料' },
  )
  assert.equal(labelFor(PRODUCT_CARD_SOURCE_TYPE, 'brand_new_source'), '来源未记录')
})

/* --------------------------------------------------- ④ 过期标记与覆盖风险 */

test('过期提示：只按后端标记说话（一句话改过 → 详细剧情可能过期；完整剧情改过 → 分镜可能过期）', () => {
  assert.deepEqual(dramaStaleNotices(null), [])
  assert.deepEqual(dramaStaleNotices({}), [])
  const both = dramaStaleNotices({ story_stale: true, shots_stale: true })
  assert.equal(both.length, 2)
  assert.match(both[0], /一句话/)
  assert.match(both[0], /详细剧情/)
  assert.match(both[1], /完整剧情/)
  assert.match(both[1], /分镜/)
  /* 后端只给 true 才提示：缺字段 = 不知道，不推断。 */
  assert.deepEqual(dramaStaleNotices({ story_stale: false, shots_stale: false }), [])
  assert.equal(dramaStaleNotices({ reasons: ['后端自己的说法'] }).length, 0)
})

test('覆盖风险：人工编辑晚于上次生成 → 必须二次确认并说明会覆盖修改', () => {
  const risky = dramaOverwriteRisk({
    manual_edited_at: '2026-09-27T10:00:00+00:00',
    generated_at: '2026-09-26T10:00:00+00:00',
  })
  assert.equal(risky.needsConfirm, true)
  assert.match(risky.message, /覆盖你的修改/)

  const safe = dramaOverwriteRisk({
    manual_edited_at: '2026-09-25T10:00:00+00:00',
    generated_at: '2026-09-26T10:00:00+00:00',
  })
  assert.equal(safe.needsConfirm, false)
  assert.match(safe.message, /1 次模型/)
})

test('覆盖风险：过期标记本身就是"改过还没重生成" → 同样要问一次覆盖', () => {
  for (const flags of [
    { story_stale: true },
    { shots_stale: true },
    { story_stale: true, shots_stale: true },
  ]) {
    const risk = dramaOverwriteRisk(flags)
    assert.equal(risk.needsConfirm, true, `${JSON.stringify(flags)} 被改过却没要求确认覆盖`)
    assert.match(risk.message, /覆盖/)
  }
})

test('覆盖风险：时间戳缺一个就不假装知道 —— 不给「会覆盖」的结论，但仍说明会替换内容', () => {
  for (const flags of [null, {}, { manual_edited_at: '2026-09-27T10:00:00+00:00' }, { generated_at: '2026-09-26T10:00:00+00:00' }]) {
    const risk = dramaOverwriteRisk(flags)
    assert.equal(risk.needsConfirm, false, `${JSON.stringify(flags)} 不该被判成"确定会覆盖"`)
    assert.match(risk.message, /替换/)
  }
})
