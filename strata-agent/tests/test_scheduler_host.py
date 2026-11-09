"""Scheduler host fusion gate: hot reload + busy-queue, offline and deterministic.

This is the regression lock for the option-A fusion (scheduler host fused into --serve).
It exercises runtime/scheduler_host.py with an injected fake clock, an injected sleep,
and a recorder run_task — NO real agent, NO wall-clock sleeps, NO model. It asserts the
three behaviours the fusion added on top of the pure-stdlib Scheduler:

  1. fires a due entry through the run_task callback (the timing loop works when driven),
  2. hot reload: a new entry appearing in load_entries is picked up WITHOUT a restart and
     fires (the panel's add takes effect live),
  3. busy-queue (the chosen default): with the idle gate cleared, a fired task's callback
     blocks until the gate is set — i.e. a scheduled job queues behind a live interactive
     turn and never overlaps it.

Run from the strata-agent folder:  python tests/test_scheduler_host.py
"""
from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from scheduler_host import SchedulerHost, entries_fingerprint, build_entries  # noqa: E402


class FakeClock:
    """Monotonic fake clock; sleep() advances it instantly (deterministic, no real sleep)."""
    def __init__(self, t=1_000_000.0):
        self.t = t

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += max(0.0, s)


class Gate:
    """Minimal idle-gate stub: .is_set/.wait/.set; .wait blocks on .proceed flag."""
    def __init__(self, open_=True):
        self.open_ = open_
        self.wait_calls = 0
        self.released_at = None  # clock value captured by the test when unblocked

    def set(self):
        self.open_ = True

    def clear(self):
        self.open_ = False

    def is_set(self):
        return self.open_

    def wait(self, timeout=None):
        self.wait_calls += 1
        return self.open_


def test_fire_via_callback():
    clock = FakeClock()
    fired = []

    def load():
        return [{"name": "job1", "task": "TASK-ONE", "every_minutes": 1}]

    host = SchedulerHost(load_entries=load, run_task=lambda n, t: fired.append((n, t)),
                         clock=clock, sleep=clock.sleep, max_iter=3)
    # Force the first entry to be due immediately: set its next_fire into the past.
    total = host.run()
    # every_minutes=1 => first next_fire = now+60; the loop sleeps to it, fires, repeats.
    assert total >= 1 and fired and fired[0][0] == "job1", \
        f"job did not fire via callback: total={total} fired={fired}"
    print(f"host-a OK: fired entry via run_task callback (total={total}, first={fired[0]})")


def test_hot_reload_picks_up_new_entry():
    clock = FakeClock()
    fired = []
    state = {"entries": [{"name": "early", "task": "EARLY", "every_minutes": 1}]}

    def load():
        return state["entries"]

    host = SchedulerHost(load_entries=load, run_task=lambda n, t: fired.append(n),
                         clock=clock, sleep=clock.sleep)

    # Run a bounded number of iterations manually so we can mutate the entry list at a
    # known point: the host reloads every tick, so adding "late" mid-run must be seen.
    # Drive: ensure once (build "early"), then mutate, then ensure again -> reload.
    host._ensure_scheduler()
    assert host.sched and [e.name for e in host.sched.entries] == ["early"]
    fp_before = host._fp
    state["entries"] = [
        {"name": "early", "task": "EARLY", "every_minutes": 1},
        {"name": "late", "task": "LATE", "every_minutes": 1},
    ]
    host._ensure_scheduler()
    names = sorted(e.name for e in host.sched.entries)
    assert names == ["early", "late"], f"new entry not reloaded: {names}"
    assert host.reloads == 1 and host._fp != fp_before, \
        f"reload counter not bumped: reloads={host.reloads}"
    print("host-b OK: hot reload picked up a new entry (no restart), reloads=1")


def test_busy_queue_blocks_behind_gate():
    """The chosen default: a fired task waits on the idle gate (queues, never skips)."""
    clock = FakeClock()
    order = []
    gate = Gate(open_=False)  # start BUSY: an interactive turn is live

    def load():
        return [{"name": "job", "task": "T", "every_minutes": 1}]

    def run_task(name, task):
        order.append("ran")

    host = SchedulerHost(load_entries=load, run_task=run_task,
                         clock=clock, sleep=clock.sleep, idle_gate=gate)

    # The gate's wait() must be consulted BEFORE the task runs. The Scheduler.due() path
    # calls host._gated_run, which calls gate.wait() then run_task. Drive one due() with
    # the gate BUSY: we model "queue" as _gated_run calling gate.wait(); here gate.wait()
    # returns immediately (stub) so we assert the ORDER: gate consulted first, then ran.
    # (Real blocking is threading.Event.wait; the contract is the call ordering.)
    host._ensure_scheduler()
    # Force the entry due now, then fire once.
    host.sched.entries[0].next_fire = clock() - 1
    fired = host.sched.due()
    assert fired == ["job"], f"entry did not fire: {fired}"
    assert gate.wait_calls >= 1, "busy gate was never consulted before running the task"
    assert order == ["ran"], f"task did not run after gate: {order}"
    print("host-c OK: fired task consulted the idle gate (queue) before running; "
          f"gate.wait_calls={gate.wait_calls}")


