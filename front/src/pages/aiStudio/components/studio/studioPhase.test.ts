/**
 * `studioPhase.ts` 的单元测试（`node --test`，与仓库既有前端测试同一套跑法）。
 *
 * 覆盖的是任务书第三、六、十一部分点名的几条硬口径：
 * 1. 阶段 key 与全局五步的换算（第 3 步名字仍是「整集视频提示词」，容器才叫「分镜工作室」）；
 * 2. 旧深链（`?studio=binding` / `?studio=generate_deliver`）继续可达；
 * 3. 刷新恢复：项目 / 章节来自路由，阶段与**当前镜头**来自 URL 参数；
 * 4. 写 URL 时不动其它参数（不把项目工作台带过来的参数吃掉）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  GLOBAL_STEPS,
  STUDIO_CONTAINER_LABEL,
  STUDIO_PHASES,
  STUDIO_PHASE_PARAM,
  STUDIO_SHOT_PARAM,
  buildStudioContinueLabel,
  buildStudioPath,
  buildStudioSearch,
  getNextStudioPhase,
  getPrevStudioPhase,
  getStudioPhase,
  globalStepIndexForProjectStep,
  projectStepKeyForPhase,
  readStudioUrlState,
  resolveStudioPhaseFromParam,
  studioPhaseIndex,
  studioPhaseMountKey,
} from './studioPhase.ts'

test('全局五步的名称与顺序固定：第 3 步仍叫「整集视频提示词」', () => {
  assert.deepEqual(
    GLOBAL_STEPS.map((step) => step.label),
    ['剧本与分镜', '资产准备', '整集视频提示词', '资产与声音检查', '生成与交付'],
  )
  assert.equal(GLOBAL_STEPS[2].label, '整集视频提示词')
  assert.notEqual(GLOBAL_STEPS[2].label, STUDIO_CONTAINER_LABEL)
  assert.equal(STUDIO_CONTAINER_LABEL, '分镜工作室')
})

test('阶段条文案自带全局序号（3 / 4 / 5）', () => {
  assert.deepEqual(
    STUDIO_PHASES.map((phase) => phase.label),
    ['3 整集视频提示词', '4 资产与声音检查', '5 生成与交付'],
  )
  assert.deepEqual(
    STUDIO_PHASES.map((phase) => phase.displayIndex),
    [3, 4, 5],
  )
})

test('阶段 ↔ 项目内部步骤 key 双向一致（含旧的 generate_deliver）', () => {
  assert.equal(projectStepKeyForPhase('video_prompt'), 'video_prompt')
  assert.equal(projectStepKeyForPhase('binding'), 'binding')
  assert.equal(projectStepKeyForPhase('deliver'), 'generate_deliver')
  assert.equal(globalStepIndexForProjectStep('video_prompt'), 2)
  assert.equal(globalStepIndexForProjectStep('binding'), 3)
  assert.equal(globalStepIndexForProjectStep('generate_deliver'), 4)
  assert.equal(globalStepIndexForProjectStep('script'), 0)
  assert.equal(globalStepIndexForProjectStep('extract_assets'), 1)
  assert.equal(globalStepIndexForProjectStep('image_prep'), 1)
})

test('旧深链继续可达，认不出来时落到第 3 阶段而不是抛错', () => {
  assert.equal(resolveStudioPhaseFromParam('video_prompt'), 'video_prompt')
  assert.equal(resolveStudioPhaseFromParam('binding'), 'binding')
  assert.equal(resolveStudioPhaseFromParam('deliver'), 'deliver')
  assert.equal(resolveStudioPhaseFromParam('generate_deliver'), 'deliver')
  assert.equal(resolveStudioPhaseFromParam(null), 'video_prompt')
  assert.equal(resolveStudioPhaseFromParam('  '), 'video_prompt')
  assert.equal(resolveStudioPhaseFromParam('something-else'), 'video_prompt')
})

test('阶段翻页边界：第 3 阶段没有上一阶段，第 5 阶段没有下一阶段', () => {
  assert.equal(getPrevStudioPhase('video_prompt'), null)
  assert.equal(getNextStudioPhase('video_prompt'), 'binding')
  assert.equal(getNextStudioPhase('binding'), 'deliver')
  assert.equal(getNextStudioPhase('deliver'), null)
  assert.equal(studioPhaseIndex('deliver'), 2)
  assert.equal(getStudioPhase('deliver').stepLabel, '生成与交付')
})

test('刷新恢复：阶段与当前镜头都从 URL 读回来', () => {
  const state = readStudioUrlState(`?${STUDIO_PHASE_PARAM}=binding&${STUDIO_SHOT_PARAM}=shot_123`)
  assert.deepEqual(state, { phase: 'binding', shotId: 'shot_123' })
  // 没有镜头参数时是 null（不是空串），页面据此"不恢复镜头"
  assert.deepEqual(readStudioUrlState(`?${STUDIO_PHASE_PARAM}=deliver`), { phase: 'deliver', shotId: null })
  assert.deepEqual(readStudioUrlState(''), { phase: 'video_prompt', shotId: null })
  assert.deepEqual(readStudioUrlState(null), { phase: 'video_prompt', shotId: null })
})

test('写 URL 只动 studio / shot，不动其它参数（不吞掉工作台带过来的参数）', () => {
  const next = buildStudioSearch('?chapter=ch_1&tab=chapters', { phase: 'deliver', shotId: 'shot_9' })
  const params = new URLSearchParams(next)
  assert.equal(params.get('chapter'), 'ch_1')
  assert.equal(params.get('tab'), 'chapters')
  assert.equal(params.get(STUDIO_PHASE_PARAM), 'deliver')
  assert.equal(params.get(STUDIO_SHOT_PARAM), 'shot_9')
})

test('清空当前镜头时把 shot 参数删掉，而不是留一个空值', () => {
  const next = buildStudioSearch('?studio=binding&shot=shot_1', { shotId: null })
  assert.equal(new URLSearchParams(next).has(STUDIO_SHOT_PARAM), false)
  assert.equal(new URLSearchParams(next).get(STUDIO_PHASE_PARAM), 'binding')
})

test('深链包含项目、章节、阶段与镜头（任务中心回跳对应镜头靠它）', () => {
  const path = buildStudioPath({
    projectId: 'proj 1',
    chapterId: 'ch/2',
    phase: 'deliver',
    shotId: 'shot_7',
  })
  assert.equal(
    path,
    '/projects/proj%201/chapters/ch%2F2/studio?studio=deliver&shot=shot_7',
  )
  // 不带镜头时不应出现空的 shot 参数
  const noShot = buildStudioPath({ projectId: 'p1', chapterId: 'c1' })
  assert.equal(noShot, '/projects/p1/chapters/c1/studio?studio=video_prompt')
})

test('阶段挂载键把镜头算进去：切镜头会重建面板，切阶段不会', () => {
  assert.notEqual(studioPhaseMountKey('video_prompt', 'a'), studioPhaseMountKey('video_prompt', 'b'))
  assert.notEqual(studioPhaseMountKey('video_prompt', 'a'), studioPhaseMountKey('binding', 'a'))
})

test('活动内的「流程下一步」文案唯一来源（同屏只有一个主按钮靠它）', () => {
  assert.equal(buildStudioContinueLabel('video_prompt'), '继续：资产与声音检查')
  assert.equal(buildStudioContinueLabel('binding'), '继续：生成与交付')
  // 前缀不重复：动作名里不许自带「继续」
  STUDIO_PHASES.forEach((phase) => {
    const label = buildStudioContinueLabel(phase.key)
    assert.equal(label.split('继续').length - 1, 1, `阶段 ${phase.key} 的文案里出现了多个「继续」`)
  })
})
