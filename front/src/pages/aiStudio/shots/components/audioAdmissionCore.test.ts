/**
 * 「参考音频」页面口径的回归测试（Node 内置测试运行器）。
 *
 * 锁三件事：
 *   1. **绑了取不到**时，必须在提交**之前**就显示「已绑定，但当前服务取不到这条声音」
 *      + 后端给的真实原因 + 修法（不是等生成失败才说）；
 *   2. **不许夸大**：携带时只能说"会进请求（本轮仅请求计划层验证）"，
 *      不能宣称"已支持参考音频影响生成"；
 *   3. 未绑定 / 明确无需声音 / asset:// / 内网地址分别有各自的状态文案。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AUDIO_NOT_REACHABLE_TITLE,
  REFERENCE_AUDIO_SCOPE_NOTE,
  REFERENCE_AUDIO_VS_FINAL_TRACK,
  audioStateTag,
  describeAudioAdmission,
  type AudioAudit,
} from './audioAdmissionCore.ts'

/**
 * 阶段 B ③（审计 §4.3 模式 5 / §7.3）：主区禁词。
 *
 * 这条断言是**新增**的（不是把旧期望放宽）：旧用例把「供应商」措辞**冻结**成了期望值，
 * 按审计口径「供应商」不许出现在主区 —— 所以期望改成同一个常量，
 * **同时**钉住这个常量本身不含禁词，防止有人改常量绕过去。
 */
const MAIN_SCREEN_FORBIDDEN_TERMS = ['供应商', 'provider', 'DRY_RUN', 'file_id'] as const

function audit(overrides: Partial<AudioAudit> = {}): AudioAudit {
  return { included: false, file_id: 'file-audio-1', ...overrides }
}

test('本机相对路径 → 显示「已绑定，但当前服务取不到这条声音」并给原因与修法', () => {
  const view = describeAudioAdmission(
    audit({
      state: 'local_path',
      reason_code: 'local_path',
      declared_url: '/files/files/voice.mp3',
      excluded_reason: '已绑定声音「验收配音」，但它解析出的是本地/相对地址（/files/files/voice.mp3）：供应商抓不到。',
      how_to_fix: '把音频上传到公网（OSS 等），或登记一个公网音频地址后重新绑定。',
    }),
  )

  assert.equal(view.blocked, true)
  assert.equal(view.title, AUDIO_NOT_REACHABLE_TITLE)
  MAIN_SCREEN_FORBIDDEN_TERMS.forEach((term) => {
    assert.ok(!view.title.includes(term), `主区标题不许含禁词「${term}」：${view.title}`)
  })
  assert.match(view.detail, /本地\/相对地址/)
  assert.match(view.fix, /公网/)
  assert.equal(view.tone, 'warning')
  // 本地路径不能出现在 tag 里当"可用"
  assert.match(view.tag, /本地/)
})

test('内网地址 → 同样显示不可访问（http:// 开头也不算可用）', () => {
  const view = describeAudioAdmission(
    audit({
      state: 'private_address',
      reason_code: 'private_address',
      declared_url: 'http://192.168.1.9:8000/voice.mp3',
      excluded_reason: '已绑定声音「验收配音」，但它指向本机/内网地址（192.168.1.9）：别人的服务器一定取不到。',
      how_to_fix: '请换成公网可访问的 http(s) 地址（OSS 等）。',
    }),
  )

  assert.equal(view.blocked, true)
  assert.equal(view.title, AUDIO_NOT_REACHABLE_TITLE)
  assert.match(view.detail, /内网/)
})

test('供应商不支持参考音频 → 也说清"绑了但用不上"', () => {
  const view = describeAudioAdmission(
    audit({
      state: 'vendor_unsupported',
      reason_code: 'vendor_unsupported',
      vendor_supports_reference_audio: false,
      excluded_reason: '已绑定声音「验收配音」，但当前视频供应商/模型不接受参考音频：本次生成请求不会携带它。',
    }),
  )

  assert.equal(view.blocked, true)
  assert.match(view.tag, /不接受参考音频/)
})

