"""Minimal stdio MCP server base (pure standard library).

Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout; stderr is the log. Implements
the three methods Strata/Claude clients call: initialize, tools/list, tools/call.
A subclass declares its tools and implements `call_tool(name, arguments)`.

-------------------------------------------------------------------------------
Wire encoding: UTF-8, always, independently of the locale
-------------------------------------------------------------------------------
MCP over stdio is UTF-8 on the wire. The clients agree: Strata's `serve/mcp.py`
sends `json.dumps(msg, ensure_ascii=False).encode("utf-8")` and reads
`raw.decode("utf-8", "replace")`; Claude Desktop does the same.

But `sys.stdin`/`sys.stdout` default to the *locale* codec, and on a Chinese Windows
that is GBK. A double-clicked launcher .bat sets no PYTHONUTF8/PYTHONIOENCODING, so
the locale codec won — and BOTH directions broke:

  * outbound: `sys.stdout.write("中文")` emitted `\\xd6\\xd0\\xce\\xc4` (GBK) while the
    client decoded UTF-8, so the model saw `\\ufffd\\ufffd` -- the mojibake in the chat.
  * inbound:  the client's UTF-8 payload was decoded as GBK, which produced lone
    surrogates and then `UnicodeEncodeError: 'utf-8' codec can't encode character
    '\\udcad' ... surrogates not allowed` -- the write tool died and left a 0-byte
    file on disk ("写入读取失败").

So we stop trusting the text layer entirely: at import we point stdin/stdout/stderr at
UTF-8, and we read/write the *binary* streams with an explicit UTF-8 codec anyway.
stderr (the log channel, which the client also decodes as UTF-8) is reconfigured for
the same reason.
"""
from __future__ import annotations

import io
import json
import queue
import sys
import threading

PROTOCOL = "2025-06-18"


def _force_utf8(stream) -> None:
    """Best effort: make a std stream speak UTF-8 whatever the locale says."""
    reconfigure = getattr(stream, "reconfigure", None)
    if reconfigure is None:
        return
    try:
        reconfigure(encoding="utf-8", errors="replace")
    except (ValueError, OSError, io.UnsupportedOperation):
        pass


_force_utf8(sys.stdin)
_force_utf8(sys.stdout)
_force_utf8(sys.stderr)

# The binary views of the same pipes. Reading/writing these is codec-proof: no locale,
# no text layer, no chance of a silent GBK round trip.
IN = getattr(sys.stdin, "buffer", None)
OUT = getattr(sys.stdout, "buffer", None)


