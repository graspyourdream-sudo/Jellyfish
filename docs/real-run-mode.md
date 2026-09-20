# 本地切换「演练模式 / 真实模式」操作手册

> 适用版本：本仓库当前分支（FastAPI 后端 + React 前端）。
> 相关代码：`backend/app/services/studio/llm_orchestration/dry_run.py`（守卫本体）、
> `backend/app/services/paid_outlet_guard.py`（把老链路也接到同一套闸门）、
> `GET /api/v1/studio/llm/orchestration/status`（状态接口）、
> 前端角标 `front/src/pages/aiStudio/components/RealRunModeBadge.tsx`。

---

## 0. 一句话结论

- **默认就是演练模式**：不发任何真实请求、不产生任何费用。删掉环境变量就回到这个状态。
- **切到真实模式只需两件事**：在**启动后端的那个终端**里 `export` 两个环境变量，然后**重启后端进程**。
- 页面右上角角标和状态接口都会如实告诉你现在是哪一种模式；被守卫拦住时，接口返回的错误里
  直接带「原因 + 怎么开」。

| 模式 | 判定条件 | 行为 |
| --- | --- | --- |
| 演练模式（默认） | `JELLYFISH_DRY_RUN` 未设置 / `1` / `true` / `yes` / `on` | 四个付费出口全部拦截，返回占位结果，**零费用** |
| 真实模式（未确认） | `JELLYFISH_DRY_RUN=0` 但 `JELLYFISH_REAL_LLM_CONFIRMED` 不是 `1` | 仍然拦截，原因明确写「缺少付费确认」 |
| 真实模式 | `JELLYFISH_DRY_RUN=0` **且** `JELLYFISH_REAL_LLM_CONFIRMED=1` | 允许真实调用，**会花钱**，成本确认/限额/去重仍生效 |

---

## 1. 前置条件

1. 后端依赖与数据库就绪（`cd backend && uv sync`，`uv run python init_db.py`）。
2. 要用到的出口必须先在「模型管理」里配好：默认文本模型 / 图片模型 / 视频模型，
   以及它们挂的供应商（`api_key`、`base_url`）。**没配置的出口即使开了真实模式也会失败。**
3. 想清楚费用：真实模式下每一次调用都按供应商计价（大模型按 token、出图按张、出视频按次、
   OSS 按存储与流量）。
4. 真实模式下建议**单独一个终端**跑后端，方便用完立刻关回演练。

---

## 2. 怎么开真实模式

### 方式 A：临时开（推荐，用完立刻关）

在**启动后端的那一个终端**里执行（两个变量必须在同一个 shell 里）：

