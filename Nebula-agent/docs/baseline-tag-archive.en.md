# Baseline Tag Archive

> [简体中文](baseline-tag-archive.md) | **English**

This file registers the annotated `v-baseline-*` tags that have been **cleaned up after being
superseded by a later baseline**, recording the commit each pointed to, so any can be rebuilt exactly
at any time. The criterion: every commit a deleted tag pointed to is an ancestor of HEAD (master)
(confirmed one by one with `git merge-base --is-ancestor`), so deleting the tag **loses no commit** —
the master chain already contains them; a tag is only a named pointer, rebuildable with the commands
below. The old bundles (keeping the newest 14 each on the E/F drives) also contain these tags, so
cloning an old bundle can also restore them.

## Current rollback point (overview · this section is authoritative)

> The current latest rollback point is `v-baseline-2026-11-26-f`
> (commit `c1680a0271c5ba8fe1a97c5d807d8185a0baa24f`, the atomic rollback point of the askConfirm focus-trap + B5 a11y gate: c1680a0 (app.js native confirm fully migrated to askConfirm + remembers opener on open / Tab and Shift+Tab kept inside the dialog / focus restored to opener on close, WCAG 2.4.3 + the B5 block in test_ask_confirm_jsdom.mjs asserting Tab-stays-inside and activeElement===opener after close); feature code and its regression lock amended into one atomic commit; full --full regression ALL GREEN (RC=0, no flaky). Note: the tag was cut under the true date 2026-11-26, continuing after a/b/c/d as the atomic rollback point of feature commit c1680a0).
> The "current rollback point / current latest rollback point" wording in each section heading below is a point-in-time snapshot from when that tag was cut (11-21-i, 11-22-d, 11-23-c, 11-24-f, 11-25-n/o/p/q/r/s/t/u, 11-26-a/b/c/d/f … each was the newest baseline at its time); wherever it disagrees with this overview, this (newest = 11-26-f) section wins.

## 2026-11-21 series cleanup (keep -h = the v0.1.0 current rollback point)

On 2026-11-21 eight all-green milestone tags a~h were cut densely, forming a linear chain; `-h`
(HEAD 93e4727, the v0.1.0 corner-stamp finalization point) is kept as that day's latest representative
and the current rollback point; a~g are older points superseded by a later baseline, and are cleaned up.

| deleted tag | pointed commit | same-day semantics |
|---|---|---|
| v-baseline-2026-11-21-a | 99cdc009d03fd4043e29631b4243037dc8d4d2c5 | sidebar all-hidden 回归修复（decouple sidebarTabs from sampling） |
| v-baseline-2026-11-21-b | b7e338c43b00e9e0abbb31dea241e5af25e4063b | watchdog xplat register + content=None wire normalize |
| v-baseline-2026-11-21-c | bd12c55fac31e73079a95912a895d925898f90d9 | watchdog 8099 relaunch interval 10s->5s |
| v-baseline-2026-11-21-d | b0cd5b6e2822a3485028c7863b94351890b6e758 | CHECK_INTERVAL==5 pinned in watchdog gate |
| v-baseline-2026-11-21-e | 041a3e904ae2e2caecd631ce7b3a71107f08d55a | fs_allowed_roots 3 dirs landed from stale stash@1 |
| v-baseline-2026-11-21-f | 31ddbbd1335beb109d737a7f56832af2991dc21b | workspace tail-drop + reset-order |
| v-baseline-2026-11-21-g | 72d7ac21bf608d1f5a5e26567e4eabd7e2d4680b | review_semantic_log trend_n=30（term1 bundle 固化） |

## Rebuild commands (to restore a cleaned-up tag)

```bat
git tag -a v-baseline-2026-11-21-a 99cdc009d03fd4043e29631b4243037dc8d4d2c5 -m "baseline rollback point @99cdc00: sidebar all-hidden regression fix + gate G root-cause lock"
git tag -a v-baseline-2026-11-21-b b7e338c43b00e9e0abbb31dea241e5af25e4063b -m "baseline: watchdog xplat register + content=None wire normalize chain"
git tag -a v-baseline-2026-11-21-c bd12c55fac31e73079a95912a895d925898f90d9 -m "baseline: watchdog 8099 relaunch interval 10s->5s"
git tag -a v-baseline-2026-11-21-d b0cd5b6e2822a3485028c7863b94351890b6e758 -m "baseline: CHECK_INTERVAL==5 pinned in watchdog gate"
git tag -a v-baseline-2026-11-21-e 041a3e904ae2e2caecd631ce7b3a71107f08d55a -m "baseline: fs_allowed_roots 3 dirs landed from stale stash@1"
git tag -a v-baseline-2026-11-21-f 31ddbbd1335beb109d737a7f56832af2991dc21b -m "baseline: workspace tail-drop + reset-order"
git tag -a v-baseline-2026-11-21-g 72d7ac21bf608d1f5a5e26567e4eabd7e2d4680b -m "baseline rollback point: review_semantic_log trend_n=30 (term1 bundle)"
```


## 2026-11-21 batch cleanup: the 2026-10-22 ~ 2026-11-20 early series (keep -i and the non-ancestor 11-02-f)

The criterion: every commit a deleted tag pointed to is an ancestor of HEAD (master) (confirmed
anc=0 tag by tag with `merge-base --is-ancestor`); deleting the tags loses no commit. The newest
rollback point `v-baseline-2026-11-21-i` and the non-ancestor `v-baseline-2026-11-02-f` (deleting it
would lose a commit) are kept.

### Kept (not deleted)

- `v-baseline-2026-11-21-i` -> 7634820... (current rollback point, newest baseline on the HEAD chain)
- `v-baseline-2026-11-02-f` -> fc8ffd5fafe4ec628779ce5476e06ec37314a5ec (**not a HEAD ancestor**;
  deleting it would lose a commit, so it is kept): docs(rules): land this-round two propose-rules
  after verification (no unicode_escape in path normalization; static guards must pass differential
  self-proof before SUITES, ratchet baseline for known hits) - pure-doc, off-anchor

### Cleaned up (97, rebuild commands below)

