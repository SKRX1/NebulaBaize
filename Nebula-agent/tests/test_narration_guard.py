# -*- coding: utf-8 -*-
"""Narration guard + text-form tool-call rescue.

Field report (2026-10-20 06:02, session 854c3f9c, round 3, 2m14s): the turn ended by itself
while the model was mid-task. The screenshot showed a one-line answer -- "目录为空、Node v24
可用。开始分块构建。" -- with `</function></tool_call>` sitting in the message text above it,
and the composer came back enabled. `logs/turn.jsonl` recorded `ending=done`, so nothing had
crashed and no notice was raised: from the client's side the turn had *answered*.

Two mechanisms produce that, and neither had any defence in the gateway:

  1. The engine template uses Qwen's XML call syntax. When the engine's streaming parser
     loses a call (or the model repeats the closers so the call closes early), the markup is
     streamed as ordinary TEXT. `tool_calls` then arrives empty, the text is non-empty, and
     `if not calls: break` reads "has text" as "has answered" -- the turn ends with the work
     not started. The gateway had no XML parsing at all (zero matches), so such a call was
     silently dropped.
  2. The model genuinely answers with its own plan ("开始…", "接下来…") and emits EOS without
     calling anything. Again: text, no calls, turn over.

This pins the fix:
  * a call written as text is recovered and executed (and stripped from the history copy),
  * a narration-only round is answered with a [system] nudge and the loop CONTINUES,
  * the nudge is capped, so a chatty model cannot loop forever,
  * a real completion ("已完成…") is never mistaken for narration,
  * every round leaves a line in logs/rounds.jsonl -- the evidence that was missing.

Pure standard library: no network, no model, no MCP child.
"""
import io
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from http_server import (GatewayHandler, GatewayState,   # noqa: E402
                         looks_like_narration, text_tool_calls)

DIAG_DIR = tempfile.mkdtemp(prefix="narr-guard-")
os.environ["STRATA_ROUND_DIAG_DIR"] = DIAG_DIR
os.environ["STRATA_TURN_DIAG_DIR"] = DIAG_DIR

OK = []


def check(name, cond, extra=""):
    if not cond:
        raise AssertionError(f"FAIL: {name} {extra}")
    OK.append(name)
    print(f"  ok  {name}")


# ── fake executor ──────────────────────────────────────────────────────────────────────
class Executor:
    tools = [
        {"name": "filesystem__write", "description": "write a file",
         "input_schema": {"type": "object"}},
        {"name": "shell__exec", "description": "run a command",
         "input_schema": {"type": "object"}},
    ]

    def __init__(self):
        self.calls = []

    def reset_cum(self):
        pass

    def call(self, name, args, on_progress=None, cancel=None):
        self.calls.append((name, args))
        return f"wrote {args.get('path', '?')}" if name == "filesystem__write" else "ok"


class FakeHandler:
    def __init__(self, state, sequences, session="s-narr"):
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
        pass

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


def text_round(text, reasoning=""):
    out = []
    if reasoning:
        out.append({"choices": [{"delta": {"reasoning_content": reasoning}}]})
    out += [{"choices": [{"delta": {"content": text}}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}]}]
    return out


def xml_call_round():
    """A call the engine failed to parse: it arrives as plain answer text."""
    text = ("这就是头部文件。\n<tool_call>\n<function=filesystem__write>\n"
            "<parameter=path>\n_build/00_head.html\n</parameter>\n"
            "<parameter=content>\n<html><head></head></html>\n</parameter>\n"
            "</function>\n</tool_call>\n")
    return text_round(text)


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


def run(state, sequences, session="s-narr"):
    h = FakeHandler(state, sequences, session)
    GatewayHandler._agent_stream(h, body=h.body)      # must never raise
    return h, parse(h)


def tool_results(events):
    out = []
    for e in events:
        ev = e.get("strata_mcp") if isinstance(e, dict) else None
        if ev and ev.get("event") == "result":
            out.append(ev)
    return out


def notices(events):
    return [e["strata_notice"] for e in events
            if isinstance(e, dict) and e.get("strata_notice")]


