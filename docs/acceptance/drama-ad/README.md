# 剧情广告完整闭环 · 浏览器验收（免费模式）

**结论：14/14 步通过**（`report.json` 里 `steps[].ok` 全为 true，每一步都有页面可见结果 + 接口/数据库旁证）。

- 运行时间：2026-09-27 05:52（本地时区）
- 视口：1440×900（`Emulation.setDeviceMetricsOverride`），点击走 `Input.dispatchMouseEvent` 真实鼠标事件
- 环境：后端 `8123`、前端 `5231`、数据库 `/tmp/jellyfish-ad-mvp/db/ad_mvp.db`（隔离临时库）
- 模式：**演练（dry_run）** —— 本轮**零真实付费调用**；第 3/4 步的产物来自"手写草稿"预置，
  页面按钮仍然真实点击（演练下如实返回"未调用模型"）。脚本用 `--seed-plan` 标注了这一模式。
- 控制台：**0 个未处理错误**

## 截图放哪儿

验收截图（38 个文件，约 6.3 MB）**不进仓库**（此前 `3c260ab` 误提交过一批，已在后续提交中移除）：

    ~/Desktop/jellyfish-drama-ad-evidence/20260927-0552/

其中：`stepNN_*.png` 逐步截图、`report.md` / `report.json` 文本报告、`console.log` 运行日志。
仓库内只保留这份说明与 `report.md` / `report.json`（文本，无凭证、无本机隐私路径）。

## 怎么重跑

    ./backend/.venv/bin/python tools/browser_acceptance_drama_ad.py --seed-plan --out <仓库外的目录>

去掉 `--seed-plan` 并在用户逐次授权后加 `--real-calls`，就是**真实验收**（见末尾说明）。

## 环境版本（本地独立 venv，必须与已验证工作区一致）

后端依赖版本直接决定测试结果：本机独立 venv 一开始装到 `fastapi 0.141.1`，
其 `include_router` **不再把子路由摊平进 `app.routes`**，于是
`test_product_extraction::test_extract_endpoint_is_registered_once_with_paid_outlet_doc`
取到空数组（端点本身在运行中的服务上是可用的）。对齐到已验证工作区的版本后消除：

    fastapi 0.135.1 / starlette 0.52.1 / sqlalchemy 2.0.48 / pydantic 2.12.5
    pytest 9.0.2 / pytest-asyncio 1.3.0 / aiosqlite 0.22.1 / httpx 0.28.1
    uvicorn 0.41.0 / celery 5.6.3 / langchain 1.2.10 / langgraph 1.0.10

前端：`antd ^5.29.3`（源码用了 5.16 才有的 `Card.styles`）+ `@types/node`，
已写入 `package.json` 与 `pnpm-lock.yaml`；`pnpm install --frozen-lockfile` 可复现。
