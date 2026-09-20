/**
 * 巨日禄「脚本组选择 + 整组导入」的纯逻辑测试（`node --test`；仓库风格：测试挨着源码）。
 *
 * 只钉用户明确说过的那几条，因为每一条错了用户就会看到幻觉数据：
 * 1) 默认一组都不选 → 不发匹配请求、rows 为空；
 * 2) 只选一组 → 请求体 `script_ids` **只有一个** id（整组，不是前三条）；
 * 3) 换组 → 旧组 rows 先被清空，才允许发新请求；
 * 4) `likely_newest` 只是提示，不构成默认选中；
 * 5) **没有时间戳证据时页面上不出现「最新版本」字样**（升级要求）；
 * 6) 缺标题 / 缺时间时显示「未提供」，**不编造**；
 * 7) 后端说 `requires_script_selection=true` 却给了 rows → 那些 rows 一条都不用；
 * 8) 组内**全部**记录都进预览（不截断）；
 * 9) 镜头不足时**三个选项**都产出，且明确写出缺少数量；
 * 10) 保存按钮只显示当前勾选条数（**不再有「最多 3 条」**）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MISSING_TIME_TEXT,
  MISSING_TITLE_TEXT,
  NEWEST_DISCLAIMER,
  NEWEST_TAG_TEXT,
  NO_TIMESTAMP_EVIDENCE,
  activeGroupLabel,
  applyGroupSwitch,
  buildJuriluEntries,
  clearRowsBeforeMatch,
  countMatchedEntries,
  defaultScriptSelection,
  groupCoverageNotice,
  groupFieldTexts,
  normalizeScriptGroups,
  planGroupMatch,
  planShotShortage,
  rawKeysText,
  reasonHasTimestampEvidence,
  resolveScriptSelection,
  sampleRows,
  sampleSectionTitle,
  saveButtonText,
  summarizeScriptGroups,
  versionInfo,
  wholeGroupNotice,
  wholeGroupSaveNotice,
  type JuriluPreviewEntry,
} from './juriluScriptGroups.ts'
import type { JuriluScriptGroup } from '../../../../../services/llmPipelineApi'

/** 契约里的真实形状：109 条 = 41 + 37 + 31。 */
function group(overrides: Partial<JuriluScriptGroup> & { script_id: string }): JuriluScriptGroup {
  return {
    title: '',
    title_source: '',
    created_at: '',
    updated_at: '',
    record_count: 0,
    seq_min: '',
    seq_max: '',
    seq_field: '',
    sample_records: [],
    raw_keys: [],
    likely_newest: false,
    version_reasons: [],
    version_hint: '',
    ...overrides,
  }
}

const G1 = group({
  script_id: '2933350',
  title: '第1集',
  title_source: 'title',
  created_at: '2026-09-18 09:00:00',
  record_count: 37,
  seq_min: '1',
  seq_max: '37',
  seq_field: 'seqNum',
})
const G2 = group({
  script_id: '2933351',
  title: '第1集',
  title_source: 'title',
  created_at: '2026-09-18 12:00:00',
  record_count: 31,
  seq_min: '1',
  seq_max: '31',
  seq_field: 'seqNum',
})
const G_NEWEST = group({
  script_id: '2936083',
  title: '第1集',
  title_source: 'title',
  created_at: '2026-09-19 10:00:00',
  record_count: 41,
  seq_min: '1',
  seq_max: '41',
  seq_field: 'seqNum',
  likely_newest: true,
  version_reasons: ['与 2933351/2933350 标题相同', '内容重合度 82%'],
  version_hint: '疑似与 2933351/2933350 为同一脚本的不同版本；最可能是最新版',
})

const GROUPS = [G1, G2, G_NEWEST]

function planRows(count: number, scriptId: string, matched = true) {
  return Array.from({ length: count }, (_, i) => ({
    order: i + 1,
    label: `S${i + 1}`,
    prompt: `【${scriptId}】第 ${i + 1} 条提示词正文`,
    shot_id: matched ? `shot${i + 1}` : '',
    reason: matched ? '' : '这条没有匹配到镜头',
  }))
}

