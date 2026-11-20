#!/usr/bin/env bash
# ============================================================
#  Nebula Agent 一键启动（POSIX counterpart of 星云白泽.bat）
#  - start 8099 gateway FIRST (boot does not depend on 8080; a dead upstream
#    only yields 502 until the engine is ready; see gateway.py)
#  - then start the 8080 engine (Strata-main). The engine launch command is
#    platform/user specific: set NEBULA_ENGINE_CMD to your engine launcher.
#  - already-running components are skipped (safe to re-run)
#  Works on Linux and macOS (Win11 uses 星云白泽.bat).
# ============================================================
MODEL="${MODEL:-s}"

AGENT_DIR="$(cd "$(dirname "$0")/Nebula-agent" && pwd)"
STANDALONE="$AGENT_DIR/run_standalone.sh"

# 8080 engine launcher: a shell command that brings the inference engine up on :8080.
# This is intentionally user/platform specific (Strata engine binaries differ per OS).
# Leave unset to skip the engine step (gateway still boots; requests 502 until an
# upstream answers). Example: NEBULA_ENGINE_CMD="./run-strata-s.sh" ./星云白泽.sh
NEBULA_ENGINE_CMD="${NEBULA_ENGINE_CMD:-}"

# Is a TCP port being LISTENed on? Prefer lsof, fall back to ss, then netstat.
port_listening() {
    local port="$1"
    if command -v lsof >/dev/null 2>&1; then
        lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    elif command -v ss >/dev/null 2>&1; then
        ss -ltn "( sport = :$port )" 2>/dev/null | grep -q ":$port"
    elif command -v netstat >/dev/null 2>&1; then
        netstat -an 2>/dev/null | grep -i "LISTEN" | grep -q ":$port"
    else
        return 1   # no port-probing tool found: treat as not-listening
    fi
}

echo "==================================================="
echo " Nebula Agent 一键启动 [model=$MODEL]"
echo "==================================================="

# ---------- 1) 8099 standalone gateway ----------
if port_listening 8099; then
    echo "[1/2] 8099 已在运行，跳过网关启动。"
else
    echo "[1/2] 8099 未运行，启动网关: $STANDALONE"
    if [ ! -x "$STANDALONE" ]; then
        echo "  错误: 找不到 $STANDALONE"
        exit 1
    fi
    nohup "$STANDALONE" >/dev/null 2>&1 &
    echo "      网关启动中，浏览器将在数秒后打开 http://127.0.0.1:8099"
    echo "      （此时 8080 尚未就绪，请求会 502，引擎起来后自动恢复）"
fi

# ---------- 2) 8080 inference engine ----------
if port_listening 8080; then
    echo "[2/2] 8080 已在运行，跳过引擎启动。"
    echo "      注意：当前 8080 上跑的模型可能与本脚本 MODEL=$MODEL 不一致。"
    echo "      若要切换模型，请先手动停止当前引擎，再运行本脚本。"
elif [ -z "$NEBULA_ENGINE_CMD" ]; then
    echo "[2/2] 未设置 NEBULA_ENGINE_CMD，跳过引擎启动。"
    echo "      网关仍可启动（只连上游）；要本地推理，请设置 NEBULA_ENGINE_CMD 指向你的引擎启动命令。"
else
    echo "[2/2] 8080 未运行，启动引擎: $NEBULA_ENGINE_CMD"
    nohup bash -c "$NEBULA_ENGINE_CMD" >/dev/null 2>&1 &
    echo "      等待 8080 端口就绪 ..."
    N=0
    until port_listening 8080; do
        N=$((N + 1))
        if [ "$N" -ge 60 ]; then
            echo "  超时：8080 未在 60 秒内就绪，请检查引擎启动日志"
            exit 1
        fi
        sleep 1
    done
    echo "      8080 就绪。"
fi

# ---------- 3) 8099 gateway watchdog (single-instance) ----------
WATCHDOG_PY="$AGENT_DIR/gw_watchdog.py"
if [ -f "$WATCHDOG_PY" ] && command -v python3 >/dev/null 2>&1; then
    echo "[3/3] 启动网关看门狗（崩溃/关窗自愈，已在运行则跳过）..."
    nohup python3 "$WATCHDOG_PY" >/dev/null 2>&1 &
else
    echo "[3/3] 未找到看门狗脚本 $WATCHDOG_PY 或 python3，跳过。"
fi

echo "==================================================="
echo " 完成。网关@8099$(port_listening 8080 && echo " + 引擎@8080") 已尝试拉起。"
echo " 停止：关闭对应进程即可（网关进程可创建 $AGENT_DIR/.gw_stop.flag 软停）。"
echo "==================================================="
