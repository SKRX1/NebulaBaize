"""Schedule MCP server: manage the daemon's schedule entries (pure standard library).

Mirrors memory_server's pattern so the web panel can drive it via the existing /mcp/call
proxy. This server reads and writes the SAME config the daemon loads (config/mcp_servers.json
-> schedule.entries), so what the panel writes is exactly what the daemon will read on its
next start. In --serve mode the scheduler runs as a fused background thread (scheduler_host) that
re-reads this config every tick, so add / remove / update take effect live (no restart). Under
the bare `--daemon` path, which reads the schedule once at startup, an edit lands on
the next daemon start.

Tools:
  list    -> the current entries plus a computed next-fire, for the panel to render
  add     -> append one entry: {name, task, <one of: every_minutes|every_hours|daily_at|at>}
  update  -> edit an existing entry by name: {name, [new_name], [task], <optional one trigger>}
  remove  -> drop one entry by name (the panel treats this as destructive -> approval)
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "runtime"))
from _mcp_base import McpServerBase  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.environ.get("SCHEDULE_CONFIG", os.path.join(ROOT, "config", "mcp_servers.json"))
STATE = os.environ.get("SCHEDULE_STATE", os.path.join(ROOT, "data", "schedule_state.json"))


def _load_state() -> dict:
    """Read the daemon's persisted state (consumed one-shots + last_run history)."""
    if not os.path.isfile(STATE):
        return {}
    try:
        with open(STATE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_state(state: dict) -> None:
    with open(STATE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
        f.write("\n")


def _load_cfg() -> dict:
    with open(CONFIG, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_cfg(cfg: dict) -> None:
    with open(CONFIG, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
        f.write("\n")


def _next_fire(entry: dict) -> str:
    """Compute a next-fire label mirroring scheduler.ScheduleEntry._compute_next."""
    now = _dt.datetime.now()
    if entry.get("at"):
        try:
            return _dt.datetime.fromisoformat(entry["at"]).strftime("%Y-%m-%d %H:%M") + " (one-shot)"
        except Exception:
            return entry["at"] + " (one-shot)"
    if entry.get("daily_at"):
        try:
            hh, mm = (int(x) for x in str(entry["daily_at"]).split(":"))
            fire = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
            if fire <= now:
                fire = fire + _dt.timedelta(days=1)
            return fire.strftime("today/tmr %H:%M").split(" ")[0] + " " + fire.strftime("%H:%M")
        except Exception:
            return entry["daily_at"]
    mins = entry.get("every_minutes")
    hours = entry.get("every_hours")
    if mins is not None:
        return f"every {mins} min"
    if hours is not None:
        return f"every {hours} h"
    return "—"


def _trigger_label(entry: dict) -> str:
    if entry.get("at"):
        return f"at {entry['at']}"
    if entry.get("daily_at"):
        return f"daily_at {entry['daily_at']}"
    if entry.get("every_minutes") is not None:
        return f"every_minutes {entry['every_minutes']}"
    if entry.get("every_hours") is not None:
        return f"every_hours {entry['every_hours']}"
    return "—"


TRIGGER_KEYS = ("every_minutes", "every_hours", "daily_at", "at")
INT_TRIGGER_KEYS = ("every_minutes", "every_hours")


class ScheduleServer(McpServerBase):
    name = "schedule"
    tools = [
        {"name": "list", "description": "List the daemon's schedule entries (name, trigger, next fire) for the panel",
         "inputSchema": {"type": "object", "properties": {}}},
        {"name": "add", "description": "Add a schedule entry (takes effect immediately in --serve mode; on daemon restart in bare --daemon mode): name, task, and exactly one of every_minutes/every_hours/daily_at/at",
         "inputSchema": {"type": "object", "properties": {
            "name": {"type": "string"}, "task": {"type": "string"},
            "every_minutes": {"type": "integer"}, "every_hours": {"type": "integer"},
            "daily_at": {"type": "string"}, "at": {"type": "string"}},
            "required": ["name", "task"]}},
        {"name": "update", "description": "Update a schedule entry by name (destructive when renaming; takes effect immediately in --serve mode): name locates the entry; optional new_name, task, and at most one of every_minutes/every_hours/daily_at/at (a provided trigger REPLACES the entry's whole trigger)",
         "inputSchema": {"type": "object", "properties": {
            "name": {"type": "string"}, "new_name": {"type": "string"}, "task": {"type": "string"},
            "every_minutes": {"type": "integer"}, "every_hours": {"type": "integer"},
            "daily_at": {"type": "string"}, "at": {"type": "string"}},
            "required": ["name"]}},
        {"name": "remove", "description": "Remove a schedule entry by name (destructive: takes effect immediately in --serve mode)",
         "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}},
    ]

    def call_tool(self, name, args):
        cfg = _load_cfg()
        entries = (cfg.get("schedule") or {}).get("entries") or []
        if name == "list":
            if not entries:
                return "no schedule entries"
            state = _load_state()
            last_run = state.get("last_run", {})
            out = []
            for e in entries:
                lr = last_run.get(e.get("name", ""))
                out.append(json.dumps({
                    "name": e.get("name", ""), "trigger": _trigger_label(e),
                    "next": _next_fire(e), "task": (e.get("task") or "")[:80],
                    "last_run": lr, "consumed": e.get("name", "") in state.get("consumed_oneshots", [])},
                    ensure_ascii=False))
            return "\n".join(out)
        if name == "add":
            nm = args.get("name", "").strip()
            task = args.get("task", "").strip()
            if not nm or not task:
                return "name and task are required"
            # exactly one trigger must be present (mirror scheduler semantics)
            trig = {k: args[k] for k in TRIGGER_KEYS if args.get(k) not in (None, "")}
            if len(trig) != 1:
                return "provide exactly one of: every_minutes, every_hours, daily_at, at"
            if any(e.get("name") == nm for e in entries):
                return f"an entry named {nm!r} already exists"
            entry = {"name": nm, "task": task, **trig}
            entries.append(entry)
            cfg.setdefault("schedule", {})["entries"] = entries
            _save_cfg(cfg)
            return f"added '{nm}' ({list(trig.keys())[0]}={list(trig.values())[0]}) — takes effect now (live scheduler; no restart needed)"
        if name == "update":
            nm = args.get("name", "").strip()
            entry = next((e for e in entries if e.get("name") == nm), None)
            if entry is None:
                return f"no entry named {nm!r}"
            new_name = (args.get("new_name") or "").strip()
            new_task = (args.get("task") or "").strip()
            trig_present = [k for k in TRIGGER_KEYS if args.get(k) not in (None, "")]
            if not new_name and not new_task and not trig_present:
                return "nothing to update (provide new_name, task, or a trigger field)"
            if len(trig_present) > 1:
                return "provide at most one of: every_minutes, every_hours, daily_at, at"
            if new_name and new_name != nm and any(e.get("name") == new_name for e in entries):
                return f"an entry named {new_name!r} already exists"
            # apply task
            if new_task:
                entry["task"] = new_task
            # apply trigger: a provided trigger REPLACES the entry's whole trigger
            if len(trig_present) == 1:
                k = trig_present[0]
                for tk in TRIGGER_KEYS:
                    entry.pop(tk, None)
                val = args[k]
                entry[k] = int(val) if k in INT_TRIGGER_KEYS else str(val).strip()
            # apply rename + migrate persisted state (last_run / consumed) so history follows the new name
            if new_name and new_name != nm:
                state = _load_state()
                migrated = False
                lr = state.get("last_run", {})
                if nm in lr:
                    lr[new_name] = lr.pop(nm)
                    migrated = True
                cons = state.get("consumed_oneshots", [])
                if nm in cons:
                    cons[cons.index(nm)] = new_name
                    migrated = True
                if migrated:
                    _save_state(state)
                entry["name"] = new_name
            cfg.setdefault("schedule", {})["entries"] = entries
            _save_cfg(cfg)
            suffix = f" -> '{new_name}'" if new_name and new_name != nm else ""
            return f"updated '{nm}'{suffix} — takes effect now (live scheduler; no restart needed)"
        if name == "remove":
            nm = args.get("name", "").strip()
            before = len(entries)
            kept = [e for e in entries if e.get("name") != nm]
            if len(kept) == before:
                return f"no entry named {nm!r}"
            cfg.setdefault("schedule", {})["entries"] = kept
            _save_cfg(cfg)
            return f"removed '{nm}' — takes effect now (live scheduler; no restart needed)"
        raise Exception(f"unknown tool: {name}")


if __name__ == "__main__":
    sys.exit(ScheduleServer().run())
