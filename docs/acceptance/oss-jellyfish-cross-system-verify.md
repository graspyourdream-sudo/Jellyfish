# Jellyfish × 上游出图服务 跨系统验收记录（已有图片 · 读取→采纳→定版→刷新恢复）

基线：`feat/integrate-main-flow-and-drama-ad` @ `2158127f5bde0bcc3d5ef9c0099c41fe27c63ee4`
上游：`127.0.0.1:4173`（人物及场景生产项目）· 任务 `9741efcd-ce9b-47ce-b013-0d1437ce25c2` · 资产 姜岁欢
Jellyfish：`127.0.0.1:8130`（后端，隔离库副本）/ `127.0.0.1:5280`（前端）
本轮**未涉及任何真实付费调用**，也**未对上游 OSS 做任何写入**。

## 一、结论

| 环节 | 结果 |
| --- | --- |
| 上游任务接口 | `status=completed`；图片匿名 `HTTP 200` / `image/png` / 449,837 字节 |
| 页面读取结果 | ✅ 通过页面正式入口读取，结果图 `src` 即上游 OSS 公网地址 |
| 采纳 | ✅ 只新增 1 个文件 + 1 条使用关系 + 1 个人物图片槽位；**不静默设版** |
| 设为定版 | ✅ 该资产恰好 1 张主图（新槽位），旧槽位保持非定版 |
| 409 防覆盖负例 | ✅ 返回结构化 409（`primary_image_replace_required`），**前后库状态逐字一致** |
| 刷新 + 从项目列表重入 | ✅ 仍显示已采纳/已定版，页面正常渲染 |
| 调用计数 | 0 文本模型 / 0 出图 / 0 视频 / 0 上游 OSS PutObject / 0 DeleteObject |

## 二、定位到并修复的两个适配缺口

1. **页面没有"读取历史任务"的入口**：任务号只活在浏览器内存 / localStorage（按 origin 隔离），
   幂等键又依赖从未落库的提示词（实测 sha1(提示词)[:8] = `6738c1c1`，而该提示词与
   `service_task_id` 在全库 41 张表中零痕迹）。
   → 修复：`AssetProductionArea.tsx` 增加只读入口（选资产 + 填出图结果编号 + 读取结果），
   命中后进入**既有**结果卡片，采纳/定版复用既有逻辑。
2. **只读查询被绑在付费出图出口上**：`GET task` 与真实出图提交共用 `outlet="image"`，
   真实模式下不打开 `JELLYFISH_REAL_LLM_CONFIRMED=1` 就读不到任何已有任务的产物，
   而打开它又会同时放开真实出图提交。
   → 修复：新增不计费只读出口 `OUTLET_IMAGE_READ`（`dry_run.READ_ONLY_OUTLETS`）：
   只读请求不要求付费确认、也不占用收费出口白名单；DRY_RUN 一层照旧先生效。
   `_request_json` 按方法分流（GET → 只读，POST → 计费）。

## 三、数据库对账（隔离副本，主库只读未动）

| 指标 | 采纳前 | 采纳后 | 定版后 | 变化原因 |
| --- | --- | --- | --- | --- |
| `files` | 138 | 139 | 139 | 采纳把上游图下载入库，新增 1 个文件记录 |
| `file_usages` | 24 | 25 | 25 | 采纳同时登记 1 条使用关系 |
| `character_images`(姜岁欢) | 1 | 2 | 2 | 采纳新增槽位 #46；旧槽位 #19 保留 |
| 唯一主图 `is_primary=1` | 0 | 0 | **1** | 采纳默认不设版；「设为定版」把 #46 置为主图，#19 保持 0 |
| 上游任务总数 | 697 | 697 | 697 | 读取不创建任务；全程无提交出图 |
| 上游 OSS 写入 | — | 0 | 0 | 未调用任何 PutObject / DeleteObject |

409 负例前后 `files` / `file_usages` / `character_images` / `is_primary` **逐字一致**（零副作用）。

## 四、测试

- 后端 `tests/test_image_read_outlet_separation.py`（新增）：6 passed —— 锁定只读出口放行、
  付费出口仍需确认、DRY_RUN 优先拦截、`_request_json` 按方法分流。
- 前端 `assetProductionReadEntry.test.ts`（新增）：4 passed —— 入口存在、只复用既有只读接口、
  读取路径无任何提交出图调用。
- 相关既有后端测试：`test_image_pipeline` / `test_primary_protection_and_retry` /
  `test_adopt_generated_image` / `test_image_reachability` / `test_llm_orchestration_dry_run` 等
  91 + 9 passed，无新增失败。
- 前端全量：789 tests / 789 pass / 0 fail；`tsc --noEmit` 0 错误；`vite build` 成功。

## 五、安全状态（收尾）

以**默认配置**启动（不设 `JELLYFISH_DRY_RUN=0`，fail-safe）：`dry_run=true`、
`real_call_confirmed=false`、`mode=dry_run`；`llm` / `image` / `video` / `oss`
四个出口 `outlet_allowed` 全为 `False`（blocked），只读出口在演练模式下同样被 DRY_RUN 拦截。

## 六、遗留与说明

- 采纳后该图按产品设计落进 **Jellyfish 自己的存储**（存储驱动 `local`，未配
  `s3_public_base_url`），因此刷新后页面加载的是后端本地副本；上游 OSS 公网地址是它的
  来源记录（读取阶段已实测匿名 `HTTP 200`）。
- 上游 OSS 的对象数无法用当前最小策略列桶统计（未授予 ListObjects）；写入为 0 的结论
  来自"无任何 PutObject/DeleteObject 代码路径被执行 + 上游任务集未变"。
- 本轮截图与运行日志按要求存放在仓库外（`/tmp/jf_verify/shots/`），仓库内只有本文件。
