"""Minimal green-gate regression for the recycle-job model added 2026-10-30.

Locks four contracts that the parallel-trash refactor added on top of the old
serial loop:
  A. synchronous path stays the default for small batches (<= _RECYCLE_TRASH_SYNC_MAX)
  B. large batch returns {job_id, total} immediately, the pool runs the trash and
     progress reports done == total and finished == True, ledger gets one line per file
  C. cancel mid-flight: already-dispatched sends still complete (they are irreversible
     in real life), the NOT-yet-started ones land in `cancelled` — so done+cancelled
     == total and cancelled > 0 (the semantic the frontend stop-button promises)
  D. unknown job_id -> 404 on both progress and cancel

The handler is constructed via __new__ (no socket / no __init__), and
_recycle_powershell is monkeypatched so the test never touches the real Windows
Recycle Bin. Pure stdlib, deterministic.
"""
import io
import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
import http_server as H   # noqa: E402


def make_handler():
    """GatewayHandler without running __init__ (which needs a socket)."""
    return H.GatewayHandler.__new__(H.GatewayHandler)


def batch_paths(script):
    """Paths embedded by _recycle_batch_script as '$paths @('a','b',...)'."""
    import re
    m = re.search(r"\$paths=@\((.*?)\);", script)
    return [p.strip().strip("'") for p in m.group(1).split(",")] if m else []


def ps_reply(self, script, delay=0.0):
    if delay:
        time.sleep(delay)
    paths = batch_paths(script)
    if paths:                          # batched path: one result line per path
        return "\n".join("OK:" + p for p in paths)
    return "OK"                        # single-file path (sync small batch)


def fake_ps_ok(self, script):
    return ps_reply(self, script)


def fake_ps_slow(self, script):
    return ps_reply(self, script, delay=0.2)    # each simulated COM send takes real time


def make_workspace_with_files(n):
    """Create a tmp workspace with n fake scratch files inside; return (ws, paths)."""
    ws = tempfile.mkdtemp(prefix="recycle_test_ws_")
    paths = []
    for i in range(n):
        p = Path(ws) / f"_scratch_{i}.bak"
        p.write_text("x", encoding="utf-8")
        paths.append(str(p))
    return ws, paths


def cleanup_ws(ws):
    import shutil
    shutil.rmtree(ws, ignore_errors=True)


def fresh_job_table():
    """_RECYCLE_JOBS is module-level; wipe it between tests so job ids don't collide."""
    with H._RECYCLE_JOBS_LOCK:
        H._RECYCLE_JOBS.clear()


def test_A_small_batch_stays_sync():
    fresh_job_table()
    H.GatewayHandler._recycle_powershell = fake_ps_ok
    h = make_handler()
    ws, paths = make_workspace_with_files(3)   # == SYNC_MAX
    try:
        code, obj = h._recycle_trash({"workspace": ws, "paths": paths})
        assert code == 200, obj
        assert "job_id" not in obj, f"small batch must stay sync: {obj}"
        assert sorted(obj["trashed"]) == sorted(paths), obj
        ledger = Path(ws) / ".strata-recycle" / "ledger.jsonl"
        assert ledger.is_file(), "ledger must exist after sync trash"
        lines = [ln for ln in io.open(ledger, encoding="utf-8").read().splitlines() if ln.strip()]
        assert len(lines) == 3, lines
        for ln in lines:
            rec = json.loads(ln)
            assert rec["action"] == "trash", rec
        print("A small-batch sync: code=200 trashed=%d ledger_lines=%d" % (len(obj["trashed"]), len(lines)))
    finally:
        cleanup_ws(ws)


def test_B_large_batch_is_a_job_and_completes():
    fresh_job_table()
    H.GatewayHandler._recycle_powershell = fake_ps_ok
    h = make_handler()
    ws, paths = make_workspace_with_files(12)  # > SYNC_MAX
    try:
        code, obj = h._recycle_trash({"workspace": ws, "paths": paths})
        assert code == 200, obj
        assert "job_id" in obj and obj["total"] == 12, obj
        # poll until finished (up to 5s)
        deadline = time.time() + 5
        while time.time() < deadline:
            code2, prog = h._recycle_progress({"job_id": obj["job_id"]})
            assert code2 == 200, prog
            if prog.get("finished"):
                break
            time.sleep(0.05)
        assert prog.get("finished") is True, prog
        assert prog["done"] == 12, prog
        assert prog["cancelled"] == 0 and prog["failed"] == 0, prog
        ledger = Path(ws) / ".strata-recycle" / "ledger.jsonl"
        lines = [ln for ln in io.open(ledger, encoding="utf-8").read().splitlines() if ln.strip()]
        assert len(lines) == 12, ("ledger must have 12 lines, got", len(lines))
        print("B large-batch job: finished done=%d ledger_lines=%d" % (prog["done"], len(lines)))
    finally:
        cleanup_ws(ws)


def test_C_cancel_only_cancels_not_yet_started():
    fresh_job_table()
    # slow send so cancel fires while BATCHES are still queued. Granularity is now the
    # batch (one PowerShell per batch): batches already started deliver all of their
    # files; only queued batches get cancelled. 120 files / batch 10 = 12 batches > 4 workers.
    H.GatewayHandler._recycle_powershell = fake_ps_slow
    h = make_handler()
    n = 120
    ws, paths = make_workspace_with_files(n)    # enough queued batches for cancel to bite
    try:
        code, obj = h._recycle_trash({"workspace": ws, "paths": paths})
        assert code == 200 and "job_id" in obj, obj
        time.sleep(0.08)                        # let the first worker round start
        code2, c = h._recycle_cancel({"job_id": obj["job_id"]})
        assert code2 == 200 and c.get("cancelled") is True, c
        deadline = time.time() + 8
        while time.time() < deadline:
            code3, prog = h._recycle_progress({"job_id": obj["job_id"]})
            assert code3 == 200, prog
            if prog.get("finished"):
                break
            time.sleep(0.05)
        assert prog.get("finished") is True, prog
        # the STOP-SEMANTIC contract (batch granularity): started batches deliver,
        # queued batches cancel, and the two together cover every file.
        assert prog["done"] + prog["cancelled"] == n, prog
        assert prog["done"] > 0, ("started batches must still deliver", prog)
        assert prog["cancelled"] > 0, ("queued batches must cancel", prog)
        assert prog["failed"] == 0, prog
        print("C cancel-midflight: done=%d cancelled=%d (total=%d)"
              % (prog["done"], prog["cancelled"], prog["total"]))
    finally:
        cleanup_ws(ws)


def test_D_unknown_job_id_is_404():
    fresh_job_table()
    h = make_handler()
    code, obj = h._recycle_progress({"job_id": "no-such-job"})
    assert code == 404, (code, obj)
    code, obj = h._recycle_cancel({"job_id": "no-such-job"})
    assert code == 404, (code, obj)
    print("D unknown-job: progress/cancel both 404")


def main():
    test_A_small_batch_stays_sync()
    test_B_large_batch_is_a_job_and_completes()
    test_C_cancel_only_cancels_not_yet_started()
    test_D_unknown_job_id_is_404()
    print("RECYCLE-JOB-MODEL TEST PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
