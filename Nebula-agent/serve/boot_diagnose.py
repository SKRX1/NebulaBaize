# -*- coding: utf-8 -*-
"""Human-readable start-up failure diagnostics (the explain-why-it-failed-to-come-up layer).

Split out of serve/server.py (refactor plan-B block 7, 2026-11-17): three functions that
share ONE responsibility -- when the server or the engine cannot come up, turn the low-level
signal (an OS errno, a non-READY line, the engine log's tail) into a sentence a user can act
on, with the fix command in it.  They do not call each other, but are the same job seen from
its three entry points:  bind/listen (listen_problem: port in use / Windows-reserved / no such
address), the image encoder (vision_start_error: a second CUDA context refused on an Exclusive_
Process card), and the engine before READY (start_log_tail: pull the engine's own last lines
into the error).  AST analysis proved they close over only builtins -- listen_problem's errno is
imported inside the function, the others use only open/getattr -- so this module needs no
top-level imports and no engine / session state.  server.py re-imports the names unchanged, so
all three call sites stay untouched.

Chosen by real cohesion (responsibility, not subsystem): engine_crashed (returns a bool, not a
message), popen (wraps Popen and raises, a side-effecting wrapper), and the arg/env helpers
(_timeout_env / unload_wait / network_path) are DIFFERENT responsibilities and were left in
server.py on purpose -- this module is message generation only.

This is an equivalence move, not a rewrite: the function bodies are byte-for-byte the
originals -- extracted from server.py here rather than re-typed, so the embedded escaped-quote
diagnosis strings survive exactly.
"""


def listen_problem(host: str, port: int, e: OSError) -> str:
    """#769: why the server cannot listen.  Only an address that is taken says "already in use"; anything else (a port
    Windows keeps reserved, an address this PC does not have, no permission) says what the OS said."""
    import errno
    code = getattr(e, "winerror", None) or e.errno
    if code in (errno.EADDRINUSE, 10048):
        return (f"port {port} is already in use - is Strata (or another server) already running? "
                f"Close it, or start this one with a different --port")
    what = e.strerror or str(e)
    if code in (10013, errno.EACCES):
        hint = ("Windows may keep this port for itself (see `netsh int ipv4 show excludedportrange protocol=tcp`) "
                "or a firewall rule forbids it: start this one with a different --port")
    elif code in (10049, errno.EADDRNOTAVAIL):
        hint = f"{host} is not an address of this PC: check \"host\" in the model's strata-<model>.json or --host"
    else:
        hint = "check --host and --port"
    return f"cannot listen on {host}:{port}: {what} [{code}]. {hint}"

def start_log_tail(log: str | None, offset: int, n: int = 20) -> str:
    """#496: the last n lines this start wrote to the engine log, for the error when the engine ended before READY -
    whatever the failure, the engine's own reason is in them (people posted the traceback without the log).  "" when
    there is no log or nothing in it from this start."""
    if not log:
        return ""
    try:
        with open(log, "rb") as f:
            f.seek(0, 2)
            start = max(offset, f.tell() - 64 * 1024)   # enough for 20 lines, never an earlier start's
            f.seek(start)
            text = f.read().decode("utf-8", "replace")
    except (OSError, ValueError):
        return ""
    lines = text.splitlines()[1 if start > offset else 0:]   # not a line cut in half
    lines = [x.rstrip() for x in lines if x.strip()][-n:]
    if not lines:
        return ""
    return "\nthe engine log's last lines:\n" + "\n".join("  " + x for x in lines)

def vision_start_error(line: str, log=None) -> str:
    """The message when the image encoder answered something other than READY.  #1445: a card in the Exclusive_Process
    compute mode (or one another process holds) refuses the encoder's CUDA context with "busy or unavailable"; that
    cause is named instead of leaving the user the first line of a traceback.  `log` is the encoder's stderr file, whose
    tail is searched too (the CUDA error is printed there)."""
    text = line.strip()
    tail = ""
    try:
        name = getattr(log, "name", None)
        if name:
            with open(name, "rb") as f:
                f.seek(0, 2)
                f.seek(max(0, f.tell() - 16384))
                tail = f.read().decode("utf-8", "replace")
    except (OSError, ValueError):
        pass
    if "busy or unavailable" in (text + tail).lower():
        return ("the vision encoder did not start: the GPU refused a second CUDA context (\"CUDA-capable device(s) "
                "is/are busy or unavailable\"). This is usually the compute mode Exclusive_Process: only one process "
                "may use the card, and the engine already holds it. Check with: nvidia-smi --query-gpu=compute_mode "
                "--format=csv; set it back with: sudo nvidia-smi -c DEFAULT (or run the encoder on another card). "
                "First line from the encoder: " + (text or "(none)"))
    return "the vision encoder did not start: " + text
