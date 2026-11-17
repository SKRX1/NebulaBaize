# -*- coding: utf-8 -*-
"""Empty-round contract: a round that yields thinking but no text and no tool call.

This is the symptom users report as "the stream just stopped": the model emits
reasoning_content, then the round ends with finish_reason=stop, no assistant text and
no tool call. The gateway used to `break` straight to [DONE], so the UI showed a
finished turn with nothing in it and no explanation.

The test pins four things:
  1. the FIRST thinking-only round triggers an auto-nudge (continue working) -- the
     user never sees a notice; the model gets another chance and produces a real answer,
  2. a SECOND consecutive empty round within the same request stops with a notice
     (non-resumable, asks for a setting change) -- another nudge would burn a round,
  3. a normal answer still finalizes without any invented notice, and
  4. the composer's sampling settings (temperature/top_p/top_k) reach `_llm_stream`
     instead of being dropped -- at the engine default 1.0 a reasoning model wanders
     and produces exactly this empty round.
Pure standard library, no network, no model.
"""
import io
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from http_server import GatewayState, GatewayHandler  # noqa: E402

DIAG_DIR = tempfile.mkdtemp(prefix="empty-round-")
os.environ["STRATA_EMPTY_ROUND_DIR"] = DIAG_DIR

OK = []


def check(name, cond, extra=""):
    if not cond:
        raise AssertionError(f"FAIL: {name} {extra}")
    OK.append(name)
    print(f"  ok  {name}")


class StubExecutor:
    """No MCP servers needed: an empty round never calls a tool."""

    tools = []

    def reset_cum(self):
        pass

    def call(self, *a, **k):                      # pragma: no cover - should not be reached
        raise AssertionError("no tool call expected in an empty round")


class FakeHandler:
    def __init__(self, state, sequences, session=None):
        body = {"messages": [{"role": "user", "content": "go"}], "temperature": 0.6,
                "top_p": 0.95, "top_k": 20, "max_tokens": 4096,
                "strata_session": session}
        self.state = state
        self.body = body
        self.rfile = io.BytesIO(json.dumps(body).encode("utf-8"))
        self.wfile = io.BytesIO()
        self.headers = {"Content-Length": "0"}
        self.path = "/v1/chat/completions"   # stand-in for BaseHTTPRequestHandler.path (read by _agent_stream)
        self._sequences = sequences
        self._round = 0
        self.sampling_seen = None

    def _llm_stream(self, messages, tools, cancel=None, stall_s=None, max_tokens=None,
                    reasoning_effort=None, reasoning_budget=None, sampling=None):
        self.sampling_seen = sampling
        self._round += 1
        seq = self._sequences[self._round - 1] if self._round <= len(self._sequences) else []
        for c in seq:
            yield c

    def _merge_tc(self, calls, frags):
        GatewayHandler._merge_tc(calls, frags)

    def _diag_empty_round(self, info):
        GatewayHandler._diag_empty_round(self, info)

    def _diag_turn(self, info):
        pass                                    # turn tracing is covered by test_turn_guard.py

    def _diag_round(self, info):
        pass                                    # per-round tracing is covered by test_narration_guard.py

    def send_response(self, code):
        pass

    def _cors(self):
        pass

    def send_header(self, *a, **k):
        pass

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


def thinking_only(text="I need to investigate this further. Let me check the details."):
    """Exactly what the failing turn looked like: reasoning, then a clean stop, no text."""
    return [{"choices": [{"delta": {"reasoning_content": text}}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}]}]


def parse(handler):
    raw = handler.wfile.getvalue().decode("utf-8", "replace")
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


def run(state, sequences, session=None):
    h = FakeHandler(state, sequences, session)
    GatewayHandler._agent_stream(h, body=h.body)
    return h, parse(h)


