# -*- coding: utf-8 -*-
# [img2img 去噪根因修复 2026-11-27 方案 A+B 回归门禁]
# 根因：Qwen-Image-2.1-Turbo 在 sd-cli 走 FLOW mode + Flux scheduler，截断的 σ 表末端停在
# 非零值 → 去噪轨迹没走满到 σ=0，残留高频颗粒（"像没完成/噪点"）。flow-shift/karras/eta/
# steps 实测都救不了；唯一实测消噪的是把 σ 表末端归 0。修复 = i2i_sigmas/i2i_hires_sigmas
# 按 strength/steps 动态构造「末端归 0」的递减 σ 表，注入到 img2img/edit 的 --sigmas / --hires-sigmas。
# 实测坐实（真实 strength0.45+hires 链路）：lapvar 163.9→146.9，比 txt2img 基准(148.6)更平滑；
# 与现状 Pearson 0.947（仅去高频、不改结构/人脸）。
#
# 差分锁 load-bearing：
#   D1 img2img -> 拼出的 cmd 必含 --sigmas 且其值末端归 0（去掉 A 注入此项即翻红）
#   D2 img2img+hires -> 必含 --hires-sigmas 且末端归 0（去掉 B 注入此项即翻红）
#   D3 txt2img -> cmd 不含 --sigmas / --hires-sigmas（σ 表只属 img2img/edit，txt2img 走全程无需）
#   纯函数：σ 表末端恒 0、strength<=0 或 steps<2 返回 None、值从 strength 单调递减。
import io
import os
import sys

sys.stdout.reconfigure(encoding="utf-8") if hasattr(sys.stdout, "reconfigure") else None
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, ROOT)
import http_server as HS  # noqa: E402

cfg = {"exe": __file__, "diffusion_model": "", "vae": "", "llm": "", "llm_vision": "", "args": []}
IEND = b"\x49\x45\x4e\x44\xae\x42\x60\x82"
ORIG_GD = HS.GENERATED_DIR
CAP = {"cmd": None}


class FakeProc:
    returncode = 0
    stdout = ""
    stderr = ""


def fake_run(cmd, **kw):
    CAP["cmd"] = list(cmd)
    od = os.path.dirname(cmd[cmd.index("-o") + 1]) or "."
    with open(os.path.join(od, "img_0.png"), "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n" + b"\x00" * 200 + IEND)   # 写完整，让流程走到登记
    return FakeProc()


def capture_cmd(genreq):
    saved = HS.subprocess.run
    HS.subprocess.run = fake_run
    import tempfile
    tmpg = tempfile.mkdtemp(prefix="gd_")
    HS.GENERATED_DIR = tmpg
    try:
        HS.GatewayHandler._gen_local(None, "a fox", 64, 64, 1, 1, "b64_json", cfg, genreq=genreq)
    except Exception:  # noqa: BLE001 — 只要 cmd 已捕获即可
        pass
    finally:
        HS.GENERATED_DIR = ORIG_GD
        HS.subprocess.run = saved
    return CAP["cmd"]


def val_after(cmd, flag):
    return cmd[cmd.index(flag) + 1] if flag in cmd else None


fails = 0


def check(label, cond, extra=""):
    global fails
    if not cond:
        fails += 1
    print("  [%s] %s  %s" % ("OK" if cond else "FAIL", label, extra))


# ── 拼命令差分（真实链路：init_image 用本文件当占位，引擎被 fake 掉） ──
i2i = capture_cmd({"gen_mode": "img2img", "init_image": __file__, "strength": 0.45, "steps": 8})
s = val_after(i2i, "--sigmas")
check("D1 img2img has --sigmas ending at 0",
      s is not None and s.endswith(",0") and float(s.split(",")[0]) <= 0.45 + 1e-6,
      "sigmas=%s" % s)
hs = val_after(i2i, "--hires-sigmas")
check("D2 img2img+hires has --hires-sigmas ending at 0",
      hs is not None and hs.endswith(",0"), "hires_sigmas=%s" % hs)

t2i = capture_cmd({"gen_mode": "txt2img", "steps": 8})
check("D3 txt2img has NO --sigmas/--hires-sigmas",
      "--sigmas" not in t2i and "--hires-sigmas" not in t2i)

edit = capture_cmd({"gen_mode": "edit", "ref_images": [__file__], "steps": 8})
check("D4 edit has --hires-sigmas ending at 0",
      val_after(edit, "--hires-sigmas") is not None
      and val_after(edit, "--hires-sigmas").endswith(",0"))

# ── 纯函数行为 ──
v = HS.i2i_sigmas(0.45, 8)
parts = [float(x) for x in v.split(",")]
check("P1 i2i_sigmas length==steps & strictly decreasing & tail 0",
      len(parts) == 8 and all(parts[i] > parts[i + 1] for i in range(7)) and parts[-1] == 0.0,
      v)
check("P2 strength<=0 -> None", HS.i2i_sigmas(0, 8) is None and HS.i2i_sigmas(-0.5, 8) is None)
check("P3 steps<2 -> None", HS.i2i_sigmas(0.5, 1) is None and HS.i2i_sigmas(0.5, 0) is None)
check("P4 junk -> None", HS.i2i_sigmas("x", 8) is None and HS.i2i_sigmas(None, 8) is None)
check("P5 strength>1 clamped to <=1", float(HS.i2i_sigmas(1.5, 8).split(",")[0]) <= 1.0)
hv = HS.i2i_hires_sigmas(0.3, 8)
check("P6 hires_sigmas ends at 0 & <=strength",
      hv.endswith(",0") and float(hv.split(",")[0]) <= 0.3 + 1e-6, hv)

print("\n%s" % ("I2I-SIGMAS-GATE: ALL GREEN (sigma-zero-end proven load-bearing: img2img/edit carry --sigmas&--hires-sigmas ending 0, txt2img carries none)"
                if fails == 0 else "I2I-SIGMAS-GATE: %d FAIL" % fails))
sys.exit(1 if fails else 0)
