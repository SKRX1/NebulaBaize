r"""Shared parallelism probe (2026-10-30, plan A "tiered probe").

ONE probe serves every parallel consumer so the numbers never drift between the
test runner, the recycle pool and the UI chip:

    cores            -> len(os.sched_getaffinity(0)) where it exists (Linux),
                        else os.cpu_count() (Windows has no affinity API).
    tests            -> floor(cores * 0.6), capped at 16   (run_tests.py)
    recycle workers  -> floor(cores * 0.4), capped at 8    (http_server recycle pool)
    recycle batch    -> fixed 8                            (design decision, not adaptive)

psutil is OPTIONAL and only ever used as a memory cap when present. The test
runner runs on plain python where psutil is NOT installed (verified on this
machine), so the probe must be stdlib-only on that path; import psutil lazily
and degrade silently. psutil is never a hard dependency here.

Precedence, highest wins:
    explicit env override  >  factor table  >  minimum 1
  env names: STRATA_TESTS_WORKERS, STRATA_RECYCLE_WORKERS, STRATA_RECYCLE_BATCH.

Deterministic contract, locked by tests/test_parallel_probe.py:
  on THIS machine (12 logical cores) the probe must reproduce the numbers the
  system was tuned with: tests=7, recycle_workers=4, recycle_batch=8.

Run from the Nebula-agent folder:
    python runtime\parallel_probe.py        # prints the probe result
"""
from __future__ import annotations

import math
import os

# factor table (plan A) -> (factor, cap). Kept as data so the differential half
# of the gate can prove the numbers move when a factor moves.
FACTORS = {
    "tests": (0.6, 16),
    "recycle_workers": (0.4, 8),
}
RECYCLE_BATCH_FIXED = 8

ENV_OVERRIDE = {
    "tests": "STRATA_TESTS_WORKERS",
    "recycle_workers": "STRATA_RECYCLE_WORKERS",
    "recycle_batch": "STRATA_RECYCLE_BATCH",
}


def probe_cores() -> int:
    """Usable logical cores, affinity-aware where the OS supports it."""
    fallback = max(1, os.cpu_count() or 1)          # every path must return a real number
    if hasattr(os, "sched_getaffinity"):            # Linux/posix
        try:
            n = len(os.sched_getaffinity(0))
            if n > 0:
                return n
        except OSError:
            return fallback                         # affinity unsupported -> cpu_count fallback
    return fallback
def memory_cap(cores: int) -> int:
    """Optional psutil memory guard: never more workers than fits in RAM.

    One in-flight parallel unit (a full test process / a PowerShell batch) is
    budgeted at MEM_PER_UNIT_GB. psutil is optional BY DESIGN — plain python
    on this machine has no psutil, so absence is the normal path, not an error.
    """
    try:
        import psutil                             # optional, never required
    except ImportError:
        return cores
    MEM_PER_UNIT_GB = 2.0
    avail_gb = psutil.virtual_memory().available / (1024 ** 3)
    return max(1, min(cores, int(avail_gb // MEM_PER_UNIT_GB)))


def compute(loads: str, cores: int | None = None) -> int:
    """The one number for one load on one machine. Precedence: env > factor."""
    env_name = ENV_OVERRIDE[loads]
    raw = os.environ.get(env_name)
    if raw:                                         # explicit override wins, always
        v = int(raw)
        return max(1, v)
    if loads == "recycle_batch":
        return RECYCLE_BATCH_FIXED
    factor, cap = FACTORS[loads]
    cores = probe_cores() if cores is None else max(1, int(cores))
    # floor on purpose: recycle floor(12*0.4)=4 reproduces the tuned value the
    # system ran with for weeks. round() would give 5 and break that contract.
    n = math.floor(cores * factor)
    n = memory_cap(n)                               # psutil only when installed
    return max(1, min(cap, n))


def probe() -> dict:
    """Full snapshot for the API endpoint and the UI chip (JSON-safe)."""
    cores = probe_cores()
    out = {"cores": cores, "psutil": _psutil_present(), "loads": {}}
    for load in ("tests", "recycle_workers", "recycle_batch"):
        out["loads"][load] = {
            "value": compute(load, cores),
            "factor": FACTORS[load][0] if load in FACTORS else None,
            "cap": FACTORS[load][1] if load in FACTORS else None,
            "override_env": ENV_OVERRIDE[load],
            "overridden": bool(os.environ.get(ENV_OVERRIDE[load])),
        }
    return out


def _psutil_present() -> bool:
    try:
        import psutil                               # noqa: F401
        return True
    except ImportError:
        return False


if __name__ == "__main__":
    import json
    print(json.dumps(probe(), indent=2))
