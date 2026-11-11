# -*- coding: utf-8 -*-
"""Differential lock: AgentLoop must tolerate max_rounds=None (the scheduled-run crash).

WHY THIS TEST EXISTS (added 2026-11-11):
  The CLI flag --max-rounds defaults to None and gateway passes it straight into
  AgentLoop(..., max_rounds=args.max_rounds). loop.run() opens with
  `for rnd in range(1, self.max_rounds + 1)`. With None that line raises
  `unsupported operand type(s) for +: 'NoneType' and 'int'` on the FIRST round --
  which is EXACTLY the reason the on-disk scheduled backup task recorded ok=false
  (a scheduled run drives the REAL AgentLoop via agent.run(); the interactive/HTTP
  chains escaped it only because http_server int()s gw_state.max_rounds separately).

  The existing test_loop_finalize_resume.py always constructs with max_rounds=8, so
  it never walked the None path and missed this.

THE FIX under test: loop.py guards `self.max_rounds = max_rounds if max_rounds is not
None else 32`.

TWO LAYERS, both load-bearing:
  * DYNAMIC (the shipped behaviour): build with max_rounds=None and run one scripted
    final-answer turn. It must run >=1 round and finalize WITHOUT raising. (Pre-fix this
    raised TypeError inside run().)
  * STATIC (the guard exists in the shipped source) + a runtime differential that proves
    the predicate is load-bearing: emulate the PRE-fix code (no guard) and show that the
    same None input DOES raise on `range(1, None + 1)` -- so removing the guard turns the
    dynamic lock red.

Pure standard library: no network, no model, no MCP child, no real serve process.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from loop import AgentLoop  # noqa: E402

OK = []


def check(name, cond, extra=""):
    if not cond:
        raise AssertionError(f"FAIL: {name} {extra}")
    OK.append(name)
    print(f"  ok  {name}")


class Turn:
    def __init__(self, content="", reasoning="", tool_calls=None, usage=None):
        self.content = content
        self.reasoning = reasoning
        self.tool_calls = tool_calls or []
        self.usage = usage or {}


class ScriptedClient:
    def __init__(self, turns):
        self._turns = list(turns)
        self.calls = 0

    def chat(self, messages, tools=None, effort=None):
        i = self.calls
        self.calls += 1
        return self._turns[i]


class FakeExecutor:
    def __init__(self, tool_names):
        self._names = list(tool_names)

    @property
    def tools(self):
        return [{"name": n, "description": "stub", "input_schema": {}} for n in self._names]

    def call(self, tool, args):
        return "ok"


def run_with_maxrounds(max_rounds, final_text):
    client = ScriptedClient([Turn(content=final_text)])
    loop = AgentLoop(client, FakeExecutor(["shell__exec"]), max_rounds=max_rounds)
    loop.refresh_tools()
    loop.run("run the shell backup")   # a single final-answer turn => finalize on round 1
    return client


def main() -> int:
    # ── DYNAMIC: max_rounds=None must run >=1 round and finalize, NOT raise ──
    print("\n=== 1: max_rounds=None finalizes without raising ===")
    try:
        c = run_with_maxrounds(None, "备份完成。")
    except TypeError as e:
        # pre-fix symptom, surfaced clearly if the guard regresses
        raise AssertionError(f"FAIL: None max_rounds raised TypeError (guard regressed): {e}")
    check("ran >=1 round (range(1, None+1) would raise BEFORE any chat)",
          c.calls >= 1, f"chat calls={c.calls}")

    # ── STATIC: the guard is present in the shipped source ──
    print("\n=== 2: the None-guard is present in the shipped loop.py source ===")
    src = open(os.path.join(ROOT, "runtime", "loop.py"), encoding="utf-8").read()
    check("loop.py guards max_rounds None -> default 32",
          "self.max_rounds = max_rounds if max_rounds is not None else 32" in src)

    # ── DIFFERENTIAL: prove the predicate is load-bearing. Emulate PRE-fix (no guard):
    #    feeding the SAME None to the original expression must raise. ──
    print("\n=== 3: differential -- pre-fix code (no guard) raises on the SAME input ===")
    max_rounds_pre_fix = None
    raised = False
    try:
        for _ in range(1, max_rounds_pre_fix + 1):   # the EXACT pre-fix line
            break
    except TypeError:
        raised = True
    check("pre-fix range(1, None + 1) raises (so the dynamic lock is not vacuous)", raised)

    print(f"\nLOOP-NONE-MAXROUNDS: {len(OK)} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
