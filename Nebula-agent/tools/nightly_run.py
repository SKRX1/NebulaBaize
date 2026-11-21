# -*- coding: utf-8 -*-
"""Nightly build entrypoint — the "slow lane" guard rail.

Runs the three slow checks end to end and aggregates their verdicts:

  1. soak          — long-session stress (live against 8099+8080 if up, else in-process)
  2. behavior_judge — per-turn soft-instruction adherence (heuristics + LLM if configured)
  3. scan_session  — parse turn.jsonl / rounds.jsonl / judge_stream.jsonl for silent failures

Designed to be safe to run anywhere:
  * live soak degrades to in-process when the engine is down (no hard failure),
  * every step's failure is reported but the script only exits non-zero on a genuine
    hard invariant violation (so a flaky engine doesn't red the whole nightly on its own).

Usage:
    python tools/nightly_run.py                 # auto: live if gateway reachable
    python tools/nightly_run.py --live          # force live, fail if engine down
    python tools/nightly_run.py --fake          # force in-process (CI)
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGS = os.path.join(ROOT, "logs")
PY = sys.executable


def _run(cmd: list[str], label: str, fail_ok: bool = True) -> tuple[int, str]:
    """Run a subprocess; return (rc, stdout). Never raises."""
    try:
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=1800)
        out = (proc.stdout or "") + (proc.stderr or "")
        print(f"\n=== {label} (rc={proc.returncode}) ===\n{out.strip()[-2000:]}")
        return proc.returncode, out
    except Exception as e:  # timeout / spawn error
        msg = f"{label} could not run: {e}"
        print(f"\n=== {label} (ERROR) ===\n{msg}")
        return (0 if fail_ok else 1), msg


def _rotate(path: str):
    """Move a gateway log aside (timestamped backup) so the nightly scan only judges
    the current window, not months of accumulated history (incl. synthetic test runs)."""
    if not os.path.exists(path):
        return
    import time as _t
    bak = f"{path}.bak-{_t.strftime('%Y%m%d-%H%M%S')}"
    try:
        os.replace(path, bak)
        print(f"  rotated {os.path.basename(path)} -> {os.path.basename(bak)}")
    except OSError as e:
        print(f"  warn: could not rotate {path}: {e}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Nightly soak + judge + scan.")
    ap.add_argument("--live", action="store_true", help="force live soak (fail if engine down)")
    ap.add_argument("--fake", action="store_true", help="force in-process soak (CI)")
    ap.add_argument("--gateway-url", default="http://127.0.0.1:8099")
    ap.add_argument("--turns", type=int, default=40, help="live: real turns")
    ap.add_argument("--rounds", type=int, default=40, help="in-process: rounds")
    ap.add_argument("--known", default="filesystem__write shell__exec",
                    help="known tool names for judge/scan")
    ap.add_argument("--no-rotate", action="store_true",
                    help="do not rotate gateway health logs before scanning")
    args = ap.parse_args()

    os.makedirs(LOGS, exist_ok=True)
    known = set(args.known.split())

    # Scope the scan to this run: rotate the rolling health logs first. The live soak
    # (and the running gateway's async judge) repopulate them during this run, so the
    # scan afterwards reflects only the nightly window — not stale synthetic failures.
    if not args.no_rotate:
        for fn in ("turn.jsonl", "rounds.jsonl", "judge_stream.jsonl"):
            _rotate(os.path.join(LOGS, fn))

    hard_fail = False

    # 1) soak
    if args.fake:
        rc, _ = _run([PY, "tools/soak_runner.py", "--fake", "--rounds", str(args.rounds),
                      "--report", os.path.join(LOGS, "soak_report.json")], "soak(in-process)")
    else:
        soak_cmd = [PY, "tools/soak_runner.py", "--gateway-url", args.gateway_url,
                    "--model", "strata", "--turns", str(args.turns),
                    "--report", os.path.join(LOGS, "soak_report.json")]
        if args.live:
            soak_cmd.append("--require-engine")
        rc, out = _run(soak_cmd, "soak(live-if-up)")
        # only a hard invariant violation (engine required & down, or aborted) is fatal
        if args.live and rc != 0:
            hard_fail = True
    if rc not in (0,):
        # live-without-requirement returns 0 on skip; any other non-zero is real
        if not (not args.live and rc == 0):
            hard_fail = hard_fail or (rc != 0)

    # 2) behavior judge on the live soak turns (if produced)
    soak_turns = os.path.join(LOGS, "soak_turn.jsonl")
    if os.path.exists(soak_turns):
        judge_cmd = [PY, "tools/behavior_judge.py", soak_turns]
        if known:
            judge_cmd += ["--known", *known]
        rc, out = _run(judge_cmd, "behavior_judge(soak turns)")
        if rc != 0:
            hard_fail = True

    # 3) session scan across all logs
    rc, out = _run([PY, "tools/scan_session.py", "--dir", LOGS], "scan_session")
    if rc != 0:
        hard_fail = True

    print("\n=== NIGHTLY SUMMARY ===")
    print("  hard_fail:", hard_fail)
    return 1 if hard_fail else 0


if __name__ == "__main__":
    sys.exit(main())
