# Plan B review: let "pure shell tasks" run via subprocess directly, decoupled from the LLM turn

> [简体中文](plan-b-shell-direct-exec-review.md) | **English**

## Background (measured facts)
- The scheduled task's `task` string is currently **not run directly as shell**, but is fed as an
  **LLM prompt to `agent.run()`** (`gateway.py:_sched_run_task` → `agent.run(task, history=[])`),
  letting the model itself decide which tool to call to run the command.
- The pass/fail decision point is `scheduler.py:_safe_run`: `run_task` not raising = success, raising
  any exception = record `last_run.ok=false`.
- "每日代码备份" (daily code backup) recorded `ok=false` at 03:30 today; the script itself is healthy
  (ran `backup-bundle.py --keep 14` → `ALL GREEN`, including the F-drive cross-drive mirror MD5). The
  failure happened at the "LLM turn" layer, not the script layer.
- The fix already landed this session (commit `827b053`) = Plan A: route `schedule-error` to the audit
  JSONL + stderr, so the failure cause becomes **visible and auditable**. **It did not change the
  execution semantics**, so the "run shell via an LLM turn" path itself is unchanged.

## What Plan B is
For tasks whose "action is clearly one shell command" (e.g. this one
`cd /d "..." && python tools\backup-bundle.py --keep 14`), **skip the LLM turn and run via subprocess
directly**, using the exit code as the pass/fail criterion (non-zero = red, and write stderr to the
audit).

## Impact surface (key: this changes the execution model and affects every other scheduled task)
1. **Decision semantics change**: today's "success" = the LLM turn raised no exception; Plan B's
   "success" = the command exited 0. The two paths have different criteria, so which task goes down
   which path must be made explicit.
2. **approval/roots semantics**: `approval`, `roots`, `model` are currently designed for "agent turns"
   (standing consent, fs_allowed_roots swap, model routing). When a shell runs directly, most of these
   fields **lose meaning** (no tool call, no model); separate shell approval/roots rules are needed,
   otherwise users are confused about "why a model was chosen for a shell task".
3. **busy serialization**: the existing `idle_gate` queues scheduled tasks after interactive turns
   (preventing concurrent contention over the model / shared executor). A direct shell grabs subprocess
   resources, not the model — whether it still goes through idle_gate needs a decision (through it =
   conservative and consistent with today; not through it = faster but may read/write shared files
   concurrently with interactive turns).
4. **Environment differences**: the cwd/env/encoding of a direct subprocess (especially Chinese paths
   `E:\星云\...` and `chcp 65001`) must be tested; the script already self-demonstrates "paths are
   passed as unicode argv, Chinese paths are not hardcoded", so this is in place, but `cmd /d` line
   endings and exit-code capture still need testing.
5. **Low irreversibility**: Plan B is an **added branch** (a flag distinguishes shell tasks from agent
   turns), not cutting all existing tasks over at once; old tasks keep the LLM turn, new shell tasks
   run directly, and the two coexist.

## Relationship to Plan A
- Plan A (already landed) solves "failures are **invisible**" — it is needed regardless of which
  execution path is taken, and is a **general observability foundation**, not a temporary patch.
- Plan B solves "we **shouldn't detour through an LLM** to run a deterministic shell command" — an
  enhancement of the execution model, higher risk and wider impact, and should be **reviewed separately
  before doing it**.

## Recommendation (default, for decision)
Default recommendation: **do nothing yet**; let Plan A be observed over at least one real 03:30
trigger (to confirm the audit can show real success/failure). If the failure is confirmed to be mainly
"the LLM turn unreliably not running the shell", then establish Plan B, satisfying at least:
1. distinguish via an explicit flag (e.g. add `exec: "shell"` to the task entry), and **do not** change
   existing agent-turn tasks;
2. direct shell runs **reuse Plan A's audit channel** too (failure cause lands in the JSONL);
3. pair it with an offline differential test: inject a failing shell (non-0 exit) → assert `ok=false`
   and the audit contains stderr; inject a succeeding shell (0 exit) → assert `ok=true`.

## One-line risk rating
- Plan A (done): low risk, pure observability, already landed.
- Plan B: medium risk, changes the execution model and affects the decision/approval semantics of all
  scheduled tasks; recommended to observe first and open a separate project.
