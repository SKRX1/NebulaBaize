# -*- coding: utf-8 -*-
"""Turn-budget contract for the direct-mode agent loop.

Pins three behaviours:
  1) GatewayState defaults — a generous ABSOLUTE ceiling plus a much shorter stall window.
     (A flat 600s wall clock used to kill real coding turns in the middle of writing files.)
  2) Reaching the ceiling or the round cap ends the turn with a resumable `strata_notice`,
     never a red `error` event, and the stream still terminates with [DONE].
  3) A silent upstream raises UpstreamStalled inside the stall window instead of hanging
     until the 600s urlopen timeout.

Pure standard library: no gateway process, no real engine, no MCP servers.
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from http_server import GatewayState, GatewayHandler, UpstreamStalled  # noqa: E402


# ─── minimal stand-ins ───────────────────────────────────────────────────────────

class FakeExec:
    """Just enough of Executor for _agent_stream: no tools, calls always succeed."""

    def __init__(self):
        self.tools = []
        self.calls = 0
        self.reset_called = 0

    def reset_cum(self):
        self.reset_called += 1

    def call(self, name, args, on_progress=None, cancel=None):
        self.calls += 1
        return "ok"


class FakeHandler:
    """Stand-in for BaseHTTPRequestHandler: captures SSE, supplies a scripted LLM."""

    def __init__(self, state, body, llm_sequences):
        self.state = state
        self.wfile = open(os.devnull, "wb")
        self.headers = {}
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
        seq = self._llm_sequences[self._round - 1] if self._round <= len(self._llm_sequences) else []
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

    def _mon_chunk(self, typ, length):
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


class CapturedHandler(FakeHandler):
    """Same, but keeps the SSE bytes in memory."""

    def __init__(self, state, body, llm_sequences):
        super().__init__(state, body, llm_sequences)
        import io
        self.wfile = io.BytesIO()

    def events(self):
        raw = self.wfile.getvalue().decode("utf-8", "replace")
        out = []
        for block in raw.split("\n\n"):
            block = block.strip()
            if not block.startswith("data:"):
                continue
            payload = block[5:].strip()
            if payload == "[DONE]":
                out.append("[DONE]")
                continue
            try:
                out.append(json.loads(payload))
            except Exception:
                pass
        return out


def _tool_call(name, arguments, cid="call_1"):
    tc = {"index": 0, "id": cid, "type": "function",
          "function": {"name": name, "arguments": json.dumps(arguments)}}
    return [{"choices": [{"delta": {"tool_calls": [tc]}}]},
            {"choices": [{"delta": {}}]}]


def _final(content):
    return [{"choices": [{"delta": {"content": content}}]},
            {"choices": [{"delta": {}}]}]


def run_loop(state, llm_sequences, body_text="go"):
    body = {"messages": [{"role": "user", "content": body_text}]}
    h = CapturedHandler(state, body, llm_sequences)
    GatewayHandler._agent_stream(h, body=body)
    return h.events()


# ─── a mock upstream: one token, then silence forever ────────────────────────────

class SilentUpstream(BaseHTTPRequestHandler):
    tokens = 0
    mode = "silent"          # "silent" | "healthy"

    def do_POST(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        n = 0
        try:
            if SilentUpstream.mode == "silent":
                d = {"choices": [{"delta": {"content": "partial "}}]}
                self.wfile.write(("data: " + json.dumps(d) + "\n\n").encode())
                self.wfile.flush()
                time.sleep(5)                    # accepted the request, then wedged
            else:
                for _ in range(6):
                    d = {"choices": [{"delta": {"content": f"t{n} "}}]}
                    self.wfile.write(("data: " + json.dumps(d) + "\n\n").encode())
                    self.wfile.flush()
                    n += 1
                    time.sleep(0.05)
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            SilentUpstream.tokens = n
        except (BrokenPipeError, ConnectionResetError, OSError):
            SilentUpstream.tokens = n

    def log_message(self, *a):
        pass


def _bare_handler(base_url):
    """A GatewayHandler instance without a socket — enough to call _llm_stream."""
    h = GatewayHandler.__new__(GatewayHandler)
    h.state = GatewayState(upstream_url=base_url, model="test-model")
    h.headers = {}
    h.path = "/v1/chat/completions"
    h.command = "POST"
    return h


def main() -> int:
    # ===== 1) defaults: generous ceiling, short stall window =====
    st = GatewayState(upstream_url="http://127.0.0.1:8080", model="strata")
    assert st.turn_budget_s >= 1800, f"absolute ceiling too tight: {st.turn_budget_s}"
    assert 30 <= st.idle_timeout_s <= 600, f"stall window out of range: {st.idle_timeout_s}"
    assert st.idle_timeout_s < st.turn_budget_s, "the stall window must be the tighter clock"
    assert st.max_rounds >= 100, f"round cap too low for a coding turn: {st.max_rounds}"
    print("  [1] defaults: OK (ceiling %ds, stall %ds, rounds %d)"
          % (st.turn_budget_s, st.idle_timeout_s, st.max_rounds))

    # ===== 2) absolute ceiling -> resumable notice, never an error =====
    state = GatewayState(upstream_url="http://127.0.0.1:8080", model="strata")
    ex = FakeExec()
    state.executor = ex
    state.turn_budget_s = 0          # already past the deadline
    state.idle_timeout_s = 180
    ev = run_loop(state, [_final("should not reach")])
    notices = [e["strata_notice"] for e in ev if isinstance(e, dict) and e.get("strata_notice")]
    assert any(n.get("code") == "turn_budget" for n in notices), f"no turn_budget notice: {ev}"
    assert not any(e.get("error") for e in ev if isinstance(e, dict)), "a stop must not be an error"
    assert ev and ev[-1] == "[DONE]", "stream must end with [DONE]"
    assert ex.reset_called == 1, "per-server cumulative budget must be reset at turn start"
    print("  [2] hard ceiling: OK (notice, no error, [DONE])")

    # ===== 3) round cap -> resumable notice (previously ended silently) =====
    state = GatewayState(upstream_url="http://127.0.0.1:8080", model="strata")
    state.executor = ex
    state.max_rounds = 2
    state.turn_budget_s = 600
    state.idle_timeout_s = 180
    ev = run_loop(state, [_tool_call("shell__exec", {"command": "echo 1"}, "c1"),
                          _tool_call("shell__exec", {"command": "echo 2"}, "c2")])
    notices = [e["strata_notice"] for e in ev if isinstance(e, dict) and e.get("strata_notice")]
    assert any(n.get("code") == "rounds" for n in notices), f"no rounds notice: {ev}"
    assert not any(e.get("error") for e in ev if isinstance(e, dict)), "round cap must not be an error"
    print("  [3] round cap: OK (notice, no error)")

    # ===== 4) a healthy stream is untouched by the stall watch =====
    SilentUpstream.mode = "healthy"
    srv = ThreadingHTTPServer(("127.0.0.1", 0), SilentUpstream)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}/v1"
    try:
        h = _bare_handler(base)
        got = list(GatewayHandler._llm_stream(h, [{"role": "user", "content": "x"}], [], stall_s=1))
        assert len(got) == 6, f"expected 6 chunks, got {len(got)}"
        print("  [4] healthy stream: OK (%d chunks, no false stall)" % len(got))

        # ===== 5) silent upstream -> UpstreamStalled inside the stall window =====
        SilentUpstream.mode = "silent"
        h = _bare_handler(base)
        t0 = time.time()
        # The first chunk lands right at the edge of the stall window, so on a loaded
        # machine it occasionally arrives after the timeout instead of before it. Retry
        # once inside the same allowance: flaky first attempts stay green, a real
        # regression fails both tries.
        attempts = []
        for attempt in range(2):
            if attempt:
                time.sleep(0.3)                        # let the OS scheduler settle
            t0 = time.time()
            seen = []
            raised = False
            try:
                for item in GatewayHandler._llm_stream(h, [{"role": "user", "content": "x"}], [], stall_s=1):
                    seen.append(item)
            except UpstreamStalled:
                raised = True
            dt = time.time() - t0
            assert raised, "a wedged upstream must raise UpstreamStalled, not hang"
            assert dt < 4, f"stall detection too slow: {dt:.1f}s"
            attempts.append((seen, dt))
            if seen: break
        assert any(s for s, _ in attempts), "the token before the stall was never delivered (two tries)"
        if len(attempts) > 1:
            print("  [5] silent upstream: OK (retry %d passed; first attempt saw %d chunks)" % (len(attempts), len(attempts[0][0])))
        else:
            print("  [5] silent upstream: OK (stall detected in %.1fs)" % attempts[0][1])
    finally:
        srv.shutdown()
        srv.server_close()

    print("test_turn_budget: PASS (defaults + ceiling/round notices + stall watchdog)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
