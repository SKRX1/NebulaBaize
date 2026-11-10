r"""Scheduler-host DIFFERENTIAL gate (permanent, 2026-11-09): prove the host-a..h regression
locks are LOAD-BEARING, not a vacuous green.

The sibling tests/test_scheduler_host.py asserts eight behaviours of runtime/scheduler_host.py
(hot reload add = host-b, hot reload delete = host-g, busy-queue defers last_run = host-f,
failing-task ok=false + isolation = host-h, ...). A green suite alone does not prove each
assertion would FAIL when its contract breaks -- a lock that never goes red is decorative.

This gate copies the runtime modules + the host test into a throwaway temp tree, mutates
ONE production branch into its KNOWN-BAD form, and re-runs the REAL host test (from temp, so
its `sys.path.insert(ROOT/runtime)` imports the mutated copy -- the predicate is the genuine
test body, zero drift, the same trick _orphan_chain_gate.py uses on a throwaway git repo).
The host test MUST go RED on each mutation. If a mutation left it green, that lock is
decorative -> this gate goes RED.

Mutations (one per lock, each the exact shipped/historical bug it guards):
  D-e  scheduler_host._sleep_to  -> the OLD `while True` wake-only-on-stop loop: a near-term
       panel add landing while asleep toward a far next_fire is never reloaded -> host-e red.
  D-f  scheduler._record_last_run hoisted ABOVE _safe_run: last_run is written while the
       agent is still busy (queued) -> host-f red.
  D-g  scheduler_host._ensure_scheduler returns even when the fingerprint changed (never
       rebuilds): a removed entry keeps firing -> host-g red.
  D-h  scheduler._safe_run stops catching the exception: a failing task kills the due() loop
       -> host-h red.

PROBE 0: the live tree (unmutated) must stay GREEN -- a mutation harness that breaks the
         baseline is broken itself.
Read-only on the real repo; the temp tree is built under tempfile.mkdtemp and removed.
Run from the strata-agent folder:
    python tests/test_scheduler_host_differential.py
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # strata-agent/
PY = sys.executable

# (key, relative module file, exact old substring -> new substring, host fn that must go red)
MUTATIONS = [
    (
        "D-e",
        os.path.join("runtime", "scheduler_host.py"),
        "        step = min(self.slice_s, remain)\n"
        "        if self.stop_event is not None:\n"
        "            self.stop_event.wait(step)\n"
        "        else:\n"
        "            time.sleep(step)\n"
        "        return\n",
        # OLD shipped bug: wake only to check stop, sleep the whole way to the far target,
        # never return to run()'s reload loop.
        "        while self._clock() < target_ts and not self._stopped():\n"
        "            step = min(self.slice_s, target_ts - self._clock())\n"
        "            if self.stop_event is not None:\n"
        "                self.stop_event.wait(step)\n"
        "            else:\n"
        "                time.sleep(step)\n"
        "        return\n",
        "test_near_entry_hot_reload_within_slice",
    ),
    (
        "D-f",
        os.path.join("runtime", "scheduler.py"),
        "                ok = self._safe_run(e)\n"
        "                fired.append(e.name)\n"
        "                self._record_last_run(e.name, ok)\n",
        # Hoist the write above the run/queue -> last_run lands while the agent is busy.
        "                self._record_last_run(e.name, True)  # MUTATION: write before run\n"
        "                ok = self._safe_run(e)\n"
        "                fired.append(e.name)\n",
        "test_busy_queue_delays_last_run_until_idle",
    ),
    (
        "D-g",
        os.path.join("runtime", "scheduler_host.py"),
        "        self.sched = Scheduler(build_entries(entries_cfg), self._gated_run,\n"
        "                               clock=self._clock, sleep=None,\n"
        "                               state_path=self.state_path, on_event=self.on_event)\n"
        "        changed = self._fp is not None\n",
        # Rebuild happens (new adds land) but removed entries are merged back -> only
        # the DELETION lock (host-g) breaks; host-b (the ADD lock) stays green.
        "        _prev = self._fp\n"
        "        self.sched = Scheduler(build_entries(entries_cfg), self._gated_run,\n"
        "                               clock=self._clock, sleep=None,\n"
        "                               state_path=self.state_path, on_event=self.on_event)\n"
        "        if _prev is not None:  # MUTATION: re-add removed entries, keep adds\n"
        "            _cn = {r[0] for r in fp}\n"
        "            for r in _prev:\n"
        "                if r[0] not in _cn:\n"
        "                    self.sched.entries.append(\n"
        "                        build_entries([{\"name\": r[0], \"task\": r[1]}])[0])\n"
        "        changed = self._fp is not None\n",
        "test_removed_entry_stops_firing_after_reload",
    ),
    (
        "D-h",
        os.path.join("runtime", "scheduler.py"),
        "        try:\n"
        "            self.run_task(entry.name, entry.task)\n"
        "            return True\n"
        "        except Exception as e:\n"
        "            self.on_event({\"type\": \"schedule-error\", \"name\": entry.name, \"error\": str(e)})\n"
        "            return False\n",
        # Stop catching: a failing task's exception bubbles out of due() and kills the loop.
        "        self.run_task(entry.name, entry.task)  # MUTATION: no isolation\n"
        "        return True\n",
        "test_run_task_exception_records_ok_false_and_survives",
    ),
    (
        "D-i",
        os.path.join("runtime", "scheduler_host.py"),
        "    if not base:\n",
        "    if True:  # MUTATION: ignore the entry base_url -> always boot client\n",
        "test_schedule_route_follows_selected_model",
    ),
]


def _read(rel):
    with open(os.path.join(ROOT, rel), "r", encoding="utf-8") as f:
        return f.read()


def _run_host_test(cwd):
    """Run tests/test_scheduler_host.py from cwd; return (returncode, combined output)."""
    p = subprocess.run([PY, os.path.join("tests", "test_scheduler_host.py")],
                       cwd=cwd, capture_output=True, text=True)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def main() -> int:
    problems = []

    # ---- PROBE 0: the live (unmutated) tree must stay GREEN ----
    rc0, out0 = _run_host_test(ROOT)
    if rc0 != 0:
        problems.append("BASELINE the live host test is RED before any mutation: " + out0[-400:])
    print("PROBE0 live-tree        %s" % ("RED" if rc0 != 0 else "green"))

    # ---- DIFFERENTIAL: each mutation must turn the REAL host test RED ----
    for key, rel, old, new, host_fn in MUTATIONS:
        tmp = tempfile.mkdtemp(prefix="sched_diff_")
        try:
            # copy runtime modules + the host test, then mutate ONE branch
            shutil.copytree(os.path.join(ROOT, "runtime"), os.path.join(tmp, "runtime"))
            os.makedirs(os.path.join(tmp, "tests"), exist_ok=True)
            shutil.copy(os.path.join(ROOT, "tests", "test_scheduler_host.py"),
                        os.path.join(tmp, "tests", "test_scheduler_host.py"))
            src = _read(rel)
            if src.count(old) != 1:
                problems.append("%s PATCH the mutation anchor matched %d times in %s "
                                "(gate is stale vs the code): "
                                % (key, src.count(old), rel))
                print("%-22s RED (patch anchor drift)" % (key))
                continue
            mutated = src.replace(old, new)
            with open(os.path.join(tmp, rel), "w", encoding="utf-8") as f:
                f.write(mutated)

            rc, out = _run_host_test(tmp)
            went_red = (rc != 0)
            # prove it went red ON THIS lock: the Python Traceback names the test
            # function frame that raised (File "...", line N, in <func>) -- not a
            # crash during import (no "in <func>" frame) and not some other lock.
            on_target = ("Traceback" in out) and (("in " + host_fn) in out)
            if not went_red:
                problems.append("%s DECORATIVE the mutation did NOT turn the host test red "
                                "-- %s is not a load-bearing lock: rc=%d"
                                % (key, host_fn, rc))
            elif not on_target:
                problems.append("%s OFF-TARGET the host test went red but not on %s "
                                "(crash/import?):\n%s" % (key, host_fn, out[-400:]))
            print("%-22s %s (rc=%d, red on %s=%s)"
                  % (key, "RED (expected)" if (went_red and on_target) else "PROBLEM",
                     rc, host_fn, on_target))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    # ---- verdict ----
    if problems:
        for p in problems:
            print("  " + p)
        print("SCHEDULER-HOST-DIFFERENTIAL: RED (%d problem(s))" % len(problems))
        return 1
    print("SCHEDULER-HOST-DIFFERENTIAL: ALL GREEN (live tree green; each of %d mutations "
          "turns its real host lock red -> host-e/f/g/h/i are load-bearing, not decorative)"
          % len(MUTATIONS))
    return 0


if __name__ == "__main__":
    sys.exit(main())
