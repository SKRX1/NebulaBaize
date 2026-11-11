"""B1 session_stream offline differential test (pure stdlib, no network).

Covers the NEW pure logic added by Plan B (token-level SSE streaming):
  1. GatewayState broadcaster: fan-out to N subscribers, full-queue skip (never
     blocks the scheduler thread), unsubscribe stops delivery.
  2. llm_client on_delta: a content delta fires the callback; a tool_call delta
     does NOT; with NO callback the turn still aggregates correctly (differential).
  3. planner passthrough: plan() forwards a non-None on_delta to client.chat.

ASCII-only output (Chinese strings get eaten through pipes on a GBK console).
Exit 0 => green.
"""
import sys
import os
import time
import queue as _queue

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "runtime"))

from http_server import GatewayState
from llm_client import StrataClient
from planner import Planner

FAILS = [0]


def check(name, cond):
    if cond:
        print(f"  PASS {name}")
    else:
        print(f"  FAIL {name}")
        FAILS[0] += 1


# ── Test 1: broadcaster fan-out / full-skip / unsubscribe ──────────────────
print("[T1] broadcaster")
gs = GatewayState(upstream_url="http://x")
q1 = gs.subscribe_stream()
q2 = gs.subscribe_stream()
gs.broadcast_stream({"session_name": "job", "text": "tok", "done": False})
check("T1.fanout.sub1", q1.get_nowait() == {"session_name": "job", "text": "tok", "done": False})
check("T1.fanout.sub2", q2.get_nowait() == {"session_name": "job", "text": "tok", "done": False})

# full-queue skip: a subscriber whose queue is full must NOT block broadcast
full = gs.subscribe_stream()
for i in range(1000):                       # subscribe_stream maxsize=1000
    full.put_nowait({"fill": i})
t0 = time.monotonic()
gs.broadcast_stream({"session_name": "job", "text": "live", "done": False})
elapsed = time.monotonic() - t0
check("T1.full_skip.no_block", elapsed < 0.2)
check("T1.full_skip.other_delivered", q2.get_nowait()["text"] == "live")
check("T1.full_skip.q1_also_got_live", q1.get_nowait()["text"] == "live")  # drain before unsubscribe

# unsubscribe: q1 leaves, a later broadcast reaches only q2/full
gs.unsubscribe_stream(q1)
gs.broadcast_stream({"session_name": "job", "text": "after", "done": False})
check("T1.unsubscribe.stopped", q1.empty())
check("T1.unsubscribe.q2_got", q2.get_nowait()["text"] == "after")

# ── Test 2: llm_client on_delta differential ───────────────────────────────
print("[T2] llm_client on_delta")


class FakeResp:
    def __init__(self, lines):
        self._lines = [l.encode("utf-8") for l in lines]
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False
    def __iter__(self):
        return iter(self._lines)


SSE = [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
    'data: {"choices":[{"delta":{"content":" world"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"x","arguments":"{}"}}]}}]}',
    'data: [DONE]',
]

# with callback: content deltas fire it, tool_call delta must NOT
c = StrataClient()
c._open = lambda req: FakeResp(SSE)
seen = []
turn = c.chat([{"role": "user", "content": "x"}], stream=True, on_delta=lambda d: seen.append(d))
check("T2.callback_content_only", seen == ["Hello", " world"])
check("T2.aggregate_content", turn.content == "Hello world")

# differential: no callback, aggregation still correct, no crash
c2 = StrataClient()
c2._open = lambda req: FakeResp(SSE)
turn2 = c2.chat([{"role": "user", "content": "x"}], stream=True)
check("T2.differential.no_cb_aggregate", turn2.content == "Hello world")

# ── Test 3: planner forwards on_delta to client.chat ───────────────────────
print("[T3] planner passthrough")


class RecordingClient:
    def __init__(self):
        self.got_on_delta = "UNSET"
    def chat(self, messages, tools=None, effort=None, on_delta=None):
        self.got_on_delta = on_delta
        from llm_client import AssistantTurn
        return AssistantTurn(content="ok", tool_calls=[])


rc = RecordingClient()
p = Planner(rc, [])
p.plan([{"role": "user", "content": "x"}], on_delta=lambda d: None)
check("T3.planner.forwards_on_delta", rc.got_on_delta is not None and callable(rc.got_on_delta))

# default (no on_delta) stays None so the interactive path is unaffected
rc2 = RecordingClient()
p2 = Planner(rc2, [])
p2.plan([{"role": "user", "content": "x"}])
check("T3.planner.default_none", rc2.got_on_delta is None)

print(f"TOTAL FAILS: {FAILS[0]}")
sys.exit(1 if FAILS[0] else 0)
