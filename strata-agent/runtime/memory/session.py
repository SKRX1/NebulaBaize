"""Session memory: append-only history with partition-frozen summary compression.

Pure standard library. The compression strategy is "分区冻结式递归摘要" (partition-freeze):

  - The first message (original intent / system) is pinned verbatim.
  - Already-summarized facts live in an APPEND-ONLY frozen note: once a fact is folded in
    it is never re-summarized, only new facts are appended at the end. This keeps the
    prompt prefix byte-stable so Strata's conversation cache keeps hitting (DESIGN.md §5).
  - A live tail of the most recent messages is kept verbatim (the active working window).
  - When the window grows past `max_chars`, the oldest live messages (beyond a pinned
    head and a minimum tail) are folded: only the NEWLY-folded messages are summarized and
    appended to the frozen note — previously-frozen content is never rewritten.

`summarize` is a callable(text) -> summary text. Plug in an LLM-backed callable (the shared
Strata model) for semantic summaries; a built-in structured summarizer is the default,
with truncation as a zero-cost fallback.
"""
from __future__ import annotations
import os
import re
import uuid


# ---- summary strategies (switchable) ----

def summarize_truncate(text: str, budget: int = 400) -> str:
    """Zero-cost fallback: hard truncation (no facts guaranteed, no LLM)."""
    return text[:budget] + ("…" if len(text) > budget else "")


def summarize_structured(text: str) -> str:
    """Built-in, no-LLM structured summarizer.

    Pulls decision/fact-shaped lines into a fixed skeleton so the model can re-read it
    stably each turn (resists drift/amnesia better than free prose). No third-party deps.
    """
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    facts, decisions, todos = [], [], []
    for l in lines:
        low = l.lower()
        if any(k in low for k in ("decid", "chose", "选择", "决定", "=>", "->", "fix", "修复")):
            decisions.append(l)
        elif any(k in low for k in ("todo", "next", "待办", "下一步", "计划", "will", "要")):
            todos.append(l)
        else:
            facts.append(l)
    out = []
    if decisions:
        out.append("关键决策:")
        out += [f"- {d}" for d in decisions[:12]]
    if facts:
        out.append("事实:")
        out += [f"- {f}" for f in facts[:12]]
    if todos:
        out.append("待办:")
        out += [f"- {t}" for t in todos[:12]]
    body = "\n".join(out) if out else "\n".join(lines[:12])
    return body[:1200] + ("…" if len(body) > 1200 else "")


STRATEGIES = {
    "structured": summarize_structured,
    "truncate": summarize_truncate,
}


