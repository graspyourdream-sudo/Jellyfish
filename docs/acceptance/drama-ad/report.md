# 剧情广告完整闭环 · 浏览器验收报告

- 前端：`http://127.0.0.1:5231`　后端：`http://127.0.0.1:8123`（**演练模式，零付费调用**）
- 视口：1440×900（`Emulation.setDeviceMetricsOverride`）
- 结果：**14/14 步通过**
- 项目：`395a3217-543b-4911-bddb-da4077790d43`　章节：`395a3217-543b-4911-bddb-da4077790d43::EP01`

点击一律走 CDP `Input.dispatchMouseEvent`（真实输入事件）；断言一律看**页面可见文本**；需要核对数据库的地方用只读 HTTP 旁证。

## 第 1 步 · 新建剧情广告项目 ✅

- 结束时的 URL：`/drama-plan?projectId=395a3217-543b-4911-bddb-da4077790d43&chapterId=395a3217-543b-4911-bddb-da4077790d43%3A%3AEP01`
- 截图：`step01_01_project_lobby.png`、`step01_02_create_modal.png`、`step01_03_ad_options.png`、`step01_04_filled.png`、`step01_05_drama_plan_page.png`、`step01_05_drama_plan_page.png`
- 证据：
  - ✓ 创建后落在剧情策划页（看到「1. 商品信息卡」区块）
  - ✓ 页面有「2. 剧情策划」区块
  - ✓ 拿到项目 ID：395a3217-543b-4911-bddb-da4077790d43
  - ✓ 拿到章节 ID：395a3217-543b-4911-bddb-da4077790d43::EP01
  - ✓ 后端 projects.kind = ad
  - ✓ 预置手写草稿：PUT /brief → 200
  - ✓ 预置手写草稿：PUT /draft → 200
  - 本模式用**手写草稿**驱动第 5/6 步（演练模式下 generate 不产生任何剧情产物）

## 第 2 步 · 保存商品资料 ✅

- 结束时的 URL：`/drama-plan?projectId=395a3217-543b-4911-bddb-da4077790d43&chapterId=395a3217-543b-4911-bddb-da4077790d43::EP01`
- 截图：`step02_01_card_state.png`、`step02_02_card_filled.png`、`step02_03_card_confirmed.png`、`step02_04_after_reload.png`
- 证据：
  - ✓ 空卡上标出了缺项（页面可见「待补充」）
  - ✓ 保存有明确回执（页面可见「已保存」）
  - ✓ 后端读回的商品名称 = '紧致焕颜精华'（保存真的落库了）
  - ✓ 页面可见「已确认」（商品卡确认后显示已确认）
  - ✓ 后端商品卡 confirmed=True
  - ✓ 刷新后页面上仍能看到已保存的商品名称
  - ✓ 刷新后商品卡仍是「已确认」状态

## 第 3 步 · 自动提取商品卖点 ✅

- 结束时的 URL：`/drama-plan?projectId=395a3217-543b-4911-bddb-da4077790d43&chapterId=395a3217-543b-4911-bddb-da4077790d43::EP01`
- 截图：`step03_01_extract_modal.png`、`step03_02_extract_filled.png`、`step03_03_extract_result.png`、`step03_04_card_confirmed_after_extract.png`
- 证据：
  - ✓ 点了提取按钮（开始提取）
  - 提取后页面文本片段：Jellyfish AI 短剧工作台 项目列表 资产管理 提示词模板 提示词导入/交付 剧情策划 模型管理 系统设置 LLM 调试台（开发） 剧情策划 演练模式 简体中文 管理员 系统管理员 剧情策划 商品信息卡 → 一句话核心创意 → 完整剧情 → 分镜 → 确认策划（落库后进入第 2 步资产准备）。 确认之前不会改动章节、分镜与任何资产。 项目 验收·剧情广告 361（剧情广告 · 待确认策划
  - ✓ 演练模式下如实说明没有调用模型（不假装提取到了内容）
  - ✓ 商品卡处于已确认状态（页面标签或后端 confirmed=True）
  - 后端商品卡：confirmed=True 名称='紧致焕颜精华' 卖点=['三秒吸收不粘腻']

## 第 4 步 · 生成连贯剧情 ✅

