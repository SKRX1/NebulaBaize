# -*- coding: utf-8 -*-
"""Integration test for the gateway direct-mode agent loop (http_server._agent_stream).

Drives the *real* `_agent_stream` method with a FakeHandler that swaps in a scripted
LLM, while the gateway's *real* Executor (all 8 MCP servers, incl. shell) runs the
tools. This exercises the actual loop code -- fail-streak 熔断, turn_budget 墙钟, the
strata_mcp event plumbing, and the /mcp shape contract -- without spawning a network
gateway or a real upstream. Pure standard library. Registered in tools/run_tests.py.
"""
import io
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from http_server import GatewayState, GatewayHandler  # noqa: E402
from executor import Executor  # noqa: E402

PY = sys.executable
ENV = dict(os.environ)
ENV.update({
    "FS_ROOT": os.path.join(ROOT),
    "FS_ALLOW": "E:/WorkBuddy",
    "FS_ALLOW_FILE": "E:/WorkBuddy/fs_allowed_roots.txt",
})

TEST_FILE = "E:/WorkBuddy/__agent_test__/hello.txt"


class FakeHandler:
    """Stand-in for BaseHTTPRequestHandler: captures SSE output, supplies a scripted LLM.

    `_agent_stream` reads the request body via `_cached_json()` (which reads `self.rfile`),
    writes SSE via `sse()` -> `self.wfile`, and yields LLM deltas from `self._llm_stream`.
    We override only `_llm_stream` and keep the rest as no-ops / BytesIO.
    """

    def __init__(self, state, body_bytes, llm_sequences):
        self.state = state
        self.rfile = io.BytesIO(body_bytes)
        self.wfile = io.BytesIO()
        self.headers = {"Content-Length": str(len(body_bytes))}
        self.path = "/v1/chat/completions"   # stand-in for BaseHTTPRequestHandler.path (read by _agent_stream)
        self._llm_sequences = llm_sequences
        self._round = 0

    def _diag_turn(self, info):
        pass                                    # turn tracing is covered by test_turn_guard.py

    def _diag_round(self, info):
        pass                                    # per-round tracing is covered by test_narration_guard.py

    def _llm_stream(self, messages, tools, cancel=None, stall_s=None, max_tokens=None,
                    reasoning_effort=None, reasoning_budget=None, sampling=None):
        self.sampling_seen = sampling
        self._round += 1
        seq = self._llm_sequences[self._round - 1]
        for c in seq:
            yield c

    def _merge_tc(self, calls, frags):
        GatewayHandler._merge_tc(calls, frags)

    def send_response(self, code):
        pass

    def _cors(self):
        pass

    def send_header(self, *a, **k):
        pass

    def _diag_empty_round(self, info):
        pass                                    # diagnostic only; see GatewayHandler._diag_empty_round

    def _mon_chunk(self, typ, length, tokens=None):
        pass                                    # monitor timeline not asserted in these loop tests

    def _chunk_type(self, c):
        # mirror of GatewayHandler._chunk_type (pure classifier, no instance state)
        if not isinstance(c, dict):
            return "other"
        if c.get("usage") is not None:
            return "usage"
        if c.get("error") is not None:
            return "error"
        if c.get("strata_notice") is not None:
            return "notice"
        sm = c.get("strata_mcp")
        if isinstance(sm, dict):
            ev = sm.get("event")
            if ev == "call":
                return "tool_call"
            if ev == "result":
                return "tool_result"
            if ev == "progress":
                return "tool_progress"
            return "mcp"
        if c.get("stopped") is not None:
            return "stopped"
        d = ((c.get("choices") or [{}])[0].get("delta") or {}) if "choices" in c else (c.get("delta") or {})
        if d.get("reasoning_content"):
            return "thinking"
        if d.get("content"):
            return "content"
        if d.get("tool_calls"):
            return "tool_call"
        if "role" in d:
            return "role"
        return "other"

    def _async_judge_turn(self, session_id, acc, shown_content, ending_kind, known):
        pass                                    # non-blocking behavior judge is diagnostic only

    def end_headers(self):
        pass


def run_loop(state, llm_sequences, body_text="go"):
    body_dict = {"messages": [{"role": "user", "content": body_text}]}
    h = FakeHandler(state, json.dumps(body_dict).encode("utf-8"), llm_sequences)
    GatewayHandler._agent_stream(h, body=body_dict)   # body kwarg skips _cached_json
    raw = h.wfile.getvalue().decode("utf-8", "replace")
    events = []
    for block in raw.split("\n\n"):
        block = block.strip()
        if not block.startswith("data:"):
            continue
        payload = block[5:].strip()
        if payload == "[DONE]":
            events.append("[DONE]")
            continue
        try:
            events.append(json.loads(payload))
        except Exception:
            pass
    return events


def _tool_call(name, arguments, cid="call_1"):
    tc = {"index": 0, "id": cid, "type": "function",
          "function": {"name": name, "arguments": json.dumps(arguments)}}
    return [{"choices": [{"delta": {"tool_calls": [tc]}}]},
            {"choices": [{"delta": {}}]}]


def _final(content):
    return [{"choices": [{"delta": {"content": content}}]},
            {"choices": [{"delta": {}}]}]


