"""Image generation end-to-end sentinel — live-if-up gate.

默认档（GPU快路径，CPU卸载不勾）真跑一张512，断言：
  - 返回非空 b64_json（base64 可解码为 PNG）
  - PNG 尺寸 == 512x512
  - 耗时 < 60s（宽松上界；实测~40s，因模型在E盘/temp在C盘跨卷只能copy，此IO为结构性代价）
  - 勾上 CPU 卸载的慢路径耗时 < 快路径 x 3（快基线~40s含copy，慢路径须同含copy，绝对值更高但比值锁不变）

如果 8099 网关不可达则 self-skip（exit 0），不阻塞 CI。

Usage:
    python tools/image_e2e_sentinel.py
    python tools/image_e2e_sentinel.py --require   # force live, fail if engine down
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import struct
import sys
import time
import urllib.request
import urllib.error

GATEWAY_URL = "http://127.0.0.1:8099"
PROMPT = "a small red apple on a white table, simple, centered"
SIZE = "512x512"
FAST_TIMEOUT_S = 60.0       # 宽松上界（实测~40s，含跨卷 staging copy 代价；旧12s基线=无staging前提已失效）
SLOW_RATIO_MAX = 3.0        # 慢路径/快路径 ≤3x（实测仅1.2x，给显存不足场景余量）


def _reachable(url: str, timeout: float = 3.0) -> bool:
    try:
        urllib.request.urlopen(url + "/v1/models", timeout=timeout)
        return True
    except Exception:
        return False


def _post(payload: dict, timeout: float = 120.0) -> dict:
    req = urllib.request.Request(
        f"{GATEWAY_URL}/v1/images/generations",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _post_strict(payload: dict, timeout: float = 120.0) -> dict:
    """_post, but a non-2xx from the built-in handler is a REAL bug -> clean FAIL (not silenced),
    surfacing the handler's JSON body (the actual sd-cli error). A pure transport failure
    (connection refused / timeout) means unreachable -> the reachability gate owns the skip.
    A 4xx is a client/contract problem -> also a real FAIL, not a skip."""
    req = urllib.request.Request(
        f"{GATEWAY_URL}/v1/images/generations",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:
            pass
        # server RESPONDED (we are reachable) -> any non-2xx is a real failure, keep it RED.
        raise AssertionError(f"gateway responded {e.code} (NOT a skip; built-in handler bug): {body[:400]}")
    except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
        # transport-only failure: the reachability gate already decided; surface as a clean FAIL
        raise AssertionError(f"gateway became unreachable mid-call (should have self-skipped): {e!r}")


def _png_dims(b64: str) -> tuple:
    raw = base64.b64decode(b64)
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise AssertionError(f"response is not PNG (got {raw[:8]!r})")
    w, h = struct.unpack(">II", raw[16:24])
    return (w, h)


def run_fast() -> float:
    payload = {"prompt": PROMPT, "size": SIZE, "response_format": "b64_json"}
    t0 = time.time()
    resp = _post_strict(payload)
    elapsed = time.time() - t0
    b64 = (resp.get("data") or [{}])[0].get("b64_json") or ""
    assert b64, "b64_json must be non-empty"
    dims = _png_dims(b64)
    assert dims == (512, 512), f"expected (512,512), got {dims}"
    assert elapsed < FAST_TIMEOUT_S, f"fast path took {elapsed:.1f}s > {FAST_TIMEOUT_S}s cap"
    print(f"  FAST  {elapsed:.1f}s  size={dims}  b64={len(b64)}")
    return elapsed


def run_slow() -> float:
    payload = {"prompt": PROMPT, "size": SIZE, "response_format": "b64_json",
               "cpu_offload": True}
    t0 = time.time()
    resp = _post_strict(payload)
    elapsed = time.time() - t0
    b64 = (resp.get("data") or [{}])[0].get("b64_json") or ""
    assert b64, "b64_json must be non-empty (slow path)"
    dims = _png_dims(b64)
    assert dims == (512, 512), f"expected (512,512), got {dims}"
    print(f"  SLOW  {elapsed:.1f}s  size={dims}  b64={len(b64)}")
    return elapsed


def main() -> int:
    ap = argparse.ArgumentParser(description="Image e2e sentinel (live-if-up)")
    ap.add_argument("--require", action="store_true",
                    help="fail if engine/gateway is down (no skip)")
    args = ap.parse_args()

    if not _reachable(GATEWAY_URL):
        if args.require:
            print("FAIL: gateway unreachable and --require was set")
            return 1
        print("SKIP: gateway unreachable (self-skip, not blocking)")
        return 0

    fast_t = run_fast()
    slow_t = run_slow()

    ratio = slow_t / fast_t if fast_t > 0 else 0
    print(f"\n  SLOW/FAST ratio = {ratio:.2f}x  (lock cap < {SLOW_RATIO_MAX}x)")

    if ratio > SLOW_RATIO_MAX:
        print(f"FAIL: ratio {ratio:.2f}x exceeds cap {SLOW_RATIO_MAX}x — 快慢分界漂移")
        return 1

    print("\nIMAGE E2E SENTINEL PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