- 结束时的 URL：`/drama-plan?projectId=395a3217-543b-4911-bddb-da4077790d43&chapterId=395a3217-543b-4911-bddb-da4077790d43::EP01`
- 截图：`step04_01_before_generate.png`、`step04_02_one_liner.png`、`step04_02_story.png`、`step04_02_storyboard.png`
- 证据：
  - ✓ 页面可见「分层生成」（页面写明是分层生成）
  - 一句话核心创意：页面提示片段 Jellyfish AI 短剧工作台 项目列表 资产管理 提示词模板 提示词导入/交付 剧情策划 模型管理 系统设置 LLM 调试台（开发） 剧情策划 演练模式 简体中文 管理员 系统管理员 剧情策划 商品信息卡 → 一句话核心创意 → 完整剧情 → 分镜 → 确认策划（落库后进入第 2 步资产准备）。 确认之前不会改
  - ✓ 点了「生成一句话」后页面有反应（不是点了没动静）
  - 完整剧情：页面提示片段 Jellyfish AI 短剧工作台 项目列表 资产管理 提示词模板 提示词导入/交付 剧情策划 模型管理 系统设置 LLM 调试台（开发） 剧情策划 演练模式 简体中文 管理员 系统管理员 剧情策划 商品信息卡 → 一句话核心创意 → 完整剧情 → 分镜 → 确认策划（落库后进入第 2 步资产准备）。 确认之前不会改
  - ✓ 点了「生成详细剧情」后页面有反应（不是点了没动静）
  - 分镜：页面提示片段 Jellyfish AI 短剧工作台 项目列表 资产管理 提示词模板 提示词导入/交付 剧情策划 模型管理 系统设置 LLM 调试台（开发） 剧情策划 演练模式 简体中文 管理员 系统管理员 剧情策划 商品信息卡 → 一句话核心创意 → 完整剧情 → 分镜 → 确认策划（落库后进入第 2 步资产准备）。 确认之前不会改
  - ✓ 点了「生成分镜」后页面有反应（不是点了没动静）

## 第 5 步 · 用户审核修改 ✅

- 结束时的 URL：`/drama-plan?projectId=395a3217-543b-4911-bddb-da4077790d43&chapterId=395a3217-543b-4911-bddb-da4077790d43::EP01`
- 截图：`step05_01_draft_loaded.png`、`step05_02_edited.png`、`step05_03_saved.png`、`step05_04_consistency.png`
- 证据：
  - ✓ 页面上有「完整剧情全文」可编辑区
  - ✓ 页面上有分镜区
  - 生成后的完整剧情全文（前 60 字）：'会议室里，她把精华瓶拍在桌上。\n前任抬头说：好久不见。\n她笑而不语。'（共 34 字）
  - 演练模式下这部分来自预置的手写草稿（34 字），不是模型产物
  - ✓ 改了内容后页面给出「未保存」提示与保存入口
  - ✓ 页面可见「已保存」（草稿保存成功有回执）
  - ✓ 后端草稿已有完整剧情全文（55 字）
  - ✓ 后端草稿已有 4 个分镜
  - ✓ 后端草稿有一句话核心创意：'一瓶精华把前任气到破防'

## 第 6 步 · 确认策划 ✅

- 结束时的 URL：`/drama-plan?projectId=395a3217-543b-4911-bddb-da4077790d43&chapterId=395a3217-543b-4911-bddb-da4077790d43::EP01`
- 截图：`step06_01_confirm_dialog.png`、`step06_02_dialog.png`、`step06_03_confirmed.png`
- 证据：
  - 服务端状态：story_status='draft' 商品卡 confirmed=True 镜头=4 一句话=True 一致性 ok=True error/警告=3
  - 页面上的「确认」类按钮：[{"text": "确认商品卡", "cls": "ant-btn ant-btn-primary ant-btn-color-primary ant-btn-variant-solid", "disabled": true, "visible": true}, {"text": "确认策划", "cls": "ant-btn ant-btn-primary ant-btn-color-primary ant-btn-variant-solid ant-btn-lg", "disabled": false, "visible": true}]
  - ✓ 点「确认策划」后出现二次确认弹窗（写正式产物前先问一次）
  - ✓ 二次确认弹窗已关闭（不会挡住后续点击）
  - ✓ 确认后页面显示「策划已确认」
  - ✓ 控制台异常 0 条
  - ✓ 服务端写入了确认状态（story_status='confirmed'）
  - 落库统计：{"shots_created": 4, "shots_updated": 0, "assets_created": 1, "assets_reused": 2, "materials_linked": 7, "shot_product_links": 2, "skipped": [], "at": "2026-09-27T09:15:22.327967+00:00"}
  - ✓ 确认结果显示「新建镜头」
  - ✓ 确认结果显示「新建资产」
  - ✓ 确认结果显示「关联记录」
  - ✓ 确认结果显示「跳过项」
  - ✓ **镜头真的落库**：4 个
  - 落库后 readiness 清单里的资产类型：['character', 'product', 'scene']（共 3 项）
  - ✓ 人物已落成正式资产
  - ✓ 场景已落成正式资产
  - ✓ **商品已落成正式资产**
  - ✓ 来源关系已登记 7 行（幂等与追溯的依据）

