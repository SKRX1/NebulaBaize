# -*- coding: utf-8 -*-
"""Empty-round contract: a round that yields thinking but no text and no tool call.

This is the symptom users report as "the stream just stopped": the model emits
reasoning_content, then the round ends with finish_reason=stop, no assistant text and
no tool call. The gateway used to `break` straight to [DONE], so the UI showed a
finished turn with nothing in it and no explanation.

The test pins three things:
  1. such a round now emits a recoverable `strata_notice` (code=empty_round) with text,
  2. a SECOND identical round is reported as non-resumable (retrying blindly would just
     burn another round), and
  3. the composer's sampling settings (temperature/top_p/top_k) reach `_llm_stream`
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

        # ── 1) thinking-only round is reported, not silently finished ──
        print("\n=== 1: thinking-only round -> recoverable notice ===")
        h, ev = run(state, [thinking_only()], "s1")
        notice = next((e["strata_notice"] for e in ev if isinstance(e, dict)
                       and e.get("strata_notice")), None)
        check("a notice is emitted", notice is not None, f"events={ev}")
        check("code is empty_round", notice and notice.get("code") == "empty_round", notice)
        check("it is resumable", notice and notice.get("resumable") is True, notice)
        check("it carries human text", notice and len(notice.get("text") or "") > 10, notice)
        check("finish_reason is reported", notice and notice.get("finish") == "stop", notice)
        check("thinking is still streamed to the UI",
              any(isinstance(e, dict) and "reasoning_content" in json.dumps(e) for e in ev))
        check("turn terminates with [DONE]", ev[-1] == "[DONE]", ev[-1])
        check("no bogus error chunk", not any(isinstance(e, dict) and e.get("error") for e in ev))

        # ── 2) two empty rounds in a row must NOT invite a blind retry ──
        # An empty round ENDS the turn, so "in a row" means two separate requests in the same
        # conversation -- the second one is what the user gets after pressing 继续.
        print("\n=== 2: second consecutive empty round -> not resumable ===")
        _h2a, ev2a = run(state, [thinking_only()], "s2")
        _h2b, ev2b = run(state, [thinking_only()], "s2")
        notices = ([e["strata_notice"] for e in ev2a if isinstance(e, dict) and e.get("strata_notice")]
                   + [e["strata_notice"] for e in ev2b if isinstance(e, dict) and e.get("strata_notice")])
        check("a notice per empty round", len(notices) == 2, notices)
        check("first one is resumable", notices[0].get("resumable") is True, notices[0])
        check("second one is NOT resumable", notices[1].get("resumable") is False, notices[1])
        check("second one reports the streak", notices[1].get("streak") == 2, notices[1])
        check("second one asks for a setting change",
              "温度" in (notices[1].get("text") or ""), notices[1])

        # ── 3) a real answer still ends silently (no notice invented) ──
        print("\n=== 3: a normal answer does not grow a notice ===")
        _h3, ev3 = run(state, [[{"choices": [{"delta": {"content": "done."}}]},
                                {"choices": [{"delta": {}, "finish_reason": "stop"}]}]])
        check("answer text streamed",
              any("done." in json.dumps(e, ensure_ascii=False) for e in ev3))
        check("no notice on a normal answer",
              not any(isinstance(e, dict) and e.get("strata_notice") for e in ev3))

        # ── 4) composer sampling reaches the LLM call ──
        print("\n=== 4: sampling is forwarded, not dropped ===")
        h4, _ = run(state, [thinking_only()], "s4")
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
