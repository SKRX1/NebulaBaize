# semantic.db VACUUM tuning notes

> [简体中文](vacuum-tuning.md) | **English**

> **Current baseline (measured 2026-11-21)**: the database ≈ 49.3 MB (51,703,808 bytes /
> 12,623 pages / free 405), fragmentation frag ≈ 3.21%, far below the 25% threshold — today it
> takes the SKIP branch daily at near-zero cost, and the gate parameters need no adjustment. Once the
> database grows to a page count well beyond 2000 and frag gradually approaches the threshold, adjust
> per "how to tune as the database grows" below. Re-check the baseline:
> `python tools\maintain_semantic_db.py` (prints pages/free/frag); inspect the trend:
> `python tools\review_semantic_log.py --include-archive`.

`tools/maintain_semantic_db.py` is woken by the scheduler at 04:30 daily and performs a **fragmentation-gated
check** on `data/semantic.db`: it performs a real VACUUM (rewriting the whole file to reclaim free
pages) only when the gate is satisfied, otherwise SKIP (reads only 3 PRAGMAs + appends one log line,
taking no write lock). The check is cheap and the action is expensive, so the gate parameters are
tuned to the database's growth.

## The gate decision (plan_vacuum)

```
real VACUUM  ⇔  page_count >= MIN_PAGES  and  freelist_count / page_count >= THRESHOLD
```

- The database is too small (`page_count < MIN_PAGES`) → never VACUUM: a whole-file rewrite is not
  worth it.
- The fragmentation ratio is below `THRESHOLD` → SKIP: reclaiming those few pages isn't worth a full
  copy.
- Failing to acquire the write lock (the memory server holds it) → SKIP, retry next cycle, never
  blocking online recall.

## Current default values (measured from code)

| Parameter | Default | Meaning |
|---|---|---|
| `MIN_PAGES` | **2000** | do not VACUUM below this page count (≈ 8 MB @ 4KB pages) |
| `THRESHOLD` | **0.25** | only VACUUM once free-page share ≥ 25% |
| `BUSY_MS` | **3000** | max time to wait for the write lock; time out → SKIP |
| `MAX_LOG_BYTES` | **1048576** | rotate the audit log to `.1` once it reaches 1 MB (0 disables) |

A 4 KB page ≈ 4 KB, so `MIN_PAGES=2000` ≈ 8 MB; page_count × 4KB ≈ database bytes.

## How to tune as the database grows

The CLI can override temporarily, to try parameters by database size (without changing code):

```
python tools\maintain_semantic_db.py --min-pages 4000 --threshold 0.15 --busy-ms 5000
```

Tuning direction (based on observed data, not intuition):

- **Database gets bigger** (page count well beyond 2000): keep `MIN_PAGES` as is — it is only the
  "don't bother with a too-small database" floor; when the database is already large you may raise it
  slightly, to avoid frequent full rewrites over small-scale fragmentation fluctuation.
- **Fragmentation grows slowly** (`frag` long well below 0.25, SKIP every day): you may lower
  `THRESHOLD` slightly (e.g. 0.15) so it triggers earlier and reclaims more; each VACUUM is a full
  copy — the lower the threshold the more often it triggers and the more I/O, a trade-off.
- **The memory server holds the lock for a long time** (log shows `write lock busy`): raise
  `BUSY_MS` slightly to give lock acquisition more patience; don't set it too long, or it slows the
  daily task window.

The basis for judgment comes from the audit log `data/semantic_maintain.log` (each line contains
`pages=… free=… frag=…%`, and VACUUM lines have before/after bytes); inspect the trend with
`tools/review_semantic_log.py`:

```
python tools\review_semantic_log.py --include-archive
```

The trend bar `碎片率趋势` (fragmentation trend) shows the fragmentation trend over the most recent
`--trend-n` (default 30, roughly one month of daily runs); if it stays near 0% long-term, the database
is append-dominated with few deletions, the 25% threshold is very lax, and the default should be kept.

## How to land a change to the default values

The default values are written as top-of-file constants in `tools/maintain_semantic_db.py`
(`MIN_PAGES` / `THRESHOLD` / `BUSY_MS`). Changing a default is a code change: after changing it you
must pass `tests/test_maintain_semantic_db.py` (locks the `plan_vacuum` threshold / floor-gate) + the
full regression; the scheduled task `记忆库体积守护 VACUUM` (`config/mcp_servers.json`, daily 04:30)
needs no frequency change — it is "check daily, reclaim conditionally".
