# -*- coding: utf-8 -*-
r"""Static guard (permanent, 2026-11-02): the filesystem__write permission boundary.

The boundary bites a real way: a write that goes THROUGH the filesystem__write tool layer to an
ABSOLUTE path OUTSIDE the allowed roots is rejected with "path escapes sandbox root". The fix
(landed as a rule) is: a probe/temp artefact a driven script needs must be written by the script
ITSELF (Python tempfile, or a relative path inside the workspace root) -- not handed to
filesystem__write pointing at an absolute external path (e.g. C:\\Users\\sk).

This gate scans the source of every gate/resident script (tools/ + tests/, .py and .mjs) and
alerts when an absolute path that falls OUTSIDE the allowed roots sits in a WRITE-TARGET
position. It deliberately does NOT alert when the absolute path is the written CONTENT or a data
key (those are not writes) -- distinguishing those is what keeps the existing tests green.

Differential self-proof (a guard that cannot catch red is an empty shell -- 2026-10-21 adjudication):
  POS: a synthesised line that writes an external absolute path through the tool layer -> MUST hit.
  NEG: a synthesised tempfile write + a data-key absolute path + an in-root write -> MUST NOT hit.
A ratchet baseline (like test_code_hygiene) grandfathers the known historical scratch writes
already on disk; any NEW absolute-external write alerts.

Path normalisation folds source-literal double-backslashes to single and compares lowercase with
forward slashes (NO unicode_escape -- that mangles CJK roots and produced a false positive on the
first run, which is what forced this fix).

Pure stdlib, no upstream dependency, deterministic, ASCII-only output. Run from Nebula-agent/:
    python tools\\_sandbox_write_guard.py
"""
from __future__ import annotations

import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # Nebula-agent/
WSROOT = os.path.dirname(ROOT)                                       # workspace root

ALLOW_FILE_CANDS = [os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "fs_allowed_roots.txt"),
                    os.path.join(WSROOT, "fs_allowed_roots.txt")]

# Ratchet baseline: known historical scratch writes already on disk (grandfathered, like
# test_code_hygiene's baseline). (basename, line_number). Any NEW absolute-external write alerts.
BASELINE = {
    ("_read_index.py", 2),   # untracked scratch probe in the workspace-root tools/ hygiene space
}

def norm(p):
    return p.replace("\\\\", "/").replace("\\", "/").rstrip("/").lower()

def load_allowed():
    allow_file = next((p for p in ALLOW_FILE_CANDS if os.path.isfile(p)), None)
    roots = []
    if allow_file:
        for line in open(allow_file, encoding="utf-8"):
            line = line.strip()
            if line and (re.match(r"^[A-Za-z]:[/\\]", line) or line.startswith(("//", "/"))):
                roots.append(norm(os.path.abspath(line)))
    roots.append(norm(WSROOT))
    return roots

def L(txt):
    return txt.replace("\\\\", "/").replace("\\", "/").rstrip("/")

# absolute-path-in-a-write-TARGET-position shapes
TARGETS = [
    (re.compile(r"open\(\s*[\"']((?:[A-Za-z]:[/\\\\]|\\\\\\\\)[^\"']+)[\"']\s*,\s*[\"'][wa]"), "open target+write-mode"),
    (re.compile(r"writeFileSync\(\s*[\"']((?:[A-Za-z]:[/\\\\]|\\\\\\\\)[^\"']+)[\"']"), "writeFileSync target"),
    (re.compile(r"copy(?:file|tree|2|)?\([^,]*,\s*[\"']((?:[A-Za-z]:[/\\\\]|\\\\\\\\)[^\"']+)[\"']"), "copy destination"),
    (re.compile(r"shutil\.\w*copy\w*\([^,]*,\s*[\"']((?:[A-Za-z]:[/\\\\]|\\\\\\\\)[^\"']+)[\"']"), "shutil.copy destination"),
    (re.compile(r"fsWrite\(\s*\{[^}]*path\s*:\s*[\"']((?:[A-Za-z]:[/\\\\]|\\\\\\\\)[^\"']+)[\"']"), "fsWrite path field"),
]

def under_allowed(p, allowed):
    p = norm(os.path.abspath(p))
    return any(p == r or p.startswith(r + "/") for r in allowed)

def scan_lines(text, allowed):
    hits = []
    for ln, line in enumerate(text.splitlines(), 1):
        for rx, note in TARGETS:
            m = rx.search(line)
            if not m:
                continue
            p = L(m.group(1))
            if under_allowed(p, allowed):
                continue
            if any(k in line for k in ("tempfile", "mkdtemp", "mkstemp", "NamedTemporary",
                                       "TemporaryFile", "TemporaryDirectory")):
                continue
            hits.append((ln, p.strip(), note))
    return hits

POS_LINE = "fsWrite({ path: 'C:\\Users\\sk\\probe.html', content: 'x' })"   # external tool-layer write -> HIT
NEG_LINES = [
    "with tempfile.NamedTemporaryFile(suffix='.html') as f: f.write('x')",     # self-writes via tempfile -> no hit
    "const map = { 'C:\\Users': ['sk','admin'] };",                            # data key, not a write -> no hit
    "open('@@ALLOWROOT@@/tmp.txt', 'w').write('x')",                                   # in an allowed root -> no hit
]

def main() -> int:
    allowed = load_allowed()
    print("allowed roots:", len(allowed))

    pos = scan_lines(POS_LINE, allowed)
    neg_samples = [l.replace("@@ALLOWROOT@@", allowed[0]) for l in NEG_LINES]
    neg = scan_lines("\n".join(neg_samples), allowed)
    pos_ok = len(pos) == 1
    neg_ok = len(neg) == 0
    print("differential POS (external tool-layer write) -> %d hit(s) [expect 1]" % len(pos))
    print("differential NEG (tempfile / data key / in-root) -> %d hit(s) [expect 0]" % len(neg))

    files = []
    for base in ("tools", "tests"):
        for pat in ("*.py", "*.mjs"):
            files += glob.glob(os.path.join(ROOT, base, pat))
    real_hits = []
    for f in files:
        if os.path.basename(f) == "_sandbox_write_guard.py":
            continue
        for ln, p, note in scan_lines(open(f, encoding="utf-8", errors="ignore").read(), allowed):
            real_hits.append((os.path.basename(f), ln, p, note))

    new_hits = [h for h in real_hits if (h[0], h[1]) not in BASELINE]
    known = [h for h in real_hits if (h[0], h[1]) in BASELINE]
    print("scanned %d file(s); NEW hits: %d  (baseline grandfathered: %d)"
          % (len(files), len(new_hits), len(known)))
    for name, ln, p, note in new_hits:
        print("  NEW   %s:%d  %s  ->  %s" % (name, ln, p, note))
    for name, ln, p, note in known:
        print("  known %s:%d  %s  ->  %s" % (name, ln, p, note))

    if not pos_ok:
        print("SANDBOX-WRITE-GUARD: RED (scanner not load-bearing -- the POS sample did not hit)")
        return 1
    if not neg_ok:
        print("SANDBOX-WRITE-GUARD: RED (false positive -- the NEG sample hit; data/content must not alert)")
        return 1
    if new_hits:
        print("SANDBOX-WRITE-GUARD: RED (%d NEW write(s) to an absolute external path via the tool layer)"
              % len(new_hits))
        return 1
    print("SANDBOX-WRITE-GUARD: ALL GREEN (scanner load-bearing, no NEW violations)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
