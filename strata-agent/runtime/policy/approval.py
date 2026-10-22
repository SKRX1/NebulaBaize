"""Approval policy engine: which actions need a user confirmation.

Pure standard library. Rules are declared in config/approval.yaml (or .json fallback).
Default sensitive actions needing approval: file write, shell exec, and destructive delete.
Network lookup (websearch) is auto-approved — the agent decides autonomously without
nagging the user on each search. Returns an explicit allow / require-approval decision the
loop consults before executing a tool.
"""
from __future__ import annotations

import json
import os

# Namespaces here are the PRODUCTION tool names (server__verb as the executor derives
# them), NOT aliases. A stale alias (e.g. "fs__write") made this default fire on nothing,
# so the gate only worked when config/approval.yaml happened to override it. Keep this in
# lockstep with the real server names so the default path is correct on its own.
DEFAULT_RULES = {
    "auto_approve": [
        "websearch__search",   # network lookup: autonomous, no nagging (user choice)
    ],
    "require_approval": [
        "filesystem__write",   # write a file
        "shell__exec",         # run a shell command
        "memory__forget",      # destructive: delete learned memory / a corpus source
    ],
    "destructive_force_confirm": True,
}


class Approval:
    def __init__(self, config_path: str | None = None):
        self.rules = dict(DEFAULT_RULES)
        if config_path and os.path.isfile(config_path):
            try:
                from config_loader import load_config
            except ImportError:
                import sys, os as _os
                sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
                from config_loader import load_config
            for k, v in (load_config(config_path) or {}).items():
                self.rules[k] = v

    def needs_approval(self, tool: str) -> bool:
        if tool in self.rules.get("auto_approve", []):
            return False
        return tool in self.rules.get("require_approval", [])
