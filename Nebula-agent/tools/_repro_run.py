# -*- coding: utf-8 -*-
# Drive the per-shape repro pages through a REAL browser (Edge headless) and read the
# probe back off the post-JS DOM. Deterministic per-shape call, isolated profile each time.
# The probe reports on THREE channels: console PROBE:: lines (via --enable-logging),
# <title>, and <pre id=probe-out>. We grep all three so a single channel failure never
# blinds us. Pure stdlib, ASCII-only stdout.
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

# shapes must match tools/_repro_build.py
SHAPES = sys.argv[1:] or ["baseline"]

def url_for(shape):
    # file:// path contains the workspace CJK segment -> percent-encode it so the
    # command line stays code-page safe (known trap in this environment).
    servedir = os.path.join(ROOT, "serve")
    page = os.path.join(servedir, "_repro_" + shape + ".html")
    if not os.path.exists(page):
        return None
    p = os.path.abspath(page).replace("\\", "/")
    enc = re.sub(r"[^\x00-\x7f]", lambda m: "".join("%%%02X" % b for b in m.group(0).encode("utf-8")), p)
    return "file:///" + enc

def run(shape):
    u = url_for(shape)
    if u is None:
        return None, "PAGE-MISSING"
    prof = tempfile.mkdtemp(prefix="edgerepro_")
    args = [EDGE, "--headless=new", "--timeout=20000", "--virtual-time-budget=12000",
            "--user-data-dir=" + prof, "--no-first-run", "--no-default-browser-check",
            "--enable-logging=stderr", "--log-level=INFO", "--dump-dom", u]
    try:
        r = subprocess.run(args, capture_output=True, timeout=120, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return None, "TIMEOUT-120s"
    blob = r.stdout.decode("utf-8", "replace") + "\n" + r.stderr.decode("utf-8", "replace")
    hits = [l.strip() for l in blob.splitlines() if "PROBE::" in l]
    t = re.search(r"<title>(.*?)</title>", blob, re.S)
    pre = re.search(r'<pre id="probe-out"[^>]*>(.*?)</pre>', blob, re.S)
    return hits, ("TITLE[" + (t.group(1)[:400]) + "]" if t else "NO-TITLE") + " | " + ("PRE[" + (pre.group(1)[:400]) + "]" if pre else "NO-PRE")

for s in SHAPES:
    hits, extra = run(s)
    print("=== SHAPE " + s)
    if hits:
        for h in hits:
            print("   " + h)
    print("   " + (extra or ""))
