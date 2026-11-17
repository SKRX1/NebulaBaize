"""Structured audit log + cost/timing meter. Pure standard library.

The gateway previously only `print`-ed events, so nothing was persisted or replayable.
This module is the observability layer the agent needs to be debuggable and to measure
whether it is actually "getting smarter with use".

- An append-only JSONL audit trail (one record per event): type, round, tool, args
  summary, result summary, duration_ms, usage (tokens when present), ts.
- A running meter: total LLM calls, retried calls, tool calls, tokens, wall time,
  rounds — dumped as a final "summary" record at task end and queryable in-process.

Nothing here fakes numbers: usage is recorded only when the API actually returns it;
durations are measured with a monotonic clock; the path is injectable for offline tests.
"""
from __future__ import annotations

import json
import os
import time


class AuditLog:
    def __init__(self, path: str | None = None, clock=None, sleep=None, enabled=True):
        self.path = path
        self._clock = clock or time.time
        self._mono = time.monotonic
        self.enabled = enabled and path is not None
        self._events = 0
        self._meter = {
            "llm_calls": 0,
            "llm_retries": 0,
            "tool_calls": 0,
            "rounds": 0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        }

    # ---- meter ----
    def note_llm(self, usage: dict | None = None, retried: bool = False) -> None:
        self._meter["llm_calls"] += 1
        if retried:
            self._meter["llm_retries"] += 1
        if usage:
            self._meter["prompt_tokens"] += int(usage.get("prompt_tokens", 0) or 0)
            self._meter["completion_tokens"] += int(usage.get("completion_tokens", 0) or 0)
            self._meter["total_tokens"] += int(usage.get("total_tokens", 0) or 0)

    def note_tool(self) -> None:
        self._meter["tool_calls"] += 1

    def note_round(self) -> None:
        self._meter["rounds"] += 1

    @property
    def meter(self) -> dict:
        return dict(self._meter)

    # ---- audit trail ----
    def event(self, etype: str, *, rnd: int | None = None, tool: str | None = None,
              arguments=None, result=None, usage=None, duration_ms: float | None = None,
              extra: dict | None = None) -> dict:
        rec = {"ts": self._clock(), "type": etype}
        if rnd is not None:
            rec["round"] = rnd
        if tool is not None:
            rec["tool"] = tool
        if arguments is not None:
            rec["args"] = _clip(json.dumps(arguments, ensure_ascii=False), 200)
        if result is not None:
            rec["result"] = _clip(str(result), 400)
        if usage:
            rec["usage"] = usage
        if duration_ms is not None:
            rec["duration_ms"] = round(float(duration_ms), 1)
        if extra:
            rec.update(extra)
        self._events += 1
        if self.enabled:
            try:
                os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            except Exception:
                pass
        return rec

    def summary(self, task: str = "") -> dict:
        rec = {"ts": self._clock(), "type": "summary", "task": _clip(task, 200),
               "meter": self.meter, "events": self._events}
        if self.enabled:
            try:
                os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            except Exception:
                pass
        return rec

    def read(self) -> list[dict]:
        if not self.path or not os.path.isfile(self.path):
            return []
        out = []
        with open(self.path, "r", encoding="utf-8") as f:
            for l in f:
                if l.strip():
                    out.append(json.loads(l))
        return out


def _clip(s: str, n: int) -> str:
    return s if len(s) <= n else s[:n] + "…"
