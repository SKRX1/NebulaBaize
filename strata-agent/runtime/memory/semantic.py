"""Semantic memory: sqlite-backed store with real full-text relevance (FTS5, bm25).

Pure standard library (sqlite3 ships with FTS5). This is the search-quality upgrade that
makes "get smarter with use" actually work: as memories accumulate, plain LIKE %q% would
pull in noise with no ranking, so we use an FTS5 content-table + bm25 relevance ranking
(multi-word OR queries, lower bm25 score = more relevant).

Dedup: rows are keyed by a normalized-content hash with a UNIQUE index, so re-storing the
same fact (from repeated auto-distills) merges instead of piling up.

sqlite-vec stays OPTIONAL: when a future embed_fn + the sqlite-vec extension are present,
vector search would take over; until then FTS5 is the primary path (it is the honest
implementation of "FTS-style matching" promised in earlier notes).
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import sqlite3
import time

from .tokenize import fts_query, index_text, tokens

# `idx` is the bigram-expanded index text (see memory/tokenize.py). FTS indexes `idx`
# rather than the raw `text`: FTS5 tokenizes a whole Chinese run as one token, so
# indexing the raw text made Chinese recall return 0 hits. Index and query must go
# through the SAME expansion, which is why `add()` stores index_text(text) here and
# `_fts_search()` builds its MATCH expression from tokenize.fts_query().
SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    idx TEXT,
    meta TEXT,
    hash TEXT NOT NULL UNIQUE,
    embedding TEXT,
    created_at REAL
);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(idx, content=items, content_rowid=id);
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_fts(rowid, idx) VALUES (new.id, new.idx);
END;
CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, idx) VALUES('delete', old.id, old.idx);
END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, idx) VALUES('delete', old.id, old.idx);
    INSERT INTO items_fts(rowid, idx) VALUES (new.id, new.idx);
END;
"""


def hash_vectorizer(text: str, dim: int = 256) -> list:
    """Pure-stdlib embedding: a hashing feature vectorizer (bag of hashed word tokens).

    Deterministic, no external model, no deps — this makes the VECTOR path genuinely
    runnable today (cosine over these vectors) instead of a dead sqlite-vec-only stub.
    It is a real (if simple) vector embedding: token counts hashed into `dim` bins and
    L2-normalized, so cosine similarity behaves like a normalized bag-of-words match.
    A future LLM/transformer embed_fn passed to SemanticMemory(embed_fn=...) supersedes
    this with no code change.
    """
    vec = [0.0] * dim
    for tok in _tokens(text):
        h = int(hashlib.md5(tok.encode("utf-8")).hexdigest(), 16)
        vec[h % dim] += 1.0
    n = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / n for v in vec]


def _tokens(text: str) -> list:
    # CJK-aware: the old `[a-z0-9]+` pattern dropped every Chinese character, so a
    # Chinese memory produced an all-zero vector and cosine was 0 for every pair.
    return tokens(text)


def cosine(a: list, b: list) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(y * y for y in b)) or 1.0
    return dot / (na * nb)


def _norm_hash(text: str) -> str:
    return hashlib.sha256(text.strip().lower().encode("utf-8")).hexdigest()[:16]


def _fts_query(query: str) -> str:
    # CJK-aware bigram expansion; OR the tokens so any-token matches rank by bm25
    return fts_query(query)


