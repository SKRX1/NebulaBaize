# -*- coding: utf-8 -*-
"""Smoke test for the near-real-time per-turn behavior judge.

Drives GatewayHandler._async_judge_turn directly. The method only needs module-level
globals (ROOT/os/time/json/threading) plus a dummy self, and writes a verdict to
logs/judge_stream.jsonl (redirected to a temp dir via STRATA_JUDGE_DIR). Confirms:
  * a clean turn -> ok True
  * leaked markup in the USER-VISIBLE text -> ok False (no_xml_leak)
so scan_session.py will surface it as HARD.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from http_server import GatewayHandler  # noqa: E402


class _Dummy:
    pass


def _read(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def test_judge_writes_verdict_and_flags_leak():
    d = tempfile.mkdtemp()
    os.environ["STRATA_JUDGE_DIR"] = d
    try:
        h = _Dummy()
        GatewayHandler._async_judge_turn(
            h, "s-clean",
            {"reasoning": "先思考再写", "tool_calls": [], "content": "完成。"},
            "完成。", "done", {"filesystem__write"})
        GatewayHandler._async_judge_turn(
            h, "s-leak",
            {"reasoning": "思考", "tool_calls": [], "content": "写好了。</function>"},
            "写好了。</function>", "done", {"filesystem__write"})

        # Wait until BOTH sessions have landed (each turn judge runs in its own
        # daemon thread; the write is lock-serialized, but scheduling order varies).
        deadline = time.time() + 15
        by_s = {}
        while time.time() < deadline:
            recs = _read(os.path.join(d, "judge_stream.jsonl"))
            by_s = {r["session"]: r for r in recs}
            if "s-clean" in by_s and "s-leak" in by_s:
                break
            time.sleep(0.05)
        recs = _read(os.path.join(d, "judge_stream.jsonl"))
        assert "s-clean" in by_s, recs
        assert "s-leak" in by_s, recs
        assert by_s["s-clean"]["ok"] is True, by_s["s-clean"]
        assert by_s["s-leak"]["ok"] is False, by_s["s-leak"]
        bad = {c["name"] for c in by_s["s-leak"]["checks"] if c["ok"] is False}
        assert "no_xml_leak" in bad, by_s["s-leak"]
        print("  ok  async judge wrote verdicts and flagged the leak")
    finally:
        os.environ.pop("STRATA_JUDGE_DIR", None)


if __name__ == "__main__":
    test_judge_writes_verdict_and_flags_leak()
    print("async_judge: all checks passed")
