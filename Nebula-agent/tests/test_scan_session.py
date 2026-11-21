# -*- coding: utf-8 -*-
"""Unit test for tools/scan_session.py -- the anomaly scanner.

Drives it against crafted logs (no live gateway needed) and asserts it flags the
HARD silent-failure signatures and ignores clean sessions.

Run: python tests/test_scan_session.py
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))

import scan_session  # noqa: E402

OK = []


def check(name, cond, extra=""):
    if not cond:
        raise AssertionError(f"FAIL: {name} {extra}")
    OK.append(name)
    print(f"  ok  {name}")


def _logs(d, turns, rounds):
    with open(os.path.join(d, "turn.jsonl"), "w", encoding="utf-8") as f:
        for r in turns:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    with open(os.path.join(d, "rounds.jsonl"), "w", encoding="utf-8") as f:
        for r in rounds:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def _scan(d):
    return scan_session.scan(
        scan_session._load(os.path.join(d, "turn.jsonl")),
        scan_session._load(os.path.join(d, "rounds.jsonl")))


def main() -> int:
    try:
        # 1) a turn that started but never ended -> HARD turn_no_end
        d = tempfile.mkdtemp()
        _logs(d, [{"kind": "start", "session": "s1", "model": "strata"}],
              [{"session": "s1", "round": 1, "finish": "stop", "calls": ["shell__exec"]}])
        f = _scan(d)
        check("start-without-end flagged HARD", any(x["code"] == "turn_no_end" for x in f), f)

        # 2) a clean turn (done, had a call) -> no findings
        d = tempfile.mkdtemp()
        _logs(d,
              [{"kind": "start", "session": "s2"},
               {"kind": "end", "session": "s2", "ending": "done"}],
              [{"session": "s2", "round": 1, "finish": "tool_calls", "calls": ["filesystem__write"],
                "rescued": [], "call_markup_in_text": False, "narration": False}])
        check("clean turn flagged nothing", _scan(d) == [], _scan(d))

        # 3) leaked markup but not recovered -> HARD leaked_unrecovered
        d = tempfile.mkdtemp()
        _logs(d,
              [{"kind": "start", "session": "s3"},
               {"kind": "end", "session": "s3", "ending": "done"}],
              [{"session": "s3", "round": 1, "finish": "stop", "calls": [], "rescued": [],
                "call_markup_in_text": True, "narration": False}])
        f = _scan(d)
        check("leaked_unrecovered flagged HARD",
              any(x["code"] == "leaked_unrecovered" for x in f), f)

        # 4) narration + no action -> SOFT only (not hard)
        d = tempfile.mkdtemp()
        _logs(d,
              [{"kind": "start", "session": "s4"},
               {"kind": "end", "session": "s4", "ending": "done"}],
              [{"session": "s4", "round": 1, "finish": "stop", "calls": [], "rescued": [],
                "call_markup_in_text": False, "narration": True}])
        f = _scan(d)
        check("narration_no_action is SOFT only",
              any(x["code"] == "narration_no_action" for x in f)
              and not any(x["level"] == "HARD" for x in f), f)

        # 5) crash / client_gone endings -> HARD abnormal_end
        for ending in ("crash", "client_gone"):
            d = tempfile.mkdtemp()
            _logs(d,
                  [{"kind": "start", "session": "sx"},
                   {"kind": "end", "session": "sx", "ending": ending, "detail": "boom"}],
                  [])
            f = _scan(d)
            check(f"{ending} flagged HARD", any(x["code"] == "abnormal_end" for x in f), f)

        # 6) the CLI exits 1 on a hard finding, 0 on clean
        d = tempfile.mkdtemp()
        _logs(d,
              [{"kind": "start", "session": "s6"},
               {"kind": "end", "session": "s6", "ending": "client_gone"}],
              [])
        old = sys.argv
        sys.argv = ["scan_session", "--dir", d]
        try:
            rc = scan_session.main()
        finally:
            sys.argv = old
        check("CLI exits 1 on hard finding", rc == 1, rc)

        d = tempfile.mkdtemp()
        _logs(d,
              [{"kind": "start", "session": "s7"},
               {"kind": "end", "session": "s7", "ending": "done"}],
              [{"session": "s7", "round": 1, "calls": ["shell__exec"]}])
        old = sys.argv
        sys.argv = ["scan_session", "--dir", d]
        try:
            rc = scan_session.main()
        finally:
            sys.argv = old
        check("CLI exits 0 on clean", rc == 0, rc)

        # 7) a failed per-turn behavior judge verdict in judge_stream.jsonl -> HARD
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "judge_stream.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"session": "sj", "ending": "done", "ok": False,
                               "checks": [{"name": "no_xml_leak", "ok": False,
                                           "detail": "raw call markup leaked"}]},
                              ensure_ascii=False) + "\n")
        fj = scan_session.scan_judge(
            scan_session._load(os.path.join(d, "judge_stream.jsonl")))
        check("judge failure flagged HARD", any(x["code"] == "behavior_judge_fail" for x in fj), fj)
        # a passing verdict must NOT flag anything
        with open(os.path.join(d, "judge_stream.jsonl"), "w", encoding="utf-8") as f:
            f.write(json.dumps({"session": "sj2", "ending": "done", "ok": True,
                               "checks": [{"name": "no_xml_leak", "ok": True, "detail": "clean"}]},
                              ensure_ascii=False) + "\n")
        check("judge pass flagged nothing",
              scan_session.scan_judge(
                  scan_session._load(os.path.join(d, "judge_stream.jsonl"))) == [], "unexpected")

        print(f"\nSCAN-SESSION: {len(OK)} checks passed")
        return 0
    except AssertionError as e:
        print(f"\nSCAN-SESSION: FAILED -> {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