class SessionMemory:
    def __init__(self, max_chars: int = 8000, keep_tail_min: int = 6,
                 strategy: str = "structured", summarize: callable = None,
                 tail_budget_ratio: float = 0.4, frozen_cap_ratio: float = 0.5,
                 frozen_refold_budget: int = None,
                 tool_result_cap: int = 10000, tool_head_lines: int = 15,
                 tool_tail_lines: int = 15, tool_log_dir: str = None):
        self.max_chars = max_chars
        self.keep_tail_min = keep_tail_min
        self.tail_budget_ratio = tail_budget_ratio
        self.frozen_cap_ratio = frozen_cap_ratio
        # Hierarchical re-fold target: when the frozen note is re-collapsed it is squeezed
        # to at most this many chars (floor 800 so even tiny configs keep the decision/fact
        # signal). Gives an O(1) ceiling on accumulated context independent of conversation
        # length. Default = half the frozen cap.
        self.frozen_refold_budget = frozen_refold_budget if frozen_refold_budget is not None \
            else max(int(max_chars * frozen_cap_ratio * 0.5), 800)
        # Tool-result cap (the "源头封顶" step): when a tool message (role=="tool") exceeds
        # `tool_result_cap` chars, only its head/tail lines are kept verbatim; the middle is
        # dropped with a marker. Tool I/O (file reads, command output, large writes) is the
        # single biggest contributor to live context, so capping it is what actually shrinks
        # the residual "still big after compress" footprint. Image/multimodal results are
        # exempt (handled separately). 0 or None disables the cap.
        self.tool_result_cap = tool_result_cap or 0
        self.tool_head_lines = tool_head_lines
        self.tool_tail_lines = tool_tail_lines
        # Zero-loss side-log: when a tool result is truncated by the cap, its FULL text is
        # written to `<tool_log_dir>/<id>.txt` and the truncation marker carries `id=` so
        # the model can call `recall_tool_log(id)` to fetch it back on a later turn. This
        # makes the cap lossless — the only trade-off is disk, never information. None
        # disables the side-log (the marker then carries no id and the cap is lossy again).
        self.tool_log_dir = tool_log_dir
        self.summarize = summarize or STRATEGIES.get(strategy, summarize_structured)
        self.history: list[dict] = []
        self._frozen_text: str = ""   # accumulated facts; re-folded when it grows past the cap
        self._frozen_flag = "_frozen_note"  # marker key on the frozen note message

    def append(self, role, content=None, **extra) -> None:
        # Accept either append(msg_dict) or append(role, content, **extra) so the full
        # message structure (tool_calls / tool_call_id) is preserved for the API call.
        if isinstance(role, dict):
            self.history.append(role)
            return
        msg = {"role": role, "content": content}
        msg.update(extra)
        self.history.append(msg)

    def as_messages(self) -> list[dict]:
        return list(self.history)

    @staticmethod
    def _cap_tool_text(text: str, cap: int, head_lines: int, tail_lines: int,
                       log_id: str = None) -> str:
        """Head/tail truncation of a single over-long tool result.

        Keeps the first `head_lines` and last `tail_lines` lines, drops the middle with a
        marker. Lines shorter than the cap that just happen to be few-but-long are left
        untouched (nothing meaningful to head/tail). This is the user-visible "30% fix":
        the model still sees the top of a command's output and its final lines (where the
        real error / result usually hides), but a 5k-char dump no longer sits verbatim.
        When `log_id` is given (a zero-loss side-log entry exists), the marker also tells
        the model how to fetch the FULL output back via `recall_tool_log(log_id)`.
        """
        if not cap or len(text) <= cap:
            return text
        lines = text.splitlines()
        if len(lines) <= head_lines + tail_lines + 1:
            return text  # few very long lines: head/tail can't help, keep as-is
        head = lines[:head_lines]
        tail = lines[-tail_lines:]
        dropped = len(lines) - head_lines - tail_lines
        mid = f"\n…[truncated {dropped} lines, head/tail kept]…"
        if log_id:
            mid += (f" (FULL output saved as tool-log id={log_id}; "
                    f"call recall_tool_log(\"{log_id}\") to read all {len(text)} chars)")
        return "\n".join(head) + mid + "\n" + "\n".join(tail)

    def _cap_tool_msg(self, m: dict) -> dict:
        """Return a capped copy of a tool message, or the original if not cappable.

        Multimodal (image) results are exempt — only the textual `content` string is
        truncated. The original history entry is never mutated (a fresh dict is returned),
        so a message's full text survives until the next compress that folds it away.

        Zero-loss: only when the text is actually truncated do we write the FULL text to
        the side-log and embed its id in the marker (so no orphan files are created for
        results that were never capped).
        """
        if self.tool_result_cap <= 0 or m.get("role") != "tool":
            return m
        content = m.get("content")
        if isinstance(content, list):
            return m  # image/multimodal — exempt
        text = _text(content)
        if not text:
            return m
        capped = self._cap_tool_text(text, self.tool_result_cap,
                                     self.tool_head_lines, self.tool_tail_lines)
        if capped is text:
            return m  # under the cap -> nothing to truncate, nothing to log
        log_id = self.write_tool_log(text) if self.tool_log_dir else None
        if log_id:
            capped = self._cap_tool_text(text, self.tool_result_cap,
                                         self.tool_head_lines, self.tool_tail_lines,
                                         log_id=log_id)
        nm = dict(m)
        nm["content"] = capped
        return nm

    def write_tool_log(self, text: str) -> str | None:
        """Persist the FULL tool output to the side-log dir; return its id (or None)."""
        return write_tool_log_text(self.tool_log_dir, text)

    @staticmethod
    def _slim_text(text: str) -> str:
        """Shrink text before/after summarization to lower the frozen note's footprint.

        - Fenced code blocks (```...```) are replaced by a one-line marker so the *fact*
          that code existed survives without the multi-line bulk.
        - Leading line-number prefixes ("  12:", "12.\t", "12) ") from pasted logs/output
          are stripped.
        - Blank lines and trailing whitespace are normalized away.

        This is the "压缩产物瘦身" step: the summary itself carries far less dead weight,
        so the residual ~30% fixed overhead (system prompt + tool schemas) is a smaller
        share of the total window.
        """
        # 1) fenced code blocks -> compact marker
        def _code_repl(m):
            n = m.group(0).count("\n")
            return f"[code block: {n} lines]"
        text = re.sub(r"```.*?```", _code_repl, text, flags=re.DOTALL)
        out = []
        for line in text.splitlines():
            # strip leading "NNN:" / "NNN." / "NNN)" / "NNN\t" line-number prefixes
            s = re.sub(r"^\s*\d+[:.)\t]\s*", "", line)
            s = s.rstrip()
            if s:
                out.append(s)
        return "\n".join(out)

    def compress(self, summarize=None) -> list[dict]:
        """Partition-freeze compression with a HARD total budget.

        Three guarantees (vs. the original append-only design):

          1. BOUNDED frozen note — re-folded to `frozen_refold_budget` chars whenever it
             grows past `frozen_cap_ratio * max_chars` (hierarchical / rolling summary:
             old facts are collapsed progressively, never appended forever).
          2. SIZE-AWARE tail — recent messages kept verbatim only while their running
             size stays under `tail_budget_ratio * max_chars` (>= `keep_tail_min` always
             kept); huge tool-I/O turns no longer defeat compression by sitting verbatim.
          3. INCREMENTAL fold — only the OLDEST middle messages needed to drop back under
             `max_chars` are folded each call (not the whole middle at once), so the
             compression cost is spread across turns instead of one giant flattening.

        The input blob and the stored frozen note are passed through `_slim_text` so the
        summary carries minimal dead weight (code blocks / line numbers stripped).
        Previously-frozen facts keep their byte prefix in the common sub-cap case, so the
        conversation cache keeps hitting (DESIGN.md §5).
        """
        summarize = summarize or self.summarize
        if self._total_chars() <= self.max_chars:
            return self.as_messages()

        head = self.history[:1]                      # pinned original intent
        # size-aware tail: keep recent messages verbatim up to a budget (min keep_tail_min)
        tail_budget = int(self.max_chars * self.tail_budget_ratio)
        tail: list[dict] = []
        acc = 0
        for m in reversed(self.history[1:]):
            c = self._msg_chars(m)
            have_min = len(tail) >= self.keep_tail_min
            # stop when: we have the minimum AND would exceed budget, OR the next single
            # message alone blows the budget (fold it instead of keeping it verbatim).
            if tail and ((have_min and acc + c > tail_budget) or (c > tail_budget and len(tail) >= 1)):
                break
            # Cap tool results in the tail, but never the freshest `keep_tail_min` messages
            # so a just-produced output that the next chained tool call still needs stays
            # full this turn (protects same-turn chains from the deferred-round loss).
            if m.get("role") == "tool" and len(tail) >= self.keep_tail_min:
                m = self._cap_tool_msg(m)
            tail.append(m)
            acc += c
        tail.reverse()

        # Split the middle into the already-frozen note(s) and the still-raw foldable runs.
        raw_middle = self.history[1: len(self.history) - len(tail)]
        frozen_msgs = [m for m in raw_middle if m.get(self._frozen_flag) == True]
        foldable = [m for m in raw_middle if m.get(self._frozen_flag) != True]
        if not foldable:
            return self.as_messages()                # nothing raw left to fold

        # Incremental: fold only the OLDEST foldable messages needed to get back under budget.
        need = self._total_chars() - self.max_chars
        folded: list[dict] = []
        removed = 0
        for m in foldable:                            # oldest first
            folded.append(m)
            removed += self._msg_chars(m)
            if removed >= need:
                break
        remaining_foldable = foldable[len(folded):]

        if not folded:
            return self.as_messages()

        blob = self._slim_text("\n".join(
            self._blob_line(self._cap_tool_msg(m) if m.get("role") == "tool" else m)
            for m in folded))
        new_summary = summarize(blob)

        # Hierarchical re-fold: collapse the frozen note (progressively tighter) when it
        # has grown past its cap, then append the new summary, then slim + hard-cap it.
        if self._frozen_text and len(self._frozen_text) > int(self.max_chars * self.frozen_cap_ratio):
            self._frozen_text = self._slim_text(summarize(self._frozen_text))
            if len(self._frozen_text) > self.frozen_refold_budget:
                self._frozen_text = self._slim_text(summarize(self._frozen_text))
        self._frozen_text = (self._frozen_text + "\n" + new_summary) if self._frozen_text else new_summary
        self._frozen_text = self._slim_text(self._frozen_text)
        if len(self._frozen_text) > self.frozen_refold_budget:
            self._frozen_text = self._frozen_text[:self.frozen_refold_budget]

        frozen_note = {"role": "assistant", "content": "[accumulated summary]\n" + self._frozen_text,
                       self._frozen_flag: True}
        self.history = head + [frozen_note] + remaining_foldable + tail
        return self.as_messages()

    @staticmethod
    def _blob_line(m: dict) -> str:
        """One message as text for the summarizer, tool calls included.

        Rendering only `content` produced a summary full of empty "assistant:" lines
        (a tool-calling turn has content=None), which folded away the most important
        part of the trace.
        """
        parts = [f"{m.get('role')}: {_text(m.get('content'))}"]
        for tc in (m.get("tool_calls") or []):
            if not isinstance(tc, dict):
                continue
            fn = tc.get("function") or {}
            args = str(fn.get("arguments") or "")
            parts.append(f"  -> {fn.get('name', '')}({args[:200]})")
        return "\n".join(parts)

    def _total_chars(self) -> int:
        return sum(self._msg_chars(m) for m in self.history)

    @staticmethod
    def _msg_chars(m: dict) -> int:
        """Approximate how much context one message actually consumes.

        Counting `content` alone badly under-counted tool-heavy runs: an assistant
        turn that issues a tool call has `content: None` and carries its payload in
        `tool_calls[].function.arguments` (e.g. writing a long file). Those turns
        counted as 0, so the budget was missed by orders of magnitude and
        compression never fired — the context grew until the API rejected it.
        """
        n = len(_text(m.get("content")))
        for tc in (m.get("tool_calls") or []):
            if not isinstance(tc, dict):
                continue
            fn = tc.get("function") or {}
            n += len(str(fn.get("name") or "")) + len(str(fn.get("arguments") or ""))
            n += 32  # per-call overhead: id/type/role scaffolding sent to the model
        return n


