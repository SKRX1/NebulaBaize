# -*- coding: utf-8 -*-
"""Regression for the bug-capture bridge.

  * capture_scenario.py writes a valid, de-duplicated entry to user_scenarios.json
  * _adversarial._load_user_scenarios() turns each entry into a runnable scenario
    that the REAL loop accepts and that ends with [DONE] (+ no markup leak for xml)

Uses a TEMP json so the repo's real user_scenarios.json is never touched by the test.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tests"))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

import _adversarial as adv  # noqa: E402

_XML_CONTENT = ("这就是头部文件。\n<tool_call>\n<function=filesystem__write>\n"
                "<parameter=path>\n_build/00_head.html\n</parameter>\n"
                "<parameter=content>\n<html><head></head></html>\n</parameter>\n"
                "</function>\n</tool_call>\n")


def _capture(tmp_path, name, kind, content, desc=""):
    out = os.path.join(tmp_path, "user_scenarios.json")
    subprocess.run([sys.executable, os.path.join(ROOT, "tools", "capture_scenario.py"),
                   "--name", name, "--kind", kind, "--content", content,
                   "--desc", desc, "--out", out], check=True)
    return out


def test_capture_writes_valid_entry():
    d = tempfile.mkdtemp()
    out = _capture(d, "demo_drift", "narration", "接下来开始构建。", "模型只描述")
    data = json.loads(open(out, encoding="utf-8").read())
    assert any(e["name"] == "demo_drift" and e["kind"] == "narration" for e in data), data
    # de-dup: re-capturing the same name must not duplicate.
    out2 = _capture(d, "demo_drift", "narration", "再次只描述。")
    data2 = json.loads(open(out2, encoding="utf-8").read())
    assert sum(1 for e in data2 if e["name"] == "demo_drift") == 1, data2


def test_loader_produces_runnable_scenario():
    d = tempfile.mkdtemp()
    out = _capture(d, "demo_xml", "xml", _XML_CONTENT)
    loaded = adv._load_user_scenarios(out)
    assert len(loaded) >= 1, loaded
    name, seq, expect, desc = loaded[0]
    assert name == "user_demo_xml"
    # Drive it through the REAL loop — must not raise, must terminate with [DONE].
    st = adv.fresh_state()
    h, ev = adv.run(st, seq, session="s-user")
    assert ev[-1] == "[DONE]", ev[-1:]
    # For an xml scenario the user-visible stream must be clean.
    assert not adv.visible_has_markup(ev), adv.visible_content(ev)[:160]
    # The inherited per-commit expect closure should also hold.
    checks = []
    def check(label, ok, ctx=None):
        checks.append(ok)
        return ok
    expect(h, ev, st, check, "demo_xml")
    assert all(checks), checks


def test_loader_handles_missing_or_empty():
    d = tempfile.mkdtemp()
    missing = os.path.join(d, "nope.json")
    assert adv._load_user_scenarios(missing) == []
    empty = os.path.join(d, "empty.json")
    open(empty, "w", encoding="utf-8").write("[]")
    assert adv._load_user_scenarios(empty) == []


if __name__ == "__main__":
    test_capture_writes_valid_entry()
    test_loader_produces_runnable_scenario()
    test_loader_handles_missing_or_empty()
    print("user_scenarios: all checks passed")
