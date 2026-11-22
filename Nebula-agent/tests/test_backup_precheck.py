#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Guard for tools/backup_precheck.py decide(): the divergence gate must be load-bearing.

decide(behind, ahead) -> (exit_code, level, message). Contract being locked:
  R1 in-sync (0,0)          -> PASS (0),  OK, no divergence
  R2 local-ahead only       -> PASS (0),  normal unpushed work (must NOT block)
  R3 behind only            -> PASS (0),  WARN but still safe
  R4 DIVERGED (both >0)     -> BLOCK (2), FAIL  <-- the only blocking case
  R5 boundary: behind>0/ahead=0 vs behind=0/ahead>0 must both PASS while R4 BLOCKs
     (single-variable flip: turning exactly one side from 0 to >0 must not block;
      only BOTH sides >0 flips to block -> proves both operands are load-bearing).
  R6 negative count -> ValueError (input guard).

Run: python tests/test_backup_precheck.py
"""
from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
from backup_precheck import decide, EXIT_PASS, EXIT_BLOCK  # noqa: E402

fails = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ((" -- " + detail) if detail else ""))
    if not cond:
        fails.append(name)


# ---- direct contract ----
code, level, msg = decide(0, 0)
check("R1 in-sync -> PASS/OK", code == EXIT_PASS and level == "OK")

code, level, msg = decide(0, 3)
check("R2 local-ahead -> PASS (not block)", code == EXIT_PASS, "code=%s" % code)
check("R2 message mentions ahead", "ahead=3" in msg, repr(msg))

code, level, msg = decide(2, 0)
check("R3 behind-only -> PASS/WARN", code == EXIT_PASS and level == "WARN", "code=%s level=%s" % (code, level))

code, level, msg = decide(2, 3)
check("R4 diverged -> BLOCK/FAIL", code == EXIT_BLOCK and level == "FAIL", "code=%s level=%s" % (code, level))

# ---- load-bearing single-variable flips ----
# turning ahead from 0 -> >0 while behind stays 0 must NOT block (proves "behind=0 path" differs from divergence)
c1, _, _ = decide(0, 1)
c2, _, _ = decide(1, 1)
check("R5a behind=0 flip not load-bearing for block (must PASS)", c1 == EXIT_PASS)
check("R5b behind=1 flip IS load-bearing (divergence blocks)", c2 == EXIT_BLOCK)
# turning behind from 0 -> >0 while ahead stays 0 must NOT block
c3, _, _ = decide(1, 0)
check("R5c ahead=0 flip not load-bearing for block (must PASS)", c3 == EXIT_PASS)
# so: only BOTH sides >0 flips to BLOCK -> prove the block needs both operands
c4, _, _ = decide(0, 5)
c5, _, _ = decide(5, 0)
c6, _, _ = decide(5, 5)
check("R5 only-both-blocks (one-side PASS, both BLOCK)",
      c4 == EXIT_PASS and c5 == EXIT_PASS and c6 == EXIT_BLOCK)

# ---- input guard ----
try:
    decide(-1, 0)
    check("R6 negative -> ValueError", False, "no raise")
except ValueError:
    check("R6 negative -> ValueError", True)

print("---- summary ----")
if fails:
    print("BACKUP-PRECHECK: RED (%d failed: %s)" % (len(fails), ",".join(fails)))
    sys.exit(1)
print("BACKUP-PRECHECK: ALL GREEN (divergence-only block proven load-bearing)")
sys.exit(0)
