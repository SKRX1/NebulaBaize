# Proxy-port consistency (websearch STRATA_PROXY)

> **简体中文** | [English](proxy-port-consistency.md)

The fact this page locks: **the port in `config/mcp_servers.json` → websearch → `env.STRATA_PROXY`
must equal the port your proxy software is actually listening on.** When you move machines or
change the proxy port, aligning this one place is enough to locate search/download fallback issues.

## Why a dedicated page

The proxy port lives in **three independent places**, which historically caused repeated
mismatches (a stale 7897 vs the actually-listening 7890):

| Where | Location | Notes |
|---|---|---|
| **websearch fallback proxy** | `config/mcp_servers.json` → `mcpServers.websearch.env.STRATA_PROXY` | written by the Tools-page proxy card; frozen into the child env at spawn |
| **git proxy** | `git config http.proxy` / `https.proxy` | git's own independent layer, not shared with system/mcp proxy |
| **system proxy** | WinINET / proxy-software mixed-port | browser + system-level traffic |

The three are independent — changing one never propagates to the others. That is the root cause of
"the port looks like 7890 but git/search still hits the old port".

## Current truth (measured)

- The local proxy software actually listens on **`127.0.0.1:7890`** (`Test-NetConnection -Port 7890`
  confirmed `TcpTestSucceeded=True`; 7897 no longer listens).
- `mcp_servers.json` `env.STRATA_PROXY = http://127.0.0.1:7890`, aligned.

## How the startup self-check locates a mismatch

`check_proxy_config` in `runtime/selfcheck.py` runs at gateway boot:

1. Reads websearch's `env.STRATA_PROXY` from `mcp_servers.json` (falling back to process env), parses
   host:port by its scheme (a bare `host:port` is treated as socks5, same as `websearch_server._proxy_parts`);
2. TCP-probes that port with a 3s timeout:
   - **reachable** → `INFO tcp ok <host>:<port>`;
   - **unreachable** → `WARN proxy <host>:<port> unreachable`, but **boot is not blocked**
     (websearch's primary path dials Bing directly; the proxy is only the fallback).

So after a machine/port change, the mismatch surfaces in **one place** in the boot report instead of
only when a search/download fails later.

## Download fallback log when the proxy is down

`_fetch_bytes` (the download-to-disk path in `servers/websearch_server.py`) is now
**proxy-first, auto direct-retry on unreachable**: when the proxy won't connect or its backend is
unavailable (socks scheme without PySocks), it prints one stderr line then retries direct:

```
[websearch] download: proxy http://127.0.0.1:7890 unreachable (ConnectionRefusedError: ...), retrying direct
```

Later, the presence or absence of that line tells you whether the proxy is up — no more silent swallow.

## What to do after changing the proxy port

1. Edit `config/mcp_servers.json` → `websearch.env.STRATA_PROXY` (or save on the Tools-page proxy card);
2. Click the MCP panel's **reload children** to apply without a restart (the child env is frozen at
   spawn; reload = re-read json + re-spawn);
3. If git operations must use the new port too, **change `git config http.proxy/https.proxy`
   separately** (it's an independent layer).

## Related gates

- `tests/test_startup_selfcheck.py` — three proxy_reach assertions (no config skip / unreachable WARN-not-fail / reachable INFO).
- `tests/test_websearch_proxy_retry.py` — R1 unreachable direct-retry+log / R2 backend unavailable / R3 working proxy no fallback / R4 no proxy direct.