```bash
cd /path/to/仓库根/backend
export JELLYFISH_DRY_RUN=0
export JELLYFISH_REAL_LLM_CONFIRMED=1

# 然后启动后端（这条就是仓库 README 里那条命令）
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

跑完之后，**在这个终端里**关回演练（见第 4 节），再重启。

> ⚠️ **为什么必须重启**：守卫在每一次真实动作前都会读当前进程的环境变量，但**外部改不了
> 已经启动的进程的环境**。所以在另一个终端 `export`、或者改完不重启，都不会生效。

### 方式 B：用仓库自带的启动脚本（自带二次确认与模式回显）

```bash
bash backend/scripts/run_backend.sh --status   # 只看当前 shell 里的模式判定，不启动
bash backend/scripts/run_backend.sh            # 演练模式启动（默认，安全）
bash backend/scripts/run_backend.sh --real     # 真实模式启动，需要按提示确认一次
bash backend/scripts/run_backend.sh --real --yes   # 非交互环境（CI/脚本）用
```

脚本只做三件事：设好两个变量 → 打印当前模式 → `exec uv run uvicorn ...`。
它**不改**默认启动方式，不用它也一样能跑（方式 A 就是等价的）。

### 方式 C：容器 / 部署环境

把这两个变量写进容器的环境变量（`deploy/` 下的 compose 或编排配置的 `environment:`），
**不要**指望 `.env`（见第 6 节第一个坑）。

---

## 3. 怎么确认现在是哪种模式

三种方式，任选其一，结论一致：

**① 状态接口（最权威）**

```bash
curl -s http://localhost:8000/api/v1/studio/llm/orchestration/status | python3 -m json.tool | head -40
```

重点看 `data` 里的这几个字段：

| 字段 | 含义 |
| --- | --- |
| `mode` | `dry_run` / `real_unconfirmed` / `real` |
| `mode_label` | 中文模式名：`演练模式` / `真实模式（未确认）` / `真实模式` |
| `is_real_mode` | 是否真的放行（只有两个开关都对才是 `true`） |
| `guard.dry_run` / `guard.real_call_confirmed` | 两个开关的实时取值 |
| `outlet_states[]` | 四个出口（大模型/出图/出视频/对象存储上传）各自 `allowed` 与拦截原因 |
| `enable_steps` / `restore_steps` | 中文的开启步骤与恢复步骤 |
| `dry_run_audit` | 最近的拦截/放行审计（排查「刚才为什么没发出去」） |

**② 页面角标**：打开前端，右上角有「演练模式」/「真实模式」标签，点开可以看到每个出口的
放行情况、开启步骤，以及最近被拦截的记录。

**③ 不启动服务，只看环境变量判定**

```bash
cd backend && uv run python - <<'PY'
from app.services.studio.llm_orchestration import dry_run
print(dry_run.mode_label(), dry_run.mode())
print(dry_run.state())
PY
```

---

## 4. 怎么关回演练模式

在**启动后端的终端**里：

```bash
unset JELLYFISH_DRY_RUN JELLYFISH_REAL_LLM_CONFIRMED
# 或者显式写死：export JELLYFISH_DRY_RUN=1
```

重启后端进程，然后按第 3 节确认：`data.mode` 应该是 `dry_run`、`data.guard.dry_run` 应该是
`true`，页面角标回到「演练模式」。

> 想更保险：`JELLYFISH_DRY_RUN` 只要不设置（或设成任意非 0/false/no/off 的值）就是演练模式；
> 取值读不懂时一律按**演练**处理（fail-safe）。

---

## 5. 真实模式下**依然存在**的成本约束（没有放开撒钱）

开真实模式只是把「演练闸门」放开，下面这些钱相关的保护**一条都没少**：

1. **调用前的确认弹窗 / 二次确认**：批量生成资产图片提示词时，默认只勾选缺失的资产
   （最多 3 个，`DEFAULT_SELECT_LIMIT`），要放大批量必须手动「全选缺失」；一旦超过 10 个
   （`CONFIRM_THRESHOLD`）会先弹一次「确认对 N 个资产调用大模型生成提示词？每个资产一次调用
   （会花钱）」再执行。相关代码：`front/src/pages/aiStudio/project/ProjectWorkbench/components/AssetImagePromptLlmPanel.tsx`。
2. **批量上限与中断**：批量任务是**逐条串行**调用，随时可以点「停止后续」（当前这条跑完，
   后续不再开始）；失败的可以单独「重试失败项」，不会连带重跑已成功的。
3. **去重 / 幂等**：
   - 出图提交带上稳定幂等键 `source_task_id = jellyfish:{project_id}:{asset_type}:{asset_id}:{sha1(prompt)[:8]}`，
     同一项目 + 同一资产 + 同一提示词重复提交会被出图服务识别为**同一个任务**，不会重复出图
     （`backend/app/services/studio/image_pipeline/image_pipeline.py:build_source_task_id`）。
   - 默认「只勾选缺失资产」「已有提示词的会被跳过」，避免把已经做过的事再做一遍。
   - 视频提示词的动作节拍合并去了重（`_dedupe_keep_order`，上限 4 条），避免同义重复堆数量。
4. **出口级闸门**：任务是「先建行、后执行」的，执行入口还会再查一次
   （`paid_outlet_guard.task_kind_block_reason`）：即使有人绕过了接口层建出 `image_generation`
   / `video_generation` 任务，回放时也会被守卫拦下并标记失败，不会真花钱。
5. **出站兜底**：`install_network_guard()` 给 `httpx` 打的补丁**只在演练模式下**掐断非本机出站；
   真实模式下不再拦截出站，所以第 1 节的「配好模型/供应商」才是硬前提。

> 结论：真实模式 ≠ 免确认。它只是让你能成功调用；确认、限额、去重三件事照旧。

---

## 6. 常见坑

1. **把两个变量写进 `backend/.env` —— 不生效。**
   `.env` 只被 pydantic-settings 读进 `Settings`（数据库、存储等配置），**不会**进入
   `os.environ`，而守卫读的是进程环境变量。必须 `export`、用启动脚本，或写进容器环境。
   这是踩坑最多的一条：`.env` 里写了 `JELLYFISH_DRY_RUN=0`，接口仍报「演练模式」。
2. **只设了一个变量。** 只设 `JELLYFISH_DRY_RUN=0` 会停在「真实模式（未确认）」，
   错误原因写的是 `real_call_not_confirmed`，仍然不会发真实请求——这是设计如此，不是 bug。
3. **改完环境变量没重启进程。** 包括 `--reload` 的情况：`--reload` 只在**代码变更**时重启，
   环境变量变了必须自己重启（`Ctrl+C` 再起）。
4. **worker / Celery 进程是另一套环境。** 如果真实调用由 worker 执行，**worker 进程**也必须
   带上这两个变量，否则任务会在执行入口被拦下并标记失败。
5. **前端角标显示「模式未知」。** 说明读不到状态接口：后端没起、端口不对
   （默认 `http://localhost:8000`，可用 `VITE_BACKEND_URL` 覆盖），或 CORS 拦住了。
   在确认之前请按「不会真花钱」对待。
