r"""Single-source gate (permanent, 2026-10-25): after the parasite(8080) retirement the
authoritative frontend lives ONLY in serve/web. This gate locks that decision.

It REPLACES the old mirror-parity gate, whose rule ("the parasite mirror must be
byte-identical to serve/web, kept in sync by deploy_to_strata.bat") died with the
retirement: nothing runs the deploy any more, so the mirror would drift and the old
gate would go permanently red (a false red).

Contract (locks the retirement decision, deterministic, ASCII-only output):
  For each parasite-only script, TWO facts must hold:
    1. it must NOT exist at its old authoritative-source path  -> if someone drops it
       back there, the "single frontend source" invariant is violated again (RED);
    2. it MUST exist under .Nebula-archive/parasite-retired/   -> the retirement stays
       one-click reversible; an archive that lost its payload is not reversible (RED).

Pure stdlib, no upstream dependency, deterministic. Run from the Nebula-agent folder:
    python tools\_single_source_gate.py
"""
from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # Nebula-agent/
WSROOT = os.path.dirname(ROOT)  # workspace root (星云智能体/)

# The 4 parasite-only scripts frozen by the retirement (master commit 755dcc6).
# (authoritative-source path relative to Nebula-agent/, archive name under the retire dir)
RETIRED = [
    ("deploy_to_strata.bat", "deploy_to_strata.bat"),
    ("deploy_host_patch.bat", "deploy_host_patch.bat"),
    ("tools/deploy_frontend.py", "tools/deploy_frontend.py"),
    ("tools/apply_host_patch.py", "tools/apply_host_patch.py"),
]
ARCHIVE_DIR = os.path.join(WSROOT, ".Nebula-archive", "parasite-retired")


def main() -> int:
    problems: list[str] = []
    if not os.path.isdir(ARCHIVE_DIR):
        print("SINGLE-SOURCE-GATE: RED archive dir not present")
        return 1

    for src_rel, arc_rel in RETIRED:
        src_path = os.path.join(ROOT, *src_rel.split("/"))
        arc_path = os.path.join(ARCHIVE_DIR, *arc_rel.split("/"))
        # 1. the authoritative source must be CLEAN of parasite scripts
        if os.path.exists(src_path):
            problems.append("reappeared_in_source %s" % src_rel)
        # 2. the archive must still hold the payload (one-click reversible)
        if not os.path.exists(arc_path):
            problems.append("missing_from_archive %s" % arc_rel)

    print("checked %d retired script(s); archive=%s" % (len(RETIRED), ARCHIVE_DIR))
    for p in problems:
        print("  " + p)
    if problems:
        print("SINGLE-SOURCE-GATE: RED (%d problem(s))" % len(problems))
        return 1
    print("SINGLE-SOURCE-GATE: ALL GREEN (single frontend source + reversible archive)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
