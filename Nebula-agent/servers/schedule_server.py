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
    if entry.get("weekly_at"):
        return "weekly " + str(entry["weekly_at"])
    if entry.get("monthly_at"):
        return "monthly " + str(entry["monthly_at"])
    if entry.get("yearly_at"):
        return "yearly " + str(entry["yearly_at"])
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
    if entry.get("weekly_at"):
        return f"weekly_at {entry['weekly_at']}"
    if entry.get("monthly_at"):
        return f"monthly_at {entry['monthly_at']}"
    if entry.get("yearly_at"):
        return f"yearly_at {entry['yearly_at']}"
    if entry.get("every_minutes") is not None:
        return f"every_minutes {entry['every_minutes']}"
    if entry.get("every_hours") is not None:
        return f"every_hours {entry['every_hours']}"
    return "—"


TRIGGER_KEYS = ("every_minutes", "every_hours", "daily_at", "at",
                "weekly_at", "monthly_at", "yearly_at")
INT_TRIGGER_KEYS = ("every_minutes", "every_hours")

# Format validators for the new time-spec triggers. Each returns None when the value is
# acceptable, else a human-readable complaint the tool surfaces verbatim. Parse rules are
# mirrored in runtime/scheduler.py (_parse_dom_hm/_parse_mm_dd_hm) -- keep in lockstep.
def _check_spec(key, val):
    import scheduler as _sched  # runtime/ is on sys.path above
    try:
        if key == "weekly_at":
            dpart, hm = str(val).strip().split(":", 1)
            int(dpart)
            hh, mm = (int(x) for x in hm.split(":"))
            assert 0 <= int(dpart) <= 6 and 0 <= hh <= 23 and 0 <= mm <= 59
        elif key == "monthly_at":
            dd, hh, mm = _sched._parse_dom_hm(str(val))
            assert 1 <= dd <= 31 and 0 <= hh <= 23 and 0 <= mm <= 59
        elif key == "yearly_at":
            mon, dd, hh, mm = _sched._parse_mm_dd_hm(str(val))
            assert 1 <= mon <= 12 and 1 <= dd <= 31 and 0 <= hh <= 23 and 0 <= mm <= 59
    except Exception:
        want = {"weekly_at": "D:HH:MM (0=Sun..6)", "monthly_at": "DD HH:MM",
                "yearly_at": "MM-DD HH:MM"}[key]
        return f"bad {key} value {val!r}, expected {want}"
    return None


APPROVAL_LEVELS = ("full", "review", "manual")


def _check_overrides(args):
    """Validate the optional per-entry execution overrides; returns complaint or None."""
    if args.get("approval") not in (None, "") and args["approval"] not in APPROVAL_LEVELS:
        return f"approval must be one of {APPROVAL_LEVELS}"
    roots = args.get("roots")
    if roots not in (None, "") and not (isinstance(roots, list) and all(isinstance(r, str) and r.strip() for r in roots)):
        return "roots must be a list of path strings"
    model = args.get("model")
    if model not in (None, "") and not isinstance(model, str):
        return "model must be a string (a model id from the model list, empty = follow chat)"
    return None


