# Daily code-backup precheck: from a hard block to "soft alert + on-disk review"

> [简体中文](backup-soft-alert.md) | **English**

> This records a clear product decision for future reference: why the precheck of the 03:00
> "daily code backup" (`backup_precheck.py`) no longer **hard-blocks** the backup, but instead
> does "a **soft, non-blocking alert + write the alert to disk** at `data\backup.log`, with a
> size-capped rotation added to that log". This document also **corrects** an earlier version's
> mistaken `|| exit /b 0` wording (measured to be wrong under cmd).

## Background

The precheck `backup_precheck.py` first runs `git fetch`, then compares the ahead/behind between
local and `origin/main`. **It exits with code 2 (block) only when both sides are ahead (a true
divergence)**; one-sided ahead or `0 0` in-sync always passes. The decision logic
`decide(behind, ahead)` is locked by both an offline unit test (`tests/test_backup_precheck.py`)
and an end-to-end differential (`tests/test_backup_precheck_e2e.py`, building a real divergence in
a real repo to confirm exit 2).

The original design was a **hard block**: on divergence `&&` short-circuits, the bundle does not
run, forcing "integrate first, then back up".

## Decision: soft, non-blocking alert + write the alert to disk + log size rotation (landed)

Conclusion: the precheck **keeps running and keeps alerting**, but **no longer blocks the
backup** — on divergence the backup proceeds as usual; the alert is written to `data\backup.log`
for later review; that log is size-capped and rotated by `rotate_log.py` to prevent unbounded
growth.

### Why it no longer hard-blocks

1. **A divergence almost never happens in the real workflow**: this machine is the only pusher and
   pushes first each round, so `origin/main` stays `0 0` in-sync with local for a long time (measured
   to be so over the long run). The daily trigger rate of a hard block is ~0.
2. **The cost and benefit of blocking are asymmetric**: divergence is rare, but if it happens and
   triggers exactly at 03:00, a hard block **silently skips** the whole day's bundle — losing one
   daily snapshot, while the very purpose of backup is "keep at least one copy every day".
3. **The "silence" of a hard block is hard to diagnose**: when skipped by `&&`, the old
   implementation left no on-disk trace at all.

### Key pitfall ①: both `|| true` and `|| exit /b 0` are wrong under cmd (measured correction of an earlier note)

The scheduler's `task` runs through `subprocess shell=True`, which on Windows goes through
**cmd.exe** (the task text itself is cmd syntax such as `cd /d`). This round we used the real
`backup_precheck.py` (exit 2) + real cmd end-to-end testing; the conclusion differs from the
previous pure-text reasoning, **corrected here**:

