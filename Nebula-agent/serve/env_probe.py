"""Runtime-environment probes: is a directory writable, and is this a Linux desktop session.

Split out of serve/server.py (refactor plan-B block 10, 2026-11-17): two independent pure
probes that share one concept -- reading the ambient environment rather than any engine/
session state. _dir_writable() tests writability via tempfile (stdlib), linux_desktop()
reads os.environ / os.name / sys.platform for a Wayland/X display. AST proved neither touches
engine/session globals, nor lazy-imports a first-party module, nor calls any sibling that does
(unlike hip_visible/engine_frozen, which stay behind: hip_visible depends on the impure
ordered_gpus, engine_frozen reads the STALL_* start-up constants and is a start-up stall probe,
not an env probe). server.py re-imports the names unchanged, so every call site (the temp-dir
sanitizer at hip_env_guard, and the desktop-VRAM note caller) stays untouched.

This is an equivalence move, not a rewrite: the function bodies are byte-for-byte the originals
-- they are extracted from server.py here rather than re-typed.
"""
import os
import sys
import tempfile


def _dir_writable(p: str) -> bool:
    try:
        with tempfile.TemporaryFile(dir=p):
            return True
    except OSError:
        return False


def linux_desktop(env=None) -> bool:
    """A graphical session on Linux (Wayland or X): its compositor, browser and apps take VRAM after the model has."""
    env = os.environ if env is None else env
    return os.name != "nt" and sys.platform != "darwin" and bool(env.get("WAYLAND_DISPLAY") or env.get("DISPLAY"))
