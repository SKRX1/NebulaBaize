r"""Contract gate: websearch download naming priority + type whitelist (2026-11).

Root cause it locks: the operator wants "what language you type is what the file is
named". The fix made the download naming priority = explicit name > this-search-query
(sanitized, original language preserved) > URL basename. This gate locks that decision
in the REAL code path (it calls the real _call_download), no network: _fetch_bytes is
monkeypatched to return canned bytes and _gc/_cache_dir are redirected to a tempdir, so
the assertion is purely about which NAME the function chose.

Return format is exactly:  "saved <path> (<n> bytes)\n(inlined ..."  -- so the basename
is parsed as "everything after 'saved ' up to the LAST ' (' on line 1" (the tempdir name
itself may contain '(', so split on the LAST occurrence, not the first).

Assertions (ASCII-matched only; Chinese is display, not a match target, per house rule):
  C1  name + query + url all given   -> explicit name wins (highest priority)
  C2  query given, no name           -> query names the file; whitelisted url ext appended
  C3  neither name nor query         -> falls back to the URL basename
  C4  non-ASCII query                -> native script PRESERVED (asserted via ord>127)
  C5  query has no ext + url .pdf    -> whitelisted ext appended (.pdf)
  C6  query has no ext + url .xyz(not wl) -> falls to .bin (whitelist miss)
  C7  Windows-illegal chars in name  -> sanitize strips them (< > : " | ? * \ /)

Run: python tests/test_websearch_download_naming.py
"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "servers"))
import websearch_server as W  # noqa: E402

FAILURES = []
_TMP = tempfile.mkdtemp(prefix="wsdlnametest")   # NO '(' in the name: keeps parsing honest


def check(label, cond, extra=""):
    print(("  OK   " if cond else "  FAIL ") + label + (("  " + extra) if extra else ""))
    if not cond:
        FAILURES.append(label)


def a(s):
    return s.encode("ascii", "backslashreplace").decode("ascii")


def _saved_name(args):
    """Call the real _call_download with network+GC stubbed; return the saved basename."""
    W._fetch_bytes = lambda url: b"X" * 64          # no network
    W._gc = lambda d: None                          # no recycle side-effect
    W._cache_dir = lambda: _TMP                     # redirect out of the real cache
    msg = W._call_download(args)
    assert msg.startswith("saved "), msg
    line1 = msg.split("\n")[0]
    rest = line1[len("saved "):]
    path = rest.rsplit(" (", 1)[0]                  # LAST " (" = the byte-count marker
    return os.path.basename(path)


# C1 explicit name wins over query + url (name already has ext -> nothing appended)
check("C1 name>query>url: explicit name wins",
      _saved_name({"url": "http://x/pic/767d.png", "query": "q", "name": "my_name.png"}) == "my_name.png")

# C2 query names the file when no name given; query has no ext -> whitelisted url ext appended
check("C2 query names the file when no name given",
      _saved_name({"url": "http://x/pic/767d.png", "query": "the_query"}) == "the_query.png")

# C3 neither -> url basename
check("C3 falls back to URL basename",
      _saved_name({"url": "http://x/pic/767d.png"}) == "767d.png")

# C4 non-ASCII query: native script preserved (assert via ord>127, not the literal)
n4 = _saved_name({"url": "http://x/img/1.png", "query": "\u767d\u6cfd"})   # 白泽
check("C4 non-ASCII query keeps native script", any(ord(c) > 127 for c in n4), "got=" + a(n4))
check("C4b native-script name still got the ext", n4.endswith(".png"), "got=" + a(n4))

# C5 query has no ext + whitelisted url ext -> ext appended
check("C5 whitelisted ext appended (.pdf)",
      _saved_name({"url": "http://x/f/doc.pdf", "query": "note"}) == "note.pdf")

# C6 query has no ext + non-whitelist url ext -> .bin
check("C6 non-whitelist ext falls to .bin",
      _saved_name({"url": "http://x/f/data.xyz", "query": "note"}) == "note.bin")

# C7 sanitize strips Windows-illegal chars from the chosen name
n7 = _saved_name({"url": "http://x/img/9.png", "query": 'a<b>c'})          # -> a_b_c.png
check("C7 sanitize strips illegal chars", n7 == "a_b_c.png", "got=" + n7)

print("\n" + ("WEBSEARCH-DOWNLOAD-NAMING: ALL PASSED" if not FAILURES
              else "WEBSEARCH-DOWNLOAD-NAMING: SOME FAILED " + str(FAILURES)))
sys.exit(1 if FAILURES else 0)
