# -*- coding: utf-8 -*-
"""Wire-boundary guard: content=None in a tool-call assistant turn.

Regression for the upstream 400
  'messages[i].content must be a string or an array of content parts'
strict OpenAI-compatible servers return when the gateway replays a
tool-call-only assistant turn (both loops store it with content: None, which
the OpenAI spec allows but llama.cpp-style servers reject). Once such a turn
is in a conversation's history, EVERY later send 400s -- the user sees
"model suddenly unusable".

Locks (all against the REAL shipped normalize_wire_messages):
  R1 a None-content assistant+tool_calls message becomes "" and keeps its tool_calls
  R2 a clean list returns the SAME object (identity, prompt-cache discipline)
  R3 list / string / dict contents are never rewritten
  R4 a None-content tool message is also normalized (same validator class)
  R5 load-bearing differential: a strict-upstream validator ACCEPTS the
     normalized list and REJECTS the untouched original (fix is required)
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "runtime"))
from llm_client import normalize_wire_messages  # noqa: E402


def strict_upstream_http_error(messages):
    """Mirror the validator that produced the user's 400: every message's
    content must be a string or a list of parts. Returns None when the body
    would be accepted, the error text otherwise."""
    for i, m in enumerate(messages):
        c = m.get("content")
        if not isinstance(c, (str, list)):
            return 'HTTP 400 Bad Request {"error": {"type": "invalid_request_error", '\
                   '"message": "messages[%d].content must be a string or an array of content parts"}}' % i
    return None


def main():
    hist = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "read it"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c1", "type": "function",
             "function": {"name": "filesystem__read", "arguments": '{"path":"a"}'}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "file body"},
        {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c2", "type": "function",
             "function": {"name": "shell__exec", "arguments": '{"command":"dir"}'}}]},
        {"role": "tool", "tool_call_id": "c2", "content": None},   # R4: tool msg None too
        {"role": "assistant", "content": "parts keep"},            # plain text untouched
    ]
    parts_msg = {"role": "user", "content": [{"type": "text", "text": "hi"},
                                             {"type": "image_url", "image_url": {"url": "data:..."}}]}
    hist.append(parts_msg)

    # R5 control side first: the untouched history is what the 400 was about.
    if strict_upstream_http_error(hist) is None:
        print("R5 FAIL: strict validator accepted the untouched list (differential not load-bearing)")
        return 1
    out = normalize_wire_messages(hist)
    # R5 fix side: normalized list passes the same validator.
    err = strict_upstream_http_error(out)
    if err is not None:
        print("R5 FAIL: strict validator still rejects the normalized list: %s" % err)
        return 1

    # R1: None -> "" and tool_calls survive.
    a = out[2]
    if a.get("content") != "" or not a.get("tool_calls"):
        print("R1 FAIL: assistant None content not normalized / tool_calls lost: %s" % json.dumps(a)[:200])
        return 1

    # R2: identity for a clean list (cache discipline).
    clean = [dict(x) for x in out if x.get("content") is not None]
    if normalize_wire_messages(clean) is not clean:
        print("R2 FAIL: clean list returned a copy (identity broken)")
        return 1

    # R3: string/list contents byte-equal.
    if out[0] is not hist[0] or out[-1] is not parts_msg:
        print("R3 FAIL: a clean message object was replaced instead of passed through")
        return 1

    # R4: tool-role None normalized too.
    if out[5].get("content") != "" or "tool_call_id" not in out[5]:
        print("R4 FAIL: tool message None not normalized")
        return 1

    # original history untouched (we copy, never mutate)
    if hist[2].get("content") is not None or hist[5].get("content") is not None:
        print("R6 FAIL: normalize mutated the original history")
        return 1

    print("ALL OK: content=None is fixed at the wire boundary, strict-upstream differential is load-bearing")
    return 0


if __name__ == "__main__":
    sys.exit(main())