```bat
git tag -a v-baseline-2026-10-22 ede2a36d5d8991d0b726f5bea117eefa81f215b8 -m "README: add scratch-hygiene clause to repo-convention section (root tools\ = pure scratch, per-file delete, never broad glob, never cross-dir)"
git tag -a v-baseline-2026-10-22-b 79861f7a968cea0163ca372fb0ef1c7f83c47522 -m "run_tests: post-green hook auto-runs _rollback_verify --no-nest on latest tag (recursion-guarded); _rollback_verify: parameterize --tag + --no-nest"
git tag -a v-baseline-2026-10-22-c 00bb0fd2d41f22561b9891356bd1d6acce5600d4 -m "config: runtime model selection drift committed separately (selected=swift-1.5-iq2_xs promoted, iq3-xxs kept as alternate; not part of the pagesim decision)"
git tag -a v-baseline-2026-10-23 e7dc6173105bba4cfc738d890dbb802098f67f05 -m "docs+rules: i18n two-state preview reuses existing keys (zero new = key-count gate holds); observation anchors referenced by README are promoted to tracked assets"
git tag -a v-baseline-2026-10-23-b 9267663152a75c393f2cafc6299f721bf6f483ff -m "ui: B1 two-state preview for the recommended-only autosteps checkbox (data-i18n phrases + data-state CSS, differential test)"
git tag -a v-baseline-2026-10-23-c 01ef8553f88318db8d97fdefb777478fb9c7a5b2 -m "feat(next-steps): 四档颜色即决定 + 退役勾选框"
git tag -a v-baseline-2026-10-23-d 21ccb8b5d01517708b98bea2ab1b0b4c01ee0abd -m "feat(prompt): next-steps 建议条数软约定放宽 2-4 -> 2-5"
git tag -a v-baseline-2026-10-23-e 18f1bef2a57284e45236705e39deb7294d423bd6 -m "rules+knowledge: land this session's memory entries (deploy_frontend.py /MIR semantics, mirror MD5 state, uncommitted-memory-entries follow-up)"
git tag -a v-baseline-2026-10-23-f b36dd700c4cba945211ca8ed99fb74f2cdb959ed -m "feat(gates): promote mirror-parity reconciliation to a permanent gate (tools/_mirror_parity_gate.py) and register it in run_tests SUITES -- locks the deploy rule that the parasite mirror must be byte-identical to serve/web (self-skips if the mirror folder is absent, no false red)"
git tag -a v-baseline-2026-10-23-g 11dd9bcd8154e1a06332e885c93baaea4e401cd1 -m "feat(frontend): decision card this turn = never auto-driven (human-pick guard, approved 2026-10-23); retired rule 'card turn ships no chips' -> card turn still ships all tiers, guard stops only the automatic run; aligned system-prompt wording; new differential contract test test_card_guard_no_autodrive registered in SUITES"
git tag -a v-baseline-2026-10-24 fe32948c4c49e7ada64768aef0019478e1a01dfa -m "feat(web): finish_reason=length feeds the auto-resume rail (Plan-A gap closed)"
git tag -a v-baseline-2026-10-24-b 7bbc4b7c2a8753b7d380471bf38f98bbd4c229ee -m "config: add local model entries swift-iq3_xxs and swift-iq3_s"
git tag -a v-baseline-2026-10-24-c a7e55faac3484faafcc0296b7b35e0539700ee92 -m "docs(README): advance gate anchors to v-baseline-2026-10-24-b + register this round (pure-doc, does not itself advance anchor)"
git tag -a v-baseline-2026-10-24-d e8b4244aeffd2a11eeee5291b4d150a12189284b -m "feat(rollback_verify): default-inject STRATA_MAX_OUTPUT_CEILING=32768 so the no-env false-red path is dodged (setdefault keeps explicit env authority)"
git tag -a v-baseline-2026-10-24-e 181b90c07d80703e372b325a8d6394c892a258c1 -m "feat(resident-retry): split a SHARED-pool 400 from a true window overflow - quiet one-resend then honest contention wording; differential gate registered (panel-53%% report)"
git tag -a v-baseline-2026-10-24-f 2223e46ae0b7cfe984c8780412e2120e31e2e483 -m "feat(rescue): map a bare server prefix back to its tool when that server exposes exactly one tool (no guessing); multi-tool servers stay prose; hallucinated_tool_call kept consistent via the same prefix map, differential fuzz test extended (15 checks)"
git tag -a v-baseline-2026-10-24-g 9a3ceefe5b122487c7f041343fe2d271b3803048 -m "feat: add undo toast to batchDelete (mirror new-btn pattern), reword delconfirm for undo"
git tag -a v-baseline-2026-10-25 94a42e2470bf0c57ddd8518f820c4a3bcb4514a5 -m "chore: track persistent restart-8099 ps1 so the tree is clean for the post-green gate"
git tag -a v-baseline-2026-10-25-b 71c4b8c611413109d808f016466fe99af56fe092 -m "feat: plan panel shows a complete-badge when fully ticked (symmetric to the close-out reminder); widen memory-card name to wrap (plan-A, gate flipped to lock the widening); + this-round rules landed"
git tag -a v-baseline-2026-10-25-c bed81ff4e44362a2641931290ae179cb5db81a47 -m "chore(css): land prior css anchor leftover (morebtn/opacity), already deployed and mirror-parity green"
git tag -a v-baseline-2026-10-25-d 1a0345d4a444308f2228f0ae50e062824abbcffb -m "test: replace dead mirror-parity gate with single-source gate after parasite retirement"
git tag -a v-baseline-2026-10-25-e 1070e8fb3724d0c4efd170dc8b7a0673030f2bec -m "feat(autosteps): recommended-only toggle drives the filter (default ON = green only, OFF = green+normal); wire loadDrawer/saveSettings/onclick+sub-checkbox, flip T6 differential"
git tag -a v-baseline-2026-10-25-f ff44bd4902b0065dbd7c9041f4abb69154ed18d9 -m "feat(sidebar): allow task ops while another task runs - batchDelete only blocks when the running task is in the selection, new-task-btn/newTaskInWorkspace allowed busy (reference handoff + composer send guard prevents running the new task until the current finishes); new-btn (clear current) stays blocked; i18n reused (no new keys); +T8 differential lock"
git tag -a v-baseline-2026-10-25-g b90402508597ccdd2c5d758fe80ab863f3401d14 -m "chore(config): land runtime model-select drift (iq3-s -> ixxs) so tree is clean for post-green; run-state not this rounds code change"
git tag -a v-baseline-2026-10-27-a e87a1d6ad34e64a2cb26b15a02027f5bebbbd842 -m "fix(mcp-base)+perf(run_tests): graceful exit on dead pipe (A); concurrent suite pool (B)"
git tag -a v-baseline-2026-10-27-b a9e43c6df6cdcca30b2b0238736ecfb9d27ea881 -m "fix(app.js)+test: tool-card title three-state (A+B) - running/progress neutral, ok===false red, ok===true result; new differential gate locks the live-progress-shown-as-error bug"
git tag -a v-baseline-2026-10-27-c 7949da1ef269a9e9a6d7a2f212a4910267d30a96 -m "test(gate): zombie-running finalize gate -- a card left running after turn end drops out of the tick scan (finalize drives 1->0, tick stops); registered in SUITES"
git tag -a v-baseline-2026-10-27-d 14af95683fcfec7b46987120a0828b18fd6bcfe1 -m "test(gate): cut-path finalize gate -- an external stream cut routed through catch must REACH finalize (no body early-return), zombie finalized, tick stops; registered in SUITES"
git tag -a v-baseline-2026-10-27-e 2cf71c2ccd91d349f9c3aa0d795bed694f5a51fb -m "feat(debug): promote debug page from drawer to full tab (memory-page paradigm) - sticky subtabs, card flow, bug box; flip stream_debug gate to new DOM; i18n pairs 1022x2"
git tag -a v-baseline-2026-10-27-f 9f118e8bdbf4001c3ca1a49727301a5c2cf9495f -m "fix(css): shared narrow flow container .about lacked justify-content, so short content got pushed to mid-screen and the sticky sub-tab bar floated (root cause of debug page looking wrong); make flex default explicit -> content+sticky hug the top; gate test_stream_debug ALL GREEN"
git tag -a v-baseline-2026-10-27-g 594507579cb1679d9e413064d6899aa93b89eaee -m "chore(models): runtime drift (daemon-selected model) committed to keep tree clean for post-green"
git tag -a v-baseline-2026-10-27-h 1321303c4596cba8249bb2baed18794ba0e431fd -m "chore(config): models.json runtime drift (selected field) reconciled for clean tree"
git tag -a v-baseline-2026-10-27-i c4fe6ae4123b9f018c7f4dc2bd62b580459b694c -m "perf(memory): A content-visibility light tier + B default recent-50 load-more for KB list"
git tag -a v-baseline-2026-10-28 0bbb90b4002537bf180edac7d5ca5a2c1661225d -m "chore: daemon runtime drift in models.json selected field"
git tag -a v-baseline-2026-10-28-b 50efcc89c35de2e70a51dc032f67feb3c1a9236f -m "fix(frontend): saveChat keeps base64 url when ref is empty (root cause of chat image loss on reload); add differential jsdom gate locking the real saveChat, registered in SUITES"
git tag -a v-baseline-2026-10-28-c 85adc4c407dc782e4ee7f1d05665c96b17d412d1 -m "test(spark): flip the IMG-stripped assertion to lock the new contract (IMG kept via allow-list, unsafe src stripped) - intended contract change from the spark image persistence feature"
git tag -a v-baseline-2026-10-28-d bcfdd0aeab054a668dfdce4349a00831fe52a43f -m "fix(spark/edit-modal): ref-only images survive reload in edit modal (filter+src+dblclick url||ref); spark add-box and list gained dblclick->openImageView delegation; differential jsdom gate 11/11 registered in SUITES"
git tag -a v-baseline-2026-10-28-e 65a5e327e01b5753fb878e75c0bc2556ebfc9875 -m "test: fix F1 static lock to a substring check (ESM strict-mode regex literals forbid brace escapes) + flip the edit-resend default-strategy lock soft->hard per the 2026-10-28 user decision (真删除 leftmost card is now the default)"
git tag -a v-baseline-2026-10-28-f b7c339c3b826c591b25ecff58f10b7531dff93cb -m "test: migrate stream_intel composer gates to contenteditable contract (value->textContent, att-thumb->chip--img)"
git tag -a v-baseline-2026-10-28-g 7ce35914e0a1ebb18e36a86457a0d622c7206eb8 -m "feat(ui): attachment chips show filename on hover title (icon-only, composer + edit modal); paste img keeps alt/title and sanitizeHtml lets IMG alt/title survive; lock via stream_intel icon-only gates"
git tag -a v-baseline-2026-10-28-h 6e7fa13dc37905f81691ffbda7289395b2418ae2 -m "chore: runtime drift - daemon rewrote models.json selected field"
git tag -a v-baseline-2026-10-28-i 9bd6a3ba59e2ab061ef764d350ffb72117555716 -m "feat(ui): image chips unified to a single inline thumbnail (composer + edit modal), name on hover title, hover-revealed delete; ceText rebuilds [img:N] from data-pid so storage/ordering survives; migrate chip--img gates to inline-thumbnail contract"
git tag -a v-baseline-2026-10-29 56178a3debe1aca31236135b7d09826617f9c352 -m "feat(css): shrink spark/composer/bubble-edit image thumbnails 44px to 32px"
git tag -a v-baseline-2026-10-29-a 8f6f25db1b32dfe9940fb7c3960a4cd4bf218ce7 -m "fix(composer): mixed text+image sends keep the typed text (paste path) - makeInlineThumb chips are now contenteditable=false (atomic, browser caret can no longer drop INSIDE the chip), pasteImageToRich moves the caret to AFTER the inserted chip (mirrors insertPlaceholder), and ceTextFromDom descends into a data-pid chip to COLLECT any user text node that landed inside it while still skipping the hover button/icon; differential locks P6 (the reported bug: text inside an atomic chip survives - RED on pre-fix code) + P7 (interleaved) + N3 (button label must not pollute)"
git tag -a v-baseline-2026-10-29-b 3a55667e5ad0defdf3aec1b32351918368a627f2 -m "chore: runtime drift - daemon rewrote models.json selected + bench_cnthink result"
git tag -a v-baseline-2026-10-29-c 8365d24d9ef3c7ef641084679911b67fa061e74e -m "chore(rules): empty-list = real delete intent (Array.isArray not .length)"
git tag -a v-baseline-2026-10-29-d 448b218452efc82ac2bb27450d9520e3ba5ae210 -m "feat(brand): AI display line -> Swift1.5-Qwen3.8Flash-Q3S (title + text, hardcoded HTML, no i18n key)"
git tag -a v-baseline-2026-10-29-e 2e810887b278f548bfec75ab3132d7f76e10c806 -m "feat(brand): tab-badge number text -> near-black #0a140f (was fallback white on green, both themes sub-AA)"
git tag -a v-baseline-2026-10-29-f 0daf65565fbd2a792716c203d263bcccec2c856f -m "feat(web): Backspace deletes an inline image chip (focused/adjacent/selection) with array+DOM splice together"
git tag -a v-baseline-2026-10-29-g ed2f6356be18fafdb8047bd3809533172103f0b4 -m "fix(web): reconcile composer/modal array to DOM before send + MutationObserver on chips (native-Backspace orphan was the source-of-truth gap)"
git tag -a v-baseline-2026-11-01-a d8c4373a9655a35e620fd6bce6ef10c237518123 -m "chore(rules): land leftover RULES line from previous session (README append four-step rule)"
git tag -a v-baseline-2026-11-01-b 757b3405451623519328921a78325ebaecacd211 -m "fix(sparks): preserve pasted images through the spark->chat push (sparkToPush extracts data-pid anchored imgs from s.html and rebuilds text with [img:N] anchors; sendUserMessage gains optional images param, 3 call sites routed through it)"
git tag -a v-baseline-2026-11-01-c 042696af17deb818c53f31cf7f5c2a03a95cda0c -m "feat(sparks): root-cause A migration + gates — migrateSparkDataPid() adds the missing data-pid anchor to a bare-img historical note so sparkToPush re-attaches the image (list shows, bubble drops); registers test_spark_datapid_anchor.mjs + test_spark_datapid_migrate.mjs into the gate list (differential PRE bare->images=[]/POST migrated->images=1 + IDEMPOTENT)"
git tag -a v-baseline-2026-11-02-a a9c505216892e8ef288fb523913ae0381dd10f75 -m "fix(sparks): spark inline thumbnail delete now WORKS -- bindInlineThumbDelete wires the three spark containers onto their own handler sparkThumbDelete(); stored-spark delete persists s.html via saveSparkEdit (chip dropped), add-box rides the shared editAttachments array, composer/modal stay on removeThumb. Gate test_spark_thumb_delete.mjs upgraded from root-cause lock to post-fix behavior lock: 5 static locks + 8 real-DOM-click differential pairs (stored-path delete/add-box array/composer control), 13/13 GREEN"
git tag -a v-baseline-2026-11-02-b ec5f82bccff4cfc7317624f237fa55298c037a13 -m "fix(sparks): delete-button icon no longer dies on SAVE -- sanitizeHtml USE-href whitelist broadened to ALSO accept the in-page sprite path web/sprite.svg# (icon() emits exactly that href); a paste-time chip was raw DOM so the icon showed, but SAVE ran sanitizeHtml which stripped the path-prefixed href -> empty <use> -> blank icon -> dead-shell delete button (the reported symptom). Off-site href STILL stripped (XSS net intact). Gate test_spark_thumb_icon.mjs upgraded to POST-FIX behavior lock (FIX survives + bare-# control + XSS-net), 5/5 GREEN; registered in SUITES"
git tag -a v-baseline-2026-11-02-d 9f229e7da3c7616656435ef2ea4a50080c4197e3 -m "fix(sparks): Shift+/ now types a question mark inside contenteditable inputs (edit-area / spark-add-input / spark-edit-ta) -- the global ? shortcut guard (app.js:8946) only exempted #input and TEXTAREA, so focused contenteditable DIVs fell through to preventDefault and popped the shortcut popover instead of typing; exemption now ALSO calls the existing isCE() helper. Root cause PINNED by reading the real focus-exemption. Gate test_question_key_contenteditable.mjs: static lock on the broadened exemption + runtime differential isCE true on the 3 shapes / false on a plain div (shortcut preserved), 9/9 GREEN; registered in SUITES"
git tag -a v-baseline-2026-11-02-e f806533d6c002ec4aaea3fe3a44b8fe887e19602 -m "feat(frontend): closing-out backstop (B mechanism) - renderNextSteps draws a minimal info-tone reminder when a closing-out turn (all-ticked plan OR a live decision card) has NO chips, so a missed fence is visible instead of purely model self-discipline; a plain empty-steps turn stays hidden so the existing hidden-on-empty gates stay green. New differential gate test_closeout_backstop (A/B/C/D + i18n pair) registered; i18n closeoutremind zh+en added; typo kun->wei fixed via read-back"
git tag -a v-baseline-2026-11-02-g 82117ac9ee52ea36ce4b86c9345b267f9ba718ed -m "perf(pixel-gate): parallelise the Edge capture segment with ThreadPoolExecutor (auto-scaled min(scenes,cpu,cap), per-scene profile) - differential contract A/C visible + B blank still locked after the change"
git tag -a v-baseline-2026-11-02-h 046aa722d30216116c567c643c54180bbeaa3d8b -m "fix(proposal-card): guard pros/cons type before .map in streaming render (real bug-log stack hit proposalCardHtml) - a quantized model sometimes writes pros/cons as a STRING, the old (o.pros||[]) guard returned that truthy string and .map threw EVERY streaming frame (8-shape direct-call probe all NO-THROW -> the crash is the decision-card render path, not markdown()); fix = Array.isArray gate (array renders, truthy string keeps content as one li, falsy empty); differential lock T7 added to test_proposal_card (string no-throw POS + array POS + absent NEG), differential-proof: red on the old code, green after"
git tag -a v-baseline-2026-11-02-i db9ce52d27e0dbd7ca1b15cbcac925e10c0b7111 -m "fix(compact-overflow): keep the generic red toast quiet on the compact-turn overflow error (the pendingCompact branch is its single owner: one accurate chunkfail notice + reroute through the chunked escape hatch); the catch used to DOUBLE-report this exact wording with a scary banner. Guard = skip the generic toast when pendingCompact AND the error matches this wording; a plain error still reports (differential control). New differential gate test_compact_overflow_quiet (TARGET quiet 0 / CONTROL reports 1, both proven to reach the stream), registered in SUITES; RULES anchor-chain rule landed."
git tag -a v-baseline-2026-11-02-j 4900fa0a77886aacc496e956dab2a9ff1d33d962 -m "feat(gate): orphan-chain gate -- post-green hook leaves HEAD detached, so a pure-doc register commit lands on it as an ORPHAN (master unmoved, branch --show-current empty, thrice reproduced). Live probe locks HEAD==master-tip AND on-branch; differential builds a REAL orphan in a temp repo and proves the predicate catches it (so the green is load-bearing, not vacuous). Registered in SUITES."
git tag -a v-baseline-2026-11-03-k 298b6e1e44f2ba21f9f95501b961244ccd7cc4d2 -m "feat(gates): A hidden-page compensating paint + B switch-back immediate paint, each with a differential gate. A: liveTimer paints the live session's body when document.hidden (rAF is paused by the browser on hidden pages); single-variable differential (only document.hidden differs, noop-rAF simulates the pause). B: renderChat tail paints immediately via paintLive() so switching back shows the newest chunk without waiting for the next rAF. Both gates registered in SUITES."
git tag -a v-baseline-2026-11-02-k 870369e298d33796a19bf227a0e4fcb99c479928 -m "feat(next-steps): live custom-text preview + IME/paste refresh on the composer (gate D)"
git tag -a v-baseline-2026-11-02-l 7307dd148b1c4a608a42c97dd86f5c00f8d2b1d8 -m "fix(spark-rerun): done-state button uses its own class spark-rerun (pending/error keep spark-exec) so the existing test_spark M1 contract (.spark-exec = pending only) holds unchanged, and click delegation also recognises spark-rerun so Re-run still works -- resolves the design collision without rewriting any test assertion"
git tag -a v-baseline-2026-11-03-m 1caac8f0ceeb301a98651eb0087f124ea70a0c20 -m "test: hr regex semantics baseline gate (ReDoS disproved, not autosize root cause); registered in SUITES"
git tag -a v-baseline-2026-11-03-n 972971d605dbe881319e60c0234569fd73c09def -m "feat(auto-resume): run to natural completion, fuse only on true loops; A main stop reads editable settings.autoresumeMax(24), B empty_round own separate budget(default 2), C i18n hint no longer hardcodes 3 (both langs); lane differential gate test_autoresume_lanes registered"
git tag -a v-baseline-2026-11-02-o 7b58ea771d26f466950dfc0d5d4de7e587ca0968 -m "feat(auto-resume): early-done lane (A+B) -- closing line while the model's OWN plan checklist still has UNCHECKED boxes = premature, not done; new fourth lane with its own counter+budget(2), never borrows main chain. B resume.cmd carries the plan self-check hard-constraint in BOTH langs (en restored to original sentence-open so the existing gate lock holds). differential gate test_early_done_lane registered (16/16 green, single-variable box-count load-bearing)"
git tag -a v-baseline-2026-11-03-a dfcfc0af1e9b110a5b9a73e9d877beb76d5283ee -m "fix(viewer): image-viewer CARD now hugs its content so a small original no longer sits in useless empty margins. Root cause: .img-viewer__card had a FIXED width:min(92vw,1100px) + flex-center body -> large blanks around a small picture (the img itself was never deformed; object-fit:contain + max-*, no !important). Fix = card width:fit-content with the upper bound retained as max-width:min(92vw,1100px) so LARGE images stay capped. New differential gate test_viewer_card_fit_content.mjs registered in SUITES."
git tag -a v-baseline-2026-11-03-b 78cdaadad010c14273e775aa74cdc4829e24e46b -m "fix(bugbox): double-click an inline thumbnail opens the viewer instead of folding the row (WIP-anchor)"
git tag -a v-baseline-2026-11-03-p 8e7e6badfc36a814821039e7fc5cc6f6b035841c -m "feat(footer): plan-A progressive reveal -- the streaming footer lights send-time-known data, above all the SEED (anchor-tip)"
git tag -a v-baseline-2026-11-03-q 5b3d46484d477615b91e62f09e9df84b3d67502a -m "feat(pagesim): scanScripts src resolve fallback mirrors _serve_static strip-first-segment"
git tag -a v-baseline-2026-11-03-r f5605c76611a20f9edb8d881949dab411675e039 -m "fix(paste): guard paste+upload on per-model modelAcceptsImages, not global health.images"
git tag -a v-baseline-2026-11-04-a c7991fdca89dbcbe475f41d0c8cd696c8af808bd -m "feat(pill): real tok/s on thinking/generating/tool states; kill first-frame Infinity"
git tag -a v-baseline-2026-11-04-b 0d37fe2727a0c16bdc76bba051257ac2c7a3b8c2 -m "feat(pill): idle copy uses its own key mon.pill.endpoint.idle (zh+en paired)"
git tag -a v-baseline-2026-11-04-c 710aa4d8f0a61ddcad1941ae560155dae6bcd5f6 -m "feat(models): expose context_window in model UI + make modal scrollable; declare 131k for swift-iq3_xxs"
git tag -a v-baseline-2026-11-05-a ba6ebcbf35b6c8456a975fcc2129abb517afb6d7 -m "monitor: raise decode byte/token estimate 3.5 -> 5.1 (backend+tooltip+test), RULES +5, model config drift"
git tag -a v-baseline-2026-11-05-b 6cd90d05b530a80d3a47e950158f372ee0392777 -m "fix(compact): cap chunked-compact re-entry + measure injection budget + slider"
git tag -a v-baseline-2026-11-05-c f999bed25be8deb8b27d208b42dd7c866fc6ac40 -m "chore(memory): record 8099 self-suicide restart rule (separate launch + report-evidence)"
git tag -a v-baseline-2026-11-05-d 0284de4b12efbc31b97639efd81a2c98cd963a18 -m "fix(rollback-verify): derive workspace root from __file__ (migration-proof)"
git tag -a v-baseline-2026-11-05-e a9b7170d628078271b64378b3c645ae52fb58eb7 -m "feat(nebula): raise orbit-spin clamp 40 -> 160 so animation can resolve fast vs slow"
git tag -a v-baseline-2026-11-05-f 150cf31f88dbdbb13f172fb4145408d5246fba1f -m "chore(memory): land leftover RULES entry (self-suicide guard, round ee1b35b)"
git tag -a v-baseline-2026-11-05-g 85ee4d8d010948e06c6f882b4f0408499d0d73ac -m "chore: runtime drift from daemon (mcp_servers.json + models.json)"
git tag -a v-baseline-2026-11-08-a 571fb50fde0edb1a74f32aaa4519d480ef8c435d -m "test(compact): static anchor locking the 3 custom 47831 models at context_window=131072 (not monitor default 32768) + sync continue-bends-send stub for the C2 activeId global + register the gate; chore: models.json runtime drift (selected=swift-iq3_s)"
git tag -a v-baseline-2026-11-08-b 00ab005b7a518edc0ccf572c2e2d24dfe263aa08 -m "chore: rules update, mcp path migration to current workspace, bat console width, utf-8-sig BOM tolerance in config_loader+gateway, encoding_canary ps-nobom downgraded to warn-only"
git tag -a v-baseline-2026-11-08-c 0020782515be5bc8f3363a261580060b1f2e6367 -m "fix(compact): chunk-budget SAFETY factor 0.92 in compactReqBudgetChars - CJK-heavy chunks run ~1 char/token vs the 1.8 perTok estimate, so a full chunk + inject + reply overflowed the real window -> engine 400 -> 'even when compacting' -> empty summary; gate test_safety_pad_gate.mjs (static lock + WITH/NO-PAD differential, registered in SUITES after test_chunkretry); chore: models.json runtime drift (selected=unsloth-ud-q4_k_xl)"
git tag -a v-baseline-2026-11-08-d b84b306766b6223242c1bc2d8525999d296a94e8 -m "feat(ctx): split fixed-overhead vs history in occupancy bar (scheme C) + archive low-freq rules to lazy knowledge.md (scheme A)"
git tag -a v-baseline-2026-11-09-a 895595c1584a59c4725eedf52c57e284d923d800 -m "docs(manifest): log real-machine acceptance of the continue-btn cut-truncation fix"
git tag -a v-baseline-2026-11-12 8fd71593d95a6aeeebfc01b94f64481f4f85b473 -m "feat(tests): make --quick the daily default tier, full explicit for release"
git tag -a v-baseline-2026-11-12-a 8fd71593d95a6aeeebfc01b94f64481f4f85b473 -m "feat(tests): make --quick the daily default tier, full explicit for release"
git tag -a v-baseline-2026-11-12-b 7673810438067fa1f41b0310b267b2ee83f0184f -m "fix(schedule): deliver payload carries workspace so scheduled sessions group correctly; drop stale (pending) label on session_stream"
git tag -a v-baseline-2026-11-12-c ecdb0f6a2943eee0c132dbe83361d807ccde38af -m "docs(readme): 登记 agent 工具改调度→侧栏自动刷新 A+B（feat 28d0e14，像素层 A 兜底肉眼复验通过）"
git tag -a v-baseline-2026-11-12-d 9429a71077055aa23dedbc13b40c8ffbdca9b4e9 -m "feat(brand): 空态白泽hero SVG+brand/pill星尘改五行命名(承接品牌改名功能线de523cc)"
git tag -a v-baseline-2026-11-12-e 20ce57dabafef878b44baa9562604cd1fa5d0d65 -m "feat(web)：压缩后自动续跑开关 settings.compactResume + 差分门禁"
git tag -a v-baseline-2026-11-12-f e80a5e2acacf8f2c7d9561b060cd22a7602fb233 -m "feat(websearch): pinyin brand-trap dictionary + in-tool guidance"
git tag -a v-baseline-2026-11-19-a bb06f16d380132ee820ecacc90f6a688b3958bee -m "fix(tools): selfcheck 日志目录自检注释统一为真实名 turn.jsonl"
git tag -a v-baseline-2026-11-20-a 47d1f0fb6ed1206677e7059dde57330e03cdee11 -m "feat(网关)：/api/version 路由补进 http_server 精确路由链（8099 重启后 tooltip 端到端生效）"
git tag -a v-baseline-2026-11-21-h 93e4727c6b2eb41b5a24de5735ecefce2427d334 -m "chore: 版本号 0.1.00 → 0.1.0（VERSION 源 + 前端静态兜底角标）"
```

