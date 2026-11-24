#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Static cross-file lock: every range slider in index.html must be wired to outputs().

ROOT-CAUSE (2026-11-24): dragging 柱状图显示上限 (s-sparkmax) did not move its displayed value.
outputs() DOES set $("o-sparkmax").textContent, but it only runs on oninput -- and the
`for (const id of [...]) $(id).oninput = outputs;` whitelist at app.js listed 10 sliders while
index.html ships 11 range inputs; s-sparkmax was the one left out. So its output stayed frozen
until 应用 (apply) redrew the drawer.

This gate reads the TWO SHIPPED files and cross-checks them:
  G1 every range-slider id in index.html is in the oninput=outputs whitelist (the actual bug);
  G2 the whitelist binds no id lacking a real slider (typo/stale guard);
  G3 every bound slider's value is actually read inside the outputs() body -- so a slider cannot
     be bound yet still show nothing (a half-fix where oninput fires but outputs() never updates);
  G4 DECOY differential strips the just-fixed s-sparkmax from a copy of the whitelist and proves
     the G1 subset check is load-bearing (it re-exposes the gap), not decorative.

Pure stdlib; reads shipped files only. No network, no browser.
"""
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, os.pardir, "serve", "web")
INDEX = os.path.join(WEB, "index.html")
APPJS = os.path.join(WEB, "app.js")


def read(p):
    with io.open(p, "rb") as f:
        return f.read().decode("utf-8", "replace")


def slider_ids(index_src):
    """Every range-input id actually shipped."""
    ids = set()
    for m in re.finditer(r'<input\b[^>]*type="range"[^>]*>', index_src):
        idm = re.search(r'id="([^"]+)"', m.group(0))
        if idm:
            ids.add(idm.group(1))
    return ids


def bound_ids(app_src):
    """Ids listed in the `for (const id of [ ... ]) $(id).oninput = outputs;` whitelist."""
    m = re.search(r'for \(const id of \[(.*?)\]\) \$\(id\)\.oninput = outputs;', app_src)
    return set(re.findall(r'"([^"]+)"', m.group(1))) if m else None


def outputs_body(app_src):
    """Extract the `function outputs() { ... }` body via brace matching (string-agnostic: the
    body has no unbalanced braces inside string/regex here, verified by the matched length)."""
    m = re.search(r'function outputs\(\)\s*\{', app_src)
    if not m:
        return None
    i = m.end() - 1  # at the opening {
    depth = 0
    while i < len(app_src):
        c = app_src[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return app_src[m.end():i]
        i += 1
    return None


fails = []
index_src = read(INDEX)
app_src = read(APPJS)

sliders = slider_ids(index_src)
binds = bound_ids(app_src)
body = outputs_body(app_src)

# G0: anchors present (refactor renaming the loop / outputs -> caught here, not silently vacuous)
if not sliders:
    fails.append("G0 no range sliders parsed from index.html (anchor drift?)")
if binds is None:
    fails.append("G0 outputs-binding whitelist loop not found in app.js (anchor drift?)")
if body is None:
    fails.append("G0 outputs() function body not found in app.js (anchor drift?)")

if sliders and binds is not None and body is not None:
    missing = sorted(sliders - binds)
    if missing:
        fails.append("G1 sliders shipped but NOT bound to outputs() (display won't follow drag): %s" % missing)

    stale = sorted(binds - sliders)
    if stale:
        fails.append("G2 whitelist binds ids with no matching range slider (typo/stale): %s" % stale)

    # G3: a bound slider's value must be referenced somewhere inside outputs() body, so binding
    #     is never a no-op. We accept the $(sid).value reference itself (it appears in outputs()).
    unref = [sid for sid in sorted(binds) if ('$("%s")' % sid) not in body]
    if unref:
        fails.append("G3 bound but outputs() body never references its slider (binding is a no-op): %s" % unref)

    # G4 DECOY differential: strip the just-fixed id -> G1 must re-expose the gap.
    if "s-sparkmax" in binds:
        stripped = binds - {"s-sparkmax"}
        if "s-sparkmax" not in sorted(sliders - stripped):
            fails.append("G4 decoy failed: stripping s-sparkmax did NOT re-expose it -> G1 check decorative")
    else:
        fails.append("G4 precondition unmet: s-sparkmax not in whitelist (fix missing?)")

if fails:
    for f in fails:
        print("FAIL " + f)
    print("\n%d check(s) failed" % len(fails))
    sys.exit(1)

print("SLIDER-OUTPUT-BINDING-LOCK: ALL GREEN  (sliders=%d bound=%d whitelist==sliders; each bound "
      "slider is referenced inside outputs(); decoy strips s-sparkmax and G1 flips)"
      % (len(sliders), len(binds)))
