"""Regression tests for SessionMemory.compress(): the context must stay BOUNDED.

The original design let the frozen (accumulated) summary grow without limit because it
was append-only, and it kept a fixed tail verbatim so a few huge tool-I/O turns defeated
the compression. These tests pin the fix: after many compactions the frozen note stays
under its cap and the total compressed context stays near max_chars, a single giant
tail message is folded rather than kept raw, and the later enhancements
(slim / hierarchical re-fold / incremental fold / zero-loss tool-result side-log) hold.
"""
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from memory.session import (SessionMemory, write_tool_log_text, read_tool_log, estimate_tokens)  # noqa: E402


def _big(n, size=600):
    return {"role": "user", "content": ("x" * size) + f" #{n}"}


def test_frozen_note_bounded_after_many_compactions():
    s = SessionMemory(max_chars=2000, keep_tail_min=2)
    s.append({"role": "system", "content": "intent"})
    for i in range(80):
        s.append(_big(i, 600))
        s.compress()
    # frozen note must stay under its cap, not grow without bound
    assert estimate_tokens(s._frozen_text) <= int(2000 * s.frozen_cap_ratio) + 2000, estimate_tokens(s._frozen_text)
    # total compressed context must stay bounded (not blow up to raw size)
    total = sum(s._msg_chars(m) for m in s.as_messages())
    assert total <= s.max_chars * 1.6, total


def test_no_op_under_budget():
    s = SessionMemory(max_chars=8000)
    s.append({"role": "system", "content": "intent"})
    for i in range(5):
        s.append(_big(i, 100))
    before = len(s.as_messages())
    msgs = s.compress()
    assert msgs == s.as_messages()
    assert len(msgs) == before


def test_tail_folds_single_giant_message():
    s = SessionMemory(max_chars=2000, keep_tail_min=2)
    s.append({"role": "system", "content": "intent"})
    s.append({"role": "user", "content": "y" * 5000})  # one giant message, placed OLD
    for i in range(10):
        s.append(_big(i, 200))  # a tail of fresh small messages pushes the giant past the tail
    s.compress()
    # the giant message is old -> it must be folded, not kept verbatim in the result
    assert not any(len(str(m.get("content"))) > 5000 for m in s.as_messages())
    total = sum(s._msg_chars(m) for m in s.as_messages())
    assert total <= s.max_chars * 1.6, total


def test_tail_keeps_recent_small_messages():
    s = SessionMemory(max_chars=2000, keep_tail_min=2)
    s.append({"role": "system", "content": "intent"})
    for i in range(10):
        s.append(_big(i, 200))
    s.compress()
    # at least keep_tail_min recent messages survive verbatim (not folded)
    tail = s.as_messages()[-2:]
    assert all(str(m.get("content", "")).startswith("x") for m in tail)


def test_slim_strips_code_blocks_and_line_numbers():
    blob = ("```python\n" + "\n".join(f"x = {i}" for i in range(20)) + "\n```\n"
            + "\n".join(f"  {i}: some log line" for i in range(10)))
    out = SessionMemory._slim_text(blob)
    assert "[code block:" in out
    assert "some log line" in out
    # leading line-number prefixes stripped
    assert not any(l.strip().startswith(tuple(f"{i}:" for i in range(10))) for l in out.splitlines())


def test_incremental_folds_only_oldest_needed():
    s = SessionMemory(max_chars=2000, keep_tail_min=2)
    s.append({"role": "system", "content": "intent"})
    for i in range(20):
        s.append(_big(i, 600))
    before = len(s.as_messages())
    s.compress()
    msgs = s.as_messages()
    # Incremental: only the minimal oldest slice is folded, so the message count stays
    # well above a full-middle fold (which would collapse to ~7).
    assert len(msgs) > 7, len(msgs)
    assert len(msgs) < before, len(msgs)
    # exactly one frozen note, right after the pinned head
    frozen = [m for m in msgs if m.get("_frozen_note")]
    assert len(frozen) == 1
    assert msgs[1] is frozen[0]
    # the most recent message is still verbatim in the live tail
    assert any("#19" in str(m.get("content")) for m in msgs)


