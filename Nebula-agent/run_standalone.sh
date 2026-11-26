#!/usr/bin/env bash
# ============================================================================
#  Nebula Agent - Standalone mode launcher (POSIX counterpart of run_standalone.bat)
#  Starts the gateway HTTP server (serves its own frontend + API proxy).
#  Frontend: serve/web/   API: proxied to --url upstream
#
#  Behaviour mirrors run_standalone.bat: auto-restart the gateway on crash
#  (backoff + max fails), soft-stop via a .gw_stop.flag file, open the browser
#  only on the first start. Works on Linux and macOS (Win11 uses run_standalone.bat).
# ============================================================================
set -u
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

ROOT="$(cd "$(dirname "$0")" && pwd)"

# venv python: POSIX uses .venv/bin/python; fall back to the Windows layout if present.
if [ -x "$ROOT/.venv/bin/python" ]; then
    PYTHON="$ROOT/.venv/bin/python"
elif [ -x "$ROOT/.venv/Scripts/python.exe" ]; then
    PYTHON="$ROOT/.venv/Scripts/python.exe"
else
    echo "找不到 venv 解释器 ($ROOT/.venv/bin/python): 请先运行 setup（setup_env.py）创建虚拟环境。"
    exit 1
fi

# --- Upstream API (change via env for remote endpoints) ---
UPSTREAM_URL="${UPSTREAM_URL:-http://127.0.0.1:8080/v1}"
MODEL="${MODEL:-strata}"
API_KEY="${API_KEY:-}"
PORT="${PORT:-8099}"
export STRATA_MAX_OUTPUT="${STRATA_MAX_OUTPUT:-16384}"
export STRATA_MAX_OUTPUT_CEILING="${STRATA_MAX_OUTPUT_CEILING:-49152}"

# --- Build args ---
ARGS=(--serve --url "$UPSTREAM_URL" --model "$MODEL" --port "$PORT")
[ -n "$API_KEY" ] && ARGS+=(--api-key "$API_KEY")

# --- Agent mode: 1 = run our own MCP tools (default), 0 = transparent proxy ---
AGENT_MODE="${AGENT_MODE:-1}"
[ "$AGENT_MODE" = "1" ] && ARGS+=(--agent)

# --- Auto-restart control ---
STOP_FLAG="$ROOT/.gw_stop.flag"
MAX_FAILS="${MAX_FAILS:-5}"
DELAY="${DELAY:-3}"
FAILS=0
GW_STARTED=0

echo "========================================"
echo " Nebula Agent - Standalone"
echo " Frontend: http://127.0.0.1:$PORT"
echo " Upstream: $UPSTREAM_URL"
echo " Model: $MODEL"
echo " 网关崩溃将自动重启（最多连续 $MAX_FAILS 次）；创建 $STOP_FLAG 可软停。"
echo "========================================"

# [encoding canary] one-shot self-check at launcher start
if [ -z "${_CANARY_RAN:-}" ]; then
    "$PYTHON" "$ROOT/tools/encoding_canary.py" || true
fi
_CANARY_RAN=1

while true; do
    if [ -e "$STOP_FLAG" ]; then
        echo "检测到停止标志 $STOP_FLAG，退出重启循环。"
        break
    fi

    # Open the browser only on the first start (not on every restart).
    if [ "$GW_STARTED" = "0" ]; then
        ( sleep 3
          if command -v xdg-open >/dev/null 2>&1; then xdg-open "http://127.0.0.1:$PORT" >/dev/null 2>&1
          elif command -v open >/dev/null 2>&1; then open "http://127.0.0.1:$PORT" >/dev/null 2>&1
          fi ) &
        GW_STARTED=1
    fi

    echo "[$(date '+%H:%M:%S')] 启动网关（失败计数 $FAILS/$MAX_FAILS）..."
    "$PYTHON" "$ROOT/runtime/gateway.py" "${ARGS[@]}"
    RC=$?

    if [ "$RC" -eq 0 ]; then
        echo "[$(date '+%H:%M:%S')] 网关正常退出（code 0），停止重启循环。"
        break
    fi

    FAILS=$((FAILS + 1))
    echo "[$(date '+%H:%M:%S')] 网关异常退出（code $RC），失败计数 $FAILS/$MAX_FAILS。"

    if [ "$FAILS" -ge "$MAX_FAILS" ]; then
        echo "连续失败 $MAX_FAILS 次，停止重启以防死循环（多为端口被占 / 依赖缺失）。"
        echo "排查后删除 $STOP_FLAG 或修正依赖，再手动重跑本脚本。"
        break
    fi

    echo "$DELAY 秒后重启 ..."
    sleep "$DELAY"
done
