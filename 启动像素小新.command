#!/bin/bash
# 像素小新 —— 双击启动器（本地开发：后端 + 前端，一条命令起全套）
#
# 产品名口径：用户可见名称是「像素小新 / Pixel Xiaoxin」，内部仍叫 Jellyfish / jellyfish
# （仓库目录、包名、环境变量、存储键都不改）。见 docs/architecture/product-branding.md。
#
# 这个脚本做四件事：检查环境 → 挑端口 → 起前端和后端 → 两个都通了再打开浏览器。
# 技术细节（端口、演练模式变量、排错方式）见 docs/real-run-mode.md 与 README 的 Local Development。
#
# 用法：
#   双击本文件                 **演练模式**启动（不会花钱；这是默认，**不会问你任何问题**）
#   ./启动像素小新.command --real   真实模式（出图/出视频/调模型/上传都会真花钱；终端里手工敲时会要一次 yes）
#   ./启动像素小新.command --real --yes  同上，但不再询问（桌面那个「真实模式·会花钱」入口用的就是它）
#   ./启动像素小新.command --check  只体检（检查依赖与端口），不启动任何服务
#
# 端口（都可用环境变量覆盖）：
#   JELLYFISH_BACKEND_PORT  后端端口，默认 8000
#   JELLYFISH_FRONT_PORT    前端端口，默认 7788
#   两个端口被占用时**不会**硬顶，也不会悄悄复用别人的服务：
#     前端端口被占用且确认是**本项目**的开发服务器 → 直接打开浏览器（不重复起一份）
#     后端端口被占用 → 自动改用一个空闲端口，并把前端指向它（避免连到别的 worktree 的后端）
#
# 其它环境变量：
#   JELLYFISH_NO_BROWSER=1  只打印地址、不自动打开浏览器（自动化/远程验收用）
#
# 停服：回到本窗口按 Control + C（会同时停掉后端和前端）。
set -u

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR" || exit 1

HOST="127.0.0.1"
BACKEND_PORT="${JELLYFISH_BACKEND_PORT:-8000}"
FRONT_PORT="${JELLYFISH_FRONT_PORT:-7788}"
BACKEND_SCRIPT="backend/scripts/run_backend.sh"
HEALTH_PATH="/health"
MODE_PATH="/api/v1/studio/llm/orchestration/status"

# 演练模式的两个守卫变量名（唯一事实来源是 backend/app/services/studio/llm_orchestration/dry_run.py；
# 这里只做展示，真正的 export 交给 run_backend.sh，免得两处口径各写一遍）。
DRY_RUN_ENV="JELLYFISH_DRY_RUN"
CONFIRM_ENV="JELLYFISH_REAL_LLM_CONFIRMED"

TMP_ROOT="${TMPDIR:-/tmp}"
TMP_ROOT="${TMP_ROOT%/}"
FRONT_LOG="${TMP_ROOT}/pixel-xiaoxin-frontend.log"

WANT_REAL=0
REAL_PRE_CONFIRMED=0
CHECK_ONLY=0
FRONT_PID=""
WATCH_PID=""

# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
pause_and_exit() {
  local code="${1:-0}"
  echo ""
  read -n 1 -s -r -p "按任意键关闭窗口..." || true
  echo ""
  exit "$code"
}

is_truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

http_ok() {
  curl -fsS --max-time 2 "$1" >/dev/null 2>&1
}

# 端口是否空闲（用 python3 试 bind；系统自带 python3 即可，不需要额外依赖）
port_free() {
  python3 - "$1" <<'PY' >/dev/null 2>&1
import socket, sys
s = socket.socket()
try:
    s.bind(("127.0.0.1", int(sys.argv[1])))
except OSError:
    raise SystemExit(1)
finally:
    s.close()
raise SystemExit(0)
PY
}

