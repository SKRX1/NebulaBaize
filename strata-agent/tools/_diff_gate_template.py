r"""DIFFERENTIAL-GATE TEMPLATE (reusable recipe, 2026-11-09) -- not a runnable test.

A differential gate proves that a regression test is LOAD-BEARING, not a vacuous green:
it copies the code-under-test + the real test into a throwaway temp tree, mutates ONE
production branch into its KNOWN-BAD form (the exact bug the lock guards), re-runs the
REAL test from the temp tree, and asserts it goes RED *on that lock*. If a mutation left
the test green, the lock is decorative -> the gate itself goes RED.

This is the same trick _orphan_chain_gate.py uses (predicate on a throwaway repo) and
what tests/test_scheduler_host_differential.py implements concretely for the scheduler
fusion. Read that file as the worked example.

WHY it is load-bearing (and how it avoids drift):
  * The predicate is the REAL test body, not a re-implemented copy -- the temp copy of the
    test imports the temp (mutated) module, so there is zero drift between "the lock" and
    "the predicate". Achieved by copying BOTH the module(s) and the test into temp and
    running the test with cwd=temp so its own `sys.path.insert(ROOT/runtime)` (now under
    temp) imports the MUTATED module.
  * PROBE 0 (baseline) runs the UNMUTATED test first and must stay GREEN -- a harness that
    breaks the baseline is itself broken, so this catches a bad copy/patch, not just a bad
    mutation.

HOW to instantiate for a new fusion layer (gateway/http, executor, ...):
  1. Identify, per existing lock, the production branch that, if broken, the lock must
     catch, and the EXACT bug that broke it historically. Mutations MUST be precise:
     mutate only THAT branch so ONLY its lock goes red. A mutation that also breaks an
     earlier-running lock will report the red on the WRONG lock (off-target) -- split the
     behaviour so each mutation isolates one lock.
  2. Fill MUTATIONS below: (key, module-file, exact old substring, new substring,
     test-function-name-that-must-go-red).
  3. Fill TEST / PREDICATE_ROOT: the test to run, and the root whose on-disk layout
     `sys.path` needs for its imports (mirror it under temp). The test must import its
     target via a path that resolves under temp (e.g. an absolute path derived from
     __file__, or a relative cwd that we set to temp).
  4. Keep output ASCII (the suite pipes through a code page; Chinese prints get swallowed).
  5. Register the INSTANTIATED gate (not this template) in tools/run_tests.py SUITES.

Invariants the instantiator must honour (the ones that bit us building the scheduler one):
  - Precise mutations (see 1 above).
  - The red must be attributed to the RIGHT lock. The reliable signal is the Python
    Traceback frame "File ... in <test_function>" -- use the test-function NAME as the
    key, not the OK-print string (the success print does NOT run on the failure path, so
    its text is absent from a red run's output).
  - Pure stdlib, deterministic, exit 0 = every mutation turned its lock red AND the live
    baseline stayed green.

USAGE (copy this file, fill the three placeholders, save as tests/<name>_differential.py,
register in run_tests.py). Below, the driver is wired to read the placeholders from a
MUTATIONS/TEST/PREDICATE_ROOT section that an instantiator pastes in; running this file
as-is reports the template is unfilled (it has no mutations yet) without crashing.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # strata-agent/
PY = sys.executable

# ---- placeholders an instantiator fills -------------------------------------------------
# (key, module-file-relative-to-root, exact-old-substring, new-substring, must-go-red-test)
MUTATIONS: list[tuple[str, str, str, str, str]] = []

# the test file (relative to root) that must go red under each mutation
TEST: str = ""

# relative paths (dirs or files) under ROOT that must be mirrored into the temp tree so the
# test's own imports resolve against the MUTATED copies (e.g. "runtime", "tests/test_x.py")
MIRROR: list[str] = []
# ----------------------------------------------------------------------------------------


def _read(rel):
    with open(os.path.join(ROOT, rel), "r", encoding="utf-8") as f:
        return f.read()


def _mirror_into(tmp):
    for rel in MIRROR:
        src = os.path.join(ROOT, rel)
        dst = os.path.join(tmp, rel)
        if os.path.isdir(src):
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy(src, dst)


def _run_test(cwd):
    p = subprocess.run([PY, os.path.relpath(os.path.join(tmp_test()), cwd)]
                       if False else [PY, TEST],
                       cwd=cwd, capture_output=True, text=True)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def tmp_test():  # kept for clarity; the test is referenced by TEST relative to cwd
    return TEST


def main() -> int:
    if not MUTATIONS or not TEST or not MIRROR:
        print("DIFF-GATE-TEMPLATE: template unfilled -- copy it, fill MUTATIONS/TEST/MIRROR "
              "(see the worked example tests/test_scheduler_host_differential.py), then "
              "register the COPY in run_tests.py. The template itself is not a CI gate.")
        return 0

    problems = []
    # PROBE 0: the live (unmutated) tree must stay green.
    rc0, out0 = _run_test(ROOT)
    if rc0 != 0:
        problems.append("BASELINE the live test is RED before any mutation: " + out0[-400:])
    print("PROBE0 live-tree        %s" % ("RED" if rc0 != 0 else "green"))

    for key, rel, old, new, red_test in MUTATIONS:
        tmp = tempfile.mkdtemp(prefix="diff_gate_")
        try:
            _mirror_into(tmp)
            src = _read(rel)
            if src.count(old) != 1:
                problems.append("%s PATCH anchor matched %d times in %s (gate stale vs code):"
                                % (key, src.count(old), rel))
                print("%-22s RED (patch anchor drift)" % key)
                continue
            with open(os.path.join(tmp, rel), "w", encoding="utf-8") as f:
                f.write(src.replace(old, new))
            rc, out = _run_test(tmp)
            went_red = (rc != 0)
            on_target = ("Traceback" in out) and (("in " + red_test) in out)
            if not went_red:
                problems.append("%s DECORATIVE mutation did not turn the test red -- "
                                "lock is not load-bearing: rc=%d" % (key, rc))
            elif not on_target:
                problems.append("%s OFF-TARGET red but not on %s (impure mutation? crash?):\n%s"
                                % (key, red_test, out[-400:]))
            print("%-22s %s (rc=%d, red on %s=%s)"
                  % (key, "RED (expected)" if (went_red and on_target) else "PROBLEM",
                     rc, red_test, on_target))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    if problems:
        for p in problems:
            print("  " + p)
        print("DIFF-GATE-TEMPLATE: RED (%d problem(s))" % len(problems))
        return 1
    print("DIFF-GATE-TEMPLATE: ALL GREEN (%d mutations each turn their lock red; baseline "
          "green -> locks are load-bearing)" % len(MUTATIONS))
    return 0


if __name__ == "__main__":
    sys.exit(main())
