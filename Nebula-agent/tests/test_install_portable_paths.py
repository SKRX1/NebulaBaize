# -*- coding: utf-8 -*-
"""Install-portability regression (the user's ask: a fresh clone dropped into ANY
folder, installed, then "all functions usable" -- not just on the dev box's path).

Three independent locks, each with a load-bearing differential (a control that goes RED
if the fix is removed):

  T1  rewrite_mcp_install_paths() on a SYNTHETIC config -- the pure function extracted from
      setup_env.py step 3. Asserts a stale install root gets fully re-rooted onto the new
      one (command/args/cwd + install-derived env), while FS_ALLOW (user's personal
      allowlist) and STRATA_PROXY (a URL) are LEFT ALONE.
        load-bearing: if the FS_ALLOW/STRATA_PROXY guard were dropped, those two would be
        re-rooted too -> this test goes RED. If the repoint loop were dropped, args would
        still point at the old root -> RED.

  T2  the REAL committed config (git HEAD blob -- exactly what a fresh clone/ZIP ships).
      Feeding it a fake "new install" root must leave ZERO stale-root references in the
      install-derived fields, while FS_ALLOW/STRATA_PROXY survive verbatim.

  T3  static locks on the launch entry + secondary snapshot/report paths:
        - 星云白泽.bat  : WATCHDOG must derive from %~dp0 (NOT a drive-absolute path),
                          else the double-click entry dies on any other path.
                          load-bearing: an absolute WATCHDOG would make this RED.
        - http_server.py : PREVIEWS_ASCII must NOT hardcode C:\\Users\\sk.
        - _restart_8099*.ps1 : report path must use $env:USERPROFILE, not C:\\Users\\sk.

Run standalone: python tests/test_install_portable_paths.py   (also registered in tools/run_tests.py)
"""
import sys, os, re, json, subprocess, importlib.util

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # .../Nebula-agent
REPO = os.path.dirname(ROOT)                                          # .../<repo root>
FAILS = []

def check(desc, cond):
    print(("  PASS " if cond else "  FAIL ") + desc)
    if not cond:
        FAILS.append(desc)

