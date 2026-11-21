# -*- coding: utf-8 -*-
r"""Real-browser E2E gate for the auto-verify-fix loop (2026-11-13 固化).

What it locks (the DOM wiring + click-path that test_autoverify_fix.mjs cannot cover):
  The push button's REAL click path (delegation handler -> pushBugFix) records pendingFixTs,
  marks fixing, sends the fix task. A subsequent green test turn consumes pendingFixTs onto
  that turn, and maybeAutoVerifyFix ejects from the box. This gate verifies via REAL headless
  Chromium (--dump-dom) that the full click-to-eject chain works end-to-end with the live DOM.

Method (same pattern as test_visual_http_render.py — page MUST sit at the doc-root):
  1. Build a harness page = copy of the real index.html with an appended harness <script> that:
     a) seeds a single open bug into localStorage, renders the box,
     b) stubs send()/postQuiet() to record calls (no wire hit),
     c) performs the REAL DOM click on the push button,
     d) simulates the consume step (streamAssistant moving pendingFixTs onto the turn),
     e) calls maybeAutoVerifyFix with a green test,
     f) writes assertion results into the page title.
  2. Serves at the DOC-ROOT (the harness sits alongside web/, NOT inside it) so relative srcs
     `web/i18n.js`, `web/app.js`, `web/admin.js` resolve. This is the same lesson that
     test_visual_http_render.py locks: a page UNDER web/ resolves web/tokens.css to
     web/web/tokens.css = 404.
  3. Runs the real headless browser via browser_server._find_browser() + _run_capture(--dump-dom).
  4. Parses the title from the rendered DOM, checks all assertions PASS.

Differential: harness's CONTROL section flips settings.autoVerifyFix OFF and verifies the bug
  STAYS (proving the switch is load-bearing and the gate is not decorative).

On a machine with no renderable browser, skips cleanly (exit 0).

Run standalone: python tests/test_autoverify_fix_realpage.py
"""
from __future__ import annotations

import http.server
import os
import re
import shutil
import socket
import socketserver
import sys
import tempfile
import threading
import time
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "servers"))
import browser_server as bs  # noqa: E402

WEB = os.path.join(HERE, "serve", "web")
SERVE = os.path.join(HERE, "serve")   # docroot: web/ is a child of this
FAILURES = []


def check(label, cond):
    print("  " + ("OK   " if cond else "FAIL ") + label)
    if not cond:
        FAILURES.append(label)


