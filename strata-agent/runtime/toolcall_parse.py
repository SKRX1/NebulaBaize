"""Text-form tool-call parsing, shared by the two server chains.

Single source of truth for the discriminators that both chains need:
  * http_server.run_with_mcp  — the Web/standalone chain (8099 actually runs this)
  * loop.AgentLoop            — the agent-loop chain

Both must judge the SAME shapes with the SAME rules, or they drift apart. This
module holds only pure functions (no server, no network, no model), so each chain
imports it as a sibling.

The engine's chat template teaches the model Qwen's XML call syntax:
    <tool_call>\n<function=NAME>\n<parameter=P>\nVALUE\n</parameter>\n</function>\n</tool_call>
Its streaming parser turns that into structured deltas -- but not always. Two field
cases (2026-10-20) end up as PLAIN TEXT in `content` instead:
  * the model repeats the closers, so `<function=...>` closes at the first `</function>` and
    the leftover `</function></tool_call>` is streamed as ordinary answer text (this is the
    literal `</function></tool_call>` a user sees sitting in the middle of an answer), and
  * the parser loses a call outright, leaving the whole XML in the text.
Either way `tool_calls` comes back EMPTY, and the round then looks exactly like a finished
answer -- the loop breaks "final answer already streamed" while the task is mid-flight, which
the user reports as "思考完就突然断了". Recovering the call from the text is what keeps the
turn alive; `known` (the real tool names) is what keeps a documentation snippet that merely
*mentions* `<function=foo>` from being executed for real.
"""
from __future__ import annotations

import json
import re

_CALL_FUNC_RE = re.compile(r"<function=([A-Za-z0-9_.\-]+)\s*>(.*?)(?:</function>|\Z)", re.S)
_CALL_PARAM_RE = re.compile(r"<parameter=([A-Za-z0-9_.\-]+)\s*>(.*?)(?:</parameter>|\Z)", re.S)
# Bare tags only. `<function=name>` is deliberately NOT matched: that is either a call (handled
# above) or prose about the format, and stripping it would mangle a legitimate explanation.
_STRAY_CALL_TAG_RE = re.compile(r"</?(?:tool_call|tool_response|function|parameter)\s*>", re.I)
_ANY_CALL_MARKUP = ("<function=", "<tool_call", "</function>", "</tool_call>",
                    "<parameter=", "</parameter>")

# ---------------------------------------------------------------------------
# Fence-name + checklist fingerprint (2026-11 report: bare plan/next-steps
# fence hallucinated as a tool call)
# A model can write the markdown plan/next-steps checklist ITSELF as a tool-call
# shape: `<function=plan>` (or next-steps) followed by plain markdown checklist
# lines, with NO `<parameter=...>` block at all. The original discriminator
# (unknown name + a parameter block) cannot see this shape, so the round ended
# mid-task. `plan`/`next-steps` are NOT real tools, so text_tool_calls already
# drops them; this is the SECOND discriminator the diagnosis asked for: a KNOWN
# markdown fence name whose body carries a checklist fingerprint is also an
# action. The DIFFERENTIAL guard against tone-pollution: prose that merely QUOTES
# `<function=plan>` with NO checklist line (a plain explanation) must NOT match
# -- locked as a negative test.
_MD_FENCE_NAMES = frozenset({"plan", "next-steps", "nextsteps"})
_CHECKLIST_RE = re.compile(r"^[ \t]*(?:[-*][ \t]+\[[ xX]\]|[-*!?][ \t]+\S)", re.M)


def _norm_tool(name: str) -> str:
    """Normalize a tool name for tolerant matching: lowercase and collapse any run of
    non-alphanumeric characters to a single underscore.

    The engine teaches the model Qwen's XML call syntax, but when a call leaks into
    `content` as text the model often transcribes the name imperfectly -- `shell_exec`
    (one underscore) or `shell-exec` instead of the real `shell__exec` (the
    server__tool convention). Without this, the rescue's exact-match filter drops the
    call and the round ends with no tool run, which users report as "工具调不动".
    """
    s = (name or "").lower()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    return s


