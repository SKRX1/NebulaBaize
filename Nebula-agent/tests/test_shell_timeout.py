# -*- coding: utf-8 -*-
"""Regression test for the shell tool's timeout + background handling.

Guards against the bug class that produced the `start /b ... & ping -n 20 & type log`
loop: a background child used to inherit the capture pipe and stall the call until the
30s ceiling, and a timed-out command leaked its process tree. Run via
`python tools/run_tests.py` (it is registered there).
"""
import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = sys.executable or "python"
SRV = os.path.join(ROOT, "servers", "shell_server.py")
ENV = dict(os.environ)
ENV["FS_ALLOW_FILE"] = os.path.join(ROOT, "_no_such_allow_file.txt")
ENV["PYTHONUTF8"] = "1"
ENV["PYTHONIOENCODING"] = "utf-8"


def main() -> int:
    p = subprocess.Popen([PY, SRV], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True, encoding="utf-8",
                         cwd=ROOT, env=ENV)
    rid = 0

    def rpc(method, params):
        nonlocal rid
        rid += 1
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": rid,
                                  "method": method, "params": params}) + "\n")
        p.stdin.flush()
        line = p.stdout.readline()
        if not line:
            raise RuntimeError("server closed stdout: " + (p.stderr.read() or "")[:300])
        return json.loads(line)

    def call(args):
        t0 = time.monotonic()
        r = rpc("tools/call", {"name": "exec", "arguments": args})
        dt = time.monotonic() - t0
        blocks = (r.get("result") or {}).get("content") or []
        text = "\n".join(b.get("text", "") for b in blocks if b.get("type") == "text")
        return dt, text

    try:
        rpc("initialize", {})
        tl = rpc("tools/list", {})
        schema = tl["result"]["tools"][0]["inputSchema"]
        assert "timeout" in schema["properties"], "timeout param missing from schema"

        # 1) per-call timeout actually bounds the command
        dt, txt = call({"command": "ping -n 10 127.0.0.1 >nul", "timeout": 2})
        assert "timed out after 2s" in txt, txt
        assert dt < 6, "timeout=2 did not fire promptly (%.2fs)" % dt

        # 2) a background child no longer stalls the call (the old hang bug)
        #    `ping -n 1` is near-instant so the detached child is gone long before the
        #    orphan check in #4 runs; the foreground `echo done` returns immediately.
        dt, txt = call({"command": 'start /b cmd /c "ping -n 1 127.0.0.1 >nul" & echo done'})
        assert "done" in txt, txt
        assert dt < 6, "background child still blocked the call: %.2fs" % dt
        assert "background child" in txt

        # 3) exit code surfaces so the agent can tell success from failure
        dt, txt = call({"command": "exit /b 7"})
        assert "[exit 7]" in txt, txt
        assert "[elapsed" in txt, txt

        # 4) a timed-out (foreground) command does not leave its process tree running.
        #    NOTE: a `start /b` child intentionally detaches and returns at once, so the
        #    orphan-kill path only fires for a direct command that actually exceeds the
        #    timeout -- use one here (no start /b).
        dt, txt = call({"command": "ping -n 60 127.0.0.1 >nul", "timeout": 2})
        assert "timed out after 2s" in txt, txt
        time.sleep(1.5)  # give taskkill /T a moment
        # shell=False + explicit encoding so a non-UTF8 OEM tasklist line never raises,
        # and stdout is always a str (even on a no-match "INFO: no tasks..." line).
        tl = subprocess.run(["tasklist", "/fi", "imagename eq PING.EXE", "/nh"],
                            capture_output=True, text=True, encoding="utf-8",
                            errors="replace", shell=False)
        tl_out = (tl.stdout or "") + (tl.stderr or "")
        assert "PING.EXE" not in tl_out, "orphan ping.exe left running after timeout:\n" + tl_out

        print("test_shell_timeout: PASS (timeout param, background, exit code, no orphan)")
        return 0
    except AssertionError as e:
        print("test_shell_timeout: FAIL ->", e)
        return 1
    finally:
        try:
            p.stdin.close()
            p.wait(timeout=5)
        except Exception:
            p.kill()


if __name__ == "__main__":
    sys.exit(main())