| Form | precheck=0 (normal day) | precheck=2 (diverged day) | Conclusion |
|---|---|---|---|
| `|| true` | no backup | no backup | ✗ cmd has no `true` builtin (that's PowerShell) |
| `|| exit /b 0` (the earlier mis-recorded option) | backup | **no backup** | ✗ `exit /b 0` ends the whole cmd process, so the subsequent `&& bundle` never runs — worse than a hard block (the agent still exits 0 and wrongly considers it a success) |
| `|| rem` / `|| (rem ok)` | no backup | no backup | ✗ unreliable |
| **`( … || cd . )` (adopted)** | backup | backup + alert on disk | ✓ inside a parenthesized group `||` swallows the code, `cd .` succeeds → the whole group exits 0 → the subsequent `&&` proceeds normally |

Key point: a bare chain `A || B && C` is flat left-associative in cmd, and a success after `||`
does not necessarily propagate through to `&&`; but once the precheck and the code-swallowing no-op
are **enclosed in a parenthesized group `( … )`**, the group's exit code is the state of "the last
command in the group", `cd .` always succeeds → the whole group exits 0 → the outer `&&` lets the
bundle through. **Parenthesization is the only reliable form here.**

### Key pitfall ②: the redirection must wrap the whole group, or the alert is not captured

In cmd, `A && B && C >> log` binds `>> log` **only to the last command C**, so the precheck
segment's stderr (the `PRECHECK FAIL` alert) is not captured at all. To capture the whole run, the
`>>` **must wrap the whole group**:

```
( cd /d "<repo>" && python backup_precheck.py || cd . ) >> "<abs-log>" 2>&1
```

(`cd .` does not change the drive, but to fully avoid relative-path ambiguity in the parenthesized
sub-environment, the log uses an **absolute path**.)

### Key pitfall ③: the log rotation must happen before `>>` opens the file

`>> backup.log` holds the file handle as soon as cmd starts, so nothing inside the group or in a
child process can rotate it afterwards (Windows lock). Therefore `rotate_log.py` must be the
**first** step of the task, exiting **before** the grouped redirection opens backup.log (cmd's
sequential execution guarantees the handle is released). `tests/test_rotate_log.py` locks its
contract of "over-size → shift by descending order keeping N copies + truncate the active file
(not delete)".

## The real task after landing (config/mcp_servers.json → schedule.entries[0].task)

```
cd /d "<repo>" \
  && python Nebula-agent\tools\rotate_log.py "<abs>\Nebula-agent\data\backup.log" --max-bytes 1048576 --keep 3 \
  && ( python Nebula-agent\tools\backup_precheck.py || cd . ) >> "<abs>\Nebula-agent\data\backup.log" 2>&1 \
  && cd /d "<repo>\Nebula-agent" && python tools\backup-bundle.py --keep 14
```

Execution semantics (verified end-to-end on a real repo + real cmd):
- **Normal day (0 0)**: rotate is mostly a no-op → the log appends `PRECHECK OK` → the bundle runs.
- **Diverged day**: the log appends `PRECHECK FAIL diverged …` (the alert is reviewable) → via
  `( … || cd . )` it does not block → the bundle **runs as usual**.
- When the log exceeds 1 MiB, `rotate_log.py` rotates `backup.log` into `.1/.2/.3` (keeping 3
  copies, deleting the oldest); the active file is truncated to empty awaiting the next append;
  disk usage is capped at ~4 MiB.
- Note: the `(blocking)` wording in `backup_precheck.py` is its original phrasing; under the new
  scheme it is only an **alert** and does not actually block.

## How to check whether a backup succeeded / whether a divergence ever happened

1. Look at `Nebula-agent\data\backup.log`: each run appends a line `PRECHECK OK …` (normal) or
   `PRECHECK FAIL diverged …` (a divergence occurred but it still backed up). For over-size history
   see `.1/.2/.3`.
2. Look at `每日代码备份.last_run` in `Nebula-agent\data\schedule_state.json` (ts ≈ 03:00 that day,
   `ok=true`).
3. Check whether the primary/mirror drives `E:\星云备份\星云白泽备份` and `F:\星云备份\星云白泽备份`
   gained a `strata-bundle-YYYYMMDD-HHMMSS.bundle` for the current day.

## Related code / tests

- `Nebula-agent/tools/backup_precheck.py` — the precheck (`decide` pure function + main, exit 2 only on a true divergence)
- `Nebula-agent/tools/rotate_log.py` — size-capped rotation for backup.log (added 2026-11-22)
- `Nebula-agent/tools/backup-bundle.py` — bundle generation with two-drive verification, keep-N trimming
- `Nebula-agent/tests/test_backup_precheck.py` — offline differential for `decide()`
- `Nebula-agent/tests/test_backup_precheck_e2e.py` — real-repo end-to-end (exit 2 → old `&&` skipped the bundle)
- `Nebula-agent/tests/test_rotate_log.py` — the `rotate_log.rotate` contract (no-op/over-size/keep-N/truncate-not-delete/boundary)
- `runtime/gateway.py:_sched_run_task` — actual execution of the scheduled task and deliver routing (the task runs shell via `agent.run`)

## How it takes effect

The scheduler host (`scheduler_host.SchedulerHost`) **hot-reloads** config on every tick; editing
the task takes effect immediately, **no need to restart** 8099. (An earlier note mistakenly said
"a restart is required"; corrected here.)

## Design stance (final conclusion): the value is a "sentinel", not a "block"

After several rounds of measurement and retrospection, the positioning of this feature converges to
one sentence: **the value of the precheck lies in "leaving a signal when an anomaly is found", not
in "blocking the backup".** The soft alert happens to untangle a dilemma that was long agonized over:

- "Keep the backup" — regardless of divergence, keep at least one bundle every day (the very purpose
  of backup);
- "Keep the signal" — on a true divergence still leave a `PRECHECK FAIL diverged` trace (reviewable
  via data\backup.log + the session stream).

A hard block trades "sacrificing the day's snapshot" for "a reminder to integrate first", but the
cost and benefit are asymmetric (a divergence almost never happens, trigger rate ≈ 0, yet once it
triggers it loses the whole snapshot and the old implementation left no trace); not using a precheck
at all would forfeit this sole divergence sentinel, saving only the few seconds of one daily fetch.
Hence "use it, but don't let it block" is strictly better than both "use it and block" and "don't
use it".

Therefore `decide()` still keeps exit code 2 / level=FAIL (this is the **contract and signal**; other
callers may block on it themselves); it is only that the daily task chooses `( … || cd . )` to
swallow it and continue backing up. **The signal is kept; the action is decoupled.**

> Decision (ruled by the owner on 2026-11-22): keep the status quo — retain the precheck's soft
> alert, no further change.