test('公网地址 → 已携带，但文案只承诺"会进请求"，不承诺影响结果', () => {
  const view = describeAudioAdmission(
    audit({ included: true, state: 'public_url', url: 'https://cdn.example.com/voice.mp3' }),
  )

  assert.equal(view.blocked, false)
  assert.equal(view.tone, 'success')
  assert.match(view.fix, /请求计划层/)
  assert.doesNotMatch(view.title, /影响生成/)
  assert.match(view.fix, /尚未有真实证据/)
})

test('asset:// → 算携带（协议里的合法参考音频地址）', () => {
  const view = describeAudioAdmission(
    audit({ included: true, state: 'asset_ref', url: 'asset://project-1/voice-asset-1' }),
  )
  assert.equal(view.blocked, false)
  assert.match(view.tag, /asset:\/\//)
  assert.match(view.detail, /asset:\/\/project-1\/voice-asset-1/)
})

test('未绑定 → 明确说未绑定，不冒充"已绑定"', () => {
  const view = describeAudioAdmission({ included: false, file_id: '', state: 'not_bound', reason_code: 'not_bound' })
  assert.equal(view.blocked, false)
  assert.equal(view.tag, '声音未绑定')
  assert.match(view.title, /还没有绑定声音/)
})

test('明确标记无需声音 → 是表态，不是漏绑，也不报警', () => {
  const view = describeAudioAdmission(audit({ file_id: '', state: 'opt_out', reason_code: 'opt_out', excluded_reason: '本镜已明确标记「无需声音」。' }))
  assert.equal(view.blocked, false)
  assert.equal(view.tag, '本镜明确无需声音')
  assert.equal(view.tone, 'default')
})

test('计划还没加载 → 状态未知，不猜', () => {
  const view = describeAudioAdmission(null)
  assert.equal(view.blocked, false)
  assert.match(view.tag, /未知/)
})

test('术语澄清：参考音频 ≠ 最终成片音轨（每个状态都带上）', () => {
  const states = [
    null,
    audit({ included: true, state: 'public_url', url: 'https://cdn.example.com/a.mp3' }),
    audit({ state: 'local_path', reason_code: 'local_path' }),
    { state: 'opt_out' } as AudioAudit,
  ]
  for (const item of states) {
    assert.equal(describeAudioAdmission(item).terminology, REFERENCE_AUDIO_VS_FINAL_TRACK)
  }
  assert.match(REFERENCE_AUDIO_VS_FINAL_TRACK, /最终成片的音轨/)
  assert.match(REFERENCE_AUDIO_SCOPE_NOTE, /请求计划层/)
})

test('阶段B③：标题常量与后端原文出口都不含主区禁词（审计 §4.3 模式 5 / 模式 6）', () => {
  MAIN_SCREEN_FORBIDDEN_TERMS.forEach((term) => {
    assert.ok(!AUDIO_NOT_REACHABLE_TITLE.includes(term), `标题常量含禁词「${term}」`)
  })
  // 后端 `excluded_reason` 原文里带「供应商」时，出口必须先过管道再上屏
  const view = describeAudioAdmission(
    audit({
      state: 'local_path',
      reason_code: 'local_path',
      excluded_reason: '已绑定声音「验收配音」，但它解析出的是本地/相对地址（/files/files/voice.mp3）：供应商抓不到。',
      how_to_fix: '把音频上传到公网（OSS 等），或登记一个公网音频地址后重新绑定。',
    }),
  )
  const surface = `${view.title}｜${view.detail}｜${view.fix}｜${view.tag}`
  MAIN_SCREEN_FORBIDDEN_TERMS.forEach((term) => {
    assert.ok(!surface.includes(term), `主区出口仍含禁词「${term}」：${surface}`)
  })
})

test('计划面板短标签：有审计用审计，没有审计时退回旧字段文案', () => {
  assert.match(audioStateTag({ included: true, state: 'public_url' }), /会携带/)
  assert.equal(audioStateTag(null, 'bound_not_public'), AUDIO_NOT_REACHABLE_TITLE)
  assert.equal(audioStateTag(null, 'bound'), '声音已绑定（公网可用）')
  assert.equal(audioStateTag(null, 'opt_out'), '本镜明确无需声音')
  assert.equal(audioStateTag(null, 'missing'), '声音未绑定')
  assert.match(audioStateTag(null, 'whatever'), /未知/)
})
