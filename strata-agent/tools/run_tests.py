"""Single entry point for the full regression suite (the CI contract).



Runs every suite as a subprocess, aggregates, and exits 0 only when all suites are

green (or skipped). A suite that returns 0 — including its own skip path — counts as

green; any non-zero exit fails the contract. Pure stdlib.



Run from the strata-agent folder:

    python tools/run_tests.py            # FAST tier (~30s, pure-logic) = the DAILY default
    python tools/run_tests.py --full     # FULL tier: everything incl slow suites + post-green rollback (run before release)
    python tools/run_tests.py --quick    # (also valid) force the fast tier explicitly -- this is the default

"""

from __future__ import annotations



import os

import shutil

import subprocess

import sys

from concurrent.futures import ThreadPoolExecutor, as_completed



ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

sys.path.insert(0, os.path.join(ROOT, "runtime"))   # shared plan-A tiered probe (one source for every consumer)

from parallel_probe import compute as _probe_compute

PY = sys.executable

# The 91 jsdom .mjs/.js tests resolve jsdom through createRequire, which walks the
# parent chain off their hardcoded C-workspace base. On a machine with no package
# manager the only durable source is the workspace-root node_modules now tracked in
# git; NODE_PATH points every node child at it, so a fresh clone resolves jsdom with
# no home-dir copy and no injected-view coincidence (proven by the hidden-home probe).
WSROOT = os.path.dirname(ROOT)
NODE_PATH_DIR = os.path.join(WSROOT, "node_modules")



# Node for the .mjs suites. PATH first (the managed runtime exports it), then the

# known managed location as a fallback. The .mjs tests resolve jsdom via an absolute

# createRequire whose base may not exist as a real directory; NODE_PATH (set above)

# is what makes them resolve against the tracked workspace-root node_modules.

NODE = shutil.which("node") or r"C:\Users\sk\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"



# Suites in stable order. e2e / daemon are the live/optional ones; they self-skip

# (return 0) when their gate isn't met, which keeps CI deterministic.

# test_tools_tab_live.mjs is deliberately NOT here: it needs a running host.

