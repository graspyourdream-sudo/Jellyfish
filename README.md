# Jellyfish — AI Short Drama Studio

<p align="center">
  <img src="./docs/img/logo.svg" alt="Jellyfish Logo" width="160" />
</p>

<p align="center">
  <a href="https://www.apache.org/licenses/LICENSE-2.0">
    <img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License" />
  </a>
  <a href="https://img.shields.io/badge/frontend-React%20%2B%20Vite-61DAFB">
    <img src="https://img.shields.io/badge/frontend-React%20%2B%20Vite-61DAFB" alt="Frontend" />
  </a>
  <a href="https://img.shields.io/badge/backend-FastAPI-009688">
    <img src="https://img.shields.io/badge/backend-FastAPI-009688" alt="Backend" />
  </a>
  <a href="https://github.com/Forget-C/Jellyfish/actions/workflows/deploy-site.yml">
    <img src="https://github.com/Forget-C/Jellyfish/actions/workflows/deploy-site.yml/badge.svg" alt="Deploy Site" />
  </a>
  <a href="https://github.com/Forget-C/Jellyfish/actions/workflows/ghcr-images.yml">
    <img src="https://github.com/Forget-C/Jellyfish/actions/workflows/ghcr-images.yml/badge.svg" alt="Build and push images" />
  </a>
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./docs/README.ja.md">日本語</a>
</p>

An end-to-end production workspace for AI-generated short dramas.  
From script input to structured storyboarding, consistency management,
shot preparation, video generation, and export.

## 📷 Screenshots

| Project overview | Asset management |
| --- | --- |
| <img src="./docs/img/project.png" alt="Project overview" width="420" /> | <img src="./docs/img/%E8%B5%84%E4%BA%A7%E7%AE%A1%E7%90%86.png" alt="Asset management" width="420" /> |

## ✨ Core Value

- **Connect the full production flow**: Move from script input to storyboard preparation, image/video generation, and task tracking in one place.
- **Turn AI output into reusable production assets**: Shots, candidate assets, dialogue, prompts, and generation tasks can all be reviewed and reused.
- **Treat consistency as a first-class problem**: Centralized character, scene, prop, and costume management reduces drift across shots.
- **Handle long-running generation as trackable tasks**: Text, image, and video jobs all go through one async task system with status, cancel, and recovery.
- **Build AI capability as infrastructure**: Model management, prompt templates, files, and OpenAPI-based collaboration make the system extensible.

## ✨ Core Capabilities

Jellyfish is not just a single “AI image/video” utility. It is a
production workspace built around:

- script understanding
- shot preparation
- asset consistency
- generation execution
- task tracking

### 1. AI script understanding and storyboard breakdown

- Split chapter scripts into shots
- Extract characters, scenes, props, costumes, and dialogue
- Run script optimization, simplification, and consistency checks
- Support targeted analysis such as character portraits or scene details

### 2. Shot preparation and confirmation workflow

The main workflow is:

`script breakdown → shot preparation → candidate confirmation → shot ready → generation workspace`

Preparation currently supports:

- extracting and refreshing shot candidates
- accepting or ignoring asset candidates
- accepting or ignoring dialogue candidates
- linking existing characters, scenes, props, and costumes
- correcting shot-level basic information
- using a unified readiness state to decide whether a shot is prepared

### 3. Asset consistency and reuse

The system maintains a shared entity model across:

- characters / actors
- scenes
- props
- costumes

This supports asset reuse across shots and helps stabilize style and identity.

### 4. Shot-level image and video orchestration

Once a shot is `ready`, the generation workspace supports:

- keyframe and reference image management
- shot-level video prompt preview
- image and video generation tasks
- single-shot and batch pre-checks
- writing generation outputs back into the shot/media system

### 5. Unified async task center

Current task infrastructure supports:

- async text-processing tasks
- async image and video generation tasks
- unified task status, result, and elapsed-time tracking
- task cancellation
- a global task center with context-aware navigation back to project/chapter/shot

### 6. Model, prompt, and generation infrastructure

Supporting capabilities include:

- multi-provider / multi-model management
- default model settings by category
- prompt template management
- file and generated media management
- OpenAPI-driven frontend/backend contracts

## 🚀 Feature Overview

### Project and chapter management