def main() -> int:
    try:
        state = GatewayState(upstream_url="http://127.0.0.1:8080", model="strata")
        state.executor = StubExecutor()
        state.direct_mode = True
        state.api_key = None
        state.max_rounds = 8

        # ── 1) first thinking-only round: auto-nudged, model recovers with a real answer ──
        print("\n=== 1: first thinking-only round -> nudged, no notice to user ===")
        REAL_ANSWER1 = [{"choices": [{"delta": {"content": "All done."}}]},
                        {"choices": [{"delta": {}, "finish_reason": "stop"}]}]
        h, ev = run(state, [thinking_only(), REAL_ANSWER1], "s1")
        notices = [e["strata_notice"] for e in ev if isinstance(e, dict) and e.get("strata_notice")]
        check("no notice for the user (model recovered after nudge)",
              len(notices) == 0, f"notices={notices}")
        check("model gave a real answer after being nudged",
              any("All done" in json.dumps(e, ensure_ascii=False) for e in ev))
        check("thinking was still streamed to the UI",
              any(isinstance(e, dict) and "reasoning_content" in json.dumps(e) for e in ev))
        check("turn terminates with [DONE]", ev[-1] == "[DONE]", ev[-1])
        check("no bogus error chunk", not any(isinstance(e, dict) and e.get("error") for e in ev))

        # ── 2) two consecutive thinking-only rounds within ONE request -> stop with notice ──
        # First round: empty -> auto-nudge (continue). Second round: still empty -> streak=2
        # -> STOP with a non-resumable notice (asks for a setting change).
        print("\n=== 2: two consecutive empty rounds -> stop with non-resumable notice ===")
        _h2, ev2 = run(state, [thinking_only(), thinking_only()], "s2")
        notices = [e["strata_notice"] for e in ev2 if isinstance(e, dict) and e.get("strata_notice")]
        check("exactly one notice (the stop notice)", len(notices) == 1, notices)
        check("code is empty_round", notices[0].get("code") == "empty_round", notices[0])
        check("it is NOT resumable", notices[0].get("resumable") is False, notices[0])
        check("it reports the streak", notices[0].get("streak") == 2, notices[0])
        check("it asks for a setting change",
              "温度" in (notices[0].get("text") or ""), notices[0])

        # ── 3) a real answer still ends silently (no notice invented) ──
        print("\n=== 3: a normal answer does not grow a notice ===")
        _h3, ev3 = run(state, [[{"choices": [{"delta": {"content": "done."}}]},
                                {"choices": [{"delta": {}, "finish_reason": "stop"}]}]])
        check("answer text streamed",
              any("done." in json.dumps(e, ensure_ascii=False) for e in ev3))
        check("no notice on a normal answer",
              not any(isinstance(e, dict) and e.get("strata_notice") for e in ev3))

        # ── 4) composer sampling reaches the LLM call (first empty round gets nudged) ──
        print("\n=== 4: sampling is forwarded, not dropped ===")
        REAL_ANSWER4 = [{"choices": [{"delta": {"content": "ok"}}]},
                        {"choices": [{"delta": {}, "finish_reason": "stop"}]}]
        h4, _ = run(state, [thinking_only(), REAL_ANSWER4], "s4")
        s = h4.sampling_seen or {}
        check("temperature forwarded", s.get("temperature") == 0.6, s)
        check("top_p forwarded", s.get("top_p") == 0.95, s)
        check("top_k forwarded as int", s.get("top_k") == 20, s)
        check("unset keys stay absent", "seed" not in s, s)

        # ── 5) diagnostics are written for the next investigation ──
        print("\n=== 5: empty rounds leave a diagnostic trail ===")
        path = os.path.join(DIAG_DIR, "empty-round.jsonl")
        check("log file exists", os.path.exists(path), path)
        lines = [json.loads(x) for x in
                 io.open(path, encoding="utf-8").read().strip().splitlines() if x.strip()]
        check("one line per empty round", len(lines) == 4, len(lines))
        rec = lines[0]
        for key in ("ts", "round", "finish", "content_chars", "reasoning_chars", "sampling"):
            check(f"diagnostic has {key}", key in rec, rec)
        check("reasoning length recorded",
              rec["reasoning_chars"] > 0 and rec["content_chars"] == 0, rec)

        print(f"\nEMPTY-ROUND: {len(OK)} checks passed")
        return 0
    finally:
        shutil.rmtree(DIAG_DIR, ignore_errors=True)
        os.environ.pop("STRATA_EMPTY_ROUND_DIR", None)


if __name__ == "__main__":
    sys.exit(main())