SUITES = [

    "tests/test_smoke.py",

    "tests/test_undefined_names.py",

    "tests/test_code_hygiene.py",     # 2026-10-22: stub/swallow/todo must stay within _hygiene_baseline.json (anti-drift)

    "tests/test_skillhub.py",

    "tests/test_registry_server.py",

    "tests/test_memory_server_tools.py",

    "tests/test_policy.py",

    "tests/test_i18n.mjs",

    "tests/test_spark.mjs",
    "tests/test_md_media.mjs",   # 2026-11-11: body-typed inline media (image/video/audio/doc-card) - branch ORDER (image before link), extension probe must strip ?query/#hash, data: sniffed by MIME, animated gif/webp/apng stay on native <img>, plain link stays byte-for-byte, zero inline handlers

    "tests/test_uploads_inline.mjs",   # 2026-11-12: search-download images render inline — app.js inline() accepts a /data/uploads/ local path on BOTH replace lines + http_server routes that prefix to the real drop-point (OUTSIDE web root) + security check allows the uploads prefix; static locks + LOAD-BEARING differential (WITH branch -> <img>, CONTROL regex leaves escaped text)

    "tests/test_admin_render.mjs",

    "tests/test_stream_intel.mjs",

    "tests/test_paste_contract.mjs",   # 2026-10-24: paste/mixed-image helpers must be DEFINED and RUN (locks the "only a call site, no definition" ReferenceError bug)
    "tests/test_schedule_contract.mjs",   # 2026-11: schedule management window (plan B) -- locks the loadSchedule startup-race fix + the single-entry render path + the edit/update helpers (must be DEFINED and RUN)
    "tests/test_schedule_autorefresh.mjs",   # 2026-11: agent-tool schedule edit -> auto-refresh panel (A+B): POLL_MS/focus/visibilitychange loadSchedule + SSE schedule-changed; static + jsdom behaviour locks
    "tests/test_session_stream.mjs",   # 2026-11-11: session_stream 方案A 拼接纯函数 assembleStreamBubbles — multiple seq chunks -> ONE bubble in seq order, done from LAST, multi-session stays separate; static lock DEFINES+CALLS + jsdom behaviour.
    "tests/test_session_stream_b1.py",  # B1 offline diff: broadcaster fan-out+full-skip+unsubscribe, llm_client on_delta callback (content-only, differential no-cb), planner passthrough

    "tests/test_inline_flow.mjs",   # 2026-10-31: mixed text+image bubble keeps the typed layout (inlineFlow: single line in -> one line out)

        "tests/test_hr_regex_semantics.mjs",   # 2026-11: hr regex semantics baseline -- legal three-char hrs match; NOT ReDoS (sub-ms, no blow-up); "-----" FALSE is by-design ([\s\1] octal, not backref). Locks against a future false-ReDoS edit.

    "tests/test_memory_card_title.mjs",   # 2026-10-24: memory-card rows via .kb-source__name must carry title= so the single-line-ellipsis hover reveals the full text (esc is the necessity - differential double-probe)

    "tests/test_sidebar_tree.mjs",

    "tests/test_switch_busy.mjs",

    "tests/test_switch_busy_e2e.mjs",

    "tests/test_hidden_paint.mjs",   # 2026-11-03 gate A: hidden-page compensating paint, single-variable differential (only document.hidden differs)

    "tests/test_switchback_paint.mjs",   # 2026-11-03 gate B: switch-back immediate paint (viewed-away negative vs on-screen positive)

    "tests/test_think_dedupe.mjs",   # 2026-11-04 gate B: paintThink routes through dedupeThink (>=3 identical lines fold, <3 verbatim, differential)

    "tests/test_edit_resend.mjs",

    "tests/test_edit_modal_images.mjs",     # 2026-10-24: edit-modal scope parametrization (dim2 image -> multimodal part) + hard-delete now undoable (dim3 differential)

"tests/test_edit_modal_e2e.mjs",   # 2026-10-29: edit-modal E2E - paste image+type, delete-last-image, request side all agree after hard-delete+regenerate (locks editResend empty-list = real-delete-intent)

    "tests/test_steps_fold.mjs",        # 2026-10-20: 执行过程折叠（工具回合收纳中间段，结束自动折叠）

    "tests/test_think_segments.mjs",

    "tests/test_think_latest_open.mjs",

    "tests/test_stop_notice.mjs",

    "tests/test_turn_stats.mjs",
    "tests/test_footer_progressive_seed.mjs",   # 2026-11 plan-A: the streaming footer progressively lights send-time-known data (above all the SEED, written in send(), not a usage chunk). Static locks skeleton stat--seed span + own _seedSig anti-flicker + honest hidden-until-seed guard; jsdom differential flips ONE variable (does m.seed exist?): present -> lit with the number, absent -> stays hidden. Round-chip single-variable flip proves it still works.

    "tests/test_auto_resume.mjs",

        "tests/test_autoresume_lanes.mjs",   # 2026-11-XX: auto-resume lane gate -- A main stop reads settings.autoresumeMax (not hardcoded), B empty_round gets its own separate budget, C i18n keys both lang; extract-source differential proves load-bearing.

        "tests/test_early_done_lane.mjs",   # 2026-11: early-done lane gate (A+B) -- a closing line while the model's OWN checklist still has UNCHECKED boxes is premature, not done; new fourth lane with its own counter+budget, never borrows the main chain. Load-bearing single-variable differential (box-count flips output) + B self-check hard-constraint in BOTH langs + resume.stopped.early key both langs; extract-source anti-drift.
        "tests/test_autoresume_floor.mjs",   # 2026-11 plan-A: main-chain auto-resume must not fuse-and-hand-back after only a couple of resumes due to a stray TOO-SMALL drawer value (the root cause of the reported "ran 2 then handed back"). Added AUTO_RESUME_FLOOR=12; runtime cap and SAVE source both honour it -- below-floor falls back to the default, a manual raise at/above the floor still wins. Load-bearing single-variable differential: dirty 2 -> cap 24, right-at-floor 12 honoured, above-floor 30 honoured.

    "tests/test_auto_memory.mjs",
    "tests/test_autorules_dynamic.mjs",   # DYNAMIC gate: default-ON rules direct-write no-draft + switch-off->draft + decoupled from master
    "tests/test_autorules_i18n_jsdom.mjs",   # 2026-11-11: jsdom behaviour gate — i18n zh-CN renders s-autorules label/hint/DOM + propose end-to-end (default-ON direct-write vs switch-off draft)
    "tests/test_setdefault_button_jsdom.mjs",   # 2026-11-11: jsdom behaviour gate for the new s-setdefault button (confirm -> loadDrawer(DEFAULTS) -> auto-apply writes localStorage; cancel does not write)

    "tests/test_mem_expand_all.mjs",   # 2026-10-26: A+C landing - memExpandAll real-fn differential (expand reveals loaded body / fold hides all)

    "tests/test_expand_persist.mjs",   # 2026-10-30: expand/collapse persistence (bug-box + memory item-level, static+runtime+differential)

    "tests/test_expand_persist_e2e.mjs",   # 2026-10-30: REAL boot click->localStorage->refresh->restore round trip (the gap the static gate left open)

    "tests/test_nav_tabs_level.mjs",   # 2026-10-30: 8 top-bar tabs + 8 view panels stay same-level siblings with the aria pairing + showTab-whitelist bijection intact (guards future tab additions)

    "tests/test_proposal_card.mjs",

    "tests/test_tool_progress_label.mjs",   # 2026-10-27: tool-card title must be three-state (running/progress = neutral, ok===false = red, ok===true = result) -- locks the live-progress-shown-as-error bug from the screenshot

    "tests/test_zombie_running_finalize.mjs",   # 2026-10-27: a card left running after the turn ends must drop out of the tick scan (finalize drives 1->0); locks the zombie-card permanent-tick/accumulating-seconds bug

    "tests/test_cut_path_finalize.mjs",   # 2026-10-27: an external stream cut routed through catch must REACH finalize (no body early-return) so the zombie is finalized and the tick stops; static-locks entry->finalize has only the tick-callback return

    "tests/test_autosteps.mjs",

    "tests/test_autofix_loop.mjs",   # 2026-10-27: self-evolving fix loop — capture stamps open, push marks fixing, idle driver takes OLDEST open (anti self-feed), verified leaves the box (audit stays JSONL); differential double-probe proven

    "tests/test_bugbox_merge_stats.mjs",   # 2026-10-28: bug-box signature-merge display + 4-number stats bar + one-shot physical merge (differential double-probe, jsdom runs real renderBugBox)

    "tests/test_recycle_paging.mjs",   # 2026-10-29: recycle bin+audit default 30 rows / load-more +30 with ZERO refetch (data cached in module vars); differential pure-logic, pure-ASCII probes

    "tests/test_recycle_job_model.py",   # 2026-10-30: recycle batch-trash job model (parallel pool, sync<=3 stays sync, cancel only cancels not-yet-started, ledger lock, 404 unknown job); pure-stdlib, deterministic

    "tests/test_recycle_sel_size.mjs",   # 2026-10-30: select-size line (data-size carry, KB/MB adaptive, " . " separator, three-state selall, selall-click refreshes count+size); differential pure-logic, pure-ASCII probes

    "tests/test_card_guard_no_autodrive.mjs",   # 2026-10-23: decision card this turn -> never auto-driven (waiting for the human pick); red/blue never run
    "tests/test_arc_scrolltop_autoexpand.mjs",   # 2026-11-11: scroll-top auto-expand static lock (root=#chat-scroll load-bearing+hit calls autoExpandCard+reverse differential proves the lock is not decorative)
    "tests/test_arc_card_single_mount.mjs",   # 2026-11-11: single-card mount static lock (gate keeps ONLY st-msg--system compaction-summary; reverse differential proves it is not decorative -> triple-card fix)
    "tests/test_arc_content_system_mount.mjs",   # 2026-11-11 C-fix lock: content-only system block renders VISIBLE text (answerSpec m.text||m.content) + pointer gate drops workspace hard-cond; each POSITIVE paired with a reverse differential proving it is load-bearing

    "tests/test_compose_steps.mjs",   # 2026-10-24: click a suggestion = a decision, not a question (exec prefix + hold confirm branch)

    "tests/test_thinking.mjs",

    "tests/test_interrupted_resume.mjs",

    "tests/test_interrupt_log.mjs",

    "tests/test_stream_done.mjs",

    "tests/test_conn_cut_resume.mjs",   # 2026-10-20: transport cut == truncated, NOT fatal

    "tests/test_length_cap_resume.mjs",   # 2026-10: finish_reason=length single-round cap -> feeds the resume rail (differential)

    "tests/test_dynamic_output_cap.py", # 2026-10-20: dynamic per-round cap + fs append mode

    "tests/test_output_ceiling.py",   # 2026-10: the write-hardened 32768 ceiling is raisable from the frontend

    "tests/test_bottom_anchor.mjs",

    "tests/test_tool_timer.mjs",

    "tests/test_stats_flicker.mjs",
    "tests/test_code_copy_flicker.mjs",   # 2026-11-14 ROOT-CAUSE: a fenced code block's top-right copy button flickered WHILE generating (same family as test_stats_flicker). paintMd rewrote node.innerHTML each streaming paint, rebuilding the .st-code card + its copy button each frame (sprite <use> re-resolve + hover transition restart). Fix routes both rewrite paths through setMdHtml, which preserves each code-card HEAD by DOM identity (position + unchanged language label). jsdom DOM-identity differential: same-label repaint -> SAME button node; label-change -> fresh head allowed; multi-card keeps each head by position.

    "tests/test_seed_display.mjs",       # 2026-10-20: random seed actually used is shown + replayable

    "tests/test_nebula.mjs",

    "tests/test_compact_resume.js",



    "tests/test_compact_resume_owner.js",  # 2026-11-08: failed compaction keeps resume snapshot (C1) + finalize honors pendingCompactOwner (C2 differential)
    "tests/test_compact_resume_guard.mjs",   # 2026-11: settings.compactResume gates the post-compact auto-resume (differential G1/G2)

    "tests/test_compact_request_flag.js",   # 2026-10-20: compaction turn tagged strata_compact (guard bypass)

    "tests/test_compact_reset.py",         # 2026-10-20: reset_prompt_tokens zeroes occupancy (fixes wedged compact)

    "tests/test_chunked_compact.mjs",      # 2026-10-20: oversized history folds in bounded chunks before the single-shot compact

    "tests/test_compact_overflow_quiet.mjs",   # 2026-11-02: compact-overflow error -> ONE quiet notice, generic red toast stays quiet (differential TARGET quiet / CONTROL reports)

    "tests/test_precondense_guard.mjs",    # 2026-10-23: chain-active guard defers chunking for auto mid-task; manual/idle unchanged
    "tests/test_precondense_loopcap.mjs",  # 2026-11 loopfix: 100%-window compact re-entry capped at PRECONDENSE_MAX=2 (no 20x loop) + measured-injection budget floor (differential Q1-Q4)
    "tests/test_chunkretry.mjs",   # 2026-11 chunkretry: compact-chunk transient-contention retry (exceeded-shape ONLY, budget EXACTLY one; SSE error chunk + direct-upstream 400 both shapes; non-exceeded fails fast, no retry)
    "tests/test_safety_pad_gate.mjs",   # 2026-11 safety-pad: chunk budget must carry a SAFETY factor 0<s<1 (CJK chunks ~1 char/token vs the 1.8 estimate -> overflow -> compact 400 -> empty summary); static lock + WITH/NO-PAD differential proves the pad strictly shrinks the budget at inj=0 and inj=20k, pad magnitude 3-20%
    "tests/test_mem_chunk_compact.mjs",   # 2026-11 memchunk: realLlmCompact splits an oversized store into token-budgeted chunks and merges EACH with its own LLM call (experience ~250% of window overflowed a single call); single chunk keeps one-call behaviour; a failing chunk is kept verbatim (lossless degrade)
    "tests/test_mem_reserve_wiring.mjs",   # 2026-11 memreserve: the reply-reserve RATIO feeds the AUTO chunk budget -- bites on a small window (16384: above the 4096 reserve floor, 30%>40% strictly shrinks budget) and is inert on a 131072 window (the 12000 clamp saturates, all ratios==12000); a pinned chunk overrides the ratio; out-of-range ratios clamp to [5,50]. Boot real app.js, single-variable ratio flips.
    "tests/test_reserve_linkage.mjs",   # 2026-11 memreserve-linkage: DRAGGING the #s-memreserve slider moves the AUTO chunk budget AND the <output> text in lockstep (the oninput=outputs wiring is live), and pinning #s-memchunk>0 DISABLES+greys #s-memreserve with the budget==the pinned chunk (the ratio is bypassed); back to auto RE-ENABLES it. Real app.js jsdom-boot, real-DOM element assertions.

    "tests/test_continue_bends_send.mjs",   # 2026-11 gate A+B: a Continue-asked compaction must REACH send past the chain-active guard (single-shot flag), other autos still deferred + now-visible toast (single-variable differential drives real compactConversation)
    "tests/test_compact_target.mjs",       # 2026-10: the compression-target slider actually moves the post-compact tail budget
    "tests/test_models_ctx_window.mjs",   # 2026-11 static anchor: the 3 custom 47831 models must declare context_window=131072 (NOT the monitor default 32768); P1 value, P2 no-drift, P3 count===3

    "tests/test_stale_tab.mjs",            # 2026-10-20: stale tab detects newer server build and reloads itself once

    "tests/test_model_registry.py",

    "tests/test_gateway_http.py",

    "tests/test_session_compact.py",

    "tests/test_runtime_cap.py",

    "tests/test_tool_multimodal.py",   # 2026-10-20: streaming multimodal tool-result -> parts list

    "tests/test_system_view.py",

    "tests/test_model_forward.py",

    "tests/test_model_switcher.mjs",

    "tests/test_model_probe.mjs",

    "tests/test_runtime_config_frontend.mjs",

    "tests/test_workspace_picker.mjs",

    "tests/test_workspace_fs.py",

    "tests/test_fs_server.py",

    "tests/test_image_persist_logic.py",   # 2026-10-28: server-side image persistence (Plan A) byte round-trip data/uploads + reject non-base64/bad-mime (logic gate; live server.py not importable here)

    "tests/test_image_persist_serialize.mjs",   # 2026-10-28: real saveChat keeps base64 url when ref is empty (root cause of image loss on reload); differential A1(->ref)/B1(->url) + mixedSegments ref||url

    "tests/test_viewer_card_fit_content.mjs",   # 2026-11-03: image-viewer CARD must HUG content (width:fit-content), NOT a fixed near-full-width box -- root cause of the "extra useless empty margin around a small original" visual bug; UPPER BOUND max-width retained to cap LARGE images, object-fit:contain kept so the picture never deforms, no !important override
    "tests/test_spark_image_sanitize.mjs",   # 2026-10-28: real sanitizeHtml lets pasted spark IMAGES survive (IMG+scheme allow-list) + XSS net intact (javascript:/blob:/onerror stripped) + contenteditable paste bound; differential pair

    "tests/test_spark_image_dblclick_persist.mjs",   # 2026-10-28: post-reload ref-only image survives in the edit modal (filter+src+dblclick url||a.ref) + spark add-box/list dblclick->openImageView; static locks + real-function differential incl. text-only no-op negative
    "tests/test_bugbox_thumb_dblclick_no_fold.mjs",   # 2026-11: double-click a bugbox in-row inline thumbnail OPENS the viewer, NOT folds the row (aligns composer span self-dblclick+stopPropagation pattern). Static locks (widened dblclick guard 2nd branch + click-dispatch .ce-thumb guard ordered BEFORE the [data-bugtoggle] toggle) + jsdom load-bearing differential flips ONE variable (is the click ON the thumbnail?): control non-thumbnail row-click TOGGLES fold, target thumbnail-click does NOT. Real-function dblclick->viewer positive.

    "tests/test_ce_text_extract.mjs",   # 2026-10-29: composer/edit-area contenteditable migration helpers (ceText/ceSetText/isCE/insertPlaceholder/removePlaceholder) boot as real functions + jsdom fallbacks produce correct results; differential positive(contenteditable)/negative(real textarea keeps .value)

    "tests/test_backspace_delete_chip.mjs",   # 2026-10-29: Backspace on a focused/adjacent/selection-covered inline chip removes it AND splices the array (source-of-truth differential, core invariant locked)

    "tests/test_chip_text_rescue.mjs",   # 2026-10-30: caret-dropped text inside a chip survives removeThumb; delete keeps text, delete button pins to fixed image via box wrapper

    "tests/test_wire_image_url.mjs",   # 2026-10-31: OUTBOUND image wire format must stay a data URL on BOTH routes (anchor mixedSegments + fallback imgs.map) via one shared helper wireImageUrl; locks the ref-drop bug (engine got relative uploads/ path and dropped the image); differential positive(url+ref->data)/negative(ref-only->ref)

    "tests/test_question_key_contenteditable.mjs",   # 2026-11-02: Shift+/ (the ? key) must TYPE inside every contenteditable input (edit-area/spark-add-input/spark-edit-ta); the global ? shortcut guard exemption now ALSO calls isCE(); static lock on the broadened exemption + runtime differential isCE true on the 3 shapes / false on a plain div (shortcut preserved)

    "tests/test_pill_closeout_align.mjs",   # 2026-11-02: close-out window pill TEXT aligns with its icon NOW via setPill when a turn finished cleanly
    "tests/test_engine_waterline.mjs",   # 2026-11-02: Plan B - inspector engine-waterline sub-row toggles with the gateway-proxied /api/monitor (available shows Engine pool pct; null and available:false hide it; reversible). Locks the two-denominators fix (per-session bar vs shared KV pool).

    "tests/test_spark_datapid_anchor.mjs",   # 2026-11-01: ROOT-CAUSE A gate (real app.js jsdom-boot, not a hand-stub): a spark whose image node is a BARE img (valid src, NO data-pid) -> sparkToPush images=[] -> bubble text-only while the LIST innerHTML still shows it; data-pid present -> images=1. Locks the "list shows, bubble drops" phenomenon and guards against a sparkToPush that stops requiring the data-pid anchor.

    "tests/test_spark_datapid_migrate.mjs",   # 2026-11-01: ROOT-CAUSE A migration gate (direction 1) — migrateSparkDataPid() adds the missing data-pid anchor to a bare-img historical note; differential PRE(bare->images=[] bug)/POST(after migrate->images=1) + IDEMPOTENT (re-migrate changes 0, anchor count stays 1). Real app.js jsdom-boot.

    "tests/test_spark_thumb_delete.mjs",   # 2026-11-01: ROOT-CAUSE spark thumbnail delete — bindInlineThumbDelete() wires click delegation only onto composer #input + chat-modal #edit-area, NOT onto the three spark containers (spark-add-input/spark-edit-ta/spark-list), so a spark note inline delete button never reaches removeThumb (array stays spliced-only on composer path). Differential COMPOSER(click->array spliced, delegation fires)/SPARK(delegation NOT wired = the bug) + static source locks. Real app.js jsdom-boot.

    "tests/test_spark_thumb_src.mjs",   # 2026-11-02: ROOT-CAUSE spark thumbnail BROKEN IMAGE pin -- REAL sanitizeHtml (gate jsdom-boot) feeds 3 src shapes: data URL SURVIVES, absolute /data/uploads/ SURVIVES, OLD relative uploads/ (no leading slash) STRIPPED = the only broken-image path (historical data only); data URL survives so a still-broken note is a legacy relative-src note.

    "tests/test_spark_thumb_icon.mjs",   # 2026-11-02: POST-FIX behavior gate -- delete-button icon href web/sprite.svg#i-trash now SURVIVES sanitizeHtml (REAL icon()+sanitizeHtml jsdom-boot); control bare # survives; XSS off-site href STILL stripped.

    "tests/test_spark_image_only_save.mjs",   # 2026-11-03: a spark note with ONLY images (no text) now SAVES -- root cause: save handler derives text via sparkHtmlToText(html), which returns "" for a pure-image body, so addSpark's old guard "if(!text) return false" rejected it; fix hoists sanitizeHtml above the guard and widens accept to text-non-empty OR sanitized-HTML-carries-an-img-with-a-surviving-src; dangerous javascript:/blob: pure-image stays REJECTED (XSS net intact); differential proves a TRULY empty text is saved by the helper branch
    "tests/test_paste_pending_gate.mjs",   # 2026-11: a send/confirmEdit fired the INSTANT you paste must not read the body as empty and bail -- paste lands DOM+array via pendingPastes gate, send/confirmEdit await it BEFORE the empty-guard (differential: paste-no-text+instant-send lands an image WITH the await, sends NOTHING without it = load-bearing)
    "tests/test_paste_multipaste_race.mjs",   # 2026-11-11: paste 2+ images lands ALL not just the first — FileReader onloads fire CONCURRENTLY, shared caret collides, the 2nd chip lands OUTSIDE composer and reconcileArray drops it. Fix serializes when files.length>1 (single stays non-blocking). Load-bearing single-variable differential (serialize flips kept 1->2) + static locks.

    # These three guard "which directory do relative paths resolve against". They existed

    # but were never registered, so the 2026-10-20 wrong-base bug shipped green.

    "tests/test_fs_workspace_base.py",

    "tests/test_shell_workspace_cwd.py",

    "tests/test_workspace_base.py",

    "tests/test_browser.py",

    "tests/test_browser_fallback.py",   # 2026-10-20: VTB hang -> --timeout capture policy

    "tests/test_page_sim.py",           # 2026-10-20: deterministic page sandbox (browser__sim)

    "tests/test_thinking_budget.mjs",   # 2026-10-20: 低/中/高 carry reasoning_budget_tokens; 跟随模型 omits both

    "tests/test_nextsteps_group.mjs",   # 2026-10-20: 推荐建议置顶 + 「推荐」徽标 + 绿/灰双色分组

    "tests/test_proposal_tier.mjs",     # 2026-10-20: 决策卡推荐选项绿档 + 推荐徽标 + 主/幽灵按钮分档

    "tests/test_suggestion_tiers.mjs",  # 2026-10-20: 建议三档（推荐/可选/不推荐）解析+渲染+proposal+i18n

    "tests/test_format_fence_differential.mjs",  # 2026-10-23: FORMAT-ROOT-CAUSE differential gate (inline-mention->0 chips vs standalone fence->4 chips, four tier groups)

    "tests/test_closeout_backstop.mjs",   # 2026-11-02: closing-out backstop (B mechanism) -- all-ticked plan OR live decision card + empty steps -> minimal reminder visible; plain empty stays hidden (keeps hidden-on-empty gates green); differential A/B/C/D + i18n pair

    "tests/test_steps_custom_label.mjs",   # 2026-11-02 gate (pasted-bubble fix): picked chips + typed text -> send label MUST carry the custom marker and the live .next-steps__custom preview shows it; empty composer stays plain count; compositionend/paste fallback + i18n pair locked (jsdom boots REAL syncStepsSendLabel)

    "tests/test_closeout_pixel.py",   # 2026-11-02: PIXEL-layer backstop for the B mechanism -- jsdom renders real DOM, REAL Edge reads a computed-style probe + PNG; A/C reminder visible, B control blank (differential, pixel truth not jsdom); writes tools/baseline/ anchor; skips if no renderable browser

    "tests/test_visual_http_render.py",   # 2026-11-12: http:// REAL-RENDER pixel gate (fixes the file:// black-screenshot blindspot) -- serves a TEMP doc-root over http (so relative CSS CAN resolve), two BYTE-IDENTICAL fixture pages differing ONLY by directory: GOOD at doc-root paints (CSS var resolves), the SAME page under web/ goes BLACK (relative tokens.css -> web/web/ 404) + a link-stripped load-bearing control also black; pure-stdlib PNG pixel differential; writes tools/baseline/ anchors; skips if no renderable browser

    "tools/_sandbox_write_guard.py",   # 2026-11-02: static guard for the filesystem__write sandbox boundary -- alerts when a gate script writes an absolute path OUTSIDE the allowed roots THROUGH the tool layer (probe/temp must be script-self-written, in-root); differential POS/NEG load-bearing + ratchet baseline for known scratch; pure-stdlib, deterministic

    "tests/test_code_style.mjs",        # 2026-10-20: 代码块语法高亮 + 思考区围栏渲染成真代码卡片

    "tests/test_shell_timeout.py",

    "tests/test_shell_utf8_trim.py",   # 2026-10-26: shell output byte-boundary UTF-8 trim (no mojibake)
    "tests/test_self_suicide_guard.py",   # 2026-11-08: shell_server self-suicide guard -- kill of OUR OWN ancestry must go detached (CIM walk proven, Toolhelp32 lists empty here); differential POS(refuse)/NEG(allow) + parse + call_tool-wiring-before-exec lock

    "tests/test_agent_loop.py",

    "tests/test_hallucinated_resume.py",   # 2026-10-25: http_server-chain plan-action resume; registers an already-green test this refactor touches (was orphaned)

    "tests/test_loop_finalize_resume.py",  # 2026-10-25: loop.py finalize-branch resume (the 8099 agent chain), driven through the real AgentLoop + shared toolcall_parse discriminators
    "tests/test_loop_none_maxrounds.py",  # 2026-11-11: loop.py run() opens range(1, max_rounds+1) and must tolerate None -- the scheduled agent-turn crash (dynamic + static + differential lock)

    "tests/test_turn_budget.py",

    "tests/test_empty_round.py",

    "tests/test_empty_round_e2e.py",   # 2026-10-31: plan-A nudge guard REAL subprocess + REAL HTTP (fake upstream feeds round1-thinking / round2-answer); closes the last mile test_empty_round could only prove at the contract layer (falsifiable: upstream hit 2x + nudge user-turn + streak=1 diag)

    "tests/test_turn_guard.py",

    "tests/test_narration_guard.py",

    "tests/test_adversarial_llm.py",

    "tests/test_toolcall_fuzz.py",

    "tests/test_stream_clean.py",

    "tests/test_scan_session.py",

    # New layering (2026-10-20): ⑥ startup self-check, ④ behavior judge, ② soak

    "tests/test_startup_selfcheck.py",

    "tests/test_behavior_judge.py",

    "tests/test_behavior_judge_llm.py",

    "tests/test_soak.py",

    "tests/test_soak_live.py",

    "tests/test_user_scenarios.py",

    "tests/test_async_judge.py",

    "tests/test_executor.py",

    "tests/test_e2e.py",

    "tests/test_daemon.py",
    "tests/test_scheduler_host.py",   # 2026-11 fusion gate A: scheduler host hot-reload + busy-queue (offline)
    "tests/test_scheduler_host_differential.py",   # 2026-11 differential lock: each of 4 mutations (host-e/f/g/h) turns its real host lock red -> proves the locks are load-bearing, not a vacuous green

    "tests/test_corpus.py",

    "tools/_seg_scroll_baseline.py",

    "tools/_semantic_summarizer_gate.py",   # live-gate: LLM semantic summarizer >= keyword on decision survival (self-skips if upstream down)

    "tools/_archive_gate.py",   # deterministic gate: archive write/read zero-loss + whitelist N=3 + default-on (locks the recoverable-archive design)
    "tools/_autorules_gate.py",  # locks default-ON per-store rules switch + routing + i18n parity (differential-proved)

    "tests/test_ctx_denominator.py",   # 2026-10: the gateway denominator == the engine's real n_ctx (no 128K-vs-256K split)
    "tests/test_ctxspark_bars.mjs",   # 2026-11 bar-chart guardrail: ctxSpark draws one <rect> PER TURN (not a polyline), every coord round-aligned to the pixel grid, width auto-shrinks with count, last bar highlighted, tier colours are the 3 existing tokens only. Real app.js jsdom-boot, differential proves the locks are load-bearing.
    "tests/test_sparkfreeze_setting.mjs",   # 2026-11-13: SPARK_FREEZE_N is now a settings-page slider (default 10). Load-bearing single-variable differential: settings.sparkFreezeN MOVES the frozen count; slice(-0) guard (0=keep none); default fallback to 10; end-to-end divider geometry. Real app.js jsdom-boot.
    "tests/test_sparkmax_setting.mjs",   # 2026-11-13: SPARK_MAX_BARS is now a settings-page slider (default 24). Load-bearing single-variable differential: settings.sparkMaxBars MOVES the drawn-bar count (8 -> 8, 12 -> 12, 24 -> 24 on the SAME 40-bar input); cap-above-length shows all; default fallback 24; below-cap boundary guard. Real app.js jsdom-boot.

    "tests/test_resident_retry.py",   # 2026-10-24: resident-contention vs true-overflow split (quiet retry, budget is one)

    "tests/test_vision_degrade.py",  # 2026-10-31: [VISION-DEGRADE] pure-helper grab: image->text placeholder + narrow vision-failure predicate (pos/neg differential)

    "tests/test_websearch_download_naming.py",   # 2026-11: download naming priority name>query(keeps language)>url-basename + ext whitelist/sanitize; calls the REAL _call_download with fetch/GC stubbed (no network)
    "tests/test_websearch_brand_trap.py",   # 2026-11 brand-trap: a pinyin/romanized query that collides with a REGISTERED brand (Baize->BIAZE) gets an ASCII guide appended telling the operator to use the native script/qualifier; deterministic (no network), calls the REAL call_tool->_call_images with _images_pass stubbed

    "tools/_single_source_gate.py",   # 2026-10-25: after parasite(8080) retirement serve/web is the ONLY frontend source; locks source clean of the 4 parasite scripts + archive reversible (replaces the now-dead mirror-parity gate)
    "tools/_mirror_rehearse_gate.py",   # 2026-11-09 mirror-rehearse: the cross-drive mirror runs the SAME clone rehearsal against the F-side bundle; this gate drives rehearse_from_bundle() through a LOAD-BEARING differential (POS good bundle -> red 0; NEG wrong head/count/tags -> red>0; NEG missing bundle -> clone-fail branch) WITHOUT touching the real F: drive (rehearses a temp bundle, CI-safe)

    "tests/test_parallel_probe.py",   # 2026-10-30: plan-A tiered probe lands; locks this machine reproduces tests=7/recycle=4/batch=8 + differential (factors/caps MOVE the numbers) + env override highest

    "tools/_orphan_chain_gate.py",   # 2026-11-02: post-green hook leaves HEAD detached -> a pure-doc register commit lands on it as an ORPHAN (master unmoved); live probe locks HEAD==master-tip on-branch, differential builds a REAL orphan and proves the predicate catches it (red on the drift)

    "tools/_flash_probe_upstream.py",   # flash-crash MAIN-CHANNEL gate: real subprocess gateway + fake slow-SSE upstream; node client mirrors fetch->reader->abort; falsifiable P1(forwarded)/P2(AbortError->m.stopped=true)/P3(upstream saw disconnect); all three must light green

    "tests/test_monitor_custom_api_landing.py",   # 2026-11-05: custom-API monitor landing (A1 tok-tuple / A2 duration_s read-key / A3 est-vs-real decode / A4 declared window / B5 stream_options / C6 i18n), differential gate
]