# 在 [start, end] 里找第一个空闲端口，找不到就回显空
find_free_port() {
  local p
  for p in $(seq "$1" "$2"); do
    if port_free "$p"; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

# 占用该端口的是不是**本项目**的 Vite 开发服务器（避免把别的应用当成自己）
front_is_ours() {
  local body
  body="$(curl -fsS --max-time 2 "$1" 2>/dev/null || true)"
  case "$body" in
    *"/src/main.tsx"*) return 0 ;;
    *"像素小新"*) return 0 ;;
    *) return 1 ;;
  esac
}

# 只读地问一下：占用该端口的后端自报是演练还是真实模式。
# 回显 `dry_run` / `real_unconfirmed` / `real` / `unknown`（读不到就回 unknown，绝不猜——
# 猜错的方向是"以为在演练、其实在真实"，那是最危险的错法）。
backend_mode_of() {
  local raw
  raw="$(curl -fsS --max-time 3 "$1" 2>/dev/null || true)"
  [ -n "$raw" ] || { echo unknown; return 0; }
  printf '%s' "$raw" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin).get("data") or {}
except Exception:
    print("unknown"); raise SystemExit(0)
print(d.get("mode") or "unknown")
' 2>/dev/null || echo unknown
}

# 把上一步的结果翻成一句人话 + 风险判断
report_occupied_backend() {
  local mode
  mode="$(backend_mode_of "${1}${MODE_PATH}")"
  case "$mode" in
    real)
      echo "  ⚠️  该服务自报**真实模式**：复用它会真实扣费（这正是本脚本不复用它的原因）。"
      ;;
    real_unconfirmed)
      echo "  ⚠️  该服务自报**真实模式（尚未确认）**：仍属真实模式一侧，不复用。"
      ;;
    dry_run)
      echo "  该服务自报演练模式；但为免连到别的 worktree，本脚本仍然不复用它。"
      ;;
    *)
      echo "  读不到它自报的模式，按「来源不明」处理（不复用）。"
      ;;
  esac
}

# 打开浏览器：`JELLYFISH_NO_BROWSER=1` 时只打印地址、不弹标签页
# （与既有桌面启动项的那个约定同名同义；自动化/远程验收时用）。
#
# 为什么要有这个开关：验收时弹出来的标签页会**活过**被停掉的服务 ——
# 下次有人点它就会看到「连不上后端」，那种"页面还在、后端没了"的假故障，
# 真机上正是这么踩到的（用户报「创建广告项目失败：Failed to fetch」的那次）。
open_browser() {
  if [ "${JELLYFISH_NO_BROWSER:-0}" = "1" ]; then
    echo "（JELLYFISH_NO_BROWSER=1：不自动打开浏览器，请手动访问上面的地址）"
    return 0
  fi
  command -v open >/dev/null 2>&1 && open "$1" >/dev/null 2>&1 || true
}

# 两个服务都通了再打开浏览器
wait_and_open() {
  local attempt backend_url front_url
  backend_url="http://${HOST}:${BACKEND_PORT}"
  front_url="http://${HOST}:${FRONT_PORT}"
  for attempt in $(seq 1 240); do
    if http_ok "${backend_url}${HEALTH_PATH}" && http_ok "$front_url"; then
      echo ""
      echo "✅ 已就绪：$front_url"
      echo "   （后端：${backend_url}　接口文档：${backend_url}/docs）"
      echo ""
      open_browser "$front_url"
      return 0
    fi
    sleep 0.5
  done
  echo ""
  echo "⚠️  等了两分钟还没就绪。前端日志：$FRONT_LOG"
  return 1
}

cleanup() {
  if [ -n "$WATCH_PID" ]; then kill "$WATCH_PID" >/dev/null 2>&1 || true; fi
  if [ -n "$FRONT_PID" ]; then
    # 前端是独立进程组（见下面的 set -m），整组一起停，不留孤儿 node 进程
    kill -TERM "-${FRONT_PID}" >/dev/null 2>&1 || kill -TERM "$FRONT_PID" >/dev/null 2>&1 || true
  fi
}

