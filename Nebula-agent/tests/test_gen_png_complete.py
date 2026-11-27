# -*- coding: utf-8 -*-
# [成品入库校验 2026-11-27 回归门禁]
# 把 _png_is_complete 思路推广到成品图持久化：_gen_local 在 shutil.copyfile(pngp, dest) 之后
# 必须校验 dest 确为写完整的 PNG（含 IEND 尾）才登记进画廊；否则删除本次残片并 raise，
# 杜绝偶发 8B PNG 签名残片（仅 \x89PNG 魔数、零 chunk）入库成为永久破图条目。
# 差分锁 load-bearing：monkeypatch subprocess.run 让引擎写出「完整 PNG」-> 入库 1 张、不报错；
# 写出「8B 残片」-> raise 且 GENERATED_DIR 里 0 个 gen_ 文件（残片已被 os.remove 清掉）。
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

EXE = os.path.join(ROOT, "..", "QwenImage2.1Turbo")  # exe 存在性靠 monkeypatch 跳过即可
# 任何存在的文件都能过 os.path.isfile(exe) 检查；用本测试文件自身当 exe 占位。
cfg = {"exe": __file__, "diffusion_model": "", "vae": "", "llm": "", "llm_vision": "", "args": []}
IEND = b"\x49\x45\x4e\x44\xae\x42\x60\x82"
ORIG_GD = HS.GENERATED_DIR
MODE = {"corrupt": False}


class FakeProc:
    returncode = 0
    stdout = ""
    stderr = ""


def fake_run(cmd, **kw):
    # 引擎真实行为：在 -o pattern 目录下写出 img_0.png。这里按 MODE 写完整或残片。
    od = os.path.dirname(cmd[cmd.index("-o") + 1]) or "."
    if MODE["corrupt"]:
        data = b"\x89PNG\r\n\x1a\n"  # 仅 8B PNG 签名，零 chunk = 半写/损坏残片
    else:
        data = b"\x89PNG\r\n\x1a\n" + b"\x00" * 200 + IEND  # 写完整
    with open(os.path.join(od, "img_0.png"), "wb") as fh:
        fh.write(data)
    return FakeProc()


def run_one(corrupt):
    MODE["corrupt"] = corrupt
    saved_run = HS.subprocess.run
    HS.subprocess.run = fake_run
    tmpg = tempfile.mkdtemp(prefix="gd_")
    HS.GENERATED_DIR = tmpg
    err = None
    res = None
    try:
        res = HS.GatewayHandler._gen_local(None, "a fox", 64, 64, 1, 1, "b64_json", cfg,
                                           genreq={"gen_mode": "txt2img"})
    except Exception as e:  # noqa: BLE001 — we assert on the raise
        err = e
    in_gallery = [f for f in os.listdir(tmpg) if f.startswith("gen_")]
    HS.GENERATED_DIR = ORIG_GD
    HS.subprocess.run = saved_run
    return err, res, in_gallery


fails = 0

# C1 差分正例：完整 PNG -> 入库 1 张、不报错
err_ok, res_ok, gal_ok = run_one(False)
ok1 = (err_ok is None and len(gal_ok) == 1)
if not ok1:
    fails += 1
print("  [%s] complete PNG -> land 1, no raise  (err=%s gallery=%d)" % (
    "OK" if ok1 else "FAIL", (str(err_ok)[:40] if err_ok else None), len(gal_ok)))

# C2 差分反例：8B 残片 -> 必须 raise，且画廊里 0 个 gen_（dest 残片已被删）
err_bad, res_bad, gal_bad = run_one(True)
ok2 = (err_bad is not None and len(gal_bad) == 0)
if not ok2:
    fails += 1
print("  [%s] corrupt 8B remnant -> raise + 0 files (residual removed)  (raised=%s gallery=%d)" % (
    "OK" if ok2 else "FAIL", err_bad is not None, len(gal_bad)))

# C3 load-bearing 反向锁：若无 IEND 校验（模拟），损坏残片会被登记（gallery=1、不报错）。
#    这里直接断言 _png_is_complete 对 8B 残片判 False —— 它是 C2 能拦下的唯一支点。
fd, p8 = tempfile.mkstemp(suffix=".png")
with os.fdopen(fd, "wb") as fh:
    fh.write(b"\x89PNG\r\n\x1a\n")
ok3 = HS._png_is_complete(p8) is False
if not ok3:
    fails += 1
print("  [%s] _png_is_complete(8B signature) is False (the load-bearing pivot)" % ("OK" if ok3 else "FAIL"))
os.remove(p8)

print("\n%s" % ("GEN-PERSIST-GATE: ALL GREEN (IEND gate proven load-bearing: complete->1 vs corrupt->raise+0)"
                if fails == 0 else "GEN-PERSIST-GATE: %d FAIL" % fails))
sys.exit(1 if fails else 0)
