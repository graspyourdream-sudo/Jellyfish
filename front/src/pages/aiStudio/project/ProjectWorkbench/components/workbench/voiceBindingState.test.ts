/**
 * 第 2 步「角色声音」区块的纯逻辑与文案测试（设计包 §10）。
 *
 * 覆盖用户点名的四件事：
 *   ① 只有**人物资产**才出这个区块（范围边界）；
 *   ② 未绑定时如实说未绑定（不编一个空文件名糊过去）；已绑定时显示音色名与来源类型；
 *   ③ 音色选择只从**音频**素材里来（图片不许当音色），并按关键字过滤；
 *   ④ 更换的确认文案必须写清**影响范围**（这个人物出现的镜头会一起换）——
 *      这是"自动继承 + 更换需二次确认"在文案上的落点。
 *
 * 另加一条护栏：本区块的文案里不许出现内部字段名 / 原始状态值（沿用共享扫描器，
 * 与工作台其余主区文案同一口径）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { findMainScreenLeaks } from '../../../../components/mainScreenCopyGuard.ts'
import { findMainScreenForbiddenTerms } from './workbenchState.ts'

import {
  VOICE_UNBOUND_MAIN,
  VOICE_SCOPE_HINT,
  VOICE_SECTION_TITLE,
  isAudioFileName,
  normalizeAssetVoice,
  replaceVoiceConfirmText,
  toPlayableUrl,
  voiceBindRequest,
  voiceOptionsFromFiles,
  voiceSavedText,
  voiceSectionAppliesTo,
  voiceStatusSummary,
} from './voiceBindingState.ts'

/* ------------------------------------------------------------------ ① 范围 */

test('只有人物资产才有「角色声音」区块（场景 / 道具 / 服装 / 商品都不出）', () => {
  assert.equal(voiceSectionAppliesTo('character'), true)
  assert.equal(voiceSectionAppliesTo(' CHARACTER '), true)
  assert.equal(voiceSectionAppliesTo('scene'), false)
  assert.equal(voiceSectionAppliesTo('prop'), false)
  assert.equal(voiceSectionAppliesTo('costume'), false)
  assert.equal(voiceSectionAppliesTo('product'), false)
  assert.equal(voiceSectionAppliesTo(''), false)
})

/* -------------------------------------------------------- ② 绑定状态与文案 */

test('后端说没绑就如实说没绑：不编造名字、不给假地址', () => {
  const view = normalizeAssetVoice({ bound: false, asset_label: '角色' })
  assert.equal(view.bound, false)
  assert.equal(view.voiceName, '')
  assert.equal(view.audioUrl, '')
  assert.equal(view.voiceRef, '')
  assert.equal(voiceStatusSummary(view), VOICE_UNBOUND_MAIN)
})

test('已绑定时带回音色名与地址；缺失字段退化成空串而不是 undefined', () => {
  const view = normalizeAssetVoice({ bound: true, file_name: '晚棠配音.mp3', url: 'files/a1.mp3' })
  assert.equal(view.bound, true)
  assert.equal(view.voiceName, '晚棠配音.mp3')
  assert.equal(view.audioUrl, 'files/a1.mp3')
  assert.match(voiceStatusSummary(view), /晚棠配音\.mp3/)
})

test('后端返回空 / 脏数据时按"未绑定"处理，不崩', () => {
  assert.equal(normalizeAssetVoice(null).bound, false)
  assert.equal(normalizeAssetVoice(undefined).bound, false)
  assert.equal(normalizeAssetVoice({}).bound, false)
  assert.equal(voiceStatusSummary(null), VOICE_UNBOUND_MAIN)
})

/* ------------------------------------------------------------ ③ 音色来源 */

test('音色只能从音频素材里选：图片 / 视频 / 其它类型一律剔除', () => {
  const options = voiceOptionsFromFiles([
    { id: 'a1', name: '晚棠配音.mp3', type: 'audio', thumbnail: '/files/a1.mp3' },
    { id: 'i1', name: '定版图.png', type: 'image', thumbnail: '/files/i1.png' },
    { id: 'v1', name: '成片.mp4', type: 'video', thumbnail: '/files/v1.mp4' },
    { id: 'a2', name: '备用配音.wav', type: 'AUDIO', thumbnail: '/files/a2.wav' },
    { id: 'x1', name: '', type: 'audio' },
  ])
  assert.deepEqual(
    options.map((item) => item.id),
    ['a1', 'a2', 'x1'],
  )
  assert.equal(options[2]?.name, 'x1', '名字为空时用编号兜底，不留空行')
})

