#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Download-state line-ending + shebang lock for setup.sh (2026-11-24).

Symmetric sibling of test_setup_bat_download.py. setup.bat is a Windows launcher
that cmd can only parse when the blob is CRLF; setup.sh is the POSIX counterpart
that bash can only launch when the shebang line ends in a bare LF. The repo pins
`*.sh text eol=lf` in .gitattributes precisely so a checkout/clone never turns
this into CRLF (a CRLF shebang -> `bash\r: bad interpreter`).

This is a STATIC lock, not an end-to-end run: the gate host is Windows and has no
bash, so we cannot exec the launcher here (unlike setup.bat, which we DO run).
Instead we read the exact bytes a downloader receives (`git show HEAD:setup.sh`;
setup.sh is `text eol=lf`, so the checkout/download transform is LF-forcing and
the blob is already LF, so `git show` bytes match what lands on disk) and assert
the invariants that make it runnable on Linux/macOS, with a decoy that injects a
CR to prove the lock is load-bearing. Pure stdlib.
"""
import os
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # .../NebulaBaize
fails = []


def check(cond, label):
    print(("PASS " if cond else "FAIL ") + label)
    if not cond:
        fails.append(label)


def setup_sh_blob():
    p = subprocess.run(["git", "show", "HEAD:setup.sh"], cwd=REPO,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode != 0:
        raise RuntimeError("git show HEAD:setup.sh failed: " +
                           p.stderr.decode("utf-8", "replace"))
    return p.stdout


def sh_is_clean(raw):
    """Return (ok, reasons). ok True only when the blob is pure LF AND the first
    line is an exactly-correct shebang with no trailing CR. Pure predicate so the
    decoy can re-run it on a mutated blob without touching git."""
    reasons = []
    if raw.count(b"\r\n") != 0:
        reasons.append("blob contains %d CRLF (must be pure LF)" % raw.count(b"\r\n"))
    # every newline must be a bare LF: total LF == total \n AND no lone \r anywhere
    if raw.count(b"\r") != 0:
        reasons.append("blob contains %d stray CR (bash sees them as part of the line)"
                       % raw.count(b"\r"))
    first = raw.split(b"\n", 1)[0]
    if first != b"#!/usr/bin/env bash":
        reasons.append("shebang line is %r (must be b'#!/usr/bin/env bash' with no trailing CR)" % first)
    return (len(reasons) == 0), reasons


def main():
    raw = setup_sh_blob()

    # T0: the headline invariant -- download-state setup.sh must be runnable bash.
    ok, reasons = sh_is_clean(raw)
    check(ok, "T0 download setup.sh is a runnable POSIX script (pure LF + clean shebang)"
          + ("" if ok else " -- " + "; ".join(reasons)))

    # T1: explicit, separately-named locks so a future drift points at the exact axis.
    check(raw.count(b"\n") > 0 and raw.count(b"\r") == 0,
          "T1 setup.sh uses LF-only line endings (CR count = %d)" % raw.count(b"\r"))
    check(raw.split(b"\n", 1)[0] == b"#!/usr/bin/env bash",
          "T2 setup.sh shebang == '#!/usr/bin/env bash' (no CR)")

    # T3 decoy differential: inject a CRLF into the shebang (exactly what a broken
    #     eol=lf rule / a Windows-editor save would do) and prove sh_is_clean flips.
    good = raw.split(b"\n", 1)
    decoy = good[0] + b"\r\n" + (good[1] if len(good) > 1 else b"")
    decoy_ok, _ = sh_is_clean(decoy)
    check(decoy != raw, "T3a decoy CRLF injection applied")
    check(not decoy_ok, "T3b decoy (CRLF shebang) is rejected -> T0 is load-bearing")

    print("")
    if fails:
        print("SETUP-SH-DOWNLOAD: FAIL (%d)" % len(fails))
        return 1
    print("SETUP-SH-DOWNLOAD: ALL GREEN (download-state LF/shebang lock + decoy differential)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
