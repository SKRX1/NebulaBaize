"""Scheduler host: the runtime fusion layer between the side-panel schedule and the agent.

The pure-stdlib ``Scheduler`` in scheduler.py owns the *timing* math (compute next-fire,
coalesce misfires, persist one-shot state) and is deliberately left untouched — it has a
live end-to-end test (tests/test_daemon.py) and a production daemon path (gateway --daemon).

This module owns the *lifecycle* that ``Scheduler.run()`` cannot provide, so the serve
process can run the scheduler as a background thread fused with the interactive agent:

  - Hot reload: the panel (servers/schedule_server.py) writes new entries straight to
    ``config/mcp_servers.json``. The daemon's ``Scheduler.run()`` reads entries once at
    startup and never sees later edits. Here every tick re-reads the file and, when the
    entry set changed, rebuilds the Scheduler (preserving the persisted one-shot state so
    a consumed one-shot never re-fires after a reload).
  - Busy arbitration (the user-chosen default "queue, run when idle"): each fired task's
    ``run_task`` callback first blocks on an idle gate, so a scheduled job never runs
    concurrently with a live interactive turn (which would double-spend the model and race
    the shared executor). It queues — it does not skip.
  - Responsive sleep: a long sleep to the next fire is broken into bounded slices on a
    stop Event, so a panel edit (new near-term entry) and a graceful shutdown both take
    effect within a slice, not after the whole sleep.

Everything is dependency-injected (load, clock, sleep, run_task, on_event) so the loop is
testable offline with a fake clock and a recorder — no real agent, no wall-clock sleeps.
"""
from __future__ import annotations

import os
import time

from scheduler import ScheduleEntry, Scheduler

# Default cap on a single sleep slice, in seconds. A slice this short makes a panel edit
# (adding a job that fires within the minute) land on the next slice, and lets a shutdown
# request stop the thread within ~this window, while keeping wakeups cheap.
DEFAULT_SLICE_S = 5.0


def entries_fingerprint(entries: list[dict]) -> tuple:
    """Stable signature of a schedule entry list, for cheap change detection.

    Keyed on the fields that drive timing and execution, so an unrelated edit elsewhere in
    the config does not force a rebuild. Order-normalised by name so a cosmetic reorder in
    the file does not count as a change.
    """
    rows = []
    for e in entries:
        if not isinstance(e, dict):
            continue
        rows.append((
            str(e.get("name", "job")),
            str(e.get("task", "")),
            e.get("every_minutes"),
            e.get("every_hours"),
            e.get("daily_at"),
            e.get("at"),
        ))
    return tuple(sorted(rows))


def build_entries(entries_cfg: list[dict]) -> list[ScheduleEntry]:
    """Turn raw config dicts into ScheduleEntry objects (mirrors gateway --daemon)."""
    out: list[ScheduleEntry] = []
    for ec in entries_cfg:
        if not isinstance(ec, dict):
            continue
        out.append(ScheduleEntry(
            name=ec.get("name", "job"),
            task=ec.get("task", ""),
            every_minutes=ec.get("every_minutes"),
            every_hours=ec.get("every_hours"),
            daily_at=ec.get("daily_at"),
            at=ec.get("at"),
        ))
    return out


