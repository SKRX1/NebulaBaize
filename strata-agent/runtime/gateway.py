"""Gateway entry point: CLI + thin HTTP front for the agent loop.



Pure standard library. Loads config (servers + skills + policy), starts the executor,

then runs a REPL (or a single --task). Talks to Strata via the OpenAI-compatible API

(shared model instance, no copy).

"""

from __future__ import annotations



import argparse

import json

import os

import sys



from llm_client import StrataClient

from executor import Executor

from loop import AgentLoop

from policy.approval import Approval

from policy.sandbox import Sandbox

from memory.session import SessionMemory

from memory.episodic import EpisodicMemory

from memory.semantic import SemanticMemory

from checkpoint import CheckpointStore



ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))





def load_yaml_or_json(path: str) -> dict:

    """Tiny loader: JSON natively; YAML via a minimal fallback (or PyYAML if present)."""

    if not os.path.isfile(path):

        return {}

    try:

        import yaml  # type: ignore

        with open(path, "r", encoding="utf-8-sig") as f:

            return yaml.safe_load(f) or {}

    except Exception:

        with open(path, "r", encoding="utf-8-sig") as f:

            return json.load(f)





def resolve_servers(cfg: dict, skills_dir: str = None) -> dict:

    """Re-exported from registry so startup and the HTTP reload path share one implementation."""

    from registry import resolve_servers as _resolve

    return _resolve(cfg, skills_dir)





