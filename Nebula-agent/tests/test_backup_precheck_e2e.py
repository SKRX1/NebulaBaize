#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""End-to-end differential for tools/backup_precheck.py main() + the real && gate.

The offline test (test_backup_precheck.py) only exercises the pure decide(). This one
builds a REAL throwaway git repo with a bare origin, drives the actual main() against
it, and proves the end-to-end contract the daily 03:00 task relies on:

    python backup_precheck.py && python <bundle-stub>   # marker only if precheck passes

  E1 DIVERGED repo (local ahead AND remote-only) -> main() exit 2, and the && bundle
     marker is NOT written (the real blocker path: a bundle is skipped).
  E2 IN-SYNC repo (0 0)                          -> main() exit 0, and the && bundle
     marker IS written.
The single load-bearing variable is "does the repo diverge from origin/main" -- flipping
only that one bit flips the exit code 0<->2 AND the marker present<->absent.

git is invoked with absolute paths + git -C (no shell), so it is shell/quote/CJK safe;
all stdout is pure ASCII. Skips cleanly if git is unavailable.

Run: python tests/test_backup_precheck_e2e.py
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PRECHECK = os.path.join(ROOT, "tools", "backup_precheck.py")

fails = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ((" -- " + detail) if detail else ""))
    if not cond:
        fails.append(name)


def git(cwd, *args):
    r = subprocess.run(["git"] + list(args), cwd=cwd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL,
                       timeout=120)
    return r.returncode, (r.stdout or "").strip(), (r.stderr or "").strip()


def make_repo(base, name):
    """bare origin + a clone on branch main with one shared commit; returns (origin, work)."""
    origin = os.path.join(base, name + "-origin.git")
    work = os.path.join(base, name + "-work")
    rc, _, err = git(base, "init", "--bare", "-b", "main", origin)
    assert rc == 0, err
    rc, _, err = git(base, "-c", "init.defaultBranch=main", "clone", origin, work)
    assert rc == 0, err
    git(work, "config", "user.name", "t")
    git(work, "config", "user.email", "t@e")
    git(work, "checkout", "-B", "main")
    return origin, work


def commit_push(work, msg, remote=True):
    p = os.path.join(work, "f")
    with open(p, "a", encoding="utf-8") as fh:
        fh.write(msg + "\n")
    git(work, "add", "-A")
    rc, _, err = git(work, "commit", "-m", msg)
    assert rc == 0, err
    if remote:
        rc, _, err = git(work, "push", "-u", "origin", "main")
        assert rc == 0, err


def run_precheck_and_stub(work, stub_path, marker_path):
    """Mirror the daily task: `python precheck && python stub`. Returns (precheck_rc, marker_exists)."""
    # stub: writes a marker file when it runs (only reachable if && let it run)
    with open(stub_path, "w", encoding="utf-8") as fh:
        fh.write(
            "import sys\n"
            "open(sys.argv[1],'w').write('BUNDLED')\n"
        )
    if os.path.exists(marker_path):
        os.remove(marker_path)
    # sequential, NOT shell, to avoid quote/CJK issues; emulate && by honoring rc.
    p = subprocess.run([sys.executable, PRECHECK], cwd=work, capture_output=True,
                       text=True, encoding="utf-8", errors="replace",
                       stdin=subprocess.DEVNULL, timeout=120)
    pre_rc = p.returncode
    if pre_rc == 0:  # the && gate: run bundle only on 0
        subprocess.run([sys.executable, stub_path, marker_path], cwd=work,
                       capture_output=True, text=True, encoding="utf-8",
                       stdin=subprocess.DEVNULL, timeout=60)
    return pre_rc, os.path.exists(marker_path), (p.stdout or "") + (p.stderr or "")


def main() -> int:
    git_path = shutil.which("git")
    if not git_path:
        print("BACKUP-PRECHECK-E2E: SKIP (git not available)")
        sys.exit(0)
    # git version guard: -b requires >= 2.28
    rc, out, err = git(os.path.dirname(git_path), "--version")
    try:
        ver = tuple(int(x) for x in out.split()[2].split(".")[:2])
    except Exception:
        ver = (0, 0)
    if ver < (2, 28):
        print("BACKUP-PRECHECK-E2E: SKIP (git -b needs >=2.28, have %s)" % out)
        sys.exit(0)

    with tempfile.TemporaryDirectory() as base:
        # ---------- E1: build a REAL divergence ----------
        origin, work = make_repo(base, "div")
        commit_push(work, "c1 shared")  # both sides now at c1
        # local-only commit (ahead)
        commit_push(work, "c2 local-ahead", remote=False)
        # remote-only commit: second clone advances origin/main beyond c1
        work2 = os.path.join(base, "div-work2")
        rc, _, err = git(base, "-c", "init.defaultBranch=main", "clone", origin, work2)
        assert rc == 0, err
        git(work2, "config", "user.name", "t2")
        git(work2, "config", "user.email", "t2@e")
        commit_push(work2, "c3 remote-ahead", remote=True)
        # now work: ahead=1 (c2) behind=1 (c3) -> true divergence

        stub = os.path.join(base, "stub.py")
        marker = os.path.join(base, "marker.txt")
        pre_rc, marker_exists, log = run_precheck_and_stub(work, stub, marker)
        check("E1 diverged: precheck exits 2", pre_rc == 2, "rc=%s log=%r" % (pre_rc, log[:200]))
        check("E1 diverged: && skipped bundle (no marker)", not marker_exists,
              "marker_exists=%s" % marker_exists)
        check("E1 log names divergence/blocking", "diverged" in log and "blocking" in log,
              repr(log[:200]))

        # ---------- E2: build an IN-SYNC repo (single variable flipped: no divergence) ----------
        origin2, work3 = make_repo(base, "sync")
        commit_push(work3, "s1 shared")  # both at s1; work3 tracks origin/main exactly
        marker2 = os.path.join(base, "marker2.txt")
        pre_rc2, marker2_exists, log2 = run_precheck_and_stub(work3, stub, marker2)
        check("E2 in-sync: precheck exits 0", pre_rc2 == 0, "rc=%s log=%r" % (pre_rc2, log2[:200]))
        check("E2 in-sync: && ran bundle (marker written)", marker2_exists,
              "marker_exists=%s" % marker2_exists)

        # ---------- load-bearing proof: the ONLY thing that differed was divergence ----------
        # E1 diverged -> (exit2, marker absent); E2 in-sync -> (exit0, marker present).
        check("DIFF: exit 0<->2 and marker present<->absent flip together with divergence",
              (pre_rc == 2 and not marker_exists) and (pre_rc2 == 0 and marker2_exists))

    print("---- summary ----")
    if fails:
        print("BACKUP-PRECHECK-E2E: RED (%d failed: %s)" % (len(fails), ",".join(fails)))
        sys.exit(1)
    print("BACKUP-PRECHECK-E2E: ALL GREEN (real-repo divergence blocks exit 2 and the && bundle skip is load-bearing)")
    sys.exit(0)


if __name__ == "__main__":
    main()
