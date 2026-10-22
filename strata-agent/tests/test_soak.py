# -*- coding: utf-8 -*-
"""Soak regression gate (layer ②) — in-process, deterministic, CI-safe.

Runs a SHORT long-session soak through the real `_agent_stream` loop (only the
engine is faked) and asserts the hard invariants that define "no long-session
leak / no drift / no runaway loop":

  * the (long) turn always ends with [DONE] (never a silent disconnect),
  * no raw <function=...>/<tool_call> markup survives into the prompt history,
  * every executed tool call is a known, well-formed name,
  * the narration / length-finish guards keep the loop from spinning to max_rounds,
  * tool calls actually executed (the loop did real work),
  * the session's Chinese-think adherence is reported as a real float.

The multi-hour REAL-engine soak is run separately (tools/soak_runner.py --gateway-url).

Run: python tests/test_soak.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

from soak_runner import soak_in_process  # noqa: E402

OK = []


def check(name, cond, extra=""):
    if not cond:
        raise AssertionError(f"FAIL: {name} {extra}")
    OK.append(name)
    print(f"  ok  {name}")


def main() -> int:
    try:
        rep = soak_in_process(rounds=18)
        print(f"  soak report: {rep}")
        check("soak overall ok", rep["ok"], rep)
        check("ended with [DONE]", rep["ended_with_done"], rep)
        check("no leaked markup in history", not rep["leaked_markup"], rep)
        check("all tool calls known/well-formed", rep["all_tools_known"], rep)
        check("did real work (tool calls > 0)", rep["tool_calls"] > 0, rep)
        check("loop did not spin to max_rounds", not rep["narration_capped"], rep)
        check("chinese-think ratio is a float >= 0.5",
              isinstance(rep["chinese_think_ratio"], float)
              and rep["chinese_think_ratio"] >= 0.5, rep)
        check("rss_source resolved", rep["rss_source"] in ("resource", "n/a"), rep)
        print(f"\nSOAK: {len(OK)} checks passed")
        return 0
    except AssertionError as e:
        print(f"\nSOAK: FAILED -> {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
