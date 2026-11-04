# -*- coding: utf-8 -*-
"""Turn guard: a failure inside a turn must never look like a dropped connection.

Field report (2026-10-20, 6m08s turn, round 14): the UI showed a shell__exec card stuck
at "未运行" and the banner "连接中断，本轮未跑完". The gateway's stderr held nothing but its
startup line -- no traceback -- and `logs/empty-round.jsonl` was never created, so this was
NOT the reasoning-only "empty round" case.

Root cause in the code: `_agent_stream` wraps the round loop in `try: ... else: sse("[DONE]")
finally: unregister` -- there is no `except` clause at all. `[DONE]` therefore lives in the
`else` branch, which Python skips the moment anything raises. `ex.call(...)` (the tool call)
is not guarded either, and `executor._req` raises ToolError on a per-command timeout,
a cancelled call and a dead MCP child. The SSE 200 was already on the wire, so the handler
simply dies: the client gets EOF with no terminator and no notice -> "连接中断", and the
whole turn's plan is lost.

This test pins the contract after the fix:
  1. a tool that times out becomes a FAILED TOOL RESULT (fed back to the model), not a
     dead turn -- the model can retry with a smaller command,
  2. any other exception escaping the loop still emits a recoverable notice AND [DONE],
  3. a crash leaves a diagnostic line so the next report is diagnosable,
  4. a normal turn still ends with exactly one [DONE] and no invented notice.

Pure standard library: no network, no model, no MCP child.
"""
import io
import json
import os
import shutil
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from executor import ToolError                       # noqa: E402
from http_server import GatewayHandler, GatewayState  # noqa: E402

DIAG_DIR = tempfile.mkdtemp(prefix="turn-guard-")
os.environ["STRATA_TURN_DIAG_DIR"] = DIAG_DIR

OK = []


def check(name, cond, extra=""):
    if not cond:
        raise AssertionError(f"FAIL: {name} {extra}")
    OK.append(name)
    print(f"  ok  {name}")


class Executor:
    """Minimal executor: `mode` decides what a tool call does."""

    tools = [{"name": "shell__exec", "description": "run a command",
              "input_schema": {"type": "object"}}]

    def __init__(self, mode="ok", text="ok"):
        self.mode = mode
        self.text = text
        self.calls = 0

    def reset_cum(self):
        pass

    def call(self, name, args, on_progress=None, cancel=None):
        self.calls += 1
        if self.mode == "timeout":
            raise ToolError("tools/call timed out")
        if self.mode == "dead":
            raise ToolError("server process died (exit 1)")
        if self.mode == "boom":
            raise RuntimeError("kaboom from a tool")
        if self.mode == "slow":
            time.sleep(0.25)                       # stands in for `python build.py`
            return "slow done"
        return self.text


class FakeHandler:
    def __init__(self, state, sequences, session="s-guard"):
        body = {"messages": [{"role": "user", "content": "go"}], "temperature": 0.6,
                "strata_session": session}
        self.state = state
        self.body = body
        self.rfile = io.BytesIO(json.dumps(body).encode("utf-8"))
        self.wfile = io.BytesIO()
        self.headers = {"Content-Length": "0"}
        self.path = "/v1/chat/completions"   # stand-in for BaseHTTPRequestHandler.path (read by _agent_stream)
        self._sequences = sequences
        self._round = 0

    def _llm_stream(self, messages, tools, cancel=None, stall_s=None, max_tokens=None,
                    reasoning_effort=None, reasoning_budget=None, sampling=None):
        self._round += 1
        seq = self._sequences[self._round - 1] if self._round <= len(self._sequences) else []
        for c in seq:
            yield c

    def _merge_tc(self, calls, frags):
        GatewayHandler._merge_tc(calls, frags)          # staticmethod on the real handler

    def _diag_empty_round(self, info):
        GatewayHandler._diag_empty_round(self, info)

    def _diag_turn(self, info):
        GatewayHandler._diag_turn(self, info)

    def _diag_round(self, info):
        GatewayHandler._diag_round(self, info)

    def send_response(self, code):
        self.status = code

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


