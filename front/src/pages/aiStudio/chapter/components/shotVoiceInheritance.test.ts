/**
 * 第 4 步「资产与声音检查」· 角色声音的只读口径测试（设计包 §10）。
 *
 * 锁住三件事：
 *   ① 五种结论各自的主区文案（含「音色名 · 继承自人物资产」这一句）；
 *   ② 缺项 / 多人物时的**下一步**（要不要给「返回人物资产补充」，地址落在第 2 步人物页）；
 *   ③ 主区文案不含内部字段名 / 原始状态值 / 地址（沿用共享扫描器）。
 *
 * 另有一条**结构性**断言：本步骤**没有**第二套选择 / 更换入口 ——
 * 文案里不许出现"绑定 / 解绑 / 更换声音"这类动作词，只能指路回人物资产。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findMainScreenLeaks } from '../../components/mainScreenCopyGuard.ts'

import {
  SHOT_VOICE_COMPLETE_ACTION,
  SHOT_VOICE_READONLY_NOTE,
  assetCompletionPath,
  describeShotVoiceInheritance,
} from './shotVoiceInheritance.ts'

const inheritedPayload = {
  shot_id: 'shot-1',
  state: 'inherited',
  file_id: 'file-a1',
  file_name: '晚棠配音.mp3',
  url: 'files/a1.mp3',
  source_asset_type: 'character',
  source_asset_id: 'char-1',
  source_asset_name: '苏晚棠',
  character_count: 1,
  voice_asset_count: 1,
}

test('已绑定：显示「音色名 · 继承自人物资产」并说明来源人物', () => {
  const view = describeShotVoiceInheritance(inheritedPayload)
  assert.equal(view.headline, '晚棠配音.mp3 · 继承自人物资产')
  assert.equal(view.voiceName, '晚棠配音.mp3')
  assert.equal(view.audioUrl, 'files/a1.mp3')
  assert.equal(view.missing, false)
  assert.equal(view.needsAssetCompletion, false, '已绑定就不该再提示去补充')
  assert.match(view.detail, /苏晚棠/)
})

test('缺项：标为声音缺项，并给「返回人物资产补充」', () => {
  const view = describeShotVoiceInheritance({
    shot_id: 'shot-2',
    state: 'missing',
    character_count: 2,
    voice_asset_count: 0,
  })
  assert.equal(view.missing, true)
  assert.equal(view.needsAssetCompletion, true)
  assert.match(view.headline, /声音缺项/)
  assert.match(view.detail, /2 个人物资产/)
  assert.match(view.detail, /第 2 步/)
})

test('缺项（这一镜还没有人物资产）：说明原因仍然给补充入口', () => {
  const view = describeShotVoiceInheritance({ state: 'missing', character_count: 0 })
  assert.equal(view.needsAssetCompletion, true)
  assert.match(view.detail, /还没有关联人物资产/)
})

test('多人物都绑了声音：不替用户挑，如实列出并指路', () => {
  const view = describeShotVoiceInheritance({
    state: 'ambiguous',
    candidates: ['苏晚棠', '叶老夫人'],
    voice_asset_count: 2,
  })
  assert.equal(view.missing, false)
  assert.equal(view.needsAssetCompletion, true)
  assert.deepEqual(view.multiVoicedNames, ['苏晚棠', '叶老夫人'])
  assert.match(view.detail, /苏晚棠、叶老夫人/)
  assert.equal(view.voiceName, '', '多人物时不许挑一个声音出来显示成"已生效"')
})

test('历史快照：声音缺项 + 如实说明那只是历史记录', () => {
  const view = describeShotVoiceInheritance({
    state: 'legacy_snapshot',
    legacy_file_id: 'file-old',
    legacy_file_name: '旧逐镜配音.mp3',
    legacy_inherited_from: 'character:char-1',
  })
  assert.equal(view.missing, true)
  assert.equal(view.needsAssetCompletion, true)
  assert.match(view.detail, /旧逐镜配音\.mp3/)
  assert.match(view.detail, /历史记录/)
  assert.equal(view.voiceName, '', '历史快照不许冒充继承来的声音')
})

test('本镜标记无需声音：既不算缺项，也不提示补充', () => {
  const view = describeShotVoiceInheritance({ state: 'opt_out', voice_asset_count: 0 })
  assert.equal(view.missing, false)
  assert.equal(view.needsAssetCompletion, false)
  assert.match(view.headline, /无需声音/)
})

test('本镜标记无需声音、但角色其实有声音：把这句话说明白', () => {
  const view = describeShotVoiceInheritance({
    state: 'opt_out',
    file_name: '晚棠配音.mp3',
    voice_asset_count: 1,
  })
  assert.match(view.detail, /晚棠配音\.mp3/)
  assert.match(view.detail, /本镜/)
})

test('未知 / 脏结论一律按缺项兜底，不把原值端上主区', () => {
  const view = describeShotVoiceInheritance({ state: 'brand_new_state' })
  assert.equal(view.missing, true)
  assert.equal(view.headline.includes('brand_new_state'), false)
  assert.equal(describeShotVoiceInheritance(null).missing, true)
  assert.equal(describeShotVoiceInheritance(undefined).needsAssetCompletion, true)
})

/* ------------------------------------------------------------------ 下一步 */

test('「返回人物资产补充」落在第 2 步资产准备的人物页签，并带上当前章节', () => {
  const path = assetCompletionPath('proj-1', 'chap-9')
  assert.equal(path, '/projects/proj-1?step=extract_assets&tab=roles&chapter=chap-9')
  assert.equal(path.includes('binding'), false, '不许把人带回第 4 步自己')
})

test('拿不到项目时不给死链（返回空串，页面据此不渲染按钮）', () => {
  assert.equal(assetCompletionPath('', 'chap-9'), '')
  assert.equal(assetCompletionPath('  ', ''), '')
})

/* -------------------------------------------------------------- 文案护栏 */

test('本步骤只有"看"的动作词，没有第二套选择 / 更换入口的措辞', () => {
  const texts = [
    SHOT_VOICE_COMPLETE_ACTION,
    SHOT_VOICE_READONLY_NOTE,
    ...['inherited', 'ambiguous', 'legacy_snapshot', 'opt_out', 'missing'].map((state) => {
      const view = describeShotVoiceInheritance({ state, candidates: ['甲', '乙'] })
      return `${view.headline}｜${view.detail}`
    }),
  ]
  texts.forEach((text) => {
    assert.doesNotMatch(text, /这里(可以|能)(绑定|选择|更换)/, `第 4 步出现了第二套入口措辞：${text}`)
    assert.doesNotMatch(text, /点击(绑定|更换)/, `第 4 步出现了第二套入口措辞：${text}`)
  })
  assert.match(SHOT_VOICE_READONLY_NOTE, /只读/)
  assert.match(SHOT_VOICE_COMPLETE_ACTION, /人物资产/)
})

test('文案不含内部字段名 / 地址 / 原始状态值', () => {
  const texts = [
    ...['inherited', 'ambiguous', 'legacy_snapshot', 'opt_out', 'missing'].map((state) => {
      const view = describeShotVoiceInheritance({ state, candidates: ['甲'], file_name: 'X.mp3' })
      return `${view.headline}｜${view.detail}`
    }),
    SHOT_VOICE_READONLY_NOTE,
    SHOT_VOICE_COMPLETE_ACTION,
  ]
  const joined = texts.join('\n')
  assert.deepEqual(findMainScreenLeaks(joined), [], `文案出现模式 1–6 泄漏：\n${joined}`)
})
