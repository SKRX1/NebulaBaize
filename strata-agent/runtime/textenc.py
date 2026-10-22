"""Decoding helpers for text that crosses a process boundary on Windows.

Everything here exists for one reason: the *locale* codec is not the *wire* codec.
On a Chinese Windows the locale codec is GBK, while MCP-over-stdio, our own HTTP/SSE
responses, and virtually every modern tool (python, node, git) speak UTF-8. Mixing
them silently corrupts Chinese text -- and a strict GBK decode of UTF-8 input does not
even corrupt quietly, it raises or emits lone surrogates.

`smart_decode` is the shared answer: prefer UTF-8, fall back to GBK. A GBK byte pair is
essentially never valid UTF-8, so the fallback is unambiguous -- whereas the reverse
order (UTF-8 read as GBK) always "succeeds" into mojibake, which is how this bug hides.
"""
from __future__ import annotations

WIRE_ENCODING = "utf-8"     # what every peer we talk to actually uses


def smart_decode(data) -> str:
    """Bytes -> str: UTF-8 first, then GBK, then a lossy UTF-8 pass. Never raises."""
    if isinstance(data, str):
        return data
    if not data:
        return ""
    for enc in (WIRE_ENCODING, "gbk"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode(WIRE_ENCODING, "replace")

