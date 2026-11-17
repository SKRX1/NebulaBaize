"""The frozen-engine watchdog predicate and its two thresholds.

Split out of serve/server.py (refactor plan-B block 11, 2026-11-17): #1317's quick
watchdog predicate engine_frozen() plus the only two values it reads, the tolerance
literals STALL_CPU_EPS_S / STALL_IO_EPS_B.  Moving the two constants with the predicate
is what makes it a TRUE net leaf -- it then closes only over its own module-level
literals, no engine/session state, no os.environ, no sibling (unlike ENGINE_STALL_S,
which stays behind because it is impure: it calls _timeout_env to read the environment,
and engine_frozen never reads it anyway).  server.py re-imports all three names
unchanged, so the single call site (the watchdog at L2053, engine_frozen(state["base"],
now)) stays untouched.

This is an equivalence move, not a rewrite: the constant lines and the function body are
byte-for-byte the originals -- they are extracted from server.py here rather than re-typed.
"""


STALL_CPU_EPS_S = 0.5       # CPU seconds the engine may use in the whole stall window and still count as frozen
STALL_IO_EPS_B = 1 << 20    # bytes read or written in that window


def engine_frozen(base: tuple[float, int], now: tuple[float, int]) -> bool:
    """#1317: True when two (cpu seconds, io bytes) samples of the engine show no work between them."""
    return (now[0] - base[0]) <= STALL_CPU_EPS_S and (now[1] - base[1]) <= STALL_IO_EPS_B