# ── Bare-server-name rescue (2026-10-24) ────────────────────────────────────────────
# A small quantized model that degrades to TEXT-XML calls often writes just the SERVER
# half of the server__tool convention: `<function=shell>` where the real tool is
# `shell__exec`. `_norm_tool` cannot help -- the bare prefix normalizes to itself and
# equals no full name, so the call is dropped and the round ends with no tool run.
# Mapping the prefix back is safe ONLY when that server contributes exactly ONE tool to
# `known`: then there is nothing to guess. A server with several tools (filesystem,
# memory, browser, registry, schedule, skillhub) stays ambiguous and is left as prose --
# the fuzz invariant "a recovered name must be a real tool" must not be paid for with a
# coin flip. Derived from `known` itself, so it tracks the live tool set automatically.
def _prefix_tool_map(known):
    """bare server prefix -> its tool name, for servers exposing exactly one tool."""
    buckets = {}
    for k in known or ():
        if "__" not in k:
            continue                      # no namespace separator = not a server__tool
        buckets.setdefault(_norm_tool(k.split("__", 1)[0]), []).append(k)
    return {p: names[0] for p, names in buckets.items() if len(names) == 1}


def text_tool_calls(text: str, known: set | None = None):
    """Recover tool calls the model wrote as XML *text* -> (calls, text_without_them).

    `known` (optional) is the set of real tool names. A `<function=NAME>` whose NAME is not in
    that set is left untouched: it is prose about the format, not a call. Each recovered call
    carries `arguments` as a JSON **string**, the same shape as a structured delta, so it can be
    fed straight into the normal `parse_tool_args` path.

    Even when NO call is recovered, orphan closers are removed when the text carries call markup.
    That matters on its own: a lone `</function></tool_call>` left in the answer history teaches
    the model that the call already happened, and it is the visible symptom users report.
    """
    if not text or not any(k in text for k in _ANY_CALL_MARKUP):
        return [], text
    calls, spans = [], []
    norm_map = {_norm_tool(k): k for k in known} if known else {}
    prefix_map = _prefix_tool_map(known) if known else {}
    for m in _CALL_FUNC_RE.finditer(text):
        name = m.group(1).strip()
        if not name:
            continue
        if known is not None and name not in known:
            # Tolerant name matching: the model sometimes writes `shell_exec` (one
            # underscore) or `shell-exec` when the real tool is `shell__exec` (the
            # server__tool convention). Map it back instead of silently dropping the
            # call -- an unrun markup call is exactly what users report as "工具调不动".
            real = norm_map.get(_norm_tool(name))
            if real is None:
                # Second tolerance layer: the model wrote only the SERVER half
                # (`<function=shell>` for `shell__exec`). Safe only for a server that
                # contributes exactly one tool to `known` -- no guessing involved.
                real = prefix_map.get(_norm_tool(name))
            if real is None:
                continue
            name = real
        args = {}
        for pm in _CALL_PARAM_RE.finditer(m.group(2)):
            pname, pval = pm.group(1).strip(), pm.group(2).strip()
            try:
                pval = json.loads(pval)       # `true`/`3`/`{"a":1}` -> real JSON value
            except Exception:
                pass                          # otherwise keep the raw text verbatim
            args[pname] = pval
        calls.append({"function": {"name": name,
                                   "arguments": json.dumps(args, ensure_ascii=False)}})
        spans.append((m.start(), m.end()))
    if not calls:
        # No call to recover. Clean orphan tags only when there is no `<function=` at all --
        # an explanation that quotes the format is left exactly as written.
        if "<function=" not in text:
            return [], _STRAY_CALL_TAG_RE.sub("", text)
        return [], text
    keep, last = [], 0
    for s, e in spans:
        keep.append(text[last:s])
        last = e
    keep.append(text[last:])
    return calls, _STRAY_CALL_TAG_RE.sub("", "".join(keep))


