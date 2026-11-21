# -*- coding: utf-8 -*-
"""gw_watchdog.py 的 POSIX 分支差分锁（纯 stdlib，无真进程/pgrep）。

锁住 _posix_existing_gateway_pids / _posix_single_instance_guard 与 existing_gateway_pids
的平台分派（本机是 Windows，故 monkeypatch sys.platform 与 subprocess.run / fcntl）：
  W1 分派 load-bearing：sys.platform=linux 时 existing_gateway_pids() 调用 pgrep（argv[0]
     =="pgrep"），绝不是 powershell —— 若分派分支被删回退到 powershell，本项即红。
  W2 pgrep 三态（_posix_existing_gateway_pids 的真实契约，见其源码）：
       rc=0 + 多个 PID 行 -> 解析成 int 列表（非数字行被丢弃）；
       rc=1（无匹配，正常）-> []；
       rc=2（查询错误/盲）-> None（调用方据此拒绝拉起，不误判）；
       异常 -> []（按无重复处理，继续）。
     且 needle 必须是 ROOT/runtime/gateway.py（限定本工作区，load-bearing：断言调用参数）。
  W3 单实例守卫（_posix_single_instance_guard 的真实契约）：
       rc=0 且有除自身外的别的 PID -> True（调用方据此退出）；
       rc=0 但只有当前 pid -> [] -> False（继续）；
       rc=1（无匹配）-> False（继续）。
  W4 flock 回退两态（无 pgrep 时）：用假 fcntl 模块注入 sys.modules 让 import fcntl 成功
       —— 拿到锁（flock 正常返回）-> False；被占用（flock 抛 BlockingIOError）-> True。
       两态是同一 except (OSError, BlockingIOError) 卫语句的单变量翻转，load-bearing。

Run: python -X utf8 tests/test_watchdog_xplat_dispatch.py
"""
import os, sys, types, io

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)                                   # workspace root (Nebula-agent)
import gw_watchdog as W                                    # noqa: E402

FAILURES = []


def check(label, cond, extra=""):
    print("  " + ("OK   " if cond else "FAIL ") + label + (" " + extra if extra else ""))
    if not cond:
        FAILURES.append(label)


class FakeRun:
    """记录调用参数；按预设返回码/输出/异常驱动被测函数。"""
    def __init__(self, returncode=0, stdout=b"", raise_exc=None):
        self.returncode = returncode
        self.stdout = stdout
        self.raise_exc = raise_exc
        self.calls = []

    def run(self, argv, **kw):
        self.calls.append((argv, kw))
        if self.raise_exc is not None:
            raise self.raise_exc
        return types.SimpleNamespace(returncode=self.returncode, stdout=self.stdout,
                                     stderr=b"")


class R:  # tiny result shim for direct attribute read
    pass


_orig = (W.subprocess.run, sys.platform, sys.modules.get("fcntl"))
real_run, real_platform, real_fcntl = _orig


def restore():
    W.subprocess.run = real_run
    sys.platform = real_platform
    if real_fcntl is not None:
        sys.modules["fcntl"] = real_fcntl
    else:
        sys.modules.pop("fcntl", None)
    W._posix_single_instance_guard._fh = None


