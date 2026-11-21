"""Regression test for the browser MCP server (render / console / screenshot).

Pure standard library: it drives the browser MCP server over its stdio JSON-RPC protocol
exactly as the executor would, and asserts the three actions on a real HTML page:
  - render      -> the returned DOM contains a marker that ONLY appears after JS ran
                   (proves JS executed and mutated the DOM, not raw-text reading)
  - console     -> a marker emitted by console.log is captured
  - screenshot  -> a valid PNG file (magic bytes) is produced
  - Chinese     -> a Chinese string in the page survives the round-trip with no mojibake
                   (proves the UTF-8 wire encoding fix on the browser tool path)

It uses the server's own `_find_browser()` so it always exercises the SAME browser the
server will actually use. When no browser on this machine can render (e.g. a sandbox that
blocks every Chromium renderer), it skips cleanly (exit 0) instead of failing red. On a
normal machine — or anywhere playwright's chrome-headless-shell is available — the full
render/console/screenshot/Chinese assertions run for real.

Run standalone: python tests/test_browser.py
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVERS = os.path.join(HERE, "servers")
SERVER = os.path.join(SERVERS, "browser_server.py")
PY = sys.executable

sys.path.insert(0, SERVERS)
import browser_server  # noqa: E402  (gives us the real _find_browser detection)


def drive(target: str, out_path: str = None) -> list[str]:
    """Send initialize -> render -> console -> (screenshot) and collect responses.

    The server writes UTF-8 on the wire, so we read *bytes* and decode UTF-8 explicitly
    rather than relying on the locale (GBK here) — otherwise non-ASCII responses mojibake.
    """
    reqs = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
         "params": {"name": "render", "arguments": {"target": target}}},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
         "params": {"name": "console", "arguments": {"target": target}}},
    ]
    if out_path:
        reqs.append({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                     "params": {"name": "screenshot",
                                "arguments": {"target": target, "out": out_path}}})
    inp = "\n".join(json.dumps(r, ensure_ascii=False) for r in reqs) + "\n"
    proc = subprocess.Popen([PY, SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, cwd=HERE)
    out, _ = proc.communicate(inp.encode("utf-8"), timeout=120)
    raw = out.decode("utf-8", "replace")
    return [l for l in raw.splitlines() if l.strip()]


def _text_of(resp_line: str) -> str:
    msg = json.loads(resp_line)
    res = msg.get("result", {})
    return "\n".join(b.get("text", "") for b in res.get("content", []) if b.get("type") == "text")


def main() -> int:
    browser = browser_server._find_browser()
    if not browser:
        # A skip here used to hide a 100% dead tool: `_find_browser()` returned None because of
        # a missing `import time` in _run_capture, and this suite silently exited 0, so the
        # regression stayed "ALL GREEN" while browser_screenshot always failed. So: skip ONLY
        # when the machine genuinely has no Chromium/Edge binary; otherwise FAIL and say why.
        candidates = list(browser_server._candidate_browsers())
        if not candidates:
            print("BROWSER TEST SKIP: no Chromium/Edge binary on this machine "
                  "(set BROWSER_BINARY_PATH to a Chromium/Edge binary)")
            return 0
        print(f"BROWSER TEST FAIL: {len(candidates)} binary/binaries present but none rendered")
        for c in candidates:
            print(f"  candidate: {c}")
        for line in getattr(browser_server, "_PROBE_LOG", []):
            print(f"  probe: {line}")
        return 1
    print(f"BROWSER TEST: using {browser}")

    tmp = tempfile.mkdtemp(prefix="browser_test_")
    html = os.path.join(tmp, "page.html")
    with open(html, "w", encoding="utf-8") as f:
        f.write('<!doctype html><html><head><title>t</title></head><body>'
                '<div id="x">BEFORE</div>'
                '<span id="cn">中文渲染测试_OK</span>'
                '<script>console.log("CONSOLE_MARKER_JS_RAN");'
                'document.getElementById("x").innerText="RENDERED_BY_JS_MARKER";</script>'
                '</body></html>')
    url = "file:///" + html.replace("\\", "/")
    shot = os.path.join(tmp, "shot.png")

    # target normalisation: plain path, percent-encoded URL and double-escaped ("%%E6%%B8")
    # URL must all resolve to the real file — models hand us all three forms in practice.
    cn_page = os.path.join(tmp, "中文页面.html")
    with open(cn_page, "w", encoding="utf-8") as f:
        f.write("<!doctype html><html><body>cn</body></html>")
    import urllib.parse as _up
    plain = cn_page
    encoded = "file:///" + _up.quote(cn_page.replace("\\", "/"))
    double = encoded.replace("%", "%%")
    for form in (plain, encoded, double):
        resolved = browser_server._to_url(form)
        assert resolved.startswith("file:///"), f"_to_url broke {form!r}: {resolved!r}"
        assert os.path.exists(resolved[len("file:///"):]), \
            f"_to_url did not resolve {form!r} -> {resolved!r}"
    print("target  OK: plain / %-encoded / %%-escaped paths all resolve to the real file")

    lines = drive(url, out_path=shot)
    by_id = {}
    for l in lines:
        try:
            m = json.loads(l)
        except Exception:
            continue
        if "id" in m:
            by_id[m["id"]] = m

    # render (id 2): the post-JS DOM must contain the JS-only marker
    render_text = _text_of(json.dumps(by_id[2])) if 2 in by_id else ""
    assert "RENDERED_BY_JS_MARKER" in render_text, \
        f"render did not reflect JS execution: {render_text[:200]!r}"

    # Chinese round-trip: a Chinese string in the page must survive with no mojibake
    assert "中文渲染测试_OK" in render_text, \
        f"Chinese text did not survive the browser round-trip: {render_text[:200]!r}"

    # console (id 3): the console.log marker must be captured
    console_text = _text_of(json.dumps(by_id[3])) if 3 in by_id else ""
    assert "CONSOLE_MARKER_JS_RAN" in console_text, \
        f"console capture failed: {console_text[:200]!r}"

    # screenshot (id 4): a valid PNG (magic bytes) must exist
    assert 4 in by_id, "screenshot response missing"
    assert os.path.isfile(shot), "screenshot file not produced"
    with open(shot, "rb") as f:
        magic = f.read(8)
    assert magic == b"\x89PNG\r\n\x1a\n", f"not a valid PNG: {magic!r}"

    print("render  OK: post-JS DOM contains RENDERED_BY_JS_MARKER (JS ran)")
    print("chinese OK: 中文渲染测试_OK survived the round-trip (no mojibake)")
    print("console OK: captured CONSOLE_MARKER_JS_RAN")
    # 2026-10-18: the server must now RETURN the PNG as an image content block (multimodal path).
    import base64 as _b64
    shot_content = by_id[4].get("result", {}).get("content", [])
    img_blocks = [b for b in shot_content if b.get("type") == "image"]
    assert img_blocks, "screenshot returned no image content block (multimodal path broken)"
    _decoded = _b64.b64decode(img_blocks[0].get("data", ""))
    assert _decoded[:8] == b"\x89PNG\r\n\x1a\n", "image block is not a valid PNG"
    assert img_blocks[0].get("mimeType") == "image/png", "image block mimeType is not image/png"
    txt_blocks = [b for b in shot_content if b.get("type") == "text"]
    assert any("saved" in b.get("text", "") for b in txt_blocks), "screenshot lost its saved-path text block"
    print("image-block OK: screenshot returns [text, image(png-base64)] for a vision model")
    print(f"screenshot OK: valid PNG ({os.path.getsize(shot)} bytes)")

    # 2026-10-20 fix: a page with a PERPETUAL requestAnimationFrame loop used to hang
    # --screenshot forever (--virtual-time-budget never terminates; virtual time can never
    # reach the budget because every frame reschedules another frame), surfacing as
    # "error: browser timed out (msedge.exe)" after the 60s subprocess kill. Capture now
    # uses --timeout for local files, so all three actions must finish in a few seconds.
    raf_html = os.path.join(tmp, "raf.html")
    with open(raf_html, "w", encoding="utf-8") as f:
        f.write('<!doctype html><html><body><canvas id="c" width="300" height="200"></canvas>'
                '<script>var n=0;function frame(){n++;var x=document.getElementById("c")'
                '.getContext("2d");x.fillStyle="hsl("+(n%360)+",70%,50%)";'
                'x.fillRect(0,0,300,200);requestAnimationFrame(frame);}'
                'requestAnimationFrame(frame);</script></body></html>')
    raf_url = "file:///" + raf_html.replace("\\", "/")
    raf_shot = os.path.join(tmp, "raf.png")
    t0 = time.monotonic()
    raf_lines = drive(raf_url, out_path=raf_shot)
    raf_elapsed = time.monotonic() - t0
    raf_by_id = {}
    for l in raf_lines:
        try:
            m = json.loads(l)
        except Exception:
            continue
        if "id" in m:
            raf_by_id[m["id"]] = m
    for rid, nm in ((2, "render"), (3, "console"), (4, "screenshot")):
        txt = _text_of(json.dumps(raf_by_id[rid])) if rid in raf_by_id else ""
        assert "timed out" not in txt.lower(), \
            f"perpetual-rAF {nm} timed out (hang not fixed): {txt[:200]!r}"
        assert rid in raf_by_id, f"perpetual-rAF {nm} produced no response"
    assert os.path.isfile(raf_shot), "perpetual-rAF screenshot not produced"
    with open(raf_shot, "rb") as f:
        assert f.read(8) == b"\x89PNG\r\n\x1a\n", "perpetual-rAF screenshot is not a valid PNG"
    assert raf_elapsed < 40, \
        f"perpetual-rAF page took {raf_elapsed:.1f}s — hang is not fixed (expected a few seconds)"
    print(f"raf     OK: perpetual-rAF page captured in {raf_elapsed:.1f}s (no hang)")
    print("BROWSER TEST OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