# ---------------------------------------------------------------------------
# 参数
# ---------------------------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --real) WANT_REAL=1 ;;
    # `--yes`：真实模式已经由调用方明确确认过（例如桌面上那个名字里就写着
    # 「真实模式·会花钱」的双击入口），**不要再让用户打字**。
    # 双击就该开始用 —— 让用户在窗口里敲 yes 才能启动，是上一版真机被吐槽的做法。
    --yes|-y) REAL_PRE_CONFIRMED=1 ;;
    --dry-run|--safe) WANT_REAL=0 ;;
    --check) CHECK_ONLY=1 ;;
    -h|--help)
      # 只打印文件头那段注释（第 1 行是 shebang，不打印），避免维护两份用法说明
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "未知参数：$arg（用 --help 看用法）" >&2; exit 1 ;;
  esac
done
if is_truthy "${JELLYFISH_REAL_MODE:-}"; then WANT_REAL=1; fi

# ---------------------------------------------------------------------------
# 体检
# ---------------------------------------------------------------------------
missing=""
for tool in uv pnpm node python3 curl; do
  command -v "$tool" >/dev/null 2>&1 || missing="${missing} ${tool}"
done

echo "========================================"
echo " 像素小新 一键启动器"
echo "========================================"
echo ""
echo "项目目录：$PROJECT_DIR"
echo ""

if [ -n "$missing" ]; then
  echo "缺少这些命令：${missing}"
  echo "请先装好再双击本文件（后端要 uv、前端要 pnpm/node）。"
  pause_and_exit 1
fi

if [ ! -f "$PROJECT_DIR/backend/pyproject.toml" ] || [ ! -f "$BACKEND_SCRIPT" ]; then
  echo "没有找到后端程序（backend/pyproject.toml / ${BACKEND_SCRIPT}）。"
  echo "请确认项目目录是否完整。"
  pause_and_exit 1
fi

if [ ! -f "$PROJECT_DIR/front/package.json" ]; then
  echo "没有找到前端程序（front/package.json）。请确认项目目录是否完整。"
  pause_and_exit 1
fi

# ---- 端口：前端 ----
FRONT_URL="http://${HOST}:${FRONT_PORT}"
if ! port_free "$FRONT_PORT"; then
  if front_is_ours "$FRONT_URL"; then
    # 已经在跑一份本项目的实例。**这里必须说清楚"模式属于那个进程"** ——
    # 真机踩过：用户双击「真实模式」入口没反应（只弹了个标签页），
    # 因为模式开关是**后端进程启动时**读的环境变量，已经在跑的那个改不了。
    # 不把这句话打出来，用户只会以为"真实模式坏了"。
    echo "本项目已经有一份实例在运行：${FRONT_URL}"
    # 注意：`BACKEND_URL` 在下面「端口：后端」那一段才赋值，所以这里直接用端口拼。
    running_backend_url="http://${HOST}:${BACKEND_PORT}"
    running_mode="$(backend_mode_of "${running_backend_url}${MODE_PATH}")"
    case "$running_mode" in
      dry_run)
        echo "  它当前是**演练模式**（不会花钱）。"
        if [ "$WANT_REAL" = "1" ]; then
          echo ""
          echo "⚠️  你要的是真实模式，但**模式在进程启动时就定死了**，改不了已经在跑的这一份。"
          echo "    请回到原来那个启动窗口按 Control + C 停掉，再双击「启动像素小新（真实模式·会花钱）」。"
          echo "    （如果那个窗口停在「确认开启真实模式？输入 yes」，Ctrl+C 就能把它退掉。）"
          pause_and_exit 1
        fi
        ;;
      real|real_unconfirmed)
        echo "  它当前是**真实模式**（出图/出视频/调模型/上传都会真的花钱，请谨慎操作）。"
        if [ "$WANT_REAL" != "1" ]; then
          echo ""
          echo "⚠️  注意：这份实例不会因为你双击了演练模式入口就变回演练。"
          echo "    要回到不花钱：回到原启动窗口按 Control + C 停掉，再双击「启动像素小新」。"
        fi
        ;;
      *)
        echo "  ⚠️  读不到它自报的模式（后端可能不是本项目、或已停止响应）。"
        ;;
    esac
    if ! http_ok "${running_backend_url}${HEALTH_PATH}"; then
      echo "  ⚠️  后端 ${running_backend_url} 已经没有响应了：这个页面看着还在，但点任何按钮都会报「连不上后端」。"
      echo "     这是**上一次启动没走完**留下的空壳（例如上次真实模式卡在确认那句、就退掉了）。"
      echo "     处理办法：回到那个启动窗口按 Control + C（或直接关掉它），再重新双击本入口。"
      pause_and_exit 1
    fi
    echo ""
    echo "→ 服务是健康的，已为你打开浏览器：${FRONT_URL}"
    open_browser "$FRONT_URL"
    # ⚠️ 这一支**不等按键**：用户双击就是"要用"，此时服务健康、页面也打开了，
    # 再拦一个「按任意键关闭窗口」只是多一道无意义的门槛（真机被吐槽过）。
    # 留在窗口里等按键的只有上面那些**异常**情况（免得信息一闪而过）。
    exit 0
  fi
  picked="$(find_free_port 7789 7820 || true)"
  if [ -z "$picked" ]; then
    echo "前端端口 ${FRONT_PORT} 被别的程序占用，且 7789-7820 也没有空闲端口。"
    echo "请先关掉占用端口的程序，或用 JELLYFISH_FRONT_PORT=xxxx 指定一个空闲端口。"
    pause_and_exit 1
  fi
  echo "前端端口 ${FRONT_PORT} 被别的程序占用，改用 ${picked}。"
  FRONT_PORT="$picked"
  FRONT_URL="http://${HOST}:${FRONT_PORT}"
