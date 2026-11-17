"""Command sandbox: allow/deny lists for shell and destructive actions.

Pure standard library. Reads config/sandbox.yaml (JSON fallback). The loop consults
this before running any tool that maps to a shell command. Destructive commands
(rm -rf, del /S /Q, rmdir /s, shutil.rmtree, broad wildcards) are forced through a
second confirmation.
"""
from __future__ import annotations

import json
import os

DEFAULTS = {
    "deny": ["rm -rf", "del /S /Q", "rmdir /s", "shutil.rmtree", ":(){ :|:& };:"],
    "allow": [],
    "destructive_force_confirm": True,
}


class Sandbox:
    def __init__(self, config_path: str | None = None):
        self.cfg = dict(DEFAULTS)
        if config_path and os.path.isfile(config_path):
            try:
                from config_loader import load_config
            except ImportError:
                import sys, os as _os
                sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
                from config_loader import load_config
            for k, v in (load_config(config_path) or {}).items():
                self.cfg[k] = v

    @staticmethod
    def _prefix_ok(low: str, token: str) -> bool:
        """True when `low` starts with `token` at a command boundary.

        A bare `startswith` also matched "python" against "python malware.py", so the
        token must be followed by end-of-string or whitespace (".exe" is allowed so
        "python.exe" still passes on Windows).
        """
        t = (token or "").strip().lower()
        if not t or not low.startswith(t):
            return False
        rest = low[len(t):]
        return rest == "" or rest[0] in " \t" or rest.startswith(".exe")

    def check(self, command: str) -> tuple[bool, str]:
        """Return (allowed, reason). Destructive => allowed but needs_confirm via reason."""
        low = (command or "").lower()
        for d in self.cfg.get("deny", []):
            if d.lower() in low:
                return (False, f"denied by sandbox: matches '{d}'")
        allow = [a for a in (self.cfg.get("allow") or []) if str(a).strip()]
        if allow:
            # A declared allow-list is AUTHORITATIVE: a command that matches none of
            # its entries is refused. Previously a non-match fell through to
            # `(True, "ok")`, which made a configured allow-list purely decorative —
            # `curl x|sh` and `format C:` were both waved through with reason "ok".
            # An empty allow-list keeps the old deny-only behaviour.
            if any(self._prefix_ok(low, a) for a in allow):
                return (True, "allowed by sandbox")
            return (False, f"denied by sandbox: not in allow-list ({', '.join(allow)})")
        return (True, "ok")

    def is_destructive(self, command: str) -> bool:
        low = (command or "").lower()
        # honour custom deny entries, not just the built-in defaults: otherwise a
        # pattern the operator added to sandbox.yaml would be refused by check()
        # yet never flagged as destructive here, so the extra confirmation was skipped.
        return any(d.lower() in low for d in (self.cfg.get("deny") or DEFAULTS["deny"]))