class SemanticMemory:
    def __init__(self, path: str = "data/semantic.db", embed_fn=None, search_mode="auto"):
        self.path = path
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        # Embedding backend is pluggable: None => the built-in pure-stdlib hash vectorizer
        # (runnable now); pass an LLM/transformer embed_fn(text)->list[float] to supersede.
        self.embed_fn = embed_fn or hash_vectorizer
        # "auto" => use vector when embeddings are present, else FTS; force "fts"/"vector".
        self.search_mode = search_mode
        self.conn = sqlite3.connect(self.path)
        self.conn.executescript(SCHEMA)
        self.conn.commit()
        self._migrate()

    def _migrate(self):
        """Guard DBs created by older schemas (no hash column, no idx column).

        Two legacy shapes are handled, both idempotently:
          - no `hash` column  -> add it and backfill, so UNIQUE dedup keeps working.
          - no `idx` column, or an items_fts built over the raw `text` column ->
            add/backfill `idx` and rebuild the FTS index over it, so Chinese recall
            starts working on stores created before the bigram tokenizer existed.
        A freshly created store is already correct, so this is a no-op there.
        """
        cols = [r[1] for r in self.conn.execute("PRAGMA table_info(items)")]
        if "hash" not in cols:
            self.conn.execute("ALTER TABLE items ADD COLUMN hash TEXT")
            cols.append("hash")
            for _id, text in self.conn.execute("SELECT id, text FROM items").fetchall():
                self.conn.execute("UPDATE items SET hash=? WHERE id=?", (_norm_hash(text), _id))
            self.conn.commit()
        names = self._table_names()
        # A legacy index built over the raw `text` column must be torn down BEFORE the
        # `idx` column is backfilled: the legacy triggers write into items_fts(rowid,
        # text) and would fail the moment items_fts is gone or lacks that column. They
        # also share names with the new triggers, so `CREATE TRIGGER IF NOT EXISTS`
        # would silently keep the stale definitions.
        legacy_fts = "items_fts" in names and "idx" not in self._fts_cols()
        if legacy_fts:
            for trg in ("items_ai", "items_ad", "items_au"):
                self.conn.execute(f"DROP TRIGGER IF EXISTS {trg}")
            self.conn.execute("DROP TABLE IF EXISTS items_fts")
            self.conn.commit()

        need_rebuild = legacy_fts
        if "idx" not in cols:
            self.conn.execute("ALTER TABLE items ADD COLUMN idx TEXT")
            for _id, text in self.conn.execute("SELECT id, text FROM items").fetchall():
                self.conn.execute("UPDATE items SET idx=? WHERE id=?", (index_text(text), _id))
            self.conn.commit()
            need_rebuild = True
        if "items_fts" not in self._table_names():
            self.conn.executescript(SCHEMA)
            self.conn.commit()
            need_rebuild = True
        if need_rebuild:
            self._rebuild_fts()

    def _table_names(self) -> list:
        return [r[0] for r in self.conn.execute("SELECT name FROM sqlite_master")]

    def _fts_cols(self) -> list:
        try:
            return [r[1] for r in self.conn.execute("PRAGMA table_info(items_fts)")]
        except Exception:
            return []

    def _rebuild_fts(self) -> None:
        """Repopulate the external-content FTS table from `items.idx`."""
        try:
            self.conn.execute("INSERT INTO items_fts(items_fts) VALUES('rebuild')")
            self.conn.commit()
        except Exception:
            pass

    def add(self, text: str, meta: dict | None = None) -> int:
        h = _norm_hash(text)
        # dedup: return existing id if the same normalized content is already stored
        row = self.conn.execute("SELECT id FROM items WHERE hash=?", (h,)).fetchone()
        if row:
            return row[0]
        emb = json.dumps(self.embed_fn(text)) if self.embed_fn else None
        cur = self.conn.execute(
            "INSERT INTO items(text, idx, meta, hash, embedding, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (text, index_text(text), json.dumps(meta or {}, ensure_ascii=False), h,
             emb, time.time()),
        )
        self.conn.commit()
        return cur.lastrowid

    def delete(self, item_id: int) -> bool:
        """Delete a single stored item by id. The FTS5 index stays consistent via the
        AFTER DELETE trigger (items_ad). Returns True if a row was removed.
        """
        cur = self.conn.execute("DELETE FROM items WHERE id=?", (item_id,))
        self.conn.commit()
        return cur.rowcount > 0

    def delete_source(self, source: str) -> int:
        """Delete every item ingested under a given source (e.g. one document path).

        This is the "user decides which corpus to drop" path: ingesting a document tags
        each chunk with meta.source == the document id/path, so deleting the whole document
        is one call. Returns the number of rows removed.
        """
        rows = self.conn.execute(
            "SELECT id FROM items WHERE json_extract(meta, '$.source')=?", (source,)).fetchall()
        ids = [r[0] for r in rows]
        for _id in ids:
            self.conn.execute("DELETE FROM items WHERE id=?", (_id,))
        self.conn.commit()
        return len(ids)

    def list_sources(self) -> list[dict]:
        """Summary of stored sources -> chunk counts, so the user can decide what to delete."""
        rows = self.conn.execute(
            "SELECT json_extract(meta, '$.source') AS src, COUNT(*) "
            "FROM items WHERE src IS NOT NULL GROUP BY src ORDER BY src").fetchall()
        return [{"source": src, "chunks": n} for (src, n) in rows]

    def get_by_source(self, source: str) -> list[dict]:
        """Every chunk stored under a given source id.

        Used by the UI 'view source' feature: the user clicks a knowledge-base source and
        sees the exact chunks that recall would inject. Returns [] when the source is empty
        or unknown (so the caller can show a friendly 'nothing here' instead of erroring).
        """
        rows = self.conn.execute(
            "SELECT id, text, meta FROM items WHERE json_extract(meta, '$.source')=?",
            (source,)).fetchall()
        return [{"id": r[0], "text": r[1], "meta": json.loads(r[2] or "{}")} for r in rows]

    def search(self, query: str, top_k: int = 5) -> list[dict]:
        # FTS5 bm25 is the verified default. Vector (pure-Python cosine) is used when
        # explicitly requested (search_mode="vector") — e.g. after wiring a real embedding
        # backend — and falls back to FTS if embeddings are missing. "auto" uses vector only
        # if a non-default embed_fn was provided AND every row has a stored embedding.
        if self.search_mode == "vector" and self.embed_fn is not None:
            rows = self.conn.execute("SELECT embedding FROM items").fetchall()
            if rows and all(r[0] is not None for r in rows):
                vec = self._vector_search(query, top_k)
                if vec is not None:
                    return vec
        return self._fts_search(query, top_k)

    def _fts_search(self, query: str, top_k: int) -> list[dict]:
        m = _fts_query(query)
        if not m:
            return []
        # bm25() runs only against the fts table; join back to content for fields
        rows = self.conn.execute(
            "SELECT rowid, bm25(items_fts) AS r FROM items_fts "
            "WHERE items_fts MATCH ? ORDER BY r LIMIT ?", (m, top_k),
        ).fetchall()
        out = []
        for rowid, score in rows:
            rec = self.conn.execute(
                "SELECT id, text, meta FROM items WHERE id=?", (rowid,)).fetchone()
            if rec:
                out.append({"id": rec[0], "text": rec[1],
                            "meta": json.loads(rec[2] or "{}"),
                            "score": -score})  # normalize: higher = more relevant
        return out

    def _vector_search(self, query: str, top_k: int):
        """Pure-Python cosine ranking over stored embeddings (no sqlite-vec dependency).

        Each row's embedding JSON is embedded via embed_fn; cosine(query_vec, row_vec)
        ranks them. Returns None only if embedding can't run (caller falls back to FTS).
        """
        try:
            qv = self.embed_fn(query)
        except Exception:
            return None
        scored = []
        for _id, text, meta, emb in self.conn.execute("SELECT id, text, meta, embedding FROM items"):
            if emb is None:
                continue
            try:
                s = cosine(qv, json.loads(emb))
            except Exception:
                return None
            scored.append((_id, text, meta, s))
        scored.sort(key=lambda x: x[3], reverse=True)   # higher cosine = more relevant
        out = []
        for _id, text, meta, s in scored[:top_k]:
            out.append({"id": _id, "text": text,
                        "meta": json.loads(meta or "{}"),
                        "score": s})
        return out
