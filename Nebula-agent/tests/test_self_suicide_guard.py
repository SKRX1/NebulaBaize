# -*- coding: utf-8 -*-
# Differential gate for the shell_server self-suicide guard (ASCII output).
# We import the REAL module and drive its guard predicates so the assertions lock
# the SHIPPED code, not a copy. The stubbed-CIM half keeps the LOGIC deterministic;
# the LIVE half (bottom) drives the REAL CIM walk against a real process tree.
import os, sys, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))        # Nebula-agent/tests
ROOT = os.path.dirname(HERE)                             # Nebula-agent
sys.path.insert(0, os.path.join(ROOT, "servers"))

spec = importlib.util.spec_from_file_location("shell_server",
                                              os.path.join(ROOT, "servers", "shell_server.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

fails = 0
def check(name, got, want):
    global fails
    ok = got == want
    if not ok:
        fails += 1
    print("%s %s (got=%r want=%r)" % ("PASS" if ok else "FAIL", name, got, want))

# --- parsing: which PID(s) a kill command names ---
check("parse-taskkill", sorted(mod._kill_target_pids("taskkill /F /T /PID 1234")), [1234])
check("parse-stopprocess", sorted(mod._kill_target_pids("Stop-Process -Id 999 -Force")), [999])
check("parse-plain-kill", sorted(mod._kill_target_pids("kill 77")), [77])
check("parse-echo-none", sorted(mod._kill_target_pids("echo hello world")), [])
check("parse-dir-no-cost", mod._kill_target_pids("dir /s /b foo") == set(), True)

# --- guard behaviour with an INJECTED ancestry set (deterministic, no live tree) ---
orig_anc = mod._my_ancestry
def fake(pids):
    mod._my_ancestry = lambda: set(pids)

# POSITIVE: kill names a PID that IS in our ancestry -> refusal note (non-None).
fake([100, 200, 1234, 5000])
check("POS-taskkill-ancestor-refused", mod._self_suicide_guard("taskkill /F /PID 1234") is not None, True)
check("POS-stopproc-ancestor-refused", mod._self_suicide_guard("Stop-Process -Id 200 -Force") is not None, True)

# NEGATIVE: kill an unrelated PID (not in ancestry) -> allowed (None).
check("NEG-kill-unrelated-allowed", mod._self_suicide_guard("taskkill /F /PID 4321"), None)

# NEGATIVE: kill a pid NOT in ancestry via stop-process -> allowed (None).
check("NEG-stopproc-unrelated-allowed", mod._self_suicide_guard("Stop-Process -Id 8888 -Force"), None)

# NEGATIVE: ordinary command -> guard is never even reached upstream (no PID parsed) -> None.
check("NEG-normal-cmd-allowed", mod._self_suicide_guard("echo done"), None)

mod._my_ancestry = orig_anc

# --- the shipped call_tool must actually CALL the guard, BEFORE the Popen exec ---
src = open(os.path.join(ROOT, "servers", "shell_server.py"), encoding="utf-8").read()
check("call_tool-calls-guard", "_guard = _self_suicide_guard(cmd)" in src, True)
check("guard-return-wired", "if _guard:" in src and "return _guard" in src, True)
i_guard = src.find("_guard = _self_suicide_guard(cmd)")
i_popen = src.find("proc = subprocess.Popen(cmd")
check("guard-runs-before-exec", 0 < i_guard < i_popen, True)

# --- LIVE end-to-end probe: drive the REAL CIM walk (NO stub) against this machine's
# real process tree, proving the guard fires on a genuine ancestor, not just injected
# data. Gated to Windows with a resolvable chain so it self-skips where CIM is
# unavailable (keeps the gate deterministic on non-Windows). We only BUILD a command
# string here -- the guard returns a refusal note and never executes the kill. ---
live_ok = (sys.platform == "win32")
real_anc = mod._my_ancestry()
if not live_ok or not real_anc:
    print("SKIP live-e2e (win32=%s, resolved_ancestry_size=%d)" % (live_ok, len(real_anc)))
else:
    me = os.getpid()
    others = sorted(p for p in real_anc if p != me)     # a REAL ancestor that is not us
    anc_pid = others[0]
    check("LIVE-POS-kill-real-ancestor-refused",
          mod._self_suicide_guard("taskkill /F /PID %d" % anc_pid) is not None, True)
    check("LIVE-NEG-kill-not-in-chain-allowed",
          mod._self_suicide_guard("taskkill /F /PID 99999"), None)

print("SELF-SUICIDE-GUARD: " + ("ALL GREEN" if fails == 0 else ("FAILURES=%d" % fails)))
sys.exit(1 if fails else 0)
