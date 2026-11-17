"""Resident regression gate: the context-window DENOMINATOR must be the engine's REAL n_ctx,
learned from its own /health -- the hardcoded fallback is only a last resort when the engine
is silent, NOT a baseline to compare against.

Root cause it locks (2026-10 report "panel shows 50% but the gateway said 92%"): the proactive
guard and the output cap used a hardcoded denominator (131072) that never learned the engine's
real n_ctx, so a chat at ~46% of the REAL window read as 92% on the gateway side and fired far
too early. The fix is GatewayState.ctx_window() = env override > polled real n_ctx > fallback,
shared by the guard and compute_output_cap.

BASELINE IS READ FROM THE RUNTIME (2026-10-23), not written as a literal: the fallback constant
below is taken from http_server.GatewayState itself, so when the operator deliberately reconfigures
the engine to a real window that happens to EQUAL the fallback, this gate does NOT turn that into a
false red. The "it learned the real value vs fell back" discrimination only has power when the real
window differs from the fallback; when they are equal it is delegated to the mechanism tests below
(fake-poll says X -> uses X; engine silent -> uses the fallback). The user reconfigured the engine's
real window to 131072 on 2026-10-23, which is exactly this case.

Self-contained: imports the CURRENT on-disk http_server (this gate locks the SOURCE, so it is
correct whether or not the running gateway has been restarted) and polls the same /health the
frontend uses. Skips cleanly when the engine is not reachable (no false red).

Run: python tests/test_ctx_denominator.py
"""
import os
import sys
import json
import importlib.util
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "runtime"))

FAILURES = []


def check(label, cond, extra=""):
    print(("  OK   " if cond else "  FAIL ") + label + (("  " + extra) if extra else ""))
    if not cond:
        FAILURES.append(label)


def skip(label, extra=""):
    print("  SKIP " + label + (("  " + extra) if extra else ""))


spec = importlib.util.spec_from_file_location("hs_mod", os.path.join(ROOT, "runtime", "http_server.py"))
hs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hs)

# The engine the gateway points at: the standalone gateway's own upstream (the 8080 engine).
# Poll its real window over the SAME /health the frontend uses. None when it will not say.
ENGINE_URL = "http://127.0.0.1:8080"
real = None
try:
    req = urllib.request.Request(ENGINE_URL + "/health", headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=2.0) as r:
        real = json.loads(r.read().decode("utf-8", "replace")).get("max_context")
    real = int(real) if isinstance(real, (int, float)) and real > 0 else None
except Exception:
    real = None

# Baseline read FROM THE RUNTIME -- the gateway's own fallback constant, not a literal in this test.
FALLBACK = hs.GatewayState(ENGINE_URL).max_context

st = hs.GatewayState(ENGINE_URL)
resolved = st.ctx_window()

print("CONTEXT-WINDOW DENOMINATOR (no double denominator):")

# Mechanism (always runs -- this is the gatekeeper that proves ctx_window CONSUMES the poll):
# fake-poll a value distinct from the fallback; ctx_window must use the polled value, and only
# fall back to the runtime constant when the poll is silent. This is the discrimination that does
# not depend on the live engine's number, so it stays valid even when real == fallback.
saved = hs.endpoint_max_context
try:
    fake_probe = FALLBACK + 66528          # "engine says something != the fallback"
    hs.endpoint_max_context = lambda url, ttl=60.0: fake_probe
    check("ctx_window uses the polled value when present", st.ctx_window() == fake_probe, str(fake_probe))
    hs.endpoint_max_context = lambda url, ttl=60.0: None       # engine silent -> fallback
    check("ctx_window falls back to the runtime constant when the engine is silent",
          st.ctx_window() == FALLBACK, str(FALLBACK))
finally:
    hs.endpoint_max_context = saved

if real is None:
    skip("live engine /health unreachable -- live equality check skipped (no false red)")
