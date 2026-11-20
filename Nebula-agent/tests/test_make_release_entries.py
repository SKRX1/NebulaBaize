# -*- coding: utf-8 -*-
"""test_make_release_entries.py — 锁 make_release_entries.find_module_file 的真实文件定位。

为什么必须有它（一次真实的 CI 失败换来的）：
  run 44716363016 三平台在第 10 步报 9 个 "MISSING-MODULE *_server.so"，但 step 9 明明
  "Successfully created 'gateway.dist/fs_server.cpython-313-x86_64-linux-gnu.so'"。
  旧代码用 `os.path.isfile(mod + pyext)` 死拼出 "fs_server.so"，在 Linux/macOS 上 CPython
  扩展模块带 abi tag（真实名带 .cpython-313-<arch>-<os>.so），所以死拼必然 False —— 把
  已成功编译的产物误报成缺。Windows 的 .pyd 不带 tag，故只有 win job 之前侥幸通过。

本测试用真实文件系统（tempfile 造 build 目录 + 真实落盘名），不调用整个 main()（那需要
真的 .so 能 import）；只针对 find_module_file 这个"构建期说有没有 == 运行时能不能 import"
的承重点。每项都配一个"旧逻辑在同样输入上必假报缺"的差分，证明新代码 load-bearing。

跨平台策略：不依赖本机解释器具体是什么 tag —— 用 CI 实测过的真实名字面量
（fs_server.cpython-313-x86_64-linux-gnu.so 等）做夹具，走 find_module_file 里的
glob 兜底分支（mod + ".cpython-*" + pyext），三平台结果一致、可复现。
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "scripts"))
import make_release_entries as mre  # noqa: E402

FAILS = []


def ck(name, ok, detail=""):
    print("%-6s %s %s" % ("PASS" if ok else "FAIL", name, detail))
    if not ok:
        FAILS.append(name)


def touch(path):
    with open(path, "wb") as f:
        f.write(b"\x00")  # 内容无关，只要求文件存在


def main():
    tmp = tempfile.mkdtemp(prefix="mre_abitag_")

    # ---- 项1：复现 CI 的真实失败名（Linux abi tag），pyext=.so ----
    # 真实落盘名（CI step 9 字面产出）。旧代码会死拼 "fs_server.so" 并判缺；新代码必须经
    # glob 兜底（mod + ".cpython-*" + pyext）找到真名。
    linux_name = "fs_server.cpython-313-x86_64-linux-gnu.so"
    touch(os.path.join(tmp, linux_name))
    got = mre.find_module_file(tmp, "fs_server", ".so")
    ck("T1 find_module_file resolves the REAL abi-tagged Linux name",
       got == linux_name, "got=%r want=%r" % (got, linux_name))
    # 差分：旧逻辑（死拼 mod+pyext）在完全相同的目录下判"不存在" —— 证明 T1 是新代码承重。
    legacy_hit = os.path.isfile(os.path.join(tmp, "fs_server" + ".so"))
    ck("T2 DIFFERENTIAL: the old isfile(mod+pyext) check is FALSE here (so T1 is load-bearing)",
       legacy_hit is False, "old isfile(fs_server.so)=%s (must be False)" % legacy_hit)

    # ---- 项3：macOS tag 同理（aarch64 / x86_64 平台串不同，glob 仍应命中）----
    mac_name = "memory_server.cpython-313-darwin.so"
    touch(os.path.join(tmp, mac_name))
    got2 = mre.find_module_file(tmp, "memory_server", ".so")
    ck("T3 a macOS-tagged name resolves too",
       got2 == mac_name, "got=%r want=%r" % (got2, mac_name))

    # ---- 项4：abi3 名（mod.abi3.so）也应命中 ----
    abi3 = "browser_server.abi3.so"
    touch(os.path.join(tmp, abi3))
    got3 = mre.find_module_file(tmp, "browser_server", ".so")
    ck("T4 an abi3 name resolves", got3 == abi3, "got=%r want=%r" % (got3, abi3))

    # ---- 项5：首选名（plain mod+pyext）存在时优先返回首选，而非 tag 名 ----
    # 这保证 --pyext 语义不被破坏：调用方明确给的扩展名若真在，就用它。
    plain_dir = tempfile.mkdtemp(prefix="mre_plain_")
    touch(os.path.join(plain_dir, "fs_server.pyd"))
    touch(os.path.join(plain_dir, "fs_server.cpython-313-win_amd64.pyd"))
    got4 = mre.find_module_file(plain_dir, "fs_server", ".pyd")
    ck("T5 plain mod+pyext wins when present (the --pyext first choice)",
       got4 == "fs_server.pyd", "got=%r" % got4)

    # ---- 项6：什么都没有 -> None（不是误报、也不是抛异常）----
    empty = tempfile.mkdtemp(prefix="mre_empty_")
    got5 = mre.find_module_file(empty, "fs_server", ".so")
    ck("T6 a genuinely absent module returns None", got5 is None, "got=%r" % got5)

    # ---- 项7：example_server 走的是同一函数（CI 里它也被死拼误报过）----
    ex = "example_server.cpython-313-x86_64-linux-gnu.so"
    touch(os.path.join(tmp, ex))
    got6 = mre.find_module_file(tmp, "example_server", ".so")
    ck("T7 example_server (also flagged MISSING in CI) resolves",
       got6 == ex, "got=%r" % got6)

    print("\nMAKE-RELEASE-ENTRIES:", "ALL GREEN" if not FAILS else "RED: " + ", ".join(FAILS))
    return 0 if not FAILS else 1


if __name__ == "__main__":
    sys.exit(main())
