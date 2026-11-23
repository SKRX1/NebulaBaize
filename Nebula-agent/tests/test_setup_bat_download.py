#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Download-state anti-crash gate for setup.bat (2026-11-24).

Context: a downloaded repo (GitHub "Download ZIP" / `git clone`) ran setup.bat and
it flash-crashed with "'... was unexpected at this time.'" EVEN THOUGH the
line-ending fix already makes the blob CRLF. The root cause is a SECOND, distinct
bug: cmd.exe, while parsing a parenthesised `if (` block, treats a bare ')' found
inside an `echo`'s text as the BLOCK TERMINATOR, and a ';' inside a REM as a
command separator -- the leftover text then becomes stray commands and the batch
dies before doing anything useful.

This gate locks the fix in the only way that proves it: extract setup.bat from
git HEAD (exactly the bytes a downloader receives -- setup.bat is `*.bat -text`,
so autocrlf/checkout applies NO line-ending transformation, so `git show HEAD:setup.bat`
is verbatim the downloaded bytes), run it under cmd.exe, and assert the crash
string is GONE and the launcher reaches its end marker. A decoy that re-inserts
the bare paren must bring the crash BACK -- a load-bearing differential proving
the assertion tracks the real bug, not a tautology.

Because it runs the real launcher end-to-end (throwaway venv + pip inside a temp
copy of HEAD), it is measured-slow and registered under SLOW_SUITES. Pure stdlib.
"""
import os
import subprocess
import sys
import tempfile
import shutil

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # .../NebulaBaize
fails = []


def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        fails.append(label)


def setup_bat_blob():
    """Raw setup.bat bytes exactly as a downloader receives them. setup.bat is
    `*.bat -text`, so `git show HEAD:setup.bat` emits the commit blob verbatim
    (no CRLF transformation on checkout / download), which is precisely what a
    GitHub ZIP or clone lands on disk."""
    p = subprocess.run(["git", "show", "HEAD:setup.bat"], cwd=REPO,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError("git show HEAD:setup.bat failed: " +
                           p.stderr.decode("utf-8", "replace"))
    return p.stdout


def run_setup_bat(sim):
    """Run setup.bat in `sim` under cmd. stdin=DEVNULL so any trailing `pause`
    gets EOF and does not block. Returns (rc, decoded_output)."""
    sb = os.path.join(sim, "setup.bat")
    try:
        r = subprocess.run(["cmd", "/c", sb], cwd=sim, stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=200)
        return r.returncode, (r.stdout or b"").decode("utf-8", "replace")
    except subprocess.TimeoutExpired as e:
        return None, (e.stdout or b"").decode("utf-8", "replace")


def materialize(sim, blob):
    with open(os.path.join(sim, "setup.bat"), "wb") as f:
        f.write(blob)
    return sim


def main():
    raw = setup_bat_blob()
    # ---- real download-state run ----
    sim = materialize(tempfile.mkdtemp(prefix="dl_gate_"), raw)
    try:
        # T0: line-ending invariant -- the download blob must be CRLF, else cmd
        #     can mis-join multi-line constructs (the original, separate crash).
        crlf = raw.count(b"\r\n")
        lf_only = raw.count(b"\n") - crlf
        check(crlf > 0 and lf_only == 0,
              "T0 download setup.bat blob is pure CRLF (crlf=%d lf_only=%d)" % (crlf, lf_only))

        rc, out = run_setup_bat(sim)
        # T1: the headline regression -- the parser must not die on a stray token.
        check("unexpected at this time" not in out,
              "T1 download setup.bat runs with NO 'unexpected at this time' (rc=%s)" % rc)
        # T2: it actually reached the end (the fix is load-bearing for the whole run,
        #     not just for suppressing a message).
        check("[done] setup complete" in out, "T2 download setup.bat reaches its end marker")
        check(rc == 0, "T3 download setup.bat exits RC=0 (got %s)" % rc)

        # T4 decoy differential: re-insert the bare paren into the inner echo and
        #     prove the crash COMES BACK. This is what makes T1 load-bearing rather
        #     than a tautology -- green T1 + red T4 means the gate really tracks the
        #     cmd paren-block-terminator bug.
        NEW = b'    echo [info] installing python ^(silent, user-level, add to PATH^) ...\r\n'
        OLD = b'    echo [info] installing python (silent, user-level, add to PATH) ...\r\n'
        if NEW in raw:
            sim2 = materialize(tempfile.mkdtemp(prefix="dl_decoy_"), raw.replace(NEW, OLD))
            try:
                rc2, out2 = run_setup_bat(sim2)
                check("unexpected at this time" in out2,
                      "T4 decoy (bare paren) reproduces the crash -> T1 is load-bearing")
            finally:
                shutil.rmtree(sim2, ignore_errors=True)
        else:
            check(False, "T4 setup.bat no longer contains the escaped echo anchor (fix shape drifted?)")
    finally:
        shutil.rmtree(sim, ignore_errors=True)

    print("")
    if fails:
        print("SETUP-BAT-DOWNLOAD: FAIL (%d)" % len(fails))
        return 1
    print("SETUP-BAT-DOWNLOAD: ALL GREEN (download-state run + CRLF lock + decoy differential)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
