"""Executor: route tool calls to MCP servers (stdio JSON-RPC, pure standard library).

This is the Act step of the loop. It owns every configured MCP server: starts them in
the background, offers their tools (namespaced `<server>__<tool>`), and routes a call
back to the server that has it. A failed call becomes a result starting with "error:"
so the model can react instead of the loop breaking.

The schema mirrors Strata's `mcpServers` block so the same file (config/mcp_servers.json)
can be read by both Strata and this runtime.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time

from textenc import WIRE_ENCODING

# The zero-loss side-log for truncated tool results lives in the session module; the
# executor only ever READS it back (via the model-callable `recall_tool_log` tool).
try:
    from memory.session import read_tool_log, write_tool_log_text
except Exception:  # pragma: no cover - fallback if run outside the package layout
    read_tool_log = None
    write_tool_log_text = None

PROTOCOL = "2025-06-18"
DEFAULTS = {"timeout_s": 60.0, "max_result_chars": 30000, "cancel_grace_s": 2.0}


def _truncate_result(out: str, cap: int, tool_log_dir: str | None) -> str:
    """Source-level head-only cap on a tool output (the executor's guard against one huge
    result flooding the current turn). When truncation happens the FULL text is persisted to
    the side-log and the marker carries a recall id, so the cap is lossless — the model can
    fetch the dropped tail via recall_tool_log(id) on a later turn.
    """
    if len(out) <= cap:
        return out
    full = out
    out = out[:cap] + f"\n…[truncated to {cap} chars]"
    if tool_log_dir and write_tool_log_text is not None:
        tid = write_tool_log_text(tool_log_dir, full)
        if tid:
            out += (f"\n(FULL output saved as tool-log id={tid}; "
                    f"call recall_tool_log(\"{tid}\") to read all {len(full)} chars)")
    return out

# A tool that is asked to cancel gets this long to wind down (ack the notifications/cancelled
# and return) before we give up on it and raise. The frontend already treats the turn as
# stopped the moment cancel is set, so this only bounds how long a stuck server can hold a
# slot.

# Per-server *session* cumulative time ceiling (seconds). This is the middle layer of the
# three timeout guards:
#   - per-command  : timeout_s (330)    — one individual tool call can run this long
#   - per-server   : SERVER_TIMEOUT_S   — one server's TOTAL across the session is capped here
#   - global turn  : turn_budget_s (600)— the whole agent turn is capped here
# A single slow command may still run to its own timeout_s, but a server cannot dominate the
# turn: once its cumulative wall time reaches the ceiling, new calls fail fast with a
# structured ``server timeout`` error instead of piling on. None = disabled (no ceiling).
SERVER_TIMEOUT_S = None

# A failed tool call is reported as a string starting with this prefix (a design choice
# carried over from Strata so the model can react instead of the loop breaking). Centralise
# the test so every caller agrees on what "error" means -- previously the loop and the
# /mcp/call envelope each re-implemented `result.startswith("error:")` independently.
ERROR_PREFIX = "error:"


def is_error(result) -> bool:
    """Whether a tool result (str or structured dict) represents a failure."""
    return isinstance(result, str) and result.startswith(ERROR_PREFIX)


def error_code(result) -> str | None:
    """Categorise a failed result so the UI can show a precise badge instead of one
    generic "error". Returns None for success (incl. dict results carrying images)."""
    if not is_error(result):
        return None
    t = result[len(ERROR_PREFIX):].strip().lower()
    if "denied" in t or "blocked by sandbox" in t or "permission" in t:
        return "denied"
    if "timed out" in t:
        return "timeout"
    if "server timeout" in t or "server_timeout" in t:
        return "server_timeout"        # this server has consumed its session budget
    if "no such tool" in t:
        return "notfound"
    if _is_transient(t):
        return "transient"        # transport-level: a candidate for retry/backoff
    return "exec"                 # the command ran but exited non-zero / misbehaved


# Transport-level failures worth a retry (the server crashed, a pipe broke). Logical
# errors -- a denied command, a command's own runtime timeout, a non-zero exit -- are
# NOT transient and must never be retried blindly (a retry could double-execute a side
# effect). A plain transport "timed out" is deliberately excluded: by the time the
# executor's own 330s ceiling trips, the server is hard-stalled, not blipping.
_TRANSIENT_HINTS = ("server process", "not alive", "dead", "write failed")


def _is_transient(msg: str) -> bool:
    m = msg.lower()
    return any(h in m for h in _TRANSIENT_HINTS)


MAX_TRANSIENT_RETRIES = 2
_TRANSIENT_BACKOFF = (0.3, 0.6)   # seconds between attempts (exponential-ish)


def configure(defaults: dict | None) -> None:
    """Apply the `mcp` block of config/mcp_servers.json (timeout_s / max_result_chars).

    The file already declared these, but nothing read them -- the executor silently
    used its 60s default while the shell server capped at 30s. Reading the block makes
    the transport limit and the per-server limits consistent and tunable from one place.
    """
    if not defaults:
        return
    if "timeout_s" in defaults:
        try:
            DEFAULTS["timeout_s"] = float(defaults["timeout_s"])
        except (TypeError, ValueError):
            pass
    if "max_result_chars" in defaults:
        try:
            DEFAULTS["max_result_chars"] = int(defaults["max_result_chars"])
        except (TypeError, ValueError):
            pass
    if "server_timeout_s" in defaults:
        try:
            v = float(defaults["server_timeout_s"])
            global SERVER_TIMEOUT_S
            SERVER_TIMEOUT_S = v if v > 0 else None
        except (TypeError, ValueError):
            pass


def current_defaults() -> dict:
    """Live snapshot of the executor's tunable caps.

    These are module-level and read at tool-call time (see call()/StdioServer.call), so a
    change made by configure() takes effect for the very next tool call without restart.
    server_timeout_s is None when disabled; we surface it as 0 so the UI has a concrete value.
    """
    return {
        "timeout_s": DEFAULTS["timeout_s"],
        "max_result_chars": DEFAULTS["max_result_chars"],
        "server_timeout_s": SERVER_TIMEOUT_S if SERVER_TIMEOUT_S is not None else 0,
    }


class ToolError(RuntimeError):
    pass


class _Slot:
    def __init__(self):
        self.done = threading.Event()
        self.msg = None
        self.error = None
        self.on_progress = None     # optional callback(text) for streaming tool output


class StdioServer:
    """A program the runtime starts and speaks to over newline-delimited JSON-RPC."""

    def __init__(self, name: str, command: str, args=None, env=None, cwd=None):
        self.name = name
        self.command = command
        self.args = args or []
        self.env = env
        self.cwd = cwd
        self._proc = None
        self._reader = None
        self._req_id = 0
        self._pending = {}
        self._lock = threading.Lock()
        self.tool_log_dir = None  # set by Executor after construction
        self.tools = []
        self._cum_s = 0.0          # cumulative wall time spent in call() this session (item 6)

    def _child_env(self):
        """Merge the configured `env` into the parent environment.

        subprocess treats `env=` as a REPLACEMENT, not an overlay: passing the
        three-variable block from config/mcp_servers.json left the MCP server with 3
        environment variables instead of 194, dropping PATH and SYSTEMROOT. It
        survives today only because the interpreter is launched by absolute path —
        the moment a server spawns a child process or is given its own `env` block,
        every command would fail with "not found".

        We now also always return a real environment (never None) so the UTF-8 pins
        below apply even to a server configured without an `env` block: a Python-based
        MCP server left on the locale codec would answer in GBK while we read UTF-8.
        """
        merged = os.environ.copy()
        merged["PYTHONUTF8"] = "1"
        merged["PYTHONIOENCODING"] = WIRE_ENCODING
        for k, v in (self.env or {}).items():
            merged[str(k)] = str(v)
        return merged

    def start(self):
        exe = shutil.which(self.command) or self.command
        full = [exe] + list(self.args)
        # encoding="utf-8" is load-bearing, not cosmetic: with bare `text=True` the pipes
        # used the locale codec (GBK on a Chinese Windows) while every MCP peer speaks
        # UTF-8, so a Chinese tool result arrived as mojibake and a Chinese argument came
        # back as lone surrogates. Pin the wire codec and keep errors="replace" so one bad
        # byte can never take down the whole reader thread.
        proc = subprocess.Popen(full, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, env=self._child_env(),
                                cwd=self.cwd, text=True, bufsize=1,
                                encoding=WIRE_ENCODING, errors="replace")
        self._proc = proc
        self._reader = proc.stdout
        # start the reader thread so responses to _req() are delivered
        threading.Thread(target=self._read_loop, daemon=True).start()
        self._req("initialize", {"protocolVersion": PROTOCOL, "capabilities": {},
                                 "clientInfo": {"name": "strata-agent", "version": "1.0.0"}})
        self._notify("notifications/initialized", {})
        res = self._req("tools/list", {})
        self.tools = [t for t in res.get("tools", [])]

    def stop(self):
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()

    def call(self, tool: str, arguments: dict, on_progress=None, cancel=None):
        # Item 6: per-server session cumulative ceiling. A single server must not be able to
        # consume the whole turn_budget by itself; once it has spent SERVER_TIMEOUT_S of wall
        # time across the session, new calls fail fast with a structured error instead of
        # piling on. This sits between the per-command timeout (timeout_s) and the global
        # turn_budget_s: one slow command may still run to its own limit, but the server's
        # total across the session is bounded below the turn budget.
        if cancel is not None and cancel.is_set():
            raise ToolError("cancelled")
        limit = SERVER_TIMEOUT_S
        if limit and self._cum_s >= limit:
            raise ToolError(
                f"server timeout: cumulative budget {limit:g}s exceeded for server '{self.name}'")
        t0 = time.monotonic()
        try:
            res = self._req("tools/call", {"name": tool, "arguments": arguments},
                            on_progress=on_progress, cancel=cancel)
        finally:
            self._cum_s += time.monotonic() - t0
        blocks = res.get("content", [])
        parts = []
        images = []
        for b in blocks:
            t = b.get("type")
            if t == "text":
                parts.append(b.get("text", ""))
            elif t == "image" and b.get("data"):
                images.append(b)
        out = "\n".join(parts)
        cap = DEFAULTS["max_result_chars"]
        if len(out) > cap:
            out = _truncate_result(out, cap, self.tool_log_dir)
        if not images:
            return out                          # plain text: byte-identical to before
        return {"text": out, "images": images}      # has image(s): hand structure to the loop

    def _req(self, method: str, params: dict, on_progress=None, cancel=None):
        # G5: if the child process died mid-run, the reader thread is gone and any further
        # request would block until the full timeout. Detect death and fail fast.
        if self._proc is not None and self._proc.poll() is not None:
            raise ToolError(f"server process not alive (exit {self._proc.returncode})")
        with self._lock:
            self._req_id += 1
            rid = self._req_id
            slot = _Slot()
            slot.on_progress = on_progress
            self._pending[rid] = slot
        try:
            self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        except (BrokenPipeError, ValueError, OSError) as e:
            raise ToolError(f"server process dead (write failed: {e})")
        try:
            # G5 (part 2): a child that dies DURING a wait used to sit out the full
            # timeout — the reader thread hits EOF and simply returns, waking nobody.
            # A probe of a broken server (starts, exits, never answers) therefore hung
            # for timeout_s before failing. Poll the process instead: death is noticed
            # within one interval. A short grace wait after death lets an answer that
            # was already buffered still win ("answered, then exited").
            deadline = time.monotonic() + DEFAULTS["timeout_s"]
            cancel_at = None  # moment after which a cancelled-but-unacked call is abandoned
            while not slot.done.wait(0.05):
                if self._proc is not None and self._proc.poll() is not None:
                    if slot.done.wait(0.1):
                        break
                    raise ToolError(f"server process died (exit {self._proc.returncode})")
                if cancel is not None and cancel.is_set():
                    # Tell the server to abort this request (MCP notifications/cancelled),
                    # then give it a short grace to acknowledge before we abandon the slot.
                    if cancel_at is None:
                        try:
                            self._send({"jsonrpc": "2.0", "method": "notifications/cancelled",
                                        "params": {"requestId": rid, "reason": "client stop"}})
                        except Exception:
                            pass
                        cancel_at = time.monotonic() + DEFAULTS.get("cancel_grace_s", 2.0)
                    elif time.monotonic() > cancel_at:
                        raise ToolError("cancelled")
                if time.monotonic() > deadline:
                    if self._proc is not None and self._proc.poll() is not None:
                        raise ToolError(f"server process died (exit {self._proc.returncode})")
                    raise ToolError(f"{method} timed out")
            if slot.error:
                raise slot.error
            msg = slot.msg
            if "error" in msg:
                err = msg["error"] if isinstance(msg["error"], dict) else {"message": str(msg["error"])}
                raise ToolError(f"{err.get('message')} (code {err.get('code')})")
            return msg.get("result") or {}
        finally:
            # Release the slot on every path. Previously it was never removed, so a
            # long-running agent grew `_pending` by one entry per tool call without bound
            # (a slow leak that never shows up in a short session).
            with self._lock:
                self._pending.pop(rid, None)

    def _notify(self, method: str, params: dict):
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    def _send(self, msg: dict):
        self._proc.stdin.write(json.dumps(msg) + "\n")
        self._proc.stdin.flush()

    def _read_loop(self):
        for line in self._reader:
            try:
                msg = json.loads(line)
            except Exception:
                continue
            method = msg.get("method")
            # Out-of-band progress notifications: a long-running tool streaming output.
            # These carry `params.token` (the request id), not a response id, so they never
            # resolve a pending slot -- they just feed the callback registered for that slot.
            if method == "notifications/progress":
                token = (msg.get("params") or {}).get("token")
                slot = self._pending.get(token) if token is not None else None
                if slot and slot.on_progress and isinstance(msg.get("params"), dict):
                    try:
                        slot.on_progress(msg["params"].get("text", ""))
                    except Exception:
                        pass
                continue
            rid = msg.get("id")
            if rid in self._pending:
                slot = self._pending[rid]
                slot.msg = msg
                slot.done.set()


class Executor:
    def __init__(self, servers: dict, defaults: dict | None = None,
                 tool_log_dir: str | None = None):
        configure(defaults)
        self.servers = {}
        for name, cfg in servers.items():
            if "command" not in cfg:
                continue  # HTTP-transport servers are left for the model-native path
            self.servers[name] = StdioServer(name, cfg["command"], cfg.get("args"),
                                             cfg.get("env"), cfg.get("cwd"))
        self._tool_owner = {}
        # Where truncated tool results are persisted for the `recall_tool_log` tool.
        # None disables recall (the cap becomes lossy again — but the rest still works).
        self.tool_log_dir = tool_log_dir
        for _srv in self.servers.values():        # propagate so StdioServer.call() can log
            _srv.tool_log_dir = tool_log_dir       # a long output is zero-loss recallable

    def start_all(self):
        for srv in self.servers.values():
            try:
                srv.start()
                for t in srv.tools:
                    self._tool_owner[f"{srv.name}__{t['name']}"] = (srv, t["name"])
            except Exception as e:
                print(f"[executor] server {srv.name} failed to start: {e}", file=sys.stderr)

    def stop_all(self):
        for srv in self.servers.values():
            srv.stop()

    def reset_cum(self):
        """Reset every server's cumulative wall-time counter (called at the start of a turn).

        `server_timeout_s` exists so one server cannot consume an entire turn by itself. It
        accumulated for the LIFE OF THE PROCESS though, so a long session eventually poisoned
        servers that were mostly idle ("cumulative budget exceeded") until the gateway was
        restarted. The budget was always meant per turn -- this makes it so.
        """
        for srv in self.servers.values():
            srv._cum_s = 0.0

    @property
    def tools(self):
        out = []
        for srv in self.servers.values():
            for t in srv.tools:
                out.append({"name": f"{srv.name}__{t['name']}",
                            "description": t.get("description", ""),
                            "input_schema": t.get("inputSchema", {})})
        # Synthetic local tool: lets the model fetch the FULL text of a tool result that
        # was truncated in history by the tool-result cap. Zero-extra-infra; it just reads
        # the side-log the session module wrote. Only advertised when the side-log is on.
        if self.tool_log_dir:
            out.append({
                "name": "recall_tool_log",
                "description": (
                    "Retrieve the FULL output of a tool result that was truncated in "
                    "history because it exceeded the tool-result cap. Pass the id from "
                    "the '[truncated ... tool-log id=...]' note (e.g. recall_tool_log("
                    "\"tl_ab12cd34\")). Use it when you need exact content that was cut "
                    "from the summary — a specific grep match, a field from a config/JSON, "
                    "a line from a long error trace. Pass id='list' to enumerate the most "
                    "recent saved tool outputs with a one-line preview."),
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "tool-log id like 'tl_ab12cd34', or 'list' to "
                                          "enumerate recent entries",
                        }
                    },
                    "required": ["id"],
                },
            })
        return out

    def call(self, namespaced_tool: str, arguments: dict, on_progress=None, cancel=None) -> str:
        # Synthetic local tool: fetch a truncated tool result's FULL text from the side-log.
        if namespaced_tool == "recall_tool_log":
            return self._recall_tool_log(arguments)
        owner = self._tool_owner.get(namespaced_tool)
        if not owner:
            return f"error: no such tool: {namespaced_tool}"
        srv, real = owner
        last = None
        for attempt in range(MAX_TRANSIENT_RETRIES + 1):
            try:
                return srv.call(real, arguments, on_progress=on_progress, cancel=cancel)
            except ToolError as e:
                last = e
                # Retry only infrastructure-level deaths (server crashed / pipe broke),
                # not logical tool errors. Back off between attempts; after the cap, fail.
                if attempt < MAX_TRANSIENT_RETRIES and _is_transient(str(e)):
                    time.sleep(_TRANSIENT_BACKOFF[attempt])
                    continue
                return f"error: {e}"
        return f"error: {last}"

    # ---- zero-loss side-log recall (synthetic local tool) ----

    def _recall_tool_log(self, arguments) -> str:
        tid = (arguments or {}).get("id") if isinstance(arguments, dict) else None
        if not tid:
            return ("error: recall_tool_log requires an id (use id='list' to enumerate "
                    "recent entries)")
        if tid == "list":
            return self._list_tool_logs()
        if read_tool_log is None:
            return "error: recall_tool_log unavailable (session module not importable)"
        data = read_tool_log(self.tool_log_dir, tid)
        if data is None:
            return (f"error: no tool-log entry with id={tid!r}. Use id='list' to see "
                    "available entries, or the id from the '[truncated ... tool-log id=...]' "
                    "note in history.")
        return data

    def _list_tool_logs(self) -> str:
        d = self.tool_log_dir
        if not d or not os.path.isdir(d):
            return "no tool-log entries (nothing was truncated, or the side-log is disabled)"
        try:
            entries = []
            for fn in os.listdir(d):
                if not fn.endswith(".txt"):
                    continue
                p = os.path.join(d, fn)
                try:
                    st = os.stat(p)
                    with open(p, encoding="utf-8") as f:
                        first = f.readline().rstrip()[:90]
                except OSError:
                    continue
                entries.append((st.st_mtime, fn[:-4], first))
            entries.sort(reverse=True)
            if not entries:
                return "no tool-log entries"
            lines = [f"{i + 1}. id={e[1]}  {e[2]}" for i, e in enumerate(entries[:20])]
            return ("Recent tool-log entries (most recent first); pass an id to "
                    "recall_tool_log to read its full content:\n" + "\n".join(lines))
        except OSError as e:
            return f"error: cannot list tool-log: {e}"
