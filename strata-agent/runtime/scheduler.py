"""Lightweight pure-standard-library scheduler (no third-party, no OS scheduler).

This is the time-trigger layer the project previously lacked (its other automations are
event-driven). A daemon process loads a `schedule` block from config and sleeps to the
nearest next fire time, then invokes each entry's action — the loop is pure stdlib
(datetime + time), so the project stays dependency-free and self-contained (no reliance
on Windows Task Scheduler / cron).

Each schedule entry declares WHAT to run and WHEN it fires (pick one):
  every_minutes / every_hours   interval-based recurring
  daily_at: "HH:MM"             time-of-day recurring
  at: "YYYY-MM-DDTHH:MM"        one-shot (fires once, then removed)

Production hardening (this revision):
  - One-shot persistence: consumed one-shot names are recorded to a state file so a
    daemon restart does NOT re-fire a one-shot that already ran.
  - Misfire coalescing: if a recurring entry is past its next-fire by many intervals
    (e.g. the machine slept/offline), it fires ONCE on wake and reschedules to the next
    real boundary — it does not run every missed tick.
  - Exception isolation: a task raising does not kill the daemon; it is reported via the
    optional on_event callback and scheduling continues.
  - Optional audit callback for observability (fire / error events).

It is decoupled from HOW a task runs via `run_task(name, task)`, so it is testable offline
(inject a recorder + a fake clock/sleep) and drives the real agent in the gateway daemon.
It never invents a fire: it sleeps to a real computed next-fire timestamp via the clock.
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import time


class ScheduleEntry:
    def __init__(self, name, task, every_minutes=None, every_hours=None,
                 daily_at=None, at=None, clock=None):
        self.name = name
        self.task = task
        self.every_s = None
        if every_minutes is not None:
            self.every_s = float(every_minutes) * 60
        if every_hours is not None:
            self.every_s = float(every_hours) * 3600
        self.daily_at = daily_at          # "HH:MM"
        self.at = at                       # one-shot ISO datetime
        self.oneshot = at is not None
        self.dead = False
        self._clock = clock or time.time
        # Records whether the caller pinned a clock, so Scheduler can adopt only the
        # entries that did not — see Scheduler.__init__.
        self._clock_explicit = clock is not None
        self.next_fire = self._compute_next()

    def _compute_next(self):
        now_ts = self._clock()
        now = _dt.datetime.fromtimestamp(now_ts)
        if self.at is not None:
            return _dt.datetime.fromisoformat(self.at).timestamp()
        if self.daily_at is not None:
            hh, mm = (int(x) for x in self.daily_at.split(":"))
            fire = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
            if fire.timestamp() <= now_ts:
                fire = fire + _dt.timedelta(days=1)
            return fire.timestamp()
        if self.every_s is not None:
            return now_ts + self.every_s
        return None

    def reschedule(self):
        if self.oneshot:
            self.dead = True   # one-shot is consumed after firing
            return
        self.next_fire = self._compute_next()


class Scheduler:
    def __init__(self, entries, run_task, clock=None, sleep=None,
                 state_path=None, on_event=None):
        self._clock = clock or time.time
        self._sleep = sleep or time.sleep
        self.on_event = on_event or (lambda ev: None)
        self.state_path = state_path
        self._consumed, self._run_history = self._load_state()
        # Make every entry share the scheduler's clock, so production needs no
        # per-entry clock wiring and a test can drive all entries with one fake clock.
        # The old guard was `getattr(e, "_clock", None) is None`, which could never be
        # true — ScheduleEntry.__init__ always assigns a real clock first — so the
        # injected clock silently did not reach the entries and next_fire stayed
        # computed against wall-clock time. Entries that pinned their own clock keep it.
        for e in entries:
            if not getattr(e, "_clock_explicit", False):
                e._clock = self._clock
                e.next_fire = e._compute_next()
        # drop one-shots already consumed in a previous daemon run (survives restart)
        self.entries = [e for e in entries
                        if not e.dead and e.name not in self._consumed]
        self.run_task = run_task

    # ---- persisted one-shot state ----
    def _load_state(self):
        if not self.state_path or not os.path.isfile(self.state_path):
            return set(), {}
        try:
            with open(self.state_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return set(data.get("consumed_oneshots", [])), data.get("last_run", {})
        except Exception:
            return set(), {}

    def _save_state(self) -> None:
        if not self.state_path:
            return
        try:
            os.makedirs(os.path.dirname(os.path.abspath(self.state_path)), exist_ok=True)
            with open(self.state_path, "w", encoding="utf-8") as f:
                json.dump({"consumed_oneshots": sorted(self._consumed),
                           "last_run": self._run_history}, f)
        except Exception:
            pass

    def _record_last_run(self, name, ok):
        self._run_history[name] = {"ts": self._clock(), "ok": ok}
        self._save_state()

    def _safe_run(self, entry) -> bool:
        """Run a task with exception isolation. Returns True on success."""
        try:
            self.run_task(entry.name, entry.task)
            return True
        except Exception as e:
            self.on_event({"type": "schedule-error", "name": entry.name, "error": str(e)})
            return False

    def due(self, now_ts=None):
        """Fire every due entry (misfire-coalesced to one run), reschedule each.

        Returns fired names. A recurring entry late by many intervals runs ONCE and jumps
        to the next real boundary (no replay of every missed tick). Exceptions in a task do
        not stop the loop.
        """
        now_ts = self._clock() if now_ts is None else now_ts
        fired = []
        for e in self.entries:
            if e.dead:
                continue
            if e.next_fire is not None and e.next_fire <= now_ts:
                late = now_ts - e.next_fire
                ok = self._safe_run(e)
                fired.append(e.name)
                self._record_last_run(e.name, ok)
                if late > 0:
                    self.on_event({"type": "schedule-misfire", "name": e.name,
                                   "late_s": round(late, 1), "ok": ok})
                if e.oneshot:
                    self._consumed.add(e.name)
                    self._save_state()
                e.reschedule()
        self.entries = [e for e in self.entries if not e.dead]
        return fired

    def run(self, max_fire=None):
        """Sleep to the nearest next fire, fire it, repeat. Returns total fires performed."""
        count = 0
        while self.entries:
            fired = self.due()
            if fired:
                count += len(fired)
                self.on_event({"type": "schedule-fire", "names": fired})
                if max_fire is not None and count >= max_fire:
                    return count
            nxt = min((e.next_fire for e in self.entries if e.next_fire is not None),
                      default=None)
            if nxt is None:
                break
            self._sleep(max(0.0, nxt - self._clock()))
        return count