# Tiered split (2026-11-12 plan-C): the CI contract default stays FULL.
# --quick runs the pure-logic tier only (skip the measured-slow suites below),
# giving a ~10s wall instead of ~60s. The slow list is DATA-DRIVEN (measured
# per-suite wall on this machine 2026-11-12, threshold >=3.0s), not name-guessed.
SLOW_SUITES = [
    "tests/test_gateway_http.py",
    "tests/test_auto_resume.mjs",
    "tools/_semantic_summarizer_gate.py",
    "tests/test_daemon.py",
    "tests/test_compact_overflow_quiet.mjs",
    "tests/test_soak_live.py",
    "tests/test_browser.py",
    "tests/test_self_suicide_guard.py",
    "tests/test_shell_timeout.py",
    "tests/test_closeout_pixel.py",
    "tests/test_visual_http_render.py",   # real Edge cold launch (http-served doc-root) -> slow tier
    "tests/test_chunked_compact.mjs",
    "tests/test_paste_pending_gate.mjs",
    "tests/test_model_forward.py",
    "tests/test_hidden_paint.mjs",
    "tests/test_mem_chunk_compact.mjs",
    "tests/test_startup_selfcheck.py",
    "tests/test_model_probe.mjs",
    "tests/test_stale_tab.mjs",
    "tests/test_empty_round_e2e.py",
]
_SLOWSET = set(SLOW_SUITES)
SUITES_QUICK = [s for s in SUITES if s not in _SLOWSET]

