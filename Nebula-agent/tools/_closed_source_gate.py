# -*- coding: utf-8 -*-
"""_closed_source_gate.py -- 闭源产物路径层的常驻门禁（纯 stdlib，不联网、不读 temp/）。

锁四件事，每件都配一个"翻转即红"的差分：
  G1 源码版 root 判定与旧公式逐字相等（改 ROOT 绝不能动开发机行为）
  G2 编译版（__file__ 比源码布局浅一层）必须落在产物根，而不是它的上一级
     ——差分：旧公式在同一个输入上必须判错（证明本修复 load-bearing）
  G3 两处都没有 marker 时必须退回可预测的兜底，不许凭空猜一个 root
  G4 find_web_dir 在两布局下各取 serve/web 与 web/
  G5 .github/workflows/build-release.yml 的步骤顺序与 3b 编译清单没漂移
     （用纯文本顺序断言，不依赖 PyYAML —— 本项目的 venv 按设计不装它）

真产物（temp/release-smoke/…）不在范围内：那是我手工下载的运行时资源，会被清掉，
门禁不能依赖它。它的实测是一次性的（见 tools/_root_artifact_gate.py，用完即删）。
"""
import os
import re
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))     # Nebula-agent
for _p in (os.path.join(ROOT, "runtime"),):
    if _p not in sys.path:
        sys.path.insert(0, _p)
try:
    import config_loader as cl
except ImportError:                                            # 仓库根起的场合
    sys.path.insert(0, os.path.join(os.path.dirname(ROOT), "Nebula-agent", "runtime"))
    import config_loader as cl

FAILS = []


def ck(name, ok, detail=""):
    print("%-5s %s %s" % ("PASS" if ok else "FAIL", name, detail))
    if not ok:
        FAILS.append(name)


def fake_build(with_config=True, with_web=True):
    """造一个 Nuitka standalone 形状的产物目录：exe 与 config/ web/ 同级。"""
    d = tempfile.mkdtemp(prefix="csbuild_")
    if with_config:
        os.makedirs(os.path.join(d, "config"))
        open(os.path.join(d, "config", "mcp_servers.json"), "w",
             encoding="utf-8").write('{"mcpServers":{}}')
    if with_web:
        os.makedirs(os.path.join(d, "web"))
        open(os.path.join(d, "web", "index.html"), "w", encoding="utf-8").write("<html>x</html>")
    return d


# ── G1 源码版逐字相等 ────────────────────────────────────────────────────────
legacy = os.path.dirname(os.path.dirname(os.path.abspath(cl.__file__)))   # config_loader 也在 runtime/
src_root = cl.project_root(os.path.join(ROOT, "runtime", "gateway.py"))
ck("G1 source checkout root == legacy two-dirnames", src_root == legacy, src_root)
ck("G1b that root really holds config/mcp_servers.json",
   os.path.isfile(os.path.join(src_root, "config", "mcp_servers.json")))
ck("G1c find_web_dir on a checkout -> serve/web",
   cl.find_web_dir(src_root) == os.path.join(src_root, "serve", "web"))

# ── G2 编译版落点 + 差分 ─────────────────────────────────────────────────────
d = fake_build()
try:
    main_file = os.path.join(d, "gateway.py")           # Nuitka 给 __main__ 的模拟形态
    exe = os.path.join(d, "gateway.exe")
    got = cl.project_root(main_file, exe_path=exe)
    ck("G2 compiled main-module -> the release dir", got == d, got)
    old_answer = os.path.dirname(os.path.dirname(main_file))
    ck("G2d DIFFERENTIAL: the old formula lands OUTSIDE it",
       old_answer != d and not os.path.isfile(
           os.path.join(old_answer, "config", "mcp_servers.json")),
       "old=%s" % old_answer)
    ck("G3 web dir on a release -> web/ (not serve/web)",
       cl.find_web_dir(d) == os.path.join(d, "web"), cl.find_web_dir(d))
    ck("G4 library-module form (exe-dir __file__) -> same release dir",
       cl.project_root(os.path.join(d, "registry.py"), exe_path=exe) == d)
    ck("G4b library-module form (runtime/ subdir __file__) -> same release dir",
       cl.project_root(os.path.join(d, "runtime", "registry.py"), exe_path=exe) == d)
    # 只有 web/index.html、没有 config（另一个 marker）也要认
    d2 = fake_build(with_config=False)
    ck("G5 a release holding only web/index.html is still recognized",
       cl.project_root(os.path.join(d2, "gateway.py"),
                       exe_path=os.path.join(d2, "gateway.exe")) == d2)
    # 没有任何 marker holder：必须回到可预测的兜底（src 表达式），不猜
    d3 = tempfile.mkdtemp(prefix="csnone_")
    ghost = os.path.join(d3, "runtime", "x.py")
    ck("G6 no marker holder -> deterministic fallback, never a guess",
       cl.project_root(ghost, exe_path="") == os.path.dirname(os.path.dirname(ghost)))
finally:
    for x in (d, d2, d3):
        import shutil
        shutil.rmtree(x, ignore_errors=True)

