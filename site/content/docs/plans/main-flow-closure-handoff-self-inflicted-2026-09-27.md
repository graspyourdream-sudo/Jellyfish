# 交接：本分支改动过的缺陷清单（含**我自己引入的**）与各自的守卫测试

> 这份清单比功能列表更有用：它记录了**这一路踩过的坑、每个坑的守卫测试、以及它们的共同模式**。
> 目的：下一位接手的人（或几个月后的我）不必重踩。
> 分支 `feat/main-flow-closure`（基线 `df33a33`），验收对照见 `main-flow-closure-acceptance-2026-09-27.md`。

## 一、我自己引入、又自己修掉的（4 条）

| # | 缺陷 | 症状 | 根因 | 修复 | 守卫 |
|---|---|---|---|---|---|
| 1 | **"明确成功"就跳过详情查询** | 成功但 create 回包没带地址的结果，`oss_url`/`image_url` 全丢 → 结果卡片给不出「采纳」，**一张真出好的图等于白丢** | 我在 `submit_targets` 里把判据写成"是不是成功"，而真正要问的是"**有没有拿到产物地址**" | `4da5890`（改成"明确成功 **且** 回包里已有地址"才跳过） | `test_image_partial_recoverable.py::test_successful_create_without_address_still_fetches_detail`、`…::test_batch_submit_without_wait_still_fetches_detail_once` |
| 2 | **采纳/设定版判定漏了 `oss_url`** | 正常成功的结果（地址在 `oss_url`、`image_url` 为空）**既没有「采纳」也没有「设为定版」**，只剩「查看详情」 | 同上：按"某一类结果长什么样"写死，只认 `imageUrl` | `4dd5610`（抽出 `hasUsableResultAddress`，把临时/长期/已采纳三个字段都认） | `assetStorageReachability.test.ts`（正常成功可采纳 / 可定版 / 都没有地址则两个入口都不给） |
| 3 | **"没拿到图地址"是误报** | 后端明明回了可取回地址，卡片却写「没有拿到可用的图地址」——把"能救"说成"救不了" | 那条提醒是**无条件**追加的；而且查询路径那次调用**漏传**了地址字段 | `1d15de1` + `e646b7a`（按结果里到底有没有可用地址分支；并把 `local_path` 一并传入） | 同文件 4 支（有地址不说"没拿到"、真没有才说、`local_path` 也算） |
| 4 | **测试白名单过窄**（连带） | 上面两条修复让成本链路"零出站"守卫用例失败 | 白名单按 `endswith` 匹配，而详情查询路径带任务号 | `eef0e94`（改为前缀/包含匹配，只放行健康检查与任务详情两类**只读**调用） | `test_costume_production_chain.py`（零出站守卫本身） |

## 二、基线既有、本分支修掉的（5 条，都是同一类"写死判据"）

| # | 缺陷 | 症状 | 修复 | 守卫 |
|---|---|---|---|---|
| 5 | `canAdopt = status === 'done'` | **部分成功**（图已生成、只是长期存储失败）的结果没有「采纳」入口——而那正是花了钱最该救回来的 | `4b9b2c8` | `assetStorageReachability.test.ts::部分成功且图可取 → 可以采纳` |
| 6 | `canSetPrimary = status === 'done'` | 同上：采纳进来也**设不了定版**，卡在最后一步 | `8e2591e` | 同文件::`部分成功必须能设成定版` |
| 7 | `_load_asset_rows` 的三条 join **没有 `distinct()`** | 同一资产在关联表里有多行（章节级 + 镜头级，**属设计**）→ 被装成两个 target → 两次 create、结果区两条相同项 | `5809696`（**按"可能双倍付费"的严重度修**：真实上游幂等去重，但换一个不去重的上游就是双倍计费） | `test_asset_load_dedupe.py`（源码守卫：三条 join 分支都必须 distinct） |
| 8 | 第 2 步**类型切换根本没接线** | `onSelectTab` 作为 prop 收进来却**从未被调用** → 资产网格永远只显示「人物」，场景/道具/服装只有计数、点不动 | `5050452` | `assetTypeSwitcher.test.ts`（源码守卫） |
| 9 | 出图前无存储预检 | 上游"出图成功但 OSS 403"时**钱已经花了**，资产却拿不到 | `55736ce`（免费预检，明确否定证据才拦） | `test_image_storage_precheck.py` |
| 10 | "存储失败"与"生成失败"混为一谈 | 存储失败但产物还在 → 只报「生成失败」，用户以为白花钱、也不会去采纳 | `6fd6c4d`（`recoverable_artifact` → 部分成功）、`47252a8`（拿不到时如实说明"可能已计费"） | `test_image_partial_recoverable.py` |

## 三、不是代码问题、但同样重要的一条：**验收脚本本身会骗人**

- **`采 纳` 中间有一个空格**：antd 默认会在**两个汉字**的按钮标签里插空格（`autoInsertSpaceInButton`）。
  我的 Playwright 脚本一直用 `/^采纳$/` 匹配 → **从来没匹配到**，于是我连续三轮误报"页面没有采纳按钮"。
  用 DOM 打出按钮原文（`72-card-probe.json`）才看见真相：**功能一直都在**。
- **教训**：**文本匹配前必须先把真实文本打出来核对**；把"我的检查没匹配到"当成"产品没做"是最坏的误判方向。
- 同类还有两次：按 `button/[role=tab]` 猜"类型页签"（实际是 `ant-tag`）、按 `5.生成与交付` 猜文案
  （实际是 `5. 生成与交付`，点后有空格）。三次都是同一个毛病：**先写选择器、后看 DOM**。
- 已固化的做法：**先探针（DOM/接口原文）→ 再写选择器/断言**；证据索引里保留 `65/67/72/77` 这几个探针文件就是为了下次能直接查。

## 四、这些坑的共同模式（写给未来的我）

1. **按"数据长什么样"写判据，而不是按"这一层要回答什么问题"** —— #1/#2/#5/#6 全是。
   这一层要回答的是「**有没有可用的产物地址**」「**这张图能不能救**」，不是「成功还是失败」「字段叫 imageUrl 还是 ossUrl」。
   → 现在的写法：`hasUsableResultAddress()` 把**所有可能承载该信息的字段**过一遍。
2. **"条件写死在前端组件里"** —— #5/#6 都是。现在这类判定一律走 `assetProduction.ts` 里的**纯函数**，可单测、可复用。
3. **静默失败**：`updateTask` 按 key 匹配、`onSelectTab` 收了不用 —— 这类"不报错但没生效"最难查。
   → 源码守卫测试（`assetTypeSwitcher.test.ts`、`test_asset_load_dedupe.py`）专门盯这种。
4. **"改了没重启"**：第 38 轮我自己就把**旧后端进程**的结果当成"修复无效"。
   → 验证前先确认进程是新代码（或用 `git log -1` + 启动时间对齐）。
5. **别把"我的检查失败"当"产品失败"**：见第三节。**先取证，再下结论**。

## 五、守卫测试清单（一次跑全）

```bash
cd /Users/apple/Documents/jellyfish-flow/backend
.venv/bin/python -m pytest tests/test_video_submit_idempotency.py tests/test_image_partial_recoverable.py \
  tests/test_image_storage_precheck.py tests/test_image_reachability.py tests/test_asset_load_dedupe.py -q
cd ../front
node --test src/pages/aiStudio/project/ProjectWorkbench/components/assetStorageReachability.test.ts \
          src/pages/aiStudio/project/ProjectWorkbench/components/workbench/assetTypeSwitcher.test.ts
```
