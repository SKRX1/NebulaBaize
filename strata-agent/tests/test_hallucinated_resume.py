# -*- coding: utf-8 -*-
"""Differential double-probe for the hallucinated-tool-call resume guard (B, 2026-10-24).

The small quantized model sometimes writes the markdown plan/next-steps fence as if it
were a TOOL CALL -- `<tool_call><function=plan>` + a `<parameter=...>` argument.
`text_tool_calls` rightfully DROPS it (the name `plan` is not a real tool), so the round
ends with non-empty text and no call. Without a guard that reads as "answered": the turn
breaks mid-task and the composer offers a manual 继续 -- exactly the interruption reported.

B keeps working in that case. The DIFFERENTIAL guard (auto-knowledge 2026-10-23 00:19,
the口径污染 trap) is that a NORMAL answer which merely QUOTES the format in prose --
`<function=name> ... </function>` with NO parameter block -- must NOT trigger a resume.

The double probe locks BOTH sides of that boundary:
  * probe 1 (the action shape)        -> resume (the turn keeps going, runs the next tool)
  * probe 2 (a prose format quote)    -> no resume (the turn finalizes normally)

Pure standard library: no network, no model, no MCP child.
"""
import io
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from http_server import hallucinated_tool_call  # noqa: E402

# reuse the narration-guard harness verbatim (FakeHandler / run / parse / notices / tools)
sys.path.insert(0, os.path.join(ROOT, "tests"))
from test_narration_guard import (FakeHandler, tool_round, text_round,  # noqa: E402
                                   run, parse, notices, fresh_state, KNOWN)

OK = []


def check(name, cond, extra=""):
    if not cond:
        raise AssertionError(f"FAIL: {name} {extra}")
    OK.append(name)
    print(f"  ok  {name}")


# ── the two shapes at the heart of the guard ──────────────────────────────────
# probe 1: an ATTEMPTED ACTION -- unknown name `plan` that CARRIES a parameter block.
HALLUC_ACTION = ("好的，我的计划如下。\n<tool_call>\n<function=plan>\n"
                 "<parameter=plan>\n- [ ] 读文件\n- [ ] 改代码\n</parameter>\n"
                 "</function>\n</tool_call>\n")
# probe 2: a PROSE QUOTE of the format -- an explanation naming a tool, NO parameter block.
PROSE_QUOTE = "调用格式是 <function=example_tool> ... </function> 这样写的。"


def main() -> int:
    # ── 1) the unit-level differential: the boundary itself ────────────────────
    print("\n=== 1: helper separates an attempted action from a prose quote ===")
    check("action shape (unknown name + parameter block) -> True",
          hallucinated_tool_call(HALLUC_ACTION, KNOWN) is True)
    check("prose format-quote (no parameter block) -> False",
          hallucinated_tool_call(PROSE_QUOTE, KNOWN) is False)
    # a real tool name that carries a parameter block is RESCUED by text_tool_calls,
    # so it must NOT be counted as a hallucinated (dropped) call
    real_call = ("<tool_call>\n<function=filesystem__write>\n<parameter=path>\n"
                 "a.txt\n</parameter>\n</function>\n</tool_call>")
    check("a real tool name with a parameter -> False (it gets rescued, not dropped)",
          hallucinated_tool_call(real_call, KNOWN) is False)
    check("empty text -> False", hallucinated_tool_call("", KNOWN) is False)
    check("plain text -> False", hallucinated_tool_call("全部完成。", KNOWN) is False)

    # Differential lock for the STRAY-CLOSER action shape (2026-10-26 report): a markdown
    # plan list inside <function=plan> whose parameter block has only a stray </parameter>
    # closer (no opening <parameter= tag) is still an ATTEMPTED ACTION -> resume. The prose
    # quote above has NO closer at all and stays False, so the two lock the boundary.
    STRAY_CLOSER = ("<tool_call>\n<function=plan>\n"
                    "- [ ] step one\n- [ ] step two\n"
                    "</parameter>\n</function>\n</tool_call>")
    check("stray-closer action shape (markdown list + stray closer) -> True",
          hallucinated_tool_call(STRAY_CLOSER, KNOWN) is True)

    # ── 2) probe 1 end-to-end: the action shape RESUMES the turn ──────────────
    print("\n=== 2: probe 1 -- a hallucinated plan-action keeps the turn working ===")
    st = fresh_state()
    h, ev = run(st, [
        text_round(HALLUC_ACTION),                    # 1: the action-shape hallucination
        tool_round(cid="call_2", args={"path": "_build/x.js", "content": "x"}),
        text_round("已完成全部构建。"),                 # 3: a real finish
    ], "s-halluc")
    check("the guard did NOT end the turn on the hallucination -- the next tool ran",
          [c[0] for c in st.executor.calls] == ["filesystem__write"], st.executor.calls)
    check("the stream ended with [DONE]", ev[-1] == "[DONE]", ev[-1:])
    check("no notice was raised (the guard continues, it does not stop-and-offer-继续)",
          not notices(ev), notices(ev))
    nudges_sent = [m for m in h.seen[1] if m.get("role") == "user"
                   and "[system]" in str(m.get("content"))
                   and "工具调用" in str(m.get("content"))]
    check("the model was told the plan-as-tool-call was not a real call",
          len(nudges_sent) == 1, h.seen[1])

    # ── 3) probe 2 end-to-end: a prose format-quote must NOT trigger a resume ─
    print("\n=== 3: probe 2 -- a prose format-quote finalizes, no resume ===")
    st2 = fresh_state()
    h2, ev2 = run(st2, [
        text_round(PROSE_QUOTE + " 已完成。"),          # 1: explanation, a real final answer
    ], "s-quote")
    check("no tool ran (nothing was executed on a pure quote)",
          st2.executor.calls == [], st2.executor.calls)
    check("only ONE round ran -- the answer finalized, it was NOT resumed",
          h2._round == 1, h2._round)
    check("the stream ended with [DONE]", ev2[-1] == "[DONE]", ev2[-1:])
    no_nudge = [m for m in (h2.seen[0] or []) if m.get("role") == "user"
                and "[system]" in str(m.get("content"))]
    check("the model was NOT nudged (a legit format-quote is left as prose)",
          not no_nudge, h2.seen[0])

    print(f"\nHALLUCINATED-RESUME: {len(OK)} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