## 2026-11-25 series (cont.): current rollback point upgraded to k then l (back-end modularization, all green)

This round cut named rollback point `v-baseline-2026-11-25-k`, pointing at commit `f4f7d4d75`
(`refactor(serve): extract tokenizer family out of server.py into serve/tokenizer.py`): the mutually decoupled
*incremental-decode + stop-string* family (ByteTokenizer / Detokenizer / stop_strings + OPENAI_MAX_STOP /
StopMatcher) lifted whole out of the 7,290-line `serve/server.py` monolith into a new module
`serve/tokenizer.py` — stdlib `codecs` only, no server globals; call sites keep their original names via a
try/except import. `test_pure_modules.py` gained its 12th module (3 load-bearing tests); CHANGELOG gained a
Changed entry (zh+en). Full regression measured ALL GREEN. This was the first back-end extraction in the chain.

Then this round cut named rollback point `v-baseline-2026-11-25-l`, pointing at commit `5f136f1a2`
(`refactor(serve): extract approval family out of server.py into serve/approval.py`): the mutually decoupled
*tool-approval policy* family (_DESTRUCTIVE_SHELL / _DESTRUCTIVE_SYMBOLS / _APPROVAL_TOOLS / _needs_approval /
_auto_deny / _approval_desc) lifted whole into a new module `serve/approval.py` — stdlib `json` + `re` only, no
server globals; `_PERM_TIERS` stays, call sites keep their original names via a try/except import. The textual
lockstep in tests/test_registry_server.py (approval.yaml ↔ frozenset) had its capture source moved from
server.py to approval.py (load-bearing); test_pure_modules.py gained its 13th module (3 load-bearing tests).
Full regression measured ALL GREEN. This is the second back-end extraction in the chain (after -k tokenizer).