def round_lines(session):
    path = os.path.join(DIAG_DIR, "rounds.jsonl")
    if not os.path.exists(path):
        return []
    lines = [json.loads(x) for x in
             io.open(path, encoding="utf-8").read().strip().splitlines() if x.strip()]
    return [x for x in lines if x.get("session") == session]


def fresh_state():
    st = GatewayState(upstream_url="http://127.0.0.1:8080", model="strata")
    st.direct_mode = True
    st.api_key = None
    st.max_rounds = 8
    st.executor = Executor()
    return st


KNOWN = {"filesystem__write", "shell__exec"}


def main() -> int:
    try:
        # ── 1) the parser: XML text -> a real call ────────────────────────────────
        print("\n=== 1: a call written as text is recovered ===")
        text = ("好的。\n<tool_call>\n<function=filesystem__write>\n<parameter=path>\n"
                "_build/a.html\n</parameter>\n<parameter=bytes>\n3\n</parameter>\n"
                "</function>\n</tool_call>")
        calls, cleaned = text_tool_calls(text, KNOWN)
        check("one call recovered", len(calls) == 1, calls)
        check("it names the tool", calls[0]["function"]["name"] == "filesystem__write", calls)
        args = json.loads(calls[0]["function"]["arguments"])
        check("arguments keep the value", args.get("path") == "_build/a.html", args)
        check("a bare number is JSON-decoded", args.get("bytes") == 3, args)
        check("the markup is gone from the text", "<function=" not in cleaned and
              "<tool_call" not in cleaned, cleaned)
        check("the prose around it survives", cleaned.strip() == "好的。", repr(cleaned))

        # ── 2) an unknown name is prose, not a call ──────────────────────────────
        print("\n=== 2: prose that merely mentions the format is not executed ===")
        doc = "调用格式是 <function=example_function_name> ... </function> 这样。"
        calls2, cleaned2 = text_tool_calls(doc, KNOWN)
        check("nothing is executed", calls2 == [], calls2)
        check("the text is untouched", cleaned2 == doc, cleaned2)

        # ── 3) an orphan closer (the exact leftover seen in the screenshot) ──────
        print("\n=== 3: an orphan closer is cleaned, not left in the answer ===")
        orphan = "写好了。\n</function>\n</tool_call>"
        calls3, cleaned3 = text_tool_calls(orphan, KNOWN)
        check("no call invented", calls3 == [], calls3)
        check("no stray tag left", "</function>" not in cleaned3 and
              "</tool_call>" not in cleaned3, cleaned3)
        check("the sentence survives", "写好了。" in cleaned3, cleaned3)

        # ── 4) plain text is passed through untouched ─────────────────────────────
        print("\n=== 4: ordinary text costs nothing ===")
        c4, t4 = text_tool_calls("全部完成。", KNOWN)
        check("no calls", c4 == [], c4)
        check("identical text", t4 == "全部完成。", t4)

        # ── 5) the narration shape ────────────────────────────────────────────────
        print("\n=== 5: only a promise of work counts as narration ===")
        check("the reported sentence is narration",
              looks_like_narration("目录为空、Node v24 可用。开始分块构建。") is True)
        check("a completion is NOT narration",
              looks_like_narration("已完成全部文件的写入，构建通过。") is False)
        check("advice to the user is NOT narration",
              looks_like_narration("接下来你可以运行 npm start 预览效果。") is False)
        check("a question is NOT narration",
              looks_like_narration("现在需要我继续写 JS 吗？") is False)
        check("a long answer is NOT narration",
              looks_like_narration("开始" + "详细说明。" * 120) is False)
        check("empty text is not narration", looks_like_narration("") is False)

        # ── 6) a narration-only round no longer ends the turn ─────────────────────
        print("\n=== 6: narration -> nudge -> the turn keeps working ===")
        st = fresh_state()
        h, ev = run(st, [
            tool_round(),                                     # 1: real work
            text_round("目录为空、Node v24 可用。开始分块构建。"),  # 2: just an announcement
            tool_round(cid="call_2", args={"path": "_build/01_game.js", "content": "x"}),
            text_round("已完成全部构建。"),                       # 4: a real finish
        ], "s-continue")
        check("the turn stayed alive and ran the promised call",
              len(st.executor.calls) == 2, st.executor.calls)
        check("it wrote the file it promised",
              st.executor.calls[1][1].get("path") == "_build/01_game.js", st.executor.calls)
        check("the stream ended with [DONE]", ev[-1] == "[DONE]", ev[-1:])
        check("no notice was raised", not notices(ev), notices(ev))
        nudge = [m for m in h.seen[2] if m.get("role") == "user"
                 and "[system]" in str(m.get("content"))]
        check("the model was told to act, not describe", len(nudge) == 1, h.seen[2])
        check("the nudge is adjacent (user role, after the answer)",
              h.seen[2][-1]["role"] == "user" and "[system]" in h.seen[2][-1]["content"],
              h.seen[2][-1])
        check("what the model said is kept in history",
              any("开始分块构建" in str(m.get("content")) for m in h.seen[2]), h.seen[2])

        # ── 7) the nudge is capped ────────────────────────────────────────────────
        print("\n=== 7: a model that only narrates cannot loop forever ===")
        st = fresh_state()
        _h7, ev7 = run(st, [
            tool_round(),
            text_round("接下来开始写第二个文件。"),
            text_round("接下来开始写第三个文件。"),
            text_round("接下来开始写第四个文件。"),
            text_round("接下来开始写第五个文件。"),
        ], "s-cap")
        check("at most two nudges were sent", _h7._round <= 4, _h7._round)
        check("it still terminated", ev7[-1] == "[DONE]", ev7[-1:])
        check("the loop did not spin to max_rounds", _h7._round < 8, _h7._round)

        # ── 8) a text-form call is executed, not swallowed ────────────────────────
        print("\n=== 8: the leaked XML call really runs the tool ===")
        st = fresh_state()
        h8, ev8 = run(st, [xml_call_round(), text_round("已完成。")], "s-rescue")
        check("the tool ran", [c[0] for c in st.executor.calls] == ["filesystem__write"],
              st.executor.calls)
        check("with the arguments parsed out of the text",
              st.executor.calls[0][1].get("path") == "_build/00_head.html", st.executor.calls)
        tr = tool_results(ev8)
        check("the UI got a tool result card", len(tr) == 1 and tr[0].get("ok") is True, tr)
        check("the turn ended normally", ev8[-1] == "[DONE]", ev8[-1:])
        second = json.dumps(h8.seen[1], ensure_ascii=False)
        check("history carries no call markup", "<function=" not in second, second[:400])

        # ── 9) every round leaves evidence ───────────────────────────────────────
        print("\n=== 9: logs/rounds.jsonl records each round ===")
        path = os.path.join(DIAG_DIR, "rounds.jsonl")
        check("the round log exists", os.path.exists(path), path)
        lines = round_lines("s-rescue")
        check("one line per round", len(lines) == 2, lines)
        check("it records the finish reason", lines[0].get("finish") == "stop", lines[0])
        check("it records the rescued call", lines[0].get("rescued") == ["filesystem__write"],
              lines[0])
        check("it flags markup that arrived as text",
              lines[0].get("call_markup_in_text") is True, lines[0])
        check("it records the executed calls",
              lines[1].get("calls") == [] and lines[0].get("calls") == ["filesystem__write"],
              [x.get("calls") for x in lines])
        cont = round_lines("s-continue")
        check("the narration round is flagged", any(x.get("narration") for x in cont), cont)
        check("the tail of the answer is kept for forensics",
              any("开始分块构建" in str(x.get("content_tail")) for x in cont), cont)

        print(f"\nNARRATION-GUARD: {len(OK)} checks passed")
        return 0
    finally:
        shutil.rmtree(DIAG_DIR, ignore_errors=True)
        os.environ.pop("STRATA_ROUND_DIAG_DIR", None)
        os.environ.pop("STRATA_TURN_DIAG_DIR", None)


if __name__ == "__main__":
    sys.exit(main())
