#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Offline differential for tools/rotate_log.py (the backup.log size-cap rotator).

rotate_log.rotate() is pure filesystem logic, so this needs no git / no real task --
it pins the contract the daily task relies on:
  * missing file / under-cap / cap<=0  -> no-op (never blocks the backup)
  * over-cap  -> shift to .1..N + TRUNCATE the ACTIVE path in place (not delete), so
    the `>>` redirect the task opens right after starts on a fresh, existing file
  * keep-N trimming: only .1..keep exist, older dropped; .1 is always the NEWEST
The load-bearing bit is the rotate-ordering + truncate-not-delete: if the active file
were deleted (not truncated) the next `>>` would still recreate it, but if the shift
order were wrong (ascending) we would clobber .1 before moving it and LOSE history.
The descending shift is what preserves them. This test proves both with concrete bytes.

Run: python tests/test_rotate_log.py
"""
from __future__ import annotations

import os
import sys
import tempfile

TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'tools')
sys.path.insert(0, TOOLS)
import rotate_log  # noqa: E402

fails = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ((" -- " + detail) if detail else ""))
    if not cond:
        fails.append(name)


def write(path, s):
    with open(path, 'w', encoding='utf-8') as fh:
        fh.write(s)


def read(path):
    with open(path, encoding='utf-8', errors='replace') as fh:
        return fh.read()


def main() -> int:
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, 'backup.log')

        # 1. missing -> no-op, and must NOT create the file
        r = rotate_log.rotate(p, 100, 3)
        check('missing -> skip(missing), no file created',
              'skip(missing)' in r and not os.path.exists(p), r)

        # 2. under cap -> ok no-op, content untouched
        write(p, 'x' * 50)
        r = rotate_log.rotate(p, 100, 3)
        check('under cap -> ok no-op', 'ok(size=50' in r, r)
        check('under cap -> content unchanged', read(p) == 'x' * 50)

        # 3. over cap -> .1 holds old bytes, active EXISTS and is EMPTY (truncate not delete)
        write(p, 'y' * 150)
        r = rotate_log.rotate(p, 100, 3)
        check('over cap -> rotated', 'rotated(' in r, r)
        check('over cap -> .1 holds the old content',
              os.path.exists(p + '.1') and read(p + '.1') == 'y' * 150)
        check('over cap -> active path still exists and is EMPTY (truncate, not delete)',
              os.path.exists(p) and os.path.getsize(p) == 0)

        # 4. keep-N trimming + ordering: 4 more rotations with distinct payloads
        for i in range(4):
            write(p, str(i) * 150)
            rotate_log.rotate(p, 100, 3)
        exists = {k: os.path.exists('%s.%d' % (p, k)) for k in (1, 2, 3, 4)}
        check('keep=3 -> .1 .2 .3 exist, the 4th is trimmed away',
              exists[1] and exists[2] and exists[3] and not exists[4], str(exists))
        # newest (.1) must be the most recent write (payload '3'); oldest kept (.3) = '1'.
        # This is the load-bearing descending-shift proof: an ascending shift would
        # overwrite .1 first and lose the newest history / scramble the order.
        check('rotation ordering correct (.1 = newest, descending shift preserves history)',
              read(p + '.1') == '3' * 150 and read(p + '.3') == '1' * 150,
              '.1=%r .3=%r' % (read(p + '.1')[:3], read(p + '.3')[:3]))

        # 5. cap<=0 -> disabled no-op even when large
        write(p, 'z' * 999)
        r = rotate_log.rotate(p, 0, 3)
        check('max_bytes<=0 -> disabled, file untouched',
              'disabled(' in r and os.path.getsize(p) == 999, r)

        # 6. single-rotation boundary: size == cap exactly must NOT rotate (cap is "exceed")
        write(p, 'w' * 100)
        r = rotate_log.rotate(p, 100, 3)
        check('size == cap -> no rotate (rotate only when EXCEEDS cap)',
              'ok(size=100' in r, r)

    print("---- summary ----")
    if fails:
        print("ROTATE-LOG: RED (%d failed: %s)" % (len(fails), ",".join(fails)))
        sys.exit(1)
    print("ROTATE-LOG: ALL GREEN (no-op/over-cap/keep-N-trim/ordering/truncate-not-delete/cap<=0/exclusive-cap proven load-bearing)")
    sys.exit(0)


if __name__ == "__main__":
    main()