| tag | commit | nature |
|---|---|---|
| v-baseline-2026-11-25-k | `f4f7d4d753f6ba1be6aa9964c7fff5ca15b070eb` | refactor(serve): tokenizer family extraction (1st back-end step; full regression ALL GREEN; confirmed on remote via ls-remote) |
| v-baseline-2026-11-25-l | `5f136f1a2c24ea90725827726731ccb9e4115510` | refactor(serve): approval family extraction (2nd back-end step; full regression ALL GREEN; confirmed on remote via ls-remote) |

**On the remote**: both are already on the remote (this round pushed origin main + each tag individually, main
0 0 synced, ls-remote hits both tags; bundle `strata-bundle-20261125-143554` already contains -l, E/F dual-drive
clone-rehearsal reproduced; the earlier bundle `strata-bundle-20261125-135313` contained -k).

### Rebuild commands (to restore named rollback points k / l)

```bat
git tag -a v-baseline-2026-11-25-k f4f7d4d753f6ba1be6aa9964c7fff5ca15b070eb -m "baseline: lock rollback point at f4f7d4d (first back-end extraction: serve/tokenizer.py family); full regression ALL GREEN"
git tag -a v-baseline-2026-11-25-l 5f136f1a2c24ea90725827726731ccb9e4115510 -m "baseline: lock rollback point at 5f136f1 (second back-end extraction: serve/approval.py family); full regression ALL GREEN"
```


