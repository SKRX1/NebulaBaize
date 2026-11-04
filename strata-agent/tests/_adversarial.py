# -*- coding: utf-8 -*-
"""Shared adversarial harness for the gateway agent loop.

This is the consolidated "adversarial sample library": every scenario is a
scripted LLM stream that mimics a way a REAL model/engine combination has
broken the stream in production (the four 2026-10-20 failure modes, plus a few
neighbours). Drive each through the REAL `_agent_stream` loop -- only the LLM is
faked -- and assert the invariants that define "no silent failure":

  * the turn ALWAYS terminates with `[DONE]` (never a silent disconnect), and
  * a call that arrived as text is recovered, executed, AND stripped from the
    history the model sees next round (never leaked as markup the model reads
    as "the call already ran").

Import this from other tests too, so a new bug becomes "add one scenario + one
assertion" instead of a brand-new file.

Pure standard library: no network, no model, no MCP child.
"""
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from http_server import (GatewayHandler, GatewayState,           # noqa: E402
                         looks_like_narration, text_tool_calls)

KNOWN = {"filesystem__write", "shell__exec"}


class Executor:
    tools = [
        {"name": "filesystem__write", "description": "write a file",
         "input_schema": {"type": "object"}},
        {"name": "shell__exec", "description": "run a command",
         "input_schema": {"type": "object"}},
    ]

    def __init__(self, behavior=None):
        self.calls = []
        self.behavior = behavior or {}

    def reset_cum(self):
        pass

    def call(self, name, args, on_progress=None, cancel=None):
        self.calls.append((name, args))
        n = len(self.calls)
        if n in (self.behavior.get("raise_on") or ()):
            raise RuntimeError(self.behavior.get("err") or "tool exploded")
        if n in (self.behavior.get("error_on") or ()):
            return "error: " + (self.behavior.get("err") or "boom")
        return "ok " + name


class FakeHandler:
    def __init__(self, state, sequences, session="s-adv"):
        body = {"messages": [{"role": "user", "content": "build the game"}],
                "temperature": 0.6, "strata_session": session}
        self.state = state
        self.body = body
        self.rfile = io.BytesIO(json.dumps(body).encode("utf-8"))
        self.wfile = io.BytesIO()
        self.headers = {"Content-Length": "0"}
        self.path = "/v1/chat/completions"   # stand-in for BaseHTTPRequestHandler.path (read by _agent_stream)
        self._sequences = sequences
        self._round = 0
        self.seen = []                      # messages passed to the model, per round

    def _llm_stream(self, messages, tools, cancel=None, stall_s=None, max_tokens=None,
                    reasoning_effort=None, reasoning_budget=None, sampling=None):
        self._round += 1
        self.seen.append(json.loads(json.dumps(messages, ensure_ascii=False)))
        seq = self._sequences[self._round - 1] if self._round <= len(self._sequences) else []
        for c in seq:
            yield c

    def _merge_tc(self, calls, frags):
        GatewayHandler._merge_tc(calls, frags)

    def _diag_empty_round(self, info):
        pass

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


def tool_round(name="filesystem__write", args=None, cid="call_1"):
    tc = {"index": 0, "id": cid, "type": "function",
          "function": {"name": name,
                       "arguments": json.dumps(args or {"path": "_build/00_head.html",
                                                        "content": "<html>"})}}
    return [{"choices": [{"delta": {"tool_calls": [tc]}}]},
            {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}]


def text_round(text, reasoning="", finish="stop"):
    out = []
    if reasoning:
        out.append({"choices": [{"delta": {"reasoning_content": reasoning}}]})
    out += [{"choices": [{"delta": {"content": text}}]},
            {"choices": [{"delta": {}, "finish_reason": finish}]}]
    return out


def xml_call_round():
    """A call the engine failed to parse: it arrives as plain answer text."""
    text = ("这就是头部文件。\n<tool_call>\n<function=filesystem__write>\n"
            "<parameter=path>\n_build/00_head.html\n</parameter>\n"
            "<parameter=content>\n<html><head></head></html>\n</parameter>\n"
            "</function>\n</tool_call>\n")
    return text_round(text)


def fresh_state(behavior=None):
    st = GatewayState(upstream_url="http://127.0.0.1:8080", model="strata")
    st.direct_mode = True
    st.api_key = None
    st.max_rounds = 12
    st.executor = Executor(behavior)
    return st


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


def run(state, sequences, session="s-adv"):
    h = FakeHandler(state, sequences, session)
    GatewayHandler._agent_stream(h, body=h.body)      # must never raise
    return h, parse(h)


