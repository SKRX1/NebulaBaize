"""model_forward.py - send a chat request to a model that is NOT the one this process loaded.

Two shapes, one entry point:

  relay(...)        a sibling local Strata instance. It speaks this very protocol (MCP loop, approvals,
                    progress) so the bytes are handed through untouched - cheapest and most faithful.

  stream_chat(...)  an external OpenAI-compatible endpoint. It does NOT know our local MCP tools, so the
                    loop runs HERE: send tools -> collect tool_calls -> run them -> append the results ->
                    ask again, up to max_rounds. The chunks we emit are the same ones openai_chunks emits,
                    so the web app cannot tell the difference.

Both are generators of `{id, object:"chat.completion.chunk", ...}` dicts (relay yields source blocks).
"""
from __future__ import annotations

import json
import time
import uuid

INTERNAL = ("strata_",)          # request fields that only mean something to THIS server


def upstream_body(entry: dict, req: dict) -> dict:
    """The request as the upstream should see it: our bookkeeping stripped, its model name in place."""
    body = {k: v for k, v in req.items() if not (isinstance(k, str) and k.startswith(INTERNAL))}
    body["model"] = entry.get("model") or body.get("model")
    return body


def _headers(entry: dict) -> dict:
    h = {"Content-Type": "application/json", "Accept": "text/event-stream"}
    key = entry.get("api_key")
    if key:
        h["Authorization"] = "Bearer " + str(key)
    return h


def open_stream(entry: dict, body: dict, timeout: float = 120.0):
    """POST the request and return the open streaming response (caller closes it)."""
    import urllib.request
    base = str(entry.get("base_url") or "").rstrip("/")
    url = base + ("/chat/completions" if base.endswith("/v1") else "/v1/chat/completions")
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    r = urllib.request.Request(url, data=data, headers=_headers(entry), method="POST")
    return urllib.request.urlopen(r, timeout=timeout)


def iter_sse(resp):
    """Yield the JSON payload of each `data:` line, or the sentinel None for `[DONE]`."""
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line or line.startswith(":") or not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            yield None
            return
        try:
            yield json.loads(payload)
        except ValueError:
            continue


def _delta_of(ev: dict) -> dict:
    ch = (ev.get("choices") or [{}])[0] or {}
    return ch.get("delta") or {}


def _finish_of(ev: dict):
    ch = (ev.get("choices") or [{}])[0] or {}
    return ch.get("finish_reason")


class _Chunker:
    def __init__(self, model: str):
        self.id = "chatcmpl-" + uuid.uuid4().hex[:12]
        self.created = int(time.time())
        self.model = model

    def __call__(self, delta: dict, finish=None, **extra) -> dict:
        c = {"id": self.id, "object": "chat.completion.chunk", "created": self.created, "model": self.model,
             "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        c.update(extra)
        return c


def stream_chat(entry: dict, req: dict, *, run_tool=None, mcp_names=(), max_rounds: int = 8,
                ask=None, timeout: float = 120.0):
    """Forward to `entry`, running our MCP tools here when the upstream asks for one.

    run_tool(name, arguments) -> {"ok","text","chars","truncated","ms"}   (None when tools are off)
    ask(tool, server, arguments) -> bool                                   (None = no gate)
    """
    chunk = _Chunker(entry.get("model") or req.get("model") or "model")
    messages = list(req.get("messages") or [])
    tools = req.get("tools") or None
    emit_tools = bool(tools and run_tool)
    rounds = 0
    total_out = 0

    while True:
        body = upstream_body(entry, {**req, "messages": messages})
        body["stream"] = True
        if emit_tools:
            body["tools"] = tools
        else:
            body.pop("tools", None)
        # ask for a reasoning delta in the dialect the endpoint understands; unknown keys are ignored
        if entry.get("thinking") == "off":
            body.pop("reasoning_effort", None)

        calls: dict[int, dict] = {}
        content_len = 0
        finish = None
        usage = None
        try:
            resp = open_stream(entry, body, timeout)
        except Exception as e:                                    # noqa: BLE001 - surfaced to the user
            yield chunk({"content": f"[{type(e).__name__}] {e}"}, "error")
            return

        with resp:
            for ev in iter_sse(resp):
                if ev is None:
                    break
                if ev.get("usage"):
                    usage = ev["usage"]
                d = _delta_of(ev)
                if not d:
                    finish = _finish_of(ev) or finish
                    continue
                reason = d.get("reasoning_content") or d.get("reasoning")
                if reason:
                    yield chunk({"reasoning_content": reason})
                if d.get("content"):
                    content_len += len(d["content"])
                    yield chunk({"content": d["content"]})
                for tc in d.get("tool_calls") or []:
                    i = int(tc.get("index") or 0)
                    slot = calls.setdefault(i, {"id": "", "type": "function",
                                                "function": {"name": "", "arguments": ""}})
                    if tc.get("id"):
                        slot["id"] = tc["id"]
                    fn = tc.get("function") or {}
                    if fn.get("name"):
                        slot["function"]["name"] += fn["name"]
                    if fn.get("arguments"):
                        slot["function"]["arguments"] += fn["arguments"]
                finish = _finish_of(ev) or finish

        if finish != "tool_calls" or not calls:
            # a normal end: hand over any tool calls we are NOT allowed to run, then the usage
            if calls and not emit_tools:
                for i, c in sorted(calls.items()):
                    yield chunk({"tool_calls": [{"index": i, **c}]})
            yield chunk({}, finish or "stop", **({"usage": usage} if usage else {}))
            return

        calls = {i: c for i, c in calls.items() if c["function"]["name"]}
        ours = [c for c in calls.values() if c["function"]["name"] in mcp_names]
        theirs = [c for c in calls.values() if c["function"]["name"] not in mcp_names]
        if theirs or not ours:                                    # the client's own tools end the turn
            for i, c in sorted(calls.items()):
                yield chunk({"tool_calls": [{"index": i, **c}]})
            yield chunk({}, "tool_calls", **({"usage": usage} if usage else {}))
            return
        if rounds >= max_rounds:
            yield chunk({}, "stop", strata_mcp={"event": "limit", "max_rounds": max_rounds}, **({"usage": usage} if usage else {}))
            return

        rounds += 1
        messages.append({"role": "assistant", "content": None, "tool_calls": [
            {"id": c["id"] or f"call_{i}", "type": "function", "function": dict(c["function"])}
            for i, c in sorted(calls.items())]})
        for i, c in sorted(calls.items()):
            name = c["function"]["name"]
            try:
                args = json.loads(c["function"]["arguments"] or "{}")
            except ValueError:
                args = {"_raw": c["function"]["arguments"]}
            cid = c["id"] or f"call_{i}"
            yield chunk({}, strata_mcp={"event": "start", "id": cid, "name": name})
            if ask is not None and not ask(name, args):
                yield chunk({}, strata_mcp={"event": "result", "id": cid, "ok": False, "skipped": True,
                                            "text": "denied by the user", "chars": 0, "truncated": False, "ms": 0})
                messages.append({"role": "tool", "tool_call_id": cid, "content": "denied by the user"})
                continue
            r = run_tool(name, args) if run_tool else {"ok": False, "text": "tools are off", "chars": 0,
                                                       "truncated": False, "ms": 0}
            yield chunk({}, strata_mcp={"event": "result", "id": cid, "ok": r["ok"], "text": r["text"],
                                        "chars": r["chars"], "truncated": r["truncated"], "ms": r["ms"]})
            messages.append({"role": "tool", "tool_call_id": cid, "content": r["text"]})
        total_out += content_len
