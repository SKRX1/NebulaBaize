# Back-end modularization progress

[简体中文](backend-modularization.md) | **English**

The back-end `serve/server.py` was once a 7,000+ line monolith. To make it testable and maintainable, cohesive
pure-function families are steadily lifted out of it into standalone `serve/*.py` modules under a *whole-family
zero-coupling move* discipline. This file tracks that extraction chain and the method it follows.

## Method discipline

1. **AST out-deps scan decides purity.** For each candidate function, compute the *module globals* it references
   (excluding stdlib, locals, builtins). A function is a *safe leaf* only when its free names are all stdlib
   imports plus its own parameters / family members. A module-level constant a function reads, when part of the
   same family, is **lifted out together** (e.g. engine_diag's `_WIN_CRASH` / `TRANSIENT_START_MARKS`).
2. **Byte-for-byte equivalence move**, not a rewrite: bodies are lifted out of server.py byte-for-byte rather than
   re-typed, so embedded escaped-quote diagnosis strings survive exactly.
3. **try/except double-path import** (a back-end-only convention): `from serve.X import ...` / `except ImportError:
   from X import ...`, because `server.py` can be run directly as `python serve/server.py` (then `serve/` is
   `sys.path[0]`). Call sites keep their original names. The front-end `app_utils.js` is globally shared and has
   **no** such convention.
4. **Every clean leaf ships a load-bearing differential behaviour test**, registered in `tests/test_pure_modules.py`
   (the per-module summary file, already registered in `tools/run_tests.py` SUITES — no separate registration). The
   differential must prove the branch *has to be taken*.
5. **Heterogeneous responsibilities are not merged**: "config assembly" and "start-up failure diagnostics" inside the
   same engine subsystem do not merge; `engine_crashed`, earlier left in server.py because it is *heterogeneous to
   boot_diagnose* (returns a bool, not a message), later turned out to be the strong-cohesion group-mate of the
   exit-status / crash-predicate members — so it was grouped into `engine_diag`.

## Extraction progress

| module | subject | batch | status |
|---|---|---|---|
| `serve/wire_codec` | OpenAI/Anthropic stream reassembly | plan-B batch (2026-11-17) | done |
| `serve/net_gate` | host / origin / api-key admission gate | plan-B batch | done |
| `serve/req_args` | request/config sampling-parameter sanitization | plan-B batch | done |
| `serve/req_stats` | per-request token/timing accounting | plan-B batch | done |
| `serve/ram_guard` | RAM-budget start-up warnings | plan-B batch | done |
| `serve/gpu_score` | per-card NVIDIA/AMD capability scores | plan-B batch | done |
| `serve/boot_diagnose` | human-readable start-up failure diagnostics (bind / encoder / log tail) | plan-B batch | done |
| `serve/path_locate` | resolve a configured/user input to the real usable path | plan-B batch | done |
| `serve/gpu_config` | the config's GPU list / whether naming several is a split | plan-B batch | done |
| `serve/env_probe` | is a dir writable / is this a Linux desktop session | plan-B batch | done |
| `serve/engine_stall` | the frozen-engine watchdog predicate + two thresholds | plan-B batch | done |
| `serve/tokenizer` | byte tokenizer stand-in / Detokenizer / stop_strings / StopMatcher | chain step 1 | done |
| `serve/approval` | tool-approval policy: registry-mutation set + destructive-shell deny + desc | chain step 2 | done |
| `serve/conv_cache` | engine conversation-cache log reader + the Monitor cache-card view | chain step 3 | done |
| `serve/engine_diag` | engine exit-status words / crash predicate / draft-head hint / GPU-runtime marks | chain step 4 | done |
| `serve/exceptions` | the engine/session exception hierarchy (9 classes: inheritance + status / retry_after loads) | chain step 5 | done |

"plan-B batch" = the first bulk extraction (refactor plan-B, 2026-11-17, eleven pure modules lifted at once);
"chain" = the incremental chain that keeps lifting one zero-coupling cohesive family at a time (tokenizer → approval
→ conv_cache → engine_diag → exceptions). Every step cuts a named rollback tag + a bundle snapshot — see `baseline-tag-archive.md`.

## Candidate-pool status

server.py keeps growing with new code. Before extracting the next family, re-run the AST out-deps=0 scan to re-list
candidates (the `tools/_q_*.py` probe series, deleted after use). Note that within the engine family,
`cpu_isa_words` / `start_exit_note` / `START_RETRIES` / `transient_start_failure` are the *heterogeneous* start-retry
and CPU-instruction-set probe responsibilities and are left in server.py on purpose (`transient_start_failure` still
reads `TRANSIENT_START_MARKS` via the import shim).
