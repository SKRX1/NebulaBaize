#!/usr/bin/env python3
"""Upgrade check: verify Strata's API endpoints after a Strata upgrade.

Run this once after Strata is upgraded. It confirms the endpoints this plugin depends on
are alive and that the tool namespace still works. It does NOT modify anything.

It also checks that the host multimodal patch (see tools/apply_host_patch.py) is still
in place: a Strata upgrade rewrites serve/ and wipes it, so this is your early warning
to re-run tools/apply_host_patch.py (or deploy_host_patch.bat).

    python tools/upgrade_check.py [--port 8080]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

ENDPOINTS = ["/v1/chat/completions", "/v1/messages", "/health", "/mcp"]

# the host-patch self-check lives next to this script
HOST_PATCH = Path(__file__).resolve().parent / "apply_host_patch.py"


def check(port: int) -> int:
    base = f"http://127.0.0.1:{port}"
    ok = True
    for ep in ENDPOINTS:
        try:
            req = urllib.request.Request(base + ep, method="GET")
            with urllib.request.urlopen(req, timeout=10) as r:
                status = r.getcode()
            print(f"  [ok] {ep} -> {status}")
        except Exception as e:
            # chat/completions/messages are POST; GET may 405 but that still means "alive"
            if isinstance(e, urllib.error.HTTPError) and e.code in (400, 404, 405):
                print(f"  [ok] {ep} -> {e.code} (alive, method differs)")
            else:
                print(f"  [MISSING] {ep} -> {e}")
                ok = False

    # host multimodal patch status (parasite-mode image viewing); offline, no server needed
    print("  --- host multimodal patch ---")
    if HOST_PATCH.exists():
        try:
            r = subprocess.run([sys.executable, str(HOST_PATCH), "--check"],
                               capture_output=True, text=True, timeout=30)
            for line in (r.stdout or "").splitlines():
                print("    " + line)
            if r.returncode != 0:
                print("    [ACTION] re-run tools/apply_host_patch.py (or deploy_host_patch.bat)")
                ok = False
        except Exception as e:
            print(f"    [warn] patch check could not run: {e}")
    else:
        print(f"    [warn] {HOST_PATCH.name} not found next to this script")

    print("Upgrade check:", "ALL PRESENT" if ok else "SOME ACTION NEEDED - see above")
    return 0 if ok else 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080)
    sys.exit(check(ap.parse_args().port))
