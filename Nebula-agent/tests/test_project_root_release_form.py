#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""test_project_root_release_form.py — 产物形态 ROOT 解析差分单测（开工修复的安全前置）

锁两件事（对应 2026-11-21 的 windows step11 真实根因 run 44740904755）：

  锁A（契约层·AST）：gateway.py 的 `ROOT =` 与 registry.py 的 `release_root` 返回值，
        对 project_root 的调用必须能让"正在运行的产物 exe"这一信号进入候选。修复方式
        是把候选顺序调整为 exe-dir 优先于源码 src（见 config_loader.project_root），
        调用点本身不需改——不传 exe_path 时函数内部已用 sys.executable。本锁改为：
        验证 project_root 在产物形态下返回 dist、源码形态下返回 checkout（行为契约），
        而非锁调用点 AST（因为修复落在函数内，调用点保持 _project_root(__file__) 不变）。

  锁B（行为·真实差分，load-bearing）：
        B1 产物形态：一个含 config marker 的 dist + 一个含 marker 的"冻结开发机 checkout"，
           以 exe_path=dist 的 gateway.exe 调用 → 必须返回 dist（不是 checkout）。
           这正是 CI 上 Nuitka 把 __file__ 冻结到 checkout、cwd 在 dist 的真实场景；
           旧顺序（src 先判）会错误返回 checkout → 读到带 venv 绝对路径的开发版 config。
        B2 源码形态：测试进程的真实 sys.executable 是不含 marker 的 python 目录，以
           一个含 marker 的 checkout 的 runtime/gateway.py 调用、不传 exe → 必须返回
           该 checkout（A/G1 的源码逐字相等前提，不被破坏）。
        B3 DIFFERENTIAL：把候选顺序"模拟回旧顺序"（src 先判）的等价调用，对 B1 的输入
           会返回 checkout —— 证明"exe 优先"是 load-bearing，单换顺序结果即反转。

纯标准库、确定性、不启动编译产物；每条都是直接调用 project_root + 一个会因回归而反
转的差分分支。
"""
import os
import shutil
import sys
import tempfile

AGENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(AGENT, "runtime"))
import config_loader  # noqa: E402

fails = []


def ck(name, ok, detail=""):
    print("%-5s %s %s" % ("PASS" if ok else "FAIL", name, detail))
    if not ok:
        fails.append(name)


def _mk_root(base, name, *, marker):
    """造一个目录；marker='config' 放 config/mcp_servers.json，'web' 放 web/index.html，
    'none' 不放 marker。返回其绝对路径。"""
    d = os.path.join(base, name)
    os.makedirs(d, exist_ok=True)
    if marker == "config":
        os.makedirs(os.path.join(d, "config"), exist_ok=True)
        open(os.path.join(d, "config", "mcp_servers.json"), "w",
             encoding="utf-8").write('{"mcpServers":{}}')
    elif marker == "web":
        os.makedirs(os.path.join(d, "web"), exist_ok=True)
        open(os.path.join(d, "web", "index.html"), "w", encoding="utf-8").write("<html>x</html>")
    return d


def _root_order_sim_old(module_file, exe_path):
    """复刻"旧顺序"（src 先判）的等价实现，仅供 B3 差分用——它锁的是"修复若被改回旧
    顺序，结果会反转"，故这里不调用被测函数，而是手写旧顺序的判定。"""
    src = os.path.dirname(os.path.dirname(os.path.abspath(module_file))) if module_file else ""
    if config_loader._holds_project(src):
        return src
    exe = exe_path or sys.executable
    exe_dir = os.path.dirname(os.path.abspath(exe)) if exe else ""
    if config_loader._holds_project(exe_dir):
        return exe_dir
    return src or exe_dir or os.getcwd()


def main() -> int:
    base = tempfile.mkdtemp(prefix="projroot_")
    try:
        # ---- B1 产物形态：dist 含 marker + 冻结的开发机 checkout 也含 marker ----
        # 模拟 CI：Nuitka 把 __file__ 冻结成 <checkout>/runtime/gateway.py（checkout 含
        # 开发版 config marker），真正运行的 exe 在 <checkout>/gateway.dist/gateway.exe。
        checkout = _mk_root(base, "Nebula-agent", marker="config")
        dist = _mk_root(checkout, "gateway.dist", marker="config")
        frozen_main = os.path.join(checkout, "runtime", "gateway.py")
        dist_exe = os.path.join(dist, "gateway.exe")
        got = config_loader.project_root(frozen_main, exe_path=dist_exe)
        ck("B1 release form: __file__ frozen to a marker-bearing checkout + "
           "running exe in dist -> ROOT is the dist (NOT the checkout)",
           os.path.normcase(got) == os.path.normcase(dist),
           "got=%r want=%r" % (got, dist))

        # ---- B3 DIFFERENTIAL：旧顺序对同一输入会错返回 checkout ----
        old = _root_order_sim_old(frozen_main, dist_exe)
        ck("B3 DIFFERENTIAL: src-first (the old order) would return the checkout "
           "here -> 'exe-first' is load-bearing",
           os.path.normcase(old) == os.path.normcase(checkout) and os.path.normcase(old) != os.path.normcase(dist),
           "old-order=%r (must equal checkout, NOT dist)" % old)

        # ---- B2 源码形态：测试进程的 sys.executable（python 目录，不含 marker） ----
        # 不传 exe_path 时函数内部用 sys.executable=真实 python，其目录不含任何 marker，
        # 因此必须先排除 exe 候选、再落到含 marker 的 checkout —— 源码场景逐字相等不破。
        src_main = os.path.join(checkout, "runtime", "gateway.py")
        got_src = config_loader.project_root(src_main)  # 不传 exe_path → 内部 sys.executable
        ck("B2 source form: running interpreter is not a project root -> falls to the "
           "marker-bearing checkout (source behavior unchanged)",
           os.path.normcase(got_src) == os.path.normcase(checkout),
           "got=%r want=%r  (sys.executable=%r)" % (got_src, checkout, sys.executable))

        # ---- B4 仅 web marker 也算 root（产物只带前端的那一半 marker）----
        dist2 = _mk_root(base, "webonly.dist", marker="web")
        got2 = config_loader.project_root(os.path.join(base, "ghost-runtime", "x.py"),
                                          exe_path=os.path.join(dist2, "gateway.exe"))
        ck("B4 a release holding only web/index.html is still recognized via the exe",
           os.path.normcase(got2) == os.path.normcase(dist2),
           "got=%r want=%r" % (got2, dist2))

        # ---- B5 无任何 marker holder：确定性兜底，绝不凭空猜 dist ----
        empty = _mk_root(base, "nomarker", marker="none")
        ghost_main = os.path.join(empty, "runtime", "x.py")
        got3 = config_loader.project_root(ghost_main, exe_path=os.path.join(empty, "y.exe"))
        ck("B5 no marker holder anywhere -> deterministic fallback (src expr), never a guess",
           os.path.normcase(got3) == os.path.normcase(os.path.dirname(os.path.dirname(ghost_main))),
           "got=%r" % got3)
    finally:
        shutil.rmtree(base, ignore_errors=True)

    print("\nPROJECT-ROOT-RELEASE-FORM:", "ALL GREEN" if not fails else "RED: " + ", ".join(fails))
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