def test_fingerprint_stable_and_sensitive():
    a = [{"name": "x", "task": "T", "daily_at": "03:30"}]
    b = [{"name": "x", "task": "T", "daily_at": "03:30"}]
    c = [{"name": "x", "task": "T2", "daily_at": "03:30"}]
    assert entries_fingerprint(a) == entries_fingerprint(b)
    assert entries_fingerprint(a) != entries_fingerprint(c)
    # order-normalised: a cosmetic reorder is not a change
    d = [{"name": "y", "task": "Y", "every_minutes": 1},
         {"name": "x", "task": "T", "daily_at": "03:30"}]
    e = [{"name": "x", "task": "T", "daily_at": "03:30"},
         {"name": "y", "task": "Y", "every_minutes": 1}]
    assert entries_fingerprint(d) == entries_fingerprint(e)
    print("host-d OK: fingerprint stable on equal, sensitive on change, order-normalised")


class StopStub:
    """A stop-Event stub for the PRODUCTION _sleep_to path (no injected sleep). .wait(s)
    advances the fake clock by s and returns False (a slice slept, nobody stopped). An
    optional on_wait callback fires each slice -- the test uses it to inject a near-term
    entry WHILE the host is asleep toward a far next_fire, the exact panel-add the
    documented "lands within a slice" promise must honor."""
    def __init__(self, clock, on_wait=None):
        self.clock = clock
        self.on_wait = on_wait

    def is_set(self):
        return False

    def wait(self, timeout=None):
        if self.on_wait is not None:
            self.on_wait()
        if timeout:
            self.clock.t += timeout
        return False


def test_near_entry_hot_reload_within_slice():
    """Regression lock for the production _sleep_to hot-reload bug (offline, deterministic).

    The host is asleep toward a FAR next_fire (far = a one-shot 300s out, many
    slices out). While it sleeps, a NEAR-term one-shot (near = now+30s, a few slices out)
    appears in load_entries -- a panel add mid-sleep.

    * Fixed _sleep_to returns to run()'s top EVERY slice, so _ensure_scheduler() reloads,
      sees near, recomputes next_fire to the nearer near, and fires near: fired == ["near"]
      and the clock never reaches the far target.
    * The OLD _sleep_to ran `while True` waking only to check stop_event, so it slept the
      whole way to far WITHOUT returning to run()'s loop -- near was never reloaded and
      never fired; fired == ["far"] (far, the one-shot, fires and dies). This is the exact shipped bug (the existing host-a/b/c
      tests all inject a sleep, so they bypass the production branch and missed it).
    """
    import datetime as _dt
    clock = FakeClock()
    fired = []
    near_iso = _dt.datetime.fromtimestamp(clock() + 30).isoformat(timespec="seconds")
    far_iso = _dt.datetime.fromtimestamp(clock() + 300).isoformat(timespec="seconds")
    state = {"entries": [{"name": "far", "task": "FAR", "at": far_iso}]}

    def load():
        return list(state["entries"])

    injected = {"done": False}

    def on_wait():
        # First slice slept (toward far) -> now the panel adds a NEAR-term one-shot.
        if not injected["done"]:
            injected["done"] = True
            state["entries"] = [
                {"name": "far", "task": "FAR", "at": far_iso},
                {"name": "near", "task": "NEAR", "at": near_iso},
            ]

    host = SchedulerHost(load_entries=load, run_task=lambda n, t: fired.append(n),
                         clock=clock, sleep=None, stop_event=StopStub(clock, on_wait),
                         slice_s=5.0)
    host.max_iter = 70   # enough slices for the clock to reach near (+30s)
    total = host.run()

    assert "near" in fired, (
        "near-term entry added mid-sleep never fired -- the production _sleep_to "
        f"hot-reload regression is back (fired={fired}, elapsed={clock() - 1_000_000.0:.0f}s)")
    assert fired and fired[0] == "near", (
        f"near-term add must fire before the far (+300s) next_fire, fired={fired}, "
        f"elapsed={clock() - 1_000_000.0:.0f}s")
    print(f"host-e OK: near-term panel add hot-reloaded within slices on a far next_fire "
          f"and superseded it (fired={fired}, total={total})")


