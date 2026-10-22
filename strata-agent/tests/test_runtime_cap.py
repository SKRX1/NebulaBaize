"""Tests for the lossless tool-result caps (Items 1-3):

- session.cap_tool_result  : head/tail truncation + side-log + upstream id pointer (Loop B)
- executor._truncate_result: source-level cap + side-log (Loop B, this-turn guard)
- http_server wiring       : _RT_CAP_KEYS exposed + GatewayState defaults
"""
import os
import sys
import tempfile

sys.path.insert(0, "runtime")

from memory.session import cap_tool_result, write_tool_log_text, read_tool_log
import executor as _exec


def _hundred():
    return "\n".join(f"line {i:03d} content" for i in range(100))


def test_cap_tool_result_head_tail_and_side_log():
    d = tempfile.mkdtemp()
    txt = _hundred()  # 100 lines
    out = cap_tool_result(txt, cap=200, head_lines=15, tail_lines=15, tool_log_dir=d)
    assert "line 000" in out          # head kept
    assert "line 099" in out          # tail kept
    assert "line 050" not in out      # middle dropped
    assert "recall_tool_log" in out   # side-log id embedded
    # the side-log file should exist and hold the FULL text
    tid = None
    for fn in os.listdir(d):
        if fn.endswith(".txt"):
            tid = fn[:-4]
    assert tid, "a side-log file must be written"
    assert read_tool_log(d, tid) == txt


def test_cap_tool_result_under_cap_is_noop():
    d = tempfile.mkdtemp()
    txt = "short text"
    assert cap_tool_result(txt, cap=200, head_lines=15, tail_lines=15,
                           tool_log_dir=d) == txt
    # no side-log file written for an under-cap result
    assert not [f for f in os.listdir(d) if f.endswith(".txt")]


def test_cap_tool_result_preserves_upstream_id():
    d = tempfile.mkdtemp()
    txt = (_hundred()
           + "\n(FULL output saved as tool-log id=tl_prev123; call recall_tool_log(\"tl_prev123\") to read all 2000 chars)")
    out = cap_tool_result(txt, cap=200, head_lines=15, tail_lines=15, tool_log_dir=d)
    # the model must still be able to reach the truly-full original via the upstream id
    assert 'recall_tool_log("tl_prev123")' in out


def test_cap_tool_result_lossy_without_log_dir():
    txt = _hundred()
    out = cap_tool_result(txt, cap=200, head_lines=15, tail_lines=15, tool_log_dir=None)
    assert "line 050" not in out
    assert "recall_tool_log" not in out   # no side-log -> no id


def test_cap_tool_result_multimodal_exempt():
    img = [{"type": "image", "data": "base64..."}]
    assert cap_tool_result(img, cap=200, head_lines=15, tail_lines=15,
                          tool_log_dir=tempfile.mkdtemp()) is img


def test_executor_truncate_result_side_log():
    d = tempfile.mkdtemp()
    out = _exec._truncate_result("x" * 20000, cap=10000, tool_log_dir=d)
    assert len(out) <= 10000 + 200
    assert "recall_tool_log" in out
    tids = [f for f in os.listdir(d) if f.endswith(".txt")]
    assert tids
    assert len(read_tool_log(d, tids[0][:-4])) == 20000


def test_executor_truncate_result_under_cap():
    out = _exec._truncate_result("small", cap=10000, tool_log_dir=tempfile.mkdtemp())
    assert out == "small"


def test_http_server_runtime_cap_wiring():
    import http_server as _http
    keys = set(_http.GatewayHandler._RT_CAP_KEYS)
    assert {"tool_result_cap", "tool_head_lines", "tool_tail_lines",
            "tool_keep_recent"} <= keys
    st = _http.GatewayState("http://x")
    assert st.tool_result_cap == 10000
    assert _exec.DEFAULTS["max_result_chars"] == 30000
    assert st.tool_keep_recent == 2
    assert st.tool_head_lines == 15
    assert st.tool_tail_lines == 15
    # the helper must be importable from the gateway module
    assert callable(_http.cap_tool_result)


if __name__ == "__main__":
    test_cap_tool_result_head_tail_and_side_log()
    test_cap_tool_result_under_cap_is_noop()
    test_cap_tool_result_preserves_upstream_id()
    test_cap_tool_result_lossy_without_log_dir()
    test_cap_tool_result_multimodal_exempt()
    test_executor_truncate_result_side_log()
    test_executor_truncate_result_under_cap()
    test_http_server_runtime_cap_wiring()
    print("PASS test_runtime_cap")