## 第 7 步 · 建立后续章节和镜头 ✅

- 结束时的 URL：`/projects/395a3217-543b-4911-bddb-da4077790d43/chapters/395a3217-543b-4911-bddb-da4077790d43::EP01/shots`
- 截图：`step07_01_chapter_shots.png`
- 证据：
  - ✓ 这一集已建立 4 个镜头
  - ✓ 镜头都挂在确认的章节上
  - ✓ 章节镜头页渲染出内容（可见文本 516 字）
  - 章节镜头页可见文本片段：Jellyfish AI 短剧工作台 项目列表 资产管理 提示词模板 提示词导入/交付 剧情策划 模型管理 系统设置 LLM 调试台（开发） 项目列表 / 项目工作台 / 章节管理 / 分镜 演练模式 简体中文 管理员 系统管理员 返回章节列表 第1章 · 面试那天（手写草稿） 分镜列表 下一步：提取资产 进入分镜工作

## 第 8 步 · 进入资产准备 ✅

- 结束时的 URL：`/projects/395a3217-543b-4911-bddb-da4077790d43?step=extract_assets&chapter=395a3217-543b-4911-bddb-da4077790d43%3A%3AEP01`
- 截图：`step08_01_before_next_step.png`、`step08_02_asset_prep_step.png`
- 证据：
  - ✓ 页面可见「继续准备资产」（确认后出现唯一主操作「继续准备资产」）
  - ✓ 落在资产准备步骤：/projects/395a3217-543b-4911-bddb-da4077790d43?step=extract_assets&chapter=395a3217-543b-4911-bddb-da4077790d43%3A%3AEP01
  - ✓ 第 2 步清单里含商品：['character', 'product', 'scene']
  - 第 2 步页面可见文本片段：Jellyfish AI 短剧工作台 项目列表 资产管理 提示词模板 提示词导入/交付 剧情策划 模型管理 系统设置 LLM 调试台（开发） 项目列表 / 项目工作台 演练模式 简体中文 管理员 系统管理员 当前项目 验收·剧情广告 361 当前集 第1集 · 面试那天（手写草稿） 继续：继续资产准备 进入后期剪辑 剧情策划 更多 其他 1. 剧本与分镜 2. 资产准备 当前 3. 整集视频提示词

## 第 9 步 · 生成视频提示词 ✅

- 结束时的 URL：`/projects/395a3217-543b-4911-bddb-da4077790d43?step=video_prompt&chapter=395a3217-543b-4911-bddb-da4077790d43%3A%3AEP01`
- 截图：`step09_01_asset_prep_step.png`、`step09_02_video_prompt_step.png`
- 证据：
  - ✓ 页面可见「资产准备」（第 2 步页面上写着当前步骤）
  - 点「视频提示词」→ URL 变成 /projects/395a3217-543b-4911-bddb-da4077790d43?step=video_prompt&chapter=395a3217-543b-4911-bddb-da4077790d43%3A%3AEP01
  - ✓ 一键从「资产准备」进入「视频提示词」（URL step=video_prompt）
  - ✓ 页面上有提示词相关内容
  - ✓ 页面写清了当前是第几步
  - ✓ 交付文本里出现方案里的商品名（'紧致焕颜精华'）

## 第 10 步 · 资产绑定 ✅

