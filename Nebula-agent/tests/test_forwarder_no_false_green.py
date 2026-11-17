# -*- coding: utf-8 -*-
"""Gate: the workspace-root tools/run_all_tests.py forwarder must NEVER false-green.

Locks (2026-11-15):
  A locate-fail -> non-zero exit + honest stderr (the old ROOT=E:\\WorkBuddy bug
    printed "TOTAL 0" and exited 0: a vacuous green).
  B locate-ok   -> delegates to the real suite AND propagates its exit code
    (sandbox stub exits 7; the forwarder must exit 7, not 0 -- load-bearing
    single-variable differential vs A).
  C passthrough -> extra argv reach the delegate verbatim (contract: args are
    forwarded, e.g. --full).
Pure stdlib, deterministic, no network. The workspace-root forwarder is COPIED
into a temp sandbox so its __file__-relative resolution is exercised for real.
"""
import os
import shutil
import subprocess
import sys
import tempfile

WS = r"E:\Nebula\NebulaBaize"
FWD = os.path.join(WS, "tools", "run_all_tests.py")
PY = sys.executable
FAILS = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (" " + detail if detail else ""))
    if not cond:
        FAILS.append(name)


def run(path, args):
    r = subprocess.run([PY, path] + args, capture_output=True, text=True, timeout=60)
    return r.returncode, r.stdout or "", r.stderr or ""


def main():
    check("forwarder-exists", os.path.isfile(FWD))
    if FAILS:
        sys.exit(1)

    tmp = tempfile.mkdtemp(prefix="gate_fwd_")
    try:
        # sandbox: <tmp>/tools/run_all_tests.py + <tmp>/Nebula-agent/tools/ stub
        st = os.path.join(tmp, "Nebula-agent", "tools")
        os.makedirs(os.path.join(tmp, "tools"))
        os.makedirs(st)
        fwd = os.path.join(tmp, "tools", "run_all_tests.py")
        shutil.copyfile(FWD, fwd)

        # A) locate-fail: no delegate yet -> must be RED (exit 2), never 0.
        rc, out, err = run(fwd, [])
        check("A-locate-fail-red", rc != 0, "rc=%d" % rc)
        check("A-honest-stderr", "cannot locate" in (err + out).lower())

        # B) locate-ok: stub delegate exits 7 (distinctive) -> forwarder must echo 7.
        stub = os.path.join(st, "run_tests.py")
        with open(stub, "w", encoding="utf-8") as f:
            f.write("import sys\n"
                    "print('STUB-ARGS:' + ' '.join(sys.argv[1:]))\n"
                    "sys.exit(7)\n")
        rc, out, err = run(fwd, [])
        check("B-exit-code-propagated", rc == 7, "rc=%d" % rc)

        # C) passthrough args reach the delegate verbatim.
        rc, out, err = run(fwd, ["--full"])
        check("C-passthrough", "STUB-ARGS:--full" in out and rc == 7, "rc=%d" % rc)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("FORWARDER-GATE: " + ("ALL GREEN" if not FAILS else "RED " + str(FAILS)))
    sys.exit(0 if not FAILS else 1)


if __name__ == "__main__":
    main()
