#!/usr/bin/env bash
# ============================================================
#  Nebula Agent 网关看门狗启动器（POSIX counterpart of gw_watchdog.bat）
#  与 run_standalone.sh 同目录。后台运行 gw_watchdog.py：每 10s 探 8099，
#  缺失且无 .gw_stop.flag 则拉起 run_standalone.sh（覆盖“整个网关进程被关闭”的场景）。
#  单实例由 gw_watchdog.py 内部守卫保证（win32 命名互斥体 / POSIX pgrep 或 flock），
#  重复启动会被自动跳过。
#  停止：结束运行中的 gw_watchdog.py 进程即可（也可建 .gw_stop.flag）。
#  ROOT 相对本脚本自身目录定位，迁移整目录不断链。
#  Works on Linux and macOS (Win11 uses gw_watchdog.bat).
# ============================================================
set -u
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

ROOT="$(cd "$(dirname "$0")" && pwd)"

# venv python: POSIX uses .venv/bin/python; fall back to Windows layout, then python3.
if [ -x "$ROOT/.venv/bin/python" ]; then
    PY="$ROOT/.venv/bin/python"
elif [ -x "$ROOT/.venv/Scripts/python.exe" ]; then
    PY="$ROOT/.venv/Scripts/python.exe"
elif command -v python3 >/dev/null 2>&1; then
    PY="$(command -v python3)"
else
    echo "找不到 Python 解释器（$ROOT/.venv/bin/python 或 python3）。请先运行 setup 创建虚拟环境。"
    exit 1
fi

# 后台脱离当前会话启动；单实例与“是否拉起网关”的判定都在 gw_watchdog.py 内（跨平台分派）。
nohup "$PY" "$ROOT/gw_watchdog.py" >/dev/null 2>&1 &
echo "看门狗已后台启动（监控 127.0.0.1:8099，每 10s 一次；重复运行会自动跳过）。"
echo "停止：结束 gw_watchdog.py 进程，或在 $ROOT 下创建 .gw_stop.flag。"
