#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Download-state exec-bit lock for the POSIX launchers (2026-11-26).

Context: a user reported that, on Linux, double-clicking the GitHub-downloaded
main source's 星云白泽.sh would NOT launch the agent. Line endings and the
shebang were already correct (the repo pins `*.sh text eol=lf`, blobs are pure LF,
shebang is `#!/usr/bin/env bash`), so the `bash\r: bad interpreter` class of bug is
NOT the cause. The real cause is a THIRD, distinct axis: git recorded every
first-party launcher at mode 100644 (no executable bit). A GitHub "Download ZIP"
preserves that mode, so the files land on disk as `-rw-r--r--` and a Linux desktop
refuses to execute them on double-click (it opens them in a text editor or says
"cannot launch / not executable").

The fix was `git update-index --chmod=+x` on the launcher chain, which records
100755 in the tree. `git ls-tree HEAD <path>` reports EXACTLY that tree mode, and
that is precisely the permission a clone/ZIP preserves -- so reading the mode from
HEAD is the download-state check (no local filesystem, no bash needed; the gate
host is Windows).

This gate locks the four user/chain-facing launchers at 100755, and a decoy that
rewrites the recorded mode to 100644 MUST flip the predicate to False -- a
load-bearing differential proving the check tracks the exec bit and is not a
tautology. Pure stdlib, reads HEAD, <1s. node_modules' third-party .sh are
deliberately out of scope.
"""
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # .../NebulaBaize

# the launcher chain a Linux user actually touches: the double-clicked entry point
# plus everything it shells out to, plus setup.sh (also double-clicked / run first).
LAUNCHERS = [
    "星云白泽.sh",                  # the double-clicked entry point (root)
    "Nebula-agent/gw_watchdog.sh",       # entry point -> watchdog
    "Nebula-agent/run_standalone.sh",    # watchdog -> gateway relaunch
    "setup.sh",                      # first-run installer, also run by hand
]
fails = []


def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        fails.append(label)


def mode_is_exec(mode):
    """True when a git tree mode string (e.g. '100755') carries the owner-exec bit.
    Pure predicate so the decoy can re-run it on a mutated mode without git."""
    try:
        return int(mode, 8) & 0o111 != 0
    except ValueError:
        return False


def tree_mode(path):
    """The git mode a downloader receives for `path`: `git ls-tree HEAD -- <path>`
    reports the committed tree mode, which clone/ZIP preserves. Returns the mode
    string, or None when the path is not tracked at HEAD."""
    p = subprocess.run(["git", "ls-tree", "HEAD", "--", path], cwd=REPO,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError("git ls-tree HEAD -- %s failed: %s"
                           % (path, p.stderr.decode("utf-8", "replace")))
    line = p.stdout.decode("utf-8", "replace").strip()
    if not line:
        return None
    return line.split()[0]            # "<mode> blob <sha>\t<path...>"; the octal mode


def main():
    for path in LAUNCHERS:
        mode = tree_mode(path)
        check(mode is not None, "T0 %s is tracked at HEAD" % path)
        if mode is None:
            continue
        check(mode_is_exec(mode),
              "T1 %s git tree mode = %s carries the exec bit (download/ZIP keeps it)" % (path, mode))

    # decoy differential: a 100644 recorded mode (the exact pre-fix regression) must
    # be rejected -- proves T1 tracks the exec bit, not merely "is it a number".
    check(mode_is_exec("100755"), "T2a positive control: 100755 accepted")
    check(not mode_is_exec("100644"), "T2b decoy 100644 (no exec bit) rejected -> T1 is load-bearing")

    print("")
    if fails:
        print("SH-EXEC-BITS: FAIL (%d)" % len(fails))
        return 1
    print("SH-EXEC-BITS: ALL GREEN (HEAD tree exec-bit lock on the launcher chain + 100644 decoy differential)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
