r"""Parallel-probe gate (2026-10-30, plan A tiered probe) — locks the landing.

Plan A contract it freezes (the decision this task made):
  tests            -> floor(cores * 0.6), capped at 16
  recycle workers  -> floor(cores * 0.4), capped at 8
  recycle batch    -> fixed 8
  explicit env override (STRATA_TESTS_WORKERS / STRATA_RECYCLE_WORKERS /
  STRATA_RECYCLE_BATCH) is ALWAYS highest.

THREE facts, all deterministic and ASCII-only output (red = non-zero exit):
  1. REPRODUCE — on THIS machine (12 logical cores, no psutil) the probe yields
     tests=7, recycle_workers=4, recycle_batch=8. Recycle reproduces the value the
     system ran with for weeks (floor(12*0.4)=4), proving "adaptive" changed nothing
     already tuned; tests 4->7 is the intended plan-A change (strong boxes were capped).
  2. DIFFERENTIAL — feed different core counts and the numbers must MOVE and respect
     the caps (10 cores -> tests 6, recycle 4; 40 cores -> tests 16, recycle 8). If a
     factor stopped mattering the probe is a hardcoded constant wearing a formula.
  3. ENV OVERRIDE WINS — set STRATA_TESTS_WORKERS=3 and the tests number becomes 3,
     beating whatever the factor formula would give. Override is the top of precedence.

The reproduce + override facts run in a CHILD process with the relevant env stripped,
so a stray STRATA_* in the caller's shell cannot poison the default-value assertions.
Pure stdlib (psutil stays OPTIONAL on the import path, exactly as the probe documents).

Run from the strata-agent folder:
    python tests\test_parallel_probe.py
"""
from __future__ import annotations

import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # strata-agent/

# env that must be ABSENT for a default-value (factor) assertion to be trustworthy
PROBE_ENV = ["STRATA_TESTS_WORKERS", "STRATA_RECYCLE_WORKERS", "STRATA_RECYCLE_BATCH"]

# Clean-env probe: strips the override env so factor-path results are real, not inherited.
CHILD = (
    "import sys, os;"
    "sys.path.insert(0, os.path.join(r'{root}', 'runtime'));"
    "import parallel_probe as p;"
    "print(p.compute('{load}'))"
)
# Differential: compute a named load at an explicit core count (factor path, no env).
CHILD_DIFF = (
    "import sys, os;"
    "sys.path.insert(0, os.path.join(r'{root}', 'runtime'));"
    "import parallel_probe as p;"
    "print(p.compute('{load}', {cores}))"
)
# Env-override: keep ONE override env, strip the others, assert it beats the formula.
CHILD_ENV = (
    "import sys, os;"
    "sys.path.insert(0, os.path.join(r'{root}', 'runtime'));"
    "import parallel_probe as p;"
    "print(p.compute('{load}'))"
)


def _run(tmpl, env_overrides=None, **kw):
    env = dict(os.environ)
    for k in PROBE_ENV:
        env.pop(k, None)                      # strip all overrides for a clean default
    if env_overrides:
        env.update(env_overrides)
    out = subprocess.run([sys.executable, "-c", tmpl.format(root=ROOT, **kw)],
                         capture_output=True, text=True, env=env, cwd=ROOT)
    return out.stdout.strip()


def main() -> int:
    problems: list[str] = []

    def expect(label, got, want):
        if got != want:
            problems.append("%s: got %r want %r" % (label, got, want))

    # 1) REPRODUCE on this machine (12 cores, no psutil) — clean env so the factor path runs.
    expect("reproduce.tests", _run(CHILD, load="tests"), "7")
    expect("reproduce.recycle_workers", _run(CHILD, load="recycle_workers"), "4")
    expect("reproduce.recycle_batch", _run(CHILD, load="recycle_batch"), "8")

    # 2) DIFFERENTIAL — the factors must actually change the numbers, and caps must bind.
    expect("diff.tests@10", _run(CHILD_DIFF, load="tests", cores=10), "6")   # floor(10*0.6)
    expect("diff.recycle@10", _run(CHILD_DIFF, load="recycle_workers", cores=10), "4")
    expect("diff.tests@40(cap16)", _run(CHILD_DIFF, load="tests", cores=40), "16")  # floor(24)->cap
    expect("diff.recycle@40(cap8)", _run(CHILD_DIFF, load="recycle_workers", cores=40), "8")  # floor(16)->cap
    # a factor that never mattered would make these equal — differential catches the constant.
    if _run(CHILD_DIFF, load="tests", cores=10) == _run(CHILD_DIFF, load="tests", cores=20):
        problems.append("diff.tests: numbers did not MOVE with core count (factor is inert)")

    # 3) ENV OVERRIDE WINS — override beats the factor formula.
    expect("env.tests=3", _run(CHILD_ENV, env_overrides={"STRATA_TESTS_WORKERS": "3"}, load="tests"), "3")
    expect("env.batch=99", _run(CHILD_ENV, env_overrides={"STRATA_RECYCLE_BATCH": "99"}, load="recycle_batch"), "99")

    print("parallel-probe gate: reproduce + differential + env-override")
    for p in problems:
        print("  " + p)
    if problems:
        print("PARALLEL-PROBE-GATE: RED (%d problem(s))" % len(problems))
        return 1
    print("PARALLEL-PROBE-GATE: ALL GREEN (reproduces this machine + differential + env override)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
