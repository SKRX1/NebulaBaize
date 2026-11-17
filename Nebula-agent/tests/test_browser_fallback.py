"""Fast, browser-free regression for the browser capture-time policy (2026-10-20).

The reported bug: `browser__screenshot` on a page with a perpetual requestAnimationFrame
loop hung ~60s and returned "error: browser timed out (msedge.exe)". Root cause: capture
used `--virtual-time-budget`, which never terminates on a perpetual-rAF page (virtual time
can't reach the budget because every frame reschedules another frame), and Chromium ignores
`--timeout` while VTB is present.

Fix under test (servers/browser_server.py):
  - local file:// URLs capture straight with `--timeout=<ms>` (fast; VTB is what hangs them)
  - http(s) URLs try VTB first (capped), then fall back to `--timeout` on timeout
  - `--timeout` is also the exit trigger `console` needs (without it --headless=new never
    exits once the page loads)

This drives `BrowserServer.call_tool` with a monkeypatched `_run` (no real browser), so it
is deterministic and instant. The real-hardware proof lives in tests/test_browser.py.

Run: python tests/test_browser_fallback.py
"""
from __future__ import annotations

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVERS = os.path.join(HERE, "servers")
sys.path.insert(0, SERVERS)

import browser_server as bs  # noqa: E402

bs._find_browser = lambda: "fakebrowser.exe"   # skip the real capability probe

checks = 0


def ok(cond, msg):
    global checks
    assert cond, msg
    checks += 1


def has(cmd, prefix):
    return any(a.startswith(prefix) for a in cmd)


class Recorder:
    """Stand-in for BrowserServer._run that records commands and simulates outcomes.

    mode="normal": every run succeeds (writes a fake PNG for --screenshot runs).
    mode="raf":    a --virtual-time-budget run TIMES OUT (perpetual-rAF page); a plain
                   --timeout run succeeds. This is the exact failure signature of the bug.
    """

    def __init__(self):
        self.mode = "normal"
        self.calls = []          # list of (cmd, timeout)

    def __call__(self, args, timeout=60, cancel=None):
        args = list(args)
        self.calls.append((args, timeout))
        shot = next((a.split("=", 1)[1] for a in args if a.startswith("--screenshot=")), None)
        vtb = has(args, "--virtual-time-budget=")
        if self.mode == "raf" and vtb:
            raise subprocess.TimeoutExpired(args, timeout)
        if shot:
            with open(shot, "wb") as f:
                f.write(b"\x89PNG\r\n\x1a\nFAKE")
        return ("<dom/>", "")


def clean_calls(rec):
    rec.calls.clear()
    return rec


def main() -> int:
    tmp = os.path.join(HERE, ".pytest_cache", "browser_fallback_tmp")
    os.makedirs(tmp, exist_ok=True)

    # --- policy selection -------------------------------------------------------------
    ok(bs._wants_vtb("http://example.test/a") is True, "http must prefer VTB")
    ok(bs._wants_vtb("https://example.test/a") is True, "https must prefer VTB")
    ok(bs._wants_vtb("file:///E:/x/index.html?demo=0") is False, "local file must skip VTB")

    srv = bs.BrowserServer()
    rec = Recorder()

    # --- 1) local file:// screenshot: exactly ONE run, --timeout, NO VTB --------------
    srv._run = rec
    clean_calls(rec)
    out1 = os.path.join(tmp, "s1.png")
    res = srv.call_tool("screenshot", {"target": "file:///E:/x/index.html?demo=0", "out": out1})
    ok(len(rec.calls) == 1, f"local file must run once, got {len(rec.calls)}")
    cmd = rec.calls[0][0]
    ok(has(cmd, "--timeout="), "local file screenshot must pass --timeout (exit trigger)")
    ok(not has(cmd, "--virtual-time-budget="), "local file screenshot must NOT pass VTB (it hangs)")
    ok(isinstance(res, list) and any(b.get("type") == "image" for b in res),
       "screenshot must return an image content block")
    ok(os.path.isfile(out1), "screenshot file must exist")

    # --- 2) local file:// render and console also use --timeout, never VTB -----------
    for name in ("render", "console"):
        clean_calls(rec)
        srv.call_tool(name, {"target": "file:///E:/x/p.html"})
        cmd = rec.calls[0][0]
        ok(has(cmd, "--timeout="), f"local file {name} must pass --timeout")
        ok(not has(cmd, "--virtual-time-budget="), f"local file {name} must not pass VTB")

    # --- 3) remote page that hangs under VTB: fall back to --timeout, still succeed ---
    rec.mode = "raf"
    clean_calls(rec)
    out3 = os.path.join(tmp, "s3.png")
    res = srv.call_tool("screenshot", {"target": "http://slow.test/game?demo=0", "out": out3})
    ok(len(rec.calls) == 2, f"remote rAF page must try VTB then plain, got {len(rec.calls)}")
    ok(has(rec.calls[0][0], "--virtual-time-budget="), "first attempt must use VTB")
    ok(has(rec.calls[1][0], "--timeout="), "fallback attempt must use --timeout")
    ok(not has(rec.calls[1][0], "--virtual-time-budget="), "fallback must NOT use VTB")
    ok(isinstance(res, list) and any(b.get("type") == "image" for b in res),
       "fallback screenshot must still return an image (bug regression)")


    # --- 4) cancellation during VTB must NOT retry (respect the Stop button) ----------
    srv2 = bs.BrowserServer()
    srv2._cancel_event.set()          # cancelled() -> True
    calls = []

    def cancelled_run(args, timeout=60, cancel=None):
        calls.append(args)
        raise subprocess.TimeoutExpired(list(args), timeout)

    srv2._run = cancelled_run
    res = srv2.call_tool("screenshot", {"target": "http://x.test/a", "out": os.path.join(tmp, "s4.png")})
    ok(str(res).startswith("error: browser timed out"), "cancel must surface as a timeout error")
    ok(len(calls) == 1, "cancel must not trigger the plain retry")

    print(f"BROWSER-FALLBACK: {checks} checks passed")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except AssertionError as e:
        print(f"BROWSER-FALLBACK FAIL: {e}")
        sys.exit(1)
