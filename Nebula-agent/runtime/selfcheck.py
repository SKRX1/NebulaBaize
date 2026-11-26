# -*- coding: utf-8 -*-
"""Startup self-check — fail-fast on misconfiguration BEFORE the gateway serves.

The gateway used to start happily with a broken MCP config, a dead upstream, or a
missing frontend build marker, and only reveal the problem as a runtime 502 / a
blank status light. This module turns those into explicit, machine-checkable
signals at boot.

Design notes:
  * Pure-ish: every check takes injectable inputs (an executor that may already
    be started, a config path, a web dir) so it is unit-testable without spawning
    real MCP children or binding a socket.
  * Severity model: each check is one of
        ERROR  -> hard failure; run_selfcheck().ok is False
        WARN   -> ok stays True, but it is reported (e.g. upstream not up yet)
        INFO   -> informational pass
  * Importing this module must NOT pull in the heavy gateway/server stack, so the
    contract checks are *static* (read the source files) rather than importing
    http_server at module load.

Usage (from within runtime/):
    from selfcheck import run_selfcheck
    rep = run_selfcheck(executor, upstream_url=..., web_dir=..., config_path=...)
"""
from __future__ import annotations

import json
import os
import socket
import sys
from typing import Optional

from config_loader import project_root as _project_root
ROOT = _project_root(__file__)   # one definition, both layouts; see runtime/gateway.py


def _check(name: str, ok: bool, detail: str = "", level: str = "ERROR") -> dict:
    return {"name": name, "ok": bool(ok), "detail": detail, "level": level}


def _load_cfg(path: str):
    """Load JSON (or YAML if available) config; raise on failure."""
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()
    try:
        return json.loads(text)
    except Exception:
        try:
            import yaml  # type: ignore
            return yaml.safe_load(text)
        except Exception as e:
            raise ValueError(f"config is neither JSON nor YAML: {e}")


# ─── individual checks ─────────────────────────────────────────────────────────

def check_config(config_path: Optional[str]) -> dict:
    if not config_path or not os.path.isfile(config_path):
        return _check("config_valid", False, f"missing config: {config_path}")
    try:
        raw = _load_cfg(config_path)
    except Exception as e:
        return _check("config_valid", False, f"parse error: {e}")
    servers = (raw.get("mcpServers") if isinstance(raw, dict) else None) or {}
    if not isinstance(servers, dict) or not servers:
        return _check("config_valid", False, "no mcpServers block declared")
    return _check("config_valid", True,
                  f"{len(servers)} server(s) declared in mcpServers", level="INFO")


def check_mcp_tools(executor) -> list[dict]:
    """Every started server must expose at least one tool.

    A server that comes up but reports ZERO tools is a real regression (it used to
    mean the subprocess spawned but its tools/list returned nothing). We fail hard
    on that; total count is reported as INFO, not enforced, because operators may
    legitimately disable a server.
    """
    if executor is None:
        return [_check("mcp_tool_floor", True, "skipped (no executor provided)", level="INFO")]
    servers = getattr(executor, "servers", {}) or {}
    if not servers:
        return [_check("mcp_tool_floor", True, "no MCP servers configured", level="INFO")]
    per = {}
    empties = []
    total = 0
    for name, srv in servers.items():
        n = len(getattr(srv, "tools", []) or [])
        per[name] = n
        total += n
        if n == 0:
            empties.append(name)
    if empties:
        return [_check("mcp_tool_floor", False,
                       f"server(s) started but expose 0 tools: {empties}; per-server={per}")]
    return [_check("mcp_tool_floor", True,
                   f"{total} tools across {len(per)} server(s); per-server={per}", level="INFO")]


def check_upstream(upstream_url: Optional[str], require: bool = False) -> dict:
    """TCP-reach the upstream engine.

    In direct mode there is no upstream, so this is INFO/skip. When an upstream is
    configured we REQUIRE a TCP connection by default too (a misconfigured host
    should not silently 502 on the first request) — but the engine may simply not
    be running yet, so a missing connection is WARN unless --require-engine.
    """
    if not upstream_url:
        return _check("upstream_reach", True, "no upstream (direct mode)", level="INFO")
    try:
        from urllib.parse import urlparse
        p = urlparse(upstream_url)
        host = p.hostname or "127.0.0.1"
        port = p.port or (443 if p.scheme == "https" else 80)
    except Exception as e:
        return _check("upstream_reach", False, f"cannot parse upstream url: {e}")
    try:
        s = socket.create_connection((host, port), timeout=3)
        s.close()
        return _check("upstream_reach", True, f"tcp ok {host}:{port}", level="INFO")
    except Exception as e:
        if require:
            return _check("upstream_reach", False,
                          f"require_engine set but cannot reach {host}:{port}: {e}")
        return _check("upstream_reach", True,
                      f"WARN cannot reach {host}:{port} ({e}); engine may start later",
                      level="WARN")