# ── G5 CI 步骤顺序与 3b 清单（纯文本，不依赖 PyYAML） ───────────────────────
YML = os.path.join(os.path.dirname(ROOT), ".github", "workflows", "build-release.yml")
if os.path.isfile(YML):
    text = open(YML, encoding="utf-8").read()
    ORDER = [
        "name: Obfuscate frontend",
        "name: Front-end smoke",
        "name: Restore C-compiler cache",
        "name: Probe build parallelism",
        "name: Compile with Nuitka",
        "name: Compile MCP servers to native modules",
        "name: Build self-locating release config",
        "name: Assert the artifact really carries compiled servers",
        "name: Package artifact",
    ]
    pos = [text.find(k) for k in ORDER]
    ck("G7 CI step order is the designed one", min(pos) >= 0 and pos == sorted(pos),
       "positions=%s" % pos)
    # 3b 与 3c 之间那段必须覆盖 servers/ 全部 + runtime 依赖闭包
    a = text.find("name: Compile MCP servers")
    b = text.find("name: Build self-locating release config")
    seg_yml = text[a:b] if a >= 0 and b > a else ""
    # 逐文件的编译清单从 yml 迁到了 scripts/build_modules.sh（为的是能在 shell 层分批并发——
    # Nuitka 的 --mode=module 一次只吃一个 positional，原先那 N 次调用【之间】是 for 串行
    # 的，实测白等 216s/519s）。清单内容逐字未改，只是换了个文件，所以搜索面也随之跟着
    # 变成"yml 的 3b 段 + 那个脚本"。这不是放宽 G8：下面 G11 会反向锁死"清单只有一份"，
    # 一旦有人把文件列表又抄回 yml（两处各自漂移），G11 立刻红。
    SHF = os.path.join(ROOT, "scripts", "build_modules.sh")
    sh_text = open(SHF, encoding="utf-8").read() if os.path.isfile(SHF) else ""
    ck("G11 the module list lives in exactly ONE place (scripts/build_modules.sh)",
       bool(sh_text) and 'MODULES="' in sh_text and 'MODULES="' not in seg_yml,
       "sh_has_list=%s yml_has_second_list=%s" % (bool(sh_text) and 'MODULES="' in sh_text,
                                                  'MODULES="' in seg_yml))
    seg = seg_yml + "\n" + sh_text
    srv_dir = os.path.join(ROOT, "servers")
    want = ["servers/" + f for f in sorted(os.listdir(srv_dir))
            if f.endswith(".py") and ".bak" not in f]
    want += ["skills/example_server.py",
             "runtime/config_loader.py", "runtime/textenc.py", "runtime/skills_loader.py",
             "runtime/executor.py", "runtime/registry.py", "runtime/audit.py",
             "runtime/scheduler.py", "runtime/corpus.py"]
    # runtime/memory 不在此列：它必须以【包】形态编译（理由见下方 G8b/G8c 的两环事实）。
    miss = [w for w in want if w not in seg]
    # memory 必须按【包】编：servers/memory_server.py 用的是包限定名 from memory.episodic，
    # 而 scripts/make_release_entries.py:108 要求产物里有 memory.<pyext> 并真 import 它。
    # Nuitka 的 module 模式逐文件编 runtime/memory/*.py 只会得到 __init__/episodic/semantic
    # 三个名字：既没有 memory 这个名字（3c 直接 MISSING-MODULE），单模块也不带子模块。
    # 所以这里锁"包形态"这个事实，而不是上一版的"逐文件列出三个 .py"——那一版被 CI 实测
    # （FATAL: one positional）与上面两环共同证伪。
    PKGRE = r"--mode=package[^\n]*\n[^\n]*runtime/memory"
    # 只看 yml 段：包形态这条命令仍留在 workflow 里（它是一次调用，不参与并发），
    # 若把面扩到 .sh，未来某个无关文件里出现同样两行就会假绿。
    pkg_ok = bool(re.search(PKGRE, seg_yml))
    loop = sh_text.split('MODULES="', 1)[1].split('"', 1)[0] if 'MODULES="' in sh_text else ""
    mem_out_of_loop = "runtime/memory" not in loop
    ck("G8 3b compiles every server AND every runtime dep the servers import",
       bool(seg) and not miss, "files=%d missing=%s" % (len(want), sorted(miss) or "none"))
    ck("G8b runtime/memory is compiled as a PACKAGE (the only form yielding memory.<pyext>)",
       pkg_ok, "saw --mode=package for runtime/memory = %s" % pkg_ok)
    ck("G8c memory is NOT in the per-file module list (guards a future 'unify it back')",
       mem_out_of_loop, "runtime/memory in module list = %s" % (not mem_out_of_loop))
    # 变异差分：证明 G8b/G8c 是 load-bearing —— 旧形态（无 package）必须红。
    legacy = re.sub(PKGRE, "--mode=module --output-dir=gateway.dist runtime/memory/__init__.py",
                    seg_yml, count=1)
    ck("G8d MUTATION: dropping the package form turns G8b RED",
       pkg_ok and not bool(re.search(PKGRE, legacy)),
       "legacy pkg_ok=%s (must be False)" % bool(re.search(PKGRE, legacy)))
    regressed = loop + "\n  runtime/memory/episodic.py\n"
    ck("G8e MUTATION: putting memory back into the loop turns G8c RED",
       mem_out_of_loop and "runtime/memory" in regressed)
    # 产物 config 必须是 token 版（这是"能搬到任何机器"的前提）
    ck("G9 the artifact config is the self-locating one (@SELF/@ROOT)",
       "@SELF" in text and "make_release_entries.py" in text
       and "cp entries.dist gateway.dist/config/mcp_servers.json" in text)
    ck("G10 the front-end smoke runs on the OBFUSCATED copy, not serve/web",
       "node scripts/smoke_web.js dist/web" in text)
else:
    ck("G7 CI workflow file exists", False, YML)

print("\nCLOSED-SOURCE-GATE:", "ALL GREEN" if not FAILS else "RED: " + ", ".join(FAILS))
sys.exit(0 if not FAILS else 1)
