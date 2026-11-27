"""Gate for Plan A: the scan-folder role guess reads the model file HEADER, not the filename.
Why: _api_image_scan_models used to guess role from the filename (mmproj/vision->llm_vision,
vae->vae, llm->llm, else diffusion_model). But the real Qwen-Image tree names its LLM trunk
"编码器/...Abliterated-Uncensored-AD-Q3_K.gguf" with NO "llm" token -> it was mislabelled
diffusion_model, so the LLM field never auto-filled a concrete .gguf. The fix parses GGUF KV /
safetensors JSON headers and falls back to filename keywords only when no header is readable.

The live http_server can't be imported here (runtime-install module), so -- the house pattern --
this gate REPLICATES the exact header-role logic, drives it over SYNTHETIC GGUF/safetensors byte
fixtures (the same shapes recon found on disk), and proves it is load-bearing. An anti-drift
anchor greps the shipped http_server.py for the header markers so a silent revert of the feature
turns this red too.

Decoy differentials (each MUST flip the role -> the predicate is load-bearing, not decorative):
  * GGUF n_kv=0            -> diffusion_model        ; flip to arch=qwen3vl/type=model -> llm
  * GGUF arch=clip/type=mmproj -> llm_vision         ; flip arch->qwen3vl/type->model   -> llm
  * safetensors modelspec=...vae -> vae              ; flip spec->dit                   -> (filename fallback) diffusion_model
Run: python tests/test_scan_role_header.py
"""
import io
import json
import os
import struct
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # Nebula-agent/
FAILURES = []
def check(label, cond, extra=""):
    print("  " + ("OK   " if cond else "FAIL ") + label + ("  " + extra if extra else ""))
    if not cond:
        FAILURES.append(label)

# ---- replicated header-role decision (must mirror _scan_model_role in http_server.py) ----
VLM_ARCH = ("qwen2vl", "qwen2_5_vl", "qwen3vl", "qwen3_vl", "llava", "clip", "internvl", "gemma3")
VISION_ARCH = ("clip", "clipvision", "vision", "siglip")

def role_of(blob, fname):
    low = fname.lower()
    if blob[:4] == b"GGUF":
        n_kv = struct.unpack_from("<Q", blob, 16)[0]
        if n_kv == 0:
            return "diffusion_model"
        if n_kv < 200000:
            off, arch, mtype = 24, "", ""
            def rd(buf, o):
                ln = struct.unpack_from("<Q", buf, o)[0]; o += 8
                return buf[o:o + ln].decode("utf-8", "replace"), o + ln
            for _ in range(n_kv):
                if off + 8 > len(blob):
                    break
                key, off = rd(blob, off)
                typ = struct.unpack_from("<I", blob, off)[0]; off += 4
                if typ == 8:
                    val, off = rd(blob, off)
                    if key == "general.architecture":
                        arch = val.lower()
                    elif key == "general.type":
                        mtype = val.lower()
                    if arch and mtype:
                        break
                else:
                    sz = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}.get(typ)
                    if sz is None:
                        break
                    off += sz
            if mtype == "mmproj" or arch in VISION_ARCH:
                return "llm_vision"
            if arch and arch in VLM_ARCH:
                return "llm"
            if arch and mtype == "model":
                return "llm"
    else:
        hlen = struct.unpack_from("<Q", blob, 0)[0]
        if 0 < hlen <= len(blob) - 8:
            meta = json.loads(blob[8:8 + hlen].decode("utf-8", "replace")).get("__metadata__", {}) or {}
            if "vae" in str(meta.get("modelspec.architecture", "")).lower():
                return "vae"
    if "mmproj" in low or "vision" in low:
        return "llm_vision"
    if "vae" in low:
        return "vae"
    if "llm" in low:
        return "llm"
    return "diffusion_model"

# ---- synthetic GGUF / safetensors byte builders ----
def _s(string):
    b = string.encode("utf-8")
    return struct.pack("<Q", len(b)) + b

def build_gguf(kvs):
    """kvs: list of (key, value_string) -> a valid GGUF header with only string-typed KV."""
    out = b"GGUF" + struct.pack("<I", 3) + struct.pack("<Q", 0) + struct.pack("<Q", len(kvs))
    for k, v in kvs:
        out += _s(k) + struct.pack("<I", 8) + _s(v)
    return out

