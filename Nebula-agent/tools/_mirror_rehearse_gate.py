"""Cross-drive mirror clone-rehearsal gate (2026-11-09).

Why: the daily backup mirrors the verified bundle to an INDEPENDENT disk (F) and, since the
mirror-rehearse change, runs the SAME clone-from-bundle rehearsal against the F-side copy so a
silent corruption / partial write on the other disk lands as RED. That rehearsal lives in
backup-bundle.py::rehearse_from_bundle(). This gate locks it: it builds a throwaway git repo +
bundle in a temp dir and drives rehearse_from_bundle() through a LOAD-BEARING differential, so
the function is proven to actually compare (not to always return green) -- WITHOUT touching the
real F: drive (we rehearse a temp bundle, so CI never needs F attached).

Contract (real git subprocess, deterministic):
  POSITIVE  a good bundle rehearsed against its OWN truth  -> red == 0 (all 4 checks OK)
  NEGATIVE  a good bundle rehearsed against a WRONG head    -> red > 0  (HEAD check load-bearing)
  NEGATIVE  a good bundle rehearsed against a WRONG count   -> red > 0  (commit-count check load-bearing)
  NEGATIVE  a good bundle rehearsed against WRONG tag set   -> red > 0  (tag-count check load-bearing)
  NEGATIVE  a NON-EXISTENT bundle                           -> red > 0  (clone-fail branch)

Run: python tools/_mirror_rehearse_gate.py
"""
import os, sys, subprocess, tempfile, importlib.util

def sh(args, cwd=None):
    p = subprocess.run(args, cwd=cwd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    return p.returncode, (p.stdout or "") + (p.stderr or "")

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "backup_bundle", os.path.join(HERE, "backup-bundle.py"))
bb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bb)
rehearse = bb.rehearse_from_bundle

FAILS = []
def check(label, cond, extra=""):
    print("  " + ("OK   " if cond else "FAIL ") + label + (("  " + extra) if extra else ""))
    if not cond:
        FAILS.append(label)

# Build a throwaway repo: 2 commits, 1 tag -> bundle. Ground truth read back from the repo.
repo = tempfile.mkdtemp(prefix="mirror_gate_repo_")
sh(["git", "init", "-q", "-b", "master", repo])
sh(["git", "config", "user.email", "gate@local"], cwd=repo)
sh(["git", "config", "user.name", "gate"], cwd=repo)
open(os.path.join(repo, "a.txt"), "w").write("1\n")
sh(["git", "add", "-A"], cwd=repo)
sh(["git", "commit", "-qm", "c1"], cwd=repo)
sh(["git", "tag", "v-gate-1"], cwd=repo)
open(os.path.join(repo, "b.txt"), "w").write("2\n")
sh(["git", "add", "-A"], cwd=repo)
sh(["git", "commit", "-qm", "c2"], cwd=repo)

_, head = sh(["git", "rev-parse", "HEAD"], cwd=repo); head = head.strip()
_, cnt = sh(["git", "rev-list", "--count", "refs/heads/master"], cwd=repo); cnt = cnt.strip()
_, tagraw = sh(["git", "tag", "-l"], cwd=repo)
tags = [x for x in tagraw.splitlines() if x.strip()]

bdir = tempfile.mkdtemp(prefix="mirror_gate_bundle_")
bundle = os.path.join(bdir, "gate.bundle")
code, out = sh(["git", "bundle", "create", bundle, "--all"], cwd=repo)
if code or not os.path.isfile(bundle):
    print("MIRROR-REHEARSE-GATE: cannot build fixture bundle: " + out.strip()[:200])
    sys.exit(1)

print("MIRROR-REHEARSE-GATE:")

# POSITIVE: bundle rehearsed against its own truth must be fully green.
red, lines = rehearse(bundle, head, cnt, tags, "pos")
check("positive: good bundle -> red == 0", red == 0, "red=%d" % red)
check("positive: all 4 checks report OK", all("OK" in l for l in lines), "%d lines" % len(lines))

# NEGATIVE: each check must be load-bearing (a wrong truth flips red).
r1, _ = rehearse(bundle, "0" * 40, cnt, tags, "neg-head")
check("differential: wrong HEAD -> red > 0", r1 > 0, "red=%d" % r1)
r2, _ = rehearse(bundle, head, str(int(cnt) + 5), tags, "neg-cnt")
check("differential: wrong commit count -> red > 0", r2 > 0, "red=%d" % r2)
r3, _ = rehearse(bundle, head, cnt, [], "neg-tag")
check("differential: wrong tag set -> red > 0", r3 > 0, "red=%d" % r3)

# NEGATIVE: a missing bundle must fail the clone branch (not crash), red >= 1.
r4, _ = rehearse(os.path.join(bdir, "does-not-exist.bundle"), head, cnt, tags, "neg-missing")
check("negative: missing bundle -> red > 0 (clone-fail branch)", r4 > 0, "red=%d" % r4)

print("")
if FAILS:
    print("MIRROR-REHEARSE-GATE: " + str(len(FAILS)) + " FAILED")
    sys.exit(1)
print("MIRROR-REHEARSE-GATE: ALL GREEN (rehearse_from_bundle load-bearing; no F: dependency)")
sys.exit(0)