def load_setup_env():
    spec = importlib.util.spec_from_file_location(
        "setup_env_under_test", os.path.join(ROOT, "setup_env.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

# ----------------------------- T1: synthetic config -----------------------------
print("T1: rewrite_mcp_install_paths() on a synthetic stale config")
m = load_setup_env()
OLD = r"E:\OldBox"
NEW = r"D:\Users\someone\NebulaBaize"
venv = os.path.join(NEW, "Nebula-agent", ".venv", "Scripts", "python.exe")
cfg = {"mcpServers": {
    "filesystem": {
        "command": OLD + r"\Nebula-agent\.venv\Scripts\python.exe",
        "args": [OLD + r"\Nebula-agent\servers\fs_server.py"],
        "cwd": OLD + r"\Nebula-agent",
        "env": {
            "FS_ROOT": OLD + r"\Nebula-agent",
            "FS_ALLOW": r"E:\personal;E:\work",   # personal allowlist: must stay
            "FS_ALLOW_FILE": OLD + r"\fs_allowed_roots.txt",
        },
    },
    "websearch": {
        "command": OLD + r"\Nebula-agent\.venv\Scripts\python.exe",
        "args": [OLD + r"\Nebula-agent\servers\websearch_server.py"],
        "cwd": OLD + r"\Nebula-agent",
        "env": {"STRATA_PROXY": "http://127.0.0.1:7897"},   # URL: must stay
    },
}}
changed = m.rewrite_mcp_install_paths(cfg, NEW, venv_py=venv)

fs = cfg["mcpServers"]["filesystem"]
ws = cfg["mcpServers"]["websearch"]

check("T1 changed flag is True", changed is True)
check("T1 filesystem.command -> new venv python", fs["command"] == venv)
check("T1 filesystem.args re-rooted to new install",
      fs["args"] == [NEW + r"\Nebula-agent\servers\fs_server.py"])
check("T1 filesystem.cwd re-rooted", fs["cwd"] == NEW + r"\Nebula-agent")
check("T1 env.FS_ROOT re-rooted", fs["env"]["FS_ROOT"] == NEW + r"\Nebula-agent")
check("T1 env.FS_ALLOW_FILE re-rooted (repo file)",
      fs["env"]["FS_ALLOW_FILE"] == NEW + r"\fs_allowed_roots.txt")
check("T1 env.FS_ALLOW LEFT UNTOUCHED (personal allowlist not install-derived)",
      fs["env"]["FS_ALLOW"] == r"E:\personal;E:\work")
check("T1 websearch STRATA_PROXY URL LEFT UNTOUCHED",
      ws["env"]["STRATA_PROXY"] == "http://127.0.0.1:7897")
check("T1 websearch.args re-rooted",
      ws["args"] == [NEW + r"\Nebula-agent\servers\websearch_server.py"])
# differential: a *relative* / non-OLD-root path must be left alone
rel = {"mcpServers": {"x": {"command": "python", "args": ["-m", "serve.fs_server"], "cwd": "rel/dir"}}}
check("T1 control: a relative-path server is left unchanged (no false rewrite)",
      m.rewrite_mcp_install_paths(rel, NEW) is False)

# ----------------------------- T2: real committed config -----------------------------
print("\nT2: the REAL committed mcp_servers.json (git HEAD blob) re-rooted onto a fake install")
NEW2 = r"F:\fresh\clone\NebulaBaize"
try:
    blob = subprocess.run(["git", "show", "HEAD:Nebula-agent/config/mcp_servers.json"],
                          cwd=REPO, capture_output=True)
    real = json.loads(blob.stdout.decode("utf-8"))
except Exception as e:
    real = None
    print("   (git HEAD read failed:", e, ")")

if real is not None:
    real_changed = m.rewrite_mcp_install_paths(real, NEW2,
        venv_py=NEW2 + r"\Nebula-agent\.venv\Scripts\python.exe")
    # collect every still-absolute path value across all servers
    stale = []
    for s in real["mcpServers"].values():
        vals = [s.get("command"), s.get("cwd")] + list(s.get("args", []) or [])
        for ek, ev in (s.get("env") or {}).items():
            if ek in ("FS_ALLOW", "STRATA_PROXY"):
                continue
            vals.append(ev)
        for v in vals:
            if isinstance(v, str) and re.match(r"^[A-Za-z]:\\", v) and "Nebula-agent" in v \
               and not v.lower().startswith(NEW2.lower()):
                stale.append(v)
    check("T2 no stale absolute Nebula-agent paths after re-root onto fake install",
          len(stale) == 0)
    # FS_ALLOW must still reference the dev-box personal dirs (untouched)
    fs_allow = real["mcpServers"]["filesystem"]["env"]["FS_ALLOW"]
    check("T2 FS_ALLOW kept verbatim (was: " + fs_allow + ")", fs_allow == r"E:\星云;E:\Nebula")
    # STRATA_PROXY kept verbatim
    proxy = real["mcpServers"]["websearch"]["env"]["STRATA_PROXY"]
    check("T2 STRATA_PROXY kept verbatim (URL not re-rooted)", proxy == "http://127.0.0.1:7897")
    # the filesystem server args must now be under NEW2
    check("T2 filesystem.args now under the fake install root",
          real["mcpServers"]["filesystem"]["args"][0].lower().startswith(NEW2.lower()))
else:
    check("T2 skipped (could not read git HEAD config)", False)

# ----------------------------- T3: static locks -----------------------------
print("\nT3: launch entry + snapshot/report paths carry no dev-box hardcode")

def rd(p):
    raw = open(p, "rb").read()
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("gbk", "replace")

# 3a: 星云白泽.bat WATCHDOG must be %~dp0-derived
launcher = rd(os.path.join(REPO, "\u661f\u4e91\u767d\u6cfd.bat"))
m_watch = re.search(r'(?im)^\s*set\s+WATCHDOG=(.*)$', launcher)
watch_val = m_watch.group(1).strip() if m_watch else ""
check("T3 星云白泽.bat defines a WATCHDOG line", bool(m_watch))
check("T3 星云白泽.bat WATCHDOG derives from %~dp0 (install-portable)",
      "%~dp0" in watch_val)
check("T3 星云白泽.bat WATCHDOG has NO drive-absolute path (load-bearing: an E:\\... would RED this)",
      not re.search(r"[A-Za-z]:\\", watch_val))

# 3b: http_server PREVIEWS_ASCII must not hardcode the dev-box user dir
http = rd(os.path.join(ROOT, "runtime", "http_server.py"))
m_prev = re.search(r'(?m)^PREVIEWS_ASCII\s*=\s*(.*)$', http)
prev_val = m_prev.group(1) if m_prev else ""
check("T3 http_server PREVIEWS_ASCII uses expanduser/USERPROFILE not C:\\Users\\sk",
      ("expanduser" in prev_val or "USERPROFILE" in prev_val) and ("Users\\sk" not in prev_val))

# 3c: restart reports use $env:USERPROFILE not the dev-box user dir
for ps1 in ("_restart_8099.ps1", "_restart_8099_full.ps1"):
    txt = rd(os.path.join(ROOT, "tools", ps1))
    m_rep = re.search(r'(?m)^\s*\$report\s*=.*$', txt)
    rep_val = m_rep.group(0) if m_rep else ""
    check("T3 %s report path uses $env:USERPROFILE" % ps1, "$env:USERPROFILE" in rep_val)
    check("T3 %s has no hardcoded C:\\Users\\sk" % ps1, "Users\\sk" not in rep_val)

print("\n---- install-portability summary ----")
if FAILS:
    for f in FAILS:
        print("FAIL:", f)
    print("TOTAL FAILS: %d" % len(FAILS))
    sys.exit(1)
print("ALL PASSED")
sys.exit(0)
