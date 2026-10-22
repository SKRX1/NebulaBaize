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
from http_server import looks_like_narration, text_tool_calls  # noqa: E402

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

    print(f"\nTOOLCALL-FUZZ: {len(OK)} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
