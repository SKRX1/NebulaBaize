#!/usr/bin/env bash
# ============================================================================
#  Nebula Agent - environment setup (POSIX counterpart of setup.bat)
#  1) locate a Python >= 3.10 (py / python3 / python); if none, print how to
#     install one (Linux distro package / macOS Homebrew / python.org).
#  2) run Nebula-agent/setup_env.py, which creates .venv, installs the pinned
#     requirements (pillow/psutil/PySocks), rewrites config + launchers, and
#     verifies all 8 servers + the gateway import under the venv python.
#  When this finishes you can run 星云白泽.sh (or Nebula-agent/run_standalone.sh).
#
#  Mirrors setup.bat on Windows; the venv itself (.venv/) stays gitignored and
#  is rebuilt here, so a fresh clone of the repo becomes runnable after this.
# ============================================================================
set -u
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

ROOT="$(cd "$(dirname "$0")" && pwd)"
AGENT="$ROOT/Nebula-agent"
SETUP_PY="$AGENT/setup_env.py"

echo "========================================"
echo " Nebula Agent - Environment Setup (POSIX)"
echo " 探测 Python、创建 venv、安装依赖、重写配置"
echo "========================================"

if [ ! -f "$SETUP_PY" ]; then
    echo "[ERROR] 找不到 $SETUP_PY（仓库不完整？）"
    exit 1
fi

# --- 1) locate a supported python (>= 3.10) ---
PY_BASE=""
check() {   # run a python probe; set PY_BASE on first success
    if [ -z "$PY_BASE" ] && "$@" -c "import sys;sys.exit(0 if sys.version_info>=(3,10) else 1)" >/dev/null 2>&1; then
        PY_BASE="$("$@" -c 'import sys;print(sys.executable)')"
    fi
}
check py -3
[ -z "$PY_BASE" ] && check python3
[ -z "$PY_BASE" ] && check python

if [ -z "$PY_BASE" ]; then
    echo "[ERROR] 未找到 Python >= 3.10。请先安装其一："
    echo "          Debian/Ubuntu : sudo apt install python3 python3-venv"
    echo "          Fedora/RHEL   : sudo dnf install python3 python3-pip"
    echo "          macOS         : brew install python@3.12  （或 python.org 安装包）"
    echo "        安装后重跑本脚本 setup.sh。"
    exit 1
fi

echo "[info] using python: $PY_BASE"
"$PY_BASE" --version

# --- 2) build venv + install deps + rewrite config + verify ---
"$PY_BASE" "$SETUP_PY"
RC=$?
if [ "$RC" -ne 0 ]; then
    echo "[ERROR] setup_env.py 失败（退出码 $RC），请查看上方日志。"
    exit "$RC"
fi

echo
echo "[done] 环境就绪。现在可运行 ./星云白泽.sh 或 bash Nebula-agent/run_standalone.sh 启动星云白泽。"
