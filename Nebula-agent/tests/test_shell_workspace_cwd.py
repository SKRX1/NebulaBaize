r"""Regression: shell MCP server must run commands inside the selected workspace.

Bug (2026-10-17, user report): `exec shell` wrote agent-generated files into
strata-agent/ instead of the user's workspace, because ShellServer ran commands with the
server's own cwd and the agent used relative paths.

Fix: run the command with cwd = the CURRENT workspace (the newest absolute entry in
FS_ALLOW_FILE). Otherwise inherit the server's cwd (backward compatible).

2026-10-20: the rule used to be "exactly ONE absolute entry", which silently stopped
holding once the user had picked a second workspace (the record is an append-only union),
so every command ran in the agent's install dir. Also fixed the parsing below: it read the
LAST line of the result, which is always the `[elapsed X.Xs]` trailer -- so case 1 could
never pass and cases 2/3 passed vacuously. This suite was never registered in run_tests.py,
which is why nobody noticed.

Run:  python tests/test_shell_workspace_cwd.py
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..", "servers")))

import shell_server  # noqa: E402


def main():
    fails = 0

    def check(name, cond, detail=""):
        nonlocal fails
        print(("PASS " if cond else "FAIL ") + name + (("  " + detail) if (detail and not cond) else ""))
        if not cond:
            fails += 1

    base = tempfile.mkdtemp(prefix="sh_ws_")
    old = os.environ.get("FS_ALLOW_FILE")
    try:
        ws = os.path.join(base, "workspace")
        other = os.path.join(base, "other")
        os.makedirs(ws)
        os.makedirs(other)
        allow = os.path.join(base, "allow.txt")

        def cwd_of():
            # A marker, not the last line: every result ends with `[elapsed X.Xs]`.
            out = shell_server.ShellServer().call_tool("exec", {"command": "echo CWD_IS=%CD%"})
            for line in out.splitlines():
                if "CWD_IS=" in line:
                    return line.split("CWD_IS=", 1)[1].strip()
            return ""

        server_cwd = os.getcwd()

        # 1) one absolute workspace -> the command runs there
        with open(allow, "w", encoding="utf-8") as f:
            f.write(ws + "\n")
        os.environ["FS_ALLOW_FILE"] = allow
        got = cwd_of()
        check("case1 cwd is the workspace", os.path.normcase(got) == os.path.normcase(ws), f"got={got!r} want={ws!r}")

        # 2) newest wins among several recorded workspaces (the 2026-10-20 bug)
        with open(allow, "w", encoding="utf-8") as f:
            f.write(other + "\n" + ws + "\n")
        os.environ["FS_ALLOW_FILE"] = allow
        got = cwd_of()
        check("case2 newest recorded workspace wins", os.path.normcase(got) == os.path.normcase(ws), f"got={got!r} want={ws!r}")

        # 3) a bare leaf name must be ignored -> the server's own cwd
        with open(allow, "w", encoding="utf-8") as f:
            f.write("打砖块3\n")
        os.environ["FS_ALLOW_FILE"] = allow
        got = cwd_of()
        check("case3 leaf name ignored (cwd unchanged)",
              os.path.normcase(got) == os.path.normcase(server_cwd), f"got={got!r} want={server_cwd!r}")

        # 4) missing allow-file -> inherit cwd (backward compatible)
        os.environ["FS_ALLOW_FILE"] = os.path.join(base, "does_not_exist.txt")
        got = cwd_of()
        check("case4 missing allow-file inherits cwd",
              os.path.normcase(got) == os.path.normcase(server_cwd), f"got={got!r} want={server_cwd!r}")

        print()
        if fails:
            print(f"SHELL WORKSPACE CWD: {fails} FAILED")
            return 1
        print("SHELL WORKSPACE CWD: ALL PASSED")
        return 0
    finally:
        if old is None:
            os.environ.pop("FS_ALLOW_FILE", None)
        else:
            os.environ["FS_ALLOW_FILE"] = old
        shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