def _text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(part.get("text", "")) for part in content if isinstance(part, dict))
    return "" if content is None else str(content)


# ---------------------------------------------------------------------------
# Zero-loss side-log for truncated tool results.
#
# When a tool result is capped by `_cap_tool_text`, its FULL text is written here so
# the model can fetch it back later via the `recall_tool_log` executor tool. Files are
# named by a random id (no collision, no path traversal) and written atomically
# (tmp + os.replace) so a crash mid-write never leaves a half file.
# ---------------------------------------------------------------------------

def write_tool_log_text(tool_log_dir: str | None, text: str) -> str | None:
    """Write `text` to `<tool_log_dir>/<id>.txt` atomically; return the id or None."""
    if not tool_log_dir:
        return None
    try:
        os.makedirs(tool_log_dir, exist_ok=True)
        tid = "tl_" + uuid.uuid4().hex[:12]
        path = os.path.join(tool_log_dir, tid + ".txt")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
        return tid
    except OSError:
        return None


def read_tool_log(tool_log_dir: str | None, tid: str) -> str | None:
    """Read a side-log entry by id. Sanitises `tid` to block path traversal; returns
    None when the dir/entry is missing or the id is malformed."""
    if not tool_log_dir or not tid:
        return None
    if not isinstance(tid, str) or not re.fullmatch(r"[A-Za-z0-9_\-]{1,64}", tid):
        return None
    path = os.path.join(tool_log_dir, tid + ".txt")
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except (FileNotFoundError, IsADirectoryError):
        return None
    except OSError:
        return None


