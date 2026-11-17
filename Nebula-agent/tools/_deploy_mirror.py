import shutil, hashlib, os, sys
# Deploy iron-rule: authoritative source serve/web -> parasite mirror, per-file MD5 verify.
# Python shutil (NOT robocopy command line) because the Chinese workspace path + "Program Files"
# space break robocopy / cmd command-line invocation.
#
# --prune: make the mirror follow the source on DELETION too (robocopy /MIR semantics). After
# copying, any file present in the mirror but NOT in the source is removed, and empty directories
# left behind are cleaned. Default OFF -> backward compatible (copy/verify only, never deletes).
# The mirror is a pure build product (the workspace source is the single truth), so pruned files
# are removed directly; the list is printed so the run stays auditable.
src = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "serve", "web")
dst = r"E:\Program Files\Strata-main\serve\web"

def md5(p):
    return hashlib.md5(open(p, "rb").read()).hexdigest()

def walk_files(root):
    out = []
    for dp, dns, fns in os.walk(root):
        for fn in fns:
            full = os.path.join(dp, fn)
            rel = os.path.relpath(full, root)
            out.append(rel)
    return sorted(out)

PRUNE = "--prune" in sys.argv[1:]

report = []
src_files = walk_files(src)
src_set = set(src_files)
for rel in src_files:
    s = os.path.join(src, rel)
    d = os.path.join(dst, rel)
    os.makedirs(os.path.dirname(d), exist_ok=True)
    if not os.path.isdir(os.path.dirname(d)):
        os.makedirs(os.path.dirname(d), exist_ok=True)
    shutil.copy(s, d)
    ok = md5(s) == md5(d)
    report.append((rel, "MATCH" if ok else "FAIL"))

print("deployed %d files from authoritative source -> mirror" % len(report))
fails = [r for r in report if r[1] != "MATCH"]
for rel, st in report:
    print(" ", st, rel)

pruned = []
if PRUNE:
    for rel in walk_files(dst):
        if rel not in src_set:
            d = os.path.join(dst, rel)
            try:
                os.remove(d)
                pruned.append(rel)
            except OSError as e:
                fails.append((rel, "PRUNE-FAIL:%s" % e))
    # clean empty directories bottom-up (never the mirror root itself)
    for dp, dns, fns in os.walk(dst, topdown=False):
        if os.path.abspath(dp) == os.path.abspath(dst):
            continue
        try:
            if not os.listdir(dp):
                os.rmdir(dp)
                pruned.append(os.path.relpath(dp, dst) + os.sep)
        except OSError:
            pass
    print("pruned %d extra mirror entries (source is the single truth)" % len(pruned))
    for rel in pruned:
        print("  -", rel)
else:
    print("(pass --prune to also delete mirror files the source no longer has)")

print("RESULT:", "ALL MATCH" if not fails else "MISMATCH: %s" % fails)