fi

# ---- 端口：后端 ----
BACKEND_URL="http://${HOST}:${BACKEND_PORT}"
if ! port_free "$BACKEND_PORT"; then
  echo "后端端口 ${BACKEND_PORT} 已被占用 —— **不复用**它。"
  report_occupied_backend "$BACKEND_URL"
  echo "  原因：本机可能同时开着别的 worktree 的后端；直接复用会让界面连到不属于本项目的服务。"
  picked="$(find_free_port 8010 8060 || true)"
  if [ -z "$picked" ]; then
    echo "8010-8060 也没有空闲端口，请先释放端口或用 JELLYFISH_BACKEND_PORT=xxxx 指定。"
    pause_and_exit 1
  fi
  BACKEND_PORT="$picked"
  BACKEND_URL="http://${HOST}:${BACKEND_PORT}"
  echo "  本项目后端改到 ${BACKEND_PORT} 启动，并已把前端指向它。"
fi
echo ""

if [ "$CHECK_ONLY" = "1" ]; then
  echo "体检通过（--check 不启动服务）。"
  echo "  后端将使用：${BACKEND_URL}"
  echo "  前端将使用：${FRONT_URL}"
  echo "  前端 node_modules：$([ -d "$PROJECT_DIR/front/node_modules" ] && echo 已存在 || echo 缺失（启动时会自动安装）)"
  echo "  后端依赖：$([ -d "$PROJECT_DIR/backend/.venv" ] && echo 已存在 || echo 缺失（uv run 会自动同步）)"
  exit 0
fi

