# 星云白泽 · Nebula Baize
[![License: AGPL-3.0-only](https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg)](LICENSE) [![Sponsor](https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-pink.svg)](https://github.com/sponsors/SKRX1)

> An original **application-layer** agent — gateway, runtime, skills, memory, and web UI —
> **powered by Strata** inference engine.

**Author:** 时空象容

> Read this in: **English** | [简体中文](README.zh-CN.md)

---

## Architecture

A one-line picture of "what this repo ships" vs "what it runs on top of":

```
+--------------------------------------------------------+
|  Nebula Baize / 星云白泽  (THIS repository)             |   <- original application layer
|  gateway · runtime · skills · scheduler · memory · tools   |      (AGPL-3.0, (c) 2026 时空象容)
|  web frontend (serve/web)                               |
+--------------------------------------------------------+
                          |
                    --url (HTTP / OpenAI-compatible)
                          |
                          v
+--------------------------------------------------------+
|  Strata inference engine  (runtime prerequisite, NOT bundled) |   <- runtime dep
|  native backend: src · include · metal · sycl · third_party|      (separately licensed by its authors)
+--------------------------------------------------------+
```

The arrow `--url` is the *only* link between the two. This repository = the top box only.

---

## What this is

星云白泽 (Nebula Baize) is the **original application layer** of this project: the agent gateway,
runtime, skills, scheduling, memory subsystem, tools, and the web frontend. This code was authored
for Nebula Baize and is what this repository ships.

It is **not** the inference engine. At runtime it connects to a separately-installed
**Strata** engine over a network endpoint (`--url http://127.0.0.1:8080/v1`). The Strata engine
and its native backend are **not bundled** in this release — they are a runtime prerequisite you
supply yourself.

## Features

A local-first agent you run entirely on your own machine, with the model of your choice:

- **Local-first gateway + agent loop.** An OpenAI-compatible gateway (`runtime/`) runs the full
  tool-calling agent loop locally. Your files, commands, and conversations stay on your machine.
- **Works with any model.** Point it at the local **Strata** engine (incl. vision), or any
  OpenAI-compatible cloud endpoint you add from the web UI (keys stay server-side, applied live
  without a restart). Cloud models get the same local tools as long as they support function-calling.
- **~36 local tools over MCP.** File, shell, browser, web search, scheduling, memory, skill
  registry, and more — all executed locally, not in a cloud sandbox.
- **A web UI, no framework.** The frontend (`serve/web/`) is plain HTML/JS with no external
  network dependencies; served straight from the gateway at `http://127.0.0.1:8099`.
- **Skills & self-extending tooling.** Add MCP servers / skills and let the agent propose new
  ones; everything is registered, audited, and reversible.
- **Memory that compounds.** The more you use it, the better it fits your workflow — see
  [How it gets smarter with use](#how-it-gets-smarter-with-use) below, and the
  [full memory & experience guide](docs/MEMORY-GUIDE.md) for the mechanism.
- **Self-healing launcher.** One double-click starts a gateway watchdog that keeps port 8099 up
  (crash-restart loop) and never forces an inference engine you may not need.
- **Reproducible & auditable.** A full regression suite (jsdom gates + Python tests) guards both
  frontend and backend; deletions go to the OS recycle bin, and rolling git bundles back up the
  whole repo at tagged rollback points.

## Getting started

1. **Clone, then bootstrap the venv once** (a fresh clone has no `.venv`, so the launchers
   fail until this runs): `setup.bat` on Windows, or `bash setup.sh` on Linux/macOS.
   It creates `.venv`, installs the pinned deps (pillow/psutil/PySocks), rewrites config,
   and verifies all servers + the gateway import.
2. Install and run a **Strata** engine (the runtime prerequisite), serving an OpenAI-compatible
   endpoint, e.g. `http://127.0.0.1:8080/v1`.
3. Point this app layer at it via `--url` / model / port (edit `run_standalone.bat`, or pass
   `UPSTREAM_URL=... MODEL=... PORT=... bash Nebula-agent/run_standalone.sh`).
4. Start it: `星云白泽.bat` (Windows) double-clicks a watchdog that brings up the gateway on demand;
   or run `run_standalone.bat` / `run_standalone.sh` directly under `Nebula-agent/`. Open the local
   frontend (default http://127.0.0.1:8099).

### Prerequisites

- **Python 3.14 (latest patch recommended; 3.10 minimum)** — required. On Windows `setup.bat`
  first probes for an existing usable Python (`py -3` / `where python` / install-dir scan);
  **if it finds ≥3.10 it does not download or install** — only when none is available does it
  silently fetch and install Python 3.14. On Linux/macOS supply your own Python 3.14.
- **Node.js** — *not needed to run this app layer*; it is only required to run the JS test
  suites (jsdom gates / Playwright e2e). Nebula Baize itself is pure Python, no Node dependency.
- **Image generation** — done by an **external `sd-cli` executable** invoked via `subprocess`.
  It is **not a Python package and not in `requirements.txt`**; bring your own Stable-Diffusion CLI
  to use image features.
- **Python dependencies** — see `Nebula-agent/requirements.txt`: hard runtime deps are only
  `pillow / psutil / PySocks` (all pre-built wheels, no local compiler needed).
  `PyYAML / send2trash / strata_tokenizer` are optional and degrade gracefully via `try` /
  `find_spec`, so they are deliberately left out of requirements.

## How it gets smarter with use

星云白泽 keeps a **memory you own and can audit** — it is not hidden inside a model's weights.
Each conversation can deposit reusable knowledge into three separate, user-gated libraries that are
injected into future turns, so the agent progressively learns your file layout, build commands,
naming rules, and known pitfalls:

- **Rules** — stable operating conventions you confirm (directory layout, build/deploy commands,
  approval model, recurring gotchas).
- **Knowledge** — confirmed facts, API quirks, environment conclusions (toolchain behavior, versions).
- **Experience** — short post-task retrospectives ("context → decision → outcome → lesson").

**How it works, verbatim from the implementation:**

- A memory MCP server (`servers/memory_server.py`) exposes `recall` (retrieve cross-session memory
  by keyword), `ingest` / `forget` / `sources` / `read_source` (learn & manage reference documents).
  Retrieval runs over an **episodic store** (`data/episodic.jsonl`) and a **semantic store**
  (`data/semantic.db`), both pure standard library.
- Writes are **deliberately user-gated.** The model cannot write facts straight into the database;
  every deposition goes through a `propose-*` fence into the scoped, auditable three-library system,
  is written as a new entry you can **undo in one click**, and respects your auto-memory toggle.
  Auto-distillation can also feed the semantic store after a task — still recallable, still yours to review.
- Net effect: confirmed conventions take effect on every future conversation, wrong turns stay
  one-click reversible, and nothing is silently baked in.

For the full mechanism, the three-library lifecycle, and how to curate it, see the
**[full memory & experience guide](docs/MEMORY-GUIDE.md)**.

## License

- The original application-layer code in this repository is released under the
  **[AGPL-3.0 License](LICENSE)** + commercial dual-licensing (see `COMMERCIAL-LICENSE.md`), Copyright (c) 2026 **时空象容**.
- Bundled third-party runtime dependencies and their permissive licenses are listed in
  **[THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES)**.
- The **Strata** engine is **not bundled** and is **not** covered by this repository's license.
  It is a separate, independently-licensed project used as a runtime dependency; "Strata" is a
  name owned by its authors — this project is *powered by* Strata, not an official Strata product.

## Recovery

- Backups are rolling git bundles (`--keep 14`), on E: (primary) and F: (mirror) under
  `星云备份\星云白泽备份`. Each carries the full repo (commits + all baseline tags).

Clone the newest bundle to restore the repo at any rollback point (commits + tags):

```bat
:: Clone the newest bundle (incl. all tag rollback points), then checkout the target tag
for /f "delims=" %%F in ('dir /b /o-d "E:\星云备份\星云白泽备份\*.bundle" ^| more +0') do (
  git clone "E:\星云备份\星云白泽备份\%%F" restore_dir
  git -C restore_dir checkout v-baseline-2026-11-21-h
  goto :done
)
:done
```

Current newest sample: `strata-bundle-20261121-182344.bundle` (HEAD 48c7338, baseline tag v-baseline-2026-11-21-j).

Rehearsed clone drill (kept for reference)
Verified on 2026-11-21: clone bundle `182344` → checkout `v-baseline-2026-11-21-j` → restore HEAD `48c7338`
(a clean rollback point; the ledger cleanup block reads back in the restored tree), every step rc 0:

```bat
git clone "E:\星云备份\星云白泽备份\strata-bundle-20261121-182344.bundle" restore_dir
git -C restore_dir checkout v-baseline-2026-11-21-j
git -C restore_dir rev-parse HEAD   :: should print 48c7338935399a3bd4d7eef13a2524706d45802b
```

---

*Original application layer © 2026 时空象容 · AGPL-3.0 (dual-licensed). Powered by Strata.*
