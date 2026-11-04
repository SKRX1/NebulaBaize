# -*- coding: utf-8 -*-
"""Differential gate for the local /metrics fallback (custom-mode Monitor page).

Root cause it locks (the "Monitor page froze once I picked an online API model" report):
the Monitor renders from ONE JSON contract, the upstream engine's own /metrics. A custom
model routes chat through THIS gateway's agent loop, so the default upstream (8080) never
sees the request -- a proxy failure used to return 502, renderMonitor was never called, and
the whole page went blank. The fix: on a GET /metrics proxy failure, return a LOCAL
aggregate of the gateway's own request ring (the agent loop records every chunk here).

Two pieces are pinned as DIFFERENTIALS (each needs the opposite to prove the input that
drives it actually drives it):

aggregate_local_metrics() -- the ring -> contract mapper:
  * last event content + FRESH   -> generating   (a live turn)
  * last event thinking + FRESH  -> reading      <- same freshness, different type => TYPE drives it
  * last event content + STALE   -> idle         <- same type, different freshness => FRESHNESS drives it
  * empty ring                 -> idle, 0 requests
  * two records, newest appended LAST -> requests[0] is the NEWEST (the row the UI treats as "last")
  * a usage event WITH token counts fills the live token; one WITHOUT leaves it honest-empty

_read_local_hardware() -- the gateway's own box, so the Monitor is not blank on a remote model:
  * nvidia-smi HAS a GPU  -> util/temp/power/pcie/name are real, VRAM scaled MiB->bytes
  * nvidia-smi reads NONE -> hardware dict is empty  <- a GPU-less box shows a dash, not a number
  * CPU/RAM/disk come from psutil when present; when psutil is absent they stay
    absent <- honesty: never invented, only read (differential on psutil availability)

Hardware reads are injected (the parser is monkeypatched) so the gate is reproducible on a
machine with or without a GPU. Assertions match only ASCII category strings (pure standard
library; registers in tools/run_tests.py).
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import http_server  # noqa: E402
from http_server import GatewayState  # noqa: E402

fails = []


def check(name, cond, extra=""):
    print(("OK   " if cond else "FAIL ") + name + ((" -> " + extra) if extra else ""))
    if not cond:
        fails.append(name)


def fresh_state():
    # __init__ needs an upstream_url only; no executor is touched by the aggregator.
    return GatewayState("http://127.0.0.1:1")


def rec(timeline, started=1700000000.0, first=None):
    # mirror begin_request's field shape so the aggregator only sees what the real ring stores
    return {"id": "x", "path": "/v1/chat/completions", "model": "m", "session_id": None,
            "started_at": started, "state": "queued", "stream": True,
            "chunk_timeline": timeline, "chunk_timeline_truncated": False,
            "queue_s": 0.0, "load_s": 0.0, "first_token_s": first, "_clock": 1000.0}


# ── Differential: last-event TYPE drives live.state (freshness held constant) ──
s = fresh_state(); s.api_requests.append(rec([{"t": 0.5, "type": "content", "bytes": 10}]))
check("content + FRESH -> generating", s.aggregate_local_metrics()["live"]["state"] == "generating")

s = fresh_state(); s.api_requests.append(rec([{"t": 0.5, "type": "thinking", "bytes": 10}]))
check("thinking + FRESH -> reading (same freshness, type drives it)",
      s.aggregate_local_metrics()["live"]["state"] == "reading")

# ── Differential: FRESHNESS drives idle (type held constant at content) ──
s = fresh_state(); s.api_requests.append(rec([{"t": 999.0, "type": "content", "bytes": 10}]))
check("content + STALE -> idle (same type, freshness drives it)",
      s.aggregate_local_metrics()["live"]["state"] == "idle")

# ── Empty ring: idle, no requests ──
s = fresh_state()
out = s.aggregate_local_metrics()
check("empty ring -> idle", out["live"]["state"] == "idle")
check("empty ring -> 0 requests", out["requests"] == [])

# ── Recent-requests: row count + NEWEST FIRST (the row renderMonitor treats as "last") ──
s = fresh_state()
s.api_requests.append(rec([{"t": 1.0, "type": "content", "bytes": 10}], started=1700000100.0))  # older
s.api_requests.append(rec([{"t": 0.4, "type": "content", "bytes": 10}], started=1700000900.0))  # newer
out = s.aggregate_local_metrics()
check("two records -> two rows", len(out["requests"]) == 2)
check("requests_kept reports the row count", out["requests_kept"] == 2)
check("rows newest-first: requests[0] is the NEWER record",
      out["requests"][0]["time"] == 1700000900.0)
check("rows newest-first: requests[1] is the OLDER record",
      out["requests"][1]["time"] == 1700000100.0)

# ── A usage event WITH token counts fills live tokens; one WITHOUT leaves them absent ──
s = fresh_state()
s.api_requests.append(rec([{"t": 0.3, "type": "usage", "bytes": 20,
                            "prompt_tokens": 512, "output_tokens": 128}]))
live = s.aggregate_local_metrics()["live"]
check("usage WITH tokens fills live.prompt_tokens", live.get("prompt_tokens") == 512)
check("usage WITH tokens fills live.generated", live.get("generated") == 128)

s = fresh_state()
s.api_requests.append(rec([{"t": 0.3, "type": "usage", "bytes": 20}]))  # bytes only, no token counts
live = s.aggregate_local_metrics()["live"]
check("usage WITHOUT token counts stays honest-empty",
      "prompt_tokens" not in live and "generated" not in live)

# ── first_token_s: taken from the real field when present, else the first content-type event ──
s = fresh_state()
s.api_requests.append(rec([{"t": 2.0, "type": "content", "bytes": 10}], first=1.5))
check("first_token_s from the explicit field",
      s.aggregate_local_metrics()["live"]["first_token_s"] == 1.5)

# ── The source marker is present so a future UI can label the aggregate ──
check("aggregate is tagged source=local", fresh_state().aggregate_local_metrics().get("source") == "local")

# ── Hardware: the gateway reads its OWN box so the Monitor is not blank on a remote model ──
_ORIG_PARSER = http_server._read_nvidia_gpu


def _reset_cache():
    http_server._HW_CACHE = None


try:
    # Differential: a GPU the parser CAN see lights the cards with real, unit-correct numbers
    def _fake_gpu_present():
        return [{"index": 0, "name": "Test GPU", "utilization.gpu": 50,
                 "memory.used": 1000, "memory.total": 2000, "temperature.gpu": 60,
                 "power.draw": 120, "power.limit": 250,
                 "pcie.link.gen.current": 3, "pcie.link.width.current": 16}]

    http_server._read_nvidia_gpu = _fake_gpu_present
    _reset_cache()
    hw = http_server._read_local_hardware()
    check("GPU present -> gpu_util is the real reading", hw["hardware"].get("gpu_util") == 50)
    check("GPU present -> VRAM scaled MiB->bytes", hw["hardware"].get("gpu_mem_used") == 1000 * 1048576)
    check("GPU present -> temp is the real reading", hw["hardware"].get("gpu_temp") == 60)
    check("GPU present -> pcie headline is the real reading", hw["hardware"].get("gpu_pcie_gen_max") == 3)
    check("GPU present -> gpu_name carried", hw["hardware_static"].get("gpu_name") == "Test GPU")
    # Differential on psutil availability: present -> cpu/ram are real readings;
    # absent -> they stay honest-empty (never invented). Disk rate needs 2 samples
    # so it is absent on the first read either way (differential is honest about it).
    if http_server.psutil is not None:
        check("psutil present -> cpu is a real reading",
              isinstance(hw["hardware"].get("cpu"), (int, float)))
        check("psutil present -> ram_total is a real positive byte count",
              isinstance(hw["hardware"].get("ram_total"), int) and hw["hardware"]["ram_total"] > 0)
        check("psutil present -> ram_used is a real positive byte count",
              isinstance(hw["hardware"].get("ram_used"), int) and hw["hardware"]["ram_used"] > 0)
        check("psutil present -> disk_read_mb real number when present, else absent (never fabricated)",
              "disk_read_mb" not in hw["hardware"]
              or isinstance(hw["hardware"]["disk_read_mb"], (int, float)))
    else:
        check("psutil absent -> cpu/ram/disk never invented",
              "cpu" not in hw["hardware"] and "ram_total" not in hw["hardware"]
              and "disk_read_mb" not in hw["hardware"])

    # Differential: a GPU-less box (parser sees none) shows a dash, not a number
    http_server._read_nvidia_gpu = lambda: []
    _reset_cache()
    hw_empty = http_server._read_local_hardware()
    # Differential: a GPU-less box shows a dash on the GPU cards, not a number.
    # When psutil IS present the non-GPU fields (cpu/ram) may legitimately carry
    # real readings; the honesty lock here is that the GPU fields themselves stay absent.
    _no_gpu = hw_empty["hardware"]
    if http_server.psutil is None:
        check("GPU absent + no psutil -> hardware dict is honest-empty", _no_gpu == {})
    else:
        check("GPU absent -> GPU fields stay absent (no fabricated number)",
              "gpus" not in _no_gpu and "gpu_util" not in _no_gpu
              and "gpu_mem_used" not in _no_gpu)
        check("GPU absent -> psutil cpu/ram still real (not GPU-fabricated)",
              isinstance(_no_gpu.get("cpu"), (int, float)))
    check("GPU absent -> hardware_static is honest-empty", hw_empty["hardware_static"] == {})

    # The aggregate carries whatever its own hardware read (here: present -> populated)
    http_server._read_nvidia_gpu = _fake_gpu_present
    _reset_cache()
    s = fresh_state()
    agg = s.aggregate_local_metrics()
    check("aggregate wires the hardware reader through", agg["hardware"].get("gpu_util") == 50)
finally:
    http_server._read_nvidia_gpu = _ORIG_PARSER
    _reset_cache()

if fails:
    print("\nFAILED: " + ", ".join(fails))
    sys.exit(1)
print("\nALL LOCAL-METRICS-FALLBACK TESTS PASSED")
