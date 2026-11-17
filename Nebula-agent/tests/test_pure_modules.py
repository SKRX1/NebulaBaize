"""Unit tests for the four pure modules split out of server.py (refactor plan-B, 2026-11-17):

  serve/wire_codec  - openai_collect / anthropic_collect stream reassembly
  serve/net_gate    - host / origin / api-key admission gate
  serve/req_args    - request / config sampling-parameter sanitization
  serve/req_stats   - per-request token / timing accounting

These are PURE functions (no engine / session / I/O state), so each behaviour can be
locked with a direct call + a load-bearing differential (the branch that MUST be taken).
The whole point of the extraction was to make this behaviour testable without importing
the engine stack -- this file is that proof.  Pure stdlib, deterministic.  Imports the
real modules via `from serve.<x> import ...` (the same path server.py uses).
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from serve import wire_codec as WC        # noqa: E402
from serve import net_gate as NG          # noqa: E402
from serve import req_args as RA          # noqa: E402
from serve import req_stats as RS         # noqa: E402


# ---------------------------------------------------------------- wire_codec ----
def _oc_chunk(text=None, finish=None, tool=None, mid=0, rcontent=None):
    delta = {}
    if text is not None:
        delta["content"] = text
    if rcontent is not None:
        delta["reasoning_content"] = rcontent
    if tool is not None:
        delta["tool_calls"] = tool
    return {"id": "id1", "object": "chat.completion.chunk", "created": 1, "model": "m",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            "usage": {"total_tokens": 1}}


def test_wire_openai_text_and_reasoning():
    r = WC.openai_collect([_oc_chunk(rcontent="think "), _oc_chunk(text="hello"), _oc_chunk(text=" world", finish="stop")])
    msg = r["choices"][0]["message"]
    assert msg["content"] == "hello world", msg
    assert msg["reasoning_content"] == "think ", msg
    assert r["choices"][0]["finish_reason"] == "stop", r
    print("WIRE openai text+reasoning: content=%r reasoning=%r" % (msg["content"], msg["reasoning_content"]))


def test_wire_openai_tool_merge_and_bad_json_dropped():
    # one streamed tool call, split across pieces, MERGED by index
    a = _oc_chunk(tool=[{"index": 0, "id": "c1", "function": {"name": "do", "arguments": "{\"a\""}}], finish=None)
    b = _oc_chunk(tool=[{"index": 0, "function": {"arguments": ":1}"}}], finish=None)
    done = _oc_chunk(finish="tool_calls")            # ended on a tool call: keep even-partial args
    r = WC.openai_collect([a, b, done])
    calls = r["choices"][0]["message"]["tool_calls"]
    assert len(calls) == 1 and calls[0]["id"] == "c1", calls
    assert calls[0]["function"]["name"] == "do", calls
    assert calls[0]["function"]["arguments"] == '{"a":1}', calls
    print("WIRE openai tool merge: 1 call args=%s" % calls[0]["function"]["arguments"])

    # LOAD-BEARING differential: finish != tool_calls -> an unfinished (non-JSON) call is DROPPED
    half = _oc_chunk(tool=[{"index": 0, "id": "c2", "function": {"name": "do", "arguments": "{\"a\""}}], finish="stop")
    r2 = WC.openai_collect([half, _oc_chunk(finish="stop")])
    assert "tool_calls" not in r2["choices"][0]["message"], r2["choices"][0]["message"]
    print("WIRE openai bad-json drop: finish=stop -> tool_calls absent (differential)")


def test_wire_openai_heartbeat_and_mcp_passthrough():
    mcp = {"name": "srv", "result": "x"}
    c = _oc_chunk(text="ok", finish="stop")
    c["strata_mcp"] = mcp
    r = WC.openai_collect([None, c])              # None heartbeat is skipped, must not crash
    assert r["choices"][0]["message"]["content"] == "ok", r
    assert r["choices"][0]["message"]["strata_mcp"] == [mcp], r
    print("WIRE openai heartbeat+mcp: content ok, mcp=%d" % len(r["choices"][0]["message"]["strata_mcp"]))


def test_wire_anthropic_text_and_tool():
    events = [
        ("message_start", {"type": "message_start", "message": {"id": "1", "role": "assistant", "content": [], "usage": {"input_tokens": 5}}}),
        ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "hi"}}),
        ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": " there"}}),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        ("content_block_start", {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "name": "tool", "id": "t1", "input": {}}}),
        ("content_block_delta", {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"x\""}}),
        ("content_block_delta", {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": ":9}"}}),
        ("content_block_stop", {"type": "content_block_stop", "index": 1}),
        ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 3}}),
    ]
    m = WC.anthropic_collect(events)
    assert m["content"][0]["text"] == "hi there", m["content"]
    assert m["content"][1]["input"] == {"x": 9}, m["content"][1]      # split json reassembled
    assert m["stop_reason"] == "tool_use" and m["usage"] == {"input_tokens": 5, "output_tokens": 3}, m
    print("WIRE anthropic: text=%r tool.input=%s stop=%s" % (m["content"][0]["text"], m["content"][1]["input"], m["stop_reason"]))


def test_wire_anthropic_thinking_and_truncated_tool_dropped():
    events = [
        ("message_start", {"type": "message_start", "message": {"id": "2", "role": "assistant", "content": [], "usage": {"input_tokens": 1}}}),
        ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}),
        ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "hmm"}}),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        # a tool whose output ended mid-arguments (#211): no valid json -> the block is dropped
        ("content_block_start", {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "name": "t", "id": "x", "input": {}}}),
        ("content_block_delta", {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": "{\"a\""}}),
        ("content_block_stop", {"type": "content_block_stop", "index": 1}),
        ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "max_tokens", "stop_sequence": None}, "usage": {"output_tokens": 1}}),
    ]
    m = WC.anthropic_collect(events)
    assert m["content"][0]["thinking"] == "hmm", m["content"]
    assert len(m["content"]) == 1, ("truncated tool block must be dropped", m["content"])
    print("WIRE anthropic: thinking ok, truncated tool dropped, blocks=%d" % len(m["content"]))


# ------------------------------------------------------------------ net_gate ----
def test_net_host_allowed():
    names = {"example.com"}
    assert NG.host_allowed("localhost", names) is True
    assert NG.host_allowed("sub.localhost:8080", names) is True
    assert NG.host_allowed("127.0.0.1:8099", names) is True           # an IP passes
    assert NG.host_allowed("", names) is True                          # no Host header passes
    assert NG.host_allowed("1.2.3.4", names, any_host=True) is True
    assert NG.host_allowed("attacker.example", names) is False         # foreign name fails
    assert NG.host_allowed("example.com", names) is True               # listed name passes
    print("NET host_allowed: local/ip/empty/any=True, foreign=False, listed=True")


def test_net_origin_and_key_and_host_name():
    assert NG.origin_allowed("http://localhost:8099", "localhost:8099", set()) is True   # same Host passes
    assert NG.origin_allowed("https://a.example", "host", set(), ("https://a.example",)) is True
    assert NG.origin_allowed("null", "host", {"x"}) is False
    assert NG.origin_allowed("https://evil.example", "host", set()) is False
    print("NET origin_allowed: same-host+trusted=True, null+foreign=False")

    assert NG.key_matches("secret", "secret") is True
    assert NG.key_matches("wrong", "secret") is False
    assert NG.key_matches("päss", "päss") is True         # non-ascii passes via utf-8/latin-1
    assert NG.key_matches("a", ["x", "a"]) is True          # #1344: several keys, matches any
    assert NG.key_list("k1, k2") == ["k1", "k2"], NG.key_list("k1, k2")
    print("NET key_matches/list: ascii+nonascii+multi pass, wrong fails")

    assert NG.host_name("Example.com:8080") == "example.com"
    assert NG.host_name("[::1]:8095") == "::1"
    assert NG.host_name("bad:port") == ""
    assert NG.host_name("::1") == "::1"                   # bare ipv6 config entry
    assert NG.host_name("") == ""
    # allowed_hosts_of accepts bare names and a leading-dot root domain (".example.com"),
    # NOT a glob: a "*" inside an entry is the bug the parser must reject.
    assert sorted(NG.allowed_hosts_of(["Example.com", ".x.example"], "")) == [".x.example", "example.com"]
    assert NG.allowed_hosts_of(["*"], "") == ["*"]
    try:
        NG.allowed_hosts_of("*.x.example", "")            # glob form is rejected (no "*" in a real host)
        raise AssertionError("expected ValueError")
    except ValueError:
        pass
    try:
        NG.allowed_hosts_of("ex ample", "")               # space is not a host name
        raise AssertionError("expected ValueError")
    except ValueError:
        pass
    print("NET host_name/allowed_hosts_of: bare+dot-root ok, glob+space raise ValueError")


# ------------------------------------------------------------------ req_args ----
def test_req_clean_shared_defaults():
    # correct-typed input: /settings keeps only known keys; temperature/top_p come back
    # as float (the float(value) cast), ints stay int, unknown keys / wrong types raise.
    d = RA.clean_shared_defaults({"temperature": 0.5, "top_k": 7, "max_tokens": 100, "reasoning_effort": "low"})
    assert d["temperature"] == 0.5 and isinstance(d["temperature"], float), d
    assert d["top_k"] == 7 and isinstance(d["top_k"], int), d
    assert d["max_tokens"] == 100 and d["reasoning_effort"] == "low", d
    # LOAD-BEARING: unlike check_request_sampling, /settings does NOT accept numeric
    # STRINGS -- a string value is rejected here (this is the path/route difference).
    for bad in ({"temperature": "hot"}, {"top_p": 5}, {"top_k": 0}, {"top_k": "7"},
                {"unknown_key": 1}, {"reasoning_effort": "x"}, {"seed": 0}):
        try:
            RA.clean_shared_defaults(bad)
            raise AssertionError("expected ValueError for %s" % bad)
        except ValueError:
            pass
    assert RA.clean_shared_defaults(None) == {}
    print("REQ clean_shared_defaults: float-cast ok, 7 bad inputs (incl numeric-string) raise, None->{}")


def test_req_check_request_sampling():
    req = {"temperature": "0.7"}
    RA.check_request_sampling(req)
    assert req["temperature"] == 0.7 and isinstance(req["temperature"], float), req   # numeric string coerced
    for bad in ({"temperature": "hot"}, {"top_k": True}, {"seed": 1.5}):
        r2 = dict(bad)
        try:
            RA.check_request_sampling(r2)
            raise AssertionError("expected ValueError for %s" % bad)
        except ValueError:
            pass
    RA.check_request_sampling({"temperature": None})           # absent/null not checked
    print("REQ check_request_sampling: numeric-string coerced, 3 bad types raise, null ok")


def test_req_lift_reasoning_effort():
    cfg = {"args": ["-ngl", "99", "--reasoning-effort", "high", "--other"]}
    RA.lift_reasoning_effort_arg(cfg)
    assert cfg["reasoning_effort"] == "high", cfg
    assert "--reasoning-effort" not in cfg["args"] and "high" not in cfg["args"], cfg
    assert "--other" in cfg["args"] and "-ngl" in cfg["args"], cfg       # unrelated flags preserved
    cfg2 = {"args": ["--reasoning-effort=low"]}
    RA.lift_reasoning_effort_arg(cfg2)
    assert cfg2["reasoning_effort"] == "low" and cfg2["args"] == [], cfg2
    print("REQ lift_reasoning_effort_arg: flag->cfg key, removed from args, others preserved")


# ------------------------------------------------------------------ req_stats ----
def test_stats_request_timings_and_seen():
    assert RS.request_timings(100, 0, {}) is None                       # engine with no clock
    r = RS.request_timings(100, 50, {"prompt_ms": 1000.0, "decode_ms": 2000.0, "reused": 20, "generated": 40})
    assert r["cache_n"] == 20 and r["prompt_n"] == 80, r               # prompt_n = read - cached
    assert r["prompt_per_second"] == 80.0, r                            # 80 tok / (1000ms/1000)
    assert r["predicted_per_second"] == 20.0, r                         # 40 tok / 2s
    assert "draft_n" not in r, r                                        # no draft when not reported
    print("STATS request_timings: cache/prompt/rates correct, draft absent when unreported")

    assert RS.prompt_tokens_seen(100, {}) == 100
    assert RS.prompt_tokens_seen(100, {"prompt_read": 30, "finish": "cancel", "reused": 10}) == 40   # #471 cancel
    print("STATS prompt_tokens_seen: full when no-cancel, partial on cancel")


def test_stats_carry_and_agg():
    carry = {}
    RS.carry_leg(carry, {"decode_ms": 100.0, "generated": 5, "prompt_ms": 50.0})
    RS.carry_leg(carry, {"decode_ms": 100.0, "generated": 5, "prompt_ms": 50.0})   # sums decode/gen across legs
    assert carry["decode_ms"] == 200.0 and carry["generated"] == 10, carry
    assert carry["prompt_ms"] == 50.0, carry                              # setdefault: first leg wins
    out = RS.add_carry({"decode_ms": 100.0, "generated": 5}, {"decode_ms": 50.0, "generated": 2, "prompt_ms": 10.0})
    assert out["decode_ms"] == 150.0 and out["generated"] == 7, out
    assert out["prompt_ms"] == 10.0, out                                  # max: the leg that read the prompt
    print("STATS carry_leg/add_carry: sums decode+gen, prompt = max/first-leg")

    seg = [{"reused": 7, "prompt_read": 3, "generated": 10, "decode_ms": 1.0}, {"generated": 5, "decode_ms": 2.0}]
    agg = RS.request_stats(seg)
    assert agg["reused"] == 7 and agg["prompt_read"] == 3, agg          # boundary kept from first segment
    assert agg["generated"] == 15 and agg["decode_ms"] == 3.0, agg      # native work summed across segments
    assert RS.request_stats([]) == {}, "empty -> {}"
    print("STATS request_stats: reused/prompt_read from first, generated/decode summed")


def main():
    test_wire_openai_text_and_reasoning()
    test_wire_openai_tool_merge_and_bad_json_dropped()
    test_wire_openai_heartbeat_and_mcp_passthrough()
    test_wire_anthropic_text_and_tool()
    test_wire_anthropic_thinking_and_truncated_tool_dropped()
    test_net_host_allowed()
    test_net_origin_and_key_and_host_name()
    test_req_clean_shared_defaults()
    test_req_check_request_sampling()
    test_req_lift_reasoning_effort()
    test_stats_request_timings_and_seen()
    test_stats_carry_and_agg()
    print("PURE-MODULES TEST PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
