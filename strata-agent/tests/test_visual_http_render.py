# -*- coding: utf-8 -*-
r"""Pixel gate for the http:// real-render method (固化 2026-11 视觉验证根因).

Root cause it locks (measured, not assumed): a Strata front-end verification page must sit at
the SERVE ROOT (a sibling of web/). A page placed UNDER serve/web/ resolves its relative CSS
`web/tokens.css` to serve/web/web/tokens.css -> 404 -> no styling -> the black-screenshot class
of untrustworthiness (exactly what a file:// / wrong-dir screenshot showed this round). The
file:// / wrong-dir method is therefore UNRELIABLE for visual verification; this gate proves the
http:// + correct-doc-root method CATCHES that failure as a pixel differential.

Differential (single variable = the page's directory; the two fixture pages are BYTE-IDENTICAL,
both linking the same relative `web/tokens.css`):
  GOOD  page at the doc-root         -> web/tokens.css RESOLVES  -> the CSS-variable block paints
                                         -> >= CONTENT_MIN non-background pixels
  BAD   the SAME page under web/     -> web/web/tokens.css = 404 -> no styling, block invisible
                                         -> <= BLANK_MAX non-background pixels

Load-bearing proof: the block colour comes from var(--st-accent, transparent), a value defined
ONLY inside tokens.css. Remove the <link> and GOOD turns black too (that is why this is a real
differential, not decoration) -- locked by the third scene.

Method is REAL: a stdlib http.server serves the temp doc-root (so relative CSS can actually
resolve -- the whole point), headless Edge --screenshot captures PNGs, and the SAME pure-stdlib
PNG decoder as test_closeout_pixel.py counts non-background pixels. On a machine with no
renderable browser the gate SKIPS (exit 0) so CI stays deterministic.

Run standalone: python tests/test_visual_http_render.py
"""
from __future__ import annotations

import http.server
import os
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

import test_closeout_pixel as cp   # reuse the pure-stdlib PNG decoder + pixel_stats

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "servers"))
import browser_server as bs  # noqa: E402  (same _find_browser / _run_capture the sibling gate uses)

REAL_TOKENS = os.path.join(HERE, "serve", "web", "tokens.css")
# The REAL front-end page (the anchor item this scene is named for). It is a dark
# FULL-PAGE app, so the family's original white-background probe model saturates on it;
# the load-bearing differential on the real page is the doc-root-CSS-resolves contrast
# (measured 2026-11-14: GOOD=156000, CSS-404=84764, link-stripped=10101 px).
REAL_INDEX = os.path.join(HERE, "serve", "web", "index.html")

# The fixture links the RELATIVE stylesheet exactly like the real front-end page does. The
# block's colour is a CSS variable defined ONLY in tokens.css -> the link is load-bearing.
FIXTURE = """<!doctype html>
<html lang="zh" data-theme="dark">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="web/tokens.css">
<style>html,body{margin:0;height:100%;background:#ffffff}
#probe{position:absolute;left:20px;top:20px;width:220px;height:220px;
       background:var(--st-accent,transparent)}
</style>
</head>
<body><div id="probe"></div></body>
</html>
"""

# pixel thresholds: a painted 220x220 accent block is >>CONTENT_MIN; an unstylished page is ~0.
CONTENT_MIN = 8000      # 220*220 = 48400 fully-painted pixels when the CSS variable resolves
BLANK_MAX = 200         # white page with a transparent block -> essentially background

# Real-index thresholds (MEASURED on this machine 2026-11-14, not guessed). The real
# page paints the full dark canvas at the correct doc-root; a CSS 404 (page under web/)
# collapses the accent styling; pointing the tokens <link> at a missing file collapses it
# further. Wide margins so the gate is robust to font/anti-alias drift while the
# differential holds. Thresholds below are the MEASURED numbers (probe3) with margin.
REAL_CONTENT_MIN  = 130000   # GOOD measured 156000 (full 520x300 painted)
REAL_COLLAPSE_MAX = 110000   # BAD measured 84764 (CSS 404 -> must stay under GOOD)
REAL_LOADBEAR_MAX = 40000    # link->missing measured 10101 -> proves the link is load-bearing