test('默认一组都不选：不发匹配请求、rows 为空', () => {
  const selection = resolveScriptSelection({
    groups: GROUPS,
    selectedScriptIds: [],
    requiresScriptSelection: true,
    rowCount: 0,
  })
  assert.deepEqual(selection.requestScriptIds, [])
  assert.equal(selection.canMatch, false)
  assert.equal(selection.selectedId, '')
  assert.equal(selection.requiresSelection, true)
  assert.match(summarizeScriptGroups(GROUPS).notice, /默认不合并/)

  const plan = planGroupMatch({ previousSelectedId: '', selectedId: '', currentRowCount: 0 })
  assert.equal(plan.send, false)
  assert.deepEqual(plan.scriptIds, [])
  assert.match(plan.blockedReason, /还没选择脚本组/)
})

test('抬头说明的数字用真实数据算（3 组 / 109 条），不写死', () => {
  const summary = summarizeScriptGroups(GROUPS)
  assert.equal(summary.groupCount, 3)
  assert.equal(summary.recordTotal, 109)
  assert.match(summary.notice, /共 3 个脚本组/)
  assert.match(summary.notice, /合计 109 条分镜/)

  const other = summarizeScriptGroups([G_NEWEST])
  assert.equal(other.recordTotal, 41)
})

test('整组选中后请求体只有一个 script_id（U1：单数语义）', () => {
  for (const item of GROUPS) {
    const selection = resolveScriptSelection({
      groups: GROUPS,
      selectedScriptIds: [item.script_id],
      requiresScriptSelection: false,
      rowCount: item.record_count,
    })
    assert.deepEqual(selection.requestScriptIds, [item.script_id])
    assert.equal(selection.requestScriptIds.length, 1, '请求体只能有一个 script_id')

    const plan = planGroupMatch({ previousSelectedId: '', selectedId: item.script_id, currentRowCount: 0 })
    assert.deepEqual(plan.scriptIds, [item.script_id])
    assert.equal(plan.scriptIds.length, 1)
  }
})

test('组内全部记录都进预览（不截断、不抽样）', () => {
  for (const item of GROUPS) {
    const rows = planRows(item.record_count, item.script_id)
    const entries = buildJuriluEntries(rows, item.script_id)
    assert.equal(entries.length, item.record_count, '整组条数必须原样进表')
    assert.equal(entries[0].juriluSeq, '1')
    assert.equal(entries[entries.length - 1].juriluSeq, String(item.record_count))
    assert.ok(entries.every((entry) => entry.scriptId === item.script_id), '每条都要带上脚本组，不能混组')
    assert.equal(countMatchedEntries(entries), item.record_count)
  }

  // 把 41 条 + 31 条混在一起是**不可能**发生的：一次只映射一组
  const only = buildJuriluEntries(planRows(41, '2936083'), '2936083')
  assert.equal(new Set(only.map((entry) => entry.scriptId)).size, 1)

  // 未匹配的条目也要进表（带原因），而不是被悄悄丢掉
  const partial = buildJuriluEntries(planRows(3, '2933351', false), '2933351')
  assert.equal(partial.length, 3)
  assert.equal(partial[0].status, 'unmatched')
  assert.equal(partial[0].matched_by, 'none')
  assert.match(partial[0].message, /没有匹配到镜头/)
  assert.equal(countMatchedEntries(partial), 0)
})

test('组覆盖率不一致时如实提示（少了几条 / 多了别的组）', () => {
  assert.equal(groupCoverageNotice(41, 41), '')
  assert.equal(groupCoverageNotice(0, 0), '')
  const less = groupCoverageNotice(41, 31)
  assert.match(less, /只返回了 31 条/)
  assert.match(less, /记录数是 41 条/)
  const more = groupCoverageNotice(31, 41)
  assert.match(more, /混入了别的 scriptId/)
})

test('换组：旧组 rows 先被清空，才允许发新请求', () => {
  const plan = planGroupMatch({ previousSelectedId: '2936083', selectedId: '2933351', currentRowCount: 41 })
  assert.equal(plan.send, true, '换组后允许发请求')
  assert.deepEqual(plan.scriptIds, ['2933351'])
  assert.equal(plan.clearBefore, true, '必须先清空旧组结果')
  assert.equal(plan.clearCount, 41)
  assert.match(plan.notice, /已切换到脚本组 2933351/)

  const oldRows = Array.from({ length: 41 }, (_, index) => `row-${index}`)
  assert.deepEqual(clearRowsBeforeMatch(oldRows, plan), [])

  const outcome = applyGroupSwitch<{ key: string }>({
    previousSelectedId: '2936083',
    selectedId: '2933351',
    currentRowCount: 41,
  })
  assert.equal(outcome.changed, true)
  assert.equal(outcome.clearedCount, 41)
  assert.deepEqual(outcome.nextRows, [])
  assert.equal(outcome.resetMatched, true, '换了组就要清掉"已匹配组"标记')

  const same = planGroupMatch({ previousSelectedId: '2936083', selectedId: '2936083', currentRowCount: 41 })
  assert.equal(same.clearBefore, true)
  assert.equal(same.clearCount, 41)

  const fresh = planGroupMatch({ previousSelectedId: '', selectedId: '2933350', currentRowCount: 0 })
  assert.equal(fresh.clearBefore, false)
  assert.equal(fresh.clearCount, 0)
})

