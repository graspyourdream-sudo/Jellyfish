/**
 * 「整体风格」预设与「起点」的回归测试。
 *
 * 重点：
 * 1. 五个预设（真人竖屏 / 真人横屏 / 2D / 3D / 其他自定义）各自映射到既有项目列；
 * 2. 竖屏预设必须写 9:16（短剧默认），横屏写 16:9；
 * 3. 自定义不覆盖任何字段；
 * 4. 起点决定新建后的落点（提示词起步直接进整集提示词看板）；
 * 5. 第三种起点「剧情广告」：请求体带 `kind=ad` + `ad_*` 两段，
 *    落点是**剧情策划页**并带上响应里的 `chapter_id`（不是工作台步骤）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AD_DEFAULT_SHOT_COUNT,
  AD_PRODUCT_SOURCE_OPTIONS,
  OVERALL_STYLE_PRESETS,
  START_MODE_OPTIONS,
  buildAdProductSource,
  buildAdProjectCreateFields,
  buildAdRequirements,
  dramaPlanPath,
  getOverallStylePreset,
  resolveAssetPreparationPath,
  resolveLandingStep,
  resolveOverallStyleFields,
  resolveProjectVideoRatio,
  resolveStartLandingPath,
} from './projectStartPresets.ts'

test('五个整体风格预设齐全（含其他自定义）', () => {
  assert.deepEqual(
    OVERALL_STYLE_PRESETS.map((preset) => preset.key),
    ['live_portrait', 'live_landscape', 'anime_2d', 'anime_3d', 'custom'],
  )
})

test('真人竖屏 → 现实 + 真人都市 + 9:16', () => {
  assert.deepEqual(resolveOverallStyleFields('live_portrait'), {
    visual_style: '现实',
    style: '真人都市',
    default_video_ratio: '9:16',
  })
})

test('真人横屏 → 现实 + 真人都市 + 16:9', () => {
  assert.deepEqual(resolveOverallStyleFields('live_landscape'), {
    visual_style: '现实',
    style: '真人都市',
    default_video_ratio: '16:9',
  })
})

test('2D → 动漫 + 国漫 + 16:9；3D → 动漫 + 动漫3D + 16:9', () => {
  assert.deepEqual(resolveOverallStyleFields('anime_2d'), {
    visual_style: '动漫',
    style: '国漫',
    default_video_ratio: '16:9',
  })
  assert.deepEqual(resolveOverallStyleFields('anime_3d'), {
    visual_style: '动漫',
    style: '动漫3D',
    default_video_ratio: '16:9',
  })
})

/* ------------------------------ 画幅取值（方案 B：手填优先） ------------------------------ */

test('画幅：手填的值优先于预设（真人竖屏也能改成 16:9）', () => {
  assert.equal(resolveProjectVideoRatio('live_portrait', '16:9'), '16:9')
  assert.equal(resolveProjectVideoRatio('anime_2d', '9:16'), '9:16')
})

test('画幅：输入框为空时回落到该风格的预设默认值', () => {
  assert.equal(resolveProjectVideoRatio('live_portrait', ''), '9:16')
  assert.equal(resolveProjectVideoRatio('live_portrait', '   '), '9:16')
  assert.equal(resolveProjectVideoRatio('anime_3d', null), '16:9')
  assert.equal(resolveProjectVideoRatio('live_landscape', undefined), '16:9')
})

test('画幅：其他自定义完全以用户填写为准（留空就是留空）', () => {
  assert.equal(resolveProjectVideoRatio('custom', '21:9'), '21:9')
  assert.equal(resolveProjectVideoRatio('custom', ''), null)
})

test('其他自定义不覆盖任何字段（由用户自己填）', () => {
  assert.equal(resolveOverallStyleFields('custom'), null)
})

test('未知 key 回退到第一个预设，不抛错', () => {
  assert.equal(getOverallStylePreset('not-a-key' as never).key, 'live_portrait')
})

test('起点决定落点：剧本起步 → 第 1 步；提示词起步 → 整集提示词看板', () => {
  assert.equal(resolveLandingStep('script'), 'script')
  assert.equal(resolveLandingStep('prompts'), 'video_prompt')
})

test('起点选项：三种生产方式并存（剧本 / 视频提示词 / 剧情广告）', () => {
  /* 新口径：原来的两种生产方式之外**增加**「剧情广告」，它是项目类型（kind=ad）而不是
     "从哪开始生产"——所以只断言"顺序与第三种的存在"，不推翻前两种既有口径。 */
  assert.deepEqual(
    START_MODE_OPTIONS.map((option) => option.key),
    ['script', 'prompts', 'drama_ad'],
  )
  assert.equal(START_MODE_OPTIONS[2].label, '剧情广告')
  assert.match(START_MODE_OPTIONS[2].description, /商品|剧情策划/)
  assert.match(START_MODE_OPTIONS[1].description, /默认章节|看板/)
})

/* ------------------------------- 剧情广告：资料来源 + 制作要求 ------------------------------- */

test('商品资料来源四项齐全（粘贴 / 上传 / 选已有 / 暂无），且都能落到后端四个取值上', () => {
  assert.deepEqual(
    AD_PRODUCT_SOURCE_OPTIONS.map((option) => option.key),
    ['paste', 'upload', 'existing', 'none'],
  )
  for (const option of AD_PRODUCT_SOURCE_OPTIONS) {
    assert.ok(['manual', 'paste', 'upload', 'existing'].includes(option.payloadType), `${option.key} 的落库取值不合法`)
    assert.ok(option.label.trim().length > 0 && option.hint.trim().length > 0, `${option.key} 缺中文说明`)
  }
})