# Isolation lane (2026-11-12): timing-sensitive suites that CPU contention can flake
# under the 7-worker pool. They run ONE AT A TIME after the pool drains, so a normal
# --full run stays honest green instead of throwing a spurious red on contention.
# Membership is a MEASURED flake (test_self_suicide_guard flakes under contention,
# runs 16/16 green solo) -- not name-guessing.
SERIAL_ONLY = [
    "tests/test_self_suicide_guard.py",   # LIVE process-tree/CIM-walk probe: flakes under CPU contention
]
_SERIALSET = set(SERIAL_ONLY)


def run_suite(rel: str) -> tuple[bool, str]:

    """Return (passed, summary_line). Exit code 0 == green (skip counts as green)."""

    p = os.path.join(ROOT, rel)

    is_node = rel.endswith((".mjs", ".js"))
    cmd = [NODE if is_node else PY, p]
    env = dict(os.environ)
    if is_node:
        env["NODE_PATH"] = NODE_PATH_DIR

    try:

        out = subprocess.run(cmd, capture_output=True, text=True,

                             timeout=300, cwd=ROOT, env=env)

    except Exception as e:

        return False, f"{rel}: could not run: {e}"

    combined = ((out.stdout or "") + ("\n[stderr]\n" + out.stderr if out.stderr else "")).strip()

    last = combined.splitlines()[-1] if combined else ""

    return out.returncode == 0, f"{rel}: {last}"