test('likely_newest 只是提示，不构成默认选中', () => {
  assert.deepEqual(defaultScriptSelection(GROUPS), [])
  const selection = resolveScriptSelection({
    groups: GROUPS,
    selectedScriptIds: defaultScriptSelection(GROUPS),
    requiresScriptSelection: true,
    rowCount: 0,
  })
  assert.equal(selection.selectedId, '')
  assert.deepEqual(selection.requestScriptIds, [])
})

test('没有时间戳证据时不出现「最新版本」字样（U2 升级要求）', () => {
  // 契约里的真实依据：标题相同 + 内容重合度 —— 都是客观事实，**不含时间戳** → 不标最新版
  const info = versionInfo(G_NEWEST)
  assert.equal(info.timestampEvidence, false)
  assert.equal(info.label, '')
  assert.equal(info.disclaimer, '')
  assert.equal(info.hint, '', '没有时间戳证据时不展示可能含"最可能是最新版"的后端提示语')
  assert.equal(info.factsTitle, '后端给出的客观事实')
  assert.deepEqual(info.facts, ['与 2933351/2933350 标题相同', '内容重合度 82%'])
  assert.equal(info.noEvidenceNotice, NO_TIMESTAMP_EVIDENCE)
  assert.match(info.noEvidenceNotice, /不做版本新旧判断/)
  // 拼给页面看的整串里不能有「最新版本」四个字
  const shown = [info.label, info.hint, info.disclaimer, ...info.facts, info.noEvidenceNotice].join('\n')
  assert.ok(!shown.includes('最新版本'), `页面上不该出现「最新版本」：${shown}`)

  // 该组自己连时间都没有，更不可能有时间戳证据
  const noTime = versionInfo(group({ script_id: 'x', likely_newest: true, version_reasons: ['创建时间更晚'] }))
  assert.equal(noTime.timestampEvidence, false)
  assert.equal(noTime.label, '')
})

test('只有后端给出基于时间戳的依据时才显示「最新版本」（并带"仍请你确认"）', () => {
  const withTime = group({
    script_id: '2936083',
    created_at: '2026-09-19 10:00:00',
    record_count: 41,
    likely_newest: true,
    version_reasons: ['创建时间 2026-09-19 10:00:00 晚于 2933350 的 2026-09-18 09:00:00'],
    version_hint: '按时间戳判断，本组最新',
  })
  const info = versionInfo(withTime)
  assert.equal(info.timestampEvidence, true)
  assert.equal(info.label, NEWEST_TAG_TEXT)
  assert.match(info.label, /时间戳/)
  assert.equal(info.disclaimer, NEWEST_DISCLAIMER)
  assert.match(info.disclaimer, /仍需你确认/)
  assert.equal(info.noEvidenceNotice, '')

  // 只有关键词、没有该组自身时间戳 → 仍不算证据
  assert.equal(reasonHasTimestampEvidence('updated_at 最晚'), true)
  const noOwnTime = versionInfo(
    group({ script_id: 'y', likely_newest: true, version_reasons: ['更新时间最晚'] }),
  )
  assert.equal(noOwnTime.timestampEvidence, false)
  assert.equal(noOwnTime.label, '')
})

