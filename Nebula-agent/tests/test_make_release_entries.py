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

    # ---- 项8：自证判据 _config_token_flaws —— 正确的产物 config 必须 0 flaws ----
    # 方案A 后产物里只有磁盘这一份 @SELF 形态（编译期不再内嵌）。_config_token_flaws 既是
    # make_release_entries 对自身 a.out 的自证，也是 --verify-config 对"运行时真读的那份"的复证
    # ——它的语义就是这条防复发锁的承重，正确形态必须放过。
    good = {"mcpServers": {
        "filesystem": {"command": "@SELF", "args": ["--server", "fs_server"], "cwd": "@ROOT"},
        "example-server": {"command": "@SELF", "args": ["--server", "example_server"], "cwd": "@ROOT"},
    }}
    ck("T8 a correct @SELF/@ROOT config has zero token flaws",
       mre._config_token_flaws(good) == [], "got=%r" % (mre._config_token_flaws(good),))

    # ---- 项9：本轮 CI 根因形态——开发机绝对 venv 路径写进 command 必须报 flaw ----
    # 真实失败：产物 config 的 command=E:\...\Nebula-agent\.venv\Scripts\python.exe，gateway
    # 运行时读到它、9 个子进程全部 [WinError 2]。"command 不是 @SELF" 这条 flaw 跨平台稳定
    # （不依赖 os.path.isabs 的平台判定），所以三平台都能锁住这个根因。
    dev = {"mcpServers": {
        "filesystem": {"command": "E:\\Nebula\\NebulaBaize\\.venv\\Scripts\\python.exe",
                       "args": ["-m", "serve.fs_server"], "cwd": "E:\\Nebula\\NebulaBaize"},
    }}
    g9 = mre._config_token_flaws(dev)
    ck("T9 DIFFERENTIAL: the REAL root-cause config (absolute venv path as command) is flagged",
       len(g9) >= 1 and any("expected @SELF" in f for f in g9), "got=%r" % (g9,))
    ck("T9b same bad config also flags the non-@ROOT cwd",
       any("expected @ROOT" in f for f in g9), "got=%r" % (g9,))

    # ---- 项10：absolute-path 这条腿单独锁（POSIX / 开头，isabs 三平台一致为真）----
    # 绕开 Windows 盘符在不同平台 isabs 不一致的陷阱；证明 isabs 分支 load-bearing。args 同时
    # 不以 --server 起头，也应被报。
    # isabs 的绝对路径要按当前平台构造：nt 只认盘符/反斜杠，POSIX 只认 /。一个跨平台字面量
    # 做不到（Windows 上 os.path.isabs("/x") 是 False）。command/cwd 保持 token、args 以
    # --server 起头，这样此处唯一能触发的就是绝对路径分支 —— 纯锁 isabs 这条腿 load-bearing。
    abs_arg = "C:\\abs\\run.sh" if os.name == "nt" else "/abs/path/run.sh"
    mix = {"mcpServers": {
        "shell": {"command": "@SELF", "args": ["--server", abs_arg], "cwd": "@ROOT"},
    }}
    g10 = mre._config_token_flaws(mix)
    ck("T10 an absolute path anywhere in a server entry is flagged (leaks an absolute path)",
       any("leaks an absolute path" in f for f in g10), "got=%r" % (g10,))
    # T10b：args 不以 --server 起头（如 ["-m", mod]）必须被报 —— 锁 args 结构这条腿。
    g10b = mre._config_token_flaws({"mcpServers": {
        "shell": {"command": "@SELF", "args": ["-m", "x"], "cwd": "@ROOT"}}})
    ck("T10b args not starting with --server is flagged too",
       any("expected [--server" in f for f in g10b), "got=%r" % (g10b,))

    print("\nMAKE-RELEASE-ENTRIES:", "ALL GREEN" if not FAILS else "RED: " + ", ".join(FAILS))
    return 0 if not FAILS else 1


if __name__ == "__main__":
    sys.exit(main())
