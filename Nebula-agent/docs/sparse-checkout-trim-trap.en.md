# Accidentally Enabling sparse-checkout Made servers/ and tools/ Vanish from the Main Repo

> [简体中文](sparse-checkout-trim-trap.md) | **English**

Locked fact: **the main repo (the development/runtime body) should never use sparse-checkout**.
Under cone mode, git physically deletes directories outside the sparse list and flags them
`skip-worktree`, while `git status` still reports "clean" — it looks exactly like "the tools and
services were suddenly deleted", but they were merely hidden by sparse checkout.

## Symptom (user's view)

The `servers/` (MCP server scripts) and `tools/` (regression/backup/scaffold scripts) directories
disappear from the working tree, yet git status reports no deletion and still tracks them. Many
tools then fail at runtime with `No such file` or `ModuleNotFoundError`. They were only recoverable
by restoring from the bundle under `E:\星云备份\星云白泽备份`.

## Root cause (operational accident)

Sparse checkout was being set up for a **temporary reference repo** (a third-party repo cloned into
`%TEMP%\...`) to keep only a few directories and avoid downloading the whole repo — but the command
`git sparse-checkout set Nebula-agent/runtime Nebula-agent/serve/web Nebula-agent/tests` was run in
the **main-repo cwd** by mistake. Under cone mode this means "keep only these 3 directories", so
servers/ and tools/ were pruned. The config evidence:

```
core.sparseCheckout       = true
core.sparseCheckoutCone   = true
git sparse-checkout list  = Nebula-agent/runtime
                            Nebula-agent/serve/web
                            Nebula-agent/tests   (missing servers/ and tools/)
```

## Recovery and de-mining

1. Recover single files: `git checkout-index -f --ignore-skip-worktree-bits -- <path>`
   (a `skip-worktree` file is refused by a plain `git checkout`; this flag force-writes it from the index);
2. **De-mine for good**: `git sparse-checkout disable`, flipping `core.sparseCheckout`/`Cone` to `false`,
   drop the skip-worktree count to 0, so servers/ and tools/ permanently return to the full working tree.
   Measured after de-mining: `tools/` went from the pruned 15 back to all 63, and all of `servers/` was on disk.

## Prevention

- Before sparse operations on a **temporary reference repo**, `cd` into that repo first (or use
  `--git-dir` to point at it explicitly); never run `sparse-checkout set/disable` in the main-repo cwd.
- Any `core.sparseCheckout=true` on the main repo is a high-risk signal — run `git sparse-checkout disable` first.
- When using `--depth 1 --filter=blob:none --sparse` for a temp clone, the sparse commands must act on
  that temp repo, and clean up the temp dir afterward so the sparse config never leaks back into the main repo.

## Relationship to backups

`git bundle create ... --all` captures the **full commit graph**, unaffected by sparse-checkout — so the
pruned servers/tools are still inside the bundle and recoverable via a full clone from backup. But the
missing working-tree files cause the runtime and regression suite to "false-crash", so whenever
servers/tools appear missing, first run `git config --get core.sparseCheckout` to tell whether sparse
checkout was mistakenly enabled, then decide between recovery and de-mining.
