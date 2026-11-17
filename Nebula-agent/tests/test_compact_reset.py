# -*- coding: utf-8 -*-
"""Unit test for the GatewayState prompt-token bookkeeping used by the compaction fix.

The compaction escape hatch works only if the gateway can forget a session's old (near-full)
occupancy when a compact request arrives (see http_server._agent_stream / reset_prompt_tokens):
  * record_prompt_tokens(session, n) -> prompt_tokens_for(session) == n
  * reset_prompt_tokens(session)      -> prompt_tokens_for(session) == 0  (clean slate)
  * recording 0 is a no-op (must not wedge a key at a falsy value)
Pure standard library; registers in tools/run_tests.py.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
from http_server import GatewayState  # noqa: E402

fails = []


def check(name, cond):
    print(("OK   " if cond else "FAIL ") + name)
    if not cond:
        fails.append(name)


st = GatewayState.__new__(GatewayState)          # bypass __init__ (needs runtime state)
st._prompt_tokens_by_session = {}
st._session_order = []
st._session_cap = 8

SID = "compact-session-1"

st.record_prompt_tokens(SID, 120000)
check("record then read returns the stored value", st.prompt_tokens_for(SID) == 120000)

st.reset_prompt_tokens(SID)
check("reset zeroes the tracked occupancy", st.prompt_tokens_for(SID) == 0)

st.record_prompt_tokens(SID, 0)                  # engine never reported usage
check("recording 0 is a no-op (no false key)", st.prompt_tokens_for(SID) == 0)

st.record_prompt_tokens(SID, 500)
check("can record again after reset", st.prompt_tokens_for(SID) == 500)

check("unknown session reads 0", st.prompt_tokens_for("never-seen") == 0)

if fails:
    print("\nFAILED: " + ", ".join(fails))
    sys.exit(1)
print("\nALL COMPACT-RESET TESTS PASSED")
