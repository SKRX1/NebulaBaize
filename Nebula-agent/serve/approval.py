# Tool-approval policy for the per-workspace permission gate (the `auto`/`manual` tiers).
# Extracted from serve/server.py: the destructive-shell deny patterns, the registry-mutation
# approval set, and the three pure predicates the MCP tool loop calls (_needs_approval /
# _auto_deny / _approval_desc). Pure: stdlib json + re only, no server globals.

import json
import re


# Destructive shell patterns we refuse to auto-run. Anchored with word boundaries (not a required
# leading whitespace) so they still fire when the command is embedded in JSON arguments, while
# ordinary build commands that merely contain these substrings (e.g. a path with "model") are not caught.
_DESTRUCTIVE_SHELL = re.compile(
    r"\b(?:"
    r"rm\s+-rf|rm\s+-r\b|rmdir\s+/s|del\s+/[sq]|format\s+[a-z]:|mkfs|shutdown|reboot|"
    r"shutil\.rmtree|dd\s+if=|"
    r"curl\s+[^|]*\|\s*(?:ba)?sh|wget\s+[^|]*\|\s*(?:ba)?sh"
    r")", re.I)
# Patterns that START with punctuation cannot live inside the \b(?:...)\b wrapper above: a word
# boundary never exists between two non-word characters, so "… > /dev/sda" and the classic
# ":(){ :|:& };:" fork bomb silently never matched. They are anchored on a command separator
# (start of string, whitespace, or a shell separator/quote) instead.
_DESTRUCTIVE_SYMBOLS = re.compile(
    r"(?:^|[\s;|&`\"'(])"
    r"(?:>\s*/dev/sd|:\s*\(\)\s*\{\s*:)", re.I)


# Tools whose effect outlives the conversation: the registry server's six mutations
# (servers/registry_server.py) write config/mcp_servers.json or skills/*.yaml, i.e.
# "start this program on the user's machine" — remote code execution by design. Even
# the autonomous `auto` tier pauses for approval on these, exactly like `manual` does
# for every tool. The read-only registry tools (list/get) and the probe (test_server,
# which persists nothing) are deliberately absent. Keep in lockstep with
# config/approval.yaml (the standalone mode's list) — the two must name the same set.
_APPROVAL_TOOLS = frozenset({
    "registry__add_server", "registry__update_server", "registry__delete_server",
    "registry__add_skill", "registry__update_skill", "registry__delete_skill",
})


def _needs_approval(tool_name: str) -> bool:
    """True for the registry mutations: a toolbox change always asks, even in `auto`."""
    return (tool_name or "") in _APPROVAL_TOOLS


def _auto_deny(tool_name: str, arguments) -> tuple[bool, str | None]:
    """For the `auto` tier: return (deny, reason) when a tool call looks destructive enough to block."""
    if not isinstance(arguments, str):
        try:
            arguments = json.dumps(arguments, ensure_ascii=False)
        except Exception:
            arguments = str(arguments)
    name = (tool_name or "").lower()
    if ("shell" in name or "exec" in name or name.endswith("run") or "command" in name) \
            and (_DESTRUCTIVE_SHELL.search(arguments or "")
                 or _DESTRUCTIVE_SYMBOLS.search(arguments or "")):
        return True, "auto-review blocked a destructive shell command"
    return False, None


def _approval_desc(tool_name: str, arguments) -> str:
    try:
        a = arguments if isinstance(arguments, str) else json.dumps(arguments, ensure_ascii=False)
    except Exception:
        a = str(arguments)
    if len(a) > 320:
        a = a[:320] + "…"
    return f"{tool_name}: {a}"
