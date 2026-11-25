"""Unit tests for the sixteen pure modules split out of server.py (refactor plan-B, 2026-11-17):

  serve/wire_codec    - openai_collect / anthropic_collect stream reassembly
  serve/net_gate      - host / origin / api-key admission gate
  serve/req_args      - request / config sampling-parameter sanitization
  serve/req_stats     - per-request token / timing accounting
  serve/ram_guard     - RAM-budget start-up warnings (arena_mib / --resident-budget-gib)
  serve/gpu_score     - per-card NVIDIA/AMD capability scores (the selection layer)
  serve/boot_diagnose - human-readable start-up failure diagnostics
  serve/path_locate   - resolve a configured/user input to the real usable path
  serve/gpu_config    - the config's GPU list / whether naming several is a split
  serve/env_probe     - is a dir writable / is this a Linux desktop session
  serve/engine_stall  - the frozen-engine watchdog predicate + its two thresholds
  serve/tokenizer     - byte tokenizer stand-in / Detokenizer / stop_strings / StopMatcher
  serve/approval      - tool-approval policy: registry-mutation set + destructive-shell deny + desc
  serve/conv_cache    - engine conversation-cache log reader + the Monitor cache-card view
  serve/engine_diag   - engine exit-status words / crash predicate / draft-head hint / GPU-runtime marks
  serve/exceptions    - the engine / session exception hierarchy (inheritance + status/retry_after)

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
from serve import ram_guard as RG           # noqa: E402
from serve import gpu_score as GS           # noqa: E402
from serve import boot_diagnose as BD       # noqa: E402
from serve import path_locate as PL         # noqa: E402
from serve import gpu_config as GC          # noqa: E402
from serve import env_probe as EP           # noqa: E402
from serve import engine_stall as ES         # noqa: E402
from serve import tokenizer as TK            # noqa: E402
from serve import approval as AP             # noqa: E402
from serve import conv_cache as CV           # noqa: E402
from serve import engine_diag as ED          # noqa: E402
from serve import exceptions as EX           # noqa: E402


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


def test_net_api_key_of_and_origins_of():
    # api_key_of (#725/#213/#1344): the value a config/env holds, as a client can send it.
    # A header strips surrounding spaces+newlines, so a key stored with them (a CRLF env file,
    # a quoted " key ") would match no request -> 401 with the RIGHT key. The fix is the
    # .strip(); these lock that, and that a value that is ONLY such characters raises (it
    # never means "no key"). A list stays a list (each key stripped), matching key_list.
    assert NG.api_key_of(None) == ""                            # absent -> "" (no key)
    assert NG.api_key_of(" secret ") == "secret"               # header-trim parity: spaces gone
    assert NG.api_key_of("secret\r\n") == "secret"              # a CRLF config/env value
    assert NG.api_key_of('  " key "  ') == '" key "'          # outer spaces stripped; inner+quotes KEPT
    assert NG.api_key_of(["a", " b "]) == ["a", "b"]           # a config list, each stripped
    for only_noise in (",", " ", "\t", ", ,"):                # a value that is ONLY separators/space
        try:
            NG.api_key_of(only_noise); raise AssertionError("expected ValueError for %r" % only_noise)
        except ValueError:
            pass
    for empty_list in ([""], ["a", ""], []):                  # any empty element (or none) -> reject
        try:
            NG.api_key_of(empty_list); raise AssertionError("expected ValueError for %r" % empty_list)
        except ValueError:
            pass
    print("NET api_key_of: trim/CRLF/quotes-ok, list-stripped, all-noise/empty-list raise")

    # origins_of (#321): a config's origin list -- scheme://host[:port], no path; "*" only
    # where wildcard allows. A wrong entry stops the start (SystemExit) rather than opening
    # more or less than the operator meant.
    assert NG.origins_of(None, "cors_origins", True) == []           # unset -> nothing added
    assert NG.origins_of("", "cors_origins", True) == []
    assert NG.origins_of([], "cors_origins", True) == []
    assert NG.origins_of("https://a.example", "k", False) == ["https://a.example"]   # a bare string wraps
    assert NG.origins_of(["https://a.example", "https://b.example/"], "k", False) == \
        ["https://a.example", "https://b.example"]                   # trailing slash stripped
    assert NG.origins_of(["*"], "cors_origins", True) == ["*"]      # wildcard where allowed
    for bad in (["*"], ["chat.example.com"], ["http://a/b"], ["https://a/b/c"], ["ftp://a"],
                ["https://a*b.com"], ["https://"]):
        try:
            NG.origins_of(bad, "trusted_origins", False)
            raise AssertionError("expected SystemExit for %r" % (bad,))
        except SystemExit:
            pass
    try:
        NG.origins_of(["x", 5], "k", False)                          # non-string element -> SystemExit
        raise AssertionError("expected SystemExit for a non-string entry")
    except SystemExit:
        pass
    print("NET origins_of: none/string/list/slash-strip/wildcard-ok, 7 bad shapes + non-str raise")


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



# ------------------------------------------------------------------- ram_guard ----
import io, contextlib, tempfile, types  # noqa: E402  (test-only helpers for this section)


class _FakeVM:
    def __init__(self, total, available):
        self.total = total; self.available = available


def _fake_psutil(total_gib, available_gib):
    """A stub psutil so the RAM warnings are deterministic regardless of this PC's real
    memory. virtual_memory() returns the total/available we ask for, in BYTES (the real
    psutil contract)."""
    mod = types.ModuleType("psutil")
    tot = int(total_gib * 2**30); avail = int(available_gib * 2**30)
    mod.virtual_memory = lambda: _FakeVM(tot, avail)
    return mod


@contextlib.contextmanager
def _stubbed(**mods):
    saved = {}
    try:
        for name, mod in mods.items():
            saved[name] = sys.modules.get(name)
            sys.modules[name] = mod
        yield
    finally:
        for name, prev in saved.items():
            if prev is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = prev


def test_ram_warn_tight_ram():
    # Guard branch: non-int / <=0 never reads psutil and never prints (returns None).
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), _stubbed(psutil=_fake_psutil(1000, 999)):
        for bad in (None, 0, -5, "", 3.0, [4]):
            assert RG.warn_tight_ram(bad) is None, bad
    assert buf.getvalue() == "", repr(buf.getvalue())
    print("RAM warn_tight_ram guard: non-int/<=0 -> silent, psutil untouched")

    # Real branch: experts that leave < 6 GB beside them -> a WARNING is printed (print-only,
    # returns None by contract). 8000 MiB experts on a 10 GiB box leaves ~2 GB -> must warn.
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), _stubbed(psutil=_fake_psutil(10, 9)):
        assert RG.warn_tight_ram(8000) is None
    out = buf.getvalue()
    assert "WARNING: RAM is tight" in out and "7.8 GB" in out, repr(out)   # experts = 8000/1024 GB
    print("RAM warn_tight_ram warn: 8000 MiB on 10 GiB -> 'RAM is tight', experts GB shown")

    # LOAD-BEARING differential: plenty of room -> NO warning. 100 MiB experts on a 64 GiB
    # box leaves ~63 GB (>= 6) -> prints nothing. The 6 GB threshold is what flips.
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), _stubbed(psutil=_fake_psutil(64, 60)):
        RG.warn_tight_ram(100)
    assert buf.getvalue() == "", repr(buf.getvalue())
    print("RAM warn_tight_ram ok: 100 MiB on 64 GiB -> no warning (differential)")


def test_ram_warn_budget_over_ram():
    # No --resident-budget-gib in args -> None (no parse, no psutil, no print).
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), _stubbed(psutil=_fake_psutil(8, 4)):
        assert RG.warn_budget_over_ram(["--resident-experts", "8"]) is None
    assert buf.getvalue() == ""

    # LOAD-BEARING at the boundary (a roomy 64/60 box): budget 40 <= free 60 AND <=
    # total-6=58 -> None, silent; budget 100 > free -> warns and returns the exact
    # sentence with the numbers. One stub, both branches, so the threshold is the only var.
    msg = None
    with contextlib.redirect_stdout(io.StringIO()), _stubbed(psutil=_fake_psutil(64, 60)):
        assert RG.warn_budget_over_ram(["--resident-budget-gib", "40"]) is None
        msg = RG.warn_budget_over_ram(["--resident-budget-gib", "100"])
    assert msg and "100 GiB" in msg and "60 GiB free of 64 GiB" in msg, repr(msg)
    print("RAM warn_budget_over_ram: 40-no-warn vs 100-warn (differential), numbers in msg")


# -------------------------------------------------------------------- gpu_score ----
def test_gpu_hip_speed_scores():
    # root is injectable -> a throwaway KFD topology dir makes this fully deterministic.
    d = tempfile.mkdtemp(prefix="kfd_")
    for node, simd, clk in [("0", "120", "1700"), ("1", "64", "1500"), ("2", "0", "999")]:
        os.makedirs(os.path.join(d, node), exist_ok=True)
        with open(os.path.join(d, node, "properties"), "w") as f:
            f.write("simd_count %s\nmax_engine_clk_fcompute %s\nextra junk line\n" % (simd, clk))
    got = GS.hip_speed_scores([0, 1], root=d)
    assert got == {0: 120.0 * 1700.0, 1: 64.0 * 1500.0}, got        # simd*clk; node2 simd=0 skipped
    # LOAD-BEARING differential: an index NOT present -> None (never a partial dict), so the
    # caller falls back to another probe.
    assert GS.hip_speed_scores([5], root=d) is None
    assert GS.hip_speed_scores([0], root=os.path.join(d, "does-not-exist")) is None  # OSError -> None
    print("GPU hip_speed_scores: exact {0:204000,1:96000}; absent-index + missing-root -> None")


def test_gpu_nvidia_speed_scores_stubbed():
    # Stub subprocess.run so the CUDA-driver probe is testable without a GPU. The child
    # prints "index sm khz" per card; got[i] = sm*khz. The env must force PCI_BUS_ID order
    # and CLEAR CUDA_VISIBLE_DEVICES so the probe sees every card regardless of the parent.
    class _R:
        stdout = "0 128 1900\n1 80 1500\n"
    def fake_run(argv, **kw):
        assert kw.get("env", {}).get("CUDA_DEVICE_ORDER") == "PCI_BUS_ID", kw.get("env")
        assert "CUDA_VISIBLE_DEVICES" not in kw.get("env", {}), kw.get("env")
        return _R()
    # Patch the name INSIDE the loaded module, not sys.modules: gpu_score imported
    # subprocess at top, so its global `subprocess` is what the function resolves. A
    # sys.modules swap would not be seen by an already-imported module.
    stub = types.ModuleType("subprocess")
    stub.run = fake_run; stub.SubprocessError = Exception
    real = getattr(GS, "subprocess", None)
    try:
        GS.subprocess = stub
        got = GS.gpu_speed_scores([0, 1])
        assert got == {0: 128.0 * 1900.0, 1: 80.0 * 1500.0}, got
        # LOAD-BEARING differential: a card the child did not report -> all(...) False -> None
        assert GS.gpu_speed_scores([0, 7]) is None
    finally:
        if real is None:
            del GS.subprocess
        else:
            GS.subprocess = real
    print("GPU gpu_speed_scores (stubbed CUDA): exact {0:243200,1:120000}; missing-card -> None")


# ----------------------------------------------------------------- boot_diagnose ----
def test_diag_listen_problem():
    assert "already in use" in BD.listen_problem("127.0.0.1", 8099, OSError(10048, "x"))
    assert "netsh" in BD.listen_problem("0.0.0.0", 443, OSError(10013, "x"))          # Windows reserved
    e = OSError(); e.errno = 10049; e.strerror = "no"
    txt = BD.listen_problem("9.9.9.9", 80, e)                                          # no such address
    assert "not an address" in txt and "9.9.9.9" in txt, txt
    # LOAD-BEARING differential: an unmapped errno falls through to the generic hint, but the
    # OS strerror + code are ALWAYS included so the user is never left a bare traceback.
    e2 = OSError(); e2.errno = 77777; e2.strerror = "odd thing"
    g = BD.listen_problem("h", 1, e2)
    assert "odd thing" in g and "77777" in g and "check --host and --port" in g, g
    print("DIAG listen_problem: in-use/reserved/no-address/generic branches, errno always surfaced")


def test_diag_start_log_tail():
    assert BD.start_log_tail(None, 0) == ""                                           # no log
    d = tempfile.mkdtemp(prefix="englog_")
    path = os.path.join(d, "engine.log")
    with open(path, "wb") as f:
        f.write(b"line one\nline two\nline three\n")
    tail = BD.start_log_tail(path, 0, n=2)
    assert "the engine log's last lines" in tail, repr(tail)
    assert "line three" in tail and "line two" in tail and "line one" not in tail, repr(tail)  # last n only
    assert BD.start_log_tail(os.path.join(d, "nope.log"), 0) == ""                   # missing file -> ""
    print("DIAG start_log_tail: last-n only; no-log / missing -> ''")


def test_diag_vision_start_error():
    # The CUDA "busy or unavailable" cause is named with its fix command (from the log tail),
    # not the first line of a traceback.
    d = tempfile.mkdtemp(prefix="viserr_")
    path = os.path.join(d, "stderr.log")
    with open(path, "wb") as f:
        f.write(b"Traceback\nCUDA-capable device(s) is/are busy or unavailable\n")
    fh = open(path, "rb")
    try:
        msg = BD.vision_start_error("something else", log=fh)
    finally:
        fh.close()
    assert "Exclusive_Process" in msg and "nvidia-smi" in msg, msg
    # LOAD-BEARING differential: an unrelated failure is echoed verbatim with the prefix,
    # NOT the CUDA advice.
    plain = BD.vision_start_error("disk full")
    assert plain == "the vision encoder did not start: disk full", repr(plain)
    assert "Exclusive_Process" not in plain
    print("DIAG vision_start_error: CUDA-cause (from log tail) vs verbatim-echo (differential)")



# ---------------------------------------------------------------- path_locate ----
def test_locate_combined_embeddings_path():
    # On Windows (os.name == "nt") the /dev/shm branch is skipped, so the combined-embeddings
    # file ALWAYS lands in the encoder's own dir with a random per-request name. Load-bearing:
    # the name must be req-<12 hex>.sve (the suffix the loader matches) and UNIQUE per call.
    vd = r"E:\enc" if sys.platform == "win32" else "/enc"
    p1 = PL.combined_embeddings_path(vd, 1)
    p2 = PL.combined_embeddings_path(vd, 1)
    name = p1.name
    assert p1.parent == PL.Path(vd), str(p1)
    assert name.startswith("req-") and name.endswith(".sve") and len(name) == 4 + 12 + 4, name
    assert p1 != p2, (p1, p2)   # different uuid -> distinct files (no cross-request clobber)
    # load-bearing guard branch: a huge nbytes that will not fit still falls back to the same
    # dir path (never to /dev/shm on a small/absent tmpfs) -> on nt it is the same anyway.
    big = PL.combined_embeddings_path(vd, 10**12)
    assert big.parent == PL.Path(vd), str(big)
    print("LOCATE combined_embeddings_path: req-<12hex>.sve in vision_dir, unique per call")


def test_locate_engine_binary():
    # A normal engine path passes through UNCHANGED (the feature check reads it directly).
    assert PL.engine_binary("/usr/bin/strata-llama") == "/usr/bin/strata-llama"
    assert PL.engine_binary("C:\\bin\\strata.exe") == "C:\\bin\\strata.exe"
    # LOAD-BEARING: only the Intel launcher wrapper "strata-sycl.sh" is redirected, and then
    # ONLY when the resolved target is_file(). A non-existent resolved path -> still the script.
    sycl = os.path.dirname(os.path.abspath(__file__)) + os.sep + "strata-sycl.sh"
    # case A: nothing real there -> returns the script path itself (is_file False -> skip).
    assert PL.engine_binary(sycl, {"env": {"STRATA_SYCL_BIN": "no/such/bin"}}) == sycl
    # case B: make the repo-relative target exist 2 levels above the wrapper's dir, then the
    # config's env wins -> engine_binary returns that file, proving cfg->env precedence.
    d = tempfile.mkdtemp(prefix="sycl_")
    two_up = os.path.dirname(os.path.dirname(d))          # matches resolve().parents[2]
    script = os.path.join(d, "strata-sycl.sh")
    open(script, "w").close()
    real_bin = os.path.join(d, "build-sycl-aot", "strata")
    os.makedirs(os.path.dirname(real_bin), exist_ok=True)
    open(real_bin, "w").close()
    got = PL.engine_binary(script, {"env": {"STRATA_SYCL_BIN": os.path.join(d, "build-sycl-aot", "strata")}})
    assert got == real_bin or (os.path.isfile(got)), repr(got)
    print("LOCATE engine_binary: non-script passthrough; sycl redirect only when target is_file")


def test_locate_slot_save_dir():
    # A relative value is made absolute against `base`; the dir is created (0700) and returned.
    base = tempfile.mkdtemp(prefix="slot_base_")
    got = PL.slot_save_dir("mysave", base=base)
    # abspath(join(base,value)) -- assert the load-bearing invariants, not an exact string:
    # the result is absolute, named mysave, and lives under (the resolved) base.
    assert os.path.isabs(got) and os.path.basename(got) == "mysave", got
    assert os.path.normcase(got).startswith(os.path.normcase(os.path.abspath(base))), got
    assert os.path.isdir(got), got
    # an absolute value ignores base: we hand it absdir directly and get absdir back.
    absdir = os.path.join(base, "abs_target")
    got2 = PL.slot_save_dir(absdir, base=base)
    assert got2 == absdir and os.path.isdir(got2), got2
    # LOAD-BEARING guard branches -> ValueError (must raise, not silently coerce):
    for bad in (None, "", "   ", 42, ["x"], "a\x01b"):
        try:
            PL.slot_save_dir(bad, base=base)
            raise AssertionError("expected ValueError for %r" % (bad,))
        except ValueError:
            pass
    # a path that names an EXISTING FILE: makedirs(exist_ok=True) raises FileExistsError
    # (a raw OSError that slot_save_dir does NOT wrap into ValueError) -- measured fact, the
    # docstring's "ValueError for anything else" does not cover this OS-level collision.
    afile = os.path.join(base, "afile")
    open(afile, "w").close()
    try:
        PL.slot_save_dir(afile, base=base)
        raise AssertionError("expected an error for an existing file, got a dir")
    except (ValueError, FileExistsError):
        pass
    print("LOCATE slot_save_dir: absolute+create ok, abs-ignores-base, 6+1 bad inputs -> ValueError")


def test_locate_import_patch_discipline():
    # FIXTURE LOCK for this cycle's real bug: gpu_score does `import subprocess` at module
    # TOP, so its name `subprocess` is bound in the module namespace; a sys.modules swap is
    # INVISIBLE to an already-imported module, while patching GS.subprocess works. ram_guard
    # imports psutil INSIDE the function, so there a sys.modules swap DOES take effect.
    # This test locks the difference so a future test never regresses to the wrong idiom.
    d = tempfile.mkdtemp(prefix="kfd_lock_")
    for node, simd, clk in [("0", "10", "100")]:
        os.makedirs(os.path.join(d, node), exist_ok=True)
        with open(os.path.join(d, node, "properties"), "w") as f:
            f.write("simd_count %s\nmax_engine_clk_fcompute %s\n" % (simd, clk))
    # (a) GS (module-top import): a sys.modules swap must NOT change GS.subprocess.
    sentinel = types.ModuleType("subprocess")
    sentinel.run = lambda *a, **k: None
    saved_real = sys.modules.get("subprocess")
    sys.modules["subprocess"] = sentinel
    try:
        assert GS.subprocess is not sentinel, (
            "GS keeps its own import binding; patching it via sys.modules is a no-op")
    finally:
        if saved_real is None: sys.modules.pop("subprocess", None)
        else: sys.modules["subprocess"] = saved_real
    # (b) the CORRECT idiom -- patch the module attribute -- is what a caller must use.
    seen = {}
    stub = types.ModuleType("subprocess")
    def _run(*a, **k):
        seen["called"] = True
        class _R: stdout = ""
        return _R()
    stub.run = _run; stub.SubprocessError = Exception
    real = getattr(GS, "subprocess", None)
    GS.subprocess = stub
    try:
        GS.gpu_speed_scores([0])
        assert seen.get("called") is True, "patching GS.subprocess is what the function sees"
    finally:
        GS.subprocess = real
    print("LOCATE import-patch lock: sys.modules swap invisible to GS; GS.subprocess patch works")


# ----------------------------------------------------------------- gpu_config ----
def test_gpu_cfg_gpu_list():
    # The config's "gpu" key -> the nvidia-smi-numbered card list, in every accepted shape.
    assert GC.gpu_list({}) == []                       # no key
    assert GC.gpu_list({"gpu": None}) == []            # explicit none
    assert GC.gpu_list({"gpu": ""}) == []              # empty string -> none
    assert GC.gpu_list({"gpu": 2}) == [2]              # a bare int is str() -> one card
    assert GC.gpu_list({"gpu": "2"}) == [2]            # single string
    assert GC.gpu_list({"gpu": "0,2"}) == [0, 2]       # CSV string -> ordered list
    assert GC.gpu_list({"gpu": " 2 , 1 "}) == [2, 1]   # whitespace around items is stripped
    assert GC.gpu_list({"gpu": [1, 3]}) == [1, 3]      # a list passes through as ints
    assert GC.gpu_list({"gpu": (0, 1, 2)}) == [0, 1, 2]  # a tuple too
    assert GC.gpu_list({"gpu": "2,,3"}) == [2, 3]      # empty CSV tokens are dropped
    # LOAD-BEARING: a non-numeric token raises ValueError (never silently coerced to 0), so a
    # malformed config fails loud rather than silently targeting card 0.
    try:
        GC.gpu_list({"gpu": "a,2"})
        raise AssertionError("expected ValueError for a non-numeric card token")
    except ValueError:
        pass
    print("GPU-CFG gpu_list: none/int/csv/strip/list/tuple/empty-drop ok; non-numeric -> ValueError")


def test_gpu_cfg_layer_split_of():
    # Several named cards AND no --peer-device on the later card(s) => a layer split.
    assert GC.layer_split_of({"gpu": [0, 2], "args": []}) is True
    assert GC.layer_split_of({"gpu": "0,1,2", "args": ["--layer-split", "99"]}) is True  # already-split is still a split
    # LOAD-BEARING differential 1: a single card is NOT a split (len <= 1 -> False).
    assert GC.layer_split_of({"gpu": 2, "args": []}) is False
    assert GC.layer_split_of({"gpu": [1], "args": []}) is False
    # LOAD-BEARING differential 2: --peer-device reassigns the second card to an expert tier,
    # so several cards + that flag is NOT a split (the engine refuses --layer-split beside it, #665).
    assert GC.layer_split_of({"gpu": [0, 2], "args": ["--peer-device", "k/q5"]}) is False
    # LOAD-BEARING guard: with a single card the `and` short-circuits, so a config that has NO
    # "args" key at all must NOT raise -- the split check never touches cfg["args"].
    assert GC.layer_split_of({"gpu": 1}) is False
    assert GC.layer_split_of({"gpu": []}) is False
    print("GPU-CFG layer_split_of: multi-card True, single-card/--peer-device False, "
          "short-circuit guards missing args key")


def test_env_dir_writable():
    # A real writable temp dir -> True; missing / unwritable path -> False (never raises).
    import tempfile
    d = tempfile.mkdtemp()
    try:
        assert EP._dir_writable(d) is True           # freshly created writable dir
    finally:
        import shutil; shutil.rmtree(d, ignore_errors=True)
    assert EP._dir_writable(os.path.join(d, "gone")) is False   # path now removed -> False, no raise
    assert EP._dir_writable("/nonexistent/definitely/not/here") is False
    # LOAD-BEARING: the just-deleted dir must be False, proving the probe actually hits the
    # filesystem rather than always trusting a string that "looks" like a path.
    print("ENV _dir_writable: writable=True / missing=False (no raise) ok")


def test_env_linux_desktop():
    # The probe reads its module's os.name / sys.platform, so we monkeypatch THOSE on EP
    # (not the real globals) to reach every branch deterministically, then restore.
    import types
    real_os, real_sys = EP.os, EP.sys
    try:
        EP.os = types.SimpleNamespace(name="posix", environ={})
        EP.sys = types.SimpleNamespace(platform="linux")
        assert EP.linux_desktop({"DISPLAY": ":0"}) is True         # X11
        assert EP.linux_desktop({"WAYLAND_DISPLAY": "wayland-0"}) is True  # Wayland
        assert EP.linux_desktop({}) is False                        # headless: no display
        assert EP.linux_desktop({"OTHER": "1"}) is False           # unrelated var is not a display
        EP.sys = types.SimpleNamespace(platform="darwin")
        assert EP.linux_desktop({"DISPLAY": ":0"}) is False        # macOS is excluded by name
        EP.os = types.SimpleNamespace(name="nt", environ={})
        assert EP.linux_desktop({"DISPLAY": ":0"}) is False        # Windows is excluded by os.name
    finally:
        EP.os, EP.sys = real_os, real_sys
    # LOAD-BEARING: on this (Windows) interpreter, os.name=="nt" short-circuits every call to
    # False -- the desktop-VRAM note must never misfire on Windows.
    assert EP.linux_desktop({"DISPLAY": ":0"}) is False
    print("ENV linux_desktop: X11/Wayland->True, headless/mac/nt->False, win-shortcircuit ok")


def test_stall_threshold_constants():
    # The two literals the predicate reads are pinned -- moving them with the predicate is
    # the whole point, so a silent change here would quietly widen/narrow the stall window.
    assert ES.STALL_CPU_EPS_S == 0.5            # CPU-seconds tolerance
    assert ES.STALL_IO_EPS_B == 1 << 20         # 1 MiB of moved I/O
    print("STALL consts: cpu_eps=0.5 / io_eps=1MiB ok")


def test_stall_engine_frozen():
    # base/now are (cpu_seconds, io_bytes) sample pairs. A quiet engine that ALSO used no
    # CPU and moved no I/O within the tolerances is FROZEN (True); a working-slow one is not.
    E = ES.STALL_IO_EPS_B
    assert ES.engine_frozen((10.0, 1000), (10.4, 1000 + E)) is True    # both at the bound -> True
    assert ES.engine_frozen((10.0, 0), (10.0, 0)) is True               # fully frozen
    # LOAD-BEARING (CPU): just over the CPU tolerance -> never frozen, even with zero I/O.
    assert ES.engine_frozen((10.0, 0), (10.0 + ES.STALL_CPU_EPS_S, 0)) is True       # == bound -> True
    assert ES.engine_frozen((10.0, 0), (10.0 + ES.STALL_CPU_EPS_S + 0.01, 0)) is False
    # LOAD-BEARING (I/O): just over the I/O tolerance -> never frozen, even with idle CPU.
    assert ES.engine_frozen((10.0, 0), (10.1, E + 1)) is False
    # BOTH must be under tolerance to flag frozen: a busy CPU but idle I/O -> False.
    assert ES.engine_frozen((5.0, 100), (5.2, 100)) is True             # cpu 0.2<=0.5, io 0 -> True
    assert ES.engine_frozen((5.0, 100), (5.6, 100)) is False            # cpu 0.6>0.5 -> False
    print("STALL engine_frozen: idle->True, cpu-busy/io-busy/over-bound->False (differential) ok")


# ---------------------------------------------------------------- tokenizer ----
def test_tokenizer_byte_roundtrip_and_specials():
    # ByteTokenizer: one id per UTF-8 byte; specials become ids >= 256 ONLY with parse_special,
    # and a plain= range suppresses that even when parse_special is on (LOAD-BEARING).
    bt = TK.ByteTokenizer()
    assert bt.encode("ab") == [97, 98]
    assert bt.encode("<|im_end|>", parse_special=True) == [256 + 1]      # the im_end id
    assert bt.encode("<|im_end|>") == list("<|im_end|>".encode())        # NO parse -> plain bytes
    assert bt.encode("<|im_end|>", parse_special=True, plain=[(0, 10)]) == list("<|im_end|>".encode())
    assert bt.decode(bt.encode("h\u00e9llo")) == "h\u00e9llo"
    print("TOKENIZER ByteTokenizer: byte round-trip / special-parse / plain-block ok")


def test_tokenizer_detokenizer_incremental():
    # Over a tok WITHOUT token_bytes (the byte tokenizer) Detokenizer keeps the re-decode path:
    # a multi-byte char split across byte tokens is HELD until complete (LOAD-BEARING: a naive
    # per-token decode would emit a stray replacement char mid-character).
    bt = TK.ByteTokenizer()
    d = TK.Detokenizer(bt)
    assert d.push(ord("A")) == "A"
    e = "\u00e9".encode("utf-8")           # 0xC3 0xA9, split across two byte tokens
    d2 = TK.Detokenizer(bt)
    out = d2.push(e[0]) + d2.push(e[1])
    assert out == "\u00e9"
    d3 = TK.Detokenizer(bt); d3.push(e[0])
    assert d3.pending() is True                          # a character is split -> held
    print("TOKENIZER Detokenizer: incremental decode / held-partial ok")


def test_tokenizer_stop_strings_and_matcher():
    # stop_strings accepts OpenAI `stop` (str/list, max OPENAI_MAX_STOP) or Anthropic
    # `stop_sequences`, drops empty strings, and raises ValueError (a 400) on bad types / too many
    # (LOAD-BEARING: the >max and wrong-type branches MUST raise, else a malformed request reaches the engine).
    assert TK.stop_strings({}) == []
    assert TK.stop_strings({"stop": "x"}) == ["x"]
    assert TK.stop_strings({"stop": ["a", "", "b"]}) == ["a", "b"]
    assert TK.stop_strings({"stop_sequences": ["s1"]}) == ["s1"]
    assert TK.stop_strings({"stop": ["a", "b", "c", "d"]}) == ["a", "b", "c", "d"]   # at the cap
    assert TK.OPENAI_MAX_STOP == 4
    for bad in ({"stop": ["a", "b", "c", "d", "e"]}, {"stop": 123}):     # over-cap / wrong type
        try:
            TK.stop_strings(bad); raise AssertionError("expected ValueError for %r" % (bad,))
        except ValueError:
            pass
    # StopMatcher holds the longest tail of the buffer that a stop string could still start with.
    sm = TK.StopMatcher(["##"])
    assert sm.push("hello #") == "hello "              # trailing '#' held back
    assert sm.push("#world") == ""                     # completes '##' -> stop fires
    assert sm.hit == "##"
    assert sm.push("more") == ""                        # after a hit, nothing more
    sm2 = TK.StopMatcher(["STOP"])
    assert (sm2.push("abc"), sm2.push("def"), sm2.flush()) == ("abc", "def", "")
    print("TOKENIZER stop_strings + StopMatcher: cap/type 400 + hold-tail ok")


# ---------------------------------------------------------------- approval ----
def test_approval_needs_registry_only():
    # _needs_approval is True ONLY for the six registry *mutations*; reads, the probe and every
    # other tool (and "") are False. LOAD-BEARING: a read like registry__list_servers must NOT
    # gate, else the autonomous tier would pause on harmless introspection.
    for m in ("registry__add_server", "registry__update_skill", "registry__delete_server"):
        assert AP._needs_approval(m) is True
    for r in ("registry__list_servers", "registry__get_server", "shell__exec", "filesystem__write", ""):
        assert AP._needs_approval(r) is False
    print("APPROVAL _needs_approval: six mutations True, reads/other/empty False ok")


def test_approval_auto_deny_destructive():
    # _auto_deny blocks a clearly destructive shell command but lets ordinary ones through.
    # LOAD-BEARING: only shell/exec/run/command-named tools are screened (name gate), and the two
    # pattern sets cover word-boundary forms (rm -rf) AND punctuation-anchored ones (> /dev/sda,
    # the fork bomb) that a \b wrapper alone would miss.
    deny, why = AP._auto_deny("shell__exec", {"command": "rm -rf /tmp/x"})
    assert deny is True and "destructive" in why
    # symbol form the \b(?:...) wrapper CANNOT match -> needs the separator-anchored set:
    deny2, _ = AP._auto_deny("shell__exec", {"command": "cat x > /dev/sda"})
    assert deny2 is True
    # an ordinary build command that merely contains the substring must NOT be blocked:
    assert AP._auto_deny("shell__exec", {"command": "npm run build"}) == (False, None)
    # a NON-shell tool name with the same text is never screened (name gate):
    assert AP._auto_deny("filesystem__write", {"path": "rm -rf"}) == (False, None)
    print("APPROVAL _auto_deny: rm-rf/symbol True, benign/non-shell False ok")


def test_approval_desc_truncates():
    # _approval_desc renders "tool: args", coercing non-str args via json and capping at 320 chars
    # with an ellipsis (LOAD-BEARING: an unbounded description would blow up the approval modal).
    d = AP._approval_desc("shell__exec", {"command": "echo hi"})
    assert d.startswith("shell__exec: ") and "echo hi" in d
    long = AP._approval_desc("shell__exec", "x" * 500)
    tail = long[len("shell__exec: "):]                 # strip the prefix; the cap is on the args part
    assert tail.endswith("\u2026") and tail.count("x") == 320
    print("APPROVAL _approval_desc: prefix + 320-cap ellipsis ok")


# ---------------------------------------------------------------- conv_cache ----
def test_conv_cache_view_card():
    # conversation_cache_view builds the Monitor card from arguments only. LOAD-BEARING:
    # enabled is True ONLY when conversation_cache_mib is an int > 0 (a string budget or 0/None
    # leaves the card disabled, matching the engine's opt-in gate), and reused_tokens comes from
    # the running totals (not recomputed), with a per-request reused>0 count over hist.
    info = {"conversation_cache_mib": 8, "conversation_cache_slots": 4}
    hist = [{"reused": 5, "prompt_tokens": 100}, {"reused": 0, "prompt_tokens": 50}]
    totals = {"reused": 5, "prompt_tokens": 150}
    parked = {"parked": 3, "bytes": 9}
    card = CV.conversation_cache_view(info, hist, totals, parked)
    assert card["enabled"] is True and card["budget_mib"] == 8 and card["slots"] == 4
    assert card["requests"] == 2 and card["requests_reused"] == 1
    assert card["reused_tokens"] == 5 and card["prompt_tokens"] == 150
    assert card["parked"] == 3 and card["bytes"] == 9          # the parked dict is splatted in
    assert card["last_reused"] == 0 and card["last_prompt"] == 50  # last hist row
    # disabled boundaries: string budget, zero, and missing all -> enabled False
    for bad in ({"conversation_cache_mib": "8"}, {"conversation_cache_mib": 0}, {}):
        assert CV.conversation_cache_view(bad, [], {}, {})["enabled"] is False
    assert CV.conversation_cache_view({}, [], {}, {})["last_reused"] is None
    print("CONV-CACHE view: int>0 gate, totals + parked splat, disabled boundaries ok")


def test_conv_log_parse_events():
    # ConvCacheLog.poll parses the engine's conversation-cache stderr lines into running state.
    # LOAD-BEARING: a parked event bumps parks but a skipped one does NOT (and leaves parked/bytes
    # refreshed anyway), a restored bumps restores, and a dropped-superseded line only sets parked.
    import tempfile
    log = os.path.join(tempfile.mkdtemp(), "engine.log")
    cl = CV.ConvCacheLog()
    lines = (
        b"strata serve: conversation cache: parked 12 tokens, 3 slots, parked=100 bytes=2048 evictions=1\n"
        b"unrelated noise line\n"
        b"strata serve: conversation cache: skipped 7 tokens, parked=110 bytes=2100\n"
        b"strata serve: conversation cache: restored 9 tokens, parked=40 bytes=900\n"
        b"strata serve: conversation cache: dropped 2 superseded entries, parked=30\n"
    )
    open(log, "wb").write(lines)
    st = cl.poll(log, 0)
    assert st["parked"] == 30            # the last DROPPED line wins
    assert st["bytes"] == 900            # last refreshed bytes (dropped has no bytes field)
    assert st["evictions"] == 1
    assert st["parks"] == 1              # only the parked line; skipped did NOT count
    assert st["restores"] == 1
    assert st["last_event"] == "restored" and st["last_tokens"] == 9
    # empty inputs short-circuit to current state without touching the file:
    assert cl.poll(None, 0) == st
    print("CONV-CACHE log: park/skip/restore counting + dropped + evictions ok")


# ---------------------------------------------------------------- engine_diag ----
def test_engine_diag_exit_words_and_crash():
    # engine_exit_words / engine_crashed read a process exit status. LOAD-BEARING three-way
    # differential on the Windows NTSTATUS space (this host's os.name == 'nt'):
    #   a known crash code (0xC000001D) -> a words line from the _WIN_CRASH table;
    #   an unmapped code inside 0xC0000000..0xD0000000 -> the generic 'system error status' form;
    #   a plain exit code (5) -> 'exit code 5', and engine_crashed is False for it but True for
    #   an NTSTATUS code. None (no status) short-circuits both.
    assert ED.engine_exit_words(None) == ""
    assert ED.engine_crashed(None) is False
    w_known = ED.engine_exit_words(0xC000001D)
    assert "illegal instruction" in w_known and "0xC000001D" in w_known
    w_range = ED.engine_exit_words(0xC0000123)          # inside the range, not in the table
    assert "system error status" in w_range
    w_plain = ED.engine_exit_words(5)                    # outside every range
    assert w_plain == "exit code 5"
    assert w_known != w_range != w_plain                 # the three branches really differ
    assert ED.engine_crashed(0xC0000005) is True         # an NTSTATUS -> a system-ended crash
    assert ED.engine_crashed(5) is False                 # a normal exit is not a crash
    assert ED.engine_crashed(0) is False                 # clean exit is not a crash
    print("ENGINE-DIAG exit words/crash: table vs range vs plain, crashed bool ok")


def test_engine_diag_log_reads():
    # start_log_marks / start_failure_hint read the engine's start log. LOAD-BEARING:
    # start_log_marks returns ONLY the TRANSIENT_START_MARKS substrings actually present
    # (an unrelated log yields []); start_failure_hint returns '' unless the draft-head
    # failure phrase appears, and otherwise a non-empty mtp advice line built from it.
    import tempfile
    d = tempfile.mkdtemp()
    assert ED.start_log_marks(None, 0) == []             # no log
    hit = os.path.join(d, "hit.log")
    open(hit, "wb").write(b"starting\nboom hsa_exception during queue setup\n")
    marks = ED.start_log_marks(hit, 0)
    assert marks == ["hsa_exception"]                     # only the present mark
    miss = os.path.join(d, "miss.log")
    open(miss, "wb").write(b"starting\nall good\n")
    assert ED.start_log_marks(miss, 0) == []             # no mark present
    assert ED.start_failure_hint(None, 0) == ""          # no log
    open(miss, "ab").write(b"some unrelated error\n")    # present but not the draft-head phrase
    assert ED.start_failure_hint(miss, 0) == ""
    dh = os.path.join(d, "dh.log")
    open(dh, "wb").write(b"strata mtp: draft head over budget\n"
                          b"strata mtp: hint: --draft-vocab en\n"
                          + ED.DRAFT_HEAD_FAIL.encode() + b"\n")
    hint = ED.start_failure_hint(dh, 0)
    assert hint.startswith(". mtp: ") and ED.DRAFT_HEAD_FAIL in hint
    assert "--draft-vocab en" in hint                    # the engine's own hint line was picked up
    print("ENGINE-DIAG log reads: marks-filter + draft-head hint build ok")


# ---------------------------------------------------------------- exceptions ----
def test_exceptions_hierarchy_and_payload():
    # The extracted exception classes must keep their inheritance + carry-loads. LOAD-BEARING:
    # EngineSilent subclasses EngineDied (so a silence is still a fatal engine loss -> the caller's
    # EngineDied handler catches it), EngineDied subclasses RuntimeError but NOT ValueError, and
    # EngineNonFinite subclasses ValueError (a started stream reports it as an error event). The two
    # carrying classes keep their attributes: SessionRefused maps kind->HTTP status (unknown kind ->
    # 'io'/500) and GpuBusy keeps retry_after. Without the extraction these relationships could silently
    # break if a base name were mis-wired during the move.
    assert issubclass(EX.EngineSilent, EX.EngineDied)
    assert issubclass(EX.EngineDied, RuntimeError) and not issubclass(EX.EngineDied, ValueError)
    assert issubclass(EX.EngineNonFinite, ValueError)
    assert issubclass(EX.SessionRefused, ValueError)
    assert issubclass(EX.ModelBusy, RuntimeError) and issubclass(EX.EngineStuck, RuntimeError)
    assert issubclass(EX.GpuBusy, RuntimeError) and issubclass(EX.ClientGone, Exception)
    # the three distinct bases really differ (not all collapsed onto one base by a mis-wired move):
    assert EX.EngineDied is not EX.EngineNonFinite is not EX.ClientGone
    r_bad = EX.SessionRefused("storage", "disk full")
    assert r_bad.kind == "storage" and r_bad.status == 507 and r_bad.published is False
    assert EX.SessionRefused("invalid", "x").status == 400
    assert EX.SessionRefused("memory", "x").status == 503
    # an unknown kind falls back to io / 500 (LOAD-BEARING: it must not KeyError):
    r_unk = EX.SessionRefused("zzz", "x")
    assert r_unk.kind == "io" and r_unk.status == 500
    # published flag round-trips:
    assert EX.SessionRefused("io", "x", published=True).published is True
    g = EX.GpuBusy("low vram", retry_after=5)
    assert g.retry_after == 5 and "low vram" in str(g)
    assert EX.GpuBusy().retry_after is None            # default (no Retry-After)
    print("EXCEPTIONS hierarchy: EngineSilent<EngineDied, ValueError vs RuntimeError bases, status/retry loads ok")


def main():
    test_wire_openai_text_and_reasoning()
    test_wire_openai_tool_merge_and_bad_json_dropped()
    test_wire_openai_heartbeat_and_mcp_passthrough()
    test_wire_anthropic_text_and_tool()
    test_wire_anthropic_thinking_and_truncated_tool_dropped()
    test_net_host_allowed()
    test_net_origin_and_key_and_host_name()
    test_net_api_key_of_and_origins_of()
    test_req_clean_shared_defaults()
    test_req_check_request_sampling()
    test_req_lift_reasoning_effort()
    test_stats_request_timings_and_seen()
    test_stats_carry_and_agg()
    test_ram_warn_tight_ram()
    test_ram_warn_budget_over_ram()
    test_gpu_hip_speed_scores()
    test_gpu_nvidia_speed_scores_stubbed()
    test_diag_listen_problem()
    test_diag_start_log_tail()
    test_diag_vision_start_error()
    test_locate_combined_embeddings_path()
    test_locate_engine_binary()
    test_locate_slot_save_dir()
    test_locate_import_patch_discipline()
    test_gpu_cfg_gpu_list()
    test_gpu_cfg_layer_split_of()
    test_env_dir_writable()
    test_env_linux_desktop()
    test_stall_threshold_constants()
    test_stall_engine_frozen()
    test_tokenizer_byte_roundtrip_and_specials()
    test_tokenizer_detokenizer_incremental()
    test_tokenizer_stop_strings_and_matcher()
    test_approval_needs_registry_only()
    test_approval_auto_deny_destructive()
    test_approval_desc_truncates()
    test_conv_cache_view_card()
    test_conv_log_parse_events()
    test_engine_diag_exit_words_and_crash()
    test_engine_diag_log_reads()
    test_exceptions_hierarchy_and_payload()
    print("PURE-MODULES TEST PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