try:
    # ---------- W1: 分派走 pgrep，不是 powershell（load-bearing）----------
    sys.platform = "linux"
    fr = FakeRun(returncode=0, stdout=b"")
    W.subprocess.run = fr.run
    existing = W.existing_gateway_pids()
    used_pgrep = bool(fr.calls) and fr.calls[0][0][0] == "pgrep"
    used_powershell = bool(fr.calls) and "powershell" in [str(x).lower() for x in fr.calls[0][0]]
    check("W1 platform=linux -> existing_gateway_pids dispatches to pgrep (not powershell)",
          used_pgrep and not used_powershell,
          "calls=%r" % ([c[0] for c in fr.calls],))

    # ---------- W2: pgrep 三态 + needle 限定本工作区 ----------
    sys.platform = "win32"   # 直接调用 POSIX helper，绕过分派，专测其内部三态
    needle_expected = os.path.join(W.ROOT, "runtime", "gateway.py")

    # rc=0 多 PID（含非数字噪声行应被丢弃）-> int 列表
    fr = FakeRun(returncode=0, stdout=b"123\n456\nabc\n\n")
    W.subprocess.run = fr.run
    got = W._posix_existing_gateway_pids()
    needle_ok = bool(fr.calls) and needle_expected in fr.calls[0][0]
    check("W2a pgrep rc=0 -> int PID list (non-numeric dropped) + needle scoped to ROOT/runtime/gateway.py",
          got == [123, 456] and needle_ok,
          "got=%r needle_ok=%s" % (got, needle_ok))

    # rc=1 无匹配（正常）-> []
    fr = FakeRun(returncode=1, stdout=b"")
    W.subprocess.run = fr.run
    got = W._posix_existing_gateway_pids()
    check("W2b pgrep rc=1 (no match, normal) -> []", got == [], "got=%r" % (got,))

    # rc>=2 查询错误/盲 -> None（调用方拒绝拉起，不误判）
    fr = FakeRun(returncode=2, stdout=b"")
    W.subprocess.run = fr.run
    got = W._posix_existing_gateway_pids()
    check("W2c pgrep rc>=2 (query error/blind) -> None", got is None, "got=%r" % (got,))

    # 异常 -> []（按无重复处理）
    fr = FakeRun(raise_exc=RuntimeError("boom"))
    W.subprocess.run = fr.run
    got = W._posix_existing_gateway_pids()
    check("W2d pgrep raise -> [] (treated as no-dup)", got == [], "got=%r" % (got,))

    # ---------- W3: 单实例守卫三态 ----------
    # rc=0 有别的 PID（!= os.getpid()）-> True
    other = os.getpid() + 1  # 构造一个必然 != 自身的 pid
    fr = FakeRun(returncode=0, stdout=("%d\n" % other).encode())
    W.subprocess.run = fr.run
    got = W._posix_single_instance_guard()
    check("W3a other instance pid present -> True (caller should exit)", got is True,
          "got=%r other=%d" % (got, other))

    # rc=0 只有自身 pid -> 过滤掉 -> [] -> False（继续）
    fr = FakeRun(returncode=0, stdout=("%d\n" % os.getpid()).encode())
    W.subprocess.run = fr.run
    got = W._posix_single_instance_guard()
    check("W3b only self pid -> filtered -> False (continue)", got is False, "got=%r" % (got,))

    # rc=1 无匹配 -> 落到函数尾 -> False
    fr = FakeRun(returncode=1, stdout=b"")
    W.subprocess.run = fr.run
    got = W._posix_single_instance_guard()
    check("W3c pgrep rc=1 (no other) -> False (continue)", got is False, "got=%r" % (got,))

    # ---------- W4: flock 回退两态（无 pgrep 时；假 fcntl 注入）----------
    W._posix_single_instance_guard._fh = None
    fcntl_mod = types.ModuleType("fcntl")
    fcntl_mod.LOCK_EX = 2
    fcntl_mod.LOCK_NB = 4
    lock_state = {"raise": False}

    def _fake_flock(fh, flags):
        if lock_state["raise"]:
            raise BlockingIOError("locked")
    fcntl_mod.flock = _fake_flock
    sys.modules["fcntl"] = fcntl_mod

    # 无 pgrep：subprocess.run 抛 FileNotFoundError -> 进 flock 分支
    fr = FakeRun(raise_exc=FileNotFoundError("no pgrep"))
    W.subprocess.run = fr.run
    # 用临时目录里的锁文件避免污染真实工作区：把 ROOT 临时指向 tempdir
    import tempfile
    td = tempfile.mkdtemp()
    real_ROOT = W.ROOT
    try:
        W.ROOT = td
        W._posix_single_instance_guard._fh = None
        # W4a 拿到锁（flock 正常返回）-> False
        lock_state["raise"] = False
        got = W._posix_single_instance_guard()
        check("W4a no pgrep + flock acquires -> False (single instance, continue)",
              got is False, "got=%r" % (got,))
        # W4b 被占用（flock 抛 BlockingIOError）-> True（单变量翻转，load-bearing）
        W._posix_single_instance_guard._fh = None
        lock_state["raise"] = True
        got = W._posix_single_instance_guard()
        check("W4b no pgrep + flock BLOCKED -> True (another instance holds it)",
              got is True, "got=%r" % (got,))
    finally:
        W.ROOT = real_ROOT
        W._posix_single_instance_guard._fh = None
        import shutil
        shutil.rmtree(td, ignore_errors=True)

finally:
    restore()

print("\n%s" % ("ALL GREEN" if not FAILURES else "FAILURES: %s" % FAILURES))
sys.exit(1 if FAILURES else 0)
