"""Route decision: a LOCAL entry that names a base_url (a sibling instance on another port)
must run the gateway's OWN MCP tools when its "tools" box is ticked -- exactly like the empty-
base (self) case. This is the fix for the reported bug: choosing a local instance, typing its
service address, and ticking "tool calls" used to DISABLE tools, while leaving the address
empty enabled them. The old code assumed a sibling "runs its own tools" and sent the request
to a plain proxy, so the checked tools silently vanished.

What must hold (the predicate is pure, so it is unit-testable without starting the loop):
  - a local entry WITH a base_url and tools not turned off  -> route to our loop (True)
  - tools:false explicitly                                  -> plain proxy (False): the checkbox OFF is honoured
  - this machine has no tools (tools_here=False)            -> plain proxy (False)
  - a custom entry                                          -> handled by the custom branch, not this one (False)
  - no entry (a self with an empty base_url, or an unknown id) -> False; _route_model already returned
    None for an empty base_url, so the empty-base / self case never reaches this predicate and
    stays on the existing direct_mode path -- its behaviour is unchanged.

The load-bearing flip is tools:false -> False (the checkbox really turns tools off), and
absent/true -> True (typing an address + ticking tools now works, which it did not before).

Run standalone: python tests/test_local_sibling_loop.py
"""
from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "runtime"))

import http_server as gw  # noqa: E402  (the gateway module, for its pure route predicate)

FAIL = []


def check(label, cond, extra=""):
    print("  " + ("OK   " if cond else "FAIL ") + label + (("  " + str(extra)) if extra else ""))
    if not cond:
        FAIL.append(label)


SIBLING = {"id": "sib", "name": "Sib", "kind": "local", "base_url": "http://127.0.0.1:8080/v1", "model": "m"}


def main():
    print("=== the route predicate _wants_local_sibling_loop ===")
    w = gw._wants_local_sibling_loop

    # the fix itself: a local entry WITH a base_url, tools not turned off, this machine has tools
    check("local + base_url + tools flag absent -> run our tools (this was the bug)",
          w(dict(SIBLING), True) is True)
    check("local + base_url + tools:true -> run our tools",
          w({**SIBLING, "tools": True}, True) is True)

    # the checkbox OFF must turn it off: the user's choice is the whole decision
    check("tools:false -> do NOT run our tools (plain proxy; checkbox OFF honoured)  [load-bearing]",
          w({**SIBLING, "tools": False}, True) is False)

    # nothing to run here anyway
    check("no tools available on this machine -> plain proxy",
          w(dict(SIBLING), False) is False)

    # the other kinds are decided elsewhere
    check("a custom entry is NOT this branch's decision",
          w({"kind": "custom", "base_url": "https://api/x/v1", "model": "g"}, True) is False)

    # the self / empty-base case never reaches here (no entry) -> unchanged, plain proxy path below
    check("no entry (self empty base, or an unknown id) -> not this branch",
          w(None, True) is False)

    print("")
    if FAIL:
        print(f"LOCAL SIBLING LOOP ROUTE: {len(FAIL)} FAILED")
        for f in FAIL:
            print("  - " + f)
        sys.exit(1)
    print("LOCAL SIBLING LOOP ROUTE: ALL PASSED")


if __name__ == "__main__":
    main()