def smart_decode(data) -> str:
    """Decode a subprocess's captured output: UTF-8 first, then the Chinese ANSI codec.

    Tools that shell out capture *bytes* and land here. Modern tools (python, node,
    git) emit UTF-8; cmd.exe built-ins emit the OEM codec (GBK on zh-CN). UTF-8 is
    tried first on purpose: a GBK byte pair is essentially never valid UTF-8, so the
    fallback is unambiguous, whereas decoding UTF-8 as GBK silently yields mojibake.
    """
    if isinstance(data, str):
        return data
    if not data:
        return ""
    for enc in ("utf-8", "gbk"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", "replace")


class McpServerBase:
    name = "base"
    tools: list[dict] = []

    def __init__(self):
        # Cancellation state for the currently-running tool call. The reader thread sets
        # `_cancel_event` when a `notifications/cancelled` arrives that targets the active
        # request; `call_tool` (and the shell/browser subprocess pump) poll `cancelled()`
        # so a Stop click kills a running command instead of letting it run to completion.
        self._active_rid = None
        self._cancel_event = threading.Event()
        self._send_lock = threading.Lock()

    def tools_list(self) -> list[dict]:
        return self.tools

    def call_tool(self, name: str, arguments: dict) -> str:
        raise NotImplementedError

    def cancelled(self) -> bool:
        """True once a `notifications/cancelled` for the active request has arrived."""
        return self._cancel_event.is_set()

    @property
    def progress_token(self):
        return getattr(self, "_progress_token", None)

    def emit_progress(self, text: str) -> None:
        """Send a `notifications/progress` frame so a long-running tool can stream output.

        No-op when not inside a `tools/call` (no active token). The client correlates the
        notification with the in-flight request via `params.token`.
        """
        token = self.progress_token
        if not token or not text:
            return
        self._send({"jsonrpc": "2.0", "method": "notifications/progress",
                    "params": {"token": token, "text": text}})

    def run(self):
        """Read frames on a background thread and dispatch them on the main thread.

        Splitting read from dispatch lets a `notifications/cancelled` be acted on *while*
        a tool is blocking inside `call_tool` on the main thread: the reader flags
        `_cancel_event` out-of-band, and the running tool polls `cancelled()` to abort.
        """
        q: "queue.Queue" = queue.Queue()
        reader_done = threading.Event()

        def _reader():
            try:
                for raw in self._frames():
                    line = raw.strip()
                    if not line:
                        continue
                    try:
                        msg = json.loads(line)
                    except Exception:
                        continue
                    if not isinstance(msg, dict):   # batch: not sent by our clients
                        continue
                    # Out-of-band cancellation: do not queue it (the main thread is busy in
                    # call_tool); just flag the active request if it matches.
                    if msg.get("method") == "notifications/cancelled":
                        rid = (msg.get("params") or {}).get("requestId")
                        if rid is not None and rid == self._active_rid:
                            self._cancel_event.set()
                        continue
                    q.put(msg)
            finally:
                reader_done.set()
                q.put(None)  # end-of-stream sentinel

        threading.Thread(target=_reader, daemon=True).start()

        while True:
            try:
                msg = q.get(timeout=0.2)
            except queue.Empty:
                if reader_done.is_set():
                    break
                continue
            if msg is None:
                break
            rid = msg.get("id")
            method = msg.get("method")
            params = msg.get("params", {})
            try:
                result = self._dispatch(method, params, rid)
            except Exception as e:
                self._send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": str(e)}})
                continue
            if rid is not None and result is not None:
                self._send({"jsonrpc": "2.0", "id": rid, "result": result})
        return 0

    @staticmethod
    def _frames():
        """One JSON-RPC line at a time, decoded as UTF-8 whatever the locale is."""
        if IN is not None:
            for raw in IN:                                  # bytes -> explicit UTF-8
                yield raw.decode("utf-8", "replace") if isinstance(raw, (bytes, bytearray)) else raw
            return
        for line in sys.stdin:                              # a host replaced sys.stdin (a test harness)
            yield line

    def _dispatch(self, method, params, rid=None):
        # Clients use `ping` as a liveness probe; without it a health check got a
        # "unknown method" error and flagged a healthy server as broken.
        if method == "ping":
            return {}
        if method == "initialize":
            return {"protocolVersion": PROTOCOL, "capabilities": {"tools": {}},
                    "serverInfo": {"name": self.name, "version": "1.0.0"}}
        if method == "notifications/initialized":
            return None
        if method == "tools/list":
            return {"tools": self.tools_list()}
        if method == "tools/call":
            # Tag progress notifications emitted while the tool runs with this request's id,
            # so the client can stream incremental output (see `_progress`).
            self._progress_token = rid
            # Mark this request as the cancellation target and clear any stale flag, then
            # run the tool. A concurrent `notifications/cancelled` (handled by the reader
            # thread) sets `_cancel_event`; the tool polls `cancelled()` to wind down.
            self._active_rid = rid
            self._cancel_event = threading.Event()
            try:
                out = self.call_tool(params.get("name"), params.get("arguments", {}) or {})
            finally:
                self._progress_token = None
                self._active_rid = None
            content = out if isinstance(out, list) else [{"type": "text", "text": str(out)}]
            return {"content": content, "isError": False}
        if method == "notifications/cancelled":
            # Defensive: if a server subclass funnels everything through `_dispatch`, still
            # flag the active request. (The default `run()` handles it in the reader thread.)
            rid = (params or {}).get("requestId")
            if rid is not None and rid == self._active_rid:
                self._cancel_event.set()
            return None
        raise Exception(f"unknown method: {method}")

    def _send(self, msg: dict):
        """Write one JSON-RPC frame as UTF-8 bytes, bypassing the locale text layer."""
        data = json.dumps(msg, ensure_ascii=False).encode("utf-8") + b"\n"
        # Serialize writes: progress notifications can be emitted from a tool's pump
        # thread while the main thread sends the result, and interleaved frames corrupt
        # the stream. The lock keeps each frame atomic.
        with self._send_lock:
            if OUT is not None:
                OUT.write(data)
                OUT.flush()
                return
            sys.stdout.write(data.decode("utf-8"))              # a text stream a host handed us
            sys.stdout.flush()