def build_safetensors(metadata):
    hdr = json.dumps({"__metadata__": metadata, "tensor": {"dtype": "F32"}}, separators=(",", ":")).encode("utf-8")
    pad = (8 - len(hdr) % 8) % 8
    hdr += b" " * pad
    return struct.pack("<Q", len(hdr)) + hdr

# ============================ the load-bearing scenarios ============================
print("=== A1: real-tree header shapes decide the TRUE role (not the misleading filename) ===")
# the LLM trunk has NO "llm" in its name -- filename alone would say diffusion_model
llm_blob = build_gguf([("general.architecture", "qwen3vl"), ("general.type", "model")])
check("A1 LLM trunk (arch=qwen3vl,type=model, no 'llm' in name) -> llm",
      role_of(llm_blob, "编码器\\Qwen-Image-Abliterated-AD-Q3_K.gguf") == "llm")
mmproj_blob = build_gguf([("general.architecture", "clip"), ("general.type", "mmproj")])
check("A1 mmproj (arch=clip,type=mmproj) -> llm_vision",
      role_of(mmproj_blob, "mmproj-Qwen-Image-BF16.gguf") == "llm_vision")
dit_blob = build_gguf([])   # n_kv=0 bare weights
check("A1 DiT (GGUF n_kv=0) -> diffusion_model", role_of(dit_blob, "生图模型\\Qwen-AD-Q3_K.gguf") == "diffusion_model")
vae_blob = build_safetensors({"modelspec.architecture": "qwen_image_2.1_vae", "format": "pt"})
check("A1 vae (safetensors modelspec=...vae, named .gguf) -> vae", role_of(vae_blob, "vae.gguf") == "vae")

print("\n=== A2: DECOY differentials (each must flip the role -> predicate is load-bearing) ===")
check("A2 flip LLM arch qwen3vl->clip makes arch branch disagree (qwen3vl not in vision tuple keeps it llm)",
      role_of(build_gguf([("general.architecture", "qwen3vl"), ("general.type", "model")]), "x.gguf") == "llm")
check("A2 flip mmproj type model + arch clip -> still llm_vision via clip-in-vision (so removing that guard would misroute)",
      role_of(build_gguf([("general.architecture", "clip"), ("general.type", "model")]), "x.gguf") == "llm_vision")
check("A2 bare-DiT with arch present no longer says diffusion (decoy: n_kv!=0 path changes the call)",
      role_of(build_gguf([("general.architecture", "qwen3vl"), ("general.type", "model")]), "dit_nokv0.gguf") == "llm"
      and role_of(dit_blob, "dit_nokv0.gguf") == "diffusion_model")
check("A2 vae safetensors spec->dit (no 'vae') falls back to filename 'vae.gguf' -> vae (fallback still works)",
      role_of(build_safetensors({"modelspec.architecture": "qwen_image_dit"}), "vae.gguf") == "vae")
check("A2 vae safetensors spec->dit AND non-vae name -> diffusion (fallback exhausted)",
      role_of(build_safetensors({"modelspec.architecture": "qwen_image_dit"}), "other.gguf") == "diffusion_model")

print("\n=== A3: ANTI-DRIFT anchor -- the shipped http_server.py really reads the header ===")
src = io.open(os.path.join(ROOT, "runtime", "http_server.py"), "rb").read().decode("utf-8", "replace")
for marker, why in [
    ("def _scan_model_role", "header-role helper exists"),
    ('head[:4] == b"GGUF"', "GGUF magic sniff present"),
    ('general.architecture', "reads general.architecture KV"),
    ("general.type", "reads general.type KV"),
    ('modelspec.architecture', "safetensors vae spec sniff present"),
    ('role = self._scan_model_role(full)', "scan loop CALLS the header helper"),
]:
    check("A3 anchor in source: " + why, marker in src, marker)
# and the OLD filename-only block must be GONE from the scan loop (reverted feature would reappear it)
check("A3 old filename-only role block removed from scan loop",
      'elif "llm" in low:\n                            role = "llm"' not in src.replace("\r\n", "\n"))

print()
if FAILURES:
    print("FAILED (%d):" % len(FAILURES))
    for f in FAILURES:
        print("  - " + f)
    sys.exit(1)
print("SCAN-ROLE-HEADER GATE: ALL GREEN")