def cap_tool_result(text: str, cap: int, head_lines: int, tail_lines: int,
                    tool_log_dir: str | None) -> str:
    """Head/tail truncate a tool result for the LIVE history (Loop B / _agent_stream).

    Mirrors the lossless behaviour of SessionMemory._cap_tool_msg: when `text` is actually
    over `cap`, only head+tail lines are kept in-line and the FULL text (as received by the
    agent loop) is persisted to the side-log with an embedded `recall_tool_log(id)` marker.
    `tool_log_dir` None -> lossy head/tail. `cap <= 0` -> no truncation. A multimodal
    `list` result is returned unchanged (the caller handles that case separately).

    If `text` already carries a recall id from an upstream truncation (e.g. the executor's
    own max_result_chars side-log), that id is preserved as a one-line pointer so the model
    can still fetch the *full* original through one more recall — the cap is never lossy.
    """
    if not cap or len(text) <= cap:
        return text
    if isinstance(text, list):
        return text
    prev_id = None
    m = re.search(r"tool-log id=([A-Za-z0-9_\-]{1,64})", text)
    if m:
        prev_id = m.group(1)
    capped = SessionMemory._cap_tool_text(text, cap, head_lines, tail_lines)
    if capped is text:
        return text
    if tool_log_dir:
        tid = write_tool_log_text(tool_log_dir, text)
        if tid:
            capped = SessionMemory._cap_tool_text(text, cap, head_lines, tail_lines, log_id=tid)
            if prev_id and prev_id != tid:
                capped = capped + (f"\n(previous full original also available: "
                                   f"recall_tool_log(\"{prev_id}\"))")
    return capped
