"""CJK-aware tokenizer shared by the memory layers (pure standard library).

Why this module exists
----------------------
FTS5's default `unicode61` tokenizer splits on whitespace/punctuation. A *run* of
Chinese characters has neither, so the whole run becomes ONE token:

    stored : "决定：账本缓存改用 60 秒 TTL"  ->  token "账本缓存改用"
    query  : "账本缓存"                     ->  token "账本缓存"

Token-level matching can never match those two, and FTS5 does no substring
matching. Net effect for a Chinese-language user: recall returned 0 hits for
almost every query, which silently disabled the "gets smarter with use" promise
(the query only hit when it happened to contain an ASCII word like "key").

The fix: index and query with the SAME bigram expansion. A CJK run
"账本缓存改用" becomes the bigrams 账本 / 本缓 / 缓存 / 存改 / 改用, each stored
as its own token. The query is expanded identically and OR-ed, so a partial
query matches, and bm25 still ranks the record with more overlapping bigrams
higher — relevance ranking is preserved, not replaced.

The same expansion feeds `tokens()`, which the pure-stdlib hash vectorizer uses;
before this it dropped every Chinese character (`[a-z0-9]+` matched nothing), so
the vector path was a zero vector for Chinese text too.
"""
from __future__ import annotations

import re

# CJK ideographs (ext A + unified), kana, and CJK compatibility ideographs.
_CJK_CLASS = (
    "\u3400-\u4dbf"      # CJK Ext A
    "\u4e00-\u9fff"      # CJK unified
    "\uf900-\ufaff"      # CJK compatibility ideographs
    "\u3040-\u30ff"      # kana
)
_ASCII_OR_CJK = re.compile(rf"[a-z0-9_]+|[{_CJK_CLASS}]+")
_CJK_ONLY = re.compile(rf"[{_CJK_CLASS}]")


def _is_cjk(tok: str) -> bool:
    return bool(tok) and bool(_CJK_ONLY.match(tok[0]))


def bigrams(run: str) -> list:
    """Split a CJK run into overlapping bigrams (single chars are kept as-is)."""
    if len(run) <= 1:
        return [run] if run else []
    return [run[i:i + 2] for i in range(len(run) - 1)]


def tokens(text: str) -> list:
    """Split text into index/query tokens. CJK runs are expanded to bigrams."""
    out = []
    for tok in _ASCII_OR_CJK.findall((text or "").lower()):
        out.extend(bigrams(tok) if _is_cjk(tok) else [tok])
    return out


def index_text(text: str) -> str:
    """Build the space-separated text stored in the FTS index column."""
    return " ".join(tokens(text))


def fts_query(query: str) -> str:
    """Build an FTS5 MATCH expression: every token OR-ed, CJK bigram-expanded."""
    toks = tokens(query)
    if not toks:
        return ""
    return " OR ".join('"' + t.replace('"', "") + '"' for t in toks)
