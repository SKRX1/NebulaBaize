"""Regression tests: Chinese text must survive every process boundary on Windows.

The bug this guards against (reported as "前端调用工具还是写入读取失败，前端乱�?):

  MCP over stdio is UTF-8 on the wire -- Strata's serve/mcp.py sends
  `json.dumps(msg, ensure_ascii=False).encode("utf-8")` and reads
  `raw.decode("utf-8", "replace")`. But sys.stdin/sys.stdout default to the *locale*
  codec, which is GBK on a Chinese Windows, and a double-clicked .bat sets no
  PYTHONUTF8/PYTHONIOENCODING. So:
    * outbound: `sys.stdout.write("中文")` emitted GBK while the client decoded UTF-8
      -> the model saw U+FFFD ("乱码" in the chat).
    * inbound:  the client's UTF-8 argument was decoded as GBK -> lone surrogates ->
      `UnicodeEncodeError: ... surrogates not allowed` -> the write tool died and left
      a 0-byte file ("写入读取失败").

These tests deliberately run the servers under a **clean, non-UTF-8 locale** (the bat's
environment), so they fail on the old code and pass on the fixed code. Run:

    python tests/test_encoding.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SERVERS = os.path.join(ROOT, "servers")
PY = sys.executable

# Hermetic: point FS_ALLOW_FILE at a path that does not exist, so the user's live
# workspace selection (E:\WorkBuddy\fs_allowed_roots.txt) can never redirect the
# relative `data/...` paths this test writes. Without it the test would pollute the
# user's currently-selected workspace folder.
ISO_ALLOW = os.path.join(tempfile.gettempdir(), f"_enc_iso_allow_{os.getpid()}.txt")

PASS, FAIL = [], []


def check(label: str, ok: bool, detail: str = ""):
    (PASS if ok else FAIL).append(label)
    print(f"  [{'ok' if ok else 'FAIL'}] {label}" + (f"  -- {detail}" if detail and not ok else ""))


def bat_env() -> dict:
    """The environment a double-clicked .bat produces: no UTF-8 pins, no LANG."""
    env = {k: v for k, v in os.environ.items()
           if k.upper() not in ("PYTHONUTF8", "PYTHONIOENCODING",
                                "PYTHONLEGACYWINDOWSSTDIO", "LANG", "LC_ALL")}
    env["FS_ALLOW_FILE"] = ISO_ALLOW          # isolate from the live workspace
    return env


CLEAN = bat_env()


# --------------------------------------------------------------------------- 1
print("\n[1] the locale really is hostile here (otherwise these tests prove nothing)")
probe = subprocess.run([PY, "-c", "import sys;print(sys.stdout.encoding)"],
                       capture_output=True, text=True, env=CLEAN)
enc = probe.stdout.strip()
print(f"  child stdio encoding under the bat env: {enc!r}")
check("servers are exercised under a non-UTF-8 locale", enc.lower() != "utf-8", enc)

# Self-validating: reproduce the UNPATCHED mechanism (a plain child using the locale
# text layer) and require that it corrupts. If this ever goes green, the section above
# stopped proving anything and the whole file is worthless.
UNPATCHED = r"""
import sys
sys.stdout.write("中文")          # exactly what _mcp_base._send used to do
sys.stdout.flush()
"""
raw = subprocess.run([PY, "-c", UNPATCHED], capture_output=True, env=CLEAN).stdout
as_client_sees_it = raw.decode("utf-8", "replace")
check("unpatched locale stdio really does corrupt (so the fix is what saves us)",
      "\ufffd" in as_client_sees_it,
      f"raw={raw!r} -> {as_client_sees_it!r}")


# --------------------------------------------------------------------------- 2
print("\n[2] smart_decode: UTF-8 first, GBK fallback, never raises")
sys.path.insert(0, SERVERS)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
from _mcp_base import smart_decode as srv_decode          # noqa: E402
from textenc import smart_decode as rt_decode             # noqa: E402

for name, fn in (("servers/_mcp_base", srv_decode), ("runtime/textenc", rt_decode)):
    check(f"{name}: utf-8 bytes -> 中文", fn("中文".encode("utf-8")) == "中文")
    check(f"{name}: gbk bytes -> 中文", fn("中文".encode("gbk")) == "中文")
    check(f"{name}: ascii unchanged", fn(b"hello") == "hello")
    check(f"{name}: empty -> ''", fn(b"") == "")
    check(f"{name}: str passthrough", fn("已解�?) == "已解�?)
    check(f"{name}: broken bytes never raise", isinstance(fn(b"\xff\xfe\x80"), str))


# --------------------------------------------------------------------------- 3
print("\n[3] a real MCP server, spoken to exactly like Strata's client does")


def rpc(server: str, calls: list[tuple[str, dict]]) -> list[dict]:
    """Launch `server` with binary pipes + the bat env, run `calls`, return parsed results."""
    proc = subprocess.Popen([PY, os.path.join(SERVERS, server)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, env=CLEAN, cwd=ROOT)
    out = []
    try:
        def send(msg):
            proc.stdin.write(json.dumps(msg, ensure_ascii=False).encode("utf-8") + b"\n")
            proc.stdin.flush()

        send({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {}})
        proc.stdout.readline()
        for i, (tool, args) in enumerate(calls, start=1):
            send({"jsonrpc": "2.0", "id": i, "method": "tools/call",
                  "params": {"name": tool, "arguments": args}})
            raw = proc.stdout.readline()
            # the client-side decode, verbatim from serve/mcp.py
            out.append(json.loads(raw.decode("utf-8", "replace")))
    finally:
        proc.kill()
    return out


def text_of(res: dict) -> str:
    if "error" in res:
        return f"ERROR: {res['error'].get('message')}"
    return res["result"]["content"][0]["text"]


# -- outbound: a Chinese tool result must not come back as U+FFFD -----------------
res = rpc("shell_server.py", [("exec", {"command": "echo 中文结果 OK"})])
t = text_of(res[0])
check("shell exec: Chinese stdout survives (no U+FFFD)", "中文结果" in t and "\ufffd" not in t, repr(t))

# -- a nested python printing Chinese (the UnicodeEncodeError case) ---------------
res = rpc("shell_server.py", [("exec", {"command": 'python -c "print(\'嵌套中文\')"'})])
t = text_of(res[0])
check("shell exec: nested python prints Chinese", "嵌套中文" in t and "\ufffd" not in t, repr(t))
check("shell exec: nested python did not crash", "UnicodeEncodeError" not in t, repr(t))

# -- chars GBK cannot represent at all: without a UTF-8 pin the *child python* dies --
# The command line stays pure ASCII (chr()), so this isolates stdout encoding: a child
# left on the GBK codec raises UnicodeEncodeError instead of printing.
res = rpc("shell_server.py", [("exec", {"command": 'python -c "print(chr(0x1F680)+\'ok\')"'})])
t = text_of(res[0])
check("shell exec: nested python prints an emoji (not encodable in GBK)",
      "\U0001F680ok" in t, repr(t))

# -- inbound: Chinese *arguments* must arrive intact (the surrogates case) --------
probe_file = "data/_enc_regression.txt"
res = rpc("fs_server.py", [("write", {"path": probe_file, "content": "中文内容 ABC"})])
t = text_of(res[0])
check("fs write: accepts Chinese content (no codec error)", t.startswith("wrote"), repr(t))

disk = os.path.join(ROOT, probe_file)
raw = open(disk, "rb").read() if os.path.exists(disk) else b""
check("fs write: file is non-empty", len(raw) > 0, f"{len(raw)} bytes")
check("fs write: on disk as UTF-8", raw.decode("utf-8", "replace") == "中文内容 ABC",
      repr(raw))

res = rpc("fs_server.py", [("read", {"path": probe_file})])
t = text_of(res[0])
check("fs read: round-trips Chinese", t == "中文内容 ABC", repr(t))

# -- reading a LEGACY GBK file (not everything on disk is UTF-8) ------------------
gbk_file = "data/_enc_legacy_gbk.txt"
with open(os.path.join(ROOT, gbk_file), "wb") as f:
    f.write("旧版GBK编码文件".encode("gbk"))
res = rpc("fs_server.py", [("read", {"path": gbk_file})])
t = text_of(res[0])
check("fs read: legacy GBK file decodes", t == "旧版GBK编码文件", repr(t))


# --------------------------------------------------------------------------- 4
print("\n[4] the gateway's own MCP client (runtime/executor.py) end to end")
cfg_path = os.path.join(ROOT, "config", "mcp_servers.json")
cfg = json.loads(open(cfg_path, encoding="utf-8").read())["mcpServers"]
# Hermetic: override the live workspace allow-file so relative writes stay under ROOT.
for _srv in ("filesystem", "shell"):
    if _srv in cfg:
        cfg[_srv].setdefault("env", {})["FS_ALLOW_FILE"] = ISO_ALLOW

# Strip the UTF-8 pins from *our* env so the fix, not the ambient environment, is
# what makes this pass.
saved = {k: os.environ.pop(k) for k in ("PYTHONUTF8", "PYTHONIOENCODING", "LANG", "LC_ALL")
         if k in os.environ}
try:
    from executor import Executor                                       # noqa: E402

    ex = Executor({"filesystem": cfg["filesystem"], "shell": cfg["shell"]})
    ex.start_all()
    try:
        check("executor: both servers started", len(ex.servers) == 2 and
              all(s.tools for s in ex.servers.values()),
              str({s.name: len(s.tools) for s in ex.servers.values()}))
        out = ex.call("filesystem__write",
                      {"path": "data/_enc_gateway.txt", "content": "网关写入中文"})
        check("executor: write Chinese arg passes through", not out.startswith("error:"), out[:120])
        out = ex.call("filesystem__read", {"path": "data/_enc_gateway.txt"})
        check("executor: read Chinese result intact", out == "网关写入中文", repr(out))
        out = ex.call("shell__exec", {"command": "echo 网关中文"})
        check("executor: shell Chinese intact", "网关中文" in out and "\ufffd" not in out, repr(out))
    finally:
        ex.stop_all()
finally:
    os.environ.update(saved)

for leftover in ("data/_enc_gateway.txt", "data/_enc_regression.txt",
                 "data/_enc_legacy_gbk.txt"):
    try:
        os.remove(os.path.join(ROOT, leftover))
    except OSError:
        pass

# ---------------------------------------------------------------------------
print(f"\n{'=' * 62}")
print(f"  {len(PASS)} passed, {len(FAIL)} failed")
if FAIL:
    for f in FAIL:
        print(f"    FAILED: {f}")
print(f"{'=' * 62}")
sys.exit(1 if FAIL else 0)
