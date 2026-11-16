# -*- coding: utf-8 -*-
"""Bug3 (2026-11-15b) 最小行为锁：url-shape 映射到 INSTALL ROOT。

锁住 _recycle_resolve 对以下 url 形态的映射：
  /data/generated/images/xxx.png  →  GENERATED_DIR / xxx.png
  /data/saved_images/xxx.png      →  ROOT/data/saved_images/xxx.png
  非 url 形态（workspace 绝对路径） → Path(raw)（legacy 不变）

Run: python -X utf8 tests/test_recycle_url_mapping.py
"""
import os, sys
from pathlib import Path
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import http_server as H  # noqa: E402

FAILURES = []
def check(label, cond, extra=""):
    print("  " + ("OK   " if cond else "FAIL ") + label + (" " + extra if extra else ""))
    if not cond: FAILURES.append(label)

def make_handler():
    return H.GatewayHandler.__new__(H.GatewayHandler)

h = make_handler()

# Test 1: generated-images url maps to GENERATED_DIR
p = h._recycle_resolve("/data/generated/images/test_gen.png")
expected = Path(H.GENERATED_DIR) / "test_gen.png"
check("R1 generated url → GENERATED_DIR", str(p) == str(expected), f"got={p}")

# Test 2: saved-images url maps to ROOT/data/saved_images
p2 = h._recycle_resolve("/data/saved_images/saved_img.png")
expected2 = Path(H.ROOT) / "data" / "saved_images" / "saved_img.png"
check("R2 saved url → ROOT/data/saved_images", str(p2) == str(expected2), f"got={p2}")

# Test 3: workspace-absolute path passes through unchanged
p3 = h._recycle_resolve("C:/some/path/file.png")
check("R3 absolute workspace path passthrough", str(p3) == str(Path("C:/some/path/file.png")), f"got={p3}")

# Test 4: query string stripped before resolving
p4 = h._recycle_resolve("/data/generated/images/test_gen.png?v=123")
expected4 = Path(H.GENERATED_DIR) / "test_gen.png"
check("R4 query string stripped", str(p4) == str(expected4), f"got={p4}")

# [打开所在文件夹修复 2026-11-15] the folder a gallery ref lives in = the CONTAINING dir,
# resolved against the INSTALL ROOT (the session root used to land one level too high -> 400).
pr = h._recycle_resolve("/data/generated/images/x.png").parent
check("R5 reveal opens the INSTALL-ROOT generated-images folder (the parent of a generated ref)",
      str(pr) == str(Path(H.GENERATED_DIR).resolve()), f"got={pr}")
ps = h._recycle_resolve("/data/saved_images/y.png").parent
check("R6 reveal opens the INSTALL-ROOT saved_images folder (the parent of a saved ref)",
      str(ps) == str((Path(H.ROOT) / "data" / "saved_images").resolve()), f"got={ps}")

# [批量删除修复 2026-11-16] the batch job fed RAW urls to _recycle_batch_script (the sync path
# mapped via _recycle_resolve, but the >threshold background path did NOT) — so every gallery file
# past the sync threshold landed on a path missing the strata-agent/ segment and silently vanished.
# The fix maps batch paths through _recycle_resolve before PowerShell sees them. Lock it.

gen_raw = "/data/generated/images/batchA.png"
mapped_batch = [str(h._recycle_resolve(gen_raw))]
script_mapped = h._recycle_batch_script(mapped_batch)
script_raw = h._recycle_batch_script([gen_raw])   # what the OLD buggy batch path produced

# R7: the MAPPED batch script embeds the INSTALL-ROOT generated-images dir (the load-bearing proof).
check("R7 batch script fed MAPPED path embeds the INSTALL ROOT",
      str(Path(H.GENERATED_DIR)) in script_mapped, f"script={script_mapped!r}")

# R8: feeding the RAW url (the old behavior) would NOT embed the install root — proves the mapping
# call is load-bearing, not a no-op. This is the differential that separates fix from regression.
check("R8 raw-url batch script does NOT embed the install root (mapping is load-bearing)",
      str(Path(H.GENERATED_DIR)) not in script_raw and gen_raw in script_raw, f"script={script_raw!r}")

# [缺前导斜杠修复 2026-11-16] stale localStorage generated entries were saved WITHOUT the leading
# slash; the fix normalizes it so they still map to the install root. Lock the new behavior.
p9 = h._recycle_resolve("data/generated/images/noslash.png")          # NO leading slash
check("R9 NO-slash generated url -> GENERATED_DIR", str(p9) == str(Path(H.GENERATED_DIR) / "noslash.png"), f"got={p9}")
p10 = h._recycle_resolve("data/saved_images/noslash.png")             # NO leading slash
check("R10 NO-slash saved url -> ROOT/data/saved_images", str(p10) == str((Path(H.ROOT) / "data" / "saved_images") / "noslash.png"), f"got={p10}")

print("\n" + ("RECYCLE-URL-MAP-GATE: " + str(len(FAILURES)) + " FAILED -> " + " | ".join(FAILURES) if FAILURES else "RECYCLE-URL-MAP-GATE: ALL GREEN"))
sys.exit(1 if FAILURES else 0)