# An answer that only *announces* the next step. The model says what it is about to do, emits
# EOS without calling a tool, and the loop treats "has text" as "has answered" -- the turn ends
# mid-task with a sentence like "目录为空、Node v24 可用。开始分块构建。" and nothing happens.
# Recognising that shape lets the loop ask for the action instead of silently stopping.
_NARRATE_RE = re.compile(r"(开始|接下来|现在|下面|下一步|让我|我来|我会|正在|准备|继续|接着|然后|先)")
_DONE_RE = re.compile(r"(已完成|已经完成|全部完成|都完成了|完成了|写好|写好了|搞定|完毕|大功告成|"
                      r"总结|以下是|详见|请查收|无需|不需要再)")


def looks_like_narration(text: str) -> bool:
    """True when an answer only promises the next step and never performs it.

    Deliberately conservative -- a false positive costs one extra round, so the rules aim at
    the reported shape and nothing wider:
      * short (a real final answer that ends a task is rarely a single line);
      * a forward-looking verb in the tail (the model's last sentence before EOS);
      * no completion marker anywhere;
      * not addressed to the user ("接下来你可以…" is advice, i.e. a finished answer);
      * not a question (it is waiting for the user, not for a tool).
    """
    s = (text or "").strip()
    if not s or len(s) > 400:
        return False
    if "?" in s or "？" in s or "你" in s:
        return False
    if _DONE_RE.search(s):
        return False
    return bool(_NARRATE_RE.search(s[-160:]))


def hallucinated_tool_call(text: str, known: set | None) -> bool:
    """True when the model TRIED to make a tool call that the parser then dropped: an XML
    `<function=NAME>` block in the answer text whose NAME is not a real tool, but which
    carries a `<parameter=...>` block -- i.e. the model wrote an *action* (an attempted
    call), not prose about the format.

    This is the "plan checklist hallucinated as a tool call" shape (2026-10-24 report):
    the model emits the markdown plan fence as `<tool_call><function=plan>` + a
    `<parameter=...>` argument, `text_tool_calls` rightfully drops it because `plan` is
    not a real tool, and the round ends with non-empty text and no call -- which reads as
    "answered", so the turn breaks mid-task and the composer offers 继续.

    The DIFFERENTIAL guard against口径污染 (auto-knowledge 2026-10-23 00:19): a *normal*
    answer that merely QUOTES the format in prose -- `<function=some_name> ... </function>`
    with NO parameter block, i.e. an explanation -- must NOT match. Only a `<function=>`
    block that actually carries a `<parameter=>` (an attempted action with arguments) is a
    hallucinated call. This is the exact inverse of the existing test case 2 ("prose that
    merely mentions the format is not executed"), so the two tests lock the boundary.
    """
    if not text or not any(k in text for k in _ANY_CALL_MARKUP):
        return False
    known = known or set()
    norm_known = {_norm_tool(k) for k in known}
    for m in _CALL_FUNC_RE.finditer(text):
        name = (m.group(1) or "").strip()
        if not name or name in known:
            continue                     # empty, or a real tool = rescued, not a drop
        if _norm_tool(name) in norm_known:
            continue                     # tolerant-match maps it back = it WAS rescued
        if _prefix_tool_map(known).get(_norm_tool(name)):
            continue                     # bare-prefix rescue maps it back = it WAS rescued
        if name.lower() in _MD_FENCE_NAMES and _CHECKLIST_RE.search(m.group(2)):
            return True                  # fence name + checklist fingerprint = attempted action
        if _CALL_PARAM_RE.search(m.group(2)) or "</parameter>" in m.group(2):
            return True                  # unknown name + a parameter block = an attempted action
    return False