else:
    # The heart of the gate: with no env override, the gateway's denominator MUST equal the
    # number the frontend panel shows (both come from this same /health). One number, no split.
    check("gateway denominator == the frontend's real window", resolved == real,
          "gateway=" + str(resolved) + " frontend=" + str(real))
    # Discrimination has power only when the real window differs from the runtime fallback.
    # When the operator deliberately set the real window == fallback (2026-10-23: 131072), the
    # live equality above IS the proof; do not turn that into a false red here.
    if real != FALLBACK:
        check("and that is NOT the runtime fallback constant (the denominator learned)",
              resolved != FALLBACK, "resolved=" + str(resolved))
    else:
        skip("real window == runtime fallback (operator-set); equality is the proof,"
             " discrimination delegated to the mechanism tests above")

# Env override always wins, in both directions, regardless of the poll.
st_env = hs.GatewayState(ENGINE_URL)
st_env._ctx_env = "200000"
st_env.max_context = FALLBACK
check("explicit env override beats the poll", st_env.ctx_window() == 200000, str(st_env.ctx_window()))

# The real-world trigger math: a chat at ~46% of the REAL window must NOT fire the 92% guard,
# while the OLD fallback denominator would have (the bug). Only meaningful when the real window
# is larger than the fallback; when they are equal the split cannot exist, so this is skipped.
lp = 121000
win = st.ctx_window()
guard_fires = bool(win) and lp >= int(win * 0.92)
old_fires = lp >= int(FALLBACK * 0.92)
if real is not None and resolved == real and resolved > FALLBACK:
    check("46%-of-real no longer trips the guard (the bug is gone)", guard_fires is False,
          "pct=" + str(round(100 * lp / win)))
    check("the old fallback denominator WOULD have fired (proves the split)", old_fires is True)
else:
    skip("real window == fallback -> no double-denominator split to demonstrate; trigger math skipped")

# ── Per-model DECLARED window (the custom-endpoint fix) ────────────────────────────
# A custom model whose endpoint never answers /health in JSON (cloud APIs, the 47831
# front-instance that returns HTML) cannot be polled for n_ctx, so it declares
# context_window / native_ctx in model_registry. A per-model declaration is the most
# specific statement about THIS model, so it wins over the machine-wide env override and
# over the poll. Back-compat: an entry that declares nothing keeps the old order unchanged.
import importlib as _il
sys.path.insert(0, os.path.join(ROOT, "serve"))
_mr = _il.import_module("model_registry")

_declared = 262144
check("ctx_window reads a per-model DECLARED context_window",
      st.ctx_window({"context_window": _declared}) == _declared,
      str(st.ctx_window({"context_window": _declared})))
check("native_ctx alias is honored too",
      st.ctx_window({"native_ctx": _declared}) == _declared,
      str(st.ctx_window({"native_ctx": _declared})))
# a declared window on a model wins even over the machine-wide env override
check("a DECLARED per-model window beats the env override (more specific)",
      st_env.ctx_window({"context_window": _declared}) == _declared,
      str(st_env.ctx_window({"context_window": _declared})))
# back-compat: an entry that declares nothing keeps the existing order (here env still wins)
check("no declaration -> unchanged behavior (env still wins)",
      st_env.ctx_window(None) == 200000 and st_env.ctx_window({}) == 200000,
      str(st_env.ctx_window(None)))
# the normalize layer keeps the field, so the registry round-trips a declared window
_norm = _mr.normalize_entry({"kind": "custom", "base_url": "http://x/v1",
                             "model": "m", "context_window": _declared})
check("model_registry.normalize_entry keeps context_window",
      _norm.get("context_window") == _declared, str(_norm.get("context_window")))

print("\nCTX-DENOMINATOR: " + ("ALL PASSED" if not FAILURES else "FAILURES: " + ", ".join(FAILURES)))
sys.exit(0 if not FAILURES else 1)
