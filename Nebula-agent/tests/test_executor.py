# -*- coding: utf-8 -*-
"""Unit tests for the executor's structured-error envelope and transient-retry backoff.

No live MCP servers: the executor is fed a fake StdioServer so we can drive the retry
path deterministically. Registered in tools/run_tests.py. Pure standard library.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import executor as ex  # noqa: E402


def test_error_envelope():
    assert ex.is_error("error: boom") is True
    assert ex.is_error("ok text") is False
    assert ex.is_error({"text": "x", "images": []}) is False
    assert ex.error_code("error: command blocked by sandbox deny list: rm -rf") == "denied"
    assert ex.error_code("error: command timed out after 5s") == "timeout"
    assert ex.error_code("error: no such tool: x__y") == "notfound"
    assert ex.error_code("error: server process died (exit 1)") == "transient"
    assert ex.error_code("error: a command exited non-zero") == "exec"
    print("  [envelope] is_error / error_code categories: OK")


def test_retry_transient():
    class FakeSrv:
        def __init__(self):
            self.n = 0

        def call(self, real, args, on_progress=None, cancel=None):
            self.n += 1
            if self.n <= 2:
                raise ex.ToolError("server process died (exit 1)")   # transient -> retried
            return "ok result"

    e = ex.Executor({})
    fake = FakeSrv()
    e.servers = {}
    e._tool_owner = {"fake__x": (fake, "x")}
    out = e.call("fake__x", {})
    assert out == "ok result", out
    assert fake.n == 3, "expected 2 retries then success, got %d calls" % fake.n
    print("  [retry] transient failure retried then succeeded: OK")


def test_no_retry_logical():
    class FakeSrv:
        def call(self, real, args, on_progress=None, cancel=None):
            raise ex.ToolError("denied")   # logical error -> NOT retried

    e = ex.Executor({})
    e.servers = {}
    e._tool_owner = {"fake__x": (FakeSrv(), "x")}
    out = e.call("fake__x", {})
    assert out.startswith("error:"), out
    print("  [retry] logical error not retried: OK")


def test_no_retry_logical():
    class FakeSrv:
        def call(self, real, args, on_progress=None, cancel=None):
            raise ex.ToolError("denied")   # logical error -> NOT retried

    e = ex.Executor({})
    e.servers = {}
    e._tool_owner = {"fake__x": (FakeSrv(), "x")}
    out = e.call("fake__x", {})
    assert out.startswith("error:"), out
    print("  [retry] logical error not retried: OK")


def test_server_timeout():
    """Item 6: a server over its per-session cumulative budget must short-circuit with a
    ``server timeout`` ToolError (never reaching the live proc) and map to code ``server_timeout``.

    The ceiling trips at >= limit, so a server sitting exactly at the budget is stopped,
    not given one more free call.
    """
    prev = ex.SERVER_TIMEOUT_S
    ex.SERVER_TIMEOUT_S = 1.0
    try:
        # Over budget: call() must raise BEFORE touching the (nonexistent) subprocess.
        over = ex.StdioServer("fake", "python", [])
        over._cum_s = 999.0
        try:
            over.call("t", {})
            assert False, "expected server timeout ToolError"
        except ex.ToolError as e:
            assert "server timeout" in str(e).lower(), str(e)

        # Boundary: trips at exactly the limit (>=), not strictly after it.
        at_limit = ex.StdioServer("fake", "python", [])
        at_limit._cum_s = 1.0
        try:
            at_limit.call("t", {})
            assert False, "expected server timeout exactly at the limit"
        except ex.ToolError as e:
            assert "server timeout" in str(e).lower(), str(e)

        # Just under the limit: proceeds to the real request path (patched, no live proc).
        def fake_req(method, params, on_progress=None, cancel=None):
            return {"content": [{"type": "text", "text": "ok"}]}
        just_under = ex.StdioServer("fake", "python", [])
        just_under._cum_s = 0.999
        just_under._req = fake_req
        assert just_under.call("t", {}) == "ok", "under-budget call must reach _req"

        # error_code mapping
        assert ex.error_code("error: server timeout: cumulative budget 1s exceeded") == "server_timeout"

        # End-to-end via Executor: an over-budget call surfaces as an error: string with
        # code server_timeout, and is NOT retried (server_timeout is not a transient hint).
        e2 = ex.Executor({})
        e2.servers = {}
        srv = ex.StdioServer("fake", "python", [])
        srv._cum_s = 999.0
        e2._tool_owner = {"fake__x": (srv, "x")}
        out = e2.call("fake__x", {})
        assert ex.is_error(out) and ex.error_code(out) == "server_timeout", out
    finally:
        ex.SERVER_TIMEOUT_S = prev
    print("  [timeout] per-server cumulative ceiling: OK")


def main() -> int:
    try:
        test_error_envelope()
        test_retry_transient()
        test_no_retry_logical()
        test_server_timeout()
        print("test_executor: PASS")
        return 0
    except AssertionError as e:
        print("test_executor: FAIL ->", e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