def tool_results(events):
    return [e["strata_mcp"] for e in events
            if isinstance(e, dict) and e.get("strata_mcp", {}).get("event") == "result"]


def notices(events):
    return [e["strata_notice"] for e in events
            if isinstance(e, dict) and e.get("strata_notice")]


def history_has_markup(h, round_index):
    if round_index >= len(h.seen):
        return False
    return any(("<function=" in str(m.get("content")) or "<tool_call" in str(m.get("content")))
               for m in h.seen[round_index])


# The text the USER actually sees: the content deltas pushed over SSE (after any
# streaming cleaner), NOT the raw `acc["content"]` the model keeps in history.
_CALL_MARKUP_TOKENS = ("<function=", "<tool_call", "</function>", "</tool_call>",
                       "<parameter=", "</parameter>")


def visible_content(events):
    out = []
    for e in events:
        if isinstance(e, dict):
            ch = (e.get("choices") or [{}])[0]
            d = ch.get("delta") or {}
            if d.get("content"):
                out.append(d["content"])
    return "".join(out)


def visible_has_markup(events):
    text = visible_content(events)
    return any(tok in text for tok in _CALL_MARKUP_TOKENS)


# ── scenario registry ─────────────────────────────────────────────────────────
# name -> dict(sequences, behavior=None, recovers_markup=False,
#              expect=lambda h, ev, st, check, name: None)
SCENARIOS = {}


def _s(name, sequences, behavior=None, expect=None):
    SCENARIOS[name] = {"sequences": sequences, "behavior": behavior,
                       "expect": expect or (lambda *a: None)}


# FM4: a call written as text is recovered, executed, and the cleaned history is
# fed to the model next round (no raw markup leaks into the prompt).
_s("xml_call_recovered",
   [xml_call_round(),
    tool_round(cid="c2", name="shell__exec", args={"command": "ls"}),
    text_round("已完成。")],
   expect=lambda h, ev, st, check, n: (
       check(f"[{n}] the leaked call executed first",
             bool(st.executor.calls) and st.executor.calls[0][0] == "filesystem__write",
             st.executor.calls)
       and check(f"[{n}] no markup in the history sent next round",
                 not history_has_markup(h, 1), h.seen[1])))


# FM4 neighbour: an unknown function name is prose, never executed.
_s("unknown_func_noexec",
   [text_round("调用格式是 <function=nonexistent_tool>...</function> 这样。")],
   expect=lambda h, ev, st, check, n: check(f"[{n}] unknown name not executed",
            st.executor.calls == [], st.executor.calls))


# FM4 neighbour: orphan closers are cleaned, no call invented.
_s("orphan_closer",
   [text_round("写好了。\n</function>\n</tool_call>")],
   expect=lambda h, ev, st, check, n: check(f"[{n}] no call invented from orphan tags",
            st.executor.calls == [], st.executor.calls))


# FM4 neighbour: malformed JSON args keep raw text, the call still runs.
_s("malformed_json_args",
   [text_round("<tool_call>\n<function=filesystem__write>\n"
               "<parameter=path>\n_build/x.html\n</parameter>\n"
               "<parameter=content>\n<html>unterminated\n</parameter>\n"
               "</function>\n</tool_call>"),
    text_round("已完成。")],
   expect=lambda h, ev, st, check, n: check(f"[{n}] malformed arg kept & call ran",
            st.executor.calls and st.executor.calls[0][0] == "filesystem__write",
            st.executor.calls))


# FM2 class: a tool raises -> failure result, turn survives, ends with [DONE].
_s("tool_raise_survives",
   [tool_round(cid="c1"),
    tool_round(cid="c2", name="shell__exec", args={"command": "boom"}),
    text_round("已完成。")],
   behavior={"raise_on": (2,)},
   expect=lambda h, ev, st, check, n: check(f"[{n}] turn kept working after a tool crash",
            len(st.executor.calls) == 2 and ev[-1] == "[DONE]", (st.executor.calls, ev[-1:])))


# FM2 class: a tool returns an error string -> captured, turn continues.
_s("tool_error_continues",
   [tool_round(cid="c1"),
    tool_round(cid="c2", name="shell__exec", args={"command": "boom"}),
    text_round("已完成。")],
   behavior={"error_on": (2,)},
   expect=lambda h, ev, st, check, n: check(f"[{n}] error returned, not thrown",
            ev[-1] == "[DONE]", ev[-1:]))