test('缺标题 / 缺时间：显示「未提供」，不编造', () => {
  const texts = groupFieldTexts(G_NEWEST)
  assert.equal(texts.titleText, '第1集')
  assert.equal(texts.titleMissing, false)
  assert.equal(texts.createdAtText, '创建时间：2026-09-19 10:00:00')
  assert.equal(texts.updatedAtText, `更新时间：${MISSING_TIME_TEXT}`)
  assert.equal(texts.recordCountText, '41 条分镜')
  assert.equal(texts.seqRangeText, '分镜序号 1–41（序号来自字段 seqNum）')
  assert.match(texts.missingMetaNotice, /后端未提供这些字段（更新时间）/)

  const empty = groupFieldTexts(group({ script_id: '1' }))
  assert.equal(empty.titleText, MISSING_TITLE_TEXT)
  assert.equal(empty.titleMissing, true)
  assert.match(empty.createdAtText, new RegExp(MISSING_TIME_TEXT))
  assert.match(empty.updatedAtText, new RegExp(MISSING_TIME_TEXT))
  assert.equal(empty.recordCountText, '0 条分镜')
  assert.equal(empty.seqRangeText, '未提供分镜序号范围')
  assert.match(empty.missingMetaNotice, /标题 \/ 创建时间 \/ 更新时间/)

  const noField = groupFieldTexts(group({ script_id: '2', seq_min: '1', seq_max: '5' }))
  assert.equal(noField.seqRangeText, '分镜序号 1–5（未提供序号字段名）')
  assert.match(rawKeysText(group({ script_id: '3' })), /后端未返回 raw_keys/)
})

test('解析自检：前几条样例 + 正文截断 + 字数如实显示', () => {
  const sample = group({
    script_id: '2936083',
    sample_records: [
      { seq: '1', sbid: 'S1', prompt_head: '前 60 字'.repeat(20), prompt_length: 120, summary_head: '摘要'.repeat(30) },
      { seq: '2', sbid: '', prompt_head: '', prompt_length: 0, summary_head: '' },
    ],
  })
  const rows = sampleRows(sample)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].seqText, '#1')
  assert.equal(rows[0].sbidText, 'S1')
  assert.equal(rows[0].promptLengthText, '120 字')
  assert.ok(rows[0].promptHeadText.length <= 61)
  assert.ok(rows[0].summaryHeadText.length <= 41)
  assert.equal(rows[1].sbidText, '未提供 sbid')
  assert.equal(rows[1].promptHeadText, '（空）')
  assert.match(sampleSectionTitle(sample), /msgpack 解析自检（正文 \/ 序号 \/ 提示词）/)
  assert.match(sampleSectionTitle(sample), /前 2 条/)
})

test('后端要求先选组却给了 rows：一条都不用（109 条不是一集的连续镜头）', () => {
  const selection = resolveScriptSelection({
    groups: GROUPS,
    selectedScriptIds: [],
    requiresScriptSelection: true,
    rowCount: 109,
  })
  assert.equal(selection.dropRows, true)
  assert.deepEqual(selection.requestScriptIds, [])
  assert.ok(selection.notices.some((item) => /必须重新选组/.test(item)))

  const ok = resolveScriptSelection({
    groups: GROUPS,
    selectedScriptIds: ['2936083'],
    requiresScriptSelection: false,
    rowCount: 41,
  })
  assert.equal(ok.dropRows, false)
  assert.deepEqual(ok.requestScriptIds, ['2936083'])
})

test('一次性收到多个 script_id：按"未选择"处理，绝不自动合并', () => {
  const selection = resolveScriptSelection({
    groups: GROUPS,
    selectedScriptIds: ['2936083', '2933351'],
    requiresScriptSelection: false,
    rowCount: 68,
  })
  assert.equal(selection.selectedId, '')
  assert.deepEqual(selection.requestScriptIds, [])
  assert.ok(selection.notices.some((item) => /一次只能选一组/.test(item)))
})

test('选了不存在的组 → 不发请求并明确提示重选', () => {
  const selection = resolveScriptSelection({
    groups: GROUPS,
    selectedScriptIds: ['9999999'],
    requiresScriptSelection: false,
    rowCount: 0,
  })
  assert.equal(selection.selectedId, '')
  assert.deepEqual(selection.requestScriptIds, [])
  assert.ok(selection.notices.some((item) => /不在本次返回的脚本组里/.test(item)))
})