def main() -> int:
    # --- start the real executor (all 8 MCP servers) ---
    cfg_path = os.path.join(ROOT, "config", "mcp_servers.json")
    cfg = json.load(open(cfg_path, encoding="utf-8"))
    servers = cfg.get("mcpServers") or cfg.get("mcp_servers") or {}
    for e in servers.values():
        if e.get("command") == "python":
            e["command"] = PY
    executor = Executor(servers)
    os.environ.update(ENV)
    executor.start_all()
    tool_names = [t["name"] for t in executor.tools]
    assert "filesystem__write" in tool_names, "filesystem__write must be available"
    assert "shell__exec" in tool_names, "shell__exec must be available"

    state = GatewayState(upstream_url="http://127.0.0.1:8080", model="strata")
    state.executor = executor
    state.direct_mode = True
    state.api_key = None

    # ===== 1) /mcp shape contract (frontend renders t.tool / namespaced name) =====
    shim = type("S", (), {"state": state})()
    mcp = GatewayHandler._mcp_status(shim)
    assert mcp["tools"] == len(tool_names)
    assert any(s["name"] == "filesystem" for s in mcp["servers"])
    assert "settings" in mcp, f"top-level missing settings: {list(mcp)}"
    for s in mcp["servers"]:
        assert "error" in s, f"server {s['name']} missing error key"
        assert s["tools"], f"server {s['name']} has no tools"
        for t in s["tools"]:
            assert "tool" in t, f"tool {t.get('name')} missing bare 'tool' field"
            assert t["name"] == f"{s['name']}__{t['tool']}"
    assert sum(len(s["tools"]) for s in mcp["servers"]) == mcp["tools"]
    print("  [1] /mcp shape contract: OK")

    # ===== 2) normal tool success: filesystem__write =====
    state.max_rounds = 8
    state.turn_budget_s = 600
    ev = run_loop(state, [_tool_call("filesystem__write", {"path": TEST_FILE,
                                                          "content": "agent loop ok"}),
                         _final("已写入测试文件。")])
    call_evt = next((e for e in ev if isinstance(e, dict)
                     and e.get("strata_mcp", {}).get("event") == "call"), None)
    res_evt = next((e for e in ev if isinstance(e, dict)
                    and e.get("strata_mcp", {}).get("event") == "result"), None)
    assert call_evt, "expected a strata_mcp call event"
    assert res_evt and res_evt["strata_mcp"]["ok"] is True, "tool should succeed"
    assert any(e == "[DONE]" for e in ev), "stream must end with [DONE]"
    assert not any(e.get("error") for e in ev if isinstance(e, dict)), "no error events"
    assert os.path.exists(TEST_FILE) and open(TEST_FILE, encoding="utf-8").read() == "agent loop ok"
    print("  [2] tool success (filesystem__write): OK")

    # ===== 3) fail-streak 熔断: same denied shell command 3x -> "do NOT repeat it" =====
    state.max_rounds = 50
    state.turn_budget_s = 600
    denied = _tool_call("shell__exec", {"command": "rm -rf /"})
    ev = run_loop(state, [denied, denied, denied, _final("stop")])
    calls = [e for e in ev if isinstance(e, dict)
             and e.get("strata_mcp", {}).get("event") == "call"
             and e["strata_mcp"]["name"] == "shell__exec"]
    results = [e["strata_mcp"]["text"] for e in ev
               if isinstance(e, dict) and e.get("strata_mcp", {}).get("event") == "result"]
    assert len(calls) >= 3, "expected >=3 shell__exec calls, got %d" % len(calls)
    assert any("do NOT repeat it" in t for t in results), \
        "fail-streak note not injected; results=%r" % results
    print("  [3] fail-streak 熔断: OK (note injected after 3 identical failures)")

    # ===== 4) turn_budget: an ABSOLUTE ceiling that reports a RESUMABLE stop, not an error =====
    # A turn that reaches a guard rail is not a failure: everything streamed so far is valid and
    # the user can continue. It used to be a naked `{"error": ...}` (red box, turn lost).
    state.max_rounds = 50
    state.turn_budget_s = 0          # deadline already past -> the guard fires on round 1
    state.idle_timeout_s = 180
    ev = run_loop(state, [_final("should not reach")])
    notices = [e["strata_notice"] for e in ev if isinstance(e, dict) and e.get("strata_notice")]
    assert any(n.get("code") == "turn_budget" for n in notices), \
        "turn ceiling not reported; notices=%r" % notices
    assert not any(e.get("error") for e in ev if isinstance(e, dict)), \
        "a stopped turn must be a notice, not a red error"
    assert ev[-1] == "[DONE]", "stream must still terminate cleanly"
    print("  [4] turn_budget: OK (resumable notice, no error event)")

    # ===== 5) streaming: a slow command emits progress events before the final result =====
    state.max_rounds = 50
    state.turn_budget_s = 600
    slow = _tool_call("shell__exec", {"command": "ping -n 2 127.0.0.1"})  # ~1.5s, emits output
    ev = run_loop(state, [slow, _final("done")])
    progress = [e for e in ev if isinstance(e, dict)
                and e.get("strata_mcp", {}).get("event") == "progress"]
    res_evt = next((e for e in ev if isinstance(e, dict)
                    and e.get("strata_mcp", {}).get("event") == "result"), None)
    assert progress, "expected >=1 strata_mcp progress event for a slow command"
    assert res_evt and res_evt["strata_mcp"]["ok"] is True, "tool should succeed"
    print("  [5] streaming progress: OK (%d progress events emitted)" % len(progress))

    # cleanup
    try:
        os.remove(TEST_FILE)
        os.rmdir(os.path.dirname(TEST_FILE))
    except Exception:
        pass
    executor.stop_all()
    print("test_agent_loop: PASS (contract + tool success + fail-streak + turn_budget)")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
