# -*- coding: utf-8 -*-
# Register _autorules_gate.py into run_tests.py SUITES (byte-level, CRLF-safe).
import io, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RT = os.path.join(ROOT, "tools", "run_tests.py")
t = open(RT, "rb").read()
anchor = b'    "tools/_archive_gate.py",   # deterministic gate: archive write/read zero-loss + whitelist N=3 + default-on (locks the recoverable-archive design)\r\n'
if b'_autorules_gate.py' in t:
    print("SKIP already-registered"); sys.exit(0)
n = t.count(anchor)
if n != 1:
    print("ABORT anchor count=", n); sys.exit(2)
new = anchor + b'    "tools/_autorules_gate.py",  # locks default-ON per-store rules switch + routing + i18n parity (differential-proved)\r\n'
t = t.replace(anchor, new, 1)
open(RT, "wb").write(t)
print("OK registered _autorules_gate.py into SUITES")
