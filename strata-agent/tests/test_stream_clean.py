# -*- coding: utf-8 -*-
"""Regression for the leftover bug: leaked call markup must never reach the user.

The gateway used to push the RAW `content` delta over SSE, so a call the engine
left as text (FM4) or an orphan closer after a structured call
(`</function></tool_call>`) showed up as literal XML in the chat -- even though
the model's *history* was cleaned at the round boundary. This test pins the
fix: the user-facing stream is cleaned too, while the raw text is still kept
long enough for the end-of-round rescue to recover the structured call.

Run: python tests/test_stream_clean.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from _adversarial import (SCENARIOS, fresh_state, run,            # noqa: E402
                          visible_content, visible_has_markup,
                          text_round)

OK = []


def check(name, cond, extra=""):
    if not cond:
        raise AssertionError(f"FAIL: {name} {extra}")
    OK.append(name)
    print(f"  ok  {name}")


def main() -> int:
    try:
        # 1) The leftover bug: leaked markup must not be visible to the user.
        sc = SCENARIOS["visible_stream_clean"]
        st = fresh_state(sc.get("behavior"))
        h, ev = run(st, sc["sequences"], "stream-clean")
        check("[stream-clean] ends with [DONE]", bool(ev) and ev[-1] == "[DONE]", ev[-1:])
        check("[stream-clean] user stream has no call markup",
              not visible_has_markup(ev), repr(visible_content(ev)))
        check("[stream-clean] leaked text call still executed",
              bool(st.executor.calls)
              and st.executor.calls[0][0] == "filesystem__write", st.executor.calls)

        # 2) A normal answer with NO markup must stream verbatim -- the cleaner must
        #    be a no-op for legitimate content (no accidental mangling).
        plain = "普通回答，没有标记，包含中文标点。结尾。"
        st2 = fresh_state()
        h2, ev2 = run(st2, [text_round(plain), text_round("已完成。")], "stream-plain")
        got = visible_content(ev2)
        check("[stream-plain] normal answer streams verbatim",
              got.startswith(plain), repr(got))

        # 3) An orphan closer alone is stripped from the visible stream, no call invented.
        st3 = fresh_state()
        h3, ev3 = run(st3, [text_round("写好了。\n</function>\n</tool_call>"),
                            text_round("已完成。")], "stream-orphan")
        check("[stream-orphan] no visible markup", not visible_has_markup(ev3),
              repr(visible_content(ev3)))
        check("[stream-orphan] no call invented", st3.executor.calls == [], st3.executor.calls)

        print(f"\nSTREAM-CLEAN: {len(OK)} checks passed")
        return 0
    except AssertionError as e:
        print(f"\nSTREAM-CLEAN: FAILED -> {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