## 2026-11-25 series (cont.): current rollback point upgraded to m (3rd back-end extraction: serve/conv_cache.py + bump 0.1.1-rc.1, all green)

This round cut named rollback point `v-baseline-2026-11-25-m`, pointing at commit `be31910`
(`feat(serve): extract conv_cache family into serve/conv_cache.py + bump 0.1.1-rc.1`): the mutually decoupled
*conversation-cache log reader* family (`ConvCacheLog`, the engine-stderr log reader + `conversation_cache_view`,
the Monitor card assembler) lifted whole into a new module `serve/conv_cache.py` — stdlib `os`/`re`/`time` only, no
server globals; call sites keep their original names via a try/except import, no textual-regex capture source was
involved (only two call sites in server.py); test_pure_modules.py gained its 14th module (2 load-bearing tests).
The same round sealed the verified [Unreleased] content into a new CHANGELOG section [0.1.1-rc.1] - 2026-11-25 and
bumped VERSION 0.1.0 -> 0.1.1-rc.1 (the back-end /api/version single-sources the VERSION file) plus the index.html
static fallback badge. Full regression measured ALL GREEN. This is the third back-end extraction in the chain
(after -k tokenizer, -l approval).

| tag | commit | nature |
|---|---|---|
| v-baseline-2026-11-25-m | `be319105105fb8ecdcdca802df8d41a9e16d5a76` | feat(serve): conv_cache family extraction + bump 0.1.1-rc.1 (3rd back-end step; full regression ALL GREEN; confirmed on remote via ls-remote) |

**On the remote**: already on the remote (this round pushed origin main + push origin v-baseline-2026-11-25-m,
main 0 0 synced, ls-remote hits tag -m; bundle `strata-bundle-20261125-150412` already contains -m, E/F dual-drive
clone-rehearsal reproduced).

### Rebuild command (to restore named rollback point m)

```bat
git tag -a v-baseline-2026-11-25-m be319105105fb8ecdcdca802df8d41a9e16d5a76 -m "baseline: lock rollback point at be31910 (3rd back-end extraction: serve/conv_cache.py; bump VERSION+CHANGELOG to 0.1.1-rc.1); full regression ALL GREEN"
```


## 2026-11-25 series (cont.): current rollback point upgraded to n (4th back-end extraction serve/engine_diag.py + modularization doc + cut release 0.1.1, all green)

This round cut named rollback point `v-baseline-2026-11-25-n`, pointing at commit `29e1f10` (release 0.1.1). It
carries two commits: `23c1588` lifted the mutually decoupled *engine exit-status / start-log diagnostics* family
(`start_failure_hint` / `engine_exit_words` / `engine_crashed` / `start_log_marks` — four pure functions — plus the
four constants they read: `DRAFT_HEAD_FAIL` / `DRAFT_HEAD_HINT` / `_WIN_CRASH` / `TRANSIENT_START_MARKS`) whole into
a new module `serve/engine_diag.py` (stdlib os/signal only, no server globals; try/except import shim); test_pure_
modules.py gained its 15th module, and a bilingual doc `docs/backend-modularization(.en).md` was created logging the
full extraction-chain progress. `29e1f10` de-RC'd the 0.1.1-rc.1 candidate — repeatedly ALL GREEN across the full
regression — into the official release 0.1.1 (VERSION + the index.html badge + the CHANGELOG section header, three
places in step) and cut the v0.1.1 release tag to trigger build-release.yml CI. `cpu_isa_words` / `start_exit_note` /
`START_RETRIES` / `transient_start_failure` (start-retry + CPU-instruction-set probe, a heterogeneous responsibility)
stay in server.py. Full regression measured ALL GREEN. This is the fourth back-end extraction rollback point in the
chain (after -k tokenizer, -l approval, -m conv_cache) and the first official release point.

| tag | commit | nature |
|---|---|---|
| v-baseline-2026-11-25-n | `29e1f10b60d7ec9e44ca1d11d03eb5ef945a3882` | release 0.1.1 (engine_diag extraction + modularization doc + de-RC official release; full regression ALL GREEN; confirmed on remote via ls-remote) |

**On the remote**: already on the remote (this round pushed origin main + push origin v0.1.1 + push origin
v-baseline-2026-11-25-n, main 0 0 synced, ls-remote hits tag -n; bundle `strata-bundle-20261125-153044` already
contains -n, E/F dual-drive clone-rehearsal reproduced).

### Rebuild command (to restore named rollback point n)

```bat
git tag -a v-baseline-2026-11-25-n 29e1f10b60d7ec9e44ca1d11d03eb5ef945a3882 -m "baseline: lock rollback point at 29e1f10 (4th back-end extraction serve/engine_diag.py + backend-modularization doc + cut release 0.1.1 de-RC from 0.1.1-rc.1); full regression ALL GREEN"
```


## 2026-11-25 series (cont.): current rollback point upgraded to o (5th back-end extraction serve/exceptions.py exception hierarchy, all green)

This round cut named rollback point `v-baseline-2026-11-25-o`, pointing at commit `a6afc2a` (`feat(serve): extract
exception hierarchy into serve/exceptions.py`): the mutually decoupled *engine / session exception hierarchy* family
(`EngineDied` / `EngineStarting` / `ClientGone` / `ModelBusy` / `EngineSilent` (subclassing EngineDied) /
`EngineNonFinite` / `SessionRefused` (with its kind->HTTP status property) / `EngineStuck` / `GpuBusy` (with
retry_after) — nine classes) was lifted whole into a new module `serve/exceptions.py`. They inherit only builtins
(RuntimeError / Exception / ValueError) or one another — zero imports, zero server globals; all nine classes'
references live inside server.py with no cross-file or textual-capture-source fallout, and call sites go through a
try/except double-path import. The AST out-deps=0 scan confirms this is the purest, most cohesive zero-dependency
family right now (real diff: server.py 4 added / 63 removed). test_pure_modules.py gained its 16th module (one test:
the fatal inheritance chain + a ValueError-vs-RuntimeError three-bases-are-distinct differential + the kind->status
mapping + the retry_after load), and docs/backend-modularization(.en).md gained a 16th row, keeping the three places
in lockstep at 16 modules. Full regression measured ALL GREEN. This is the fifth back-end extraction rollback point
in the chain (after -k / -l / -m / -n).

| tag | commit | nature |
|---|---|---|
| v-baseline-2026-11-25-o | `a6afc2a6ee1e8ea07b5740d77814a4044d9411b6` | feat(serve): exceptions hierarchy extraction (5th back-end step; full regression ALL GREEN; confirmed on remote via ls-remote) |

**On the remote**: already on the remote (this round pushed origin main + push origin v-baseline-2026-11-25-o, main
0 0 synced, ls-remote hits tag -o; bundle `strata-bundle-20261125-160340` already contains -o, E/F dual-drive
clone-rehearsal reproduced).

### Rebuild command (to restore named rollback point o)

```bat
git tag -a v-baseline-2026-11-25-o a6afc2a6ee1e8ea07b5740d77814a4044d9411b6 -m "baseline: lock rollback point at a6afc2a (5th back-end extraction: serve/exceptions.py engine/session exception hierarchy; full regression ALL GREEN)"
```


## 2026-11-25 series (cont.): current rollback point upgraded to p (front-end chain new round serve/web/app_utils.js splitPath + back-end wrap-up doc, all green)

This round cut named rollback point `v-baseline-2026-11-25-p`, pointing at commit `58d0955` (`feat(web): extract
splitPath into app_utils.js`): after the back-end chain concluded naturally, the extraction turned to the front-end
`app.js` (an 11,935-line monolith) and, under the same discipline, surfaced the zero-dependency cohesive leaf
`splitPath` (splits an absolute path into clickable breadcrumb segments, Windows-flavoured: C:->C:\ drive root, a
leading / is root-relative) — it belongs to the same *path-handling* family as the existing firstPath already in
app_utils.js and was lifted whole into `app_utils.js`. It references only its argument + String/Array/RegExp builtins,
zero app.js globals, zero DOM; referenced in exactly two places in app.js with no textual-capture source, and the call
site keeps its original name. Blast radius: test_app_utils_contract.mjs EXPORTS gains splitPath, test_app_utils_jsdom.mjs
gains a behaviour gate, and test_workspace_picker.mjs merges app_utils.js + app.js into one win.eval scope. This round
also registered the back-end modularization wrap-up (CHANGELOG) + the ledger top overview (o→p). Full regression
measured ALL GREEN. This is the first rollback point of the front-end chain's new round after the spark family pause.

| tag | commit | nature |
|---|---|---|
| v-baseline-2026-11-25-p | `58d0955c379e8fc944b1b0372c91cb2294d21d09` | feat(web): splitPath extraction into app_utils.js (front-end chain new round + back-end wrap-up doc; full regression ALL GREEN; confirmed on remote via ls-remote) |

**On the remote**: already on the remote (this round pushed origin main + push origin v-baseline-2026-11-25-p, main 0 0
synced, ls-remote hits tag -p; bundle `strata-bundle-20261125-164121` already contains -p, E/F dual-drive clone-rehearsal
reproduced, keep-14 pruned).

### Rebuild command (to restore named rollback point p)

