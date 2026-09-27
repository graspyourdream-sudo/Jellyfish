# 闭环验收 · 证据速查（一页）

> 目标：**不必翻 60+ 个证据文件**，直接从"验收点"跳到"看哪个文件"。
> 目录：`~/Desktop/jellyfish-flow-evidence/`（共 123 个文件；下表只列每格的**代表作**）。
> 配套：`main-flow-closure-acceptance-2026-09-27.md`（对照表）、`main-flow-closure-status-2026-09-27.md`（流水账）。

## A. 两条起步路径 × 五步（每步 1 张图 + 1 份文本快照）

| 步 | 剧本起步（`63-*`） | 提示词起步（`66-*`） | 该格要看的结论 |
|---|---|---|---|
| 1 剧本与分镜 | `63-steps-1-剧本与分镜.png`、`63-steps-1-剧本与分镜.txt` | `66-prompt-start-1-剧本与分镜.png`、`66-prompt-start-1-剧本与分镜.txt` | 提示词路径显示 **`1. 剧本与分镜（已跳过：提示词起步）`** |
| 2 资产准备 | `63-steps-2-资产准备.png`、`63-steps-2-资产准备.txt` | `66-prompt-start-2-资产准备.png`、`66-prompt-start-2-资产准备.txt` | `已定版 1`、`资产准备未完成：提示词 / 图片 / 定版还有缺口`、`下一步：去确认剧本里提取到的资产…` |
| 3 整集视频提示词 | `63-steps-3-整集视频提示词.png`、`63-steps-3-整集视频提示词.txt` | `66-prompt-start-3-整集视频提示词.png`、`66-prompt-start-3-整集视频提示词.txt` | `逐镜状态（服务端草稿 · 刷新/中断都不丢）`、`可重试 N 镜（已完成的不会重发）` |
| 4 资产与声音绑定 | `63-steps-4-资产与声音绑定.png`、`63-steps-4-资产与声音绑定.txt` | `66-prompt-start-4-资产与声音绑定.png`、`66-prompt-start-4-资产与声音绑定.txt` | `已绑定资产 1`、`⑤ 本镜还缺什么` |
| 5 生成与交付 | `63-steps-5-生成与交付.png`、`63-steps-5-生成与交付.txt` | `66-prompt-start-5-生成与交付.png`、`66-prompt-start-5-生成与交付.txt` | `本镜还缺 3 项`、`可交付 1 条`、`复制交付文本` |

## B. 刷新 / 重进不丢（三种独立证据）

| 对象 | 看这里 | 结论 |
|---|---|---|
| 视频任务（第 5 步） | `61-recovery-2-panel6-video-visible.png`、`61-recovery-page-text.txt` | 全新页面里主预览播放器载入该视频（`0.0 / 12.0s`）、显示「已生成视频」 |
| 定版（第 2 步） | `80-5-fresh-session-scene.png`、`80-after-reload.txt` | 全新会话里场景卡片显示「南安侯府大堂 场景 **已定版**」（库里 `is_primary=1`） |
| 服务端草稿（第 3 步） | `63-steps-3-整集视频提示词.txt` | `在服务端草稿 · 刷新/中断都不丢` + `从服务端恢复草稿` |

## C. 真实付费调用（按审批执行，无重试）

| 事项 | 看这里 | 结论 |
|---|---|---|
| 出视频 1 次（S001） | `60-paid-1-open.png` … `60-paid-4-after-reload.png`、`60-paid.log` | `task_01M3GK5WC8EEWWETFT4CZFA82J`、170s、`status=completed`、写回 `shots.generated_video_file_id` |
| 出图 1 次（苏晚棠） | `50-authorized-image-1-before.png` … `50-authorized-image-6-after-reload.png`、`51-image-outcome.*`、`52-primary-verify.*` | 上游 OSS 403 → 本机图保留 → 采纳 → 定版 |
| 出图 1 次（乌鸦） | `69-adopt-loop.log`、`69-after-generate.txt` | 上游再次 403；上游任务 `b6011f60-…` 判 `partial_failed`、本机图可取回 |
| 一次"未花钱的尝试" | `70-free-adopt.log` | 演练模式下被守卫拦在本地，**无调用** |

## D. 四类口径（①②③④）

| 口径 | 看这里 | 结论 |
|---|---|---|
| ① 免费存储预检 | `62-storage-precheck-real-upstream.txt` | 真实上游只报 `configured/…`、**不报可写性** → 预检如实降级并写明需上游补探测 |
| ② 部分成功 + 可恢复 | `71-stub-loop-2-result.png`、`70-after-generate.txt`（第 26~29 轮脚本把文本快照写死在 70- 前缀） | `outcome=partial_failed` + 可取回地址；卡片给「采 纳」 |
| ③ 采纳 → 设为定版 → 复核 | `80-1-result.png`（按钮含「采 纳 / 设为定版」）、`80-3-primary.png`、`80-5-fresh-session-scene.png` | `POST /adopt` 200（`image_id=53`）→ 设主图 200（`is_primary:true`）→ 全新会话已定版 |
| ④ 定版不可用时显式标记 | `64-asset-row-badge.png`、`64-asset-row-badge.txt`、`77-tab-probe.json` | 苏晚棠定版带「仅本机 · 不能用于后续生成」；公网地址的结果卡片**不打**该标 |

## E. 结构/取证类（解释"为什么"用）

| 主题 | 看这里 |
|---|---|
| 第 2 步类型切换修复（场景/道具/服装可达） | `77-tab-probe.json`、`78-1-result.png`、`79-scene3.log` |
| 结果卡片按钮真实文本（antd 给两字按钮插空格） | `72-card-probe.json`（`["采 纳", …]`） |
| 步骤页签真实 DOM | `67-step5-probe.json` |
| 第 5 步演练（未花钱） | `59-rehearsal-1-open.png` … `59-rehearsal-3-after-submit.png`、`59-rehearsal-page-text-after.txt` |

## F. 复核命令（不需要我，任何人可跑）

```bash
cd /Users/apple/Documents/jellyfish-flow
git diff --stat df33a33..HEAD -- front/openapi.json      # 应为空（未 regen）
git diff --name-only df33a33..HEAD | wc -l               # 48 个路径（见验收文档 §0.5 审计）
git status --short                                        # 应为空
cd backend && .venv/bin/python -m pytest tests/ -q        # 1365 passed / 13 failed（13 个为基线既有的 meta 过期用例）
cd ../front && ./node_modules/.bin/tsc --noEmit           # 195 错，全部为既有两类根因（缺 @types/node、antd 版本）
```
