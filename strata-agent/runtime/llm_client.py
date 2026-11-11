"""OpenAI-compatible client for Strata (pure standard library).

Talks to http://127.0.0.1:8080/v1/chat/completions, streaming, parses reasoning
and tool calls. No SDK required. The model instance is shared; this client is a thin
facade over Strata's existing API.
"""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field


@dataclass
class AssistantTurn:
    content: str = ""
    reasoning: str = ""
    tool_calls: list[dict] = field(default_factory=list)
    usage: dict = field(default_factory=dict)   # token accounting when the API returns it


class StrataClient:
    def __init__(self, base_url: str = "http://127.0.0.1:8080/v1",
                 model: str = "strata", effort: str = "medium",
                 max_tokens: int = 4096, api_key: str | None = None,
                 timeout: int = 3600, max_retries: int = 3, backoff_base: float = 1.0,
                 backoff_max: float = 30.0, sleep=None, on_retry=None):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.effort = effort
        self.max_tokens = max_tokens
        self.api_key = api_key
        self.timeout = timeout
        # Resilience: transient network/5xx/timeout failures are retried with exponential
        # backoff so a single blip no longer crashes the whole round. sleep is injectable
        # for offline tests; on_retry(event) observes each retry for the audit log.
        self.max_retries = max_retries
        self.backoff_base = backoff_base
        self.backoff_max = backoff_max
        self._sleep = sleep or time.sleep
        self.on_retry = on_retry or (lambda ev: None)

    def _backoff(self, attempt: int) -> float:
        return min(self.backoff_base * (2 ** attempt), self.backoff_max)

    def _open(self, req):
        """urlopen with retry + exponential backoff on transient failures."""
        last = None
        for attempt in range(self.max_retries + 1):
            try:
                return urllib.request.urlopen(req, timeout=self.timeout)
            except urllib.error.HTTPError as e:
                # retry only transient server errors; 4xx are the caller's fault
                if e.code in (408, 429, 500, 502, 503, 504) and attempt < self.max_retries:
                    self.on_retry({"attempt": attempt + 1, "reason": f"HTTP {e.code}",
                                   "wait": self._backoff(attempt)})
                    self._sleep(self._backoff(attempt))
                    last = e
                    continue
                raise
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                if attempt < self.max_retries:
                    self.on_retry({"attempt": attempt + 1, "reason": str(e),
                                   "wait": self._backoff(attempt)})
                    self._sleep(self._backoff(attempt))
                    last = e
                    continue
                raise
        raise last

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    def chat(self, messages: list[dict], tools: list[dict] | None = None,
             stream: bool = True, effort: str | None = None,
             on_delta=None) -> AssistantTurn:
        """Send a chat completion, return a normalized AssistantTurn.

        Cache note: keep `messages` append-only so Strata's prompt cache hits;
        do not reorder the prefix.
        """
        body = {
            "model": self.model,
            "messages": messages,
            "stream": stream,
            "max_tokens": self.max_tokens,
            "reasoning_effort": effort or self.effort,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"
        if stream:
            # B5: ask for a final usage chunk (OpenAI-standard). Providers that honour it light
            # up prompt/output/cached for real; one that rejects an unknown field answers 400
            # through the existing reject path, so no new failure mode is introduced.
            body["stream_options"] = {"include_usage": True}
        url = f"{self.base_url}/chat/completions"
        req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=self._headers())
        if not stream:
            with self._open(req) as r:
                data = json.loads(r.read().decode("utf-8", "replace"))
            return _turn_from_response(data)
        return self._stream(req, on_delta=on_delta)

    def _stream(self, req, on_delta=None) -> AssistantTurn:
        turn = AssistantTurn()
        with self._open(req) as r:
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                payload = json.loads(line[6:])
                if payload.get("usage"):                       # some providers emit usage last
                    turn.usage = payload["usage"]
                cho = payload.get("choices") or []
                if not cho:
                    continue
                d = cho[0].get("delta", {})
                if d.get("reasoning_content"):
                    turn.reasoning += d["reasoning_content"]
                if d.get("content"):
                    turn.content += d["content"]
                    if on_delta:
                        on_delta(d["content"])
                for tc in d.get("tool_calls", []) or []:
                    _merge_tool_call(turn, tc)
        return turn

    def attach_image(self, path: str) -> dict:
        mime = mimetypes.guess_type(path)[0] or "image/jpeg"
        data = base64.b64encode(open(path, "rb").read()).decode()
        return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}}


def _merge_tool_call(turn: AssistantTurn, tc: dict):
    idx = tc.get("index", 0)
    while len(turn.tool_calls) <= idx:
        turn.tool_calls.append({"id": "", "name": "", "arguments": ""})
    call = turn.tool_calls[idx]
    call["id"] = tc.get("id") or call["id"]
    fn = tc.get("function") or {}
    if fn.get("name"):
        call["name"] += fn["name"]
    if fn.get("arguments"):
        call["arguments"] += fn["arguments"]


def _turn_from_response(data: dict) -> AssistantTurn:
    msg = data["choices"][0]["message"]
    turn = AssistantTurn(content=msg.get("content") or "",
                         reasoning=msg.get("reasoning_content") or "")
    for tc in msg.get("tool_calls", []) or []:
        fn = tc.get("function", {})
        turn.tool_calls.append({"id": tc.get("id", ""), "name": fn.get("name", ""),
                                "arguments": fn.get("arguments", "")})
    return turn
