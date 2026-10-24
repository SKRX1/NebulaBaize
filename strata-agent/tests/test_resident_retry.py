# -*- coding: utf-8 -*-
"""Differential gate for the resident-contention vs true-overflow split (2026-10-24).

Root cause it locks (the "panel shows 53% but it said context overflow" report): a 400 from
the upstream is NOT always "the window is full". On a SHARED engine the n_ctx window is per
conversation, but the resident KV pool (--kv-resident, the conversation cache across ALL live
sessions) is shared; a request can be refused the moment it triggers an eviction, before room
is reserved for its own output. That refusal is contention, not a full window -- the honest
response is a quiet resend, and only after a resend fails do we say so.

overflow_action() is the pure decision; the gate pins every branch as a DIFFERENTIAL (each
decision needs the opposite to prove the input that drives it actually drives it):
  * under the guard line, never retried  -> retry        (quiet, invisible)
  * under the guard line, ALREADY retried-> notice_contention   <- the retry budget is ONE
  * at/over the guard line               -> compact     <- the guard line still binds
  * no usage recorded / window unknown   -> compact     <- a fresh chat is not a victim
  * exactly on the line                  -> compact     <- strict '<' so the line is exclusive
Assertions match only the ASCII category strings (the wording itself is Chinese and is NOT
matched here -- the ASCII-word rule). Pure standard library; registers in tools/run_tests.py.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
from http_server import overflow_action, _GUARD_FRACTION, _CONTENTION_TEXT  # noqa: E402

fails = []


def check(name, cond, extra=""):
    print(("OK   " if cond else "FAIL ") + name + ((" -> " + extra) if extra else ""))
    if not cond:
        fails.append(name)


WIN = 131072
LINE = int(WIN * _GUARD_FRACTION)               # the guard fraction, read from the module
UNDER = 70000                                    # ~53% -- the panel value from the report

# ── Differential pair: the retry budget is EXACTLY ONE (the crux of the gate) ──
check("under-line + first refusal -> retry (quiet resend)",
      overflow_action(UNDER, WIN, False) == "retry", "retry")
check("under-line + ALREADY retried -> notice_contention (budget is one)",
      overflow_action(UNDER, WIN, True) == "notice_contention", "notice_contention")

# ── The guard line still binds: a chat that IS near full compacts, never retries ──
check("at/over the guard line + first refusal -> compact (guard binds)",
      overflow_action(LINE + 1, WIN, False) == "compact", "compact")
check("exactly ON the line -> compact (strict '<' so the line is exclusive)",
      overflow_action(LINE, WIN, False) == "compact", "compact")

# ── A chat we cannot measure is not a contention victim: it compacts ──
check("no usage recorded (0) -> compact", overflow_action(0, WIN, False) == "compact", "compact")
check("window unknown (0) -> compact", overflow_action(UNDER, 0, False) == "compact", "compact")
check("both unknown -> compact", overflow_action(None, None, False) == "compact", "compact")

# ── The contention notice wording exists and is non-empty (Chinese body NOT matched here) ──
check("_CONTENTION_TEXT is a non-empty string", isinstance(_CONTENTION_TEXT, str) and len(_CONTENTION_TEXT) > 0)

if fails:
    print("\nFAILED: " + ", ".join(fails))
    sys.exit(1)
print("\nALL RESIDENT-RETRY TESTS PASSED")
