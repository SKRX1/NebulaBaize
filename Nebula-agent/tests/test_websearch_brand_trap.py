r"""Contract gate: websearch pinyin/romanization brand-trap notice (2026-11).

Context it locks (verified, real network, 2026-11): searching Bing Images for the
pinyin/romanization of a non-Latin word that happens to be a REGISTERED BRAND gets
hijacked by that brand. Real sample: 'Baize' (romanization of the legend) -> Bing
returns mostly BIAZE / 毕亚兹 brand storefront images (a JD flagship-store brand), not
the intended subject. This is Bing's own query understanding (brand-word priority),
NOT our parser -- we cannot fix Bing, so we SHOUT the workaround in-tool the moment
the query token hits the dictionary.

The fix is data-driven and deterministic (no network): a dictionary of known
pinyin/romanization collisions; when a query token matches, the tool appends an ASCII
guide line telling the operator to use the native script or add a qualifier. This gate
locks that decision in the REAL code path (it calls the real call_tool -> _call_images
with _images_pass stubbed so the ONLY variable is the dictionary hit).

Assertions (ASCII-matched only; the guide line itself is ASCII, per house rule):
  B1  query 'Baize'                  -> output carries the brand-trap line + the native
                                        script suggestion (dict key present in query)
  B2  query 'Baize legendary beast'  -> still triggers (the token is present); the
                                        suggested qualifier appears inside the line
  B3  query '  BAIZE  ' (caps+spaces)-> normalized match still triggers (case/space robust)
  B4  query 'white unicorn'          -> NO trap line (no dict token -> pure passthrough)
  B5  query 'bai ze' (split)         -> NO trap line: matching is by whole token, so a
                                        broken romanization does NOT false-fire
  B6  description for search_images  -> mentions 'brand' (the visible hint is present)
  B7  empty query                    -> no crash, no trap line (defensive)

Run: python tests/test_websearch_brand_trap.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "servers"))
import websearch_server as W  # noqa: E402

FAILURES = []

# Bare instance (skip __init__ which would block on stdin). Stub the network method ON
# THE CLASS so the instance dispatch picks it up; canned body is neutral (no trap text),
# so the ONLY variable is whether the dictionary hit appends a note on top.
W.WebSearchServer._images_pass = lambda self, q, count, proxy: "CANNED_BODY_no_trap_here"
srv = W.WebSearchServer.__new__(W.WebSearchServer)


def a(s):
    return s.encode("ascii", "backslashreplace").decode("ascii")


def run(query):
    return a(srv.call_tool("search_images", {"query": query}))


def check(label, cond, extra=""):
    print(("  OK   " if cond else "  FAIL ") + label + (("  " + extra) if extra else ""))
    if not cond:
        FAILURES.append(label)


# B1 exact romanization hit -> trap line + native-script suggestion
r1 = run("Baize")
check("B1 'Baize' emits the brand-trap line", "brand-trap hit" in r1, "out=" + r1)
check("B1b trap line names the offending brand BIAZE", "BIAZE" in r1, "out=" + r1)
check("B1c trap line suggests the native script (backslash-u escaped)",
      "\\u767d\\u6cfd" in r1, "out=" + r1)

# B2 token present with a qualifier -> still fires, suggested qualifier shown
r2 = run("Baize legendary beast")
check("B2 token inside a longer query still fires", "brand-trap hit" in r2, "out=" + r2)
check("B2b suggested qualifier 'legendary beast' appears", "legendary beast" in r2,
      "out=" + r2)

# B3 case + surrounding spaces are normalized
r3 = run("  BAIZE  ")
check("B3 caps+spaces still fires", "brand-trap hit" in r3, "out=" + r3)

# B4 non-dict query -> pure passthrough (body only, no note)
r4 = run("white unicorn")
check("B4 non-dict query has NO trap line", "brand-trap hit" not in r4, "out=" + r4)

# B5 broken romanization (split) does NOT false-fire
r5 = run("bai ze")
check("B5 split 'bai ze' does NOT false-fire", "brand-trap hit" not in r5, "out=" + r5)

# B6 the search_images tool description carries the visible hint
desc = ""
for t in W.WebSearchServer.tools:
    if t.get("name") == "search_images":
        desc = a(t.get("description", ""))
check("B6 search_images description mentions the brand hazard", "brand" in desc.lower(),
      "desc=" + desc)

# B7 empty query defensive: no crash, no trap
r7 = run("")
check("B7 empty query no crash, no trap", "brand-trap hit" not in r7, "out=" + r7)

print("\n" + ("WEBSEARCH-BRAND-TRAP: ALL PASSED" if not FAILURES
              else "WEBSEARCH-BRAND-TRAP: SOME FAILED " + str(FAILURES)))
sys.exit(1 if FAILURES else 0)
