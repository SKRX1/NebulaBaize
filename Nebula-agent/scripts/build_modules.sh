#!/usr/bin/env bash
# 把 servers/ + runtime 的兄弟模块编成 .pyd/.so —— CI 步骤 3b 的全部编译代码搬到这里。
#
# 为什么单独成脚本、为什么要并发：CI 实测 Nuitka 的 --mode=module 只接受【一个】
# positional（FATAL: "specify only one positional argument unless --run is specified"），
# 所以 N 个文件必须 N 次独立调用，不能合成一条命令。而这 N 次调用【之间】原先是
# 串行的——那正是实测里 Linux 519s / Windows 216s 的主要浪费（每次调用内部的 C 编译
# 已经是并行的，浪费全在调用与调用之间的空档）。本脚本只在 shell 层做分批并发，
# 不改变任何一次 Nuitka 调用的参数语义，产物与逐个手跑完全一致。
#
# 用法（CI 或本地都行，脚本自己 cd 到 Nebula-agent 根）：
#   bash scripts/build_modules.sh [CONC=3] [JOBS_MAX=4] [OUT=gateway.dist]
#   CONC      最多同时跑几个 nuitka 进程；实际取 min(CONC, 核数)
#   JOBS_MAX  单个 nuitka 进程内 --jobs 的上限；实际取 min(JOBS_MAX, 核数)
#
# 并发度为什么不拉满：free windows runner 只有 4 核 / 约 7GB，而每个 nuitka 进程内部
# 还要 fork jobs 个 C 编译子进程。默认 3 路 × min(nproc,4) 是拍板值——有没有余量看
# workflow 里 probe 步打印的 cores/mem_available_mb，只有它显示余量充足才上调 CONC，
# 否则可能 OOM（表现为 cl.exe 以怪异的退出码失败，而不是干净的 FATAL）。
#
# 失败可见性：每路 stdout/stderr 各自落 .build-logs/<path>.log，退出码落同名 .rc，
# 结束后【按清单顺序】回放到本脚本 stdout，任一失败则整体红并点名失败文件——
# 并发不打乱日志归属，也不丢退出码（后台任务的 $? 无法在 wait 之后逐项取回，
# 所以退出码必须由被调方自己落盘）。
set -u

CONC="${1:-3}"
JOBS_MAX="${2:-4}"
OUT="${3:-gateway.dist}"

cd "$(dirname "$0")/.." || exit 1   # -> Nebula-agent 根：下面的模块路径按仓库根书写

# 并行度的分配规则（一次 CI 实跑修正过的，勿凭直觉再改回去）：
# 实测 windows-latest 只有 2 核（probe 步打印 cores=2、MemTotal 8.3GB），ubuntu 是 4 核。
# 于是同一组"3 路 × min(nproc,4)"在两种机器上的含义完全不同：
#   - 4 核 Linux：实测 519s -> 87s。gcc 很轻，超发无代价（每个模块只有几个 .c，
#     且每个 nuitka 进程的大部分时间是单进程的 Python->C 编译阶段，那期间 CPU 本来闲着）。
#   - 2 核 Windows：实测 216s -> 350s，反而更慢。cl.exe 每次启动都要拉起 vctip/链接器，
#     进程开销按核数成倍地抢，4 个 C 编译进程挤 2 核时调度损耗盖过了重叠收益。
# 所以这里按"总 C 编译进程数 ≈ 核数"来分配 jobs：MSVC 上 jobs = cores // CONC（至少 1），
# 其余平台维持 JOBS_MAX 封顶（超发在 gcc/clang 上是净收益，已由上面那组数字证明）。
# 关键点：多个 nuitka 进程之间能重叠的是它们各自的单进程阶段（Python->C 生成、链接），
# 这正是并发要拿的收益；把 C 编译进程数钉在核数内，是为了这份收益不以调度抖动为代价。
cores="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1)"
case "$cores" in ''|*[!0-9]*) cores=1 ;; esac
[ "$cores" -ge 1 ] || cores=1
[ "$CONC" -gt "$cores" ] && CONC="$cores"

# 平台判据用 uname -s：MSYS/Git-bash 返回 MINGW*/MSYS_NT*，Linux 返回 Linux，macOS 返回
# Darwin。不用 $OS/$OSNAME —— 它们在 Git-bash 里恒为 Windows_NT，会让本地验证与真实
# Linux 分支不可分（本轮就是这样先判错过一次）。
plat="$(uname -s 2>/dev/null || echo unknown)"
case "$plat" in
  MINGW*|MSYS*|CYGWIN*) on_windows=1 ;;
  *) on_windows=0 ;;
esac

jobs="$JOBS_MAX"
if [ "$on_windows" = "1" ]; then
  # MSVC：把总 C 编译进程数钉在核数内（见上）。
  jobs=$((cores / CONC))
  [ "$jobs" -lt 1 ] && jobs=1
  [ "$jobs" -gt "$JOBS_MAX" ] && jobs="$JOBS_MAX"
fi
[ "$jobs" -gt "$cores" ] && jobs="$cores"
echo "[build_modules] plat=$plat on_windows=$on_windows"
echo "[build_modules] cores=$cores conc=$CONC jobs=$jobs out=$OUT"

# 这份清单不是猜的：按各 server 的真实 import 与它们的一层传递依赖逐个坐实（详见
# build-release.yml 步骤 3b 的注释）。memory/ 不在这里——它必须按【包】编
# （--mode=package），由 workflow 里紧随其后那条命令单独处理，别"顺手统一"进来。
MODULES="
  servers/_mcp_base.py
  servers/fs_server.py
  servers/shell_server.py
  servers/websearch_server.py
  servers/memory_server.py
  servers/browser_server.py
  servers/schedule_server.py
  servers/skillhub_server.py
  servers/registry_server.py
  skills/example_server.py
  runtime/config_loader.py
  runtime/textenc.py
  runtime/skills_loader.py
  runtime/executor.py
  runtime/registry.py
  runtime/audit.py
  runtime/scheduler.py
  runtime/corpus.py
"

LOGD=".build-logs"
rm -rf "$LOGD"
mkdir -p "$LOGD" || exit 1

run_one() {
  local f="$1"
  local lg
  lg="$LOGD/$(printf '%s' "$f" | tr '/.' '__').log"
  python -m nuitka --mode=module --assume-yes-for-downloads --jobs="$jobs" \
    --output-dir="$OUT" "$f" > "$lg" 2>&1
  echo "$?" > "$lg.rc"
}

batch=""; n=0
flush_batch() {
  local p
  for p in $batch; do wait "$p" || true; done
  batch=""; n=0
}

for f in $MODULES; do
  run_one "$f" &
  batch="$batch $!"
  n=$((n + 1))
  [ "$n" -ge "$CONC" ] && flush_batch
done
flush_batch

# 按清单顺序回放日志 + 读各模块自落的 rc 判定成败。
bad=""; total=0
for f in $MODULES; do
  total=$((total + 1))
  lg="$LOGD/$(printf '%s' "$f" | tr '/.' '__').log"
  rc="$(cat "$lg.rc" 2>/dev/null || echo NO_RC)"
  echo "===== $f  rc=$rc"
  [ -f "$lg" ] && cat "$lg"
  [ "$rc" = "0" ] || bad="$bad $f"
done

if [ -n "$bad" ]; then
  echo "[build_modules] RED: failed modules:$bad"
  exit 1
fi
echo "[build_modules] OK: $total modules -> $OUT"
