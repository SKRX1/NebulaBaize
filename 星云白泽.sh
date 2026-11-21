#!/usr/bin/env bash
# ============================================================
#  Nebula Agent 一键启动（POSIX counterpart of 星云白泽.bat，启动顺序调整 2026-11）
#  两步：
#  [1] 先启动网关看门狗（单实例）——它内部会自行拉起并自愈 8099 网关，
#      不再单独显式起网关。
#  [2] 再启动推理引擎：默认对应 Windows 的
#      E:\Nebula\Strata模型安装\run-iq3_s_abliterated.bat。该引擎二进制因
#      OS 而异，POSIX 下用 NEBULA_ENGINE_CMD 指定等价启动命令；未设则跳过。
#  - 已运行的组件会被跳过（重复运行安全）。
#  Works on Linux and macOS (Win11 uses 星云白泽.bat).
# ============================================================
AGENT_DIR="$(cd "$(dirname "$0")/Nebula-agent" && pwd)"

# 8080 engine launcher: a shell command that brings the inference engine up on :8080.
# (POSIX counterpart of run-iq3_s_abliterated.bat — engine binaries differ per OS.)
# Leave unset to skip the engine step (gateway/watchdog still boot; requests 502 until
# an upstream answers). Example: NEBULA_ENGINE_CMD="./run-strata-s.sh" ./星云白泽.sh
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
echo " Nebula Agent 一键启动"
echo "==================================================="

# ---------- 1) watchdog (it brings up & self-heals the 8099 gateway; single-instance) ----------
WATCHDOG_PY="$AGENT_DIR/gw_watchdog.py"
if [ -f "$WATCHDOG_PY" ] && command -v python3 >/dev/null 2>&1; then
    echo "[1/2] 启动网关看门狗（它会自动拉起 8099 网关，已在运行则跳过）..."
    nohup python3 "$WATCHDOG_PY" >/dev/null 2>&1 &
    echo "      看门狗启动中，网关将由其在数秒内拉起 http://127.0.0.1:8099"
    echo "      （此时 8080 引擎尚未就绪，请求会 502，引擎起来后自动恢复）"
else
    echo "[1/2] 错误: 未找到看门狗脚本 $WATCHDOG_PY 或 python3"
    echo "      它是 8099 网关的拉起源，缺少则无法启动，已中止。"
    exit 1
fi

# ---------- 2) 8080 inference engine ----------
if port_listening 8080; then
    echo "[2/2] 8080 已在运行，跳过引擎启动。"
    echo "      注意：当前 8080 上跑的模型可能与本脚本预期不一致；"
    echo "      若要切换模型，请先手动停止当前引擎，再运行本脚本。"
elif [ -z "$NEBULA_ENGINE_CMD" ]; then
    echo "[2/2] 未设置 NEBULA_ENGINE_CMD，跳过引擎启动。"
    echo "      网关/看门狗仍可启动（只连上游）；要本地推理，请设置 NEBULA_ENGINE_CMD 指向等价引擎命令。"
else
    echo "[2/2] 8080 未运行，启动引擎: $NEBULA_ENGINE_CMD"
    nohup bash -c "$NEBULA_ENGINE_CMD" >/dev/null 2>&1 &
    echo "      等待 8080 端口就绪 ..."
    N=0
    until port_listening 8080; do
        N=$((N + 1))
        if [ "$N" -ge 60 ]; then
            echo "  超时：8080 未在 60 秒内就绪，请检查引擎启动日志"
            break
        fi
        sleep 1
    done
    port_listening 8080 && echo "      8080 就绪。"
fi

echo "==================================================="
echo " 完成。看门狗(含 8099 网关)$(port_listening 8080 && echo " + 引擎@8080") 已尝试拉起。"
echo " 停止：关闭对应进程即可（网关进程可创建 $AGENT_DIR/.gw_stop.flag 软停）。"
echo "==================================================="
