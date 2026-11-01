r"""Orphan-chain WATCH anchor (lightweight, observation-only -- NOT a CI gate).

This is the observation companion to the load-bearing CI gate tools/_orphan_chain_gate.py.
The gate is the hard tripwire; THIS anchor is a read-only nudge you run by hand so the
post-green detached-HEAD -> orphan drift is noticed EARLY, before it quietly lands a
pure-doc commit on a detached HEAD (which would make master stop moving). It guards against
FUTURE hooks introducing the same class of drift, not just the one we already fixed.

WHAT IT READS (read-only, the real repo; runs no git that mutates anything):
  - git branch --show-current  -> are we ON a branch, or DETACHED?
  - git rev-parse master / HEAD -> do the two pointers hold the same commit?
  - git log master..HEAD        -> does HEAD carry a commit master CANNOT reach (a real orphan)?

THREE STATES (the whole point -- distinguish benign drift from a real orphan):
  OK     on a branch, nothing unreachable -> clean, the normal resting state.
  NUDGE  DETACHED but HEAD == master tip (content identical). This is the KNOWN post-green
         hook side effect (the hook checks the tag out and restores HEAD by hash, leaving a
         detached HEAD whose content equals master). It is NOT a data loss -- just put HEAD
         back on the branch. A nudge to glance, not a mandate.
  WARN   HEAD carries a commit master cannot reach (git log master..HEAD non-empty), OR we are
         detached AND content differs from master -> a REAL orphan: master did not move, the
         commit is connected to no branch. Fix: git checkout master && git merge --ff-only <orphan>.

HONESTY NOTE: this is deliberately NOT a CI gate. It prints a verdict for a human glance; it
must not fail CI (a detached-HEAD-equals-master moment is expected right after a post-green
hook run and is not a failure). The hard tripwire with the differential proof stays in
_orphan_chain_gate.py. Do not register THIS file in SUITES -- registration would turn a nudge
into a gate and break the separation this anchor exists to keep.

Pure-ASCII output only (Chinese print through a pipe/code page gets swallowed).
Read-only. Run any time:  python tools\_orphan_chain_watch.py
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # strata-agent/


def git(args):
    r = subprocess.run(["git"] + args, cwd=ROOT, capture_output=True, text=True)
    return r.stdout.strip()


def main() -> int:
    on_branch = git(["branch", "--show-current"])
    master = git(["rev-parse", "master"])
    head = git(["rev-parse", "HEAD"])
    ahead = git(["log", "master..HEAD", "--oneline"])   # commits HEAD has that master cannot reach

    print("orphan-chain WATCH anchor (read-only, NOT a CI gate)")
    print("=" * 66)
    print("on_branch  = %s" % (repr(on_branch) if on_branch else "(empty -> DETACHED)"))
    print("master     = %s" % master[:7])
    print("HEAD       = %s" % head[:7])
    print("master..HEAD (HEAD carries unreachable commits) = %s" % (repr(ahead) if ahead else "(empty)"))
    print("-" * 66)

    # Decide the three states. The order matters: a REAL orphan (unreachable commit) is the
    # worst; then detached-but-equal (benign known hook side effect); then clean.
    if ahead:
        verdict = "WARN"
        why = "HEAD carries commit(s) master cannot reach -> REAL ORPHAN. " \
              "Fix: git checkout master && git merge --ff-only <the-orphan-commit>."
    elif on_branch == "" and head == master:
        verdict = "NUDGE"
        why = "DETACHED but content equals master tip -> the KNOWN post-green hook side effect " \
              "(not data loss). Just put HEAD back on the branch."
    elif on_branch == "":
        verdict = "WARN"
        why = "DETACHED AND content differs from master -> investigate before committing anything."
    else:
        verdict = "OK"
        why = "on a branch, nothing unreachable -> clean resting state."

    print("VERDICT: %s -- %s" % (verdict, why))
    print("NOTE: nudge = a glance + put HEAD back; WARN = a real orphan needs the ff-only fix. "
          "This anchor is observation-only; the hard tripwire is tools/_orphan_chain_gate.py.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
