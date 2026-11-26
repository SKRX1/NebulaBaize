# docs index

> [简体中文](README.md) | **English**

A central navigation for the documents in this directory. When adding a new design/operations
document, register a one-line entry here (grouped by topic).

## Operations / tuning

- [`vacuum-tuning.md`](vacuum-tuning.md) / [简体中文](vacuum-tuning.md) — notes on tuning the `semantic.db` VACUUM gate
  (how to adjust MIN_PAGES / THRESHOLD / BUSY_MS as the database grows; includes the current
  real-database baseline).

- [`backup-soft-alert.md`](backup-soft-alert.md) / [简体中文](backup-soft-alert.md) — why the daily code-backup precheck moved from a
  hard block to "a soft, non-blocking alert + write the alert to data\backup.log + size rotation".
  Includes a measured truth table showing both `|| true` and `|| exit /b 0` are wrong under cmd, that
  the only safe primitive is the parenthesized group `( … || cd . )`, and the design stance "the value
  is a sentinel, not a block".

- [`proxy-port-consistency.md`](proxy-port-consistency.md) / [简体中文](proxy-port-consistency.md)
  — proxy-port consistency: three independent 7890 stores, how to locate a mismatch on a
  machine/port change; boot-time check_proxy_config probe + download proxy-down direct-retry log.

## Design / review

- [`plan-b-shell-direct-exec-review.md`](plan-b-shell-direct-exec-review.md) / [简体中文](plan-b-shell-direct-exec-review.md) — review record of
  Plan B (direct shell execution).

## History / archive

- [`baseline-tag-archive.md`](baseline-tag-archive.md) / [简体中文](baseline-tag-archive.md) —
  an archive ledger of `v-baseline-*` tags cleaned up after being superseded by a later baseline
  (records each tag's commit and exact rebuild command; deleting the tags loses no commit, the
  master chain already contains them).
