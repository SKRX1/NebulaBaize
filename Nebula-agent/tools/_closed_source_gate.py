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
    seg = text[a:b] if a >= 0 and b > a else ""
    srv_dir = os.path.join(ROOT, "servers")
    want = ["servers/" + f for f in sorted(os.listdir(srv_dir))
            if f.endswith(".py") and ".bak" not in f]
    want += ["skills/example_server.py",
             "runtime/config_loader.py", "runtime/textenc.py", "runtime/skills_loader.py",
             "runtime/executor.py", "runtime/registry.py", "runtime/audit.py",
             "runtime/scheduler.py", "runtime/corpus.py",
             "runtime/memory/__init__.py", "runtime/memory/episodic.py",
             "runtime/memory/semantic.py"]
    miss = [w for w in want if w not in seg]
    ck("G8 3b compiles every server AND every runtime dep the servers import",
       bool(seg) and not miss, "files=%d missing=%s" % (len(want), sorted(miss) or "none"))
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
