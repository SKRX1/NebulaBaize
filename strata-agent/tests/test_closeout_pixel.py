# -*- coding: utf-8 -*-
r"""Pixel-level regression gate for the closing-out backstop (B mechanism).

The mechanism layer (test_closeout_backstop.mjs) proves the reminder is DRAWN in the DOM via
jsdom. But jsdom does NOT run layout, so "drawn in DOM" is not yet "visible on pixels". This
gate closes the gap with a REAL headless Edge on a REAL computed-style probe, so a mechanism
that renders in jsdom but paints invisibly (the README line-203 "dark page screenshots black"
class of untrustworthiness) is caught here, not assumed.

Layer split (each layer measured on its own, so a hang in one is diagnosable — the exact
lesson from the round that hung 150s):
  1. jsdom renders the REAL DOM via the REAL functions and writes STATIC snapshots
     (inline real CSS + an immediate-execution computed-style probe baked into document.title;
     NO app.js boot in the snapshot, so the untrustworthy boot path is avoided).
  2. REAL Edge: --dump-dom reads the computed-style probe back (real layout, not jsdom), and
     --screenshot captures a PNG. A pure-stdlib PNG decoder counts non-background pixels so the
     assertion is PIXEL truth, not a crude byte signal.

Differential contract (mirrors the mechanism gate, so a guard relaxation locks BOTH sides):
  A  all-ticked plan + empty steps   -> box visible, reminder VISIBLE, PNG carries content
  C  live proposal  + empty steps    -> box visible, reminder VISIBLE, PNG carries content   (the user-requested scene)
  B  plain empty (control)           -> box hidden, reminder NONE,   PNG is essentially blank

On a machine with no renderable browser the gate SKIPS (exit 0) so CI stays deterministic; on
a normal machine it runs for real and writes the success screenshots into tools/baseline/ as the
"mechanism-backstop pixel layer proven" archival anchor.

Run standalone: python tests/test_closeout_pixel.py
"""
from __future__ import annotations

import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "servers"))
import browser_server as bs   # noqa: E402  (reuse _find_browser / _run_capture)

# fixture snapshots + the baseline archive anchor MUST stay inside the workspace root and are
# written by the scripts themselves (jsdom fixture via Node, Edge via --screenshot) -- never
# handed to the filesystem__write tool layer pointing at an absolute path OUTSIDE the roots
# (that is what _sandbox_write_guard.py now locks).
FIXTURE = os.path.join(HERE, "tools", "_pixel_backstop_fixture.mjs")
BASELINE = os.path.join(HERE, "tools", "baseline")
NODE = shutil.which("node") or r"C:\Users\sk\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"

# Differential contract: scene -> (expected box state, expected reminder state)
SCENES = {
    "A": ("VISIBLE", "VISIBLE"),     # all-ticked plan
    "C": ("VISIBLE", "VISIBLE"),     # live decision card (user-requested pixel sample)
    "B": ("HIDDEN",   "NONE"),        # plain empty control
}
# a content-bearing snapshot must carry at least this many non-background pixels;
# the blank control must carry fewer than this (real layout of a visible reminder is >> this)
CONTENT_MIN = 80
BLANK_MAX = 40

# Parallelism cap: workers = min(#scenes, cpu_count, PARALLEL_CAP). Each scene is an
# independent cold browser launch in its OWN profile, so they parallelise cleanly.
PARALLEL_CAP = 8


# ---- pure-stdlib PNG decoder (8-bit RGB/RGBA, non-interlaced, filters 0-4) ---------------
def decode_png(path):
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    pos = 8
    w = h = bitdepth = colortype = interlace = 0
    idat = b""
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos + 4])[0]
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        if typ == b"IHDR":
            w, h, bitdepth, colortype, _, _, interlace = struct.unpack(">IIBBBBB", chunk)
        elif typ == b"IDAT":
            idat += chunk
        elif typ == b"IEND":
            break
        pos += 12 + ln
    if interlace != 0 or bitdepth != 8 or colortype not in (2, 6):
        return None
    channels = 4 if colortype == 6 else 3
    raw = zlib.decompress(idat)
    stride = w * channels
    out = bytearray()
    prev = bytearray(stride)
    i = 0
    for _ in range(h):
        f = raw[i]; i += 1
        line = bytearray(raw[i:i + stride]); i += stride
        if f == 1:
            for x in range(channels, stride):
                line[x] = (line[x] + line[x - channels]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - channels] if x >= channels else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - channels] if x >= channels else 0
                b = prev[x]
                c = prev[x - channels] if x >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        out += line
        prev = line
    return (w, h, channels, out)