```bat
git tag -a v-baseline-2026-11-25-p 58d0955c379e8fc944b1b0372c91cb2294d21d09 -m "baseline: lock rollback point at 58d0955 (front-end chain new round: splitPath extracted into app_utils.js; back-end modularization wrap-up doc; full regression ALL GREEN)"
```


## 2026-11-25 series (cont.): current rollback point upgraded to q (front-end chain round 2 serve/web/app_utils.js proposalMarkdown, all green)

This round cut named rollback point `v-baseline-2026-11-25-q`, pointing at commit `5e5cb71` (`feat(web): extract
proposalMarkdown into app_utils.js`): continuing the splitPath round, under the same discipline (zero external
dependency AST out-deps=0, zero app.js globals, zero DOM, no mutation) the cohesive leaf `proposalMarkdown` surfaced
(it serialises a proposal decision-card object into a human-readable markdown document: title + verified-state + options
comparison table + evidence + next) — it belongs to the same *markdown-render* family as the existing mdKindOf/mdImageTag
already in app_utils.js and was lifted whole into `app_utils.js`. It references only its argument's fields plus
Array/String/template builtins; referenced in exactly two places in app.js (one call site inside saveProposalToFile + one
definition), no regex-source capture, and the call site keeps its original name. Blast radius: test_app_utils_contract.mjs
EXPORTS gains proposalMarkdown, test_app_utils_jsdom.mjs gains a 5-assertion behaviour gate, and test_proposal_card.mjs's
Object.assign boot list gains proposalMarkdown (under outside-only, a top-level function does not cross win.eval scope).
This round also added the front-end round-2 CHANGELOG entry + ledger symbol-list row #35 (title count 34→35) + the top
overview (p→q). Full regression measured ALL GREEN.

| tag | commit | nature |
|---|---|---|
| v-baseline-2026-11-25-q | `5e5cb71fe9a73d95f38d9b9926063b9de3c78308` | feat(web): proposalMarkdown extraction into app_utils.js (front-end chain round 2, markdown-render family; full regression ALL GREEN; confirmed on remote via ls-remote) |

**On the remote**: already on the remote (this round pushed origin main + push origin v-baseline-2026-11-25-q, main 0 0
synced, ls-remote hits tag -q; bundle `strata-bundle-20261125-171323` already contains -q, E/F dual-drive clone-rehearsal
reproduced, keep-14 pruned).

### Rebuild command (to restore named rollback point q)

```bat
git tag -a v-baseline-2026-11-25-q 5e5cb71fe9a73d95f38d9b9926063b9de3c78308 -m "baseline: lock rollback point at 5e5cb71 (front-end chain round 2: proposalMarkdown extracted into app_utils.js markdown-render family; full regression ALL GREEN)"
```

## 2026-11-26 series (cont.): current latest rollback point upgraded to d (back-end extraction chain step 6 + flaky fix + app_utils self-describing index, all green)

Owner sign-off: push this round's single commit to origin (behind=0 fast-forward, confirmed 0 0), then cut named rollback point `-d`
(annotated) at HEAD. `-d` is an annotated tag whose message records only facts actually verified by a real run (full regression
--full ALL GREEN incl. post-green hooks). This round's commit `505406e`:

| tag | commit | nature |
|---|---|---|
| v-baseline-2026-11-26-d | `505406e6741ce425202c43db7d32dcf4bbddac90` | refactor(serve): sampling block extracted into req_args (byte-identical + diff test) + fixed schedule-contract flaky + app_utils self-describing index (full regression ALL GREEN) |

**On the remote**: already on the remote (this round pushed origin main, then pushed `v-baseline-2026-11-26-d` alone; main 0 0 synced,
ls-remote hits tag -d deref == 505406e6741ce425202c43db7d32dcf4bbddac90).

### Rebuild command (to restore named rollback point d)

```bat
git tag -a v-baseline-2026-11-26-d 505406e6741ce425202c43db7d32dcf4bbddac90 -m "baseline: sampling block extracted to req_args (byte-identical, diff test), schedule-contract flaky fixed (bounded poll), app_utils 42-sym/14-family doc index. Full regression --full ALL GREEN (incl post-green hooks)."
```

### app_utils.js extraction-chain full symbol inventory (source of truth = the EXPORTS list in tests/test_app_utils_contract.mjs, 42 total)

The symbols below have been moved whole from app.js into `serve/web/app_utils.js`; app.js no longer redefines them (contract two-way lock: app_utils must define + app.js must not redefine).
Load-order rule: index.html must load `<script src="web/app_utils.js">` before `web/app.js` so that app_utils, loading first, exposes the symbols below as globals for app.js call sites to use.

| # | symbol | topic group |
|---|---|---|
| 1 | `timeStr` | misc basics |
| 2 | `fmtBytesSel` | misc basics |
| 3 | `parsePlanItems` | plan/proposal text |
| 4 | `extractNextSteps` | plan/proposal text |
| 5 | `extractProposalsFromText` | plan/proposal text |
| 6 | `detectLang` | misc basics |
| 7 | `firstPath` | path/scope |
| 8 | `nextScopeUp` | path/scope |
| 9 | `nextScopeDown` | path/scope |
| 10 | `clone` | misc basics |
| 11 | `classifyTool` | tool-result classification |
| 12 | `bugBoxSigKey` | bug-box aggregation |
| 13 | `bugBoxStats` | bug-box aggregation |
| 14 | `bugBoxGroups` | bug-box aggregation |
| 15 | `thinkPeek` | pure think-text transforms |
| 16 | `dedupeThink` | pure think-text transforms |
| 17 | `configValue` | stateless helper |
| 18 | `safeCut` | stateless helper |
| 19 | `taskOrder` | stateless helper |
| 20 | `pickSeed` | stateless helper |
| 21 | `snapSent` | stream/think path |
| 22 | `toolSeq` | stream/think path |
| 23 | `noteStreamPhase` | stream/think path |
| 24 | `assembleStreamBubbles` | stream/session record |
| 25 | `computeWaterfall` | stream/session record |
| 26 | `nebTaskFromTool` | tool/task-name parsing |
| 27 | `inflightToolName` | tool/task-name parsing |
| 28 | `mdKindOf` | markdown render (kind by url) |
| 29 | `mdImageTag` | markdown render (image-tag construction) |
| 30 | `buildCtxArr` | context compaction (build compaction input array) |
| 31 | `renderMsgForCompact` | context compaction (per-message render+truncate) |
| 32 | `sparkIsExecuted` | spark execution check (pure boolean) |
| 33 | `sparkTimeCompare` | spark sort (pure comparator) |
| 34 | `splitPath` | path/scope (this round: app.js -> app_utils.js) |
| 35 | `proposalMarkdown` | markdown render (this round: app.js -> app_utils.js) |
| 36 | `designFileName` | string/identifier normalisation (this round: app.js -> app_utils.js) |
| 37 | `safeGroup` | string/identifier normalisation (this round: app.js -> app_utils.js) |
| 38 | `endpointKey` | string/identifier normalisation (this round: app.js -> app_utils.js) |
| 39 | `normalizeTags` | string/identifier normalisation (this round: app.js -> app_utils.js) |
| 40 | `toolResultText` | string/identifier normalisation (this round: app.js -> app_utils.js) |
| 41 | `_memEstTokens` | memory-text metrics (this round: app.js -> app_utils.js) |
| 42 | `_memEntryCount` | memory-text metrics (this round: app.js -> app_utils.js) |

## 2026-11-26 series (cont.): current latest rollback point upgraded to e (zh/en double-ledger alignment + RULES other-line landing, doc-only)

Owner sign-off: push this round's close-out commits to origin (behind=0 fast-forward, confirmed 0 0), then cut named rollback point `-e` (annotated) at the final HEAD. Because the owner asked to freeze the en ledger and this round's close-out **together**, `-e` points at the final HEAD `b67480a6f693fd9781ea1117262ae4ffe743c358` after items 2+3 (en/zh alignment 892619f + RULES landing b67480a), not the earlier 010a2ba. Two independent chore commits this round:

| tag | commit | nature |
|---|---|---|
| v-baseline-2026-11-26-e | `b67480a6f693fd9781ea1117262ae4ffe743c358` | docs(archive.en): en ledger backfilled to the 11-26 series + app_utils 42-symbol inventory section (zh/en fully aligned) + chore(rules): other-line entry landed (doc-only, no code change) |

**On the remote**: already on the remote (this round pushed origin main, then pushed `v-baseline-2026-11-26-e` alone; main 0 0 synced, ls-remote hits tag -e deref == b67480a6f693fd9781ea1117262ae4ffe743c358).

### Rebuild command (to restore named rollback point e)

```bat
git tag -a v-baseline-2026-11-26-e b67480a6f693fd9781ea1117262ae4ffe743c358 -m "baseline: en ledger fully aligned to zh (11-26 series backfill + app_utils 42-symbol inventory section) + RULES other-line drift landed. Doc-only; tag points at the double-ledger alignment + RULES landing commit b67480a."
```

## 2026-11-25 series (cont.): current latest rollback point upgraded to r (WorkBuddy-trace purge: 137 test anchors + display strings + fallback, quick regression all green)

This round cut named rollback point `v-baseline-2026-11-25-r`, pointing at commit `835dad4` (`chore(workbuddy): purge stale WorkBuddy path traces from test harness + display + node fallback`): it removed the WorkBuddy-era paths left over after the project migrated to `E:\Nebula\NebulaBaize`. The runtime was already clean (the active mcp_servers.json launches the local .venv); the residue sat in the test-harness path anchors and a few display strings:

