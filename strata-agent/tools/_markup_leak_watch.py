r"""Markup-leak watch anchor (lightweight, observation-only -- NOT a CI gate).

Reads logs/rounds.jsonl and reports, per REAL session, the fraction of rounds where the
model leaked call markup into answer text AND it was not rescued
(call_markup_in_text == True and rescued == []). That is exactly the "plan-code segment"
symptom the user saw on screen.

HONESTY NOTE on the metric: "leak" counts BOTH kinds that look identical on screen:
  (a) a real hallucinated call (e.g. the model emitted a fake tool named "plan"), and
  (b) legitimate prose that merely *mentions* the call format ("<function=NAME>", source
      comments) -- which the parser deliberately leaves in place and is NOT a bug.
So a WARN means "worth a human glance at what the leaked markup actually is", NOT a
hard "must fold now". The fold decision is made by a human reading the flagged rows.

Decision rule (2026-10-23): keep display as-is (no fold) while leaks stay rare. The fold
layer only earns its cost once a single session reliably recurs past THIS WATCH LINE.
Watch line default = 10% (one leak in ten rounds). Below it -> OK, hold current behavior.
Above it -> WARN.

Two honesty guards so test-fixture noise can't fake a verdict:
  * TEST-FIXTURE NAME FAMILIES are excluded from the verdict (adv-*/s-*/cap-*/effort-*/
    stream-*/soak-*/A/B/sess-* are CI stubs, not real chat; a real session is 8-hex-uuid).
  * MIN SAMPLE gate: a session counts toward WARN only if it has >= MIN_ROUNDS rounds,
    so a 4-round blip can't "reliably recur".

Pure-ASCII output only (Chinese print through a pipe/code page gets swallowed).
Run any time; it is read-only.

Usage: python tools\_markup_leak_watch.py [watch_pct]   (watch_pct as fraction, default 0.10)
"""
import os
import sys
import io
import json

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(os.path.dirname(HERE), "logs", "rounds.jsonl")

WATCH = 0.10
for _a in sys.argv[1:]:
    try:
        WATCH = float(_a)
        break
    except ValueError:
        pass

MIN_ROUNDS = 10
TEST_PREFIXES = ("adv-", "s-", "cap-", "effort-", "stream-", "soak-", "sess-")
TEST_EXACT = {"A", "B"}


def is_real(name: str) -> bool:
    if name in TEST_EXACT:
        return False
    for p in TEST_PREFIXES:
        if name.startswith(p):
            return False
    return len(name) == 8 and all(c in "0123456789abcdef" for c in name)


rows = []
with io.open(LOG, encoding="utf-8") as fh:
    for line in fh:
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            pass

sessions = {}
for r in rows:
    s = (r.get("session") or "?")[:8]
    d = sessions.setdefault(s, {"total": 0, "leak": 0, "rescued": 0})
    d["total"] += 1
    if r.get("call_markup_in_text") and not r.get("rescued"):
        d["leak"] += 1
    if r.get("rescued"):
        d["rescued"] += 1

print("markup-leak watch | total rows=%d | watch line=%.0f%% | min sample=%d rounds"
      % (len(rows), WATCH * 100, MIN_ROUNDS))
print("=" * 66)
print("REAL sessions (8-hex uuid) only -- test fixtures excluded from verdict")
print("-" * 66)
flagged = 0
for s, d in sorted(sessions.items(), key=lambda kv: (kv[1]["leak"], kv[1]["total"]), reverse=True):
    if not is_real(s) or d["total"] == 0:
        continue
    rate = d["leak"] / d["total"]
    eligible = d["total"] >= MIN_ROUNDS
    if eligible and rate > WATCH:
        verdict = "WARN"
        flagged += 1
    else:
        verdict = "OK"
    tag = "" if eligible else "  (below min sample, info only)"
    print("%s sess=%s total=%3d leak=%d rescued=%d rate=%5.1f%%%s" % (
        verdict, s, d["total"], d["leak"], d["rescued"], rate * 100, tag))
print("-" * 66)
print("REAL sessions past watch line: %d" % flagged)
print("VERDICT: %s" % ("GLANCE (a real session past watch line -- human reads the rows)"
                       if flagged else "HOLD CURRENT (no real session past watch line)"))
print("NOTE: 'leak' mixes hallucinated calls + legit format prose; WARN is a nudge to read, not a mandate.")