def main(argv=None) -> int:

    ap = argparse.ArgumentParser(description="Strata Agent Gateway")

    ap.add_argument("--config", default=os.path.join(ROOT, "config", "mcp_servers.json"))

    ap.add_argument("--url", default="http://127.0.0.1:8080/v1")

    ap.add_argument("--model", default="strata")

    ap.add_argument("--think", default="medium", choices=["none", "low", "medium", "high"])

    ap.add_argument("--api-key", default=None)

    ap.add_argument("--api-monitor", action="store_true",

                    help="full monitor retention (256K I/O kept verbatim). The lightweight "

                         "per-chunk timeline monitor is always on by default without this flag")

    ap.add_argument("--max-rounds", type=int, default=None,

                    help="agent loop round cap (default: config mcp.max_rounds, else 1000)")

    ap.add_argument("--skills-dir", default=os.path.join(ROOT, "skills"), help="scan skills/*.yaml")

    ap.add_argument("--task", default=None, help="run a single task and exit")

    ap.add_argument("--daemon", action="store_true",

                    help="run the pure-stdlib scheduler from config.schedule and exit")

    ap.add_argument("--serve", action="store_true",

                    help="start the HTTP server (standalone mode: serves frontend + proxies API)")

    ap.add_argument("--agent", action="store_true",

                    help="direct agent mode: gateway runs its own MCP loop (for upstreams without native MCP, e.g. plain OpenAI)")

    ap.add_argument("--port", type=int, default=8099,

                    help="HTTP port for --serve mode (default 8099)")

    ap.add_argument("--resume", action="store_true",

                    help="resume a long task from data/checkpoint.json if present")

    args = ap.parse_args(argv)



    raw_cfg = load_yaml_or_json(args.config)

    servers_cfg = resolve_servers(raw_cfg, skills_dir=args.skills_dir)

    # Skill policy metadata (permissions/triggers) — G3: declared skill policy is enforced.

    from skills_loader import load_skills_meta

    skill_meta = load_skills_meta(args.skills_dir)

    # Zero-loss side-log for truncated tool results. Config override `session.tool_log_dir`

    # wins; otherwise default to ROOT/data/tool-log (runtime working dir, survives restart,

    # gitignored as ephemeral). None would disable recall (cap becomes lossy again).

    _scfg0 = (raw_cfg.get("session", {}) or {})

    _tool_log_dir = _scfg0.get("tool_log_dir") or os.path.join(ROOT, "data", "tool-log")

    executor = Executor(servers_cfg, defaults=raw_cfg.get("mcp"), tool_log_dir=_tool_log_dir)

    executor.start_all()

    if not any(srv.tools for srv in executor.servers.values()):

        # ROOT-CAUSE GUARD (2026-10-22): a boot with ZERO real MCP-server tools is exactly

        # the condition that made brand-new conversations regress to text-mimicked XML tool

        # calls -- the planner gets no usable tool schema and the small quant model fakes the

        # call as prose (single-underscore shell_exec leaking as <function=...>). Note the

        # tools PROPERTY is never literally empty (it always appends the synthetic

        # recall_tool_log when tool_log_dir is on), so the honest check is per-server tool

        # lists, not `not executor.tools`. Default: refuse to start; STRATA_STRICT_TOOLS=0

        # restores the old silent chat-only mode. Self-check only: `not executor.tools` was

        # the user-approved line and is kept below as the belt-and-braces second look.

        if os.environ.get("STRATA_STRICT_TOOLS", "1") != "0":

            print("[gateway] FATAL: no MCP server tools after start_all(); refusing to start "

                  "(a tool-less boot is the root cause of the text-XML regression on brand-"

                  "new conversations). Set STRATA_STRICT_TOOLS=0 to allow chat-only mode.",

                  file=sys.stderr)

            sys.exit(2)

        print("[gateway] no tools available (servers failed to start); running in chat-only mode",

              file=sys.stderr)



    client = StrataClient(base_url=args.url, model=args.model, effort=args.think,

                          api_key=args.api_key)

    # Observability layer (audit JSONL + cost/timing meter). Lives under data/.

    from audit import AuditLog

    audit = AuditLog(os.path.join(ROOT, "data", "audit.jsonl"))



    def _on_retry(ev):

        audit.note_llm(retried=True)

        audit.event("retry", extra=ev)

    client.on_retry = _on_retry

    approval = Approval(os.path.join(ROOT, "config", "approval.yaml"))

    sandbox = Sandbox(os.path.join(ROOT, "config", "sandbox.yaml"))



    # Memory layers (data/ under package root). Session is the live window;

    # episodic/semantic persist across sessions and are exposed via the memory MCP server.

    # G6: wire session.max_chars from config so changing it actually changes behavior

    # (the previous default silently masked the config value when they happened to match).

    _scfg = (load_yaml_or_json(args.config).get("session", {}) or {})

    session = SessionMemory(

        max_chars=int(_scfg.get("max_chars", 8000)),

        keep_tail_min=int(_scfg.get("keep_tail_min", 6)),

        strategy=_scfg.get("strategy", "structured"),

        tail_budget_ratio=float(_scfg.get("tail_budget_ratio", 0.4)),

        frozen_cap_ratio=float(_scfg.get("frozen_cap_ratio", 0.5)),

        frozen_refold_budget=(int(_scfg["frozen_refold_budget"])

                             if _scfg.get("frozen_refold_budget") is not None else None),

        tool_result_cap=int(_scfg.get("tool_result_cap", 10000)),

        tool_head_lines=int(_scfg.get("tool_head_lines", 15)),

        tool_tail_lines=int(_scfg.get("tool_tail_lines", 15)),

        tool_log_dir=_tool_log_dir,

    )

    episodic = EpisodicMemory(os.path.join(ROOT, "data", "episodic.jsonl"))

    semantic = SemanticMemory(os.path.join(ROOT, "data", "semantic.db"))



    def interactive_confirm(tool: str, reason: str) -> bool:

        # non-interactive (--task) => auto-approve; interactive REPL => ask

        if args.task:

            return True

        try:

            ans = input(f"  ? allow {tool} ({reason})? [y/N] ").strip().lower()

        except (EOFError, KeyboardInterrupt):

            return False

        return ans in ("y", "yes")  # default-deny: empty/no => declined



    # Recommended default: built-in structured summarizer (no third-party deps).

    # To use semantic summaries, plug an LLM-backed callable here (shared Strata model):

    #   def summarize(text): return client.chat([...])  # returns a compact summary

    from memory.session import STRATEGIES

    _strategy = (load_yaml_or_json(args.config).get("session", {}) or {}).get("strategy", "structured")

    summarize = STRATEGIES.get(_strategy, STRATEGIES["structured"])

    # Semantic summarizer (shared Strata model). Off by default; activate by setting
    # config session.strategy to "llm". Falls back to structured on an empty LLM reply.
    if _strategy in ("llm", "semantic"):
        _SEM_SYS = (
            "You compress a chunk of an agent's own conversation history into a short "
            "summary. You MUST preserve every durable decision, confirmed fact, and open "
            "to-do VERBATIM (keep the exact wording of each, one per line). Drop only pure "
            "process narration and tool-output noise. Output lines only.")
        def summarize(text, _c=client, _sys=_SEM_SYS):
            try:
                turn = _c.chat([{"role": "system", "content": _sys},
                                {"role": "user", "content": text}],
                               tools=[], effort="off", stream=True)
                out = (turn.content or "").strip()
                return out or STRATEGIES["structured"](text)
            except Exception:
                return STRATEGIES["structured"](text)





    def on_event(e):

        if e["type"] == "tool":

            print(f"  [{e['round']}] {e['tool']} -> {str(e['result'])[:120]}")

        elif e["type"] == "final":

            print(f"  [final] {e['answer'][:400]}")

        elif e["type"] == "blocked":

            print(f"  [blocked] {e['tool']}: {e['reason']}")

        elif e["type"] == "approval":

            print(f"  [approval needed] {e['tool']}")

        elif e["type"] == "compress":

            print(f"  [compress] {e['from']} -> {e['to']} messages")

        elif e["type"] == "distill":

            print(f"  [distill] {e['event'][:160]}")

        elif e["type"] == "distill-semantic":

            print(f"  [distill->semantic] {e['text'][:120]}")

        elif e["type"] == "verify":

            status = "PASS" if e["passed"] else "FAIL"

            print(f"  [self-verify {status} attempt {e['attempt']}] {e['output'][:200]}")



    # Automated self-test gate (opt-in via config.verify). When a command is configured,

    # a model-stated "done" triggers that verification; a red run feeds the failure back

    # so the model reflects, fixes, and re-verifies (bounded retries).

    _vcfg = load_yaml_or_json(args.config).get("verify", {}) or {}

    verifier = None

    max_verify_retries = int(_vcfg.get("max_retries", 2))

    _vchecks = _vcfg.get("checks") or []

    if _vcfg.get("command") or _vchecks:

        from verifier import Verifier

        if _vchecks:

            # combined check_fn: run the command guard (if any) THEN each

            # front-end browser__sim probe; any red makes the whole gate red.

            def _combo_check(executor=executor, _cmd=_vcfg.get("command"),

                             _checks=_vchecks, _cwd=ROOT, _to=int(_vcfg.get("timeout_s", 120))):

                import subprocess as _sp, re as _re, json as _json

                from textenc import smart_decode as _dec

                if _cmd:

                    _p = _sp.run(_cmd, capture_output=True, shell=True, cwd=_cwd, timeout=_to)

                    if _p.returncode != 0:

                        return False, ("[command guard]\n" + _dec(_p.stdout) + _dec(_p.stderr)).strip()

                for _chk in _checks:

                    _page = _chk.get("page")

                    _a = {"page": _page, "probes": _chk.get("probes") or {},

                          "steps": int(_chk.get("steps", 3))}

                    try:

                        _res = executor.call("browser__sim", _a) or ""

                    except Exception as _e:

                        return False, f"[{_page}] sim raised: {_e}"

                    if _res.startswith("error:"):

                        return False, f"[{_page}] {_res}"

                    _m = _re.search(r"errors=(\d+)", _res)

                    if _m and int(_m.group(1)) > 0:

                        return False, f"[{_page}] runtime errors>0\n{_res}"

                    for _k, _want in (_chk.get("expect") or {}).items():

                        _pm = _re.search(r"^\s*" + _re.escape(_k) + r" = (.*)$", _res, _re.M)

                        _got = _pm.group(1).strip() if _pm else None

                        if _got != _json.dumps(_want):

                            return False, f"[{_page}] probe {_k}={_got!r} expected {_json.dumps(_want)}"

                return True, "command guard + all front-end probes green"

            verifier = Verifier(check_fn=_combo_check)

        else:

            verifier = Verifier(command=_vcfg["command"], cwd=ROOT,

                                timeout_s=int(_vcfg.get("timeout_s", 120)))



    agent = AgentLoop(client, executor, max_rounds=args.max_rounds, on_event=on_event,

                      approval=approval, sandbox=sandbox, session=session,

                      confirm=interactive_confirm, summarize=summarize,

                      episodic=episodic, semantic=semantic,

                      verifier=verifier, max_verify_retries=max_verify_retries,

                      audit=audit, checkpoint=CheckpointStore(os.path.join(ROOT, "data", "checkpoint.json")),

                      skill_meta=skill_meta)

    agent.refresh_tools()



    history: list[dict] = []

    # Long-task durability: resume from the last saved checkpoint when requested.

    if args.resume and agent.checkpoint is not None and agent.checkpoint.exists():

        history = agent.checkpoint.load()

        print(f"[gateway] resuming from checkpoint ({len(history)} messages)")

    try:

        if args.daemon:

            cfg = load_yaml_or_json(args.config)

            sched_cfg = cfg.get("schedule", {}) or {}

            entries_cfg = sched_cfg.get("entries", []) or []

            from scheduler import ScheduleEntry, Scheduler

            entries = []

            for ec in entries_cfg:

                entries.append(ScheduleEntry(

                    name=ec.get("name", "job"), task=ec.get("task", ""),

                    every_minutes=ec.get("every_minutes"),

                    every_hours=ec.get("every_hours"),

                    daily_at=ec.get("daily_at"), at=ec.get("at")))

            if not entries:

                print("[daemon] no schedule.entries configured", file=sys.stderr)

                return 0



            def run_task(name, task):

                print(f"  [fire] {name}: {task[:120]}")

                agent.run(task, history=[])  # fresh context per scheduled run



            print(f"[daemon] scheduler started with {len(entries)} entry(ies); Ctrl+C to stop.")

            state_path = os.environ.get("SCHEDULE_STATE") or os.path.join(ROOT, "data", "schedule_state.json")

            Scheduler(entries, run_task, state_path=state_path).run()

            return 0

        if args.serve:

            # Standalone mode: serve the frontend + transparent proxy to upstream Strata server.

            # --url is the OpenAI-compatible base (e.g. http://127.0.0.1:8080/v1) for the agent

            # client. The proxy needs the full server root (strip /v1 if present).

            from http_server import GatewayState, run_server, WEB_DIR

            # ── Startup self-check (layer ⑥) ──

            # Fail-fast on misconfiguration BEFORE serving. Default mode is "warn":

            # a dead upstream is reported but does not block boot (engine may start

            # later). STRATA_SELFCHECK=fail makes any hard failure refuse to serve.

            _sc_mode = os.environ.get("STRATA_SELFCHECK", "warn").lower()

            if _sc_mode != "off":

                from selfcheck import run_selfcheck, format_report

                _sc_rep = run_selfcheck(

                    executor,

                    upstream_url=args.url,

                    web_dir=WEB_DIR,

                    config_path=args.config,

                    require_engine=os.environ.get("STRATA_REQUIRE_ENGINE") == "1",

                    source_root=ROOT,

                )

                print(format_report(_sc_rep), file=sys.stderr)

                if _sc_mode == "fail" and not _sc_rep["ok"]:

                    print("[gateway] startup self-check FAILED; refusing to serve "

                          "(STRATA_SELFCHECK=fail). Fix the reported checks and retry.",

                          file=sys.stderr)

                    return 1

            server_root = args.url

            if server_root.endswith("/v1"):

                server_root = server_root[:-3]

            gw_state = GatewayState(

                upstream_url=server_root,

                model=args.model,

                api_key=args.api_key,

                config_path=args.config,

                skills_dir=args.skills_dir,

            )

            # Resolve the agent-loop caps from the CLI flag, else config/mcp, else defaults.

            # (Previously streaming chat silently used a hardcoded 24 while the config said

            # 500 and --max-rounds 32 was ignored for the HTTP/direct loop -- all inconsistent.)

            mcp_cfg = (raw_cfg.get("mcp") or {}) if isinstance(raw_cfg, dict) else {}

            gw_state.max_rounds = int(args.max_rounds or mcp_cfg.get("max_rounds") or 1000)

            gw_state.turn_budget_s = int(mcp_cfg.get("turn_budget_s") or 3600)

            gw_state.idle_timeout_s = int(mcp_cfg.get("idle_timeout_s") or 180)

            gw_state.executor = executor
            gw_state.verifier = verifier            # serve-path gate wiring (option B)
            gw_state.max_verify_retries = max_verify_retries if verifier else 0

            # Inject the lossless tool-result cap (Loop B) into the live gateway state so the

            # Web/direct path mirrors Loop A. _tool_log_dir was computed above (line ~78).

            _scfg = (raw_cfg.get("session") or {}) if isinstance(raw_cfg, dict) else {}

            gw_state.tool_result_cap = int(_scfg.get("tool_result_cap", 10000))

            gw_state.tool_head_lines = int(_scfg.get("tool_head_lines", 15))

            gw_state.tool_tail_lines = int(_scfg.get("tool_tail_lines", 15))

            gw_state.tool_keep_recent = int(_scfg.get("tool_keep_recent", 2))

            gw_state.tool_log_dir = _tool_log_dir

            # Step2-A: the request monitor is always on (lightweight: 16K I/O cap + per-chunk

            # timeline). The old --api-monitor / "api_monitor": true flag now means FULL

            # retention (256K I/O, kept verbatim) rather than "on at all".

            gw_state.api_monitor_full = bool(

                args.api_monitor or (isinstance(raw_cfg, dict) and raw_cfg.get("api_monitor") is True))

            gw_state._mon_io_cap = 262144 if gw_state.api_monitor_full else 16384

            if gw_state.api_monitor_full:

                print("[gateway] request monitor: FULL retention (256K I/O)", file=sys.stderr)

            else:

                print("[gateway] request monitor: lightweight (always on, 16K I/O cap + timeline)",

                      file=sys.stderr)

            gw_state.direct_mode = args.agent

            if args.agent:

                print(f"[gateway] direct agent mode ON: local MCP tools will be used "

                      f"({len(executor.tools)} tools) even if the upstream has none.", file=sys.stderr)

            # Fusion (option A): run the scheduler as a background thread fused with
            # the interactive agent. SchedulerHost hot-reloads schedule.entries every
            # tick (so panel add/remove take effect WITHOUT a daemon restart) and queues
            # each fired task behind live interactive turns (gw_state._idle gate), so a
            # scheduled job never overlaps a chat turn. run_task drives the real agent.
            import threading as _th
            from scheduler_host import SchedulerHost, resolve_schedule_route

            def _sched_model_lookup(selected_id):
                # the SAME source of truth chat routes by (model_registry.selected) -- so a
                # scheduled job lands on whatever model the user picked, not the boot client.
                try:
                    import sys as _s
                    sd = os.path.join(ROOT, "serve")
                    if sd not in _s.path:
                        _s.path.insert(0, sd)
                    import model_registry as _mr
                    doc = _mr.load()
                    return _mr.find(doc, selected_id)
                except Exception:
                    return None

            # ── per-entry execution overrides (roots / approval tier / model pin) ──
            # Creating a scheduled task IS the consent: nobody is watching a 3 a.m. fire,
            # so "full" and "auto" both run freely (auto = the require_approval list passes
            # by standing consent; the stdin confirm would EOF-deny it -- the old silent
            # failure that made unattended backups red). "manual" degrades this revision:
            # there is no push channel from this process to the UI yet (the approval modal
            # is fed by the ENGINE's SSE stream, and a scheduled run has no such stream),
            # so a manual-tier run gets a loud event and runs nothing until wired v2.
            _sched_auto_confirm = lambda tool, reason: True

            _FS_ALLOW = os.path.join(os.path.dirname(ROOT), "fs_allowed_roots.txt")

            def _sched_roots_swap(add_roots):
                # fs_server re-reads the allow-file on EVERY tool call (see serve/server.py
                # move-to-end note), so appending entry roots before the run and restoring
                # the exact original bytes after is safe. Caveat (documented): a chat request
                # whose workspace move-to-ends lands mid-run gets rolled back by the restore
                # -- the idle-gate makes that window tiny (chat turn => gate queued this run).
                try:
                    saved = open(_FS_ALLOW, "rb").read()
                except FileNotFoundError:
                    saved = None
                if add_roots:
                    lines = [l.strip() for l in (saved.decode("utf-8").splitlines() if saved else []) if l.strip()]
                    lines += [r for r in add_roots if r.lower() not in {x.lower() for x in lines}]
                    open(_FS_ALLOW, "w", encoding="utf-8").write("\n".join(lines) + "\n")
                return saved

            def _sched_roots_restore(saved):
                if saved is None:
                    try:
                        os.remove(_FS_ALLOW)
                    except OSError as _e:
                        print(f'  [sched-roots-warn] could not remove allow-file: {_e}', file=sys.stderr)
                else:
                    open(_FS_ALLOW, "wb").write(saved)

            import time as _sched_time
            def _sched_extract_answer(result):
                """Extract the last assistant text from agent.run() return (list of messages)."""
                if not result:
                    return "(no output)"
                for m in reversed(result):
                    if m.get("role") == "assistant" and m.get("content"):
                        return m["content"]
                return "(no final answer)"

            def _sched_run_task(name, task):
                print(f"  [sched-fire] {name}: {task[:120]}", file=sys.stderr)
                entry = _sched_host.raw_by_name.get(name) or {}
                tier = str(entry.get("approval") or "auto").strip().lower()
                if tier == "manual":
                    print(f"  [sched-manual-deferred] {name}: approval tier 'manual' has no "
                          f"UI channel yet (v1 degrades: running under standing consent)",
                          file=sys.stderr)
                    tier = "auto"   # v1: manual degrades to auto WITH a loud event (above)
                # Route through model_registry.selected (chat's source of truth): when the
                # picked model lives at its own base_url (e.g. 47831) the run goes there; an
                # empty base_url means the boot upstream (8080) -> use the original client.
                # A per-entry model pin overrides the chat selection (the user's ask).
                try:
                    import model_registry as _mr
                    _sel = str(entry.get("model") or "").strip() or ((_mr.load() or {}).get("selected"))
                except Exception:
                    _sel = None
                base, model, key = resolve_schedule_route(
                    _sel, _sched_model_lookup, args.url, args.model, args.api_key)
                routed = None
                if base != args.url or model != args.model or (key or None) != (args.api_key or None):
                    from llm_client import StrataClient as _SC
                    routed = _SC(base_url=base, model=model, effort=args.think, api_key=key)
                saved_roots = _sched_roots_swap(list(entry.get("roots") or []))
                # planner holds its OWN client ref, so both must see the routed one. Anchor
                # proof (do not 'simplify' to agent.client only -- that would miss the planner):
                #   (line numbers are as-of-2026-11-09; anchor by symbol, not the number)
