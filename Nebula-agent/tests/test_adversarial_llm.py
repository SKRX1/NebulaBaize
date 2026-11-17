# -*- coding: utf-8 -*-
"""Drive every scenario in tests/_adversarial.py through the REAL agent loop.

Per-commit gate asserting the two invariants that define "no silent failure":
  * every turn terminates with `[DONE]` (never a silent disconnect), and
  * a call that arrived as text is recovered, executed, and stripped from the
    history the model sees next round (never leaked as markup it misreads).

Run: python tests/test_adversarial_llm.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _adversarial import SCENARIOS, fresh_state, run  # noqa: E402

OK = []


def check(name, cond, extra=""):
    if not cond:
        raise AssertionError(f"FAIL: {name} {extra}")
    OK.append(name)
    print(f"  ok  {name}")


def main() -> int:
    try:
        for name, sc in SCENARIOS.items():
            print(f"\n=== {name} ===")
            st = fresh_state(sc.get("behavior"))
            h, ev = run(st, sc["sequences"], "adv-" + name)
            check(f"[{name}] ends with [DONE]", bool(ev) and ev[-1] == "[DONE]", ev[-1:])
            sc["expect"](h, ev, st, check, name)
        print(f"\nADVERSARIAL-LLM: {len(OK)} checks passed")
        return 0
    except AssertionError as e:
        print(f"\nADVERSARIAL-LLM: FAILED -> {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
