# -*- coding: utf-8 -*-
"""Per-card GPU capability scores used to pick a card / split layers (the selection layer).

Split out of serve/server.py (refactor plan-B block 6, 2026-11-17): two functions that
share one concept -- producing a `dict[int, float]` "how fast is each card" score, keyed
the way nvidia-smi numbers them, to be fed into card selection.  NVIDIA (CUDA multiprocessors
x max clock, via the CUDA driver API -- no toolkit needed) and AMD (KFD topology SIMDs x max
engine clock) are the two ends of the same job.  AST analysis proved they close over only the
stdlib (os/sys/subprocess) -- no engine / session state and, unlike gpu_vram_mib, no lazy
first-party import.  (gpu_vram_mib was deliberately left behind: it lazy-imports serve.telemetry,
so it is NOT a pure leaf despite the name-based scan -- the known false-positive trap.)
server.py re-imports the names unchanged, so both call sites stay untouched.

This is an equivalence move, not a rewrite: the function bodies are byte-for-byte the
originals -- they are extracted from server.py here rather than re-typed, so the embedded
child-process code strings (full of literal \n) survive exactly.
"""
import os
import sys
import subprocess


def gpu_speed_scores(indices: list[int]) -> dict[int, float] | None:
    """Multiprocessors x max clock for each NVIDIA card, numbered as nvidia-smi numbers them (the CUDA driver API,
    which every driver ships: no toolkit needed); None when it cannot say for every one of them."""
    code = (
        "import ctypes,sys,os\n"
        "os.environ['CUDA_DEVICE_ORDER']='PCI_BUS_ID'\n"
        "lib=ctypes.CDLL('nvcuda.dll' if os.name=='nt' else 'libcuda.so.1')\n"
        "assert lib.cuInit(0)==0\n"
        "n=ctypes.c_int()\n"
        "assert lib.cuDeviceGetCount(ctypes.byref(n))==0\n"
        "for i in range(n.value):\n"
        "    d=ctypes.c_int()\n"
        "    assert lib.cuDeviceGet(ctypes.byref(d),i)==0\n"
        "    sm=ctypes.c_int(); mhz=ctypes.c_int()\n"
        "    lib.cuDeviceGetAttribute(ctypes.byref(sm),16,d)\n"
        "    lib.cuDeviceGetAttribute(ctypes.byref(mhz),13,d)\n"
        "    print(i,sm.value,mhz.value)\n")
    try:
        env = dict(os.environ)
        env["CUDA_DEVICE_ORDER"] = "PCI_BUS_ID"
        env.pop("CUDA_VISIBLE_DEVICES", None)
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=30, env=env)
        got = {}
        for line in r.stdout.splitlines():
            i, sm, khz = (int(x) for x in line.split())
            got[i] = float(sm) * float(khz)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    return got if all(i in got and got[i] > 0 for i in indices) else None

def hip_speed_scores(indices: list[int], root: str = "/sys/class/kfd/kfd/topology/nodes") -> dict[int, float] | None:
    """AMD on Linux: SIMDs x max engine clock of each card, from the KFD topology (the order setup and the engine use
    for "gpu" there: the GPU nodes in node order).  None when the files are not there (Windows, no ROCm driver)."""
    try:
        nodes = sorted((int(n) for n in os.listdir(root) if n.isdigit()))
    except OSError:
        return None
    cards = []
    for n in nodes:
        try:
            props = dict(line.split() for line in open(os.path.join(root, str(n), "properties")) if len(line.split()) == 2)
            simd, clk = int(props.get("simd_count", 0)), int(props.get("max_engine_clk_fcompute", 0))
        except (OSError, ValueError):
            continue
        if simd > 0:
            cards.append(float(simd) * float(clk or 1))
    got = dict(enumerate(cards))
    return got if all(i in got for i in indices) else None
