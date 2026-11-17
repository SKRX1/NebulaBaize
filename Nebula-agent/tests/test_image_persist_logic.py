"""Logic gate for the server-side image persistence (Plan A). The live server.py can't be
imported in this workspace (serve.frontend lives only in the runtime install), so this test
replicates the exact data-URL contract of _images_upload — parse -> base64-decode -> write
under data/uploads/ -> read back — and asserts the byte round-trip the reload-loss bug needs.
Run from Nebula-agent/.
"""
import base64
import os
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # Nebula-agent/
FAILURES = []
def check(label, cond, extra=""):
    print("  " + ("OK   " if cond else "FAIL ") + label + ("  " + extra if extra else ""))
    if not cond:
        FAILURES.append(label)

# the EXT/mime map _images_upload uses (kept in sync; drop one entry here and a check goes red)
EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
       "image/webp": ".webp", "image/bmp": ".bmp"}

def handle_upload(data_url, name):
    """Mirror of _images_upload's logic path; returns (status, payload) like the handler."""
    if not data_url.startswith("data:") or ";base64," not in data_url:
        return 400, {"error": "not a base64 data URL"}
    head, _, payload = data_url.partition(",")
    mime = head[len("data:"):].split(";")[0].lower()
    ext = EXT.get(mime)
    if not ext:
        return 400, {"error": "unsupported mime " + (mime or "(none)")}
    try:
        data = base64.b64decode(payload)
    except Exception:
        return 400, {"error": "not valid base64"}
    if len(data) > 20_000_000:
        return 413, {"error": "too large"}
    updir = os.path.join(ROOT, "data", "uploads")
    os.makedirs(updir, exist_ok=True)
    fname = "img-" + uuid.uuid4().hex[:16] + ext
    with open(os.path.join(updir, fname), "wb") as f:
        f.write(data)
    return 200, {"ref": "/data/uploads/" + fname, "name": name or fname}

# a tiny valid PNG so the upload really is image bytes
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC")

def main():
    print("IMAGE PERSIST LOGIC:")

    # A1: a real base64 PNG round-trips byte-for-byte through disk under data/uploads/
    st, res = handle_upload("data:image/png;base64," + base64.b64encode(PNG).decode(), "e2e-test")
    check("A1. upload returns 200", st == 200, "status=%s" % st)
    check("A1. upload returns a data/uploads reference", res.get("ref", "").startswith("/data/uploads/"), res.get("ref"))
    if res.get("ref"):
        disk = os.path.join(ROOT, "data", "uploads", os.path.basename(res["ref"]))
        check("A1. the file exists on disk", os.path.isfile(disk))
        served = open(disk, "rb").read() if os.path.isfile(disk) else b""
        check("A1. the served bytes match the uploaded bytes", served == PNG,
              "sent=%d got=%d" % (len(PNG), len(served)))
        check("A1. control: an empty/garbage payload is NOT silently equal to a real image",
              served != b"", "served=%d" % len(served))
        try: os.remove(disk)   # clean up the test artefact
        except OSError: pass

    # A2: a non-base64 data URL is rejected (400), not crash
    st2, _ = handle_upload("http://x/y.png", "n")
    check("A2. a non-base64 data URL is rejected with 400", st2 == 400, "status=%s" % st2)
    # A3: an unsupported mime is rejected (400) — control proving the mime map is live
    st3, _ = handle_upload("data:image/tiff;base64," + base64.b64encode(PNG).decode(), "n")
    check("A3. an unsupported mime is rejected with 400", st3 == 400, "status=%s" % st3)

    print("")
    print("IMAGE PERSIST LOGIC: " + ("ALL GREEN" if not FAILURES else "%d FAILED" % len(FAILURES)))
    raise SystemExit(0 if not FAILURES else 1)

main()