- **Scheme A** (load-bearing test anchors + display strings): the `createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/")` in 137 test files -> `E:/Nebula/NebulaBaize/` (the workspace-root node_modules holds the real jsdom/playwright; the old base dir no longer exists and was previously reached only through a NODE_PATH ancestor fallback); the `mem.kb.path.ph` placeholder in i18n (both langs), the `test_runtime_config_frontend.mjs` stub path, the stale python candidate line in `setup.bat`, and the doc examples in `test_registry_server`/`test_skillhub` -> all WorkBuddy-free.
- **Scheme B** (node/python fallback -> the system install): the node fallback in `run_tests.py`/`test_closeout_pixel.py` -> `E:\Program Files\nodejs\node.exe`; the workbuddy node glob in `browser_server._find_node()` -> `%ProgramFiles%\nodejs\*\node.exe`.
- **Kept per the rename iron rule**: the `audit.jsonl`/`logs`/`tool-log`/`config/.backups`/`*.bak-*`/"the old ROOT=E:\WorkBuddy bug" historical-narration comments (genuine fossils of "a little past code used WorkBuddy"; rewriting them would only distort history).

Measured this round: `tools/run_tests.py --quick` full suite **ALL GREEN** (incl. i18n 1392 keys x2 and the whole jsdom net); `--full` failed only on `test_shell_timeout`/`test_self_suicide_guard`, neither of which references a changed anchor and both ALL GREEN when run alone (per the existing flaky experience). numstat == --ignore-cr-at-eol, zero line-ending pollution; commit `835dad4` pushed to origin (fast-forward `b5dd74e..835dad4`, main 0 0 synced).

| tag | commit | nature |
|---|---|---|
| v-baseline-2026-11-25-r | `835dad49e1b1f52af17bb96cf8c840c32a4d948d` | chore(workbuddy): purge 137 test createRequire anchors + display strings + node/python fallback (WorkBuddy-trace purge; quick regression ALL GREEN; confirmed on remote via ls-remote) |

**On the remote**: already on the remote (this round pushed origin main + push origin v-baseline-2026-11-25-r, main 0 0 synced, ls-remote hits tag -r deref == commit `835dad4`).

### Rebuild command (to restore named rollback point r)

```bat
git tag -a v-baseline-2026-11-25-r 835dad49e1b1f52af17bb96cf8c840c32a4d948d -m "WorkBuddy trace purge: 137 test createRequire anchors + display strings + node fallback; quick regression ALL GREEN"
```

## 2026-11-26 superseded-numbering cleanup (cut on 11-25 but labelled 11-26, out of date order · 5 removed)

The owner signed off on removing 5 superseded-numbering tags: they were actually created on **2026-11-25** (see `git for-each-ref --sort=-creatordate`: -a 17:27 / -b 17:53 / -c 18:22 / -d 20:06 / -e 20:28, all on 11-25) yet carry an 11-26 label, which conflicts with this repo's "tag name follows the real git date" convention and is reversed against date order. The criterion: every commit a deleted tag pointed to is an ancestor of HEAD (master) (confirmed anc=0 tag by tag with `git merge-base --is-ancestor`); deleting the tags **loses no commit** — the master chain already contains them; a tag is only a named pointer, rebuildable with the commands below. Both steps were done: local delete + `git push origin --delete`.

| deleted tag | pointed commit (40) | original semantics (existing ledger summary) |
|---|---|---|
| v-baseline-2026-11-26-a | `fcb8f9b6df5da01c0d18efc78f3068f441391748` | 11-26-series early baseline (superseded numbering, created on 11-25) |
| v-baseline-2026-11-26-b | `ca99cc274415a9bb7903acd20af8d203441df347` | 11-26-series early baseline (superseded numbering, created on 11-25) |
| v-baseline-2026-11-26-c | `9d4699eed6a4fac7ffc16a016e801e4af4b6146b` | 11-26-series early baseline (superseded numbering, created on 11-25) |
| v-baseline-2026-11-26-d | `505406e6741ce425202c43db7d32dcf4bbddac90` | back-end extraction chain step 6: sampling into req_args + flaky fix + app_utils self-describing index (--full all green) |
| v-baseline-2026-11-26-e | `b67480a6f693fd9781ea1117262ae4ffe743c358` | zh/en double-ledger alignment + app_utils 42-symbol inventory backfill + RULES other-line landing (doc-only) |

### Rebuild commands (to restore a removed superseded-numbering tag)

```bat
git tag -a v-baseline-2026-11-26-a fcb8f9b6df5da01c0d18efc78f3068f441391748 -m "superseded 11-26-series early baseline (created on 2026-11-25, date-order mismatch)"
git tag -a v-baseline-2026-11-26-b ca99cc274415a9bb7903acd20af8d203441df347 -m "superseded 11-26-series early baseline (created on 2026-11-25, date-order mismatch)"
git tag -a v-baseline-2026-11-26-c 9d4699eed6a4fac7ffc16a016e801e4af4b6146b -m "superseded 11-26-series early baseline (created on 2026-11-25, date-order mismatch)"
git tag -a v-baseline-2026-11-26-d 505406e6741ce425202c43db7d32dcf4bbddac90 -m "baseline: sampling block extracted to req_args (byte-identical, diff test), schedule-contract flaky fixed, app_utils 42-sym/14-family doc index. Full regression --full ALL GREEN"
git tag -a v-baseline-2026-11-26-e b67480a6f693fd9781ea1117262ae4ffe743c358 -m "baseline: en ledger fully aligned to zh (11-26 series backfill + app_utils 42-symbol inventory section) + RULES other-line drift landed. Doc-only"
```

## 2026-11-25 series (cont.): current latest rollback point upgraded to s (zh ledger backfill of -r + superseded-numbering cleanup, doc-only)

This round cut named rollback point `v-baseline-2026-11-25-s` at commit `b6a1777`, locking the state right after “the zh ledger backfilled the `-r` current-rollback-point section + registered the `2026-11-26` superseded-numbering cleanup” (doc-only: the zh ledger backfilled -r overview + the 11-26 cleanup section; no code / regression-scope change). Quick regression ALL GREEN, commit `b6a1777` pushed to origin (main 0 0), ls-remote confirms tag -s deref == commit `b6a1777` is on the remote.

| tag | commit | nature |
|---|---|---|
| v-baseline-2026-11-25-s | `b6a177736e4c5cd510a4e6dec4df305eddce05da` | zh ledger backfill of -r current-rollback-point section + registration of the 2026-11-26 superseded-numbering cleanup (doc-only; quick regression ALL GREEN; confirmed on remote via ls-remote) |

**On the remote**: already on the remote (this round pushed origin main + pushed v-baseline-2026-11-25-s alone, main 0 0 synced, ls-remote hits tag -s deref == `b6a1777`).

### Rebuild command (to restore named rollback point s)

```bat
git tag -a v-baseline-2026-11-25-s b6a177736e4c5cd510a4e6dec4df305eddce05da -m "baseline: lock rollback point at b6a1777 (zh ledger backfill of -r + 2026-11-26 superseded-numbering cleanup; doc-only; quick regression ALL GREEN)"
```

## 2026-11-25 series (cont.): current latest rollback point upgraded to t (en ledger synced to zh, doc-only)

This round cut named rollback point `v-baseline-2026-11-25-t` at commit `798a3d0`, locking the “en ledger fully aligned to zh” point: the en ledger synced to zh — backfilled the `-r` current-rollback-point section (zh/en overviews both upgraded to `-r`) + the `2026-11-26` superseded-numbering cleanup section, making the zh/en ledgers fully aligned (doc-only; no code / regression-scope change). Quick regression ALL GREEN, commit `798a3d0` pushed to origin (main 0 0), ls-remote confirms tag -t deref == commit `798a3d0` is on the remote.

| tag | commit | nature |
|---|---|---|
| v-baseline-2026-11-25-t | `798a3d0747b86e7fe23960c46f02fa8fe0bc2ae8` | en ledger synced to zh: backfilled -r section + 2026-11-26 cleanup section so zh/en fully aligned (doc-only; quick regression ALL GREEN; confirmed on remote via ls-remote) |

**On the remote**: already on the remote (this round pushed origin v-baseline-2026-11-25-t, ls-remote hits tag -t deref == `798a3d0`).

### Rebuild command (to restore named rollback point t)

```bat
git tag -a v-baseline-2026-11-25-t 798a3d0747b86e7fe23960c46f02fa8fe0bc2ae8 -m "baseline: lock rollback point at 798a3d0 (en ledger synced to zh: -r current-rollback-point + 2026-11-26 cleanup backfilled; doc-only; quick regression ALL GREEN)"
```
## 2026-11-25 series (cont.): current latest rollback point upgraded to u (README gate-anchor column advanced from -g to -u, doc-only)

This round cut named rollback point `v-baseline-2026-11-25-u` at commit `4c5ade2b98c3820d1c763680b5d27de908c7068d`, locking the "README gate-anchor column full advance" point: the 13 gate-anchor table rows' "last real-green run (manual-observation anchor)" column was advanced in bulk from `v-baseline-20261113-g` (2026-11-13, anchor d7ec6ef) to `-u` (this point 4c5ade2), and the hard-coded suites count was corrected from the stale 172 to the real 292; the old `-g` series semantic note (d7ec6ef / sparkMaxBars differential lock) is kept as anchor-history, and the L323 historical prose registration is left intact as past fact. Doc-only; no code / regression-scope change.

