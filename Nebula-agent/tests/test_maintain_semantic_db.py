"""Guard for tools/maintain_semantic_db.py: the VACUUM-gating predicate must be load-bearing.

plan_vacuum decides when a VACUUM pays (fragmentation worth reclaiming). Each assertion is
paired with a flip that changes the verdict, proving the threshold and the min-pages gate are
not decorative. Run: python tests/test_maintain_semantic_db.py
"""
from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from maintain_semantic_db import plan_vacuum  # noqa: E402


def main() -> int:
    # 1) High fragmentation on a big store -> VACUUM.
    assert plan_vacuum(page_count=10000, freelist_count=3000) is True, \
        "case1: 30% free on a 10k-page store should be worth a vacuum"

    # 2) Low fragmentation on the same store -> SKIP. (Load-bearing flip of case1: same
    #    page_count, freelist dropped below the 25% threshold -> verdict must flip to False.)
    assert plan_vacuum(page_count=10000, freelist_count=1000) is False, \
        "case2: 10% free is below the 25% threshold -> must NOT vacuum (threshold is load-bearing)"

    # 3) Tiny store with high fragmentation -> SKIP. (Load-bearing flip: the min-pages gate,
    #    not the ratio, drives this. 90% free on a 1000-page store is not worth a full rewrite.)
    assert plan_vacuum(page_count=1000, freelist_count=900) is False, \
        "case3: a sub-2000-page store is not worth a rewrite even at 90% free (min-pages is load-bearing)"

    # 4) Exactly at threshold -> VACUUM (>= boundary). Distinguishes >= from >.
    assert plan_vacuum(page_count=4000, freelist_count=1000) is True, \
        "case4: exactly 25% free must vacuum (boundary is >=, not >)"

    # 5) One below threshold -> SKIP. (Load-bearing flip of case4: 24.9% free flips to False.)
    assert plan_vacuum(page_count=4000, freelist_count=999) is False, \
        "case5: just under 25% free must skip (confirms the >= boundary is enforced)"

    # 6) Degenerate page_count (0 / negative) must never trigger a rewrite.
    assert plan_vacuum(page_count=0, freelist_count=0) is False, \
        "case6a: an empty store must not vacuum"
    assert plan_vacuum(page_count=-5, freelist_count=1) is False, \
        "case6b: a negative page_count must not vacuum (guard load-bearing)"

    print("MAINTAIN-SEMANTIC-DB: ALL GREEN (threshold + min-pages gate proven load-bearing)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