test('镜头不足：明确写出缺少数量，并给出三个选项', () => {
  // 本集 0 镜 + 该组 31 条（还没匹配，用户直接点"创建缺失镜头"）
  const empty = planShotShortage({ shotCount: 0, entryCount: 0, matchedCount: 0, groupRecordCount: 31 })
  assert.equal(empty.show, true)
  assert.equal(empty.targetCount, 31)
  assert.equal(empty.missingCount, 31)
  assert.match(empty.message, /缺少 31 个/)
  assert.deepEqual(
    empty.options.map((item) => item.key),
    ['create_missing', 'save_matched_only', 'back_to_adjust'],
  )
  assert.match(empty.options[0].label, /创建缺失镜头（31 个）并重新匹配/)
  assert.match(empty.options[1].label, /仅保存已经匹配的条目（0 条）/)
  assert.match(empty.options[1].label, /仅保存/)
  assert.match(empty.options[2].label, /返回调整/)
  assert.equal(empty.options[0].disabled, false)
  assert.equal(empty.options[1].disabled, true, '一条都没匹配上时"仅保存已匹配"没有意义')
  assert.equal(empty.options[2].disabled, false)

  // 已匹配 20 条、本集 25 镜、该组 31 条 → 缺 6 个
  const partial = planShotShortage({ shotCount: 25, entryCount: 31, matchedCount: 20, groupRecordCount: 31 })
  assert.equal(partial.missingCount, 6)
  assert.match(partial.message, /现有 25 个镜头/)
  assert.match(partial.message, /缺少 6 个/)
  assert.equal(partial.options[0].disabled, false)
  assert.equal(partial.options[1].disabled, false)
  assert.match(partial.options[1].label, /（20 条）/)

  // 数量一致 → 不显示这套选项
  const aligned = planShotShortage({ shotCount: 31, entryCount: 31, matchedCount: 31, groupRecordCount: 31 })
  assert.equal(aligned.show, false)
  assert.equal(aligned.missingCount, 0)
})

test('预览表抬头必须写出当前是哪一组（防止看错表）', () => {
  assert.equal(activeGroupLabel(GROUPS, '2936083'), '当前脚本组：2936083（第1集） · 41 条分镜')
  assert.match(activeGroupLabel(GROUPS, ''), /尚未选择脚本组/)
  assert.match(activeGroupLabel(GROUPS, '888'), /不在本次脚本组清单里/)
})

test('保存按钮只显示当前勾选条数，不再出现「最多 3 条」（U2 升级要求）', () => {
  assert.equal(saveButtonText(31), '确认保存（31 条）')
  assert.equal(saveButtonText(0), '确认保存（0 条）')
  assert.equal(saveButtonText(109), '确认保存（109 条）')
  assert.ok(!saveButtonText(41).includes('最多'), '不该再有"最多 N 条"的限制文案')
  assert.ok(!saveButtonText(41).includes('临时章节'))

  const notice = wholeGroupSaveNotice(31, '2933350', 31)
  assert.match(notice, /脚本组 2933350/)
  assert.match(notice, /31 条/)
  assert.match(notice, /来源 jurilu/)
  assert.match(notice, /不与其他 scriptId 混合/)

  const whole = wholeGroupNotice(G2)
  assert.match(whole, /31 条记录会全部进入统一预览与匹配/)
  assert.match(whole, /不截断/)
  assert.match(whole, /不与其他 scriptId 混合/)
  assert.match(wholeGroupNotice(null), /还没选择脚本组/)
})

test('归一化：缺字段就留空（交给展示层说"未提供"），没有 script_id 的组丢掉', () => {
  const normalized = normalizeScriptGroups([
    { script_id: '2936083', record_count: '41', likely_newest: true, version_reasons: ['重合 82%', ''] },
    { script_id: '', title: '野组' },
    null,
    { script_id: 'x', record_count: '不是数字' },
  ])
  assert.equal(normalized.length, 2)
  assert.equal(normalized[0].record_count, 41)
  assert.equal(normalized[0].title, '')
  assert.deepEqual(normalized[0].version_reasons, ['重合 82%'])
  assert.equal(normalized[0].likely_newest, true)
  assert.equal(normalized[1].record_count, 0)
  assert.equal(normalized[1].likely_newest, false)
  assert.deepEqual(normalizeScriptGroups(undefined), [])
})

test('条目类型带脚本组与巨日禄序号（页面预览表两列的数据来源）', () => {
  const entries: JuriluPreviewEntry[] = buildJuriluEntries(
    [{ order: 7, prompt: '正文', shot_id: 'shot7' }, { prompt: '正文2' }],
    '2933351',
  )
  assert.equal(entries[0].scriptId, '2933351')
  assert.equal(entries[0].juriluSeq, '7')
  assert.equal(entries[1].juriluSeq, '未提供序号')
  assert.equal(entries[1].shot_id, '')
})
