"""
Local git-bundle backup for the Strata repo (NO remote, NO open-source, NO upload).

Why: the user keeps the source private (not on GitHub public) and wants a local,
versioned, fully-restorable backup that supersedes the fragile tools/_backup
timestamp-dir + .bak pile. A `git bundle --all` is ONE self-contained file that
carries the ENTIRE commit history, every branch, every tag -- so `git clone` of
that bundle reproduces the repo exactly. Stored OUTSIDE the repo, same drive.

This script is self-verifying:
  1. git bundle create --all        (full history, all refs, single file)
  2. git bundle verify              (git's own integrity check)
  3. clone-from-bundle rehearsal    (clone to a temp dir, prove it is identical:
                                     same HEAD sha, same total commit count,
                                     same tag count, master reachable)
Exit 0 = all green, non-zero = RED (a gate you can chain).

Usage:
  python tools/backup-bundle.py [DEST_DIR]
  DEST_DIR default:  E:\\01星云\\星云智能体备份   (outside the repo, same drive)

Run from anywhere; the repo root is derived at runtime via git (no hardcoded
Chinese path in the command line -- subprocess passes paths as unicode argv).
"""
import os, sys, subprocess, tempfile, shutil, datetime

DEFAULT_DEST = "E:\\01星云\\星云智能体备份"
# Keep the most recent N bundles; older ones are pruned after a green run. Daily backup
# for ~2 weeks. 0 disables pruning (keep everything).
DEFAULT_KEEP = 14


def sh(args, cwd=None):
    """Run a command (argv list, unicode-safe), return (code, stdout+stderr text)."""
    p = subprocess.run(args, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def prune_old(dest, keep):
    """Keep only the newest `keep` bundles in dest (by timestamped filename). 0 = keep all."""
    if keep <= 0:
        return []
    import glob, re
    pats = glob.glob(os.path.join(dest, "strata-bundle-*.bundle"))
    # filename carries YYYYMMDD-HHMMSS, so a lexical sort is a chronological sort
    pats.sort()
    doomed = pats[:-keep] if len(pats) > keep else []
    removed = []
    for f in doomed:
        try:
            os.remove(f); removed.append(os.path.basename(f))
        except OSError:
            pass
    return removed


def main():
    # args: [DEST_DIR] [--keep N]. A bare --keep is honored WITHOUT a positional DEST so
    # the scheduler can call "backup-bundle.py --keep 14" and keep the default destination.
    dest = DEFAULT_DEST
    keep = DEFAULT_KEEP
    rest = sys.argv[1:]
    i = 0
    pos = []
    while i < len(rest):
        a = rest[i]
        if a == "--keep":
            keep = int(rest[i + 1]); i += 2; continue
        if a.startswith("--keep="):
            keep = int(a.split("=", 1)[1]); i += 1; continue
        pos.append(a); i += 1
    if pos:
        dest = pos[0]

    here = os.path.dirname(os.path.abspath(__file__))
    code, out = sh(["git", "rev-parse", "--show-toplevel"], cwd=here)
    if code:
        print("RESULT: RED (cannot find git repo root from %s)" % here)
        print(out)
        return 1
    repo = out.strip()

    # repo HEAD + commit count + tag count (the ground truth we restore against)
    _, head = sh(["git", "rev-parse", "HEAD"], cwd=repo)
    head = head.strip()
    # Count the PORTABLE formal history (refs/heads/master), NOT --all: --all pulls in
    # refs/stash, whose WIP/index commits a `git clone` deliberately does NOT restore
    # (expected git behaviour, not data loss). master covers every baseline tag on its chain.
    _, cnt = sh(["git", "rev-list", "--count", "refs/heads/master"], cwd=repo)
    cnt = cnt.strip()
    _, tagraw = sh(["git", "tag", "-l"], cwd=repo)
    tags = [x for x in tagraw.splitlines() if x.strip()]

    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    os.makedirs(dest, exist_ok=True)
    bundle = os.path.join(dest, "strata-bundle-%s.bundle" % ts)

    print("repo    :", repo)
    print("HEAD    :", head)
    print("commits :", cnt, " tags:", len(tags))
    print("dest    :", dest)

    # 1) create the full bundle (all refs => self-contained, cloneable)
    code, out = sh(["git", "bundle", "create", bundle, "--all"], cwd=repo)
    if code or not os.path.isfile(bundle):
        print("RESULT: RED (bundle create failed)")
        print(out)
        return 1
    size = os.path.getsize(bundle)
    print("bundle  :", os.path.basename(bundle), "(%.2f MB)" % (size / 1048576.0))

    # 2) git's own integrity check
    code, out = sh(["git", "bundle", "verify", bundle], cwd=repo)
    v_ok = (code == 0 and "is okay" in out)
    print("verify  :", "OK" if v_ok else "FAIL")
    if not v_ok:
        print(out)
        print("RESULT: RED (bundle verify failed)")
        return 1

    # 3) clone-from-bundle rehearsal -> prove the bundle reproduces the repo
    tmp = tempfile.mkdtemp(prefix="strata_restore_")
    clone = os.path.join(tmp, "restored")
    code, out = sh(["git", "clone", bundle, clone])
    if code:
        print("RESULT: RED (clone-from-bundle failed)")
        print(out)
        shutil.rmtree(tmp, ignore_errors=True)
        return 1
    _, rhead = sh(["git", "rev-parse", "HEAD"], cwd=clone)
    rhead = rhead.strip()
    _, rcnt = sh(["git", "rev-list", "--count", "refs/heads/master"], cwd=clone)
    rcnt = rcnt.strip()
    _, rtagraw = sh(["git", "tag", "-l"], cwd=clone)
    rtags = [x for x in rtagraw.splitlines() if x.strip()]
    # master must be reachable in the restored clone
    _, rb = sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=clone)
    rb = rb.strip()
    shutil.rmtree(tmp, ignore_errors=True)

    checks = [
        ("HEAD sha matches", rhead == head, "%s == %s" % (rhead[:12], head[:12])),
        ("commit count matches", rcnt == cnt, "%s == %s" % (rcnt, cnt)),
        ("tag count matches", len(rtags) == len(tags), "%d == %d" % (len(rtags), len(tags))),
        ("master reachable", rb == "master", rb),
    ]
    red = 0
    for name, ok, detail in checks:
        print("  %-22s %s  %s" % (name, "OK" if ok else "FAIL", detail))
        if not ok:
            red += 1

    if red:
        print("RESULT: RED (restore rehearsal mismatch: %d)" % red)
        return 1
    print("RESULT: ALL GREEN (bundle verified + clone-rehearsal reproduced the repo)")
    print("restorable with:  git clone \"%s\" <dir>" % bundle)
    removed = prune_old(dest, keep)
    if removed:
        print("pruned  : kept newest %d, removed %d: %s" % (keep, len(removed), ", ".join(removed)))
    elif keep > 0:
        print("pruned  : kept newest %d, nothing to remove" % keep)
    return 0


if __name__ == "__main__":
    sys.exit(main())