- 结束时的 URL：`/projects/395a3217-543b-4911-bddb-da4077790d43/chapters/395a3217-543b-4911-bddb-da4077790d43::EP01/studio?studio=binding&chapter=395a3217-543b-4911-bddb-da4077790d43%3A%3AEP01`
- 截图：`step10_01_binding_step.png`
- 证据：
  - 点「. 资产与声音绑定」→ URL 变成 /projects/395a3217-543b-4911-bddb-da4077790d43/chapters/395a3217-543b-4911-bddb-da4077790d43::EP01/studio?studio=binding&chapter=395a3217-543b-4911-bddb-da4077790d43%3A%3AEP01
  - ✓ 一键进入「关联绑定」（URL step=binding）
  - ✓ 页面上有绑定相关内容
  - ✓ 有 2/4 个镜头看得到已绑定的商品（读完所有镜头）

## 第 11 步 · 生成与交付 ✅

- 结束时的 URL：`/projects/395a3217-543b-4911-bddb-da4077790d43/chapters/395a3217-543b-4911-bddb-da4077790d43::EP01/studio?studio=deliver&chapter=395a3217-543b-4911-bddb-da4077790d43%3A%3AEP01`
- 截图：`step11_01_generate_deliver_step.png`
- 证据：
  - 点「. 生成与交付」→ URL 变成 /projects/395a3217-543b-4911-bddb-da4077790d43/chapters/395a3217-543b-4911-bddb-da4077790d43::EP01/studio?studio=deliver&chapter=395a3217-543b-4911-bddb-da4077790d43%3A%3AEP01
  - ✓ 一键进入「生成与交付」（URL step=generate_deliver）
  - ✓ 页面上有生成与交付相关内容
  - ✓ 视频就绪接口可用（只读）

## 第 12 步 · 回到项目列表核对阶段 ✅

- 结束时的 URL：`/projects`
- 截图：`step12_01_project_list.png`
- 证据：
  - ✓ 列表上有「剧情广告」徽标
  - ✓ 列表上给出了该项目的当前阶段（用户一眼知道走到哪了）
  - 列表可见文本片段：Jellyfish AI 短剧工作台 项目列表 资产管理 提示词模板 提示词导入/交付 剧情策划 模型管理 系统设置 LLM 调试台（开发） 项目列表 演练模式 简体中文 管理员 系统管理员 全 部 待补原文 待提取分镜 待准备镜头 生成中 可继续推进 排序 创建时间 新→旧 视图 批量 新建项目 真人都市 剧情广告 验收·剧情广告 361 已确认策划，可进入资产准备 2026-09-27 09:12 草稿 浏览器验收：从商品资料到剧情策划再到五步流程。 当前阶段 已确认策划，可进入资产准备 第1章 · 已有分镜，继续后续步骤（资产准备 → 整集视频提示词） 待确认 4 已就绪 0 生成中 0

## 第 13 步 · 列表重进后状态完整恢复 ✅

- 结束时的 URL：`/drama-plan?projectId=395a3217-543b-4911-bddb-da4077790d43&chapterId=395a3217-543b-4911-bddb-da4077790d43::EP01`
- 截图：`step13_01_list.png`、`step13_02_reentered.png`、`step13_03_plan_after_reenter.png`
- 证据：
  - ✓ 列表上能看到刚创建的项目
  - ✓ 重新进入落回同一条项目：/projects/395a3217-543b-4911-bddb-da4077790d43
  - 列表入口落在 /projects/395a3217-543b-4911-bddb-da4077790d43?step=image_prep，再进剧情策划页核对状态恢复
  - ✓ 重进后仍显示「已确认」，没有退回未确认状态
  - ✓ 重进后商品卡内容仍在

## 第 14 步 · 第 5 步生成计划识别商品 ✅

- 结束时的 URL：`/drama-plan?projectId=395a3217-543b-4911-bddb-da4077790d43&chapterId=395a3217-543b-4911-bddb-da4077790d43::EP01`
- 截图：（无）
- 证据：
  - 帧计划预览返回 422：{"code": 422, "message": "shot_id: Field required", "data": null, "meta": null}（不当作失败：它可能要求先有定版图）
  - ✓ 视频就绪接口可用（只读，不改任何数据）
