# -*- coding: utf-8 -*-
"""Startup self-check CLI.

Builds the REAL executor from config (spawns MCP children, counts their tools),
runs the full self-check, writes logs/startup_selfcheck.json, and exits non-zero
on any hard failure so a launcher / CI step can refuse to serve a misconfigured
gateway.

This is the "startup layer" of the test strategy: it runs once, at boot, and is
cheap (a few TCP connects + tool counts). The launcher .bat can call it, or the
gateway calls it inline (see runtime/gateway.py).

Usage:
    python tools/startup_check.py [--config PATH] [--strict]
    exit 0 = all checks pass (or only warnings); 1 = hard failure
"""
from __future__ import annotations

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from selfcheck import run_selfcheck, format_report  # noqa: E402


def _load_servers(config_path: str):
    with open(config_path, "r", encoding="utf-8") as fh:
        raw = json.load(fh)
    servers = (raw.get("mcpServers") if isinstance(raw, dict) else None) or {}
    defaults = raw.get("mcp") if isinstance(raw, dict) else None
    return servers, defaults


def main() -> int:
    ap = argparse.ArgumentParser(description="Run the gateway startup self-check.")
    ap.add_argument("--config", default=os.path.join(ROOT, "config", "mcp_servers.json"))
    ap.add_argument("--strict", action="store_true",
                    help="treat warnings as failures too")
    ap.add_argument("--require-engine", action="store_true",
                    help="treat an unreachable upstream as a hard failure")
    args = ap.parse_args()

    # Build a real executor so the tool-count check reflects what actually spawned.
    executor = None
    try:
        from executor import Executor
        servers, defaults = _load_servers(args.config)
        executor = Executor(servers, defaults=defaults)
        executor.start_all()
    except Exception as e:
        print(f"[startup-check] could not build executor: {e}", file=sys.stderr)

    upstream = os.environ.get("STRATA_UPSTREAM_URL", "http://127.0.0.1:8080")
    rep = run_selfcheck(
        executor,
        upstream_url=upstream,
        web_dir=os.path.join(ROOT, "serve", "web"),
        config_path=args.config,
        require_engine=args.require_engine,
        source_root=ROOT,
    )
    if args.strict:
        rep["ok"] = rep["ok"] and rep["warnings"] == 0

    print(format_report(rep))

    log_dir = os.path.join(ROOT, "logs")
    os.makedirs(log_dir, exist_ok=True)
    try:
        with open(os.path.join(log_dir, "startup_selfcheck.json"), "w", encoding="utf-8") as fh:
            json.dump(rep, fh, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[startup-check] could not write report: {e}", file=sys.stderr)

    if executor is not None:
        try:
            executor.stop_all()
        except Exception:
            pass

    return 0 if rep["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
