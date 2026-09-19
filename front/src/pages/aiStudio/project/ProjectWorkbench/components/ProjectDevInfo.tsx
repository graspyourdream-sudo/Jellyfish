import { Button, Collapse, Descriptions, Tag } from 'antd'
import type { ProjectStepInput, ProjectStepResolution } from '../projectSteps'
import type { ProjectStepSignalDetail } from '../hooks/useProjectStepSignals'

const SIGNAL_ENDPOINTS = [
  ['章节与原文', 'GET /api/v1/studio/chapters?project_id=…（字段 shot_count / raw_text）'],
  ['镜头与视频提示词', 'GET /api/v1/studio/prompt-delivery/{project_id}?scope=episodes（字段 shot_id / chapter_id / video_prompt）'],
  ['项目角色', 'GET /api/v1/studio/entities/character?page_size=100（字段 project_id / thumbnail / image_prompts）'],
  ['项目场景/道具/服装', 'GET /api/v1/studio/shot-links/{scene|prop|costume}?project_id=…（字段 shot_id / chapter_id / thumbnail）'],
  ['角色镜头绑定', 'GET /api/v1/studio/shots/{shot_id}/preparation-state（字段 assets_overview.summary.linked_count，按镜头抽样）'],
]

const STEP_PRECEDENCE = [
  '1. 没有章节或没有任何章节原文            → script（剧本）',
  '2. 有章节原文但当前集分镜数为 0           → script（剧本）',
  '3. 已有分镜但项目资产（角色/场景/道具）为空 → extract_assets（提取资产）',
  '4. 有资产但没有参考图片/图片提示词        → image_prep（图片准备）',
  '5. 有图片但当前集镜头都没有 video_prompt  → video_prompt（视频提示词）',
  '6. 有提示词但当前集镜头都没有关联资产      → binding（关联绑定）',
  '7. 以上都满足                            → generate_deliver（生成与交付）',
].join('\n')

type ProjectDevInfoProps = {
  detail: ProjectStepSignalDetail
  model: ProjectStepInput
  resolution: ProjectStepResolution
  onReload: () => void
}

/**
 * 「开发信息」折叠区（T5）：把接口路径、字段口径、判定优先级这类技术细节
 * 收进默认折叠的面板，主界面只留用户能看懂的任务/缺失/下一步。
 */
export function ProjectDevInfo({ detail, model, resolution, onReload }: ProjectDevInfoProps) {
  const assetCounts = detail.assetCounts
  return (
    <Collapse
      ghost
      size="small"
      items={[
        {
          key: 'dev',
          label: <span className="text-xs text-gray-500">开发信息</span>,
          children: (
            <div className="space-y-3 text-xs text-gray-600">
              <Descriptions size="small" column={2} bordered={false} colon={false}>
                <Descriptions.Item label="章节数">{detail.chapterCount}</Descriptions.Item>
                <Descriptions.Item label="已有原文章节">{detail.chaptersWithTextCount}</Descriptions.Item>
                <Descriptions.Item label="判定用当前集分镜数">
                  {detail.focusChapterShotCount}
                  {detail.focusChapterId ? `（chapter=${detail.focusChapterId}）` : '（未选定当前集）'}
                </Descriptions.Item>
                <Descriptions.Item label="当前集已填视频提示词">{detail.focusChapterShotsWithPrompt}</Descriptions.Item>
                <Descriptions.Item label="当前集已关联资产镜头">
                  {detail.focusChapterShotsWithLinks}
                  {detail.bindingSampleSize > 0 ? `（角色绑定按前 ${detail.bindingSampleSize} 个镜头抽样）` : ''}
                </Descriptions.Item>
                <Descriptions.Item label="项目镜头总数 / 已填提示词">
                  {detail.projectShotCount} / {detail.projectShotsWithPrompt}
                </Descriptions.Item>
                <Descriptions.Item label="资产数量（角色/场景/道具/服装）">
                  {assetCounts.characters} / {assetCounts.scenes} / {assetCounts.props} / {assetCounts.costumes}
                </Descriptions.Item>
                <Descriptions.Item label="已有参考图片资产数">{detail.assetImageCount}</Descriptions.Item>
                <Descriptions.Item label="已保存图片提示词资产数">
                  {detail.assetsWithImagePromptCount === null
                    ? '无法判定（当前接口载荷未暴露 image_prompts）'
                    : detail.assetsWithImagePromptCount}
                </Descriptions.Item>
              </Descriptions>

              <div className="flex flex-wrap items-center gap-2">
                <span>判定结果：</span>
                <Tag color="blue" className="mr-0">
                  {resolution.step}
                </Tag>
                <span>{resolution.reason}</span>
                <Button size="small" type="link" className="px-1" onClick={onReload}>
                  重新判定
                </Button>
              </div>

              <div>
                <div className="mb-1 font-medium text-gray-500">resolveProjectStep 入参（原始计数）</div>
                <pre className="m-0 overflow-x-auto rounded bg-gray-50 p-2 text-[11px] leading-5">
                  {JSON.stringify(model, null, 2)}
                </pre>
              </div>

              <div>
                <div className="mb-1 font-medium text-gray-500">六步判定优先级</div>
                <pre className="m-0 overflow-x-auto rounded bg-gray-50 p-2 text-[11px] leading-5">
                  {STEP_PRECEDENCE}
                </pre>
              </div>

              <div>
                <div className="mb-1 font-medium text-gray-500">信号来源接口</div>
                <ul className="m-0 list-disc pl-4 space-y-0.5">
                  {SIGNAL_ENDPOINTS.map(([name, endpoint]) => (
                    <li key={name}>
                      <span className="text-gray-500">{name}：</span>
                      <code>{endpoint}</code>
                    </li>
                  ))}
                </ul>
              </div>

              {detail.failedSources.length > 0 ? (
                <div className="text-amber-600">
                  未取到的信号（已按 0/未知降级，判定会停在更靠前的步骤）：
                  {detail.failedSources.join('、')}
                </div>
              ) : (
                <div className="text-emerald-600">全部信号抓取成功。</div>
              )}
            </div>
          ),
        },
      ]}
    />
  )
}