def tool_round(name="shell__exec", args=None, cid="call_1"):
    tc = {"index": 0, "id": cid, "type": "function",
          "function": {"name": name, "arguments": json.dumps(args or {"command": "build"})}}
    return [{"choices": [{"delta": {"tool_calls": [tc]}}]},
            {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}]


def final_round(text="done."):
    return [{"choices": [{"delta": {"content": text}}]},
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


def run(state, sequences, session="s-guard"):
    h = FakeHandler(state, sequences, session)
    GatewayHandler._agent_stream(h, body=h.body)     # must never raise
    return h, parse(h)


def notices(events):
    return [e["strata_notice"] for e in events
            if isinstance(e, dict) and e.get("strata_notice")]


def tool_results(events):
    out = []
    for e in events:
        ev = e.get("strata_mcp") if isinstance(e, dict) else None
        if ev and ev.get("event") == "result":
            out.append(ev)
    return out


def main() -> int:
    try:
        state = GatewayState(upstream_url="http://127.0.0.1:8080", model="strata")
        state.direct_mode = True
        state.api_key = None
        state.max_rounds = 8

        # ── 1) a timed-out tool is a failed RESULT, not a dead turn ──────────────
        print("\n=== 1: tool timeout -> failed tool result, turn survives ===")
        ex = Executor("timeout")
        state.executor = ex
        _h, ev = run(state, [tool_round(), final_round("recovered.")])
        check("the stream terminated with [DONE]", ev[-1] == "[DONE]", ev[-1:])
        check("the tool result was reported to the UI", len(tool_results(ev)) == 1, tool_results(ev))
        tr = tool_results(ev)[0]
        check("it is marked failed", tr.get("ok") is False, tr)
        check("it names the timeout", "timed out" in str(tr.get("text", "")), tr)
        check("the model was told to try smaller", "拆" in str(tr.get("text", ""))
              or "smaller" in str(tr.get("text", "")), tr)
        check("a second round really ran", ex.calls == 1 and _h._round >= 2, _h._round)
        check("the answer after recovery is streamed",
              any("recovered." in json.dumps(e, ensure_ascii=False) for e in ev))
        check("no crash notice for a plain tool failure", not notices(ev), notices(ev))

        # ── 2) a dead MCP child is also just a failed result ─────────────────────
        print("\n=== 2: dead MCP child -> failed result, turn survives ===")
        ex = Executor("dead")
        state.executor = ex
        _h2, ev2 = run(state, [tool_round(), final_round("ok.")])
        check("still ends with [DONE]", ev2[-1] == "[DONE]", ev2[-1:])
        check("result marked failed", tool_results(ev2) and tool_results(ev2)[0].get("ok") is False,
              tool_results(ev2))

        # ── 3) an UNEXPECTED exception never becomes a silent cut ───────────────
        print("\n=== 3: unexpected crash -> recoverable notice + [DONE] ===")
        state.executor = Executor("ok")
        boom = RuntimeError("state blew up mid-turn")

        def exploding(_sid):
            raise boom

        state.prompt_tokens_for = exploding            # reached at the top of round 1
        _h3, ev3 = run(state, [final_round()], "s-crash")
        check("no exception escaped the handler", True)
        check("the stream still terminated with [DONE]", ev3 and ev3[-1] == "[DONE]", ev3[-1:])
        n = notices(ev3)
        check("a notice explains the crash", len(n) == 1, n)
        check("code is turn_crash", n and n[0].get("code") == "turn_crash", n)
        check("it is resumable (work is kept)", n and n[0].get("resumable") is True, n)
        check("it carries the error text", n and "blew up" in str(n[0].get("text", "")), n)

        # ── 4) the crash left a diagnostic trail ────────────────────────────────
        print("\n=== 4: the turn log records how it ended ===")
        path = os.path.join(DIAG_DIR, "turn.jsonl")
        check("turn log exists", os.path.exists(path), path)
        lines = [json.loads(x) for x in
                 io.open(path, encoding="utf-8").read().strip().splitlines() if x.strip()]
        crashes = [x for x in lines if x.get("kind") == "crash"]
        check("one crash line", len(crashes) == 1, crashes)
        check("it records the error", "blew up" in str(crashes[0].get("error")), crashes[0])
        check("it records the round", "round" in crashes[0], crashes[0])
        check("it carries a traceback", "Traceback" in str(crashes[0].get("trace")), crashes[0])
        check("the turn logged a start and an end", any(x.get("kind") == "start" for x in lines)
              and any(x.get("kind") == "end" for x in lines), [x.get("kind") for x in lines])

        # ── 5) a healthy turn is untouched: one [DONE], no notice ───────────────
        print("\n=== 5: a healthy turn gains nothing but its [DONE] ===")
        state = GatewayState(upstream_url="http://127.0.0.1:8080", model="strata")
        state.direct_mode = True
        state.api_key = None
        state.max_rounds = 8
        ex = Executor("ok", text="file written")
        state.executor = ex
        _h5, ev5 = run(state, [tool_round(), final_round()], "s-ok")
        check("exactly one [DONE]", ev5.count("[DONE]") == 1, ev5.count("[DONE]"))
        raw5 = _h5.wfile.getvalue().decode("utf-8", "replace")
        check("nothing is written after the terminator", raw5.rstrip().endswith("data: [DONE]"),
              raw5[-40:])
        check("tool result ok", tool_results(ev5) and tool_results(ev5)[0].get("ok") is True,
              tool_results(ev5))
        check("no notice on a healthy turn", not notices(ev5), notices(ev5))
        all_lines = [json.loads(x) for x in
                     io.open(path, encoding="utf-8").read().strip().splitlines() if x.strip()]
        check("no crash logged for a healthy turn",
              len([x for x in all_lines if x.get("kind") == "crash"]) == 1,
              [x.get("kind") for x in all_lines])
        check("the healthy turn ended as 'done'",
              all_lines[-1].get("ending") == "done", all_lines[-1])

        # ── 6) a long tool call keeps the stream demonstrably alive ─────────────
        # A build/install writes nothing for minutes. The socket then looks dead to the browser's
        # idle clock, and afterwards nobody can prove the turn was still working. A comment line
        # every hb_s fixes that without inventing an event the UI must handle.
        print("\n=== 6: keepalive flows while a slow tool runs ===")
        os.environ["STRATA_HEARTBEAT_S"] = "0.05"
        os.environ["STRATA_HEARTBEAT_REPORT_S"] = "0.1"
        state6 = GatewayState(upstream_url="http://127.0.0.1:8080", model="strata")
        state6.direct_mode = True
        state6.api_key = None
        state6.max_rounds = 8
        state6.executor = Executor("slow")
        h6, ev6 = run(state6, [tool_round(), final_round("done with build.")], "s-hb")
        raw6 = h6.wfile.getvalue().decode("utf-8", "replace")
        check("keepalives were written during the tool call", ": ping" in raw6, raw6[:300])
        check("the live tool reported its elapsed time", "仍在运行" in raw6, raw6[:600])
        check("keepalives still end with one [DONE]", ev6.count("[DONE]") == 1, ev6.count("[DONE]"))
        check("nothing follows the terminator", raw6.rstrip().endswith("data: [DONE]"), raw6[-40:])
        os.environ.pop("STRATA_HEARTBEAT_S", None)
        os.environ.pop("STRATA_HEARTBEAT_REPORT_S", None)

        print(f"\nTURN-GUARD: {len(OK)} checks passed")
        return 0
    finally:
        shutil.rmtree(DIAG_DIR, ignore_errors=True)
        os.environ.pop("STRATA_TURN_DIAG_DIR", None)


if __name__ == "__main__":
    sys.exit(main())
