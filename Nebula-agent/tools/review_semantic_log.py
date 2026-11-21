"""Weekly review of data/semantic_maintain.log: a fragmentation-trend summary.

The maintenance task (tools/maintain_semantic_db.py) appends one audit line per run. This
reads those lines back and reports the numbers a weekly review wants:

    * how many runs did a VACUUM vs. skipped
    * the cumulative bytes reclaimed across all VACUUMs
    * the timestamp of the most recent run

`summarize()` is pure (takes log lines, returns a dict) so it is directly testable; the CLI
just reads the file and formats the dict. Reads the active log; if a rotated .1 archive is
passed via --include-archive it is folded in too (the .1 is the older generation).

Run:
    python tools/review_semantic_log.py
"""
from __future__ import annotations

import argparse
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "runtime"))
from config_loader import project_root  # noqa: E402

ROOT = project_root(__file__)
LOG = os.path.join(ROOT, "data", "semantic_maintain.log")

# [2026-11-21 15:53:45] VACUUM done  bytes ...  (reclaimed +15536128, 30.2%)  ...
# [2026-11-21 15:51:48] SKIP  (pages=...)  bytes=...
_TS_RE = re.compile(r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]")
_RECLAIM_RE = re.compile(r"reclaimed\s\+?(-?\d+)")
# Fragmentation per line: SKIP lines carry "frag=12.3%"; VACUUM lines carry the before->after
# page/freelist counts, so their fragmentation is free_before/pages_before. The lock-busy SKIP
# carries neither and is simply not a trend point.
_FRAGPCT_RE = re.compile(r"frag=(\d+(?:\.\d+)?)%")
_VACPF_RE = re.compile(r"pages\s+(\d+)->(\d+)\s+free\s+(\d+)->(\d+)")
# Sparkline blocks (ascending) for the trend bar.
_SPARK = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588"
TREND_N = 10  # default: show the most recent N fragmentation points


def summarize(lines, trend_n: int = TREND_N) -> dict:
    """Reduce audit log lines to a fragmentation-trend summary (pure, testable).

    Returns {"vacuum", "skip", "reclaimed", "last_ts", "lines", "trends", "trend_n"}.
    "trends" is a list of (ts, frag_pct) for the most recent trend_n lines that carry a
    fragmentation reading, sorted oldest->newest by timestamp.
    A line counts as a VACUUM when it contains "VACUUM" and a SKIP when it starts (after the
    timestamp) with "SKIP"; "reclaimed +N" on a VACUUM line adds N to the running total. The
    fixed-width "[YYYY-MM-DD HH:MM:SS]" timestamps compare correctly as plain strings, so the
    max is the most recent run.
    """
    vacuum = skip = reclaimed = 0
    last_ts = None
    counted = 0
    frag_points: list = []
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        counted += 1
        m = _TS_RE.match(line)
        if m:
            ts = m.group(1)
            if last_ts is None or ts > last_ts:
                last_ts = ts
        if "VACUUM" in line:
            vacuum += 1
            rm = _RECLAIM_RE.search(line)
            if rm:
                reclaimed += int(rm.group(1))
        elif "SKIP" in line:
            skip += 1
        # fragmentation reading for this line (SKIP: frag=%; VACUUM: free_before/pages_before)
        pct = None
        fp = _FRAGPCT_RE.search(line)
        if fp:
            pct = float(fp.group(1))
        else:
            vp = _VACPF_RE.search(line)
            if vp and int(vp.group(1)):
                pct = 100.0 * int(vp.group(3)) / int(vp.group(1))
        if pct is not None and m:
            frag_points.append((m.group(1), round(pct, 1)))
    frag_points.sort(key=lambda t: t[0])  # oldest -> newest by the fixed-width timestamp
    trends = frag_points[-trend_n:] if trend_n > 0 else frag_points
    return {"vacuum": vacuum, "skip": skip, "reclaimed": reclaimed,
            "last_ts": last_ts, "lines": counted, "trends": trends, "trend_n": trend_n}


def format_summary(s: dict) -> str:
    """Render a summarize() dict as a short human-readable weekly-review block."""
    mb = s["reclaimed"] / (1024 * 1024)
    last = s["last_ts"] or "(no runs recorded)"
    return (
        "semantic.db 周复盘摘要\n"
        "  VACUUM 次数 : %d\n"
        "  SKIP   次数 : %d\n"
        "  累计回收     : %d bytes (%.2f MB)\n"
        "  最近一次     : %s\n"
        "  审计行数     : %d" % (s["vacuum"], s["skip"], s["reclaimed"], mb, last, s["lines"])
        + _format_trend(s.get("trends", []))
    )


def _format_trend(trends) -> str:
    """Render a fragmentation-rate sparkline + the last reading (ts, pct) per point."""
    if not trends:
        return "\n  碎片率趋势   : (无碎片读数)"
    bars = ""
    for _ts, pct in trends:
        idx = max(0, min(len(_SPARK) - 1, int(pct / 100.0 * (len(_SPARK) - 1) + 0.5)))
        bars += _SPARK[idx]
    latest = trends[-1]
    return "\n  碎片率趋势   : %s  最近 %.1f%% (%s)，共 %d 点" % (bars, latest[1], latest[0], len(trends))


def read_lines(paths) -> list:
    lines: list = []
    for p in paths:
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                lines.extend(f.read().splitlines())
    return lines


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Summarize data/semantic_maintain.log for weekly review.")
    ap.add_argument("--log", default=LOG, help="audit log path (default data/semantic_maintain.log)")
    ap.add_argument("--include-archive", action="store_true",
                    help="also fold in the rotated <log>.1 archive (the older generation)")
    ap.add_argument("--trend-n", type=int, default=TREND_N,
                    help="show the most recent N fragmentation-rate points (0 = all; default %d)" % TREND_N)
    a = ap.parse_args(argv)
    paths = [a.log + ".1", a.log] if a.include_archive else [a.log]
    s = summarize(read_lines(paths), trend_n=a.trend_n)
    print(format_summary(s))
    return 0


if __name__ == "__main__":
    sys.exit(main())
