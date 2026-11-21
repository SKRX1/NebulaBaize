"""End-to-end self-test: Executor <-> a real MCP server over stdio (no GPU, no model).

Runs servers/fs_server.py, lists its tools, and calls `list` and `write`+`read`.
This proves the executor<->server path works. Run from the Nebula-agent folder:
    python tests/test_smoke.py
"""
from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from executor import Executor  # noqa: E402

PY = sys.executable
SERVERS = {
    "fs": {"command": PY, "args": [os.path.join(ROOT, "servers", "fs_server.py")],
           "cwd": ROOT, "env": {**os.environ, "FS_ROOT": ROOT}},
}


def main() -> int:
    ex = Executor(SERVERS)
    ex.start_all()
    assert ex.tools, "executor found no tools"
    tool_names = [t["name"] for t in ex.tools]
    print("tools:", tool_names)
    out = ex.call("fs__list", {"path": ""})
    print("fs__list ->", out[:200])
    out = ex.call("fs__write", {"path": "selftest.txt", "content": "hello from agent"})
    print("fs__write ->", out)
    out = ex.call("fs__read", {"path": "selftest.txt"})
    print("fs__read ->", out)
    assert "hello from agent" in out
    ex.stop_all()
    print("SELF-TEST OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
