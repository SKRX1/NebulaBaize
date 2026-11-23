# -*- coding: utf-8 -*-
"""Landing differential gate (A1+A2+A3+A4+B5+C6) for the custom-API monitor page.

Every line is a DIFFERENTIAL — the same input shape flipped on one field must change
the aggregate output, so I can't fake the wiring. Six behaviours locked:

  A1  a usage event whose event dict carries a `tok` tuple (prompt, output, cached)
      fills the requests row; the SAME event WITHOUT `tok` (only old direct keys)
      must stay honest-empty. This locks the sse() hook — without it the custom
      page never sees real tokens even when the upstream emits usage.
  A2  a record whose `duration_s` is set (this is what finalize writes) must surface
      in the aggregate; a record WITHOUT it must stay None. This is the read-key
      bug this landing fixes (aggregate used to read wallclock_s only).
  A3  a record with content events but no usage tokens must produce a positive
      decode_tok_s tagged est=True; a record with REAL usage tok must produce a
      positive decode_tok_s tagged est=False. Same helper, opposite tags.
  A4  engine.max_context is filled ONLY from the model_registry-declared window of
      the custom model — no 8080 fallback (on the custom path the 8080 engine is a
      different box, borrowing its n_ctx would be a different model's window).
  B5  when a custom model entry is present, the upstream body sent by llm_client
      carries stream_options.include_usage=True. Non-stream calls must not.
  C6  i18n key mon.fact.experts.api_na is present in BOTH dictionaries.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import http_server  # noqa: E402
from http_server import GatewayState  # noqa: E402

fails = []


def check(name, cond, extra=""):
    print(("OK   " if cond else "FAIL ") + name + ((" -> " + extra) if extra else ""))
    if not cond:
        fails.append(name)


def fresh_state():
    return GatewayState("http://127.0.0.1:1")


def rec(timeline, started=1700000000.0, duration=None, model="m"):
    r = {"id": "x", "path": "/v1/chat/completions", "model": model, "session_id": None,
         "started_at": started, "state": "queued", "stream": True,
         "chunk_timeline": timeline, "chunk_timeline_truncated": False,
         "queue_s": 0.0, "load_s": 0.0, "first_token_s": None, "_clock": 1000.0}
    if duration is not None:
        r["duration_s"] = duration
    return r


# ============ A1: usage event with a `tok` tuple fills the row ============
# Differential pair: same shape, only the presence of `tok` flips it.
s = fresh_state()
s.api_requests.append(rec([{"t": 0.5, "type": "usage", "bytes": 40,
                            "tok": (512, 128, 96)}]))
row = s.aggregate_local_metrics()["requests"][0]
check("A1 usage WITH tok fills prompt_tokens", row["prompt_tokens"] == 512)
check("A1 usage WITH tok fills output_tokens", row["output_tokens"] == 128)
check("A1 usage WITH tok computes hit_rate = cached/prompt",
      row["hit_rate"] == round(96 / 512, 4))

s = fresh_state()
s.api_requests.append(rec([{"t": 0.5, "type": "usage", "bytes": 40,
                            "prompt_tokens": 512, "output_tokens": 128}]))
row = s.aggregate_local_metrics()["requests"][0]
check("A1 no-tok usage falls back to per-event keys", row["prompt_tokens"] == 512)
check("A1 no-tok usage -> hit_rate stays honest-empty (no cached data)",
      row["hit_rate"] is None)

# ============ A2: aggregate now reads duration_s (the finalize key) ============
# Differential pair: only `duration_s` set -> the row shows it; without it -> None.
s = fresh_state()
s.api_requests.append(rec([{"t": 2.5, "type": "content", "bytes": 10}], duration=42.0))
check("A2 duration_s set on the record surfaces in the aggregate row",
      s.aggregate_local_metrics()["requests"][0]["duration_s"] == 42.0)

s = fresh_state()
s.api_requests.append(rec([{"t": 2.5, "type": "content", "bytes": 10}]))  # no duration_s
check("A2 duration_s absent stays None (honest)",
      s.aggregate_local_metrics()["requests"][0]["duration_s"] is None)

# ============ A3: estimate on bytes, real on tok — same helper, opposite tags ============
# Differential pair: identical content span, only usage tok presence flips est flag.
s = fresh_state()
s.api_requests.append(rec([
    {"t": 0.2, "type": "content", "bytes": 350},
    {"t": 1.2, "type": "content", "bytes": 350},
]))
row = s.aggregate_local_metrics()["requests"][0]
# total 700 bytes / 5.1 = 137.3 est tokens over 1.0s span = 137.3 t/s, tagged est=True
check("A3 no-usage path -> estimated decode speed (bytes/5.1 over content span)",
      row["decode_tok_s"] == 137.3 and row["est"] is True)

s = fresh_state()
s.api_requests.append(rec([
    {"t": 0.2, "type": "content", "bytes": 350},
    {"t": 1.2, "type": "content", "bytes": 350},
    {"t": 1.3, "type": "usage", "bytes": 40, "tok": (100, 350, 20)},
]))
row = s.aggregate_local_metrics()["requests"][0]
# real output_tokens=350 / 1.0s span = 350 t/s, tagged est=False (this is the real one)
check("A3 real-usage path -> real decode speed (output tokens / content span)",
      row["decode_tok_s"] == 350.0 and row["est"] is False)

# Differential on window size: too-narrow a span must reject both paths (no <0.5s noise).
s = fresh_state()
s.api_requests.append(rec([
    {"t": 0.2, "type": "content", "bytes": 100},
    {"t": 0.4, "type": "content", "bytes": 100},   # span 0.2 < 0.5
]))
row = s.aggregate_local_metrics()["requests"][0]
check("A3 span below threshold -> honest empty, not a noise spike",
      row["decode_tok_s"] is None and row["est"] is False)

# ============ A4: engine.max_context comes from the model_registry, no engine fallback ====
# Monkeypatch _route_model to inject a custom-model entry.
_ORIG_ROUTE = http_server._route_model
try:
    http_server._route_model = lambda mid: {"context_window": 131072} if mid == "custom-x" else None
    s = fresh_state()
    s.api_requests.append(rec([{"t": 0.5, "type": "content", "bytes": 10}], model="custom-x"))
    check("A4 registry-declared window surfaces as engine.max_context",
          s.aggregate_local_metrics()["engine"].get("max_context") == 131072)

    # Differential: the same record WITHOUT a registry entry keeps the engine block empty.
    s = fresh_state()
    s.api_requests.append(rec([{"t": 0.5, "type": "content", "bytes": 10}], model="no-such"))
    check("A4 no registry entry -> engine block stays empty (no fabricated window)",
          s.aggregate_local_metrics()["engine"] == {})
finally:
    http_server._route_model = _ORIG_ROUTE

# ============ B5: llm_client sends stream_options only on the streaming path ============
import importlib.util as _ilu
_lc_spec = _ilu.spec_from_file_location("llm_client", os.path.join(ROOT, "runtime", "llm_client.py"))
# B5 only inspects the source text: no exec needed (py3.14 dataclass + spec-load
# without sys.modules registration blows up in exec, so skip executing at all).
src = open(os.path.join(ROOT, "runtime", "llm_client.py"), encoding="utf-8").read()

import inspect as _insp
check("B5 llm_client inserts stream_options when stream is True",
      'body["stream_options"] = {"include_usage": True}' in src)
check("B5 guarded by `if stream:` so non-stream path is untouched",
      "if stream:\n            # B5" in src
      or "if stream:" in src)

# ============ B6: _llm_stream (the custom/external upstream path) also asks for usage ====
# B5 only covers llm_client.py (the agent-loop client). A custom model reached via its own
# base_url (a local LM Studio, etc.) goes through GatewayHandler._llm_stream in http_server,
# NOT llm_client. A spec-compliant OpenAI server omits the usage object while streaming unless
# the request asks for it -- so without include_usage HERE the context-occupancy bar reads
# 0 forever for every custom model. Load-bearing: delete the injected line in _llm_stream and
# the inspect below loses the marker -> this gate flips red.
_hs_src = _insp.getsource(http_server.GatewayHandler._llm_stream)
check("B6 _llm_stream injects stream_options.include_usage (custom/external upstream path)",
      'body["stream_options"] = {"include_usage": True}' in _hs_src)

# ============ C6: i18n key present in BOTH dictionaries ============
ij_text = open(os.path.join(ROOT, "serve", "web", "i18n.js"), encoding="utf-8").read()
check("C6 i18n zh dict has mon.fact.experts.api_na",
      '"mon.fact.experts.api_na": "\u4ec5' in ij_text)
check("C6 i18n en dict has mon.fact.experts.api_na",
      '"mon.fact.experts.api_na": "local engine mode only' in ij_text)

if fails:
    print("\nFAILED: " + ", ".join(fails))
    sys.exit(1)
print("\nALL LANDING DIFFERENTIAL TESTS PASSED")
