# -*- coding: utf-8 -*-
"""RAM-budget start-up warnings (the memory-headroom advisory layer).

Split out of serve/server.py (refactor plan-B block 5, 2026-11-17): two warnings that
share one concept -- comparing the model experts' RAM footprint against what this PC
actually has, and telling the user before (not after) decoding turns "dead slow" or the
engine is OOM-killed.  AST analysis proved these close over only `os` + the optional
`psutil` (imported inside the function, so it stays genuinely optional and the module
still imports on a machine without it) -- no engine / session state.  server.py
re-imports the names unchanged, so all three call sites stay untouched.

Chosen by real cohesion: these two were deliberately NOT part of req_args (that module
is sampling-parameter validation; this one is memory advice).  They share a theme only
with each other, which is why they form their own module.

This is an equivalence move, not a rewrite: the function bodies are byte-for-byte the
originals, verified against server.py before committing.
"""
import os


def warn_tight_ram(arena_mib) -> None:
    """The model's experts live in RAM (INFO arena_mib, engine 0.1.10+).  With less than ~6 GB left beside them for the
    system, the engine and this server, Linux ends the engine mid-answer when memory runs out (issue #27) and Windows
    pages to disk; say so at start instead of after a lost answer."""
    if not isinstance(arena_mib, int) or arena_mib <= 0:
        return
    try:
        import psutil
        total = psutil.virtual_memory().total
    except Exception:  # noqa: BLE001 - psutil is optional here
        return
    left = total / 2**30 - arena_mib / 1024
    if left < 6:
        print(f"[strata] WARNING: RAM is tight - the model's experts take {arena_mib / 1024:.1f} GB of this PC's "
              f"{total / 2**30:.0f} GB, leaving {left:.1f} GB for everything else. "
              + ("Linux may stop the engine in the middle of an answer. " if os.name != "nt" else
                 "Windows will slow down (paging to disk). ")
              + "Close other programs, or run START-HERE --setup and pick a smaller size (Q2_0 / IQ2_XS).", flush=True)


def warn_budget_over_ram(args) -> str | None:
    """#1080: an explicit `--resident-budget-gib N` bigger than the RAM this PC has free (or than its total beside
    ~6 GB for everything else) pushes experts into swap or the file tier: decode that is "dead slow" until the number is
    removed.  A warning at start, never a refusal (recommend, never force).  -> the sentence printed, or None."""
    try:
        budget = float(args[list(args).index("--resident-budget-gib") + 1])
    except (ValueError, IndexError):
        return None
    try:
        import psutil
        vm = psutil.virtual_memory()
        total, free = vm.total / 2**30, vm.available / 2**30
    except Exception:  # noqa: BLE001 - psutil is optional here
        return None
    if budget <= free and budget <= total - 6:
        return None
    msg = (f"WARNING: the RAM budget for experts is {budget:g} GiB (--resident-budget-gib), but this PC has "
           f"{free:.0f} GiB free of {total:.0f} GiB: what does not fit goes to swap or is read from disk, which can make "
           "decoding very slow. Lower it (setup sizes it for this PC) or remove the argument to let the engine choose.")
    print("[strata] " + msg, flush=True)
    return msg
