"""Verifier: an automated self-test / self-debug gate (pure standard library).

This is the wiring that turns "the agent CAN run tests and fix bugs" into an
AUTOMATED loop: at task end the loop runs the verifier; if it reports red, the
failure output is fed back into the conversation so the model reflects and fixes,
then verifies again — up to a small retry budget. Green ends the task.

Two construction styles (both stdlib-only):

  1. Command-based (the production default): give a shell command, e.g. the test
     suite. Success is defined by the command's exit code (0 => pass) — the same
     contract CI uses, so it is unambiguous and not text-guessing.

  2. Callable-based: pass a `check_fn() -> (passed: bool, output: str)` for custom
     checks (lint, type-check, an HTML render/console probe once a browser tool is
     wired in, etc.).

It does NOT invent results: a command it cannot run reports failure with the error,
so a red verification is always real signal, never a hallucinated green.
"""
from __future__ import annotations

import subprocess

from textenc import smart_decode


class Verifier:
    def __init__(self, command: str | None = None, check_fn=None,
                 cwd: str | None = None, timeout_s: int = 120):
        if command is None and check_fn is None:
            raise ValueError("Verifier needs either a command or a check_fn")
        self.command = command
        self.check_fn = check_fn
        self.cwd = cwd
        self.timeout_s = timeout_s

    def check(self) -> tuple[bool, str]:
        """Return (passed, output). Exit code 0 => pass for the command path."""
        if self.check_fn is not None:
            try:
                res = self.check_fn()
                if isinstance(res, tuple):
                    return bool(res[0]), (res[1] if len(res) > 1 else "")
                return bool(res), ""
            except Exception as e:  # a crashing checker is a RED, not a silent green
                return False, f"checker raised: {e}"
        # command path
        try:
            # Capture *bytes* and decode explicitly: `text=True` would use the locale
            # codec (GBK here), so a pytest/node/git failure message written in UTF-8
            # reached the model as mojibake -- useless for the self-fix loop.
            out = subprocess.run(self.command, capture_output=True,
                                 timeout=self.timeout_s, shell=True, cwd=self.cwd)
        except Exception as e:
            return False, f"verifier could not run '{self.command}': {e}"
        combined = smart_decode(out.stdout)
        err = smart_decode(out.stderr)
        if err.strip():
            combined += "\n[stderr]\n" + err
        return out.returncode == 0, combined.strip()
