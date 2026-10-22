# -*- coding: utf-8 -*-
"""Unit tests for the behavior judge (layer ④).

Each heuristic is tested with a crafted turn, including the negative cases that
represent the soft-instruction drift we want to catch (English-only reasoning,
malformed tool-call JSON, leaked XML, dangling tool call).

Run: python tests/test_behavior_judge.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

from behavior_judge import (  # noqa: E402
    judge_chinese_think, judge_tool_calls, judge_no_xml_leak,
    judge_clean_finish, judge_turn, judge_session,
)

KNOWN = {"filesystem__write", "shell__exec"}


def check(name, cond, extra=""):
    if not cond:
        raise AssertionError(f"FAIL: {name} {extra}")
    print(f"  ok  {name}")


def main() -> int:
    try:
        # ── chinese_think ──
        cjk_pass = judge_chinese_think({"reasoning_content": "先思考一下，这里要用中文推理。"})
        check("chinese reasoning -> pass", cjk_pass["ok"] is True, cjk_pass)
        cjk_fail = judge_chinese_think({"reasoning_content": "let me think about this in English only."})
        check("english-only reasoning -> fail", cjk_fail["ok"] is False, cjk_fail)
        cjk_none = judge_chinese_think({"content": "no reasoning here"})
        check("no reasoning -> ok=None (not a failure)", cjk_none["ok"] is None, cjk_none)

        # ── tool_call_valid ──
        tc_ok = judge_tool_calls({"tool_calls": [
            {"function": {"name": "filesystem__write",
                          "arguments": '{"path": "a", "content": "b"}'}}]},
            known=KNOWN)
        check("valid known tool call -> pass", tc_ok["ok"] is True, tc_ok)
        tc_bad_name = judge_tool_calls({"tool_calls": [
            {"function": {"name": "nonexistent", "arguments": {}}}]}, known=KNOWN)
        check("unknown tool name -> fail", tc_bad_name["ok"] is False, tc_bad_name)
        tc_bad_json = judge_tool_calls({"tool_calls": [
            {"function": {"name": "filesystem__write", "arguments": "{bad json"}}]}, known=KNOWN)
        check("malformed json args -> fail", tc_bad_json["ok"] is False, tc_bad_json)
        check("no tool calls -> pass", judge_tool_calls({})["ok"] is True)

        # ── no_xml_leak ──
        leak = judge_no_xml_leak({"content": "done <function=filesystem__write> x </function>"})
        check("raw markup in answer -> fail", leak["ok"] is False, leak)
        check("clean answer -> pass", judge_no_xml_leak({"content": "已完成。"})["ok"] is True)

        # ── clean_finish ──
        dangling = judge_clean_finish({"tool_calls": [{"function": {"name": "x"}}]})
        check("turn ends on tool call w/o text -> fail", dangling["ok"] is False, dangling)
        empty = judge_clean_finish({})
        check("empty turn -> fail", empty["ok"] is False, empty)
        clean = judge_clean_finish({"content": "全部完成。", "tool_calls": [{"function": {"name": "x"}}]})
        check("text answer present -> pass", clean["ok"] is True, clean)

        # ── judge_turn aggregation ──
        good_turn = {"id": 1, "reasoning_content": "用中文思考。",
                     "content": "完成。", "tool_calls": [
                         {"function": {"name": "filesystem__write",
                                      "arguments": '{"path": "a"}'}}]}
        check("good turn -> ok", judge_turn(good_turn, known=KNOWN)["ok"] is True)
        bad_turn = {"id": 2, "reasoning_content": "think in english",
                    "content": "<function=x></function>", "tool_calls": []}
        check("bad turn -> not ok", judge_turn(bad_turn, known=KNOWN)["ok"] is False)

        # ── judge_session ──
        sess = judge_session([good_turn, bad_turn], known=KNOWN)
        check("session with one bad turn -> failed count 1",
              sess["failed"] == 1 and sess["ok"] is False, sess)
        sess_ok = judge_session([good_turn, dict(good_turn, id=9)], known=KNOWN)
        check("all-good session -> ok", sess_ok["ok"] is True and sess_ok["failed"] == 0, sess_ok)

        print("\nBEHAVIOR-JUDGE: all checks passed")
        return 0
    except AssertionError as e:
        print(f"\nBEHAVIOR-JUDGE: FAILED -> {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
