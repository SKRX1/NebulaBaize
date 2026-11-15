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

print("\n" + ("RECYCLE-URL-MAP-GATE: " + str(len(FAILURES)) + " FAILED -> " + " | ".join(FAILURES) if FAILURES else "RECYCLE-URL-MAP-GATE: ALL GREEN"))
sys.exit(1 if FAILURES else 0)
