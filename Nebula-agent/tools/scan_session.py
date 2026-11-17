# -*- coding: utf-8 -*-
"""Session anomaly scanner.

Reads the per-turn (turns.jsonl) and per-round (rounds.jsonl) diagnostic logs the
gateway writes, and flags the "silent failure" signatures that previously surfaced
only as a user complaint + a screenshot:

  HARD (exit 1):
    * a turn has a `start` but no `end`                   -> process died / killed mid-flight
    * turn `ending` == "crash" or "client_gone"           -> abnormal termination
    * a round has call markup in text but nothing rescued -> leaked & unrecovered
    * turn ended `done` with ZERO tool calls/rescues AND a narration round
                                                          -> promise, no action
  SOFT (warning; --strict -> exit 1):
    * a turn ended `done` with a narration round in it     -> described instead of did

This is the meta-fix for "we always had to archaeology the bug from a screenshot":
it turns a user-reported symptom into a system-detected, machine-checkable signal.
Run it after a real session, or wire it into CI against captured logs.

Usage:
    python tools/scan_session.py [--dir LOGDIR] [--strict] [--json]
    exit 0 = no hard findings, 1 = hard findings, 2 = usage/IO error
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HARD, SOFT = "HARD", "SOFT"


def _load(path):
    if not os.path.exists(path):
        return []
    out = []
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                pass
    return out


def scan_judge(judge_lines):
    """Surface per-turn behavior-judge failures as HARD findings.

    `judge_stream.jsonl` is written asynchronously by the gateway after each turn
    (tools/behavior_judge.py). A `{"ok": false}` verdict means the turn finished but
    drifted on a soft instruction (e.g. raw call markup still in the user-visible text,
    an invalid tool call, an empty/finished-on-a-call turn) -- exactly the class the
    nightly judge exists to catch, now also caught near-real-time.
    """
    findings = []
    for r in judge_lines:
        if r.get("ok") is False:
            details = "; ".join(str(c.get("detail", "")) for c in (r.get("checks") or [])
                                if c.get("ok") is False)
            findings.append({"level": HARD, "code": "behavior_judge_fail", "session": r.get("session"),
                             "detail": f"per-turn behavior judge failed: {details}"})
    return findings


def scan(turn_lines, round_lines):
    """Return a list of finding dicts: {level, code, session, detail}."""
    findings = []
    turns = {}
    for r in turn_lines:
        turns.setdefault(r.get("session"), []).append(r)
    rounds = {}
    for r in round_lines:
        rounds.setdefault(r.get("session"), []).append(r)

    for sid, recs in turns.items():
        starts = [r for r in recs if r.get("kind") == "start"]
        ends = [r for r in recs if r.get("kind") == "end"]
        if starts and not ends:
            findings.append({"level": HARD, "code": "turn_no_end", "session": sid,
                             "detail": "a turn started but never recorded an end (died mid-flight?)"})
            continue
        for e in ends:
            ending = e.get("ending")
            if ending in ("crash", "client_gone"):
                findings.append({"level": HARD, "code": "abnormal_end", "session": sid,
                                 "detail": f"turn ended abnormally: {ending} ({e.get('detail')})"})
            elif ending == "done":
                rs = rounds.get(sid, [])
                any_call = any((r.get("calls") or []) or (r.get("rescued") or []) for r in rs)
                narrated = any(r.get("narration") for r in rs)
                leaked_unrecovered = any(r.get("call_markup_in_text")
                                        and not (r.get("rescued") or [])
                                        for r in rs)
                if leaked_unrecovered:
                    findings.append({"level": HARD, "code": "leaked_unrecovered",
                                     "session": sid,
                                     "detail": "call markup arrived as text but was not recovered"})
                if narrated and not any_call:
                    findings.append({"level": SOFT, "code": "narration_no_action",
                                     "session": sid,
                                     "detail": "turn ended after narration with no tool executed"})
    return findings


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    default_dir = os.path.join(os.path.dirname(here), "logs")
    ap = argparse.ArgumentParser(
        description="Scan gateway session logs for silent-failure signatures.")
    ap.add_argument("--dir", default=default_dir,
                    help="directory containing turns.jsonl / rounds.jsonl")
    ap.add_argument("--strict", action="store_true",
                    help="treat SOFT findings as failures too")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of text")
    args = ap.parse_args()

    if not os.path.isdir(args.dir):
        print(f"scan_session: no log dir {args.dir} -- nothing to scan")
        return 0
    turns = _load(os.path.join(args.dir, "turns.jsonl"))
    rounds = _load(os.path.join(args.dir, "rounds.jsonl"))
    judges = _load(os.path.join(args.dir, "judge_stream.jsonl"))
    if not turns and not rounds and not judges:
        print(f"scan_session: {args.dir} has no turn/round/judge logs -- nothing to scan")
        return 0

    findings = scan(turns, rounds)
    findings += scan_judge(judges)
    hard = [f for f in findings if f["level"] == HARD]
    soft = [f for f in findings if f["level"] == SOFT]

    if args.json:
        print(json.dumps({"dir": args.dir, "hard": hard, "soft": soft,
                          "scanned_turns": len(turns), "scanned_rounds": len(rounds),
                          "scanned_judge": len(judges)},
                         ensure_ascii=False, indent=2))
    else:
        print(f"scan_session: scanned {len(turns)} turn records, {len(rounds)} round records")
        for f in hard:
            print(f"  [HARD] {f['code']} session={f['session']}: {f['detail']}")
        for f in soft:
            print(f"  [SOFT] {f['code']} session={f['session']}: {f['detail']}")
        if not findings:
            print("  OK: no silent-failure signatures found")

    if hard:
        return 1
    if soft and args.strict:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
