"""Integration regression test using the REAL MCP client: Strata's own serve/mcp.py.

Why this file exists
--------------------
`tests/test_encoding.py` exercises our servers with a hand-rolled JSON-RPC peer. This
one removes the test double: it drives the actual `McpHub` that the running app uses
(parasitic mode = `run-swift-iq3_*.bat` -> Strata's serve/server.py -> serve/mcp.py),
so "the frontend shows 乱码 / writes fail" can never come back unnoticed.

The bug it locks down: Strata's client speaks **UTF-8** on the MCP stdio wire, while
our servers used the process's *locale* codec (GBK on a Chinese Windows, and a
double-clicked .bat sets no PYTHONUTF8). Chinese tool results came back as U+FFFD and
Chinese arguments came back as surrogates, so `write` died with a UnicodeEncodeError
and left a 0-byte file.

The test strips UTF-8 pins from the environment before starting the hub, so it stays
discriminating even when the caller happens to have a UTF-8 locale. It SKIPS (exit 0)
when Strata-main is not installed -- it must not break a standalone checkout.

    python tests/test_strata_client_e2e.py
"""
from __future__ import annotations

import glob
import importlib
import json
import os
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CFG = os.path.join(ROOT, "config", "mcp_servers.json")

# Hermetic: the shipped config points FS_ALLOW_FILE at the user's live workspace file,
# and fs_server/shell_server now honour it (relative writes land in the workspace). This
# test writes relative `data/...` paths and asserts they land under ROOT, so isolate the
# allow-file to a non-existent temp path -- otherwise the test redirects its own writes
# into whatever workspace the user happens to have selected, and pollutes it.
_ISO_ALLOW = os.path.join(tempfile.gettempdir(), f"_e2e_iso_allow_{os.getpid()}.txt")
_cfg_data = json.loads(open(CFG, encoding="utf-8").read())
for _srv in ("filesystem", "shell"):
    _cfg_data["mcpServers"].setdefault(_srv, {}).setdefault("env", {})["FS_ALLOW_FILE"] = _ISO_ALLOW
CFG = os.path.join(tempfile.gettempdir(), f"_e2e_cfg_{os.getpid()}.json")
with open(CFG, "w", encoding="utf-8") as _f:
    json.dump(_cfg_data, _f, ensure_ascii=False, indent=2)

STRATA_CANDIDATES = [
    r"E:\Program Files\Strata-main",
    os.environ.get("STRATA_HOME", ""),
]
STRATA = next((p for p in STRATA_CANDIDATES if p and os.path.isdir(os.path.join(p, "serve"))), None)

if STRATA is None:
    print("SKIP: Strata-main not found (set STRATA_HOME to run this integration test)")
    sys.exit(0)

sys.path.insert(0, STRATA)
try:
    mcp = importlib.import_module("serve.mcp")
except Exception as e:                                   # noqa: BLE001
    print(f"SKIP: could not import serve.mcp from {STRATA}: {e}")
    sys.exit(0)

PASS, FAIL = [], []


def check(label, ok, detail=""):
    (PASS if ok else FAIL).append(label)
    print(f"  [{'ok' if ok else 'FAIL'}] {label}" + (f"  -- {detail}" if detail and not ok else ""))


# Make the run hostile on purpose: the hub builds each child's env from os.environ, so
# removing the UTF-8 pins reproduces exactly what a double-clicked .bat gives it.
PINNED = ("PYTHONUTF8", "PYTHONIOENCODING", "PYTHONLEGACYWINDOWSSTDIO", "LANG", "LC_ALL")
saved = {k: os.environ.pop(k) for k in PINNED if k in os.environ}
print(f"[env] stripped for this run: {sorted(saved)}")

hub = None
try:
    hub = mcp.hub_from_config({}, CFG)
    if hub is None:
        print("SKIP: the MCP config lists no servers")
        sys.exit(0)
    hub.start()
    hub.wait(120)

    tools = hub.template_tools()
    names = sorted(t["name"] for t in tools)
    check("Strata's hub started and offers every tool", len(names) >= 17, str(names))

    def call(tool, args):
        return hub.call(tool, args)

    # 1) Chinese argument IN, Chinese result OUT, UTF-8 on disk
    r = call("filesystem__write", {"path": "data/_e2e_cn.txt", "content": "端到端中文 ABC"})
    check("write accepts a Chinese argument", bool(r.get("ok")), repr(r.get("text"))[:140])
    disk = os.path.join(ROOT, "data", "_e2e_cn.txt")
    raw = open(disk, "rb").read() if os.path.exists(disk) else b""
    check("write produced a non-empty UTF-8 file", raw.decode("utf-8", "replace") == "端到端中文 ABC",
          repr(raw))

    r = call("filesystem__read", {"path": "data/_e2e_cn.txt"})
    check("read round-trips Chinese with no U+FFFD",
          r.get("text") == "端到端中文 ABC" and "\ufffd" not in r.get("text", ""),
          repr(r.get("text")))

    # 2) Chinese shell output, and a character GBK cannot represent at all
    r = call("shell__exec", {"command": "echo 端到端中文"})
    check("shell stdout is Chinese, not U+FFFD",
          "端到端中文" in r.get("text", "") and "\ufffd" not in r.get("text", ""),
          repr(r.get("text")))

    r = call("shell__exec", {"command": 'python -c "print(chr(0x1F680))"'})
    check("a nested python can print an emoji (would die on the GBK codec)",
          "\U0001F680" in r.get("text", ""), repr(r.get("text")))

    # 3) a legacy GBK file on disk still reads correctly (bonus of the smart decode)
    legacy = os.path.join(ROOT, "data", "_e2e_legacy.txt")
    with open(legacy, "wb") as f:
        f.write("旧版GBK文件".encode("gbk"))
    r = call("filesystem__read", {"path": "data/_e2e_legacy.txt"})
    check("a legacy GBK file decodes instead of turning into U+FFFD",
          r.get("text") == "旧版GBK文件", repr(r.get("text")))
finally:
    for leftover in ("data/_e2e_cn.txt", "data/_e2e_legacy.txt"):
        try:
            os.remove(os.path.join(ROOT, leftover))
        except OSError:
            pass
    for p in glob.glob(os.path.join(ROOT, "data", "_strata_*.txt")):
        try:
            os.remove(p)
        except OSError:
            pass
    for _p in (CFG, _ISO_ALLOW):          # drop the isolated temp config/allow-file
        try:
            os.remove(_p)
        except OSError:
            pass
    os.environ.update(saved)

print(f"\n{'=' * 62}")
print(f"  {len(PASS)} passed, {len(FAIL)} failed   (client: {STRATA})")
if FAIL:
    for f in FAIL:
        print(f"    FAILED: {f}")
print(f"{'=' * 62}")
sys.stdout.flush()
os._exit(1 if FAIL else 0)      # the hub's child processes hold worker threads