def main(argv=None) -> int:
    import argparse
    _ap = argparse.ArgumentParser(description="Regression suite runner (plan-C tiered)")
    _ap.add_argument("--quick", action="store_true",
                     help="fast tier: pure-logic only (the DAILY default)")
    _ap.add_argument("--full", action="store_true",
                     help="full tier: everything incl slow suites + post-green rollback (run before release)")
    _a = _ap.parse_args(argv)
    _mode = "full" if _a.full else "quick"
    _suites = SUITES_QUICK if _mode == "quick" else SUITES
    print("[tier] %s  (%d suites)" % (_mode, len(_suites)))

    # 2026-10-27: run the suites concurrently (bounded pool, results kept by index so

    # the printed order is unchanged). Default 4 workers, not the full core count --

    # a few suites are timing-sensitive and CPU contention can flake them. Override with

    # STRATA_TESTS_WORKERS; STRATA_TESTS_SERIAL=1 forces back to the old serial path.

    if os.environ.get("STRATA_TESTS_SERIAL") == "1":

        workers = 1

    else:

        workers = _probe_compute("tests")   # floor(cores*0.6) cap16; STRATA_TESTS_WORKERS env override wins (probe handles it)

    results = [None] * len(_suites)

    if workers <= 1:

        for i, s in enumerate(_suites):

            ok, line = run_suite(s)

            results[i] = (s, ok, line)

    else:

        parallel_idx = [i for i, s in enumerate(_suites) if s not in _SERIALSET]

        with ThreadPoolExecutor(max_workers=workers) as ex:

            futs = {ex.submit(run_suite, _suites[i]): i for i in parallel_idx}

            for fut in as_completed(futs):

                ok, line = fut.result()

                results[futs[fut]] = (_suites[futs[fut]], ok, line)

        # isolation lane: SERIAL_ONLY suites run one at a time AFTER the pool

        # drains; land results on their ORIGINAL index so printed order is unchanged.

        for i, s in enumerate(_suites):

            if s in _SERIALSET:

                results[i] = (s,) + run_suite(s)

    for s, ok, line in results:

        print(line)

    print("---- regression summary ----")

    all_ok = all(ok for _, ok, _ in results)

    for _, ok, line in results:

        print(("PASS " if ok else "FAIL ") + line)

    print("REGRESSION: " + ("ALL GREEN" if all_ok else "RED — contract broken"))



    # Post-green hook (2026-10-22): once the whole suite is green, auto-run the

    # rollback verify against the latest milestone tag. --no-nest so it does NOT

    # spawn another full suite (recursion guard). This is the green->tag->anchor

    # loop's live check; a failure here turns the run red.

    if all_ok and _mode == "full":
        rv = os.path.join(ROOT, "tools", "_rollback_verify.py")

        try:

            r = subprocess.run([PY, rv, "--no-nest"], capture_output=True,

                               text=True, timeout=120, cwd=ROOT)

            out = ((r.stdout or "") + ("\n[stderr]\n" + r.stderr if r.stderr else "")).strip()

            print("---- post-green rollback verify ----")

            print(out)

            all_ok = (r.returncode == 0)

        except Exception as e:

            print("---- post-green rollback verify ----")

            print("could not run rollback verify: %s" % e)

            all_ok = False

        print("REGRESSION (incl. post-green): " + ("ALL GREEN" if all_ok else "RED — contract broken"))



    return 0 if all_ok else 1





if __name__ == "__main__":

    sys.exit(main())

