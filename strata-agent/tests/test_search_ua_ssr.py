r"""Contract gate: websearch SEARCH channel must use a command-line UA that triggers
Bing's server-side render (2026-11).

Root cause it locks (measured, not assumed): urllib fetches Bing with a "modern browser"
UA (Mozilla/5.0) and Bing returns a JS-only SPA shell (results filled by front-end JS, so
the DOM carries NO <h2><a href=...> / b_algo node). urllib does NOT run JS, so the parser
sees nothing -> "Chinese query looks polluted / returns nothing". The English long-query
only sometimes worked because it happened to hit an SSR edge node. Sending a command-line
tool UA (curl/...) makes Bing return the SSR page, and the Chinese query resolves to real
results (baike / zhihu / etc). The DOWNLOAD channel keeps the browser UA on purpose (image
CDNs check Referer for hot-linking) -- so UA is deliberately split per channel.

Two-layer lock, no network:
  LAYER 1 static source locks -- the search channel (_fetch) references _SSR_UA; _SSR_UA is
          a command-line UA (curl, no Mozilla); the download channel (_fetch_bytes) keeps the
          browser UA (_UA). The split is the design.
  LAYER 2 behaviour differential --
          (2a) parser: an SPA-shell HTML (no <h2><a href>) yields ZERO results from the REAL
               _parse_bing; the equivalent SSR HTML (with it) yields >=1. This reproduces the
               pollution symptom and proves the parser is NOT the bug -- the UA (which decides
               which page Bing returns) is what is load-bearing.
          (2b) real call path: with build_opener monkeypatched to RECORD the outgoing request
               UA, call_tool("search") emits _SSR_UA; flipping _SSR_UA to a control value
               moves the emitted UA with it -> that line is load-bearing, not decorative.
               NOTE on reading the UA back (measured): urllib stores Request(headers=...) keys
               title-cased, so the dict key is "User-agent" and BOTH get_header("User-Agent")
               and headers.get("User-Agent") return None -- read it as headers.get("User-agent").

Run: python tests/test_search_ua_ssr.py
"""
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "servers"))
import websearch_server as W  # noqa: E402

FAILURES = []
def check(label, cond, extra=""):
    print(("  OK   " if cond else "  FAIL ") + label + (("  " + extra) if extra else ""))
    if not cond:
        FAILURES.append(label)

SRC = open(os.path.join(ROOT, "servers", "websearch_server.py"), encoding="utf-8").read()

# ── LAYER 1: static source locks ───────────────────────────────────────────
print("=== 1: static source locks (UA split is the design) ===")

# search channel (_fetch) must reference _SSR_UA, not a literal browser UA
fetch_line = next((l for l in SRC.splitlines() if "urllib.request.Request(url" in l), "")
check("L1a _fetch (search channel) uses _SSR_UA", "_SSR_UA" in fetch_line)
check("L1b _fetch no longer hard-codes the browser UA literal", "Mozilla/5.0" not in fetch_line)

# the SSR UA must be a command-line tool UA that triggers Bing SSR (curl, NOT a browser UA)
check("L1c _SSR_UA is defined as a curl/command-line UA (no 'Mozilla')",
      bool(__import__("re").search(r'_SSR_UA\s*=\s*"[^"]*curl[^"]*"', SRC)) and
      not __import__("re").search(r'_SSR_UA\s*=\s*"[^"]*Mozilla', SRC))

# download channel keeps the browser UA on purpose (CDN Referer anti-hotlink). This is a
# DELIBERATE split -- locking it prevents someone "unifying" the UA and silently
# re-introducing the pollution AND breaking image downloads.
check("L1d download _UA stays the browser UA", '_UA = "Mozilla/5.0"' in SRC)
check("L1e _fetch_bytes (download) references _UA, not _SSR_UA",
      '"User-Agent": _UA' in SRC)

# ── LAYER 2a: parser differential (reproduces the pollution symptom) ────────
print("\n=== 2a: parser differential (parser is NOT the bug; the UA-decided page is) ===")

# What Bing returns for a modern-browser UA: JS-only SPA shell -- NO server result node.
SPA_SHELL = ('<div id="b_content" style="visibility:hidden">'
             '<script>window._G={Region:"CN"}</script></div>')
# What Bing returns for a command-line UA: SSR with the result anchors the regex needs.
SSR_PAGE = ('<ol id="b_results"><li class="b_algo"><h2 class="b_til">'
            '<a href="https://baike.baidu.com/item/baize" h="ID">baize encyclopedia</a></h2>'
            '<div class="b_lineclamp">the white beast of Chinese myth</div></li></ol>')

shell_res, shell_snip = W._parse_bing(SPA_SHELL)
ssr_res, ssr_snip = W._parse_bing(SSR_PAGE)
check("L2a-i SPA-shell HTML -> ZERO parse results (reproduces the 'pollution/empty' symptom)",
      len(shell_res) == 0)
check("L2a-ii SSR HTML -> >=1 parse result (the regex fires on the real SSR node)",
      len(ssr_res) >= 1)
# differential is load-bearing: same parser, only the page shape differs.
check("L2a-iii the parser CAN resolve the SSR page it could not resolve for the shell",
      len(ssr_res) > len(shell_res))

# ── LAYER 2b: real call path emits the SSR UA; flipping it moves the emitted UA ──
print("\n=== 2b: real call path emits _SSR_UA (the line is load-bearing) ===")

captured = {}
class _FakeResp:
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def read(self): return SSR_PAGE.encode("utf-8")
class _FakeOpener:
    def open(self, req, timeout=None):
        # urllib stores Request(headers=...) keys title-cased -> the dict key is "User-agent"
        # (get_header("User-Agent") / headers.get("User-Agent") both return None, measured).
        captured["ua"] = dict(req.headers).get("User-agent")
        return _FakeResp()

_orig_opener = urllib.request.build_opener
urllib.request.build_opener = lambda *a, **k: _FakeOpener()
try:
    srv = W.WebSearchServer()

    # WITH: emits the configured _SSR_UA (a curl UA)
    srv.call_tool("search", {"query": "baize test"})
    emitted_with = captured.get("ua")
    check("L2b-i call_tool('search') emits _SSR_UA on the wire", emitted_with == W._SSR_UA,
          "emitted=" + str(emitted_with))

    # CONTROL: flip _SSR_UA -> the emitted UA follows it -> the reference is load-bearing
    W._SSR_UA = "CONTROL_UA_PROVES_LOAD_BEARING"
    srv.call_tool("search", {"query": "baize test"})
    emitted_ctl = captured.get("ua")
    check("L2b-ii flipping _SSR_UA MOVES the emitted UA (load-bearing, not decorative)",
          emitted_ctl == "CONTROL_UA_PROVES_LOAD_BEARING", "emitted=" + str(emitted_ctl))

    # and a browser UA in the search channel is exactly the polluted-shell path the fix avoids
    W._SSR_UA = "Mozilla/5.0 (would-be-browser-UA)"
    srv.call_tool("search", {"query": "baize test"})
    check("L2b-iii a browser UA in the search channel is exactly what the fix AVOIDS "
          "(the polluted-shell path)", captured.get("ua") == "Mozilla/5.0 (would-be-browser-UA)")
finally:
    urllib.request.build_opener = _orig_opener

print("\n" + ("SEARCH-UA-SSR: ALL GREEN" if not FAILURES
              else "SEARCH-UA-SSR: SOME FAILED " + str(FAILURES)))
sys.exit(1 if FAILURES else 0)