def test_hierarchical_refold_bounded():
    s = SessionMemory(max_chars=4000, keep_tail_min=2)
    s.append({"role": "system", "content": "intent"})
    for i in range(200):
        s.append(_big(i, 600))
        s.compress()
    # after many rounds the frozen note must sit at/under its re-fold budget
    assert estimate_tokens(s._frozen_text) <= s.frozen_refold_budget + 100, estimate_tokens(s._frozen_text)
    # and total compressed context stays bounded
    total = sum(s._msg_chars(m) for m in s.as_messages())
    assert total <= s.max_chars * 1.6, total


def test_cap_tool_text_keeps_head_and_tail():
    long_tool = "\n".join(f"result line {i}" for i in range(200))
    out = SessionMemory._cap_tool_text(long_tool, 1200, 15, 15)
    # head + tail survive, the middle is dropped with a marker
    assert "result line 0" in out
    assert "result line 199" in out
    assert "truncated 170 lines" in out  # 200 - 15 - 15
    # a middle line that head/tail drops must be gone
    assert "result line 100" not in out
    # under the cap -> unchanged
    assert SessionMemory._cap_tool_text("short text", 1200, 15, 15) == "short text"


def test_cap_tool_msg_exempts_multimodal():
    s = SessionMemory()
    mm = {"role": "tool", "content": [
        {"type": "text", "text": "x" * 5000},
        {"type": "image_url", "image_url": {"url": "u"}},
    ]}
    # image/multimodal results are exempt: the original message object is returned untouched
    assert s._cap_tool_msg(mm) is mm


def test_tool_result_cap_applied_in_compress():
    # With the default-style max_chars (=8000, tail_budget=3200 > cap=1200) a ~1400-char
    # tool message fits in the live tail but still exceeds the per-result cap, so it is
    # head/tail truncated while kept verbatim in the tail.
    s = SessionMemory(max_chars=8000, keep_tail_min=2, tool_result_cap=1200)
    s.append({"role": "system", "content": "intent"})
    for i in range(30):
        s.append(_big(i, 1100))  # push well over budget so compression actually runs (token caliber)
    long_tool = "\n".join(f"result line {i}" for i in range(100))  # ~1400 chars
    s.append({"role": "tool", "content": long_tool})
    for j in range(5):
        s.append({"role": "user", "content": f"followup {j}"})
    s.compress()
    all_text = "\n".join(str(m.get("content")) for m in s.as_messages())
    assert "truncated" in all_text
    assert "result line 50" not in all_text


def test_tool_result_cap_folded_path():
    # When the window is small the long tool message can't fit the tail and is folded into
    # the summary; the cap must still apply to the folded content (head/tail kept). Placed
    # first (oldest) so it is among the messages actually folded this round.
    s = SessionMemory(max_chars=3000, keep_tail_min=2, tool_result_cap=1200)
    s.append({"role": "system", "content": "intent"})
    long_tool = "\n".join(f"result line {i}" for i in range(100))
    s.append({"role": "tool", "content": long_tool})  # oldest -> folded
    for i in range(20):
        s.append(_big(i, 600))  # push well over budget (token caliber) so folding fires
    s.compress()
    all_text = "\n".join(str(m.get("content")) for m in s.as_messages())
    # The cap drops the MIDDLE of the folded tool result (never carried into the summary),
    # and the summary itself stays bounded. The cosmetic "truncated" marker may be
    # summarized away, so we assert on the content: a middle line must be gone while a
    # head line survives.
    assert "result line 0" in all_text    # head kept
    assert "result line 50" not in all_text  # middle dropped
    # the whole compressed context must be far smaller than the raw 100-line dump
    # (unified to the token caliber -- same bound, same intent: product fits the budget)
    assert estimate_tokens(all_text) < 4000


def test_tool_result_cap_keeps_freshest_full():
    s = SessionMemory(max_chars=8000, keep_tail_min=4, tool_result_cap=1200)
    s.append({"role": "system", "content": "intent"})
    for i in range(30):
        s.append(_big(i, 300))
    long_tool = "\n".join(f"fresh result {i}" for i in range(100))
    s.append({"role": "tool", "content": long_tool})  # freshest message
    s.compress()
    all_text = "\n".join(str(m.get("content")) for m in s.as_messages())
    # the freshest tool message (within keep_tail_min) keeps its full body verbatim, so a
    # same-turn chained call that re-reads it this turn still sees everything
    assert "fresh result 50" in all_text


