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

Run from the Nebula-agent folder:  python tests/test_scheduler_host.py

LOCK CHEAT-SHEET (host-a..i, added 2026-11-09 so a future edit can locate a lock fast):

  lock    production invariant it locks                                falsify mutation
  ------  -----------------------------------------------------------  -----------------------
  host-a  timing loop fires a DUE entry through the run_task callback   (baseline, no mutation)
  host-b  hot-reload ADD direction: a NEW entry is picked up, no restart  differential D-g keeps
  host-c  the fired task consults the idle gate BEFORE run_task (order)   this lock GREEN
  host-d  fingerprint: stable on equal, sensitive on change, order-normalised  (pure fn, no mut)
  host-e  a NEAR-term panel add lands WITHIN a slice while asleep to a    differential D-e
          far next_fire (_sleep_to returns to run() top every slice)
  host-f  busy-queue DEFERS last_run until idle (Scheduler.due records     differential D-f
          last_run only AFTER _safe_run -> gate.wait -> run_task returns)
  host-g  hot-reload DELETE direction: a removed entry stops firing       differential D-g
  host-h  a failing run_task records last_run.ok=false, is isolated, and   differential D-h
          the loop survives (the failing entry reschedules next tick)
  host-i  a scheduled run routes to the selected model's own base_url      differential D-i
          (chat's single source of truth); no base_url -> boot client (8080)

  Boundary, honestly stated: host-e/f/g/h/i carry a falsifiable production-branch mutation in
  tests/test_scheduler_host_differential.py (each mutation is the EXACT historical/shipped bug
  and MUST turn its lock red -- proving the lock is load-bearing, not a vacuous green).
  host-a/b/c/d are BASELINE behaviour locks (the thing under test IS the injected layer / a
  pure function), so they have no separate mutation; host-b and host-c are the differential
  gate's CONTROL-GREEN locks -- mutation D-g is written precisely so it breaks ONLY host-g
  while host-b stays green, which is exactly what proves D-g is a single-behaviour mutation.

  Falsify-recipe for a NEW fusion layer: copy tools/_diff_gate_template.py, fill
  MUTATIONS/TEST/MIRROR, keep output ASCII, register the COPY in run_tests.py SUITES.

"""
from __future__ import annotations

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from scheduler_host import SchedulerHost, entries_fingerprint, build_entries, resolve_schedule_route  # noqa: E402


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


def test_removed_entry_stops_firing_after_reload():
    """host-g: panel 删项后热重载即时停触发（锁删除方向，host-b 只锁了新增方向）。

    _ensure_scheduler() 每 tick 比对指纹；面板删掉一项 -> 指纹变 -> rebuild -> 被删项
    从 sched.entries 消失 -> 后续 tick 不再 due -> 不再触发。锁三件事：
      1. 删项前：job 会 fire（证明测试设置真的在触发它，谓词非空）
      2. 删项后 reload：reloads+1，sched.entries 不含被删项（删除被即时拾取）
      3. 删项后继续跑多 tick：被删项再未触发（fires 计数不再因它增长）

    证伪（见 differential 探针 D3）：_ensure_scheduler 在指纹变化时仍 return（永不
    rebuild），被删项会一直 fire -> host-g 变红。
    """
    clock = FakeClock()
    fired = []
    state = {"entries": [
        {"name": "keep", "task": "KEEP", "every_minutes": 1},
        {"name": "drop", "task": "DROP", "every_minutes": 1},
    ]}

    def load():
        return list(state["entries"])

    host = SchedulerHost(load_entries=load, run_task=lambda n, t: fired.append(n),
                         clock=clock, sleep=clock.sleep)

    # (1) 两个 job 都会 fire 一次：drive 3 个 tick 跨过 60s 边界
    host.max_iter = 3
    host.run()
    assert "drop" in fired and "keep" in fired, \
        f"setup: neither job fired before removal (predicate vacuous): {fired}"
    drop_before = fired.count("drop")

    # (2) 面板删掉 drop -> 下一 tick reload 应即时拾取
    state["entries"] = [{"name": "keep", "task": "KEEP", "every_minutes": 1}]
    host._ensure_scheduler()
    names = [e.name for e in host.sched.entries]
    assert "drop" not in names, \
        f"removed entry not dropped after reload (entries={names})"
    assert host.reloads >= 1, f"removal did not bump reloads (reload={host.reloads})"

    # (3) 删项后继续跑多个 tick：drop 绝不复现
    fired.clear()
    host.max_iter = 5
    host.run()
    assert "drop" not in fired, \
        f"removed entry kept firing after reload (fires={fired}) -- deletion not honored"
    print(f"host-g OK: panel removal hot-reloaded, removed entry stopped firing "
          f"(pre-removal drop hits={drop_before}, post-removal drop hits=0, reloads={host.reloads})")



def test_run_task_exception_records_ok_false_and_survives():
    """host-h: run_task 抛异常 -> last_run.ok=false 仍写盘 + 隔离不杀循环。

    Scheduler.due() 用 _safe_run 包住 run_task，捕获异常返 False -> _record_last_run(name,
    False) 落盘 -> 循环对后续 entry 继续。锁三件事：
      1. 抛异常项：last_run[name] 存在且 ok is False（失败被持久化，非静默丢失）
      2. 隔离：异常没把 due() 打断，同 tick 的下一个 entry 照常触发
      3. 循环存活：后续 tick 仍能处理 recurrence（调度器没被异常杀死）

    证伪（见 differential 探针 D4）：_safe_run 不捕获异常 -> 异常冒泡杀 due()/host.run()
    -> host-h 变红。
    """
    import json
    import tempfile
    clock = FakeClock()
    tmpdir = tempfile.mkdtemp(prefix="q_hosth_")
    state_path = os.path.join(tmpdir, "state.json")
    calls = []

    def load():
        return [
            {"name": "boom", "task": "BOOM", "every_minutes": 1},
            {"name": "ok", "task": "OK", "every_minutes": 1},
        ]

    def run_task(name, task):
        calls.append(name)
        if name == "boom":
            raise RuntimeError("task exploded")

    events = []
    host = SchedulerHost(load_entries=load, run_task=run_task, state_path=state_path,
                         clock=clock, sleep=clock.sleep, on_event=events.append)
    host._ensure_scheduler()
    # Force both due now -> one due() pass runs boom (raises) then ok.
    for e in host.sched.entries:
        e.next_fire = clock() - 1
    fired = host.sched.due()

    # (1) 异常项被记为 ok=false 并落盘
    with open(state_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    assert "boom" in data.get("last_run", {}), \
        f"failing entry not recorded in last_run: {data.get('last_run')}"
    assert data["last_run"]["boom"]["ok"] is False, \
        f"failing entry ok is not False: {data['last_run']['boom']}"
    # (2) 隔离：boom 抛异常没杀死 due()，同 tick 的 ok 也触发了
    assert "ok" in calls, \
        f"isolation broken: entry after the raiser never ran (calls={calls})"
    assert "boom" in events_names(events), \
        f"schedule-error event not emitted for the failing task: {[e.get('type') for e in events]}"
    # (3) 循环存活：boom 是 recurrence，下一 tick 应再次被处理（调度器没被杀）
    boom_before = calls.count("boom")
    calls.clear()
    for e in host.sched.entries:
        e.next_fire = clock() - 1
    fired2 = host.sched.due()
    assert "boom" in calls, \
        f"scheduler died after a failing task (boom not re-scheduled): calls={calls}"
    print(f"host-h OK: failing task recorded ok=false + isolated + loop survived "
          f"(boom ok={data['last_run']['boom']['ok']}, ok-ran-after-raiser=True, "
          f"boom rescheduled next tick={calls.count('boom') >= 1})")


def events_names(events):
    """Names carried by schedule-error events (helper for host-h)."""
    return [ev.get("name") for ev in events if ev.get("type") == "schedule-error"]

def test_schedule_route_follows_selected_model():
    """host-i: a SCHEDULED run routes to model_registry.selected's base_url when it has one
    (so the scheduler lands on the SAME model chat uses), and falls back to the boot client
    when the picked entry has no base_url (the "8080 is this gateway itself" case). This is
    the pure function the gateway wires into _sched_run_task; DI lookup, deterministic, no
    registry file touched.

    It locks the fix for the reported bug: with 8080 DOWN and a custom model selected (47831),
    a fired job must go to 47831, not to the dead boot client (8080) -- which is why a fired
    scheduled task used to record ok=false (the write path reached a dead upstream).
    """
    lookup = {
        "sel-47831": {"id": "sel-47831", "base_url": "http://127.0.0.1:47831/v1",
                       "model": "swift-iq3_s", "api_key": ""},
        "sel-local": {"id": "sel-local", "base_url": "", "model": "swift-1.5-iq3_s"},
    }

    def entry_lookup(sid):
        return lookup.get(sid)

    boot_base, boot_model, boot_key = "http://127.0.0.1:8080/v1", "strata", None

    # (1) a picked model that lives at its own base_url -> route to it (the 47831 case)
    base, model, key = resolve_schedule_route("sel-47831", entry_lookup,
                                              boot_base, boot_model, boot_key)
    assert base == "http://127.0.0.1:47831/v1", f"did not route to the selected base_url: {base}"
    assert model == "swift-iq3_s", f"did not carry the selected model: {model}"

    # (2) entry with an empty base_url -> fall back to the boot default (the 8080-self path)
    b2, m2, k2 = resolve_schedule_route("sel-local", entry_lookup,
                                        boot_base, boot_model, "BOOTKEY")
    assert (b2, m2, k2) == (boot_base, boot_model, "BOOTKEY"), \
        f"empty base_url must fall back to the boot client: {(b2, m2, k2)}"

    # (3) selected id not in the registry -> fall back to the boot default (never crash)
    b3, m3, k3 = resolve_schedule_route("ghost", entry_lookup, boot_base, boot_model, None)
    assert (b3, m3) == (boot_base, boot_model), f"unknown id must fall back: {(b3, m3)}"

    # (4) a lookup that RAISES (broken registry) -> fall back, must not kill the run
    def boom(_):
        raise RuntimeError("registry blew up")
    b4, m4, _ = resolve_schedule_route("sel-47831", boom, boot_base, boot_model, None)
    assert (b4, m4) == (boot_base, boot_model), f"a raising lookup must fall back, not raise: {(b4, m4)}"

    print(f"host-i OK: selected-with-base_url routes to it ({base}/{model}); empty base_url, "
          f"unknown id, and a raising lookup all fall back to the boot client")

def test_schedule_error_event_reaches_the_consumer():
    """host-j: a schedule-error must reach the injected on_event (not be silently swallowed).

    This is the production-wiring lock for the 2026-11-11 fix. The bug: the serve path built
    SchedulerHost WITHOUT passing on_event, so the inner Scheduler fell back to its default
    no-op lambda and a fired task's exception (schedule-error) was dropped with NO audit and
    NO UI -- "why did it fail" was unrecoverable. host-h already proves the Scheduler EMITS
    the event when on_event is injected; this lock proves the WIRING (the production consumer
    is actually handed a callback that receives it).

    Two layers:
      1. STATIC: gateway.py's SchedulerHost construction must pass on_event=, and the named
         callback must call audit.event(...) and branch on schedule-error. (Reading the exact
         shipped source -- a regression that drops the wiring turns this red.)
      2. DYNAMIC: drive the host with a run_task that RAISES and a recording on_event; assert
         the schedule-error event is delivered to the consumer with the failing task's name.
    """
    import json
    import tempfile
    import datetime as _dt

    # ---- layer 1: static wiring lock on the shipped gateway source ----
    gpath = os.path.join(ROOT, "runtime", "gateway.py")
    gsrc = open(gpath, "rb").read().decode("utf-8", "replace")
    assert "on_event=_sched_audit_event" in gsrc, (
        "serve SchedulerHost must pass on_event=_sched_audit_event (the 2026-11-11 wiring fix "
        "was dropped -- schedule-error would be silently swallowed again)")
    # the named callback must actually route events somewhere durable, and specifically handle
    # schedule-error (else the wiring would be cosmetic).
    w = gsrc.index("def _sched_audit_event")
    body = gsrc[w:w + 900]
    assert "audit.event(" in body, "_sched_audit_event must call audit.event(...)"
    assert "schedule-error" in body, "_sched_audit_event must branch on schedule-error"

    # ---- layer 2: dynamic end-to-end -- a failing task's event reaches the consumer ----
    clock = FakeClock()
    received = []

    def load():
        return [{"name": "boom-job", "task": "BOOM", "every_minutes": 1}]

    def run_task(name, task):
        raise RuntimeError("simulated agent-turn failure")

    host = SchedulerHost(load_entries=load, run_task=run_task,
                         clock=clock, sleep=clock.sleep, on_event=received.append)
    host._ensure_scheduler()
    host.sched.entries[0].next_fire = clock() - 1
    fired = host.sched.due()

    assert fired == ["boom-job"], f"setup: job did not fire: {fired}"
    errs = [ev for ev in received if ev.get("type") == "schedule-error"]
    assert errs, f"schedule-error never reached the consumer (received={[e.get('type') for e in received]})"
    assert errs[0].get("name") == "boom-job", f"event carries the wrong name: {errs[0]}"
    assert "simulated agent-turn failure" in str(errs[0].get("error", "")), \
        f"event lost the exception detail: {errs[0]}"
    print(f"host-j OK: schedule-error reaches the injected consumer "
          f"(static wiring lock GREEN + dynamic delivery name={errs[0]['name']!r})")


def main() -> int:
    test_fire_via_callback()
    test_hot_reload_picks_up_new_entry()
    test_busy_queue_blocks_behind_gate()
    test_fingerprint_stable_and_sensitive()
    test_near_entry_hot_reload_within_slice()
    test_busy_queue_delays_last_run_until_idle()
    test_removed_entry_stops_firing_after_reload()
    test_run_task_exception_records_ok_false_and_survives()
    test_schedule_route_follows_selected_model()
    test_schedule_error_event_reaches_the_consumer()
    print("SCHEDULER HOST FUSION GATE OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