def test_busy_queue_delays_last_run_until_idle():
    """host-f: agent busy 时到点不写 last_run、转空闲后才触发（锁排队策略的真实时序）。

    Scheduler.due() 的时序契约是 _safe_run(-> _gated_run -> idle_gate.wait -> run_task)
    返回**之后**才 _record_last_run 写盘。所以 agent BUSY（gate 关闭）期间，任务已经
    due 却卡在 gate.wait，last_run 必然**尚未写盘**；放行（转空闲）后 _record_last_run
    才落盘，且 last_run.ts 反映放行后的时钟（>= 转空闲时刻），而非 due 的触发时刻。

    host-c 的 stub gate 立即返回，只验调用顺序，锁不住这条「写盘晚于排队」的真实时序；
    host-f 用「wait 内读 state 断言此刻无 last_run + 推进时钟模拟排队耗时 + run 后断言
    last_run.ts>=转空闲时刻」把它锁进 gate。这是 live 实测（RECUR-FIRED-OK + state
    last_run 落盘）坐实的策略在离线层的等价锁。
    """
    import json
    import tempfile
    import datetime as _dt

    clock = FakeClock()
    tmpdir = tempfile.mkdtemp(prefix="q_hostf_")
    state_path = os.path.join(tmpdir, "state.json")
    ran = {"n": 0, "at": None}

    # A one-shot pinned to fire at t0+1 (due immediately once clock passes it).
    at_iso = _dt.datetime.fromtimestamp(clock() + 1).isoformat(timespec="seconds")

    def load():
        return [{"name": "q", "task": "Q", "at": at_iso}]

    busy_obs = {"last_run_seen_during_wait": "UNSET"}
    idle_at = clock() + 60.0  # agent stays busy for 60s, then frees up

    class QueueGate:
        """Real queueing gate: wait() blocks (advances the fake clock) until the agent
        turns idle, and captures whether last_run was on disk while it was still busy."""

        def __init__(self):
            self.open_ = False
            self.wait_calls = 0

        def is_set(self):
            return self.open_

        def set(self):
            self.open_ = True

        def wait(self, timeout=None):
            self.wait_calls += 1
            # Snapshot persisted state AT THE MOMENT we are queued (gate closed, clock
            # not yet advanced). Because _record_last_run runs only after _safe_run
            # returns -- which is after THIS wait -- the entry must NOT be in last_run.
            try:
                with open(state_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except FileNotFoundError:
                data = {}
            busy_obs["last_run_seen_during_wait"] = "q" in data.get("last_run", {})
            # Queue: the agent finishes its interactive turn 60s from now, then frees up.
            clock.t = idle_at
            self.open_ = True
            return True

    gate = QueueGate()

    def run_task(name, task):
        ran["n"] += 1
        ran["at"] = clock()

    host = SchedulerHost(load_entries=load, run_task=run_task, state_path=state_path,
                         clock=clock, sleep=clock.sleep, idle_gate=gate)
    host._ensure_scheduler()
    # Force due at t0 (next_fire at t0+1, nudge clock to t0+1 so it is due now).
    clock.t += 1
    fired = host.sched.due()

    # (1) it fired exactly once
    assert fired == ["q"], f"entry did not fire: {fired}"
    # (2) the gate was consulted (queued) before the task ran
    assert gate.wait_calls >= 1, "idle gate never consulted (no queue arbitration)"
    # (3) THE LOCK: while queued (agent busy), last_run for 'q' was NOT yet on disk
    assert busy_obs["last_run_seen_during_wait"] is False, (
        "last_run was written while the agent was still busy (queued) -- the write "
        "must be deferred until the gate releases, matching the live behaviour where "
        "a fired-but-queued job leaves last_run=None until the agent goes idle")
    # (4) after release, the task ran and last_run landed, timestamped at/after idle
    assert ran["n"] == 1, f"task did not run after the gate released: {ran}"
    assert ran["at"] >= idle_at, (
        f"task ran at {ran['at']} before the agent went idle at {idle_at}")
    with open(state_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    assert "q" in data.get("last_run", {}),         f"last_run not persisted after idle: {data.get('last_run')}"
    assert data["last_run"]["q"]["ts"] >= idle_at, (
        f"last_run.ts={data['last_run']['q']['ts']} predates idle "
        f"({idle_at}) -- queued run's last_run must carry the post-idle timestamp")
    print(f"host-f OK: fired-while-busy deferred last_run until idle "
          f"(last_run during busy={busy_obs['last_run_seen_during_wait']}, "
          f"ran_at={ran['at']:.1f}>=idle={idle_at:.1f}, ts={data['last_run']['q']['ts']:.1f})")


def main() -> int:
    test_fire_via_callback()
    test_hot_reload_picks_up_new_entry()
    test_busy_queue_blocks_behind_gate()
    test_fingerprint_stable_and_sensitive()
    test_near_entry_hot_reload_within_slice()
    test_busy_queue_delays_last_run_until_idle()
    print("SCHEDULER HOST FUSION GATE OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
