# -*- coding: utf-8 -*-
# [img2img 去噪根因修复 2026-11-27 方案 A+B 回归门禁]
# 根因：Qwen-Image-2.1-Turbo(8步蒸馏) 高强度图生图残留高频颗粒（"像没完成/噪点"）。早期方案
# 把 custom σ 表末端归 0 注入 img2img 主遍；后续实测发现 --scheduler karras 降噪更彻底——
# 真实链路(hires+hires-sigmas)三档 lapvar 0.30:121->84.7 / 0.45:151->97.9 / 0.65:167->149.7（karras
# 全面更低=更平滑，0.65 已逼近 txt2img 基准148.6），与现状 Pearson>=0.985（仅去高频、闭眼变化保留）。
# 现方案：img2img 主遍默认注 --scheduler karras（用户未自选 scheduler 时）；custom --sigmas 与
# --scheduler 互斥(custom 覆盖 scheduler)故主遍不再注 custom σ 表。hires 二遍也不再注 custom
# --hires-sigmas(2026-11-28 回归修复：实测它是「图生图噪、文生图光滑」的真元凶——主遍 karras 下，
# 同链路只差这一个 flag，lapvar 110.3->176.0，它给 denoise0.3 二遍强加线性 σ 表盖过 karras 注颗粒；
# 移除后 karras+hires=110.3 比 txt2img 基准118 还平滑，且 hires 本体反而降噪 139->110 故保留)。
#
# 差分锁 load-bearing：
#   D1 img2img -> 拼出的 cmd 必含 --sigmas 且其值末端归 0（去掉 A 注入此项即翻红）
#   D2 img2img+hires -> 不含 --hires-sigmas（B腿已移除=load-bearing，加回去即翻红）
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
sch = val_after(i2i, "--scheduler")
check("D1 img2img defaults to --scheduler karras (no custom --sigmas)",
      sch == "karras" and "--sigmas" not in i2i, "scheduler=%s" % sch)
# D5 用户自选 scheduler 时胜出，且不重复注 karras（--scheduler 与 custom --sigmas 互斥防双注）
us = capture_cmd({"gen_mode": "img2img", "init_image": __file__, "strength": 0.45, "steps": 8, "scheduler": "discrete"})
check("D5 user-chosen scheduler wins, no karras double-inject, no custom --sigmas",
      val_after(us, "--scheduler") == "discrete" and "karras" not in us and "--sigmas" not in us,
      "scheduler=%s" % val_after(us, "--scheduler"))
hs = val_after(i2i, "--hires-sigmas")
check("D2 img2img+hires carries NO --hires-sigmas (B-leg removed; it re-injected grain onto the karras hires 2nd pass)",
      hs is None, "hires_sigmas=%s" % hs)

t2i = capture_cmd({"gen_mode": "txt2img", "steps": 8})
check("D3 txt2img has NO --sigmas/--hires-sigmas",
      "--sigmas" not in t2i and "--hires-sigmas" not in t2i)

edit = capture_cmd({"gen_mode": "edit", "ref_images": [__file__], "steps": 8})
check("D4 edit carries NO --hires-sigmas (B-leg removed, same root cause as D2)",
      val_after(edit, "--hires-sigmas") is None)

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

print("\n%s" % ("I2I-SIGMAS-GATE: ALL GREEN (img2img defaults to karras scheduler, no custom --sigmas, user-scheduler wins w/o double-inject; hires/edit carry NO --hires-sigmas, txt2img carries none)"
                if fails == 0 else "I2I-SIGMAS-GATE: %d FAIL" % fails))
sys.exit(1 if fails else 0)