# FM1 class: narration -> nudge -> continue (the model's promise is honoured).
_s("narration_nudge_continue",
   [tool_round(cid="c1"),
    text_round("目录为空、Node v24 可用。开始分块构建。"),
    tool_round(cid="c2", name="shell__exec", args={"command": "build"}),
    text_round("已完成。")],
   expect=lambda h, ev, st, check, n: check(f"[{n}] promised call eventually ran",
            len(st.executor.calls) == 2, st.executor.calls))


# FM1 class: repeated narration is capped (no infinite loop).
_s("repeated_narration_capped",
   [tool_round(cid="c1"),
    text_round("接下来写第二个文件。"),
    text_round("接下来写第三个文件。"),
    text_round("接下来写第四个文件。"),
    text_round("接下来写第五个文件。")],
   expect=lambda h, ev, st, check, n: check(f"[{n}] did not spin to max_rounds",
            ev[-1] == "[DONE]" and h._round <= 4, (ev[-1:], h._round)))


# A round that hit the output budget but produced nothing must not silently end.
_s("mid_length_finish",
   [text_round("", finish="length"), text_round("已完成。")],
   expect=lambda h, ev, st, check, n: check(f"[{n}] length finish continues",
            ev[-1] == "[DONE]", ev[-1:]))


# The leftover-bug regression: leaked call markup (a call written as text in FM4, or
# orphan closers after a structured call) must NEVER reach the user-facing SSE stream as
# visible XML. The call is still recovered and executed; only the user's visible text is
# cleaned. (2026-10-20: previously the raw `</function></tool_call>` sat in the chat.)
_s("visible_stream_clean",
   [xml_call_round(),                                   # FM4: whole call as text -> recovered
    text_round("写好了。\n</function>\n</tool_call>"),      # orphan closers -> stripped
    tool_round(cid="c2", name="shell__exec", args={"command": "ls"}),
    text_round("已完成。")],
   expect=lambda h, ev, st, check, n: (
       check(f"[{n}] user-visible stream has NO call markup",
             not visible_has_markup(ev), visible_content(ev))
       and check(f"[{n}] leaked text call still executed",
                 bool(st.executor.calls)
                 and st.executor.calls[0][0] == "filesystem__write", st.executor.calls)
       and check(f"[{n}] no markup in history next round",
                 not history_has_markup(h, 1), h.seen[1])))


# ── user-reported bug capture bridge ─────────────────────────────────────────────
# tools/capture_scenario.py writes entries to tests/user_scenarios.json; each becomes a
# permanent regression that runs in test_adversarial_llm.py on every commit. This is the
# "report one bug -> gain one regression" path that narrows the coverage ceiling cheaply.
# A reported bug is replayed through the REAL loop and asserted against the same invariants
# (always ends with [DONE]; for `xml` kind, no call markup reaches the user-visible stream).
def _load_user_scenarios(path=None):
    if path is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "user_scenarios.json")
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    out = []
    for e in data:
        if not isinstance(e, dict):
            continue
        kind = e.get("kind", "work")
        content = e.get("content", "") or ""
        name = "user_" + str(e.get("name", "scenario"))

        def expect_factory(k):
            def expect(h, ev, st, check, n):
                if k == "xml":
                    return (check(f"[{n}] user-{k} ends with [DONE]", ev[-1] == "[DONE]", ev[-1:])
                            and check(f"[{n}] user-{k} visible stream has no call markup",
                                      not visible_has_markup(ev), visible_content(ev)[:160]))
                return check(f"[{n}] user-{k} ends with [DONE]", ev[-1] == "[DONE]", ev[-1:])
            return expect
        _expect = expect_factory(kind)

        if kind == "xml":
            seq = [xml_call_round() if not content
                   else text_round(content, finish="stop")]
        elif kind == "narration":
            seq = [text_round(content)] if content else [text_round("接下来开始构建。")]
        elif kind == "length":
            seq = ([text_round(content, finish="length"), text_round("已完成。")] if content
                   else [text_round("", finish="length"), text_round("已完成。")])
        elif kind == "empty":
            seq = [text_round(content)] if content else [text_round("")]
        else:  # work
            seq = [text_round(content)] if content else [text_round("已完成。")]
        out.append((name, seq, _expect, e.get("desc", "")))
    return out


# Register every captured user scenario into the same per-commit gate, so a reported bug
# becomes a permanent regression without touching Python.
for _name, _seq, _expect, _desc in _load_user_scenarios():
    _s(_name, _seq, expect=_expect)
