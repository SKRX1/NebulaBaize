"""Checkpoint store: persist a long-running task's conversation so it can resume from the
last saved point after a crash/restart. Pure standard library (JSON on disk).

This is the durability layer for long autonomous tasks: previously if the process died
mid-run, only what had already been distilled to episodic memory survived — the live
conversation (the working history) was lost. A checkpoint captures the authoritative
message history to disk; on restart, run() can be seeded from it to continue where it
left off.

Design notes:
  - save(history) writes the full message list atomically (write temp then rename), so a
    crash mid-write never leaves a half-written checkpoint.
  - load() returns [] when no checkpoint exists, so callers can treat "no checkpoint" as
    "start fresh" uniformly.
  - It stores the message history only — memory layers (episodic/semantic) are already
    persisted separately, so a checkpoint is purely about the live window.
  - The path is injectable so it is offline-testable without polluting data/.
"""
from __future__ import annotations

import json
import os


class CheckpointStore:
    def __init__(self, path: str):
        self.path = path

    def exists(self) -> bool:
        return os.path.isfile(self.path)

    def save(self, history: list[dict]) -> None:
        """Atomically persist the message history (temp write + os.replace)."""
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(list(history), f, ensure_ascii=False)
        os.replace(tmp, self.path)

    def load(self) -> list[dict]:
        if not self.exists():
            return []
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []
