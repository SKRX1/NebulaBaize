import shutil, hashlib, os
# Deploy iron-rule: authoritative source serve/web -> parasite mirror, per-file MD5 verify.
# Python shutil (NOT robocopy command line) because the Chinese workspace path + "Program Files"
# space break robocopy / cmd command-line invocation.
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

report = []
src_files = walk_files(src)
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
print("RESULT:", "ALL MATCH" if not fails else "MISMATCH: %s" % fails)
