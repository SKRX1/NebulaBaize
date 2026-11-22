#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Size-capped log rotation for the daily-backup log (and any append log).

Why this tool exists: the daily backup task writes its precheck alert via a shell
redirect `... >> data\\backup.log 2>&1`. A `>>` redirect opens (and holds) the file
handle the moment cmd starts, so a child of that same command can NOT rotate
backup.log itself (Windows locks it). The rotation therefore has to run BEFORE the
redirect opens the file -- i.e. as the FIRST step of the task. This script does that:
if the log exceeds a byte cap, it is shifted into timestamped/suffixed history files
(`backup.log.1` is the most recent rotation, higher = older), keeping at most `--keep`
history files and deleting the rest. The active `backup.log` is then truncated so the
next append starts fresh. Net effect: the on-disk footprint stays bounded
(≈ (keep+1) x max-bytes) regardless of how long the job has run.

It is a standalone, dependency-free, TESTABLE tool -- not a python -c blob inside the
task string (which is hard to test and easy to get wrong). Safe by construction:
  - missing file          -> no-op, exit 0
  - file under the cap    -> no-op, exit 0
  - any error             -> report on stderr but STILL exit 0 (a rotation failure
                             must never block the backup that follows it)
The contract the task relies on: this process EXITS (releasing any handle) before the
redirect in the next `&&` step opens backup.log -- sequential cmd guarantees that.

Usage: python rotate_log.py <path> [--max-bytes N] [--keep K]
"""
from __future__ import annotations

import argparse
import os
import sys


def rotate(path, max_bytes, keep):
    """Rotate `path` if it exceeds max_bytes. Returns a short action string."""
    if max_bytes <= 0:
        return "disabled(max_bytes<=0)"
    if not os.path.isfile(path):
        return "skip(missing)"
    try:
        size = os.path.getsize(path)
    except OSError as exc:
        return "skip(stat-error:%s)" % exc
    if size <= max_bytes:
        return "ok(size=%d<=cap=%d)" % (size, max_bytes)

    # Drop the oldest beyond `keep`, then shift .(keep-1)->.keep ... base->.1.
    # We iterate from the highest index down so we never clobber a file we have
    # not moved yet.
    try:
        oldest = "%s.%d" % (path, keep)
        if os.path.exists(oldest):
            os.remove(oldest)
        for n in range(keep - 1, 0, -1):
            src = "%s.%d" % (path, n)
            dst = "%s.%d" % (path, n + 1)
            if os.path.exists(src):
                os.replace(src, dst)
        # active -> .1, then truncate the active file in place (preserve the path
        # the upcoming redirect will open). Truncating (not deleting) also avoids
        # any window where backup.log is absent.
        os.replace(path, "%s.1" % path)
        with open(path, "w", encoding="utf-8"):
            pass
        return "rotated(size=%d>cap=%d, kept<=.1..%d)" % (size, max_bytes, keep)
    except OSError as exc:
        return "error(%s)" % exc


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Size-capped log rotation")
    ap.add_argument("path", help="log file to rotate")
    ap.add_argument("--max-bytes", type=int, default=1048576,
                    help="rotate when the file exceeds this many bytes (default 1 MiB)")
    ap.add_argument("--keep", type=int, default=3,
                    help="how many rotated history files to keep (default 3)")
    args = ap.parse_args(argv)

    try:
        action = rotate(args.path, args.max_bytes, max(1, args.keep))
    except Exception as exc:  # never break the backup over a rotation hiccup
        print("ROTATE warn: %r" % exc, file=sys.stderr)
        return 0
    print("ROTATE %s -> %s" % (args.path, action))
    return 0


if __name__ == "__main__":
    sys.exit(main())
