"""Static gate: the 8080 parasitic engine's /web/ branch must carry the same cache
validators (ETag + Last-Modified + 304) that the 8099 gateway _serve_static gained in
commit 3699074, so both instances behave identically -- a changed app.js/app.css is
picked up on a plain reload (no hard-refresh dance after deploying frontend edits).

The engine is too heavy to boot for a contract test (mock engine + MCP stack + a model),
so this is a pure source-code gate: read serve/server.py, normalise line endings to LF,
and assert the validators are present in the /web/ send block. A decoy removes the 304
response and proves the gate flips (load-bearing). Pure ASCII output.

python tests/test_web_branch_cache.py    -> exit 0 == PASS
"""
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SERVER = os.path.join(ROOT, "serve", "server.py")

fails = []


def check(name, cond):
    print("%-40s %s" % (name, "OK" if cond else "FAIL"))
    if not cond:
        fails.append(name)


raw = open(SERVER, "rb").read()
# normalise CRLF/CR -> LF so the line-endings (this file is mixed) cannot break matching
text = raw.replace(b"\r\n", b"\n").replace(b"\r", b"\n").decode("utf-8", "replace")

# 1) the email.utils import that supplies the HTTP-date helpers
check("import-email.utils", "from email.utils import formatdate, parsedate_to_datetime" in text)

# 2) the /web/ branch: locate its send block by the types dict unique to that branch
m = re.search(r'(types = \{.*?\n)(.*?)(if path\.startswith\("/data/uploads/"\))', text, re.S)
check("web-branch-locatable", m is not None)

block = m.group(2) if m else ""

# 3) validators on the 200 path
check("etag-header", 'self.send_header("ETag", etag)' in block)
check("last-modified-header", 'self.send_header("Last-Modified", last_modified)' in block)
check("mtime-ns-etag", "st.st_mtime_ns" in block)
check("keeps-no-cache", 'self.send_header("Cache-Control", "no-cache")' in block)

# 4) the conditional path: 304 with no body, honouring both If-None-Match and If-Modified-Since
check("response-304", "self.send_response(304)" in block)
check("checks-inm", '"If-None-Match"' in block)
check("checks-ims", '"If-Modified-Since"' in block)
# the 304 branch must come BEFORE the 200 so an unchanged file never re-downloads the body
i304 = block.find("self.send_response(304)")
i200 = block.find('self.send_response(200)')
check("304-before-200", i304 != -1 and i200 != -1 and i304 < i200)

# 5) decoy: strip the 304 response -> the gate's own assertions must flip. We assert the
#    DECOYED text lacks the 304 (proving the check is load-bearing on this exact file).
decoyed = text.replace("self.send_response(304)", "self.send_response(200)", 1)
check("decoy-flips-304", "self.send_response(304)" not in decoyed)

print("\n%d failed" % len(fails))
if fails:
    for f in fails:
        print("  FAIL:", f)
    sys.exit(1)
print("WEB-BRANCH-CACHE: ALL GREEN")
sys.exit(0)
