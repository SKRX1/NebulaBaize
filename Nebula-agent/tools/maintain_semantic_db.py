"""Periodic maintenance for data/semantic.db: VACUUM only when fragmentation is worth it.

The semantic store is append-only-ish (add / delete_source / forget), so after deletes the
sqlite file keeps freed pages on its freelist and grows. A VACUUM rewrites the file and
reclaims them, but it is a full-file copy: running it unconditionally (or on a tiny store)
is wasted I/O. So `plan_vacuum` gates on fragmentation: VACUUM only when the freelist is a
meaningful fraction of the file AND the store is big enough that a rewrite is worth it.

The DB is opened by the memory MCP server (an on-demand stdio subprocess). VACUUM needs an
exclusive write lock, so we take it cooperatively: a short busy_timeout, and if the lock is
contended we SKIP this cycle (the next scheduled run retries) -- never block a live recall.

Run as a scheduled task (config/mcp_servers.json schedule.entries), e.g. daily:
    python tools/maintain_semantic_db.py
Exit 0 on success / skip (a skip is healthy: it means "nothing to reclaim" or "DB busy").
"""
from __future__ import annotations

import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runtime"))
from config_loader import project_root  # noqa: E402

ROOT = project_root(__file__)
DB = os.path.join(ROOT, "data", "semantic.db")

# Tunables: reclaim only when it pays. A store under MIN_PAGES (~8 MB at 4 KB pages) is not
# worth a full-file rewrite; below THRESHOLD the freed pages are too few to bother.
MIN_PAGES = 2000
THRESHOLD = 0.25
BUSY_MS = 3000  # how long to wait for the write lock before giving up this cycle


def plan_vacuum(page_count: int, freelist_count: int,
                min_pages: int = MIN_PAGES, threshold: float = THRESHOLD) -> bool:
    """Decide whether a VACUUM is worth it from page/freelist counts (pure, testable).

    True when the store is big enough that a rewrite pays (page_count >= min_pages) AND the
    freelist is a large enough fraction (freelist/page >= threshold) to justify the I/O.
    Returns False for tiny stores, empty stores, and low-fragmentation stores.
    """
    if page_count <= 0 or page_count < min_pages:
        return False
    return (freelist_count / page_count) >= threshold


def _sizes(con: sqlite3.Connection):
    ps = con.execute("PRAGMA page_size").fetchone()[0]
    pc = con.execute("PRAGMA page_count").fetchone()[0]
    fl = con.execute("PRAGMA freelist_count").fetchone()[0]
    return ps, pc, fl


def main() -> int:
    if not os.path.exists(DB):
        print("semantic.db: not present, nothing to maintain ->", DB, file=sys.stderr)
        return 0
    con = sqlite3.connect(DB, timeout=BUSY_MS / 1000.0)
    try:
        ps, pc, fl = _sizes(con)
        if not plan_vacuum(pc, fl):
            print("semantic.db: skip (pages=%d free=%d frag=%.1f%% < threshold)" %
                  (pc, fl, 100.0 * fl / pc if pc else 0.0))
            return 0
        # VACUUM must run outside a transaction (autocommit). Try to take the write lock;
        # if the memory server holds it, sqlite raises "database is locked" within the
        # busy_timeout -> skip this cycle, do NOT block.
        before = os.path.getsize(DB)
        con.isolation_level = None
        try:
            con.execute("VACUUM")
        except sqlite3.OperationalError as e:
            # Contended lock is the expected healthy-skip path on a busy store: log + exit 0.
            print("semantic.db: skip (write lock busy: %s) -> retry next cycle" % e, file=sys.stderr)
            return 0
        after = os.path.getsize(DB)
        ps2, pc2, fl2 = _sizes(con)
        print("semantic.db: VACUUM done  %d -> %d bytes  (pages %d->%d, free %d->%d)" %
              (before, after, pc, pc2, fl, fl2))
        return 0
    finally:
        con.close()


if __name__ == "__main__":
    sys.exit(main())