6. **只关掉 `JELLYFISH_DRY_RUN` 而忘了确认变量**，或者反过来把确认变量设成 `0`/`no`，
   都不算开启（`real_call_confirmed` 只认 `1/true/yes/on` 这类真值）。
7. **演练模式下有些接口会返回占位产物**（例如 `dry-run.invalid` 域名下的图片地址、
   `status: dry_run` 的任务）。这些地址不可访问是**预期行为**，不要当成故障去"修"。
8. **别把真实模式当默认。** 需要付费的验证请开一个独立终端、用完立刻关回演练；
   提交代码时不要带任何真实开关的环境文件。

---

## 7. 相关测试（都不会产生真实费用）

```bash
# 后端：模式判定 / 出口放行 / 结构化拦截错误 / 状态接口
cd backend && DATABASE_URL="sqlite+aiosqlite:////tmp/jf_test.db" \
  uv run python -m pytest -q tests/test_dry_run_real_mode.py tests/test_paid_outlet_guard.py -p no:cacheprovider

# 前端：模式解析与拦截错误解析（纯逻辑）
cd front && node --test src/pages/aiStudio/components/realRunModeCore.test.ts
```

守卫相关代码的位置速查：

| 关注点 | 位置 |
| --- | --- |
| 开关判定、模式、中文步骤 | `backend/app/services/studio/llm_orchestration/dry_run.py` |
| 拦截异常与结构化 409 | `backend/app/services/paid_outlet_guard.py`、`backend/app/main.py` |
| 状态接口 | `backend/app/api/v1/routes/studio/llm_orchestration.py`（`GET /api/v1/studio/llm/orchestration/status`） |
| 前端角标 | `front/src/pages/aiStudio/components/RealRunModeBadge.tsx` |
| 前端纯逻辑 | `front/src/pages/aiStudio/components/realRunModeCore.ts` |
| 前端接口封装 | `front/src/services/orchestrationStatusApi.ts` |
| 本地启动脚本 | `backend/scripts/run_backend.sh` |