- Create and manage projects and chapters
- Use chapters as the unit for scripts, shots, and generation
- Provide dashboard-style entry points and aggregated stats

### AI script processing

- Break chapter scripts into shots
- Extract characters, scenes, props, costumes, and dialogue
- Support optimization, simplification, and consistency checks
- Support focused analysis such as character portraits or scene information

### Shot preparation workflow

- Edit shot title, summary, and basic information
- Refresh extracted asset and dialogue candidates
- Confirm, ignore, or link candidate items
- Use preparation state to determine shot readiness
- Keep “prepared” distinct from “currently generating”

### Asset and entity management

- Manage characters, actors, scenes, props, and costumes
- Link and reuse them at shot level
- Manage entity images
- Check name existence to encourage reuse of existing assets

### Shot generation workspace

- Manage keyframes, reference images, and video prompts
- Check video readiness before generation
- Launch image/video generation tasks
- Support both single-shot and batch generation workflows

### Task center

- View active and recently finished tasks
- Track status, progress, elapsed time, and results
- Cancel tasks
- Jump back to the related project, chapter, or shot

### Model and prompt infrastructure

- Manage providers, models, and default settings
- Manage prompt templates for images, video, and shots
- Generate frontend request helpers and types from OpenAPI
- Provide a stable base for future AI workflow expansion

### File and media management

- Manage uploads and generated outputs
- Preview, link, and reuse image/video assets
- Preserve shot and entity context around generated media

## 🎯 Use Cases

- Short / micro-drama creators
- AI studios producing video content in batches
- Solo creators exploring vertical drama production
- Education and training teams making lesson videos
- Brands and e-commerce teams producing story-driven promos

## 🔁 Frontend OpenAPI client and type generation

Frontend request helpers and types are generated from the backend
OpenAPI spec. Output directory:

- `front/src/services/generated/`

Cached spec file:

- `front/openapi.json`

With the backend dev server running at `http://127.0.0.1:8000`, run:

```bash
cd front
pnpm run openapi:update
```

## 🐳 Docker Compose

The repository includes a ready-to-run compose setup under
`deploy/compose/`.

### Ports

- Frontend: `http://localhost:7788`
- Backend: `http://localhost:8000` (`/docs` for Swagger)
- MySQL: `localhost:${MYSQL_PORT:-3306}`
- Redis: `localhost:${REDIS_PORT:-6379}`
- RustFS: `http://localhost:${RUSTFS_PORT:-9000}`

### Start

```bash
cp deploy/compose/.env.example deploy/compose/.env
docker compose --env-file deploy/compose/.env -f deploy/compose/docker-compose.yml up --build
```

## 🧑‍💻 Local Development

### 一键启动（macOS）

在 Finder 里双击仓库根目录的 **`启动像素小新.command`**：它会检查依赖 → 挑端口 →
同时起后端与前端 → 两个都通了再打开浏览器。默认走**演练模式**（不会产生任何费用）。

```bash
./启动像素小新.command                  # 演练模式（默认，零费用；双击也是这一条）
./启动像素小新.command --real           # 真实模式（会真花钱，终端里手工敲会先问一次 yes）
./启动像素小新.command --real --yes     # 真实模式且不再询问（给桌面双击入口用）
./启动像素小新.command --check          # 只体检（依赖与端口），不启动服务
```

停服：回到窗口按 `Control + C`（后端与前端一起停）。
默认后端 8000 / 前端 7788；端口被占用时不会硬顶，也不会悄悄复用别人的服务 ——
后端会改用一个空闲端口，并把前端（`VITE_BACKEND_URL`）指到它。
环境变量 `JELLYFISH_BACKEND_PORT` / `JELLYFISH_FRONT_PORT` 可覆盖端口；
`JELLYFISH_NO_BROWSER=1` 只打印地址、不自动开浏览器。
命令行参数**优先于** `JELLYFISH_REAL_MODE` 这类环境变量（显式参数赢，避免"以为在演练、其实在花钱"）。

### Backend

```bash
cd backend
cp .env.example .env
uv sync
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Frontend

```bash
cd front
pnpm install
pnpm dev
```

## 📄 License

This project is licensed under [Apache-2.0](./LICENSE).

## 💬 Community & Feedback

- [GitHub Issues](https://github.com/Forget-C/Jellyfish/issues)

