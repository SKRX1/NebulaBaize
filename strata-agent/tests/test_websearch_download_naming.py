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
  C6  query no ext + url .xyz(not in wl, shape-valid) -> kept as .xyz (A+B: table
      no longer gates it; "browser can download can download")
  C7  Windows-illegal chars in name  -> sanitize strips them (< > : " | ? * \ /)
  C8  truly extension-less url + no name ext -> .bin (the ONLY real fallback)
  M1  name .png + data PNG magic       -> stays .png (sniff agrees, no change)
  M2  name .jpg + data PNG magic        -> corrected to .png (cross-family fix)
  M3  name .heic + data TIFF magic      -> corrected to .tif (cross-family fix)
  M4-M17 sniff-table coverage, ONE assertion per magic (carrier name is .bin, which
       lives in NO sniff family -- so only the sniffer can move the extension):
       M4 JPEG  M5 GIF  M6 BMP  M7 PDF  M8 TIFF(big-endian branch)  M9 RIFF-WEBP
       M10 RIFF-WAVE  M11 gz(bug-exposed: 2-byte magic once mis-wired to [:4], FIXED)
       M12 bz2  M13 7z  M14 rar  M15 zip-container  M16 BMFF-mov
       M17 BMFF other brand (isom) -> .mp4   (the ISO-BMFF catch-all branch)
  M18 zip magic + name .docx -> stays .docx  (intra-container-family: NO collateral)
  M19 TIFF magic + name .tiff -> stays .tiff (alias inside family: NO collateral)

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


def _saved_name(args, data=b"X" * 64):
    """Call the real _call_download with network+GC stubbed; return the saved basename."""
    W._fetch_bytes = lambda url: data               # no network; default junk bytes
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

# C6 url ext NOT in the (A) whitelist but shape-valid -> kept as-is (B: not gated)
check("C6 non-whitelist ext kept as-is (B: table no longer gates)",
      _saved_name({"url": "http://x/f/data.xyz", "query": "note"}) == "note.xyz")

# C8 truly extension-less (no dot in url path, name has no ext) -> .bin (real fallback)
check("C8 extension-less url + no name ext -> .bin",
      _saved_name({"url": "http://x/f/noext", "query": "note"}) == "note.bin")

# C7 sanitize strips Windows-illegal chars from the chosen name
n7 = _saved_name({"url": "http://x/img/9.png", "query": 'a<b>c'})          # -> a_b_c.png
check("C7 sanitize strips illegal chars", n7 == "a_b_c.png", "got=" + n7)

# M1 name .png, data=PNG magic -> stays .png (sniff agrees)
# PNG magic: first 8 bytes of any valid PNG file, padded to 16+
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
check("M1 .png + PNG magic stays .png (sniff agrees)",
      _saved_name({"url": "http://x/pic/767d.png", "query": "q", "name": "photo.png"},
                  data=_PNG_MAGIC) == "photo.png")

# M2 name .jpg, data=PNG magic -> corrected to .png (cross-family)
check("M2 .jpg + PNG magic corrected to .png", 
      _saved_name({"url": "http://x/pic/767d.png", "query": "q", "name": "photo.jpg"},
                  data=_PNG_MAGIC) == "photo.png")

# M3 name .heic, data=TIFF magic -> corrected to .tif (cross-family, house pain-point)
# TIFF little-endian magic: II*\x00 + enough bytes to clear the 16-byte sniff floor
_TIFF_MAGIC = b"II*\x00" + b"\x00" * 32
check("M3 .heic + TIFF magic corrected to .tif", 
      _saved_name({"url": "http://x/pic/767d.png", "query": "q", "name": "photo.heic"},
                  data=_TIFF_MAGIC) == "photo.tif")

# ── M4-M19 sniff-table coverage: one assertion per magic. Carrier default is .bin
# (in NO sniff family), so ONLY the sniffer can move the extension -- the assertion
# exercises _sniff_ext/_reconcile_ext, not the naming logic. M18/M19 override the
# carrier to their own family so they lock the NO-COLLATERAL intra-family rule.
# Padded so every magic clears the 16-byte sniff floor and the 12-byte BMFF window.
def sniff(label, magic, expect, carrier="f.bin"):
    got = _saved_name({"url": "http://x/f/x.bin", "query": "q", "name": carrier},
                      data=magic + b"\x00" * 32)
    check(label, got == expect, "got=" + a(got))

sniff("M4 JPEG magic -> .jpg",             b"\xff\xd8\xff\xe0", "f.jpg")
sniff("M5 GIF magic -> .gif",              b"GIF89a", "f.gif")
sniff("M6 BMP magic -> .bmp",              b"BM", "f.bmp")
sniff("M7 PDF magic -> .pdf",              b"%PDF-", "f.pdf")
sniff("M8 TIFF big-endian branch -> .tif", b"MM\x00*", "f.tif")   # M3 locked the LE branch
sniff("M9 RIFF-WEBP -> .webp",             b"RIFF\x00\x00\x00\x00WEBP", "f.webp")
sniff("M10 RIFF-WAVE -> .wav",             b"RIFF\x00\x00\x00\x00WAVE", "f.wav")
sniff("M11 gzip -> .gz",                   b"\x1f\x8b\x08", "f.gz")
sniff("M12 bzip2 -> .bz2",                 b"BZh9", "f.bz2")
sniff("M13 7z -> .7z",                     b"7z\xbc\xaf\x27\x1c", "f.7z")
sniff("M14 rar v5 -> .rar",                b"Rar!\x1a\x07\x01\x1d", "f.rar")
sniff("M15 zip container -> .zip",         b"PK\x03\x04", "f.zip")
sniff("M16 ISO-BMFF qt brand -> .mov",     b"\x00\x00\x00\x18ftypqt  ", "f.mov")
sniff("M17 ISO-BMFF other brand -> .mp4",  b"\x00\x00\x00\x18ftypisom", "f.mp4")
# intra-family = NO collateral (the load-bearing safety design):
sniff("M18 zip magic + .docx stays .docx",  b"PK\x03\x04", "f.docx", carrier="f.docx")
sniff("M19 TIFF magic + .tiff stays .tiff", b"II*\x00", "f.tiff",   carrier="f.tiff")

print("\n" + ("WEBSEARCH-DOWNLOAD-NAMING: ALL PASSED" if not FAILURES
              else "WEBSEARCH-DOWNLOAD-NAMING: SOME FAILED " + str(FAILURES)))
sys.exit(1 if FAILURES else 0)