Full regression ran on commit `4c5ade2` (the `-u` deref): of the 292 suites, **only** `tools/image_e2e_sentinel.py` flaked to FAIL because its fast-path took 62.9s > the 60s cap under 292-suite concurrent wall-clock contention; single-running that suite gave RC=0 (FAST 12.1s, ratio 0.93x), proving it is high-load jitter and not a regression from this round; the other 291 suites are green.

| tag | commit | nature |
|---|---|---|
| v-baseline-2026-11-25-u | `4c5ade2b98c3820d1c763680b5d27de908c7068d` | README gate-anchor column advanced -g to -u + suites 172 to 292 fix (doc-only; full suite 292 green except image_e2e_sentinel high-load flaky · single-run RC=0 · rest green; ls-remote confirms on remote) |

**On the remote**: already on the remote (ls-remote hits tag -u deref == `4c5ade2`; this round's single push of `-u` should be up-to-date).

### Rebuild command (to restore named rollback point u)

```bat
git tag -a v-baseline-2026-11-25-u 4c5ade2b98c3820d1c763680b5d27de908c7068d -m "baseline: lock rollback point at 4c5ade2 (README gate-anchor column advanced -g to -u; suites 172 to 292; doc-only; full suite 292 green except image_e2e_sentinel high-load flaky single-run RC=0)"
```
## 2026-11-26 series: current latest rollback point upgraded to a (doc-advance rollback point b673877, doc-only)

This round cut named rollback point `v-baseline-2026-11-26-a` at commit `b673877e09ea7f846e658e45f4a8807ec51e700b`, locking the state landed by commit b673877 (the README gate-anchor column -g to -u advance + the zh/en ledger -u section backfill).
This tag was created under the true date 2026-11-26 01:54, continuing after the previously cleaned-up 11-26 superseded numbers (old d/e); it is the first surviving 11-26 number, no superseded-numbering conflict. Doc-only; no code / regression-scope change; commit `b673877` pushed to origin (main and origin in 0 0 sync).

| tag | commit | nature |
|---|---|---|
| v-baseline-2026-11-26-a | `b673877e09ea7f846e658e45f4a8807ec51e700b` | doc-advance rollback point: b673877 (anchor column -g to -u + ledger -u section backfilled); doc-only; single-push of this tag ls-remote confirms on remote |

**On the remote**: this round pushed origin v-baseline-2026-11-26-a (new tag), ls-remote hits deref == `b673877`.

### Rebuild command (to restore named rollback point a)

```bat
git tag -a v-baseline-2026-11-26-a b673877e09ea7f846e658e45f4a8807ec51e700b -m "baseline: lock doc-advance rollback point at b673877 (v-baseline-2026-11-25-u gate-anchor column -g to -u landed + ledger -u section backfilled; doc-only)"
```
## 2026-11-26 series: current latest rollback point upgraded to b (CHANGELOG doc commit 395b479, doc-only)

This round cut named rollback point `v-baseline-2026-11-26-b` at commit `395b4798d0875851b9eb2e646ee0fdaf5d285416`, locking the state landed by commit 395b479 (the CHANGELOG Unreleased-section backfill of the v-baseline-2026-11-26-a milestone + the image_e2e_sentinel cap 60s to 75s flaky root-cause fix).
This tag was created under the true date 2026-11-26, the 2nd surviving 11-26 number (continuing after a), no superseded-numbering conflict; main already in 0 0 sync, single-push of this tag. Doc-only; no code / regression-scope change.

| tag | commit | nature |
|---|---|---|
| v-baseline-2026-11-26-b | `395b4798d0875851b9eb2e646ee0fdaf5d285416` | CHANGELOG doc commit rollback point: 395b479 (Unreleased section backfills the -a milestone + sentinel cap 60 to 75s); doc-only; single-push of this tag ls-remote confirms on remote |

**On the remote**: this round pushed origin v-baseline-2026-11-26-b (new tag), ls-remote hits deref == `395b479`.

### Rebuild command (to restore named rollback point b)

```bat
git tag -a v-baseline-2026-11-26-b 395b4798d0875851b9eb2e646ee0fdaf5d285416 -m "baseline: lock CHANGELOG-doc commit 395b479 (changelog logs v-baseline-2026-11-26-a + image_e2e_sentinel cap 60s to 75s; doc-only)"
```
## 2026-11-26 series: current latest rollback point upgraded to c (chore roots-reorder landing at 22c6ef4, clean all-green point)

This round cut named rollback point `v-baseline-2026-11-26-c` at commit `22c6ef4e5c963de7af65af40465cbdedf5239ae0`, locking the clean all-green state of the -b ledger-backfill doc commit (fb81124) plus the other-line chore that reordered the fs_allowed_roots whitelist entry (landed as 22c6ef4).
This tag was created under the true date 2026-11-26, the 3rd surviving 11-26 number (continuing after a/b), no superseded-numbering conflict; main already in 0 0 sync, single-push of this tag.

**Regression proof**: tools/run_tests.py --full **268 suites ALL GREEN** (incl. all live suites); the post-green rollback verify checked out tag -b(395b479) also ALL GREEN then restored to main; tree clean, main in 0 0 sync.

| tag | commit | nature |
|---|---|---|
| v-baseline-2026-11-26-c | `22c6ef4e5c963de7af65af40465cbdedf5239ae0` | clean all-green point: 22c6ef4 (the -b ledger-backfill doc commit fb81124 + the chore roots whitelist reorder landing); tools/run_tests.py --full 268 suites ALL GREEN (incl. live), post-green -b verify green; main 0 0; single-push of this tag ls-remote peel confirms on remote |

**On the remote**: this round pushed origin v-baseline-2026-11-26-c (new tag), ls-remote peel == `22c6ef4`.

### Rebuild command (to restore named rollback point c)

```bat
git tag -a v-baseline-2026-11-26-c 22c6ef4e5c963de7af65af40465cbdedf5239ae0 -m "baseline: lock clean all-green point at 22c6ef4 (chore roots reorder landed on top of fb81124 ledger backfill; tools/run_tests.py --full 268 suites ALL GREEN incl live; post-green -b rollback verify green; tree clean; main in 0 0 sync)"
```
## 2026-11-26 series: current latest rollback point upgraded to d (ledger-backfill -c doc commit 62db181, speed-view -c parity point, doc-only)

This round cut named rollback point `v-baseline-2026-11-26-d` at commit `62db181122091cc541a5f6e074187b1b0d54e517` (the doc commit where the ledger speed-view header/body/list were all upgraded to -c), locking the doc-consistency state where the archive speed-view three elements are all -c and every -a/-b/-c section table-row commit equals the git deref truth, i.e. the state locked by commit 62db181 (doc-only).
This tag was created under the true date 2026-11-26, the 4th surviving 11-26 number (continuing after a/b/c; the previously cleaned-up old d/e superseded numbers point to different commits and no longer exist); main was in 0 0 sync at the time, single-push of this tag.

**Note**: `-d` anchors the ledger-backfill doc commit 62db181 (not HEAD, not the all-green regression point 22c6ef4); it embodies the convention of cutting a tag to anchor the parity point each time the ledger speed-view is bumped.

| tag | commit | nature |
|---|---|---|
| v-baseline-2026-11-26-d | `62db181122091cc541a5f6e074187b1b0d54e517` | ledger speed-view -c parity point: 62db181 (the doc commit where the -c speed-view three elements are synced and each section table-row equals the deref truth); doc-only; main 0 0 at the time; single-push of this tag ls-remote peel==`62db181` confirms on remote |

**On the remote**: this round pushed origin v-baseline-2026-11-26-d (new tag), ls-remote peel == `62db181`.

### Rebuild command (to restore named rollback point d)

```bat
git tag -a v-baseline-2026-11-26-d 62db181122091cc541a5f6e074187b1b0d54e517 -m "baseline: lock ledger-speed-view -c parity at 62db181 (archive zh+en speed-view header/body/list all upgraded to -c; each -a/-b/-c section table-row commit == git deref truth; data-driven parity recheck PARITY OK; doc-only)"
```

## 2026-11-26 series: current latest rollback point upgraded to f (askConfirm focus-trap + B5 a11y gate atomic point c1680a0, all-green)

This round cut the named rollback point `v-baseline-2026-11-26-f` at commit `c1680a0271c5ba8fe1a97c5d807d8185a0baa24f`, locking the atomic feature point of "native confirm fully migrated to askConfirm + focus trap (remembers opener / Tab and Shift+Tab kept inside the dialog / focus restored on close) + B5 jsdom a11y gate"; the full --full regression was ALL GREEN (RC=0, no flaky). Feature code and its regression lock were amended into a single commit, so the rollback point is atomic.
The tag was cut under the true date 2026-11-26, continuing after a/b/c/d (the ledger's existing newest registered entry was d; this round only appends the -f section).

| tag | commit | nature |
|---|---|---|
| v-baseline-2026-11-26-f | `c1680a0271c5ba8fe1a97c5d807d8185a0baa24f` | focus-trap + B5 a11y gate atomic point: c1680a0 (askConfirm focus trap + test_ask_confirm_jsdom.mjs B5 Tab-stays-inside / close-restore-opener); --full ALL GREEN |

**On the remote**: this round pushed origin main then single-pushed `git push origin v-baseline-2026-11-26-f`; main in 0 0 sync, ls-remote peel == `c1680a0`.

### Rebuild command (to restore named rollback point f)

```bat
git tag -a v-baseline-2026-11-26-f c1680a0271c5ba8fe1a97c5d807d8185a0baa24f -m "baseline: askConfirm focus-trap + B5 a11y gate (atomic, all-green)"
```
