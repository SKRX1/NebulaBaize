"""Skills loader: scan skills/*.yaml and merge them into the MCP server set.

Pure standard library (uses config_loader's built-in YAML parser). This is what makes the
"copy a skill folder in and it works" promise real: previously skills/*.yaml were a spec
with no code loading them. Each skill declares tool servers (command + args); the loader
turns them into standard mcpServers entries the Executor can start.

A skill yaml looks like:
    name: pdf-tools
    tools:
      - mcp: pdf-server
        command: python
        args: ["skills/pdf-tools/server.py"]
    permissions: {filesystem: [read], shell: [exec]}
    requires_env: {PYTHONPATH: "$SKILL_DIR/lib"}

`$SKILL_DIR` is expanded to the skill file's directory (absolute), so paths resolve
relative to the package root regardless of cwd.
"""
from __future__ import annotations

import os

from config_loader import load_config


def _expand(value, skill_dir: str):
    if isinstance(value, str):
        return value.replace("$SKILL_DIR", skill_dir)
    if isinstance(value, list):
        return [_expand(v, skill_dir) for v in value]
    if isinstance(value, dict):
        return {k: _expand(v, skill_dir) for k, v in value.items()}
    return value


def load_skills(skills_dir: str) -> dict:
    """Return {server_name: {command, args, env, cwd}} for every skill in skills_dir.

    Returns {} when the dir is missing. Names are namespaced as the skill's tool `mcp`.
    """
    out: dict = {}
    for name, entry, meta in _scan(skills_dir):
        out[name] = entry
    return out


def is_within_permissions(meta: dict, verb: str) -> bool:
    """Decide whether a skill tool action is within its declared permissions.

    A skill that declares NO permissions => default behavior (not forced). When it DOES
    declare permissions, an action is auto-approved only if its verb is listed under some
    scope; anything outside the granted actions is forced through the approval gate. This
    is the rule that makes a skill's declared `permissions` actually mean something.
    """
    perms = meta.get("permissions") or {}
    if not perms:
        return True
    allowed = set()
    for scope_actions in perms.values():
        if isinstance(scope_actions, list):
            allowed.update(scope_actions)
    return verb in allowed


def matches_trigger(meta: dict, text: str) -> bool:
    """True if the task text hits any of the skill's declared trigger keywords."""
    t = (text or "").lower()
    return any(str(kw).lower() in t for kw in (meta.get("triggers") or []))


def load_skills_meta(skills_dir: str) -> dict:
    """Return {server_name: {name, permissions, triggers}} so declared skill policy runs.

    Previously permissions/triggers in skills/*.yaml were decorative (the loader dropped
    them). This returns them so the gateway can enforce them: a tool action whose scope is
    NOT inside the skill's declared `permissions` is forced through the approval gate, and
    a `triggers` keyword hit on the task surfaces the skill (surfacing, not auto-execution).
    """
    return {name: meta for name, _entry, meta in _scan(skills_dir)}


def _scan(skills_dir: str):
    """Shared scan: yield (server_name, entry, meta) tuples per declared skill tool."""
    if not os.path.isdir(skills_dir):
        return
    for fn in sorted(os.listdir(skills_dir)):
        if not fn.endswith((".yaml", ".yml", ".json")):
            continue
        path = os.path.join(skills_dir, fn)
        skill = load_config(path) or {}
        skill_dir = os.path.dirname(path)
        perms = skill.get("permissions") or {}
        triggers = skill.get("triggers") or []
        for tool in (skill.get("tools") or []):
            if not isinstance(tool, dict) or "command" not in tool:
                continue
            name = tool.get("mcp") or f"{skill.get('name', fn)}-{tool.get('command')}"
            entry = {"command": tool["command"],
                     "args": _expand(tool.get("args", []), skill_dir),
                     # Default the working directory to the SKILL's own directory
                     # (the same meaning $SKILL_DIR has elsewhere in the file) rather
                     # than ".", which silently resolved to the process cwd and made
                     # a skill's relative paths depend on where the gateway was launched.
                     "cwd": _expand(tool.get("cwd") or "$SKILL_DIR", skill_dir)}
            env_extra = _expand(skill.get("requires_env", {}) or {}, skill_dir)
            if env_extra:
                entry["env"] = env_extra
            meta = {"name": skill.get("name", fn), "permissions": perms, "triggers": triggers}
            yield name, entry, meta
