r"""Regression: the workspace the user picked must be the base for relative paths.

Bug (2026-10-20, user report -- two tool errors during a streaming turn):

    filesystem_list {"path": "c01.txt"}           -> [WinError 267] 目录名称无效
                                                     '...\strata-agent\c01.txt'
    filesystem_list {"path": "游戏开发/打砖块2"}  -> [WinError 3] 系统找不到指定的路径
                                                     '...\strata-agent\游戏开发\打砖块2'
    shell_exec                                    -> CWD=...\strata-agent

Root cause: FS_ALLOW_FILE is an append-only UNION of every workspace the user ever opened,
never pruned -- and both `fs_server._relative_base()` and `shell_server._workspace_cwd()`
only honoured it when it held EXACTLY ONE absolute root. From the second workspace onward
that condition is permanently false, so both silently fell back to the agent's own install
dir while the model was being told to work inside the project folder.

Fix:
  * newest wins -- the host MOVES the active workspace to the end of the record (appending
    only when absent left the previous workspace as the base after switching back);
  * a bare leaf name (which the browser folder picker can leak) never becomes the base;
  * path errors now name the resolved path AND the base, so one retry is enough;
  * a relative path that re-states the workspace prefix ("游戏开发/打砖块2/x.js") is
    re-anchored into the workspace;
  * the gateway puts the ABSOLUTE workspace in the system prompt (and rewrites the
    composer's relative "Working directory:" line), so the model stops guessing.

Run:  python tests/test_workspace_base.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(HERE)
SERVER_DIR = os.path.join(PROJ, "servers")
RUNTIME_DIR = os.path.join(PROJ, "runtime")

# fs_server binds its allow-file path at import time, so each case needs a fresh interpreter.
CHILD = r'''
import json, os, sys
sys.path.insert(0, os.environ["SRV"])
import fs_server
out = {"base": fs_server._relative_base()}
s = fs_server.FsServer()
for tag, name, args in json.loads(os.environ["CALLS"]):
    try:
        out[tag] = {"ok": True, "text": s.call_tool(name, args)}
    except Exception as e:
        out[tag] = {"ok": False, "err": str(e)}
print("RESULT " + json.dumps(out, ensure_ascii=False))
'''


def fs_case(root, allow_lines, calls, env_extra=None):
    """Run fs_server against `root` with `allow_lines` as the workspace record."""
    allow = os.path.join(root, "_allow.txt")
    with open(allow, "w", encoding="utf-8") as f:
        f.write("\n".join(allow_lines) + ("\n" if allow_lines else ""))
    env = dict(os.environ)
    env.update({"SRV": SERVER_DIR, "FS_ROOT": root, "FS_ALLOW": "", "FS_ALLOW_FILE": allow,
                "CALLS": json.dumps(calls, ensure_ascii=False),
                "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
    env.update(env_extra or {})
    r = subprocess.run([sys.executable, "-c", CHILD], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", env=env, cwd=root)
    for line in (r.stdout or "").splitlines():
        if line.startswith("RESULT "):
            return json.loads(line[7:])
    raise AssertionError("child produced no result: " + (r.stdout or "") + (r.stderr or ""))


def main() -> int:
    fails = 0

    def check(name, cond, detail=""):
        nonlocal fails
        print(("PASS " if cond else "FAIL ") + name +
              (("  -> " + str(detail)) if (detail and not cond) else ""))
        if not cond:
            fails += 1

    base = tempfile.mkdtemp(prefix="ws_base_")
    try:
        agent = os.path.join(base, "agent")            # FS_ROOT: the agent's own install dir
        proj = os.path.join(base, "proj")
        ws = os.path.join(proj, "alpha")               # the workspace the user picked
        other = os.path.join(base, "other")
        for d in (agent, ws, other, os.path.join(ws, "parts"), os.path.join(ws, "alpha")):
            os.makedirs(d, exist_ok=True)
        for d in (agent, ws, os.path.join(ws, "parts"), os.path.join(ws, "alpha")):
            pass
        open(os.path.join(agent, "c01.txt"), "w", encoding="utf-8").write("root file")
        open(os.path.join(ws, "c01.txt"), "w", encoding="utf-8").write("ws file")
        open(os.path.join(ws, "index.html"), "w", encoding="utf-8").write("<h1>首页</h1>")
        open(os.path.join(ws, "alpha", "inner.txt"), "w", encoding="utf-8").write("inner")

        # ── 1. THE bug: several recorded workspaces must not collapse the base ──
        r = fs_case(agent, [other, ws], [])
        check("1 multi-entry record: newest workspace is the base",
              os.path.normcase(r["base"]) == os.path.normcase(ws), r["base"])
        check("1 the base is NOT the agent install dir",
              os.path.normcase(r["base"]) != os.path.normcase(agent), r["base"])

        # ── 2. a bare leaf name never becomes the base ──
        r = fs_case(agent, [other, "alpha", ws], [])
        check("2 bare leaf name in the record is skipped",
              os.path.normcase(r["base"]) == os.path.normcase(ws), r["base"])

        # ── 3. an empty record still falls back to ROOT (backward compatible) ──
        r = fs_case(agent, [], [])
        check("3 empty record falls back to ROOT",
              os.path.normcase(r["base"]) == os.path.normcase(agent), r["base"])

        # ── 4. `list` on a FILE says so instead of raising WinError 267 ──
        r = fs_case(agent, [other, ws], [["f", "list", {"path": "c01.txt"}]])
        f = r["f"]
        check("4 list-on-a-file fails with an actionable message", not f["ok"], f)
        check("4 it names the file/dir confusion", "is a file" in f.get("err", ""), f.get("err"))
        check("4 it is not a raw WinError 267", "267" not in f.get("err", ""), f.get("err"))

        # ── 5. a missing path names the resolved path AND the base ──
        r = fs_case(agent, [other, ws], [["f", "list", {"path": "nope.txt"}]])
        f = r["f"]
        check("5 missing path is an error", not f["ok"], f)
        check("5 it says 'does not exist'", "does not exist" in f.get("err", ""), f.get("err"))
        check("5 it names the base it resolved against", ws in f.get("err", ""), f.get("err"))

        # ── 6. a path that re-states the workspace prefix is re-anchored ──
        r = fs_case(agent, [other, ws], [["f", "list", {"path": "proj/alpha"}],
                                         ["r", "read", {"path": "proj/alpha/index.html"}]])
        check("6 'proj/alpha' resolves to the workspace itself", r["f"]["ok"], r["f"])
        check("6 it lists the workspace contents",
              r["f"]["ok"] and "index.html" in r["f"]["text"], r["f"])
        check("6 'proj/alpha/index.html' reads the real file",
              r["r"]["ok"] and "首页" in r["r"].get("text", ""), r["r"])

        # ── 7. a genuine same-named SUBfolder is not rewritten ──
        r = fs_case(agent, [other, ws], [["f", "list", {"path": "alpha"}],
                                         ["r", "read", {"path": "alpha/inner.txt"}]])
        check("7 a real sub-folder of the same name still works", r["f"]["ok"], r["f"])
        check("7 its contents are the sub-folder's, not the workspace's",
              r["f"]["ok"] and "inner.txt" in r["f"]["text"] and "index.html" not in r["f"]["text"],
              r["f"])
        check("7 reading inside it still works",
              r["r"]["ok"] and r["r"].get("text", "").strip() == "inner", r["r"])

        # ── 8. shell: the command runs in the same (newest) workspace ──
        code = (
            "import os,sys;os.environ['FS_ALLOW_FILE']=sys.argv[1];"
            "sys.path.insert(0,sys.argv[2]);import shell_server as s;"
            "print('CWD '+str(s._workspace_cwd()))"
        )
        allow = os.path.join(base, "_allow_shell.txt")
        with open(allow, "w", encoding="utf-8") as fh:
            fh.write("\n".join([other, ws]) + "\n")
        r = subprocess.run([sys.executable, "-c", code, allow, SERVER_DIR],
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", env={**os.environ, "PYTHONUTF8": "1"})
        cwd = (r.stdout or "").strip().replace("CWD ", "")
        check("8 shell runs in the newest workspace", os.path.normcase(cwd) == os.path.normcase(ws),
              cwd or (r.stderr or "").strip()[-200:])

        # ── 9/10. the host records the ACTIVE workspace, not a growing union ──
        sys.path.insert(0, RUNTIME_DIR)
        import http_server as hs                                            # noqa: E402

        rec = os.path.join(base, "_allow_host.txt")
        old_env = os.environ.get("FS_ALLOW_FILE")
        os.environ["FS_ALLOW_FILE"] = rec
        try:
            with open(rec, "w", encoding="utf-8") as fh:
                fh.write(other + "\n" + ws + "\n")
            got = hs._record_workspace(ws, agent)
            check("9 recording returns the absolute workspace",
                  os.path.normcase(got) == os.path.normcase(ws), got)
            lines = [l.strip() for l in open(rec, encoding="utf-8") if l.strip()]
            check("9 no duplicate line was added", lines.count(ws) == 1, lines)
            check("9 the active workspace is LAST", lines[-1] == ws, lines)

            # switching BACK to an older workspace must move it to the end
            hs._record_workspace(other, agent)
            lines = [l.strip() for l in open(rec, encoding="utf-8") if l.strip()]
            check("10 switching back moves that workspace to the end", lines[-1] == other, lines)
            check("10 the previously active one is kept (allow list survives)", ws in lines, lines)

            # a relative / leaf reference resolves to the recorded absolute folder
            check("10 'proj/alpha' resolves via the record",
                  os.path.normcase(hs._resolve_workspace("proj/alpha", agent)) == os.path.normcase(ws),
                  hs._resolve_workspace("proj/alpha", agent))
            check("10 a bare leaf resolves via the record",
                  os.path.normcase(hs._resolve_workspace("alpha", agent)) == os.path.normcase(ws),
                  hs._resolve_workspace("alpha", agent))
        finally:
            if old_env is None:
                os.environ.pop("FS_ALLOW_FILE", None)
            else:
                os.environ["FS_ALLOW_FILE"] = old_env

        # ── 11. the system prompt carries the ABSOLUTE workspace ──
        msgs = [{"role": "system", "content": "BASE"},
                {"role": "system", "content": "Working directory: proj\\alpha\nread files"},
                {"role": "user", "content": "hi"}]
        out = hs._with_workspace_hint(msgs, ws)
        joined = "\n".join(m.get("content", "") for m in out if isinstance(m.get("content"), str))
        check("11 the relative Working directory line is replaced", ws in out[1]["content"], out[1])
        check("11 the line now reads the absolute path",
              out[1]["content"].splitlines()[0] == "Working directory: " + ws,
              out[1]["content"].splitlines()[0])
        check("11 exactly one Working directory line (no contradiction left)",
              out[1]["content"].count("Working directory:") == 1,
              out[1]["content"].count("Working directory:"))
        check("11 the base note is present", "路径基准" in joined, joined[-200:])
        check("11 message count is unchanged", len(out) == len(msgs), len(out))
        check("11 Windows backslashes do not blow up the rewrite (no bad escape)",
              isinstance(out[1]["content"], str))

        out2 = hs._with_workspace_hint([{"role": "user", "content": "hi"}], ws)
        check("11 a prompt with no Working directory line gains one",
              len(out2) == 2 and "路径基准" in out2[0]["content"], out2)

        vision = [{"role": "system", "content": [{"type": "text", "text": "Working directory: z"}]}]
        out3 = hs._with_workspace_hint(vision, ws)
        check("11 list-form message content is left untouched",
              out3[0]["content"] == vision[0]["content"], out3[0]["content"])

        print()
        if fails:
            print(f"WORKSPACE BASE: {fails} FAILED")
            return 1
        print("WORKSPACE BASE: ALL PASSED")
        return 0
    finally:
        shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
