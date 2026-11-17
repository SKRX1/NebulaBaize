# -*- coding: utf-8 -*-
"""Resolve a configured / user-supplied input into the actual filesystem path to use
(the where-does-it-live layer).

Split out of serve/server.py (refactor plan-B block 8, 2026-11-17): three functions that
share ONE responsibility -- turn a config value or user argument into the real path this
process should read from or write to, and make sure that path is usable:
  - combined_embeddings_path (#874): where one request's combined image-embeddings file
    goes, choosing /dev/shm on Linux when it has room, else the encoder's own dir.
  - slot_save_dir: the user's slot save path normalized to ONE absolute directory
    (relative to base/None), created 0700 when missing, ValueError otherwise.
  - engine_binary: the file that actually holds the engine's option strings -- for the Intel
    sycl launcher, a wrapper script, it resolves to STRATA_SYCL_BIN rather than the script.
Chosen by responsibility (the paths they return are where a request/save/feature-check
will actually operate).  AST analysis proved they close over only the stdlib
(os / shutil / uuid / pathlib.Path) -- no engine / session state.  server.py re-imports the
names unchanged, so all four call sites stay untouched.

HONEST SCOPE NOTE: this is the loosest cluster of the plan-B series. The three share the
"resolve a configured input to a usable path" duty, but their side effects differ (one
probes /dev/shm, one makedirs+validates, one checks is_file) -- so if a future pass wants
a finer split, slot_save_dir is the one that most cleanly belongs with req_args'
parameter-validation duty instead.  Flagged so this judgement is reviewable, not silent.

This is an equivalence move, not a rewrite: the bodies are byte-for-byte the originals --
extracted from server.py here rather than re-typed, so issue refs and escaped strings survive
exactly.
"""
import os
import shutil
import uuid
from pathlib import Path


def combined_embeddings_path(vision_dir: Path, nbytes: int) -> Path:
    """#874: where one request's combined image-embeddings file goes.  Every request with images rewrites it (it is
    deleted after the request), which on a disk is steady heavy writing: on Linux it goes to /dev/shm when that has
    room (the engine reads it back at once), on Windows the file is opened short-lived (the cache is not forced out
    to the drive).  Anywhere else, or when /dev/shm is too small (Docker's default is 64 MB), it stays in the encoder's
    own directory, as before."""
    name = f"req-{uuid.uuid4().hex[:12]}.sve"
    shm = Path("/dev/shm")
    if os.name != "nt" and shm.is_dir() and os.access(shm, os.W_OK):
        try:
            if shutil.disk_usage(shm).free > 2 * nbytes + (16 << 20):
                return shm / f"strata-vision-{os.getpid()}-{name}"
        except OSError:
            pass
    return Path(vision_dir) / name

def engine_binary(exe: str, cfg: dict | None = None) -> str:
    """The file that holds the engine's own option strings, for a feature check that reads it.  The Intel launcher
    (sycl/serve/strata-sycl.sh) is a shell script that runs its repo's STRATA_SYCL_BIN (default build-sycl-aot/strata)
    in a container, so the check reads that binary, not the script.  Any other `exe` is the engine itself."""
    p = Path(exe)
    if p.name == "strata-sycl.sh":
        rel = ((cfg or {}).get("env") or {}).get("STRATA_SYCL_BIN") or os.environ.get("STRATA_SYCL_BIN") \
            or "build-sycl-aot/strata"
        b = p.resolve().parents[2] / rel
        if b.is_file():
            return str(b)
    return exe

def slot_save_dir(value, base: str | None = None) -> str:
    """The slot save path as one absolute, normalized directory (relative to `base`, else the server's working
    directory), created private to this user when missing.  ValueError for anything else."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("slot_save_path must be a directory path (a string)")
    if any(ord(c) < 32 for c in value):
        raise ValueError("slot_save_path must not contain control characters")
    path = os.path.abspath(os.path.join(base, value) if base and not os.path.isabs(value) else value)
    os.makedirs(path, mode=0o700, exist_ok=True)
    if not os.path.isdir(path):
        raise ValueError(f"slot_save_path {path} is not a directory")
    return path