def start_http(docroot):
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=docroot, **kw)
        def log_message(self, *a):   # silence request logging
            pass

    # bind a free port deterministically (probe :0 then rebind) so parallel CI runs never collide
    probe = socket.socket(); probe.bind(("127.0.0.1", 0)); port = probe.getsockname()[1]; probe.close()
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", port), H)
    th = threading.Thread(target=httpd.serve_forever, daemon=True); th.start()
    # wait until the server actually answers (deterministic, no blind sleep-then-hope races)
    url = "http://127.0.0.1:%d/" % port
    for _ in range(50):
        try:
            urllib.request.urlopen(url, timeout=2); break
        except Exception:
            time.sleep(0.1)
    return httpd, port


def shoot(browser, profile, url, png):
    bs._run_capture([browser, *bs.BASE_FLAGS, "--user-data-dir=" + profile, "--timeout=8000",
                     "--window-size=520,300", "--hide-scrollbars", "--screenshot=" + png, url],
                    timeout=45, cwd=HERE)
    return cp.pixel_stats(png)


def main() -> int:
    browser = bs._find_browser()
    if not browser:
        print("PIXEL GATE SKIP: no renderable Chromium/Edge on this machine (CI stays green)")
        return 0
    if not os.path.exists(REAL_TOKENS):
        print("FAIL: serve/web/tokens.css not found (fixture source missing):", REAL_TOKENS)
        return 1

    work = tempfile.mkdtemp(prefix="vishttp_")
    web = os.path.join(work, "web")
    os.makedirs(web, exist_ok=True)
    # tokens.css is COPIED from the REAL file: the gate measures the same token source the app uses.
    shutil.copyfile(REAL_TOKENS, os.path.join(web, "tokens.css"))
    # BYTE-IDENTICAL fixtures -- the single variable is the page's directory (root vs under web/).
    for sub, name in (("", "good.html"), (web, "bad.html")):
        p = os.path.join(sub, name) if sub else os.path.join(work, name)
        open(p, "w", encoding="utf-8").write(FIXTURE)
    assert os.path.getsize(os.path.join(work, "good.html")) == os.path.getsize(os.path.join(web, "bad.html"))

    httpd, port = start_http(work)
    base = "http://127.0.0.1:%d" % port
    try:
        profile = tempfile.mkdtemp(prefix="visprof_")
        good = shoot(browser, profile, base + "/good.html", os.path.join(work, "good.png"))
        bad = shoot(browser, profile, base + "/web/bad.html", os.path.join(work, "bad.png"))
    finally:
        httpd.shutdown(); httpd.server_close()

    fails = []
    # load-bearing probe: also shoot the GOOD page with the <link> stripped (variable -> transparent)
    noline = FIXTURE.replace('<link rel="stylesheet" href="web/tokens.css">', "")
    noline_path = os.path.join(work, "noline.html")
    open(noline_path, "w", encoding="utf-8").write(noline)
    httpd2, port2 = start_http(work)
    try:
        profile2 = tempfile.mkdtemp(prefix="visprof2_")
        nolink = shoot(browser, profile2, "http://127.0.0.1:%d/noline.html" % port2,
                       os.path.join(work, "noline.png"))
    finally:
        httpd2.shutdown(); httpd2.server_close()

    def report(label, stats, ok):
        px = ("%dpx nonwhite" % stats["nonwhite"]) if stats else "UNDECODABLE"
        print(("  OK   " if ok else "  FAIL ") + label + "  " + px)
        if not ok:
            fails.append(label)

    ok_good = good and good["nonwhite"] >= CONTENT_MIN
    ok_bad = bad and bad["nonwhite"] <= BLANK_MAX
    ok_nolink = nolink and nolink["nonwhite"] <= BLANK_MAX

    # ---- REAL index.html#images scenes (the doc-root anchor this family is named for) ----
    # Same method, real page. Single variable = the page directory; the two real-index
    # fixtures are BYTE-IDENTICAL copies of the real index. A load-bearing third scene
    # points the tokens <link> at a missing file; on the real dark page that collapses the
    # accent styling (the dark background itself comes from tokens.css), proving the link
    # is load-bearing -- not decoration. Thresholds are the MEASURED numbers above.
    if os.path.exists(REAL_INDEX):
        # the real page links the FULL asset set; stage it all into this temp doc-root so
        # GOOD resolves everything and the ONLY variable is the one each scene changes
        # (the page directory, or which <link> is broken). Mirrors probe3 topology (MEASURED
        # thresholds 130000/110000/40000 come from THIS full staging).
        web_src = os.path.join(HERE, "serve", "web")
        for _a in ("tokens.css", "components.css", "app.css", "i18n.js", "app.js", "admin.js", "sprite.svg"):
            _s = os.path.join(web_src, _a)
            if os.path.isfile(_s):
                shutil.copyfile(_s, os.path.join(web, _a))
        src = open(REAL_INDEX, encoding="utf-8").read()
        # GOOD: the real index AT the doc-root served here (#images anchor resolves CSS)
        shutil.copyfile(REAL_INDEX, os.path.join(work, "real_good.html"))
        # BAD: the SAME real index placed UNDER web/ (relative CSS -> web/web/ = 404)
        shutil.copyfile(REAL_INDEX, os.path.join(web, "real_bad.html"))
        assert os.path.getsize(os.path.join(work, "real_good.html")) == \
            os.path.getsize(os.path.join(web, "real_bad.html"))
        # LOAD-BEARING: doc-root page with the tokens <link> pointed at a missing file
        noline_real = src.replace(
            '<link rel="stylesheet" href="web/tokens.css">',
            '<link rel="stylesheet" href="web/_MISSING_pixel_probe.css">')
        assert noline_real != src, "tokens link not found in real index (anchor drift)"
        open(os.path.join(work, "real_nolink.html"), "w", encoding="utf-8").write(noline_real)
        httpdR, portR = start_http(work)
        try:
            profR = tempfile.mkdtemp(prefix="visprofR_")
            baseR = "http://127.0.0.1:%d" % portR
            rg = shoot(browser, profR, baseR + "/real_good.html#images",
                       os.path.join(work, "real_good.png"))
            rb = shoot(browser, profR, baseR + "/web/real_bad.html#images",
                       os.path.join(work, "real_bad.png"))
            rn = shoot(browser, profR, baseR + "/real_nolink.html#images",
                       os.path.join(work, "real_nolink.png"))
        finally:
            httpdR.shutdown(); httpdR.server_close()
        ok_rg = rg and rg["nonwhite"] >= REAL_CONTENT_MIN
        ok_rb = rb and rb["nonwhite"] <= REAL_COLLAPSE_MAX and (
            not rg or rb["nonwhite"] < rg["nonwhite"])   # differential direction: BAD < GOOD
        ok_rn = rn and rn["nonwhite"] <= REAL_LOADBEAR_MAX
        report("REAL-GOOD (real index at doc-root, CSS resolves, #images) >= %d" % REAL_CONTENT_MIN, rg, ok_rg)
        report("REAL-BAD  (same real index under web/, CSS 404 -> collapse) <= %d" % REAL_COLLAPSE_MAX, rb, ok_rb)
        report("REAL-LOADBEARING (tokens link -> missing file) <= %d" % REAL_LOADBEAR_MAX, rn, ok_rn)
        if not fails:
            for tag in ("real_good", "real_bad", "real_nolink"):
                shutil.copyfile(os.path.join(work, tag + ".png"),
                             os.path.join(HERE, "tools", "baseline", "visual_http_%s.png" % tag))
            print("  BASELINE: real-index scenes archived (good=painted, bad=404, nolink=stripped)")

    report("GOOD (served at doc-root, relative CSS resolves) >= %d" % CONTENT_MIN, good, ok_good)
    report("BAD  (same page under web/, CSS 404 -> black) <= %d" % BLANK_MAX, bad, ok_bad)
    report("LOAD-BEARING (link stripped -> variable transparent) <= %d" % BLANK_MAX, nolink, ok_nolink)

    if not fails:
        os.makedirs(os.path.join(HERE, "tools", "baseline"), exist_ok=True)
        for tag in ("good", "bad", "noline"):
            shutil.copyfile(os.path.join(work, tag + ".png"),
                            os.path.join(HERE, "tools", "baseline", "visual_http_%s.png" % tag))
        print("  BASELINE: 3 success screenshots archived (good=painted, bad/noline=blank control)")
        print("VISUAL-HTTP GATE OK")
    else:
        print("FAILURES:", len(fails))

    shutil.rmtree(work, ignore_errors=True)
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
