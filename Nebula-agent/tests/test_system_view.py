"""Regression test for the DIRECT_SYSTEM_PROMPT fallback.

The web frontend always sends its own (Chinese) system prompt via apiMessages(),
so the backend must NOT prepend the redundant English DIRECT_SYSTEM_PROMPT when a
system message is already present. It should only inject it as a fallback for
clients (raw API/CLI) that supply no system message.
"""
import os
import sys

_RUNTIME = os.path.join(os.path.dirname(__file__), "..", "runtime")
if _RUNTIME not in sys.path:
    sys.path.insert(0, _RUNTIME)

from http_server import system_view_with_fallback, DIRECT_SYSTEM_PROMPT


def test_no_prepend_when_system_present():
    msgs = [{"role": "system", "content": "frontend system"},
            {"role": "user", "content": "hi"}]
    out = system_view_with_fallback(msgs)
    assert out is msgs, "must return the same list, no duplicate system prepended"
    assert len(out) == 2
    assert out[0]["content"] == "frontend system"


def test_prepend_when_no_system():
    msgs = [{"role": "user", "content": "hi"}]
    out = system_view_with_fallback(msgs)
    assert len(out) == 2
    assert out[0]["role"] == "system"
    assert out[0]["content"] == DIRECT_SYSTEM_PROMPT
    assert out[1]["role"] == "user"


def test_empty_messages_gets_fallback():
    out = system_view_with_fallback([])
    assert len(out) == 1
    assert out[0]["role"] == "system"
    assert out[0]["content"] == DIRECT_SYSTEM_PROMPT


def test_non_system_first_message_gets_fallback():
    msgs = [{"role": "assistant", "content": "stray"},
            {"role": "user", "content": "hi"}]
    out = system_view_with_fallback(msgs)
    assert out[0]["role"] == "system"


if __name__ == "__main__":
    test_no_prepend_when_system_present()
    test_prepend_when_no_system()
    test_empty_messages_gets_fallback()
    test_non_system_first_message_gets_fallback()
    print("ALL PASSED")
