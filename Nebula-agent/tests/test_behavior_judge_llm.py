# -*- coding: utf-8 -*-
"""Behavior judge — LLM-as-judge wiring (B-layer).

Locks:
  * with no JUDGE_URL/JUDGE_MODEL set, judge_turn stays heuristic-only (no llm_judge check)
  * with both set, judge_llm is actually called and its verdict folds into the turn:
      - PASS  -> turn still ok
      - FAIL  -> turn hard-fails on llm_judge
  * a failed judge HTTP call degrades gracefully (applied=False) — never red the suite
    just because the judge model is down.

Run:  python tests/test_behavior_judge_llm.py
"""
import os
import json
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import behavior_judge as bj  # noqa: E402

PASS_BODY = json.dumps({"choices": [{"message": {"content":
    "PASS 中文思考充分，工具调用合规，无泄漏，收尾干净。"}}]})
FAIL_BODY = json.dumps({"choices": [{"message": {"content":
    "FAIL 思考混入了大量英文，违反强制中文思考。"}}]})


class _Monkey:
    """Minimal monkeypatch: set attr, restore on exit."""
    def __init__(self):
        self._saved = []

    def setattr(self, obj, name, val):
        self._saved.append((obj, name, getattr(obj, name, _MISSING)))
        setattr(obj, name, val)

    def delenv(self, key):
        had = key in os.environ
        val = os.environ.pop(key, None)
        self._saved.append(("_env", key, (had, val)))

    def setenv(self, key, val):
        had = key in os.environ
        old = os.environ.get(key)
        os.environ[key] = val
        self._saved.append(("_env", key, (had, old)))

    def __enter__(self):
        return self

    def __exit__(self, *a):
        for entry in reversed(self._saved):
            if entry[0] == "_env":
                _, key, (had, old) = entry
                if had:
                    os.environ[key] = old
                else:
                    os.environ.pop(key, None)
            else:
                obj, name, old = entry
                if old is _MISSING:
                    delattr(obj, name)
                else:
                    setattr(obj, name, old)
        return False


_MISSING = object()


class _FakeResp:
    def __init__(self, text):
        self._t = text.encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self._t


def _patch_urlopen(mp, body: str):
    def fake(req, timeout=30):
        return _FakeResp(body)
    mp.setattr(bj.urllib.request, "urlopen", fake)


GOOD_TURN = {"id": 0, "content": "已完成构建。",
             "reasoning_content": "正在执行第 1 步，先把内容写入文件。",
             "tool_calls": []}


def _names(checks):
    return {c["name"] for c in checks}


def test_no_model_no_llm():
    with _Monkey() as mp:
        mp.delenv("JUDGE_URL")
        mp.delenv("JUDGE_MODEL")
        r = bj.judge_turn(GOOD_TURN)
    assert "llm_judge" not in _names(r["checks"]), "llm must not run without config"
    assert r["ok"] is True


def test_llm_pass_keeps_ok():
    with _Monkey() as mp:
        mp.setenv("JUDGE_URL", "http://127.0.0.1:9999/v1")
        mp.setenv("JUDGE_MODEL", "judge-model")
        _patch_urlopen(mp, PASS_BODY)
        r = bj.judge_turn(GOOD_TURN, use_llm=True)
    assert "llm_judge" in _names(r["checks"]), "llm_judge must appear when configured"
    llm = [c for c in r["checks"] if c["name"] == "llm_judge"][0]
    assert llm["ok"] is True
    assert r["ok"] is True


def test_llm_fail_hard():
    with _Monkey() as mp:
        mp.setenv("JUDGE_URL", "http://127.0.0.1:9999/v1")
        mp.setenv("JUDGE_MODEL", "judge-model")
        _patch_urlopen(mp, FAIL_BODY)
        leaky = dict(GOOD_TURN, content="done",
                     reasoning_content="now doing step one in English which is wrong")
        r = bj.judge_turn(leaky, use_llm=True)
    llm = [c for c in r["checks"] if c["name"] == "llm_judge"][0]
    assert llm["ok"] is False
    assert r["ok"] is False  # LLM FAIL must be a hard failure, not cosmetic


def test_llm_call_failure_degrades():
    with _Monkey() as mp:
        mp.setenv("JUDGE_URL", "http://127.0.0.1:9999/v1")
        mp.setenv("JUDGE_MODEL", "judge-model")

        def boom(req, timeout=30):
            raise RuntimeError("judge model 500")
        mp.setattr(bj.urllib.request, "urlopen", boom)
        r = bj.judge_turn(GOOD_TURN, use_llm=True)
    # even if the judge call blows up, the turn must still be judged by heuristics
    assert "llm_judge" not in _names(r["checks"])
    assert r["ok"] is True


if __name__ == "__main__":
    funcs = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    ok = 0
    for f in funcs:
        f()
        print(f"  ok  {f.__name__}")
        ok += 1
    print(f"behavior_judge_llm: {ok} checks passed")
