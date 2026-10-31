import re, sys, io

# Grab the two pure helpers straight from the production source and exec them in isolation.
SRC = io.open(r"E:\WorkBuddy\星云智能体\strata-agent\runtime\http_server.py",
              encoding="utf-8").read()

def grab_fn(name):
    m = re.search(r"^def %s\(.*?(?=^def |\Z)" % re.escape(name), SRC,
                  re.S | re.M)
    if not m:
        raise SystemExit("helper not found: " + name)
    ns = {}
    exec(compile(m.group(0), "<grab>", "exec"), ns)
    return ns[name]

_degrade = grab_fn("_degrade_image_blocks")
_is_vf = grab_fn("_is_vision_failure")

fails = 0
def check(label, got, want):
    global fails
    ok = got == want
    print(("PASS" if ok else "FAIL"), "|", label, "->", repr(got)[:80])
    if not ok:
        fails += 1

# ---- _is_vision_failure: positive = real engine strings, negative = must NOT hijack ----
check("vf real-engine could-not-be-read",
      _is_vf("upstream error: HTTP 400: Bad Request ... the image could not be read: cannot read the image"), True)
check("vf decode wording", _is_vf("image could not be decoded"), True)
check("vf cannot read", _is_vf("cannot read the image data"), True)
check("vf NOT context-overflow (neg guard)", _is_vf("request exceeds the context window"), False)
check("vf NOT generic", _is_vf("internal server error"), False)
check("vf NOT empty", _is_vf(""), False)

# ---- _degrade_image_blocks: image block -> text placeholder, text preserved ----
msgs = [
    {"role": "user", "content": [
        {"type": "text", "text": "look at this"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
    ]},
]
out = _degrade(msgs)
blocks = out[0]["content"]
img_types = [b["type"] for b in blocks if b["type"] == "image_url"]
check("degrade drops image_url", img_types, [])
check("degrade keeps original text block", blocks[0]["text"], "look at this")
check("degrade image block became text placeholder", blocks[1]["type"], "text")

# differential pair: the SAME message, before has image_url, after has none
before_has = any(b["type"] == "image_url" for b in msgs[0]["content"])
after_has = any(b["type"] == "image_url" for b in out[0]["content"])
check("differential before-has-image", before_has, True)
check("differential after-has-image", after_has, False)

# original messages must NOT be mutated (degrade returns a copy)
check("original not mutated", any(b["type"] == "image_url" for b in msgs[0]["content"]), True)

# text-only messages pass through unchanged
plain = [{"role": "user", "content": [{"type": "text", "text": "hello"}]}]
check("text-only unchanged", _degrade(plain), plain)

# string-content message passes through
strc = [{"role": "user", "content": "plain string"}]
check("string-content unchanged", _degrade(strc), strc)

print("\nTOTAL FAILS:", fails)
sys.exit(1 if fails else 0)