class ScheduleServer(McpServerBase):
    name = "schedule"
    tools = [
        {"name": "list", "description": "为面板列出守护进程的定时任务条目（名称、触发器、下次触发时间）",
         "inputSchema": {"type": "object", "properties": {}}},
        {"name": "add", "description": "新增一条定时任务（在 --serve 模式下立即生效；在纯 --daemon 模式下于守护进程重启时生效）：name、task，以及 every_minutes/every_hours/daily_at/weekly_at/monthly_at/yearly_at/at 中恰好一个，外加可选 roots（列表）、approval（full/review/manual）、model（留空=跟随对话所选模型）",
         "inputSchema": {"type": "object", "properties": {
            "name": {"type": "string"}, "task": {"type": "string"},
            "every_minutes": {"type": "integer"}, "every_hours": {"type": "integer"},
            "daily_at": {"type": "string"}, "at": {"type": "string"},
            "weekly_at": {"type": "string"}, "monthly_at": {"type": "string"},
            "yearly_at": {"type": "string"},
            "roots": {"type": "array", "items": {"type": "string"}},
            "approval": {"type": "string", "enum": ["full", "review", "manual"]},
            "model": {"type": "string"},
            "deliver": {"type": "string", "enum": ["audit", "session_summary", "session_stream"]}},
            "required": ["name", "task"]}},
        {"name": "update", "description": "按名称更新一条定时任务（改名时具破坏性；在 --serve 模式下立即生效）：name 用于定位条目；可选 new_name、task，至多一个触发器（所提供的触发器会替换该条目的整个触发器），以及可选 roots/approval/model（提供值即修改它，提供哨兵值 \"-\" 则清回默认）",
         "inputSchema": {"type": "object", "properties": {
            "name": {"type": "string"}, "new_name": {"type": "string"}, "task": {"type": "string"},
            "every_minutes": {"type": "integer"}, "every_hours": {"type": "integer"},
            "daily_at": {"type": "string"}, "at": {"type": "string"},
            "weekly_at": {"type": "string"}, "monthly_at": {"type": "string"},
            "yearly_at": {"type": "string"},
            "roots": {"type": "array", "items": {"type": "string"}},
            "approval": {"type": "string", "enum": ["full", "review", "manual"]},
            "model": {"type": "string"},
            "deliver": {"type": "string", "enum": ["audit", "session_summary", "session_stream"]}},
            "required": ["name"]}},
        {"name": "remove", "description": "按名称删除一条定时任务（破坏性：在 --serve 模式下立即生效）",
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
                    "last_run": lr, "consumed": e.get("name", "") in state.get("consumed_oneshots", []),
                    "roots": e.get("roots") or [], "approval": e.get("approval") or "review",
                    "model": e.get("model") or "", "deliver": e.get("deliver") or ""},
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
                return "provide exactly one of: every_minutes, every_hours, daily_at, at, weekly_at, monthly_at, yearly_at"
            for k, v in trig.items():
                if k not in INT_TRIGGER_KEYS:
                    bad = _check_spec(k, v)
                    if bad:
                        return bad
            bad = _check_overrides(args)
            if bad:
                return bad
            if any(e.get("name") == nm for e in entries):
                return f"an entry named {nm!r} already exists"
            entry = {"name": nm, "task": task, **trig}
            if args.get("roots"):
                entry["roots"] = [str(r).strip() for r in args["roots"]]
            if args.get("approval"):
                entry["approval"] = str(args["approval"]).strip()
            if (args.get("model") or "").strip():
                entry["model"] = str(args["model"]).strip()
            if args.get("deliver"):
                entry["deliver"] = str(args["deliver"]).strip()
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
            override_present = [k for k in ("roots", "approval", "model", "deliver") if args.get(k) is not None]
            if not new_name and not new_task and not trig_present and not override_present:
                return "nothing to update (provide new_name, task, a trigger field, or an override)"
            if len(trig_present) > 1:
                return "provide at most one of: every_minutes, every_hours, daily_at, at, weekly_at, monthly_at, yearly_at"
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
            # apply execution overrides: provide a value to CHANGE, provide "-" to CLEAR
            # back to default. An absent key leaves the existing value alone -- the panel
            # sends the full form state on every save, so this only guards manual calls.
            for k in ("approval", "model", "deliver"):
                if args.get(k) is not None:
                    v = str(args[k]).strip()
                    if v == "-":
                        entry.pop(k, None)
                    else:
                        entry[k] = v
            if args.get("roots") is not None:
                r = args["roots"]
                if r == "-":
                    entry.pop("roots", None)
                elif isinstance(r, list):
                    if r:
                        entry["roots"] = [str(x).strip() for x in r]
                    else:
                        entry.pop("roots", None)
            bad = _check_overrides({k: entry[k] for k in ("roots", "approval", "model") if k in entry})
            if bad:
                return bad
            for k in trig_present:
                if k not in INT_TRIGGER_KEYS:
                    bad = _check_spec(k, args[k])
                    if bad:
                        return bad
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


def main() -> int:
    """入口：源码版由 __main__ 调它；闭源产物里由 `gateway --server <name>` 调它。

    闭源版把 servers/*.py 编成 <name>.pyd（Nuitka --mode=module），扩展模块里
    `__name__` 是模块名而非 "__main__"，故必须由编译后的 gateway 显式调用本函数。
    """
    return ScheduleServer().run()


if __name__ == "__main__":
    sys.exit(main())
