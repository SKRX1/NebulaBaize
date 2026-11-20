#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Nebula Agent 网关看门狗（可选增强）
==================================
覆盖 run_standalone.bat 重启循环都救不了的场景：整个网关窗口被关闭、
或进程被从外部杀掉（重启循环本身也跟着死）。

工作方式：每 CHECK_INTERVAL 秒探测 127.0.0.1:PORT 是否在监听；
不在监听且不存在停止标志 .gw_stop.flag 时，拉起 run_standalone.bat。

与 run_standalone.bat 的停止标志共用，二者互斥地读取 .gw_stop.flag：
- 想彻底停掉：先创建 .gw_stop.flag，再关窗口。
- 想恢复自动拉起：删除 .gw_stop.flag 后重新启动本看门狗。

后台运行建议（登录即启动，崩溃自愈）：
  schtasks /create /tn "NebulaGWWatchdog" /tr "\"<python>\" \"<本文件绝对路径>\"" /sc onlogon /rl highest
其中 <python> 用 Nebula-agent/.venv/Scripts/python.exe 的绝对路径。
"""
import os
import socket
import subprocess
import sys
import time

PORT = 8099
ROOT = os.path.dirname(os.path.abspath(__file__))
# win32 拉起 run_standalone.bat；POSIX 拉起同名 POSIX 入口 run_standalone.sh。
STANDALONE = os.path.join(
    ROOT, "run_standalone.bat" if sys.platform == "win32" else "run_standalone.sh")
STOP_FLAG = os.path.join(ROOT, ".gw_stop.flag")
CHECK_INTERVAL = 10  # 秒


def is_listening(port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1.0)
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    finally:
        s.close()


MAX_SKIP = 2      # guard: consecutive launches skipped when a gateway exists but 8099 is not listening


def existing_gateway_pids() -> list[int]:
    """gateway.py processes in this workspace (pure-ASCII match string: Chinese in
    PS -Command depends on the code page and is unreliable). Returns [] on query
    failure. Motivation: a gateway that is alive but NOT listening (starting/binding
    failure) used to get a SECOND instance pulled -- double-instance observed on
    2026-10-21 10:49. Guard: skip launch when others exist, for at most MAX_SKIP
    rounds, then launch anyway so a truly dead gateway is never parked."""
    existing_gateway_pids.streak = getattr(existing_gateway_pids, "streak", 0)
    if sys.platform != "win32":
        return _posix_existing_gateway_pids()
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | "
             "Where-Object { $_.CommandLine -match 'gateway.py' } | "
             "Select-Object -ExpandProperty ProcessId"],
            capture_output=True, timeout=10, cwd=ROOT)
        if r.returncode != 0:
            print(f"[watchdog] 警告：进程查询 powershell 非零退出 code={r.returncode}"
                  f"（守卫本轮盲跑，按无重复处理）", file=sys.stderr)
        return [int(x) for x in r.stdout.decode("utf-8", "replace").split() if x.strip().isdigit()]
    except subprocess.TimeoutExpired:
        # 10s timeout: the query itself is blind this round -- do NOT launch on a
        # blind read; let the guard skip and re-probe on the next cycle instead.
        print("[watchdog] 警告：进程查询超时（10s），守卫本轮拒绝拉起以免瞎眼误判", file=sys.stderr)
        return None
    except Exception as exc:  # noqa: BLE001
        print(f"[watchdog] 警告：进程查询失败 {exc!r}（守卫本轮盲跑，按无重复处理）", file=sys.stderr)
        return []


existing_gateway_pids.streak = 0


def launch() -> None:
    # win32：新建控制台窗口，独立于看门狗；run_standalone.bat 内部已含重启循环。
    if sys.platform == "win32":
        subprocess.Popen(
            f'cmd /c "{STANDALONE}"',
            creationflags=subprocess.CREATE_NEW_CONSOLE,
        )
        return
    # POSIX：脱离当前会话后台拉起 run_standalone.sh（其内部已含重启循环）。
    subprocess.Popen(["bash", STANDALONE], start_new_session=True,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _posix_existing_gateway_pids():
    """POSIX 网关进程探测：pgrep -f 匹配本工作区 gateway.py 的绝对路径（限定到本 ROOT，
    避免误匹配别处同名）。返回 PID 列表；查询工具异常/返回码>=2 时返回 None（本轮盲跑，
    由调用方守卫拒绝拉起、下轮再探），无匹配返回 []。与 win32 powershell CIM 分支语义对齐。"""
    needle = os.path.join(ROOT, "runtime", "gateway.py")
    try:
        r = subprocess.run(["pgrep", "-f", needle], capture_output=True, timeout=10, cwd=ROOT)
        # pgrep 退出码：0=有匹配, 1=无匹配(正常), >=2=错误(查询盲 -> None, 不误判)
        if r.returncode >= 2:
            print(f"[watchdog] POSIX 进程查询失败 code={r.returncode}（本轮盲跑，拒绝拉起）",
                  file=sys.stderr)
            return None
        return [int(x) for x in r.stdout.decode("utf-8", "replace").split() if x.strip().isdigit()]
    except Exception as exc:  # noqa: BLE001
        print(f"[watchdog] POSIX 进程查询失败 {exc!r}（本轮盲跑，按无重复处理）", file=sys.stderr)
        return []


def _posix_single_instance_guard():
    """POSIX 单实例守卫：pgrep -f 匹配本文件绝对路径，除自身外仍有别的实例则返回 True
    （调用方据此退出）。无 pgrep 时退回 flock（进程退出自动释放）。win32 走命名互斥体（见 main）。"""
    try:
        r = subprocess.run(["pgrep", "-f", os.path.join(ROOT, "gw_watchdog.py")],
                           capture_output=True, timeout=10)
        if r.returncode == 0:
            pids = [int(x) for x in r.stdout.decode("utf-8", "replace").split()
                    if x.strip().isdigit() and int(x) != os.getpid()]
            if pids:
                print(f"[watchdog] 已有实例在运行 PID {pids}，退出（单实例守卫）。")
                return True
    except FileNotFoundError:
        # 无 pgrep：退回基于文件锁的守卫（flock 进程退出自动释放）。
        try:
            import fcntl
            fh = _posix_single_instance_guard._fh
            if fh is None:
                fh = _posix_single_instance_guard._fh = open(
                    os.path.join(ROOT, ".gw_watchdog.lock"), "a")
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, BlockingIOError):
            print("[watchdog] 已有实例在运行，退出（flock 单实例守卫）。")
            return True
        return False
    except Exception as exc:  # noqa: BLE001
        print(f"[watchdog] POSIX 单实例守卫检查失败，继续: {exc}")
    return False


_posix_single_instance_guard._fh = None


def main() -> int:
    if sys.platform != "win32":
        # POSIX 单实例守卫：另有实例在跑则退出；无 pgrep 时退回 flock（见 helper）。
        if _posix_single_instance_guard():
            return 0
    else:
        # 单实例守卫（win32）：Windows 命名互斥体，进程退出自动释放，避免重复启动拉起多个看门狗。
        # 注意：必须用 ctypes.GetLastError()（而非 kernel32.GetLastError()），否则 ctypes
        # 内部参数转换会清掉 last-error，导致 ERROR_ALREADY_EXISTS(183) 永远读不到、守卫失效。
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            CreateMutexW = kernel32.CreateMutexW
            CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
            CreateMutexW.restype = ctypes.c_void_p
            CreateMutexW(None, 0, "Global\\NebulaGWWatchdog")
            if ctypes.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
                print("[watchdog] 已有实例在运行，退出（单实例守卫）。")
                return 0
        except Exception as exc:  # noqa: BLE001
            print(f"[watchdog] 单实例守卫检查失败，继续: {exc}")

    print(f"[watchdog] 监控 127.0.0.1:{PORT}，每 {CHECK_INTERVAL}s 检测一次。")
    print(f"[watchdog] 停止：创建 {STOP_FLAG} 并关闭窗口。按 Ctrl+C 退出本看门狗。")
    try:
        while True:
            if os.path.exists(STOP_FLAG):
                print("[watchdog] 检测到停止标志，退出。")
                return 0
            try:
                if not is_listening(PORT):
                    others = existing_gateway_pids()
                    if others is None:                       # query blind -> skip, no blind launch
                        time.sleep(CHECK_INTERVAL)
                        continue
                    if others and existing_gateway_pids.streak < MAX_SKIP:
                        existing_gateway_pids.streak += 1
                        print(f"[watchdog] {PORT} 未监听，但检测到 gateway 进程 PID {others}"
                              f"（可能启动中/绑定失败）——跳过本次拉起以免双实例"
                              f"（连跳 {existing_gateway_pids.streak}/{MAX_SKIP} 后放行）")
                    else:
                        existing_gateway_pids.streak = 0
                        print(f"[watchdog] {PORT} 未监听，拉起网关 ...")
                        launch()
            except Exception as exc:  # noqa: BLE001
                print(f"[watchdog] 检测/拉起异常: {exc}")
            time.sleep(CHECK_INTERVAL)
    except KeyboardInterrupt:
        print("\n[watchdog] 手动退出。")
        return 0


if __name__ == "__main__":
    sys.exit(main())
