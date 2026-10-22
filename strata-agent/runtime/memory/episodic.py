"""Episodic memory: an append-only cross-conversation event log.

Pure standard library. Events are stored as JSONL in data/episodic.jsonl. Used to recall
specific past events (what happened, what was decided) across sessions.

Search uses bm25 relevance (FTS5, built in-memory over the JSONL records) so that, as
events accumulate, recall ranks by relevance instead of plain substring matching. Falls
back to substring matching if FTS5 is unavailable.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time

from .tokenize import fts_query, index_text


def _norm_hash(text: str) -> str:
    return hashlib.sha256(text.strip().lower().encode("utf-8")).hexdigest()[:16]


def _fts_query(query: str) -> str:
    # CJK-aware: a bare whitespace split left a Chinese query as one giant token that
    # could never match a stored run, so Chinese recall silently returned nothing.
    return fts_query(query)


class EpisodicMemory:
    def __init__(self, path: str = "data/episodic.jsonl"):
        self.path = path
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        self._seen = self._load_hashes()

    def _rows(self):
        if not os.path.isfile(self.path):
            return []
        with open(self.path, "r", encoding="utf-8") as f:
            return [json.loads(l) for l in f if l.strip()]

    def _load_hashes(self) -> set:
        return {_norm_hash(r.get("event", "")) for r in self._rows()}

    def log(self, event: str, meta: dict | None = None) -> None:
        # dedup: skip if the exact same normalized event was already logged
        h = _norm_hash(event)
        if h in self._seen:
            return
        rec = {"ts": time.time(), "event": event, "meta": meta or {}}
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        self._seen.add(h)

    def recent(self, n: int = 20) -> list[dict]:
        return self._rows()[-n:]

    def search(self, query: str) -> list[dict]:
        rows = self._rows()
        if not rows:
            return []
        ranked = self._fts_search(rows, query)
        if ranked:
            return ranked
        # substring fallback. NOTE: this used to be gated on `ranked is not None`,
        # but `_fts_search` returns [] (not None) on a clean miss, so the fallback
        # never ran for the exact case it existed for — a miss returned an empty
        # result instead of degrading to substring matching.
        q = (query or "").lower()
        if not q:
            return []
        return [r for r in rows
                if q in r.get("event", "").lower() or q in json.dumps(r.get("meta", {})).lower()]

    def _fts_search(self, rows, query: str):
        m = _fts_query(query)
        if not m:
            return None
        try:
            conn = sqlite3.connect(":memory:")
            # `event` holds the bigram-expanded text (what we MATCH against); `orig`
            # is UNINDEXED and carries the verbatim event back out, so ranking never
            # rewrites the record the caller sees.
            conn.execute("CREATE VIRTUAL TABLE t USING fts5(event, meta, orig UNINDEXED)")
            data = [(index_text(r.get("event", "")),
                     json.dumps(r.get("meta", {}), ensure_ascii=False),
                     r.get("event", ""))
                    for r in rows]
            conn.executemany("INSERT INTO t(event, meta, orig) VALUES (?,?,?)", data)
            res = conn.execute(
                "SELECT orig, meta, bm25(t) r FROM t WHERE t MATCH ? ORDER BY r", (m,)).fetchall()
            conn.close()
            return [{"event": e, "meta": json.loads(m_) if m_ else {},
                     "score": -sc} for (e, m_, sc) in res]
        except sqlite3.OperationalError:
            return None

