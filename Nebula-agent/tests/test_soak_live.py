# -*- coding: utf-8 -*-
"""Live soak driver — wiring + reachability gate (A-layer).

Locks:
  * gateway unreachable (and --require-engine off) -> neutral report, ok=None, no crash
  * reachable + a scripted stream -> runs N turns, judges each, ok True, turns_run==N
  * when a real engine is actually up, a short live soak is attempted as best-effort
    evidence (environment-dependent; a hiccup does not red the suite).

Run:  python tests/test_soak_live.py
"""
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import soak_runner as sr  # noqa: E402


class _Monkey:
    def __init__(self):
        self._saved = []

    def setattr(self, obj, name, val):
        self._saved.append((obj, name, getattr(obj, name, _MISSING)))
        setattr(obj, name, val)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        for obj, name, old in reversed(self._saved):
            if old is _MISSING:
                delattr(obj, name)
            else:
                setattr(obj, name, old)
        return False


_MISSING = object()

SAMPLE_SSE = (
    'data: {"choices":[{"delta":{"content":"完成。"}}]}\n\n'
    'data: [DONE]\n\n'
)


def test_unreachable_neutral():
    with _Monkey() as mp:
        mp.setattr(sr, "_probe", lambda url, timeout=3.0: False)
        rep = sr.soak_live("http://127.0.0.1:9", "strata", 3, ["x"], require_engine=False)
    assert rep.get("reachable") is False, rep
    assert rep.get("ok") is None, "should be neutral (skip), not a hard failure"
    assert "error" in rep


def test_scripted_live_runs_all_turns():
    with _Monkey() as mp:
        mp.setattr(sr, "_probe", lambda url, timeout=3.0: True)
        mp.setattr(sr, "_post_json", lambda url, payload: SAMPLE_SSE)
        d = tempfile.mkdtemp()
        rep = sr.soak_live("http://127.0.0.1:8099", "strata", 4,
                           ["第一步", "第二步"], require_engine=False, report_dir=d)
    assert rep.get("reachable") is True
    assert rep["turns_run"] == 4, rep
    assert rep["ok"] is True, rep
    # turns persisted for the downstream judge/scan
    assert os.path.exists(os.path.join(d, "soak_turns.jsonl"))


def test_real_live_if_up():
    """Best-effort: only meaningful when 8099+8080 are actually running."""
    if not sr._probe("http://127.0.0.1:8099/api/models"):
        print("  skip real live soak (gateway down)")
        return
    try:
        d = tempfile.mkdtemp()
        rep = sr.soak_live("http://127.0.0.1:8099", "strata", 2,
                           ["请用一句话介绍北京。"], require_engine=False, report_dir=d)
    except Exception as e:
        print(f"  warn real live soak raised (engine-dependent): {e}")
        return
    assert rep.get("reachable") is True, rep
    print(f"  ok  real live soak: turns_run={rep.get('turns_run')} "
          f"tools={rep.get('tool_calls')} ok={rep.get('ok')}")


if __name__ == "__main__":
    funcs = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    ok = 0
    for f in funcs:
        f()
        print(f"  ok  {f.__name__}")
        ok += 1
    print(f"soak_live: {ok} checks passed")