# Harness runs AFTER all page scripts loaded (same realm, top-level function/let visible).
HARNESS_SCRIPT = r"""
<script>
(function(){
  var out = [];
  function R(label, cond, extra){ out.push((cond?'PASS':'FAIL')+' :: '+label+(extra?(' ['+extra+']'):'')); }
  function readPending(){ try { return eval('pendingFixTs'); } catch(e){ return '<no-bind>'; } }
  function writePendingNull(){ try { eval('pendingFixTs = null'); return true; } catch(e){ return false; } }
  function box(){ return JSON.parse(localStorage.getItem('strata.bugBox')||'[]'); }
  try {
    // Seed one open bug so the push button renders
    localStorage.setItem('strata.bugBox', JSON.stringify([{ts:1700000000001,status:'open',msg:'e2e-real',stack:'stack',sourceTab:'debug',kind:'bug:window.onerror'}]));
    if (typeof renderBugBox === 'function') renderBugBox();
    var btn = document.querySelector('[data-bugact="push"]');
    R('push button rendered in real DOM', !!btn);

    // Stub network legs (record calls, no wire hit)
    var sendCalls = [];
    var realSend = window.send; window.send = function(h){ sendCalls.push(ceText(document.getElementById('input'))); };
    var pqUrls = [];
    var realPQ = window.postQuiet; window.postQuiet = function(url, body){ pqUrls.push(url); };

    // REAL DOM CLICK on the push button (tests the delegation handler wiring)
    if (btn) btn.click();
    R('click: exactly one send fired', sendCalls.length===1);
    R('click: prompt carries the bug msg', !!(sendCalls[0] && sendCalls[0].indexOf('e2e-real')>=0));
    R('click: record marked fixing', box()[0] && box()[0].status==='fixing');
    R('click: pendingFixTs recorded = the bug ts', readPending()===1700000000001);

    // Lock the classifier input (pytest hits TEST_RE, result shape is green)
    var shape = {server:'shell',name:'shell__exec',arguments:'pytest tests/test_e2e.py',result:'7 passed in 0.12s',ok:true};
    var cc = (typeof classifyTool==='function') ? classifyTool(shape) : null;
    R('classifyTool reads green shape as test+ok', !!(cc && cc.kind==='test' && cc.ok===true), JSON.stringify(cc));

    // Consume: streamAssistant moves pendingFixTs onto the turn
    var m = {role:'assistant',text:'',reasoning:'',tools:[shape]};
    var p = readPending();
    if (p){ m._fixBugTs = p; writePendingNull(); }
    R('consume moved onto turn as _fixBugTs', m._fixBugTs===1700000000001);
    R('consume cleared one-shot (null)', readPending()===null);

    // MAIN: green gate -> ejection
    settings.autoVerifyFix = true;
    if (typeof maybeAutoVerifyFix==='function') maybeAutoVerifyFix(m);
    R('GREEN gate: bug EJECTED from box', box().length===0);

    // CONTROL switch-OFF: green test on a pushed fix must STAY fixing
    localStorage.setItem('strata.bugBox', JSON.stringify([{ts:1700000000002,status:'fixing',msg:'ctrl',stack:'s',sourceTab:'debug',kind:'bug:x'}]));
    settings.autoVerifyFix = false;
    if (typeof maybeAutoVerifyFix==='function') maybeAutoVerifyFix({_fixBugTs:1700000000002, tools:[{server:'shell',name:'shell__exec',arguments:'pytest tests/test_x.py',result:'7 passed in 0.12s',ok:true}]});
    R('CONTROL switch-OFF -> stays fixing, NOT ejected', box().length===1 && box()[0].status==='fixing');

    // CONTROL no-push-turn (no _fixBugTs): green test -> no-op
    localStorage.setItem('strata.bugBox', JSON.stringify([{ts:1700000000003,status:'fixing',msg:'ctrl2',stack:'s',sourceTab:'debug',kind:'bug:x'}]));
    settings.autoVerifyFix = true;
    if (typeof maybeAutoVerifyFix==='function') maybeAutoVerifyFix({tools:[{server:'shell',name:'shell__exec',arguments:'pytest tests/test_x.py',result:'7 passed in 0.12s',ok:true}]});
    R('CONTROL no-push-turn -> stays fixing, NOT ejected', box().length===1 && box()[0].status==='fixing');

    localStorage.removeItem('strata.bugBox');
    window.send = realSend; window.postQuiet = realPQ;

    var allpass = out.every(function(x){return x.indexOf('PASS')===0;});
    document.title = (allpass ? 'E2E ALL PASS' : 'E2E SOME FAIL') + ' :: ' + out.join(' || ');
  } catch(e){
    document.title = 'HARNESS-ERROR :: ' + e.message;
  }
})();
</script>
"""


def start_http(docroot):
    """Start an http.server on a free port serving the docroot."""
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=docroot, **kw)
        def log_message(self, *a):
            pass

    probe = socket.socket(); probe.bind(("127.0.0.1", 0)); port = probe.getsockname()[1]; probe.close()
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", port), H)
    th = threading.Thread(target=httpd.serve_forever, daemon=True); th.start()
    url = "http://127.0.0.1:%d/" % port
    for _ in range(50):
        try:
            urllib.request.urlopen(url, timeout=2); break
        except Exception:
            time.sleep(0.1)
    return httpd, port