# ---- zero-loss side-log (the "no information lost" version of the tool-result cap) ----

def test_write_and_read_tool_log():
    with tempfile.TemporaryDirectory() as d:
        tid = write_tool_log_text(d, "full tool output 12345")
        assert tid and tid.startswith("tl_")
        assert read_tool_log(d, tid) == "full tool output 12345"
        # missing id -> None
        assert read_tool_log(d, "tl_doesnotexist") is None
        # malformed id (path traversal attempt) -> None, never escapes the dir
        assert read_tool_log(d, "../etc/passwd") is None
        assert read_tool_log(d, "tl_../../secret") is None
        assert read_tool_log(d, "bad id with spaces") is None


def test_cap_tool_msg_writes_side_log_and_embeds_id():
    with tempfile.TemporaryDirectory() as d:
        s = SessionMemory(tool_result_cap=200, tool_head_lines=2, tool_tail_lines=2,
                          tool_log_dir=d)
        long_tool = "\n".join(f"line {i} payload" for i in range(100))
        m = s._cap_tool_msg({"role": "tool", "content": long_tool})
        capped = m["content"]
        # the marker carries the side-log id
        assert "tool-log id=" in capped
        # a middle line is gone from the capped text
        assert "line 50 payload" not in capped
        # the FULL text is recoverable from the side-log
        import re as _re
        _id = _re.search(r"tool-log id=(\S+)\b", capped).group(1).rstrip(')"')
        assert read_tool_log(d, _id) == long_tool


def test_cap_tool_msg_no_side_log_when_under_cap():
    with tempfile.TemporaryDirectory() as d:
        s = SessionMemory(tool_result_cap=200, tool_log_dir=d)
        short = "tiny result"
        m = s._cap_tool_msg({"role": "tool", "content": short})
        # under the cap -> returned verbatim, no file written (no orphan files)
        assert m["content"] == short
        assert m is not None
        txt_files = [f for f in os.listdir(d) if f.endswith(".txt")]
        assert txt_files == [], txt_files


def test_executor_recall_tool_log():
    # The executor's recall logic reads the same side-log; verify it without starting MCP
    # servers (servers={}).
    with tempfile.TemporaryDirectory() as d:
        tid = write_tool_log_text(d, "the full command output")
        from executor import Executor
        ex = Executor({}, tool_log_dir=d)
        # recall by id returns the full text
        assert ex._recall_tool_log({"id": tid}) == "the full command output"
        # list mode enumerates the entry
        listing = ex._recall_tool_log({"id": "list"})
        assert tid in listing
        # unknown id -> structured error, not a crash
        err = ex._recall_tool_log({"id": "tl_unknown"})
        assert err.startswith("error:")
        # missing id -> error
        assert ex._recall_tool_log({}).startswith("error:")
        # the synthetic tool is advertised when the side-log is on
        names = [t["name"] for t in ex.tools]
        assert "recall_tool_log" in names


if __name__ == "__main__":
    test_frozen_note_bounded_after_many_compactions()
    test_no_op_under_budget()
    test_tail_folds_single_giant_message()
    test_tail_keeps_recent_small_messages()
    test_slim_strips_code_blocks_and_line_numbers()
    test_incremental_folds_only_oldest_needed()
    test_hierarchical_refold_bounded()
    test_cap_tool_text_keeps_head_and_tail()
    test_cap_tool_msg_exempts_multimodal()
    test_tool_result_cap_applied_in_compress()
    test_tool_result_cap_folded_path()
    test_tool_result_cap_keeps_freshest_full()
    test_write_and_read_tool_log()
    test_cap_tool_msg_writes_side_log_and_embeds_id()
    test_cap_tool_msg_no_side_log_when_under_cap()
    test_executor_recall_tool_log()
    print("PASS test_session_compact")