test('「暂无商品资料」落成 manual（后端没有 none 这个取值），其余三种一对一', () => {
  assert.equal(buildAdProductSource({ choice: 'none' }).type, 'manual')
  assert.equal(buildAdProductSource({ choice: 'paste', text: '卖点' }).type, 'paste')
  assert.equal(buildAdProductSource({ choice: 'upload', fileIds: ['f1', 'f2'] }).type, 'upload')
  assert.equal(buildAdProductSource({ choice: 'existing', productId: 'p1' }).type, 'existing')
})

test('资料来源只把**对应那一种**的内容填进去（不把粘贴文本塞进上传分支）', () => {
  assert.deepEqual(buildAdProductSource({ choice: 'paste', text: '一瓶精华', fileIds: ['f1'], productId: 'p1' }), {
    type: 'paste',
    text: '一瓶精华',
    file_ids: [],
    product_id: '',
  })
  assert.deepEqual(buildAdProductSource({ choice: 'upload', text: '不该带上', fileIds: ['f1', '', 'f2'] }), {
    type: 'upload',
    text: '',
    file_ids: ['f1', 'f2'],
    product_id: '',
  })
  assert.deepEqual(buildAdProductSource({ choice: 'existing', productId: 'p1', text: '不该带上' }), {
    type: 'existing',
    text: '',
    file_ids: [],
    product_id: 'p1',
  })
})

test('制作要求：镜头数收口到 1–16、时长不为负，缺省镜头数按 6', () => {
  assert.equal(buildAdRequirements({}).shot_count, AD_DEFAULT_SHOT_COUNT)
  assert.equal(buildAdRequirements({ shotCount: 99 }).shot_count, 16)
  assert.equal(buildAdRequirements({ shotCount: 0 }).shot_count, 1)
  assert.equal(buildAdRequirements({ shotCount: 4.7 }).shot_count, 4)
  assert.equal(buildAdRequirements({ durationSeconds: -5 }).duration_seconds, 0)
  assert.equal(buildAdRequirements({ shotCount: null }).shot_count, AD_DEFAULT_SHOT_COUNT)
})

test('制作要求：必含 / 禁含按一行一条过滤空行，题材调性去首尾空格', () => {
  const built = buildAdRequirements({
    genre: '  都市  ',
    tone: '爽感',
    mandatoryElements: ['产品出镜', '', '结尾有 slogan'],
    forbiddenElements: [''],
  })
  assert.equal(built.genre, '都市')
  assert.deepEqual(built.mandatory_elements, ['产品出镜', '结尾有 slogan'])
  assert.deepEqual(built.forbidden_elements, [])
})

test('只有剧情广告才带 kind=ad 与 ad_* 字段（普通短剧的请求体一个字段都不变）', () => {
  assert.equal(buildAdProjectCreateFields({ startMode: 'script' }), null)
  assert.equal(buildAdProjectCreateFields({ startMode: 'prompts' }), null)
  const ad = buildAdProjectCreateFields({
    startMode: 'drama_ad',
    productSource: { choice: 'paste', text: '文案' },
    requirements: { tone: '温情', shotCount: 8 },
  })
  assert.ok(ad)
  assert.equal(ad?.kind, 'ad')
  assert.equal(ad?.ad_product_source.type, 'paste')
  assert.equal(ad?.ad_product_source.text, '文案')
  assert.equal(ad?.ad_requirements.shot_count, 8)
})

test('剧情广告创建后的落点是剧情策划页，且带上 chapter_id', () => {
  assert.equal(dramaPlanPath('p1'), '/drama-plan?projectId=p1')
  assert.equal(
    resolveStartLandingPath('drama_ad', 'p1', 'c1'),
    '/drama-plan?projectId=p1&chapterId=c1',
  )
  /* 没有 chapter_id 时（后端没回）也不能拼出空参数 —— 退化成只带 projectId。 */
  assert.equal(resolveStartLandingPath('drama_ad', 'p1', ''), '/drama-plan?projectId=p1')
  /* 其余起点的落点一个字都没变。 */
  assert.equal(resolveStartLandingPath('script', 'p1', 'c1'), '/projects/p1?step=script')
  assert.equal(resolveStartLandingPath('prompts', 'p1', 'c1'), '/projects/p1?step=video_prompt')
})

test('确认策划后的第 2 步入口：step=extract_assets 且 chapter 做 URL 编码', () => {
  assert.equal(
    resolveAssetPreparationPath('p 1', 'c/1'),
    '/projects/p%201?step=extract_assets&chapter=c%2F1',
  )
  assert.equal(
    resolveAssetPreparationPath('p1', 'c1'),
    '/projects/p1?step=extract_assets&chapter=c1',
  )
})

test('预设里凡带视觉风格的，必须同时有题材风格与画幅（避免写半截配置）', () => {
  for (const preset of OVERALL_STYLE_PRESETS) {
    if (preset.key === 'custom') continue
    assert.ok(preset.visualStyle, `${preset.key} 缺 visualStyle`)
    assert.ok(preset.style, `${preset.key} 缺 style`)
    assert.match(preset.defaultVideoRatio ?? '', /^\d+:\d+$/, `${preset.key} 画幅格式不对`)
  }
})
