/**
 * 分镜准备页「本镜无需声音」开关的单测（Task 4）。
 *
 * 这里钉住四件事：
 *   1. **与角色声音继承的关系**必须写明（开启 = 本镜不继承；关闭 = 照常继承），
 *      且必须写清"声音本身在人物资产里改" —— 它不是一个声音编辑入口；
 *   2. 写入请求体只有 `audio_opt_out` 一个字段（补丁口是"只改传进来的字段"，
 *      夹带别的字段就等于顺手改了别的东西）；
 *   3. 错误出口走全仓统一的 message 包装层（这条断言原来钉在已删除的旧绑定区上，
 *      现在迁到本组件）；
 *   4. 主区文案干净（禁词 / 地址 / 原始状态值），且**不提供**第二套声音操作
 *      （没有试听、没有选择、没有上传、没有解绑）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { extractScanSurfaces } from '../../components/mainScreenCopyGuard.ts'
import {
  SHOT_AUDIO_OPT_OUT_HINT,
  SHOT_AUDIO_OPT_OUT_INHERITS,
  SHOT_AUDIO_OPT_OUT_LABEL,
  SHOT_AUDIO_OPT_OUT_MARKED,
  SHOT_AUDIO_OPT_OUT_SAVE_FAILED,
  SHOT_AUDIO_OPT_OUT_SCOPE_NOTE,
  describeShotAudioOptOut,
  shotAudioOptOutPatch,
  shotAudioOptOutSavedText,
} from './shotAudioOptOut.ts'

const here = dirname(fileURLToPath(import.meta.url))
const component = readFileSync(join(here, 'ShotAudioOptOutSwitch.tsx'), 'utf8')

test('开关语义：标记态与继承态各有明确结论（不靠勾选态自己猜）', () => {
  const marked = describeShotAudioOptOut(true)
  assert.equal(marked.checked, true)
  assert.equal(marked.statusText, SHOT_AUDIO_OPT_OUT_MARKED)

  const inheriting = describeShotAudioOptOut(false)
  assert.equal(inheriting.checked, false)
  assert.equal(inheriting.statusText, SHOT_AUDIO_OPT_OUT_INHERITS)
})

test('与角色声音继承的关系两个方向都写明（关闭 = 本镜照常继承）', () => {
  assert.match(SHOT_AUDIO_OPT_OUT_HINT, /开启后这一镜不继承人物资产的角色声音/)
  assert.match(SHOT_AUDIO_OPT_OUT_HINT, /关闭时这一镜照常继承/)
  assert.ok(
    describeShotAudioOptOut(false).hint === SHOT_AUDIO_OPT_OUT_HINT,
    '两个状态都要带这句说明，不能只在标记态出现',
  )
})

test('它不是第二个声音编辑入口：声音本身仍指向第 2 步人物资产详情', () => {
  assert.match(SHOT_AUDIO_OPT_OUT_SCOPE_NOTE, /人物资产详情/)
  assert.match(SHOT_AUDIO_OPT_OUT_SCOPE_NOTE, /只决定这一镜用不用它/)
  assert.match(SHOT_AUDIO_OPT_OUT_SCOPE_NOTE, /不会改到人物资产/)
  // 组件里不许出现选择 / 试听 / 上传 / 解绑这类"第二套声音操作"。
  // 只看**用户可见文案**（注释里合法地写着"这里没有试听"，那不是给用户看的字）。
  const surfaces = extractScanSurfaces(component).map((surface) => surface.text)
  for (const word of ['试听', '选择音色', '上传音频', '解绑', '更换']) {
    assert.deepEqual(
      surfaces.filter((text) => text.includes(word)),
      [],
      `开关的用户可见文案里出现了声音编辑动作「${word}」`,
    )
  }
  // 只有一处写入动作，且它写的是本镜自己的那一格标记
  assert.match(component, /shotAudioOptOutSavedText/)
})

test('写入请求体只有 audio_opt_out 一个字段（补丁口语义不变）', () => {
  assert.deepEqual(shotAudioOptOutPatch(true), { audio_opt_out: true })
  assert.deepEqual(shotAudioOptOutPatch(false), { audio_opt_out: false })
  assert.deepEqual(Object.keys(shotAudioOptOutPatch(true)), ['audio_opt_out'])
  // 极值：非布尔真值不许被当成 true 写进去（只认严格布尔语义）
  assert.deepEqual(shotAudioOptOutPatch(1 as unknown as boolean), { audio_opt_out: false })
})

test('开关文案：标题与两份提示语都是用户语言且不含禁词', () => {
  assert.equal(SHOT_AUDIO_OPT_OUT_LABEL, '本镜无需声音')
  assert.equal(shotAudioOptOutSavedText(true), '已标记：本镜无需声音')
  assert.equal(shotAudioOptOutSavedText(false), '已取消「无需声音」标记')
  assert.equal(SHOT_AUDIO_OPT_OUT_SAVE_FAILED, '保存失败')

  const banned = ['file_id', 'audio_file_id', 'shot_id', '槽位', '供应商', '门禁', 'DRY_RUN']
  const texts = [
    SHOT_AUDIO_OPT_OUT_LABEL,
    SHOT_AUDIO_OPT_OUT_MARKED,
    SHOT_AUDIO_OPT_OUT_INHERITS,
    SHOT_AUDIO_OPT_OUT_HINT,
    SHOT_AUDIO_OPT_OUT_SCOPE_NOTE,
    SHOT_AUDIO_OPT_OUT_SAVE_FAILED,
    shotAudioOptOutSavedText(true),
    shotAudioOptOutSavedText(false),
  ]
  banned.forEach((term) => {
    texts.forEach((text) => {
      assert.equal(text.includes(term), false, `文案命中禁词「${term}」→「${text}」`)
    })
  })
  // 地址 / 本机路径一律不进文案
  texts.forEach((text) => {
    assert.equal(/https?:\/\//.test(text), false, `文案里出现了地址：${text}`)
  })
})

test('错误出口走统一 message 包装层（原钉在已删除绑定区上的断言迁到这里）', () => {
  assert.match(component, /import \{ showUserError \} from '\.\.\/\.\.\/components\/userFacingMessage'/)
  assert.match(component, /void showUserError\(error, SHOT_AUDIO_OPT_OUT_SAVE_FAILED\)/)
  assert.equal(
    /\(e as Error\)\?\.message|error\?\.message/.test(component),
    false,
    '不许把后端原文直出到主区（模式 6）',
  )
})