# ---------------------------------------------------------------------------
# 模式：默认演练（与 run_backend.sh 的口径一致，真正的 export 在那里做）
# ---------------------------------------------------------------------------
if [ "$WANT_REAL" = "1" ]; then
  echo "################  真实模式  ################"
  echo " 出图、出视频、调用大模型、上传素材都会**真的执行**，会真的花钱。"
  echo " 回到不花钱的演练模式：停掉本窗口（Control + C），再双击「启动像素小新」。"
  echo "############################################"
  echo ""
  # 「双击就该开始用」：真实模式**不要求在窗口里打字** ——
  # 桌面那个入口的名字本身（`启动像素小新（真实模式·会花钱）`）就是确认动作，
  # 双击它是一次明确的选择；中控台那套既有入口也是这个口径（`--real` 直接启动）。
  #
  # ⚠️ 但有一条底线：**确认/拒绝必须发生在启动任何服务之前**。
  # 真机事故：以前这层确认藏在 run_backend.sh 里（前端已经在后台起好），
  # 没人回答于是窗口看着"没反应"、前端却占住端口，之后每次双击都被
  # "已有实例在运行"拦住，用户自己走不出来。
  # 所以：只有**带 --yes**（= 调用方已明确确认真实模式）才免问；
  # 手工敲 `--real` 的终端用户仍然会被问一次（那里没有"双击即确认"这层语义）。
  if [ "$REAL_PRE_CONFIRMED" != "1" ]; then
    printf '确认开启真实模式？输入 yes 后回车（直接回车或其它输入都会取消，且不会启动任何服务）：'
    read -r real_answer || real_answer=""
    if [ "$real_answer" != "yes" ]; then
      echo ""
      echo "已取消：没有开启真实模式，也没有启动任何服务（端口都是干净的）。"
      echo "想要不花钱地启动：直接双击「启动像素小新」。"
      pause_and_exit 1
    fi
    echo "已确认真实模式 —— 下面开始启动服务。"
  else
    echo "已确认真实模式 —— 下面开始启动服务。"
  fi
else
  echo "================  演练模式  ================"
  echo " 出图、出视频、调用大模型、上传素材都不会真的执行，不会花钱。"
  echo " 要真的出图/出视频：双击「启动像素小新（真实模式·会花钱）」。"
  echo " 守卫变量：${DRY_RUN_ENV}=1，并清掉 ${CONFIRM_ENV}"
  echo "============================================"
fi
echo ""

trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# 前端（后台；先起，因为它冷启动比后端慢）
# ---------------------------------------------------------------------------
if [ ! -d "$PROJECT_DIR/front/node_modules" ]; then
  echo "正在安装前端依赖（第一次会慢一些）……"
  if ! (cd "$PROJECT_DIR/front" && pnpm install); then
    echo "前端依赖安装失败，请检查网络后重试。"
    pause_and_exit 1
  fi
fi

echo "正在启动前端（${FRONT_URL}）……日志：$FRONT_LOG"
: >"$FRONT_LOG"
# set -m：让后台任务自成进程组，退出时能整组停掉（不留孤儿 node）
set -m
(
  cd "$PROJECT_DIR/front" || exit 1
  # 把界面明确指到本项目这次启动的后端端口上：后端端口被占用而改端口时，
  # 这一步保证界面不会回落到默认的 8000（那可能是别的 worktree 的服务）。
  VITE_BACKEND_URL="$BACKEND_URL" \
    pnpm exec vite --host "$HOST" --port "$FRONT_PORT" --strictPort --no-open
) >>"$FRONT_LOG" 2>&1 &
FRONT_PID=$!
set +m

# ---------------------------------------------------------------------------
# 后台等两个服务都就绪，再打开浏览器；后端本身在前台跑，Control + C 即停服
# ---------------------------------------------------------------------------
wait_and_open &
WATCH_PID=$!

echo ""
echo "正在启动后端（${BACKEND_URL}）……"
echo "提示：保持这个窗口打开，系统才会持续运行；要停止服务，按 Control + C。"
echo ""

cd "$PROJECT_DIR" || pause_and_exit 1
# 演练/真实两套守卫环境变量由 run_backend.sh 统一设置（单一口径，不在本脚本重写一遍）。
# 真实模式这里带 `--yes`：确认已经在**启动任何服务之前**问过了（见上面的 read），
# 不让用户在一个已经开始起服务的窗口里再答一次（那正是"双击没反应"的成因）。
backend_args=()
if [ "$WANT_REAL" = "1" ]; then
  backend_args=(--real --yes)
fi
PORT="$BACKEND_PORT" HOST="$HOST" bash "$BACKEND_SCRIPT" ${backend_args[@]+"${backend_args[@]}"}

echo ""
echo "服务已停止。"
pause_and_exit 0
