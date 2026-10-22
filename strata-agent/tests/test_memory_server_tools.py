"""Regression guard for the memory MCP server's advertised tool surface.

A real bug (found during live end-to-end smoke) was that the memory server
exposed raw WRITE tools `remember` / `store`, which let the model write facts
straight into data/semantic.db — bypassing the user-gated, scoped, audited
three-library system (rules/knowledge/experience via the ```propose-* fences)
AND ignoring the autoMemory toggle. The designed auto-deposition only fires
when the model is steered to the fence path; the direct write tools hollowed
that out.

This test locks the fix at BOTH surfaces:
  1. the declared `tools` list (what the model is actually offered), and
  2. the `call_tool` dispatch (so a stale "store"/"remember" branch can't
     silently execute even if it were re-added).

Run from the strata-agent folder with the managed python:
    python tests/test_memory_server_tools.py
"""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER_PATH = os.path.join(ROOT, "servers", "memory_server.py")

# Point the server's data dir at a throwaway location so instantiating it
# (which creates EpisodicMemory / SemanticMemory handles) never touches the
# real runtime data/. Must be set BEFORE the module is imported, because the
# module reads AGENT_DATA into a module-level constant at import time.
_TMP = tempfile.mkdtemp(prefix="mem_srv_probe_")
os.environ["AGENT_DATA"] = _TMP

# servers/memory_server.py inserts servers/ and runtime/ into sys.path itself,
# which is what makes `from memory.episodic import ...` resolve. Load it by
# file location (it is not a package) under a unique module name.
_spec = importlib.util.spec_from_file_location("mem_srv_probe", SERVER_PATH)
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
MemoryServer = _module.MemoryServer


def _tool_names():
    return {t["name"] for t in MemoryServer.tools}


def main() -> int:
    names = _tool_names()

    # --- 1) the raw WRITE tools must NOT be advertised to the model ---
    for banned in ("store", "remember"):
        assert banned not in names, (
            f"REGRESSION: memory server re-exposes '{banned}' — this bypasses the "
            f"scoped, audited three-library system and the autoMemory toggle. "
            f"Advertised tools: {sorted(names)}"
        )

    # --- 2) the legitimate, user-gated tools must still be present ---
    # (guards against accidentally emptying the server while removing the bad ones)
    for required in ("recall", "ingest", "forget", "sources", "read_source"):
        assert required in names, (
            f"REGRESSION: expected memory tool '{required}' is missing. "
            f"Advertised tools: {sorted(names)}"
        )

    # --- 3) the dispatch must reject the removed names (no silent dead branch) ---
    srv = MemoryServer()
    for banned in ("store", "remember"):
        try:
            srv.call_tool(banned, {"text": "x", "event": "x"})
        except Exception:
            pass  # expected: unknown tool
        else:
            raise AssertionError(
                f"REGRESSION: call_tool('{banned}', ...) executed instead of "
                f"raising 'unknown tool' — the direct write path is back."
            )

    print("memory server tool surface OK: store/remember removed; "
          f"exposed = {sorted(names)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
