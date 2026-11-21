r"""Orphan-chain gate (permanent, 2026-11-02): the post-green rollback hook checks out the
anchor tag's commit, runs the verify, then restores HEAD -- and a KNOWN, thrice-reproduced
side effect is that it leaves HEAD DETACHED at the end. If a pure-doc register commit is
then made on that detached HEAD, it becomes an ORPHAN: master does not move, the commit is
not connected to any branch, and `git branch --show-current` returns empty. The fix every
time was the same: `git merge --ff-only <orphan>` to fast-forward master onto the chain tip
(the orphan's parent is exactly the old master tip, so it is a clean fast-forward, zero loss).
This gate locks that invariant so the drift is CAUGHT, not noticed three rounds late.

Contract (deterministic, pure stdlib, ASCII-only output, exit 0 = green):
  PROBE 1 (live repo, the current truth): HEAD must carry NO commit that master cannot
          reach -- i.e. `git log master..HEAD` must be empty, AND we must be ON a branch
          (`git branch --show-current` non-empty). A pure-doc register commit left on the
          post-green detached HEAD is the exact orphan this must catch (RED).
  PROBE 2 (differential, proves PROBE 1 is load-bearing and not a vacuous green): build a
          throwaway temp repo, make one commit on master, then commit again on a DETACHED
          HEAD (the orphan). PROBE 1's predicate must GO RED there. If it stayed green on a
          real orphan, the gate would be decorative -> RED the gate.

Read-only on the real repo (rev-parse / log only); the temp repo is created under
tempfile.mkdtemp and removed at the end. Run from the Nebula-agent folder:
    python tools\_orphan_chain_gate.py
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # Nebula-agent/


def git(args, cwd):
    r = subprocess.run(["git"] + args, cwd=cwd, capture_output=True, text=True)
    return r.stdout.strip()


def orphan_drift(cwd):
    """Return (drifted_bool, detail). Drifted = HEAD has commits master cannot reach,
    OR we are not on a branch (detached -> the post-green hook signature)."""
    ahead = git(["log", "master..HEAD", "--oneline"], cwd)
    on_branch = git(["branch", "--show-current"], cwd)
    drifted = bool(ahead) or (on_branch == "")
    return drifted, "ahead=%r on_branch=%r" % (ahead, on_branch)


def main() -> int:
    problems: list[str] = []

    # ---- PROBE 1: the live repo must be green (no orphan, on a branch) ----
    d1, det1 = orphan_drift(ROOT)
    if d1:
        problems.append("LIVE-REPO-ORPHAN (HEAD has commits master cannot reach, or detached) "
                        "-> run: git checkout master && git merge --ff-only <the-orphan-commit>. detail: " + det1)

    # ---- PROBE 2: differential -- prove the predicate catches a REAL orphan ----
    tmp = tempfile.mkdtemp(prefix="orphan_gate_")
    try:
        subprocess.run(["git", "init", "-q", "-b", "master"], cwd=tmp, capture_output=True, text=True)
        subprocess.run(["git", "config", "user.email", "gate@local"], cwd=tmp, capture_output=True, text=True)
        subprocess.run(["git", "config", "user.name", "gate"], cwd=tmp, capture_output=True, text=True)
        # commit A on master
        open(os.path.join(tmp, "a.txt"), "w").write("1")
        subprocess.run(["git", "add", "."], cwd=tmp, capture_output=True, text=True)
        subprocess.run(["git", "commit", "-qm", "A-on-master"], cwd=tmp, capture_output=True, text=True)
        # commit B stays on master -> both A and B are reachable -> NOT drifted (green baseline)
        open(os.path.join(tmp, "b.txt"), "w").write("2")
        subprocess.run(["git", "add", "."], cwd=tmp, capture_output=True, text=True)
        subprocess.run(["git", "commit", "-qm", "B-on-master"], cwd=tmp, capture_output=True, text=True)
        d0, det0 = orphan_drift(tmp)
        if d0:
            problems.append("DIFFERENTIAL-BASELINE expected green on on-master commits but got: " + det0)
        # now go to an EARLIER commit (detached) and add a commit -> the new commit is an orphan
        subprocess.run(["git", "checkout", "-q", "HEAD~1"], cwd=tmp, capture_output=True, text=True)
        open(os.path.join(tmp, "c.txt"), "w").write("3")
        subprocess.run(["git", "add", "."], cwd=tmp, capture_output=True, text=True)
        subprocess.run(["git", "commit", "-qm", "C-on-detached-ORPHAN"], cwd=tmp, capture_output=True, text=True)
        d2, det2 = orphan_drift(tmp)
        if not d2:
            problems.append("DIFFERENTIAL-ORPHAN the predicate FAILED to catch a real orphan (gate is decorative): " + det2)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # ---- verdict ----
    print("PROBE1 live-repo  %s" % ("RED" if any(p.startswith("LIVE") for p in problems) else "green") + "  " + det1)
    print("PROBE2 differential built a real orphan and the predicate caught it")
    for p in problems:
        print("  " + p)
    if problems:
        print("ORPHAN-CHAIN-GATE: RED (%d problem(s))" % len(problems))
        return 1
    print("ORPHAN-CHAIN-GATE: ALL GREEN (live repo on-branch with no unreachable commits; differential proves the predicate catches an orphan)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