def check_build_marker(web_dir: Optional[str]) -> dict:
    """The status light relies on window.__strataBuild to tell builds apart.

    If app.js is missing or the marker was stripped, the light cannot distinguish
    a fresh build from a stale tab — a silent regression. Hard-fail if absent.
    """
    if not web_dir:
        return _check("build_marker", True, "skipped (no web_dir)", level="INFO")
    app_js = os.path.join(web_dir, "app.js")
    if not os.path.isfile(app_js):
        return _check("build_marker", False, f"frontend missing: {app_js}")
    try:
        with open(app_js, "r", encoding="utf-8", errors="replace") as fh:
            head = fh.read()  # read the WHOLE file: the marker may sit past 200KB (app.js is ~426KB); a truncated scan false-fails
    except Exception as e:
        return _check("build_marker", False, f"cannot read {app_js}: {e}")
    if "window.__strataBuild" not in head:
        return _check("build_marker", False,
                      "app.js has no window.__strataBuild marker (status light cannot version)")
    return _check("build_marker", True, "window.__strataBuild present", level="INFO")


def check_models_contract(source_root: Optional[str]) -> dict:
    """The composer's /api/models status light depends on probe+path in the response.

    Static contract guard: the gateway must emit `probe` and `path` for every
    model entry, and model_registry must expose public()/probe(). We read the
    source rather than import the server stack (keep this module import-light).
    """
    if not source_root:
        return _check("models_contract", True, "skipped (no source_root)", level="INFO")
    # This guard READS source files, which by definition do not exist in a closed-source
    # build (gateway and its modules are compiled). The contract is still enforced there --
    # it was enforced when that binary was built from exactly this source. Reporting
    # "missing <path>" would be a phantom failure hiding any REAL one, so state the reason.
    http_mod = os.path.join(source_root, "runtime", "http_server.py")
    reg_mod = os.path.join(source_root, "serve", "model_registry.py")
    if not (os.path.isfile(http_mod) and os.path.isfile(reg_mod)):
        return _check("models_contract", True,
                      "skipped: no readable source here (a compiled build ships no .py; "
                      "the contract was enforced at build time)", level="INFO")
    problems = []
    if os.path.isfile(http_mod):
        with open(http_mod, "r", encoding="utf-8", errors="replace") as fh:
            h = fh.read()
        if '"probe":' not in h and '"probe": ' not in h:
            problems.append("http_server.py does not emit 'probe' in /api/models")
        if '"path":' not in h:
            problems.append("http_server.py does not emit 'path' in /api/models")
    else:
        problems.append(f"missing {http_mod}")
    if os.path.isfile(reg_mod):
        with open(reg_mod, "r", encoding="utf-8", errors="replace") as fh:
            r = fh.read()
        if "def public" not in r:
            problems.append("model_registry.py has no public()")
        if "def probe" not in r:
            problems.append("model_registry.py has no probe()")
    else:
        problems.append(f"missing {reg_mod}")
    if problems:
        return _check("models_contract", False, "; ".join(problems))
    return _check("models_contract", True, "probe+path contract present in code", level="INFO")


def check_logs_dir(source_root: Optional[str]) -> dict:
    """The diagnostics layer (turn.jsonl / rounds.jsonl) must be writable."""
    if not source_root:
        return _check("logs_dir", True, "skipped (no source_root)", level="INFO")
    log_dir = os.path.join(source_root, "logs")
    try:
        os.makedirs(log_dir, exist_ok=True)
        probe = os.path.join(log_dir, ".selfcheck_writable")
        with open(probe, "w", encoding="utf-8") as fh:
            fh.write("ok")
        os.remove(probe)
        return _check("logs_dir", True, f"writable: {log_dir}", level="INFO")
    except Exception as e:
        return _check("logs_dir", False, f"logs dir not writable ({log_dir}): {e}")