def build_harness(dest_dir):
    """Copy index.html from serve/web/, inject harness script before </body>, write to dest_dir/."""
    src = open(os.path.join(WEB, "index.html"), encoding="utf-8").read()
    harness_html = src.replace("</body>", HARNESS_SCRIPT + "</body>")
    assert harness_html != src and "E2E ALL PASS" in harness_html
    p = os.path.join(dest_dir, "harness.html")
    open(p, "w", encoding="utf-8", newline="").write(harness_html)
    return p


def parse_title(dom_text):
    """Extract <title> content from rendered DOM."""
    m = re.search(r"<title[^>]*>(.*?)</title>", dom_text, re.I)
    return m.group(1) if m else ""


def main() -> int:
    browser = bs._find_browser()
    if not browser:
        print("REALPAGE E2E SKIP: no renderable browser (CI stays green)")
        return 0

    work = tempfile.mkdtemp(prefix="realpage_")
    profile = tempfile.mkdtemp(prefix="realprof_")

    # docroot = a temp dir containing:
    #   harness.html  (the page itself, sits at root)
    #   web/          (symlink or copy of serve/web/ so srcs web/app.js resolve)
    # We use a copy to avoid symlink issues on Windows.
    web_copy = os.path.join(work, "web")
    # Only copy what the page loads: i18n.js, app.js, admin.js, tokens.css, components.css, app.css, favicon.svg, sprite.svg, img/
    # Faster than full copy and sufficient for the harness.
    os.makedirs(web_copy, exist_ok=True)
    for fname in ["i18n.js", "app.js", "admin.js", "tokens.css", "components.css", "app.css"]:
        src_f = os.path.join(WEB, fname)
        if os.path.isfile(src_f):
            shutil.copy2(src_f, os.path.join(web_copy, fname))
    for dname in ["img"]:
        src_d = os.path.join(WEB, dname)
        if os.path.isdir(src_d):
            shutil.copytree(src_d, os.path.join(web_copy, dname))
    # Also copy sprite.svg and favicon.svg
    for fname in ["sprite.svg", "favicon.svg"]:
        src_f = os.path.join(WEB, fname)
        if os.path.isfile(src_f):
            shutil.copy2(src_f, os.path.join(web_copy, fname))

    # harness at doc-root (NOT inside web/), so srcs="web/app.js" resolves correctly
    src_html = open(os.path.join(WEB, "index.html"), encoding="utf-8").read()
    harness_html = src_html.replace("</body>", HARNESS_SCRIPT + "</body>")
    harness_path = os.path.join(work, "harness.html")
    open(harness_path, "w", encoding="utf-8", newline="").write(harness_html)

    httpd, port = start_http(work)
    try:
        url = "http://127.0.0.1:%d/harness.html" % port
        args = [browser, *bs.BASE_FLAGS, f"--user-data-dir={profile}",
                f"--virtual-time-budget=4000", "--dump-dom", url]
        dom, err = bs._run_capture(args, timeout=30, cwd=HERE)
        title = parse_title(dom)

        if not title:
            check("title extracted from DOM", False, "empty")
            check("DOM contains app.js markers", "data-tab" in dom or "composer" in dom, dom[:200])
        else:
            # Title format: "E2E ALL PASS :: PASS :: label1 || PASS :: label2 || ..."
            # Split header from assertion block on first " :: ", then split assertions on " || ".
            head, sep, block = title.partition(" :: ")
            if not sep or not block:
                check("title has assertion data", False, repr(title[:200]))
            else:
                for a in block.split(" || "):
                    a = a.strip()
                    if not a:
                        continue
                    label = a.split(" :: ", 1)[1] if " :: " in a else a
                    check(label, a.startswith("PASS"))
                check("overall header says ALL PASS", head == "E2E ALL PASS")

    finally:
        httpd.shutdown()
        httpd.server_close()
        shutil.rmtree(work, ignore_errors=True)
        shutil.rmtree(profile, ignore_errors=True)

    print("")
    if FAILURES:
        print(f"REALPAGE E2E: {len(FAILURES)} FAILURES")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    else:
        print("REALPAGE E2E: ALL PASS")
        return 0


if __name__ == "__main__":
    sys.exit(main())