def pixel_stats(path):
    d = decode_png(path)
    if not d:
        return None
    w, h, ch, px = d
    # background = light theme body white; count pixels far from pure white
    nonwhite = 0
    for i in range(0, len(px), ch):
        r, g, b = px[i], px[i + 1], px[i + 2]
        if not (r >= 245 and g >= 245 and b >= 245):
            nonwhite += 1
    return {"w": w, "h": h, "nonwhite": nonwhite}


def main() -> int:
    browser = bs._find_browser()
    if not browser:
        print("PIXEL GATE SKIP: no renderable Chromium/Edge on this machine (CI stays green)")
        return 0

    work = tempfile.mkdtemp(prefix="closeout_pixel_")
    # Layer 1: jsdom writes the static snapshots
    fx = subprocess.run([NODE, FIXTURE, work], capture_output=True, text=True,
                        timeout=90, cwd=HERE)
    if "SNAPSHOTS_WRITTEN" not in (fx.stdout or ""):
        print("FAIL: fixture produced no snapshots\n" + (fx.stdout or "") + (fx.stderr or ""))
        return 1
    for line in (fx.stdout or "").splitlines():
        if line.startswith("jsdom"):
            print("  " + line)

    results = {}
    fails = []
    def run_scene(scene):
        # per-scene profile: Chromium locks ONE profile per process, so parallel scenes must
        # not share one (the same lesson that made each scene already use its own profile).
        profile = tempfile.mkdtemp(prefix="pxprof_")
        snap = os.path.join(work, "snap_%s.html" % scene)
        url = "file:///" + snap.replace("\\", "/")
        out, _ = bs._run_capture([browser, *bs.BASE_FLAGS, "--user-data-dir=" + profile,
                                  "--timeout=8000", "--dump-dom", url], timeout=45, cwd=HERE)
        m = re.search(r"<title>PROBE::(.*)</title>", out)
        probe = json.loads(m.group(1)) if m else None
        png = os.path.join(work, "snap_%s_shot.png" % scene)
        bs._run_capture([browser, *bs.BASE_FLAGS, "--user-data-dir=" + profile, "--timeout=8000",
                         "--window-size=900,500", "--hide-scrollbars",
                         "--screenshot=" + png, url], timeout=45, cwd=HERE)
        return scene, (probe, pixel_stats(png), png)

    # Auto-scale: workers = min(#scenes, cpu_count, cap). I/O-bound (waiting on child processes),
    # so the GIL is released and the cold launches truly overlap. With only 3 scenes the cap
    # never binds today -- it exists so a future scene increase scales up automatically.
    workers = max(1, min(len(SCENES), os.cpu_count() or 1, PARALLEL_CAP))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for scene, res in ex.map(run_scene, list(SCENES)):
            results[scene] = res

    # differential assertions (both sides of every boundary locked)
    for scene, (exp_box, exp_rem) in SCENES.items():
        probe, ps, png = results[scene]
        ok_probe = probe and probe.get("box_vis") == exp_box and probe.get("reminder") == exp_rem
        # pixel side: a VISIBLE scene must carry content; the HIDDEN control must be blank
        if exp_box == "VISIBLE":
            ok_px = ps and ps["nonwhite"] >= CONTENT_MIN
        else:
            ok_px = ps and ps["nonwhite"] <= BLANK_MAX
        label = "scene %s: probe(box=%s reminder=%s) pixels=%s" % (
            scene, probe.get("box_vis") if probe else "?", probe.get("reminder") if probe else "?",
            ("%dpx nonwhite" % ps["nonwhite"]) if ps else "UNDECODABLE")
        passed = ok_probe and ok_px
        print(("  OK   " if passed else "  FAIL ") + label)
        if not passed:
            fails.append(label)

    # write the success screenshots to the baseline archive anchor
    if not fails:
        os.makedirs(BASELINE, exist_ok=True)
        for scene in SCENES:
            _, _, png = results[scene]
            dest = os.path.join(BASELINE, "closeout_pixel_%s.png" % scene)
            shutil.copyfile(png, dest)
        print("  BASELINE: 3 success screenshots written to tools/baseline/ "
              "(closeout_pixel_A/C = reminder visible, closeout_pixel_B = blank control)")
        print("PIXEL GATE OK")
        return 0

    print("FAILURES:", len(fails))
    return 1


if __name__ == "__main__":
    sys.exit(main())
