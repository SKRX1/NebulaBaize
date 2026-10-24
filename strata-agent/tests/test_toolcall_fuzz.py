# -*- coding: utf-8 -*-
"""Contract fuzzer for the engine<->gateway tool-call format bridge.

`text_tool_calls()` is the only thing standing between a model/engine that emits
a call as TEXT and a silently-dropped action. This fuzzes its input space and
asserts the invariants that must ALWAYS hold:

  * it never raises, on any input (including hostile / malformed);
  * a `<function=KNOWN>` is ALWAYS recovered as exactly one call named KNOWN with
    valid-JSON arguments;
  * an UNKNOWN name is NEVER executed (left as prose);
  * when a call IS recovered, the cleaned text carries no stray call tags that
    would teach the model the call "already ran";
  * surrounding prose is preserved.

Run: python tests/test_toolcall_fuzz.py
"""
import json
import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
from http_server import (hallucinated_tool_call, looks_like_narration,
                      text_tool_calls)  # noqa: E402

KNOWN = {"filesystem__write", "shell__exec"}
UNK = "nonexistent_tool"

OK = []


def check(name, cond, extra=""):
    if not cond:
        raise AssertionError(f"FAIL: {name} {extra}")
    OK.append(name)


def _markup_in(text):
    return any(k in text for k in ("<function=", "<tool_call", "</function>", "</tool_call>",
                                   "<parameter=", "</parameter>"))


def fuzz_one(text, known):
    calls, cleaned = text_tool_calls(text, known)
    assert isinstance(cleaned, str)
    for c in calls:
        nm = c["function"]["name"]
        assert nm in known, f"recovered unknown {nm}"
        json.loads(c["function"]["arguments"])  # must be valid JSON
    has_func = "<function=" in text
    if calls:
        # recovered: stray tags must be gone
        assert "</function>" not in cleaned, cleaned
        assert "</tool_call>" not in cleaned, cleaned
        assert "<tool_call" not in cleaned, cleaned
    elif not has_func:
        # orphan markup is cleaned even when no call is found
        assert "</function>" not in cleaned, cleaned
        assert "</tool_call>" not in cleaned, cleaned
    # unknown name with <function= is left as prose -> don't assert on it
    return calls, cleaned


def main() -> int:
    rng = random.Random(20261020)
    closers = ["</function>", "</function></function>", "", " ", "</function>\n</tool_call>"]
    pres = ["", "好的。\n", "处理结果如下：\n", "下面开始。\n", "完成度 50%。\n"]
    posts = ["", "\n请继续。", "\n以上。", "\n我们下一步。"]
    params = [
        [("path", "_build/a.html"), ("content", "<html>")],
        [("command", "npm run build")],
        [("path", "3"), ("bytes", "7")],
        [("data", '{"x":1}')],
        [("path", "中文路径/文件.txt")],
        [],
    ]
    n = 0
    for _ in range(400):
        name = rng.choice([*KNOWN, UNK])
        params_now = rng.choice(params)
        pre = rng.choice(pres)
        post = rng.choice(posts)
        close = rng.choice(closers)
        inner = "".join(f"<parameter={p}>{v}</parameter>\n" for p, v in params_now)
        if name in KNOWN:
            body = f"<tool_call>\n<function={name}>\n{inner}</function>\n{close}"
        else:
            body = f"<function={name}>\n{inner}</function>"
        text = f"{pre}{body}{post}"
        calls, cleaned = fuzz_one(text, KNOWN)
        n += 1
        if name in KNOWN:
            assert len(calls) == 1 and calls[0]["function"]["name"] == name, (name, calls)
        else:
            assert calls == [], (name, calls, cleaned)
        assert pre.strip() in cleaned or pre == "", (pre, cleaned)
        assert post.strip() in cleaned or post == "", (post, cleaned)
    check("fuzzed 400 XML serializations without violation", n == 400, n)

    # explicit edge cases
    c, cl = text_tool_calls("<function=filesystem__write>\n<parameter=path>\na</parameter>\n"
                            "</function>\n</function>", KNOWN)
    check("double close -> one call", len(c) == 1 and c[0]["function"]["name"] == "filesystem__write", c)
    check("double close -> stray tag removed", "</function>" not in cl, cl)

    c, cl = text_tool_calls("<function=shell__exec>\n<parameter=command>\nrm -rf /\n</parameter>\n"
                            "</function>", KNOWN)
    check("non-json param kept verbatim",
          json.loads(c[0]["function"]["arguments"])["command"] == "rm -rf /", c)

    c, cl = text_tool_calls("格式：<function=my_tool>...</function>", KNOWN)
    check("doc snippet not executed",
          c == [] and cl == "格式：<function=my_tool>...</function>", (c, cl))

    for _ in range(200):
        s = "".join(rng.choice("abcde开始下一步完成你？123 ") for _ in range(rng.randint(0, 50)))
        assert isinstance(looks_like_narration(s), bool)
    check("narration fuzz: 200 random strings safe", True)

    # ── Bare-server-prefix rescue (2026-10-24): the differential pair ──────────────
    # A small quantized model that degrades to TEXT-XML writes just the SERVER half of
    # the server__tool convention (`<function=shell>` for `shell__exec`). The rescue is
    # safe only where nothing is guessed: a server contributing EXACTLY ONE tool to
    # `known`. Same input shape, only the server's tool count differs -- that is what
    # makes this a differential, not two independent assertions.
    FULL = {"shell__exec", "filesystem__read", "filesystem__write", "memory__recall"}
    single = "<function=shell>\n<parameter=command>\nls\n</parameter>\n</function>\n"
    multi = "<function=filesystem>\n<parameter=path>\na\n</parameter>\n</function>\n"
    c_s, cl_s = fuzz_one(single, FULL)
    c_m, cl_m = fuzz_one(multi, FULL)
    check("differential: single-tool server rescued, multi-tool server not",
          len(c_s) == 1 and c_m == [], (c_s, c_m))
    check("bare prefix maps to the REAL namespaced name",
          c_s and c_s[0]["function"]["name"] == "shell__exec", c_s)
    check("rescued call keeps its arguments",
          c_s and json.loads(c_s[0]["function"]["arguments"]).get("command") == "ls", c_s)
    check("rescued call: stray tags cleaned from the answer",
          "</function>" not in cl_s and "</tool_call>" not in cl_s, cl_s)
    check("ambiguous server: text left as prose (no guessing)",
          "<function=filesystem>" in cl_m, cl_m)
    # hallucinated_tool_call must stay consistent with the rescue: a call that the
    # rescue maps back was NOT dropped, so it must not be reported as a hallucination;
    # an ambiguous prefix that stays prose IS still an attempted-but-dropped action.
    check("hallucinated: a rescued bare prefix is not a drop",
          hallucinated_tool_call(single, FULL) is False)
    check("hallucinated: an ambiguous bare prefix + params is still a drop",
          hallucinated_tool_call(multi, FULL) is True)
    # the map itself: derived from `known`, so it tracks whatever the gateway advertises
    from http_server import _prefix_tool_map  # noqa: E402
    pm = _prefix_tool_map(FULL)
    check("prefix map: single-tool server present",
          pm.get("shell") == "shell__exec" and pm.get("memory") == "memory__recall", pm)
    check("prefix map: multi-tool server absent (ambiguous)", "filesystem" not in pm, pm)

    print(f"\nTOOLCALL-FUZZ: {len(OK)} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