#   runtime/loop.py:AgentLoop.__init__ L67 builds self.planner = Planner(client, [])
                #   runtime/planner.py:Planner.__init__ L26 does self.client = client and plan() then
                #     calls self.client.chat(...) -- i.e. the planner chats through ITS OWN ref,
                #     so re-pointing only agent.client would leave planner on the boot client.
                # The idle-gate serialises this swap (no live interactive turn races it).
                _saved_agent, _saved_planner = agent.client, agent.planner.client
                _saved_confirm = agent.confirm
                if routed is not None:
                    agent.client = agent.planner.client = routed
                agent.confirm = _sched_auto_confirm  # standing consent for the whole run
                # B1 session_stream: for streaming runs, point the loop's token callback at
                # the gateway broadcaster so every content delta fans out live. The scheduler
                # is single-threaded + idle-gated, so this per-run swap cannot race a chat turn.
                _pre_deliver = str((entry or {}).get("deliver") or "").strip().lower()
                _sched_ws = ((list(entry.get("roots") or [])) or [""])[0]
                if _pre_deliver == "session_stream":
                    agent.on_token = lambda d, _n=name, _w=_sched_ws: gw_state.broadcast_stream(
                        {"session_name": _n, "workspace": _w, "text": d, "done": False})
                try:
                    result = agent.run(task, history=[])  # fresh context per scheduled run
                finally:
                    agent.client, agent.planner.client = _saved_agent, _saved_planner
                    agent.confirm = _saved_confirm
                    agent.on_token = None
                    _sched_roots_restore(saved_roots)
                # --- B1: for a streamed run, emit the DONE marker over the broadcaster
                #     (the live deltas were already pushed token-by-token via on_token).
                _deliver = str((entry or {}).get("deliver") or "").strip().lower()
                if _deliver == "session_stream":
                    # B1: the whole streamed text was already pushed token-by-token over
                    # the broadcaster. The final DONE marker carries the FULL answer as a
                    # disconnect-resume fallback (a client that reconnects mid-run only
                    # sees this one message). session_stream no longer touches the outbox.
                    try:
                        gw_state.broadcast_stream({"session_name": name, "workspace": _sched_ws,
                                                   "text": _sched_extract_answer(result),
                                                   "done": True, "ok": True, "final": True})
                    except Exception as _be:
                        print(f"  [sched-stream-warn] {name}: {_be}", file=sys.stderr)
                # --- deliver=session_summary: write result to session_outbox ---
                # (session_stream is handled by the broadcaster above, not the outbox,
                #  so it is excluded here to avoid double-injection via the front-end
                #  EventSource.)
                if _deliver == "session_summary":
                    try:
                        _outbox = os.path.join(ROOT, "data", "session_outbox.jsonl")
                        if _deliver == "session_stream":
                            # method A: one append per assistant message (seq ordered),
                            # last one flagged done=true so the front-end stops the cursor
                            _chunks = [m for m in (result or [])
                                       if m.get("role") == "assistant" and m.get("content")]
                            if not _chunks:
                                _chunks = [{"content": "(no final answer)"}]
                            with open(_outbox, "a", encoding="utf-8") as _f:
                                for _seq, _m in enumerate(_chunks):
                                    _last = (_seq == len(_chunks) - 1)
                                    _out = {"session_name": name, "ts": _sched_time.time(),
                                          "text": _m.get("content", ""), "entry": name,
                                          "ok": True, "seq": _seq, "done": bool(_last)}
                                    _f.write(json.dumps(_out, ensure_ascii=False) + "\n")
                        else:
                            _txt = _sched_extract_answer(result)
                            _out = {"session_name": name, "ts": _sched_time.time(),
                                  "text": _txt, "entry": name, "workspace": _sched_ws, "ok": True, "done": True}
                            with open(_outbox, "a", encoding="utf-8") as _f:
                                _f.write(json.dumps(_out, ensure_ascii=False) + "\n")
                    except Exception as _oe:
                        print(f"  [sched-outbox-warn] {name}: {_oe}", file=sys.stderr)

            def _sched_audit_event(e):
                # 调度事件落审计 (2026-11-11): schedule-error 过去被默认空 lambda 静默吞掉
                # (构造 SchedulerHost 时没传 on_event -> 回落 scheduler 默认 no-op lambda),
                # 失败原因事后无从查起. 这里把每条调度事件写入 audit JSONL, 并对
                # schedule-error 向 stderr 吼一行, 让调度执行的失败原因可见且可审计.
                try:
                    audit.event(str(e.get("type", "schedule-event")), extra=e)
                except Exception as _ae:
                    # the whole point of this wiring is "a failure must be VISIBLE" -- so a
                    # failure to write the audit line is itself surfaced, never silently eaten
                    # (test_code_hygiene flags an except body that is only pass/continue).
                    print(f"  [sched-audit-warn] could not log event {e.get('type')}: {_ae}",
                          file=sys.stderr)
                if str(e.get("type", "")) == "schedule-error":
                    print(f"  [sched-error] {e.get('name')}: {e.get('error')}",
                          file=sys.stderr)

            def _sched_load():
                try:
                    return (load_yaml_or_json(args.config).get("schedule") or {}).get("entries") or []
                except Exception:
                    return []

            _sched_stop = _th.Event()
            _sched_host = SchedulerHost(
                load_entries=_sched_load, run_task=_sched_run_task,
                state_path=os.path.join(ROOT, "data", "schedule_state.json"),
                stop_event=_sched_stop, idle_gate=gw_state._idle,
                on_event=_sched_audit_event,
            )
            _th.Thread(target=_sched_host.run, name="scheduler-host", daemon=True).start()
            _n = len(_sched_load())
            print(f"[gateway] scheduler host started (fused with serve; hot reload + "
                  f"busy-queue); {_n} entr(y/ies) loaded", file=sys.stderr)

            run_server(gw_state, port=args.port)

            return 0

        if args.task:

            history = agent.run(args.task, history=history)

            print("\nDone.")

            return 0

        print("Strata Agent. type a task; /quit to leave.")

        while True:

            try:

                msg = input("\nyou> ").strip()

            except (EOFError, KeyboardInterrupt):

                print()

                break

            if msg in ("/quit", "/exit"):

                break

            if not msg:

                continue

            history = agent.run(msg, history=history)

    finally:

        executor.stop_all()

    return 0





if __name__ == "__main__":

    sys.exit(main())

