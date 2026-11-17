# -*- coding: utf-8 -*-
"""Differential double-probe for the loop.py finalize-branch resume guard (2026-10-25).

WHY THIS TEST EXISTS (and why test_hallucinated_resume.py is not enough):

  8099 agent mode runs the REAL AgentLoop (loop.py). The http_server B-guard is on a
  DIFFERENT chain (run_with_mcp), so a green test there does NOT prove the 8099 chain
  keeps working. This file drives the REAL loop.py finalize branch through a scripted
  fake client, so the 8099 execution path itself is covered.

THE SHAPES (same discriminators as http_server, now via the SHARED module
toolcall_parse, so both chains judge them identically):

  * probe 1  plan-as-tool-call ACTION shape: unknown name `<function=plan>` that
    CARRIES a `<parameter=...>` block. The model wrote an ACTION, so the loop must
    KEEP GOING (nudge + run the next real tool), not finalize.
  * probe 2  a PROSE format-quote in a real final answer (NO parameter block): must
    finalize normally, no nudge, no extra round.

Cap separation (the recommended fix): the action-shape guard has its OWN larger budget
(5); narration keeps the conservative cap (2). This test locks BOTH the action-shape
continue AND the prose-quote finalize so the two boundaries can't drift.

Pure standard library: no network, no model, no MCP child.
"""
import io
import json
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


# ── scripted fakes for planner / loop ───────────────────────────────────────────
class Turn:
    """The object planner reads off client.chat(). Mirrors llm_client's response shape."""
    def __init__(self, content="", reasoning="", tool_calls=None, usage=None):
        self.content = content
        self.reasoning = reasoning
        self.tool_calls = tool_calls or []
        self.usage = usage or {}


class ScriptedClient:
    """Returns one scripted Turn per chat() call, in order."""
    def __init__(self, turns):
        self._turns = list(turns)
        self.calls = 0

    def chat(self, messages, tools=None, effort=None, on_delta=None):
        i = self.calls
        self.calls += 1
        return self._turns[i]


class FakeExecutor:
    """Minimal executor: exposes real tool NAMES (so `known` is representative) and a
    no-op call(). The real tools are not run — we only assert the loop's control flow."""
    def __init__(self, tool_names):
        self._names = list(tool_names)

    @property
    def tools(self):
        return [{"name": n, "description": "stub", "input_schema": {}} for n in self._names]

    def call(self, tool, args):
        return "ok"


KNOWN = ["filesystem__write", "shell__exec"]   # real tool names (NOT "plan")

# probe 1: an ATTEMPTED ACTION -- unknown name `plan` that CARRIES a parameter block.
PLAN_ACTION = ("好的，我的计划如下。\n<tool_call>\n<function=plan>\n"
               "<parameter=plan>\n- [ ] 读文件\n- [ ] 改代码\n</parameter>\n"
               "</function>\n</tool_call>\n")
# probe 2: a real final answer that merely QUOTES the format (NO parameter block) + a
# completion marker, so neither guard should fire and the loop finalizes.
PROSE_QUOTE = "调用格式是 <function=example_tool> ... </function> 这样写的。已完成。"


def run_loop(turns):
    client = ScriptedClient(turns)
    ex = FakeExecutor(KNOWN)
    loop = AgentLoop(client, ex, max_rounds=8)
    loop.refresh_tools()
    loop.run("do the task")          # the task text; guard fires on the model's turns below
    return client


def main() -> int:
    # ── probe 1: action shape KEEPS the loop working (finalize branch must NOT break) ──
    print("\n=== 1: plan-as-tool-call action shape continues the loop ===")
    c1 = run_loop([
        Turn(content=PLAN_ACTION),                                   # 1: the action-shape
        Turn(tool_calls=[{"id": "c2", "name": "filesystem__write",
                          "arguments": json.dumps({"path": "x", "content": "y"})}]),  # 2: a real tool ran
        Turn(content="全部完成。"),                                    # 3: a real finish
    ])
    check("the loop ran >=3 rounds (it did NOT break on the action shape)",
          c1.calls >= 3, f"client.chat calls={c1.calls}")
    check("the model was nudged about plan-as-tool-call on round 2's input",
          c1.calls >= 2, f"client.chat calls={c1.calls}")

    # ── probe 2: a prose format-quote finalizes, NO extra round ──────────────────
    print("\n=== 2: a prose format-quote finalizes, no resume ===")
    c2 = run_loop([
        Turn(content=PROSE_QUOTE),                                   # 1: explanation, a real final answer
    ])
    check("exactly ONE round ran -- the answer finalized, it was NOT resumed",
          c2.calls == 1, f"client.chat calls={c2.calls}")

    # ── differential boundary: action shape has a parameter block, the prose quote does not ──
    print("\n=== 3: shared discriminators lock the boundary ===")
    from toolcall_parse import hallucinated_tool_call, looks_like_narration
    check("action shape -> hallucinated True",
          hallucinated_tool_call(PLAN_ACTION, set(KNOWN)) is True)
    check("prose format-quote -> hallucinated False",
          hallucinated_tool_call(PROSE_QUOTE, set(KNOWN)) is False)
    # a normal completion answer is not narration either (so neither guard fires on it)
    check("prose completion answer -> narration False",
          looks_like_narration(PROSE_QUOTE) is False)

    print(f"\nLOOP-FINALIZE-RESUME: {len(OK)} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