test('按名称筛选音色（大小写无关），筛不到就是空列表', () => {
  const files = [
    { id: 'a1', name: '晚棠配音.mp3', type: 'audio' },
    { id: 'a2', name: '老夫人配音.mp3', type: 'audio' },
  ]
  assert.deepEqual(voiceOptionsFromFiles(files, '晚棠').map((item) => item.id), ['a1'])
  assert.deepEqual(voiceOptionsFromFiles(files, '没有这一段').map((item) => item.id), [])
  assert.equal(voiceOptionsFromFiles(files, '  ').length, 2)
})

test('音频后缀判定：常见音频放行，图片 / 无后缀不放行', () => {
  assert.equal(isAudioFileName('晚棠配音.MP3'), true)
  assert.equal(isAudioFileName('配音.m4a'), true)
  assert.equal(isAudioFileName('定版图.png'), false)
  assert.equal(isAudioFileName('没有后缀'), false)
})

test('相对地址补成可播放地址；本来就是绝对地址的不动它', () => {
  assert.equal(toPlayableUrl('/files/a1.mp3', 'http://127.0.0.1:8000'), 'http://127.0.0.1:8000/files/a1.mp3')
  assert.equal(toPlayableUrl('files/a1.mp3', 'http://127.0.0.1:8000/'), 'http://127.0.0.1:8000/files/a1.mp3')
  assert.equal(toPlayableUrl('https://cdn.test/a.mp3', 'http://127.0.0.1:8000'), 'https://cdn.test/a.mp3')
  assert.equal(toPlayableUrl('', 'http://127.0.0.1:8000'), '')
})

test('绑定请求体只有一处构造（渲染层不写内部字段名）', () => {
  const body = voiceBindRequest({ id: 'file-1', name: '晚棠配音.mp3', audioUrl: '' })
  assert.deepEqual(Object.keys(body), ['file_id'])
  assert.equal((body as Record<string, unknown>).file_id, 'file-1')
})

/* ------------------------------------------------------------ ④ 更换确认 */

test('更换的确认文案写清影响范围：这个人物出现的镜头会一起换', () => {
  const text = replaceVoiceConfirmText('苏晚棠', '晚棠配音.mp3', '新配音.mp3', 4)
  assert.match(text.title, /苏晚棠/)
  assert.match(text.title, /新配音\.mp3/)
  assert.match(text.content, /4 个镜头/)
  assert.match(text.content, /晚棠配音\.mp3/, '要把"原来那段不再生效"说清')
  assert.match(text.content, /自动同步/)
})

test('没有出场镜头数时也要说清范围（不许退化成"确定吗"）', () => {
  const text = replaceVoiceConfirmText('苏晚棠', '', '新配音.mp3', 0)
  assert.match(text.content, /镜头会一起换成新声音/)
  assert.doesNotMatch(text.content, /原来的/)
})

test('保存成功的提示说明"谁继承它"，而不只是"保存成功"', () => {
  assert.match(voiceSavedText('苏晚棠', '晚棠配音.mp3'), /晚棠配音\.mp3/)
  assert.match(voiceSavedText('苏晚棠', '晚棠配音.mp3'), /自动继承/)
})

/* -------------------------------------------------------------- ⑤ 文案护栏 */

test('区块文案不含内部字段名 / 原始状态值 / 地址', () => {
  const samples = [
    VOICE_SECTION_TITLE,
    VOICE_SCOPE_HINT,
    VOICE_UNBOUND_MAIN,
    voiceStatusSummary(normalizeAssetVoice({ bound: true, file_name: 'A.mp3' })),
    replaceVoiceConfirmText('苏晚棠', 'A.mp3', 'B.mp3', 3).title,
    replaceVoiceConfirmText('苏晚棠', 'A.mp3', 'B.mp3', 3).content,
    voiceSavedText('苏晚棠', 'B.mp3'),
  ]
  samples.forEach((text) => {
    assert.deepEqual(findMainScreenForbiddenTerms(text), [], `文案出现禁词：${text}`)
  })
  // 共享扫描器（含字段名 / 地址 / 枚举原值 / 模型名）：整段文案零命中
  const joined = samples.join('\n')
  assert.deepEqual(findMainScreenLeaks(joined), [], `文案出现模式 1–6 泄漏：\n${joined}`)
})
