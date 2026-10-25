r"""Mirror-parity gate (permanent, 2026-10-23): the parasite copy must be byte-identical
to the authoritative frontend source.

Contract (locks the deploy rule, not a code path):
  source  = <strata-agent>/serve/web            (the single source of truth)
  target  = E:\Program Files\Strata-main\serve\web   (the robocopy/MIR mirror)
Every file in source must MD5-match its counterpart in target, and target must hold no
extra files (MIR semantics means "mirror", not "merge").

Self-skip: if the target folder is absent (different machine, fresh clone) the gate
returns 0 with a SKIP line -- a gate that must not produce a false red in CI.

Pure stdlib, deterministic, no upstream dependency, ASCII-only output.
Run from the strata-agent folder:
    python tools\_mirror_parity_gate.py
"""
from __future__ import annotations

import hashlib
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "serve", "web")
TARGET = r"E:\Program Files\Strata-main\serve\web"
# must stay symmetric with deploy_frontend.py EXCLUDE_DIRS
EXCLUDE_DIRS = {"fonts_backup"}


def md5(path: str) -> str:
    with open(path, "rb") as fh:
        return hashlib.md5(fh.read()).hexdigest()


def gather(root: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for dirpath, _dirs, files in os.walk(root):
        rel_parts = os.path.relpath(dirpath, root).split(os.sep)
        rel_parts = [] if rel_parts == ["."] else rel_parts
        if any(p in EXCLUDE_DIRS for p in rel_parts):
            continue
        for f in files:
            key = os.path.relpath(os.path.join(dirpath, f), root).lower()
            out[key] = os.path.join(dirpath, f)
    return out


def main() -> int:
    if not os.path.isdir(SOURCE):
        print("MIRROR-PARITY-GATE: FAIL source not found")
        return 1
    if not os.path.isdir(TARGET):
        # gate is not applicable on this machine -> skip, never a false red
        print("MIRROR-PARITY-GATE: SKIP (target mirror folder not present)")
        return 0

    src = gather(SOURCE)
    dst = gather(TARGET)
    problems: list[str] = []

    for key in sorted(set(src) | set(dst)):
        if key not in dst:
            problems.append("missing_in_mirror %s" % key)
            continue
        if key not in src:
            problems.append("extra_in_mirror %s" % key)
            continue
        if md5(src[key]) != md5(dst[key]):
            problems.append("md5_diff %s" % key)

    print("source_files %d  mirror_files %d" % (len(src), len(dst)))
    for p in problems:
        print("  " + p)
    if problems:
        print("MIRROR-PARITY-GATE: RED (%d file(s) out of parity)" % len(problems))
        return 1
    print("MIRROR-PARITY-GATE: ALL GREEN (%d files byte-identical)" % len(src))
    return 0


if __name__ == "__main__":
    sys.exit(main())
