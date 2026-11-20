#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""make_release_entries.py — 闭源产物(C 形态)里 MCP 子进程的自定位启动表。

背景（见 scripts/CLOSED_SOURCE_BUILD.md 4.5 节，已采纳 C）：
  servers/*.py 被 `nuitka --mode=module` 编成平台原生 fs_server.pyd / _mcp_base.pyd …。
  .pyd 是扩展模块，不能 `python fs_server.pyd` 直接执行，而且其
  `if __name__ == "__main__"` 永不成立 —— 于是入口改由【编译后的 gateway 自己】承担：
      gateway.exe --server <name>        # import <name> 后调 main()，stdio 跑 MCP
  因此产物内不再需要第二个 python 解释器，也绝没有任何绝对安装路径。

本脚本做三件事（都是构建期一次性生成，产物可搬目录）：
  1) 校验每个 <name>.<pyext> 真能被 import 且暴露 main()（真跑 import，不是读文本）；
  2) 校验需要 runtime 模块的 server 所依赖的 runtime.<name>.<pyext> 也在产物里；
  3) 写出 entries.dist（相对路径启动表），供打包步骤放进产物根目录。

用法（CI 内，cwd = Nebula-agent）：
    python scripts/make_release_entries.py build \
        --out entries.dist \
        --entrypoint gateway.dist/gateway.exe \
        --pyext .pyd --windows \
        --runtime-modules memory,corpus,registry,audit,scheduler \
        --inherit config/mcp_servers.json
"""
import argparse
import glob
import importlib.machinery
import json
import os
import subprocess
import sys

# servers/<name>.py 里【需要 runtime/ 兄弟模块】的那几个，及它们各自 import 什么。
# （实测来源：对 servers/*.py 做 AST 扫描 —— 见 CLOSED_SOURCE_BUILD.md 4.5 第 2 条。
#  browser/fs/shell 只依赖 _mcp_base，故不在表内；_mcp_base 由 CI 一并编成 .pyd。）
NEEDS_RUNTIME = {
    "memory_server": ["corpus", "memory"],
    "registry_server": ["registry", "audit"],
    "schedule_server": ["scheduler"],
    "skillhub_server": ["executor"],
}

# entries 的名字（与工具前缀 <server>__<tool> 一致，绝不能改名）
SERVERS = [
    ("filesystem", "fs_server"),
    ("shell", "shell_server"),
    ("websearch", "websearch_server"),
    ("memory", "memory_server"),
    ("browser", "browser_server"),
    ("schedule", "schedule_server"),
    ("skillhub", "skillhub_server"),
    ("registry", "registry_server"),
]

# 从 --inherit 的原 config 里只搬这几段（session/mcp 是纯参数，不含任何路径）
INHERIT_SECTIONS = ("mcp", "session")


def find_module_file(build_dir, mod, pyext):
    """返回产物目录里该模块【真实】的文件名（含 abi tag 的也算），找不到返回 None。

    为什么不能死拼 mod+pyext：Linux/macOS 的 CPython 扩展模块带 abi tag，真实落盘名是
    mod.cpython-313-x86_64-linux-gnu.so（见 step 9 "Successfully created ..." 的实测；Windows
    的 .pyd 不带 tag，故只有 win job 之前侥幸通过）。这里的后缀候选取解释器自己 import 时
    用的规则（importlib.machinery.EXTENSION_SUFFIXES），与 probe_module 里 importlib.import_module
    的查找严格一致——构建期说的"有没有"必须等于运行时说的"能不能 import"，否则就是假报缺。
    pyext 仍作首选以兼容既有 --pyext 语义；末尾再按 tag 形态 glob 兜底（abi3/cp3xx/平台串）。
    """
    cand = [mod + pyext]                                   # 调用方显式指定的首选（如 .pyd）
    for suf in importlib.machinery.EXTENSION_SUFFIXES:     # ['.cpython-313-...-linux-gnu.so', '.abi3.so', '.so'...]
        cand.append(mod + suf)
    for pat in (mod + ".abi3" + pyext, mod + ".*" + pyext, mod + ".cpython-*" + pyext):
        # basename() 统一成裸文件名：与上面 mod+pyext / EXTENSION_SUFFIXES 两个候选分支同构
        # （它们返回的是相对 build_dir 的名字）。否则这里会漏出完整路径、语义不一致。
        cand += [os.path.basename(p) for p in sorted(glob.glob(os.path.join(build_dir, pat)))]
    seen, out = set(), []
    for c in cand:
        if c not in seen:
            seen.add(c); out.append(c)
    for c in out:
        if os.path.isfile(os.path.join(build_dir, c)):
            return c
    return None


def probe_module(build_dir, name, pyext):
    """真跑一次 `python -c "import <name>; ..."`：验证 .pyd 可导入且有 main()。

    用子进程而不是本进程 import：每个 .pyd 一进一出的副作用（读 env、连管道）互不影响，
    且失败信息能逐条报出来。
    """
    code = (
        "import importlib,sys;"
        "m=importlib.import_module(%r);"
        "f=getattr(m,'main',None);"
        "sys.stderr.write('NO-MAIN' if f is None else 'OK '+(getattr(m,'__file__','') or ''));"
        "sys.exit(0 if f is not None else 3)" % name
    )
    p = subprocess.run([sys.executable, "-c", code], cwd=build_dir,
                       capture_output=True, text=True, encoding="utf-8",
                       errors="replace", stdin=subprocess.DEVNULL, timeout=120)
    out = ((p.stdout or "") + (p.stderr or "")).strip()
    return p.returncode, out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("build_dir", help="nuitka --mode=module --output-dir 的产物目录")
    ap.add_argument("--out", required=True, help="写出 entries.dist 的路径")
    ap.add_argument("--entrypoint", required=True,
                    help="编译后 gateway 的路径（Windows 写 gateway.exe）")
    ap.add_argument("--pyext", default=".pyd", help="扩展名：.pyd(win) / .so(linux/macos)")
    ap.add_argument("--windows", action="store_true", help="Windows：命令走反斜杠且需 .exe")
    ap.add_argument("--runtime-modules", default="",
                    help="已编译进产物的 runtime 模块名（逗号分隔）")
    ap.add_argument("--inherit", default="",
                    help="可选：从这份开发 config 里搬 mcp/session 两段纯参数")
    a = ap.parse_args(argv)

    build_dir = os.path.abspath(a.build_dir)
    if not os.path.isdir(build_dir):
        print("BUILD DIR NOT FOUND: %s" % build_dir, file=sys.stderr)
        return 2
    runtime_mods = {m.strip() for m in a.runtime_modules.split(",") if m.strip()}

    # 自定位：产物里的 command/cwd 只写 token，绝不含绝对路径。
    # @SELF = 正在运行的解释器本身（闭源产物里就是编译后的 gateway，无需第二个 python）
    # @ROOT = 它所在的产物根目录（registry.release_root() 现场由 __file__ 推导）
    # 两者都在启动时由 runtime/registry.resolve_servers() 展开，所以三平台可以是同一份文本。
    # --entrypoint 只用于日志与"该文件确实在产物里"的校验，不进 entries。
    ep = a.entrypoint.replace("\\", "/")
    ep_name = os.path.basename(ep)

    problems, entries = [], {}
    for name, mod in SERVERS:
        # 1) 模块在位 + 可 import + 有 main()。"在位"按真实落盘名判定（含 abi tag），
        #    绝不死拼 mod+pyext——那样在非 Windows 平台会把已成功编译的 .so 误报为缺。
        if find_module_file(build_dir, mod, a.pyext) is None:
            problems.append("MISSING-MODULE %s (%s%s not found under any interpreter suffix)" % (mod, mod, a.pyext))
            continue
        rc, out = probe_module(build_dir, mod, a.pyext)
        if rc != 0 or not out.startswith("OK"):
            problems.append("PROBE %s: rc=%s %s" % (mod, rc, out[:200]))
            continue
        # 2) 它 import 的 runtime 模块也必须已编译进产物
        for dep in NEEDS_RUNTIME.get(mod, []):
            if dep not in runtime_mods:
                problems.append("MISSING-RUNTIME-MODULE %s <- needed by %s" % (dep, mod))
        # 3) 自定位条目：只写 token —— 无绝对路径、无平台专属写法
        entries[name] = {
            "command": "@SELF",
            "args": ["--server", mod],
            "cwd": "@ROOT",
        }
        # 技能展开出的 example-server 走同一形态（产物里同样编成 example_server.pyd，
        # 见 CI 的 servers 编译步骤）。

    # skill 生成的条目（名字取 mcp 名，args 里的模块名是文件名去扩展名）
    entries.setdefault("example-server", {
        "command": "@SELF",
        "args": ["--server", "example_server"],
        "cwd": "@ROOT",
    })
    if find_module_file(build_dir, "example_server", a.pyext) is None:
        problems.append("MISSING-MODULE example_server (no interpreter-suffixed file for it)")

    doc = {"mcpServers": entries}
    if a.inherit and os.path.isfile(a.inherit):
        try:
            src = json.load(open(a.inherit, encoding="utf-8-sig"))
            for k in INHERIT_SECTIONS:
                if isinstance(src.get(k), dict):
                    doc[k] = src[k]
        except Exception as e:
            print("WARN: could not inherit %s: %s" % (a.inherit, e), file=sys.stderr)

    if problems:
        for p in problems:
            print("FAIL " + p, file=sys.stderr)
        print("ENTRIES: RED (%d problem(s))" % len(problems), file=sys.stderr)
        return 1

    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    # 自证（承重）：读回自己写的文件逐字段核对 —— command/cwd 必须是 token，
    # 且任何一个字段都不是绝对路径。这是"产物能搬到任意目录"的硬条件，
    # 用 os.path.isabs 判定（Windows 上盘符与 / 开头都为真），不用正则。
    back = json.load(open(a.out, encoding="utf-8"))
    flaws = []
    for sname, ent in (back.get("mcpServers") or {}).items():
        if ent.get("command") != "@SELF":
            flaws.append("%s.command=%r expected @SELF" % (sname, ent.get("command")))
        if ent.get("cwd") != "@ROOT":
            flaws.append("%s.cwd=%r expected @ROOT" % (sname, ent.get("cwd")))
        alist = ent.get("args") or []
        if alist[:1] != ["--server"]:
            flaws.append("%s.args=%r expected [--server, <module>]" % (sname, alist))
        for v in [ent.get("command"), ent.get("cwd")] + list(alist):
            if isinstance(v, str) and os.path.isabs(v):
                flaws.append("%s leaks an absolute path: %r" % (sname, v))
    if flaws:
        for f in flaws:
            print("FAIL " + f, file=sys.stderr)
        print("ENTRIES: RED after write (%d)" % len(flaws), file=sys.stderr)
        return 1
    print("ENTRIES: GREEN %d servers -> %s (all command/cwd as @SELF/@ROOT; "
          "entrypoint %s is validated only, not embedded)" % (len(entries), a.out, ep_name))
    return 0


if __name__ == "__main__":
    sys.exit(main())
