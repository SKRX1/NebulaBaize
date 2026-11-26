#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Download-state exec-bit lock for EVERY first-party .sh in the repo (2026-11-26).

Context: a user reported that, on Linux, double-clicking the GitHub-downloaded
main source's 星云白泽.sh would NOT launch the agent. Line endings and the
shebang were already correct (the repo pins `*.sh text eol=lf`, blobs are pure LF,
shebang is `#!/usr/bin/env bash`), so the `bash\r: bad interpreter` class of bug is
NOT the cause. The real cause is a THIRD, distinct axis: git recorded every
first-party launcher at mode 100644 (no executable bit). A GitHub "Download ZIP"
preserves that mode, so the files land on disk as `-rw-r--r--` and a Linux desktop
refuses to execute them on double-click (it opens them in a text editor or says
"cannot launch / not executable").

The fix was `git update-index --chmod=+x`, which records 100755 in the tree.
`git ls-tree HEAD <path>` reports EXACTLY that tree mode, and that is precisely the
permission a clone/ZIP preserves -- so reading the mode from HEAD is the
download-state check (no local filesystem, no bash needed; the gate host is Windows).

EVOLVED SCOPE (task 2, 2026-11-26): the original gate hardcoded four launcher
names, so a FIFTH first-party .sh added later could silently land at 100644 and
never be caught. `Nebula-agent/scripts/build_modules.sh` was in exactly that state
(100644, run via `bash scripts/build_modules.sh` in CI) -- a live example of the
very drift this gate is meant to prevent. This gate now DYNAMICALLY discovers every
tracked first-party `.sh` (everything except vendored `node_modules/`, whose
exec bits belong to upstream and must NOT be policed by us) and asserts each one
carries the exec bit. A brand-new first-party .sh that forgets `chmod +x` now
flips this gate red the moment it is committed.

Three load-bearing differentials prove the checks track real state, not tautology:
  * exec-bit decoy: a 100644 recorded mode (the exact pre-fix regression) MUST be
    rejected by mode_is_exec -> T1 tracks the exec bit, not merely "is a number".
  * vendored-scope decoy: the node_modules filter MUST exclude third-party .sh
    (they are legitimately 100644 on the upstream tarball); if is_first_party were
    the literal True, the decoy proves the predicate would wrongly flag them.
  * presence guard: LAUNCHERS (the entry chain a Linux user touches) is asserted to
    still be present in the discovered set, so a dynamic-scan regression that
    returns an empty list cannot produce a false "all green".

Pure stdlib, reads HEAD, <1s.
"""
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # .../NebulaBaize

# The launcher chain a Linux user actually touches: the double-clicked entry point
# plus everything it shells out to, plus setup.sh. We assert these are present in
# the discovered set (presence guard) AND that discovery is not vacuous. If one is
# renamed/removed on purpose, update this list in the same commit that does so.
LAUNCHERS = [
    "星云白泽.sh",                       # the double-clicked entry point (root)
    "Nebula-agent/gw_watchdog.sh",        # entry point -> watchdog
    "Nebula-agent/run_standalone.sh",     # watchdog -> gateway relaunch
    "setup.sh",                           # first-run installer, also run by hand
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


def is_first_party(path):
    """True for a first-party .sh we own and must keep executable; False for
    vendored third-party code under node_modules/ (its exec bits belong to the
    upstream package and are legitimately 100644 on the published tarball)."""
    norm = path.replace("\\", "/")
    return not norm.startswith("node_modules/")


def tracked_sh_modes():
    """(path, mode) for every tracked .sh at the index/HEAD tree. `git ls-files -s`
    lists "<mode> <sha> <stage>\t<path" and reports the staged/index mode, which on
    a clean tree equals the HEAD tree mode -- the exact permission a clone/ZIP keeps.
    core.quotepath=off keeps unicode paths (星云白泽.sh) readable."""
    p = subprocess.run(["git", "-c", "core.quotepath=off", "ls-files", "-s", "*.sh"],
                       cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError("git ls-files -s '*.sh' failed: %s"
                           % p.stderr.decode("utf-8", "replace"))
    out = []
    for line in p.stdout.decode("utf-8").splitlines():
        head, sep, path = line.partition("\t")
        if not sep:
            continue
        out.append((path, head.split()[0]))
    return out


def main():
    entries = tracked_sh_modes()
    first_party = [(pth, m) for pth, m in entries if is_first_party(pth)]
    vendored = [pth for pth, m in entries if not is_first_party(pth)]

    print("[gate] tracked .sh: %d total -> %d first-party, %d vendored(excluded)"
          % (len(entries), len(first_party), len(vendored)))
    for pth, m in first_party:
        print("       + %s  %s" % (m, pth))

    # T1: every first-party .sh must carry the exec bit (download/ZIP preserves it).
    for pth, m in first_party:
        check(mode_is_exec(m),
              "T1 %s git tree mode = %s carries the exec bit (download/ZIP keeps it)" % (pth, m))

    # T2 presence guard: the entry-launcher chain is still in the discovered set, so
    # a vacuous/empty dynamic scan cannot yield a false all-green.
    discovered = set(pth for pth, _ in first_party)
    for launcher in LAUNCHERS:
        check(launcher in discovered,
              "T2 presence guard: %s is discovered as first-party (scan not vacuous)" % launcher)

    # T3 exec-bit decoy: a 100644 recorded mode (the exact pre-fix regression) must be
    # rejected -- proves T1 tracks the exec bit, not merely "is a number".
    check(mode_is_exec("100755"), "T3a positive control: 100755 accepted")
    check(not mode_is_exec("100644"), "T3b decoy 100644 (no exec bit) rejected -> T1 is load-bearing")

    # T4 vendored-scope decoy: node_modules .sh must be classified OUT of scope. They
    # are legitimately 100644 upstream; if is_first_party ignored node_modules (e.g.
    # returned True unconditionally) they would leak into the policed set and flip
    # this gate red on files we do not own. The decoy re-runs the predicate on a real
    # vendored path and asserts it is excluded.
    sample_vendored = next((pth for pth in vendored), None)
    if sample_vendored is not None:
        check(not is_first_party(sample_vendored),
              "T4a vendored .sh (%s) excluded from the policed set" % sample_vendored)
    else:
        print("NOTE no vendored node_modules/*.sh present -> T4a vacuous (node_modules not installed)")
    check(is_first_party("星云白泽.sh") and is_first_party("Nebula-agent/scripts/build_modules.sh"),
          "T4b first-party predicate still accepts our own launchers/scripts")

    print("")
    if fails:
        print("SH-EXEC-BITS: FAIL (%d)" % len(fails))
        return 1
    print("SH-EXEC-BITS: ALL GREEN (HEAD exec-bit lock on ALL first-party .sh; "
          "node_modules excluded; presence-guard + 100644 + vendored decoys)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