class SchedulerHost:
    """Background scheduler driver with hot reload, busy arbitration, interruptible sleep.

    Args:
      load_entries: () -> list[dict]  reads the current schedule.entries from config.
      run_task:     (name, task) -> None  executes one fired entry (production: a queued
                    agent turn). Exceptions are isolated by the inner Scheduler.due().
      state_path:   path for the persisted one-shot / last_run state (shared with the panel).
      stop_event:   object with .is_set() -> bool and .wait(s) -> bool; the host sleeps in
                    slices so stop + reload stay responsive. threading.Event satisfies this.
      idle_gate:    object with .wait(timeout=None) -> truthy, and .set() -> None. The host
                    calls idle_gate.wait() BEFORE running a task so a scheduled job queues
                    behind live interactive turns. None => no arbitration (runs immediately).
      clock, sleep: injectable time (production defaults to time.time / slice-wait).
      on_event:     audit callback (fire / reload / stop / error).
      slice_s:      max seconds per sleep slice (reload/shutdown responsiveness).
      max_iter:     optional cap on loop iterations (tests; None => run until stop/no entries).
    """

    def __init__(self, load_entries, run_task, state_path=None, stop_event=None,
                 idle_gate=None, clock=None, sleep=None, on_event=None,
                 slice_s: float = DEFAULT_SLICE_S, max_iter=None):
        self.load_entries = load_entries
        self.run_task = run_task
        self.state_path = state_path
        self.stop_event = stop_event
        self.idle_gate = idle_gate
        self._clock = clock or time.time
        self._sleep = sleep
        self.on_event = on_event or (lambda ev: None)
        self.slice_s = max(0.01, float(slice_s))
        self.max_iter = max_iter
        self._fp = None
        self.sched: Scheduler | None = None
        self.fires = 0
        self.reloads = 0

    # ---- sleep that is interruptible by stop_event ----
    def _sleep_to(self, target_ts: float) -> None:
        """Sleep until target_ts in bounded slices; wake early if stop_event is set."""
        if self._sleep is not None:
            # Injected sleep (tests): drive it with the raw remaining delta so a fake
            # clock advances deterministically; the stop check is the fake clock's job.
            self._sleep(max(0.0, target_ts - self._clock()))
            return
        # Single slice, then return to run()'s loop so a hot-reloaded, nearer entry
        # (a panel add landing after we started sleeping toward a far next_fire) is
        # seen on the next _ensure_scheduler()/due() pass. A while-loop that only
        # checked stop_event here would sleep past a far next_fire and never observe
        # the near-term entry -- the exact bug the docstring promises not to have.
        if self._stopped():
            return
        remain = target_ts - self._clock()
        if remain <= 0:
            return
        step = min(self.slice_s, remain)
        if self.stop_event is not None:
            self.stop_event.wait(step)
        else:
            time.sleep(step)
        return

    def _stopped(self) -> bool:
        return bool(self.stop_event and self.stop_event.is_set())

    # ---- (re)build the scheduler from the current config, preserving persisted state ----
    def _ensure_scheduler(self) -> None:
        try:
            entries_cfg = self.load_entries() or []
        except Exception as e:
            self.on_event({"type": "schedule-reload-error", "error": str(e)})
            return
        fp = entries_fingerprint(entries_cfg)
        if fp == self._fp and self.sched is not None:
            return
        # Rebuild: a fresh Scheduler reloads the persisted one-shot state, so consumed
        # one-shots stay consumed across a reload (no double-fire on a panel edit).
        self.sched = Scheduler(build_entries(entries_cfg), self._gated_run,
                               clock=self._clock, sleep=None,
                               state_path=self.state_path, on_event=self.on_event)
        changed = self._fp is not None
        self._fp = fp
        if changed:
            self.reloads += 1
            self.on_event({"type": "schedule-reload", "count": len(self.sched.entries)})

    # ---- the callback handed to Scheduler: queue behind interactive turns, then run ----
    def _gated_run(self, name: str, task: str) -> None:
        if self.idle_gate is not None:
            # Busy arbitration (default = queue): block until the agent is idle, so a
            # scheduled task never overlaps a live interactive turn.
            self.idle_gate.wait()
        self.run_task(name, task)

    def next_fire(self):
        if not self.sched:
            return None
        vals = [e.next_fire for e in self.sched.entries if e.next_fire is not None]
        return min(vals) if vals else None

    def run(self) -> int:
        """Drive the scheduler: reload -> fire due -> interruptible sleep, repeat.

        Returns the total number of fired entries. Exits on stop_event, on max_iter, or
        when no entries remain (e.g. all one-shots consumed and none recurring)."""
        it = 0
        while not self._stopped():
            if self.max_iter is not None and it >= self.max_iter:
                break
            it += 1
            self._ensure_scheduler()
            if not self.sched or not self.sched.entries:
                # Nothing to schedule right now: stop if empty at startup (the daemon path
                # exits when there are no entries), otherwise sleep a slice and re-check so
                # a later panel add is picked up by the next reload.
                if self._fp is not None and self.sched is not None and not self.sched.entries:
                    # had entries, now empty -> keep alive on a slice so future adds land
                    self._sleep_to(self._clock() + self.slice_s)
                    continue
                break
            fired = self.sched.due()
            if fired:
                self.fires += len(fired)
                self.on_event({"type": "schedule-fire", "names": fired})
            nxt = self.next_fire()
            if nxt is None:
                # No computable next fire (no entries) — reload window; keep alive a slice.
                self._sleep_to(self._clock() + self.slice_s)
                continue
            self._sleep_to(nxt)
        self.on_event({"type": "schedule-stop", "fires": self.fires,
                       "reloads": self.reloads})
        return self.fires
