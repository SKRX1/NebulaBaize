"""Periodic maintenance for data/semantic.db: VACUUM only when fragmentation is worth it.

The semantic store is append-only-ish (add / delete_source / forget), so after deletes the
sqlite file keeps freed pages on its freelist and grows. A VACUUM rewrites the file and
reclaims them, but it is a full-file copy: running it unconditionally (or on a tiny store)
is wasted I/O. So `plan_vacuum` gates on fragmentation: VACUUM only when the freelist is a
meaningful fraction of the file AND the store is big enough that a rewrite is worth it.

The DB is opened by the memory MCP server (an on-demand stdio subprocess). VACUUM needs an
exclusive write lock, so we take it cooperatively: a short busy_timeout, and if the lock is
contended we SKIP this cycle (the next scheduled run retries) -- never block a live recall.

Every run appends one audit line to data/semantic_maintain.log (timestamp + action + the
before/after byte counts), so a weekly review can watch the fragmentation trend over time.
That log is size-capped: when it reaches MAX_LOG_BYTES it rotates to a single .1 archive.

Run as a scheduled task (config/mcp_servers.json schedule.entries), e.g. daily:
    python tools/maintain_semantic_db.py
Tunables are overridable on the CLI so they can be retuned per store size:
    python tools/maintain_semantic_db.py --min-pages 4000 --threshold 0.15
Exit 0 on success / skip (a skip is healthy: it means "nothing to reclaim" or "DB busy").
"""
from __future__ import annotations

import argparse
import datetime
import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runtime"))
from config_loader import project_root  # noqa: E402

ROOT = project_root(__file__)
DB = os.path.join(ROOT, "data", "semantic.db")
LOG = os.path.join(ROOT, "data", "semantic_maintain.log")

# Tunables (CLI-overridable): reclaim only when it pays. A store under MIN_PAGES (~8 MB at
# 4 KB pages) is not worth a full-file rewrite; below THRESHOLD the freed pages are too few
# to bother.
MIN_PAGES = 2000
THRESHOLD = 0.25
BUSY_MS = 3000  # how long to wait for the write lock before giving up this cycle
# Audit-log ceiling: the log grows ~one line/day, so this is a guard against long-term
# bloat, not a hot path. When the active log reaches MAX_LOG_BYTES it is rotated to
# a single .1 archive (old .1 overwritten). 0/negative disables rotation.
MAX_LOG_BYTES = 1024 * 1024  # 1 MB


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


def should_rotate(cur_size: int, max_bytes: int = MAX_LOG_BYTES) -> bool:
    """True when the active audit log has grown to/over the ceiling and must be rotated.

    A non-positive max_bytes disables rotation entirely (the sentinel the CLI uses).
    """
    if max_bytes <= 0:
        return False
    return cur_size >= max_bytes


def rotate_if_needed(log_path: str, max_bytes: int = MAX_LOG_BYTES) -> bool:
    """If the active log is at/over max_bytes, roll it to a single .1 archive (best-effort).

    Returns True when a rotation happened. The old .1 is overwritten (single-generation).
    """
    try:
        size = os.path.getsize(log_path)
    except OSError:
        return False  # no active log yet -> nothing to rotate
    if not should_rotate(size, max_bytes):
        return False
    try:
        os.replace(log_path, log_path + ".1")
        return True
    except OSError:
        print("audit rotate failed ->", log_path, file=sys.stderr)
        return False


def _append_audit(line: str, log_path: str = LOG, max_bytes: int = MAX_LOG_BYTES) -> None:
    """Append one timestamped audit line; best-effort (a failed audit must not fail the run).

    Rotates the active log to a single .1 archive first when it has reached max_bytes.
    """
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    try:
        os.makedirs(os.path.dirname(os.path.abspath(log_path)), exist_ok=True)
        rotate_if_needed(log_path, max_bytes)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (stamp, line))
    except OSError:
        # An unwritable audit log is not a reason to fail maintenance; surface on stderr.
        print("audit write failed ->", log_path, file=sys.stderr)


def _sizes(con: sqlite3.Connection):
    ps = con.execute("PRAGMA page_size").fetchone()[0]
    pc = con.execute("PRAGMA page_count").fetchone()[0]
    fl = con.execute("PRAGMA freelist_count").fetchone()[0]
    return ps, pc, fl


def run(db: str, min_pages: int, threshold: float, busy_ms: int, log_path: str,
        max_log_bytes: int = MAX_LOG_BYTES) -> int:
    if not os.path.exists(db):
        print("semantic.db: not present, nothing to maintain ->", db, file=sys.stderr)
        return 0
    con = sqlite3.connect(db, timeout=busy_ms / 1000.0)
    try:
        ps, pc, fl = _sizes(con)
        if not plan_vacuum(pc, fl, min_pages=min_pages, threshold=threshold):
            msg = "SKIP  (pages=%d free=%d frag=%.1f%% below min_pages=%d/threshold=%.2f)  bytes=%d" % (
                pc, fl, 100.0 * fl / pc if pc else 0.0, min_pages, threshold, os.path.getsize(db))
            print("semantic.db:", msg)
            _append_audit(msg, log_path, max_log_bytes)
            return 0
        # VACUUM must run outside a transaction (autocommit). Try to take the write lock;
        # if the memory server holds it, sqlite raises "database is locked" within the
        # busy_timeout -> skip this cycle, do NOT block.
        before = os.path.getsize(db)
        con.isolation_level = None
        try:
            con.execute("VACUUM")
        except sqlite3.OperationalError as e:
            # Contended lock is the expected healthy-skip path on a busy store: log + exit 0.
            msg = "SKIP  (write lock busy: %s) -> retry next cycle  bytes=%d" % (e, before)
            print("semantic.db:", msg, file=sys.stderr)
            _append_audit(msg, log_path, max_log_bytes)
            return 0
        after = os.path.getsize(db)
        ps2, pc2, fl2 = _sizes(con)
        msg = ("VACUUM done  bytes %d -> %d  (reclaimed %+d, %.1f%%)  pages %d->%d  free %d->%d" %
               (before, after, before - after, 100.0 * (before - after) / before if before else 0.0,
                pc, pc2, fl, fl2))
        print("semantic.db:", msg)
        _append_audit(msg, log_path, max_log_bytes)
        return 0
    finally:
        con.close()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Conditionally VACUUM data/semantic.db (fragmentation-gated).")
    ap.add_argument("--min-pages", type=int, default=MIN_PAGES,
                    help="skip VACUUM when the store is smaller than this page count (default %d)" % MIN_PAGES)
    ap.add_argument("--threshold", type=float, default=THRESHOLD,
                    help="VACUUM only when freelist/page_count >= this fraction (default %.2f)" % THRESHOLD)
    ap.add_argument("--busy-ms", type=int, default=BUSY_MS,
                    help="milliseconds to wait for the write lock before skipping (default %d)" % BUSY_MS)
    ap.add_argument("--db", default=DB, help="path to the sqlite db (default data/semantic.db)")
    ap.add_argument("--log", default=LOG, help="audit log path (default data/semantic_maintain.log)")
    ap.add_argument("--max-log-bytes", type=int, default=MAX_LOG_BYTES,
                    help="rotate the audit log to .1 once it reaches this many bytes; 0 disables (default %d)" % MAX_LOG_BYTES)
    a = ap.parse_args(argv)
    return run(a.db, a.min_pages, a.threshold, a.busy_ms, a.log, a.max_log_bytes)


if __name__ == "__main__":
    sys.exit(main())
