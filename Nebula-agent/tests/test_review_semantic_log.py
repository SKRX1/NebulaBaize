"""Guard for tools/review_semantic_log.py: the audit-log summarizer must count truthfully.

summarize() turns audit-log lines into {vacuum, skip, reclaimed, last_ts, lines}. Each
assertion is paired with a flip that changes a number, proving the counts are load-bearing
(not a stub): a VACUUM line must bump vacuum AND add reclaimed; SKIP must bump skip only;
the most-recent timestamp must win even when lines are out of order.
Run: python tests/test_review_semantic_log.py
"""
from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from review_semantic_log import summarize, read_lines  # noqa: E402


def main() -> int:
    # A representative fixture mixing VACUUM (with reclaimed), SKIP, and a lock-busy SKIP.
    lines = [
        "[2026-11-20 04:30:00] VACUUM done  bytes 51417088 -> 35880960  (reclaimed +15536128, 30.2%)  pages 12553->8760  free 3769->0",
        "[2026-11-21 04:30:00] SKIP  (pages=12214 free=0 frag=0.0% below min_pages=2000/threshold=0.25)  bytes=50028544",
        "[2026-11-22 04:30:00] VACUUM done  bytes 40000000 -> 38000000  (reclaimed +2000000, 5.0%)  pages 9000->8000  free 1000->0",
        "[2026-11-19 04:30:00] SKIP  (write lock busy: database is locked) -> retry next cycle  bytes=50000000",
    ]
    s = summarize(lines)
    assert s["vacuum"] == 2, "two VACUUM lines -> vacuum=2 (count is load-bearing)"
    assert s["skip"] == 2, "two SKIP lines -> skip=2 (the lock-busy SKIP counts too)"
    assert s["reclaimed"] == 15536128 + 2000000, "cumulative reclaimed sums both VACUUM deltas (load-bearing)"
    assert s["last_ts"] == "2026-11-22 04:30:00", \
        "most-recent timestamp wins even though the newest line is 3rd (string-compare max is load-bearing)"
    assert s["lines"] == 4, "all four non-empty lines counted"

    # Load-bearing flips: removing the only VACUUM drops vacuum to 0 and reclaimed to 0.
    only_skip = summarize(["[2026-11-21 04:30:00] SKIP  (pages=1 free=0)  bytes=100"])
    assert only_skip["vacuum"] == 0 and only_skip["reclaimed"] == 0, \
        "a SKIP-only log has zero VACUUMs and zero reclaimed (flips both from the mixed fixture)"
    assert only_skip["skip"] == 1 and only_skip["last_ts"] == "2026-11-21 04:30:00"

    # Empty / all-blank log is a clean zero summary (not a crash).
    empty = summarize([])
    assert empty == {"vacuum": 0, "skip": 0, "reclaimed": 0, "last_ts": None, "lines": 0}, \
        "an empty log yields an all-zero summary with last_ts=None"
    blank = summarize(["", "   ", ""])
    assert blank["lines"] == 0, "blank-only lines are not counted"

    # A VACUUM line with NO "reclaimed" token still counts as a VACUUM, adds 0 reclaimed.
    novalue = summarize(["[2026-11-23 04:30:00] VACUUM done  (no reclaim numbers here)"])
    assert novalue["vacuum"] == 1 and novalue["reclaimed"] == 0, \
        "a VACUUM without a reclaim token counts as a run and adds 0 (regex is guarded)"

    # read_lines skips a missing path without raising (the real store may have no .1 yet).
    tmp = os.path.join(ROOT, "data", "semantic_maintain.log")
    got = read_lines([tmp + ".1", tmp])
    assert isinstance(got, list), "read_lines always returns a list even if the .1 archive is absent"

    print("REVIEW-SEMANTIC-LOG: ALL GREEN (vacuum/skip counts + cumulative reclaimed + most-recent ts proven load-bearing)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
