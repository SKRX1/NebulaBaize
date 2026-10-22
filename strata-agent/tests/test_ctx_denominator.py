"""Resident regression gate: the context-window DENOMINATOR must be the engine's REAL n_ctx,
learned from its own /health -- not a hardcoded 128K fallback.

Root cause it locks (2026-10 report "panel shows 50% but the gateway said 92%"): the proactive
guard and the output cap used a hardcoded denominator (131072) that never learned the engine's
real n_ctx (here 262144). So a chat at ~46% of the REAL window read as 92% on the gateway side
and fired far too early. The fix is GatewayState.ctx_window() = env override > polled real
n_ctx > fallback, shared by the guard and compute_output_cap.

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

st = hs.GatewayState(ENGINE_URL)
resolved = st.ctx_window()

print("CONTEXT-WINDOW DENOMINATOR (no double denominator):")

if real is None:
    # Engine not answering /health: we cannot prove the denominator == real window right now.
    # Fall back to proving the mechanism on a fake, then SKIP the live equality check (no false red).
    print("  SKIP live engine /health unreachable -- mechanism-only checks below")
    # Mechanism: ctx_window must consult endpoint_max_context (the poll), and only fall back
    # to the 128K constant when that returns None.
    saved = hs.endpoint_max_context
    try:
        hs.endpoint_max_context = lambda url, ttl=60.0: 999000   # fake "engine says 999000"
        check("ctx_window uses the polled value when present", st.ctx_window() == 999000, str(resolved))
        hs.endpoint_max_context = lambda url, ttl=60.0: None       # engine silent -> fallback
        check("ctx_window falls back to the constant when engine is silent", st.ctx_window() == 131072)
    finally:
        hs.endpoint_max_context = saved
else:
    # The heart of the gate: with no env override, the gateway's denominator MUST equal the
    # number the frontend panel shows (both come from this same /health). One number, no split.
    check("gateway denominator == the frontend's real window", resolved == real,
          "gateway=" + str(resolved) + " frontend=" + str(real))
    check("and that is NOT the old hardcoded 128K fallback", resolved != 131072, "resolved=" + str(resolved))

# Env override always wins, in both directions, regardless of the poll.
st_env = hs.GatewayState(ENGINE_URL)
st_env._ctx_env = "200000"
st_env.max_context = 131072
check("explicit env override beats the poll", st_env.ctx_window() == 200000, str(st_env.ctx_window()))

# The real-world trigger math: a chat at ~46% of the REAL window must NOT fire the 92% guard,
# while the OLD 128K denominator would have (the bug). Uses whatever denominator is in force.
lp = 121000
win = st.ctx_window()
guard_fires = bool(win) and lp >= int(win * 0.92)
old_fires = lp >= int(131072 * 0.92)
if real is not None and resolved == real and resolved > 131072:
    check("46%-of-real no longer trips the guard (the bug is gone)", guard_fires is False,
          "pct=" + str(round(100 * lp / win)))
    check("the old 128K denominator WOULD have fired (proves the split)", old_fires is True)

print("\nCTX-DENOMINATOR: " + ("ALL PASSED" if not FAILURES else "FAILURES: " + ", ".join(FAILURES)))
sys.exit(0 if not FAILURES else 1)
