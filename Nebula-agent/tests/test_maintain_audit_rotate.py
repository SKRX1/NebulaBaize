"""Guard for tools/maintain_semantic_db.py audit-log rotation: the size cap must be load-bearing.

Three pieces are locked:
  * should_rotate()  -- the threshold predicate (>= boundary, and the 0/negative "disabled" sentinel)
  * rotate_if_needed() -- a rotation really moves the active log to a single .1 archive
  * _append_audit()  -- an over-threshold active log is rotated BEFORE the new line is written

Every branch is paired with a flip that changes the outcome, proving the cap (not just the
code path) drives the behaviour. Run: python tests/test_maintain_audit_rotate.py
"""
from __future__ import annotations

import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from maintain_semantic_db import should_rotate, rotate_if_needed, _append_audit  # noqa: E402


def main() -> int:
    # ---- should_rotate: threshold predicate, load-bearing flips ----
    assert should_rotate(1024, 1024) is True, "at exactly the ceiling -> rotate (>= boundary)"
    assert should_rotate(1023, 1024) is False, "one byte under the ceiling -> no rotate (load-bearing flip of the boundary)"
    assert should_rotate(5000, 1024) is True, "over the ceiling -> rotate"
    # The "disabled" sentinel: a non-positive cap rotates NOTHING, even at huge size.
    assert should_rotate(999_999_999, 0) is False, "max_bytes=0 disables rotation (sentinel, load-bearing)"
    assert should_rotate(999_999_999, -1) is False, "negative max_bytes disables rotation"

    # ---- rotate_if_needed: a real rotation happens, single .1 archive ----
    d = tempfile.mkdtemp()
    log = os.path.join(d, "maintain.log")
    with open(log, "w", encoding="utf-8") as f:
        f.write("A" * 2000)  # 2000 bytes, over a 1024 ceiling
    rotated = rotate_if_needed(log, max_bytes=1024)
    assert rotated is True, "rotate_if_needed must report a rotation occurred"
    assert not os.path.exists(log), "active log must be gone after rotation (it was moved, not copied)"
    assert os.path.exists(log + ".1"), "the .1 archive must exist"
    assert len(open(log + ".1", encoding="utf-8").read()) == 2000, ".1 must carry the old content verbatim"

    # Below-threshold file is left alone (load-bearing flip: same call, smaller file).
    small = os.path.join(d, "small.log")
    with open(small, "w", encoding="utf-8") as f:
        f.write("B" * 10)
    assert rotate_if_needed(small, max_bytes=1024) is False, "under the ceiling -> no rotation"
    assert os.path.exists(small) and not os.path.exists(small + ".1"), "under-threshold log untouched (no .1)"

    # Single-generation: rotating a second time overwrites the old .1 (never .2).
    with open(log, "w", encoding="utf-8") as f:
        f.write("C" * 3000)  # a fresh over-threshold active log
    rotate_if_needed(log, max_bytes=1024)
    assert not os.path.exists(log + ".2"), "rotation is single-generation: no .2 ever created"
    assert len(open(log + ".1", encoding="utf-8").read()) == 3000, ".1 replaced by the newest generation"

    # ---- _append_audit: an over-threshold active log is rotated BEFORE the new line ----
    log2 = os.path.join(d, "audit.log")
    with open(log2, "w", encoding="utf-8") as f:
        f.write("OLD" * 1000)  # 3000 bytes, over the 1024 ceiling
    old_len = os.path.getsize(log2)
    _append_audit("NEWLINE-MARKER", log2, max_bytes=1024)
    assert os.path.exists(log2 + ".1"), "_append_audit must have rotated the over-threshold log"
    assert len(open(log2 + ".1", encoding="utf-8").read()) == old_len, ".1 holds the pre-rotation content"
    active = open(log2, encoding="utf-8").read()
    assert "NEWLINE-MARKER" in active, "the new line lands in the fresh active log"
    assert "OLD" not in active, "the rotated-out content is NOT in the active log (the append is a flip of no-rotation)"

    print("MAINTAIN-AUDIT-ROTATE: ALL GREEN (threshold + disabled-sentinel + real rotation + append-then-rotate proven load-bearing)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
