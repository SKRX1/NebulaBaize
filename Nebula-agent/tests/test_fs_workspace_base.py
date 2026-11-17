r"""Regression: fs_server relative-path resolution must honour the selected workspace.

Bug (2026-10-17, user report): the Strata web UI records the workspace as a bare leaf
name when the user picks a folder via the browser's File System Access API (it cannot
reveal absolute paths). `fs_server._safe()` resolved every RELATIVE path against its own
root (strata-agent/), so agent-generated files landed there instead of the user's
workspace folder (E:\WorkBuddy\游戏开发\打砖块3).

Fix: when FS_ALLOW_FILE records exactly one *absolute* workspace, relative paths resolve
there; otherwise fall back to ROOT (backward compatible). Absolute paths are unaffected.

Run:  python tests/test_fs_workspace_base.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.abspath(os.path.join(HERE, "..", "servers"))

# Runs in a fresh interpreter so fs_server's import-time env reads see our FS_* vars.
CHILD = r'''
import os, sys, json
sys.path.insert(0, os.environ["FS_SERVER_DIR"])
from fs_server import FsServer
p = json.loads(os.environ["FS_TEST_PATH"])
c = json.loads(os.environ["FS_TEST_CONTENT"])
FsServer().call_tool("write", {"path": p, "content": c})
print("WROTE")
'''


def run_case(root, allow_lines, relpath, content="中文OK"):
    allow = os.path.join(root, "allow.txt")
    with open(allow, "w", encoding="utf-8") as f:
        f.write("\n".join(allow_lines) + ("\n" if allow_lines else ""))
    env = dict(os.environ)
    env["FS_ROOT"] = root
    env["FS_ALLOW"] = ""
    env["FS_ALLOW_FILE"] = allow
    env["FS_SERVER_DIR"] = SERVER_DIR
    env["FS_TEST_PATH"] = json.dumps(relpath, ensure_ascii=False)
    env["FS_TEST_CONTENT"] = json.dumps(content, ensure_ascii=False)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run([sys.executable, "-c", CHILD], capture_output=True, text=True,
                          encoding="utf-8", errors="replace", env=env, cwd=root)


def main():
    fails = 0

    def check(name, cond, detail=""):
        nonlocal fails
        print(("PASS " if cond else "FAIL ") + name + (("  " + detail) if (detail and not cond) else ""))
        if not cond:
            fails += 1

    base = tempfile.mkdtemp(prefix="fs_ws_")
    try:
        root = os.path.join(base, "root")
        ws = os.path.join(base, "workspace")
        os.makedirs(root)
        os.makedirs(ws)

        # 1) exactly one absolute workspace -> relative write lands in the workspace
        r = run_case(root, [ws], "sub/a.txt", "中文OK")
        check("case1 child ran", r.returncode == 0, (r.stderr or r.stdout).strip()[-200:])
        in_ws = os.path.isfile(os.path.join(ws, "sub", "a.txt"))
        in_root = os.path.isfile(os.path.join(root, "sub", "a.txt"))
        check("case1 relative write lands in workspace", in_ws, f"ws={in_ws} root={in_root}")
        check("case1 nothing written to server root", not in_root)
        if in_ws:
            with open(os.path.join(ws, "sub", "a.txt"), encoding="utf-8") as f:
                check("case1 content intact (utf-8)", f.read() == "中文OK")

        # 2) no workspace recorded -> fall back to ROOT (backward compatible)
        r = run_case(root, [], "sub/b.txt", "x")
        check("case2 child ran", r.returncode == 0, (r.stderr or r.stdout).strip()[-200:])
        check("case2 relative write falls back to root", os.path.isfile(os.path.join(root, "sub", "b.txt")))

        # 3) bare leaf name (the browser-picker bug) must NOT become the base
        r = run_case(root, ["打砖块3"], "sub/c.txt", "x")
        check("case3 child ran", r.returncode == 0, (r.stderr or r.stdout).strip()[-200:])
        check("case3 leaf name ignored, write lands in root", os.path.isfile(os.path.join(root, "sub", "c.txt")))

        # 4) absolute path write is unaffected by the relative base
        target = os.path.join(ws, "abs.txt")
        r = run_case(root, [ws], target, "abs")
        check("case4 child ran", r.returncode == 0, (r.stderr or r.stdout).strip()[-200:])
        check("case4 absolute write lands at absolute path", os.path.isfile(target))

        print()
        if fails:
            print(f"FS WORKSPACE BASE: {fails} FAILED")
            return 1
        print("FS WORKSPACE BASE: ALL PASSED")
        return 0
    finally:
        shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
