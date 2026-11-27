# -*- coding: utf-8 -*-
# [预览半写修复 2026-11-27 回归门禁]
# 锁定 _png_is_complete：写完整的 PNG（含 IEND chunk + CRC）判 True；半写/截断/空/8B 头
# 判 False。这是「生成中预览闪烁重叠」根因修复的核心判据（preview_ready 改判 PNG 是否写完，
# 不再仅 isfile）。差分锁：同 body 加 IEND=True、不加 IEND=False，证明 IEND 判据 load-bearing。
import io
import os
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8") if hasattr(sys.stdout, "reconfigure") else None
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)
import http_server as HS  # noqa: E402

IEND = b"\x49\x45\x4e\x44\xae\x42\x60\x82"  # PNG IEND chunk type + its CRC32


def _w(data):
    fd, p = tempfile.mkstemp(suffix=".png")
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    return p


fails = 0


def check(name, data, want):
    global fails
    p = _w(data)
    try:
        got = HS._png_is_complete(p)
    finally:
        os.remove(p)
    ok = got is want
    if not ok:
        fails += 1
    print("  [%s] %-42s want=%s got=%s" % ("OK" if ok else "FAIL", name, want, got))


# C1: 完整 PNG -> True
check("full png (sig + body + IEND)", b"\x89PNG\r\n\x1a\n" + b"\x00" * 100 + IEND, True)
# C2: 仅 8B 签名（半写残留，正是成品图里实测出现的损坏态）-> False
check("PNG signature only (8B mid-write remnant)", b"\x89PNG\r\n\x1a\n", False)
# C3: 有 body 但缺 IEND（写到一半）-> False
check("body present, IEND missing (truncated)", b"\x89PNG\r\n\x1a\n" + b"\x00" * 500, False)
# C4: 空文件 -> False
check("empty file", b"", False)
# C5: <12B 残片 -> False（且不得因 seek 负偏移抛错）
check("tiny <12B junk", b"\x89PNG", False)

# C6: 差分锁 load-bearing —— 同 body 加 IEND 必须 True、不加必须 False
body = b"\x89PNG\r\n\x1a\n" + os.urandom(1000)
p_wo = _w(body)
p_w = _w(body + IEND)
try:
    a = HS._png_is_complete(p_wo)
    b = HS._png_is_complete(p_w)
finally:
    os.remove(p_wo)
    os.remove(p_w)
ok = (a is False and b is True)
if not ok:
    fails += 1
print("  [%s] DIFFERENTIAL: no-IEND=%s with-IEND=%s (must be False/True)" % ("OK" if ok else "FAIL", a, b))

print("\n%s" % ("PNG-COMPLETE-GATE: ALL GREEN" if fails == 0
                else "PNG-COMPLETE-GATE: %d FAIL" % fails))
sys.exit(1 if fails else 0)