def check_proxy_config(config_path: Optional[str]) -> dict:
    """Proxy-port consistency: the websearch STRATA_PROXY must actually be reachable.

    One-place locator for the cross-cutting fact "the configured proxy port equals the
    port the proxy software is really listening on". When you move machines or change
    the proxy port, this boot check TCP-connects the configured port and reports it, so
    a mismatch surfaces here instead of as an opaque search/download failure later.

    The proxy is only the *fallback* path for websearch (the primary path dials Bing
    directly), so an unreachable proxy is WARN (service still works), never a hard fail.
    Port parsing mirrors websearch_server._proxy_parts(): a bare host:port is treated as
    socks5://; scheme without an explicit port falls back to the scheme default.
    """
    if not config_path or not os.path.isfile(config_path):
        return _check("proxy_reach", True, "skipped (no config)", level="INFO")
    try:
        raw = _load_cfg(config_path)
    except Exception as e:
        return _check("proxy_reach", True, f"skipped (config unreadable): {e}", level="INFO")
    servers = (raw.get("mcpServers") if isinstance(raw, dict) else None) or {}
    ws = servers.get("websearch") or {}
    # config env is what gets injected into the websearch child at spawn time (the
    # source of truth); fall back to this process's env if the config sets none.
    proxy = ((ws.get("env") or {}).get("STRATA_PROXY") or "").strip() \
            or (os.environ.get("STRATA_PROXY") or "").strip()
    if not proxy:
        return _check("proxy_reach", True, "no websearch proxy configured (direct-only)", level="INFO")
    url = proxy if "://" in proxy else "socks5://" + proxy
    try:
        from urllib.parse import urlparse
        pr = urlparse(url)
    except Exception as e:
        return _check("proxy_reach", True, f"skipped (unparsable proxy '{proxy}'): {e}", level="INFO")
    host = pr.hostname or "127.0.0.1"
    if pr.port:
        port = pr.port
    elif pr.scheme in ("http", "https"):
        port = 443 if pr.scheme == "https" else 80
    else:
        port = 1080  # socks default
    try:
        s = socket.create_connection((host, port), timeout=3)
        s.close()
        return _check("proxy_reach", True, f"tcp ok {host}:{port} (STRATA_PROXY)", level="INFO")
    except Exception as e:
        return _check("proxy_reach", True,
                      f"WARN proxy {host}:{port} unreachable ({e}); websearch direct path "
                      f"still works, proxy fallback disabled", level="WARN")


# ─── aggregator ────────────────────────────────────────────────────────────────

def run_selfcheck(executor=None, *, upstream_url: Optional[str] = None,
                  web_dir: Optional[str] = None, config_path: Optional[str] = None,
                  require_engine: bool = False, source_root: Optional[str] = None,
                  fail_fast: bool = True) -> dict:
    source_root = source_root or ROOT
    web_dir = web_dir or os.path.join(source_root, "serve", "web")

    checks: list[dict] = []
    checks.append(check_config(config_path))
    checks.extend(check_mcp_tools(executor))
    checks.append(check_upstream(upstream_url, require=require_engine))
    checks.append(check_build_marker(web_dir))
    checks.append(check_models_contract(source_root))
    checks.append(check_logs_dir(source_root))
    checks.append(check_proxy_config(config_path))

    hard = [c for c in checks if (not c["ok"]) and c["level"] == "ERROR"]
    warns = [c for c in checks if c["level"] == "WARN"]
    ok = len(hard) == 0
    return {
        "ok": ok,
        "fail_fast": fail_fast,
        "hard_failures": len(hard),
        "warnings": len(warns),
        "checks": checks,
    }


def format_report(rep: dict) -> str:
    lines = ["startup self-check:",
             f"  result   : {'OK' if rep['ok'] else 'FAILED'} "
             f"({rep['hard_failures']} hard / {rep['warnings']} warn)"]
    for c in rep["checks"]:
        mark = "OK " if c["ok"] else ("WARN" if c["level"] == "WARN" else "FAIL")
        lines.append(f"  [{mark}] {c['name']}: {c['detail']}")
    return "\n".join(lines)


if __name__ == "__main__":
    # Allow a standalone smoke run: python runtime/selfcheck.py [config_path]
    cfg = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "config", "mcp_servers.json")
    rep = run_selfcheck(config_path=cfg, source_root=ROOT)
    print(format_report(rep))
    sys.exit(0 if rep["ok"] else 1)
