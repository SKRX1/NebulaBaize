# -*- coding: utf-8 -*-
"""Contract gate: websearch download proxy-unreachable -> direct-retry + operator log.

Root cause it locks (2026-11): _fetch_bytes used to be proxy-only with NO fallback, so a
dead/absent proxy made every download fail opaquely. The fix tries the proxy first and,
when it is unreachable OR its backend is unavailable (socks scheme without PySocks),
prints ONE stderr log line and retries direct -- so operators can later distinguish
"proxy up" vs "proxy down" from the log, and a broken proxy no longer blocks downloads.

No network: _fetch_bytes_via is monkeypatched per scenario; _proxy_parts is stubbed. The
assertions are about control flow (did it fall back?) and the log text (ASCII-matched
only; Chinese is display, never a match target, per house rule).

Scenarios:
  R1  proxy raises (ConnectionRefused)  -> falls back to direct, log has "unreachable" + "retrying direct"
  R2  proxy opener None (socks no PySocks) -> falls back to direct, log has "backend unavailable"
  R3  proxy works (returns bytes)       -> uses proxy, NO fallback log, direct never called
  R4  no proxy configured               -> straight to direct, no proxy attempt

Run: python tests/test_websearch_proxy_retry.py
"""
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "servers"))
import websearch_server as W  # noqa: E402

FAILURES = []


def check(label, cond, extra=""):
    print(("  OK   " if cond else "  FAIL ") + label + (("  " + extra) if extra else ""))
    if not cond:
        FAILURES.append(label)


class _RaisingOpener:
    def __init__(self, exc):
        self._exc = exc

    def open(self, req, timeout=30):
        raise self._exc


def run_case(proxy_ret, via_behaviour):
    """Return (result_bytes, stderr_text, direct_called).

    via_behaviour: a callable (url, headers, proxy) -> bytes/None/raise, modelling
    _fetch_bytes_via's outcome. The proxy attempt and the direct retry both go through it,
    so we record which proxy value each call saw.
    """
    seen = {"direct": False, "proxy": False}
    orig_parts, orig_via, orig_err = W._proxy_parts, W._fetch_bytes_via, sys.stderr
    W._proxy_parts = lambda: proxy_ret

    def via(url, headers, proxy):
        if proxy is None:
            seen["direct"] = True
        else:
            seen["proxy"] = True
        return via_behaviour(url, headers, proxy)

    W._fetch_bytes_via = via
    buf = io.StringIO()
    try:
        sys.stderr = buf
        result = W._fetch_bytes("https://example.com/img.png")
    finally:
        W._proxy_parts, W._fetch_bytes_via, sys.stderr = orig_parts, orig_via, orig_err
    return result, buf.getvalue(), seen


# R1 proxy raises -> direct fallback + unreachable log
res, err, seen = run_case("http://127.0.0.1:1",
                          lambda u, h, p: (_ for _ in ()).throw(ConnectionRefusedError("refused"))
                          if p is not None else b"DIRECT_BYTES")
check("R1 unreachable proxy falls back to direct", res == b"DIRECT_BYTES", repr(res))
check("R1 proxy was attempted first", seen["proxy"] and seen["direct"])
check("R1 log says unreachable", "unreachable" in err, repr(err))
check("R1 log says retrying direct", "retrying direct" in err, repr(err))
check("R1 log carries exception type", "ConnectionRefusedError" in err, repr(err))

# R2 proxy opener unavailable (None) -> backend-unavailable log + fallback
res, err, seen = run_case("socks5://127.0.0.1:1080",
                          lambda u, h, p: None if p is not None else b"DIRECT_BYTES")
check("R2 unavailable backend falls back to direct", res == b"DIRECT_BYTES", repr(res))
check("R2 log says backend unavailable", "backend unavailable" in err, repr(err))
check("R2 log says retrying direct", "retrying direct" in err, repr(err))

# R3 proxy works -> uses proxy, no fallback, direct never tried
res, err, seen = run_case("http://127.0.0.1:7890",
                          lambda u, h, p: b"PROXY_BYTES" if p is not None else b"DIRECT_BYTES")
check("R3 working proxy used", res == b"PROXY_BYTES", repr(res))
check("R3 direct never tried when proxy works", seen["direct"] is False)
check("R3 no fallback log", err.strip() == "", repr(err))

# R4 no proxy -> straight to direct, proxy never attempted
res, err, seen = run_case(None, lambda u, h, p: b"DIRECT_BYTES")
check("R4 no proxy -> direct", res == b"DIRECT_BYTES", repr(res))
check("R4 proxy never attempted", seen["proxy"] is False)
check("R4 no fallback log", err.strip() == "", repr(err))

print("\n" + ("WEBSEARCH-PROXY-RETRY: ALL PASSED" if not FAILURES
              else "WEBSEARCH-PROXY-RETRY: SOME FAILED " + str(FAILURES)))
sys.exit(1 if FAILURES else 0)
