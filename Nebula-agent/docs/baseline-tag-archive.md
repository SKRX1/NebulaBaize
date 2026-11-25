# 基线 Tag 归档账本 · Baseline Tag Archive

> **简体中文** | [English](baseline-tag-archive.en.md)

本文件登记「已被后续基线覆盖、予以清理」的 `v-baseline-*` 附注 tag，记录其指向的 commit，
以便随时精确重建。判据：被删 tag 指向的 commit 全部是 HEAD（master）的祖先（`git merge-base
--is-ancestor` 逐一坐实），故删 tag **不丢任何 commit**——master 链已含它们；tag 仅是命名指针，
按下方命令即可重建。旧 bundle（E/F 盘各保留最新 14 份）亦含这些 tag，clone 旧 bundle 同样可恢复。

## 当前回滚点（速览 · 以本节为准）

> 当前最新回滚点 = `v-baseline-2026-11-25-r`
> （commit `835dad49e1b1f52af17bb96cf8c840c32a4d948d`，WorkBuddy 痕迹清理：137 个测试 createRequire 锚点 + 展示文案 + node/python 兜底路径统一到系统 nodejs；quick 全套回归 ALL GREEN、commit `835dad4` 已推 origin、ls-remote 坐实 `-r` 已在远端）。
> 下方各章节标题里的「当前回滚点 / 当前最新回滚点」字样，是打该 tag 当时的历史快照（11-21-i、11-22-d、11-23-c、11-24-f、11-25-n/o/p/q/r、11-26-d/e … 各为其当时最新基线）；凡与本速览不一致，一律以本节（最新 = 11-25-r）为准。

## 2026-11-21 系列清理（保留 -h = v0.1.0 当前回滚点）

2026-11-21 当天密集打了 a~h 共 8 个全绿里程碑 tag，构成一条线性链；`-h`（HEAD 93e4727，
v0.1.0 角标定稿点）作为当天最新代表与当前回滚点保留，a~g 为被后续基线覆盖的旧点，予以清理。

| 已删 tag | 指向 commit | 当日语义 |
|---|---|---|
| v-baseline-2026-11-21-a | 99cdc009d03fd4043e29631b4243037dc8d4d2c5 | sidebar all-hidden 回归修复（decouple sidebarTabs from sampling） |
| v-baseline-2026-11-21-b | b7e338c43b00e9e0abbb31dea241e5af25e4063b | watchdog xplat register + content=None wire normalize |
| v-baseline-2026-11-21-c | bd12c55fac31e73079a95912a895d925898f90d9 | watchdog 8099 relaunch interval 10s->5s |
| v-baseline-2026-11-21-d | b0cd5b6e2822a3485028c7863b94351890b6e758 | CHECK_INTERVAL==5 pinned in watchdog gate |
| v-baseline-2026-11-21-e | 041a3e904ae2e2caecd631ce7b3a71107f08d55a | fs_allowed_roots 3 dirs landed from stale stash@1 |
| v-baseline-2026-11-21-f | 31ddbbd1335beb109d737a7f56832af2991dc21b | workspace tail-drop + reset-order |
| v-baseline-2026-11-21-g | 72d7ac21bf608d1f5a5e26567e4eabd7e2d4680b | review_semantic_log trend_n=30（term1 bundle 固化） |

## 重建命令（如需恢复某个被清理的 tag）

```bat
git tag -a v-baseline-2026-11-21-a 99cdc009d03fd4043e29631b4243037dc8d4d2c5 -m "baseline rollback point @99cdc00: sidebar all-hidden regression fix + gate G root-cause lock"
git tag -a v-baseline-2026-11-21-b b7e338c43b00e9e0abbb31dea241e5af25e4063b -m "baseline: watchdog xplat register + content=None wire normalize chain"
git tag -a v-baseline-2026-11-21-c bd12c55fac31e73079a95912a895d925898f90d9 -m "baseline: watchdog 8099 relaunch interval 10s->5s"
git tag -a v-baseline-2026-11-21-d b0cd5b6e2822a3485028c7863b94351890b6e758 -m "baseline: CHECK_INTERVAL==5 pinned in watchdog gate"
git tag -a v-baseline-2026-11-21-e 041a3e904ae2e2caecd631ce7b3a71107f08d55a -m "baseline: fs_allowed_roots 3 dirs landed from stale stash@1"
git tag -a v-baseline-2026-11-21-f 31ddbbd1335beb109d737a7f56832af2991dc21b -m "baseline: workspace tail-drop + reset-order"
git tag -a v-baseline-2026-11-21-g 72d7ac21bf608d1f5a5e26567e4eabd7e2d4680b -m "baseline rollback point: review_semantic_log trend_n=30 (term1 bundle)"
```

## 2026-11-21 批量清理：2026-10-22 ~ 2026-11-20 早期系列（保留 -i 与非祖先 11-02-f）

判据：被删 tag 指向的 commit 全部是 HEAD（master）的祖先（逐 tag `merge-base --is-ancestor` 坐实 anc=0），
删 tag 不丢任何 commit；保留最新回滚点 `v-baseline-2026-11-21-i` 与非祖先 `v-baseline-2026-11-02-f`（删它会丢 commit）。

### 保留（不删）

- `v-baseline-2026-11-21-i` -> 7634820...（当前回滚点，HEAD 链最新基线）
- `v-baseline-2026-11-02-f` -> fc8ffd5fafe4ec628779ce5476e06ec37314a5ec（**非 HEAD 祖先**，删会丢 commit，故保留）：docs(rules): land this-round two propose-rules after verification (no unicode_escape in path normalization; static guards must pass differential self-proof before SUITES, ratchet baseline for known hits) - pure-doc, off-anchor

### 已清理（97 个，重建命令见下）

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



## 2026-11-22 系列：当前回滚点（保留，post-green 已坐实 WORKING ROLLBACK POINT）

本轮为 backup-bundle 回归修复的 HEAD 打新基线 `v-baseline-2026-11-22-d`，作为**当前最新回滚点**保留。
`_rollback_verify.py` 的 `latest_tag()` 走 `git tag -l --sort=-creatordate` 取首条 = 本 tag，
post-green 回环已指向此不含回归的新锚点；本回合实测 `--no-nest` 复验 **VERIFY_EXIT=0 / VERDICT:
TAG IS A WORKING ROLLBACK POINT (ALL GREEN)**，并已纳入 E/F 盘 `--all` bundle（HEAD/commit/tag 三计数全对）。

| tag（保留） | 指向 commit（40 位） | 当日语义 |
|---|---|---|
| v-baseline-2026-11-22-d | 1621c6e673622d54cfefb66b419942d55ed22aed | fix(backup-bundle): rehearse 的 branch 改 keyword-only，修回归打破 _mirror_rehearse_gate |

> 当日更早的 a/b/c 为同线早期基线，已被 -d 取代为次新（c 含该回归、d 为修复后点）；如未来清理
> a/b/c，按判据 `git merge-base --is-ancestor <commit> HEAD` 逐一坐实 anc=0 后再删，不丢任何 commit。

### 重建命令（如需精确恢复当前回滚点 d）

```bat
git tag -a v-baseline-2026-11-22-d 1621c6e673622d54cfefb66b419942d55ed22aed -m "baseline: backup-bundle rehearse branch keyword-only fix, mirror_rehearse_gate green (post-green anchor without the regression)"
```


## 2026-11-22 系列（继）：当前最新回滚点升级为 e（保留）

本轮为「全套文档中文默认化定稿」的 HEAD 打新基线 `v-baseline-2026-11-22-e`，
作为**当前最新回滚点**保留；它取代上方 -d 成为最新基线（-d 退为次新）。
本轮为纯文档改动（README/CONTRIBUTING/MEMORY-GUIDE/部署说明 中文默认 + .en 对照，
README 顶栏语言切换规范）；已验证：链接可达、CRLF 统一、远端裸名 README.md 为中文默认、
全套代码回归未受文档改名影响 ALL GREEN。

| tag（保留） | 指向 commit（40 位） | 当日语义 |
|---|---|---|
| v-baseline-2026-11-22-e | d9d6b1d1f51a8050d311738fe6f8fe2529d63d44 | docs(readme): 顶栏补语言切换规范提示（全套文档中文默认化定稿点） |

### 重建命令（如需精确恢复当前回滚点 e）

```bat
git tag -a v-baseline-2026-11-22-e d9d6b1d1f51a8050d311738fe6f8fe2529d63d44 -m "baseline: docs full Chinese-default restructure (README/CONTRIBUTING/MEMORY-GUIDE/部署说明 = zh default + .en counterparts), README topbar language-switch norm; verified: links reachable, CRLF uniform, remote README.md zh-default confirmed"
```


## 2026-11-23 系列：当前最新回滚点升级为 c（保留）

本轮为「setup 白名单自动重置能力」的 HEAD 打新基线 `v-baseline-2026-11-23-c`，
作为**当前最新回滚点**保留；它取代上方 11-22-e 成为最新基线（11-22 系列退为历史次新）。
本轮已实测：setup_env.py 新增 module 级纯函数 reset_fs_allowed_roots + 抽出 backup_once（一次性备份），
由 test_setup_backup_lock 锁定；全套回归 ALL GREEN；main 已同步 origin（ahead/behind 0 0），
并按铁律「先 main 后单 tag」把 -c 单独推上远端（远端仅新增此一个 tag）。

| tag（保留） | 指向 commit（40 位） | 当日语义 |
|---|---|---|
| v-baseline-2026-11-23-c | c64de97067f543e7ff6698090eb80727e99121de | setup: fs 白名单自动重置 + 一次性 backup_once（reset_fs_allowed_roots / --keep-roots，setup.bat 转发 %*、setup.sh 转发 "$@"），test_setup_backup_lock 锁定 |

### 重建命令（如需精确恢复当前回滚点 c）

```bat
git tag -a v-baseline-2026-11-23-c c64de97067f543e7ff6698090eb80727e99121de -m "baseline: setup fs-allowlist auto-reset + one-shot backup_once (reset_fs_allowed_roots / --keep-roots; setup.bat forwards %* / setup.sh forwards \"$@\"; test_setup_backup_lock), full suite ALL GREEN, main synced to origin"
```

## 2026-11-24 系列：当前最新回滚点升级为 e（保留）

本轮为「别线 RULES.md 未落账记忆独立 chore 落账」的 HEAD 打新基线 `v-baseline-2026-11-24-e`，
作为**当前最新回滚点**保留；它取代上方 11-23-c 成为最新基线（11-23 系列退为历史次新）。
本轮为纯文档落账（仅 RULES.md 追加 2 条记忆规则：harness 脚本 in-place 改写保 CRLF、
SUITES 登记前先单跑计时定档），工作树落账后转干净；已按铁律「先 main 后单 tag」把 main 推上
origin 坐实 0 0，再把 `-e` 单独推上远端（远端仅新增此一个 tag），并纳入 E/F 双盘 `--all` bundle
（HEAD=0dd37be、commit/tag 三计数全对、main 可达、clone 演练复现）。

| tag（保留） | 指向 commit（40 位） | 当日语义 |
|---|---|---|
| v-baseline-2026-11-24-e | 0dd37be4085fe4fb4d0de48dc99dd88460867f4d | chore(rules): land 2 pending memory rules from prior line (harness CRLF in-place rewrite; SUITES timing gate) |

### 重建命令（如需精确恢复当前回滚点 e）

```bat
git tag -a v-baseline-2026-11-24-e 0dd37be4085fe4fb4d0de48dc99dd88460867f4d -m "v-baseline 2026-11-24-e: chore(rules) land 2 pending memory rules from prior line. Clean working tree at HEAD 0dd37be; doc-only landing, no code change."
```

## 2026-11-24 系列（继）：当前最新回滚点升级为 f（保留）

本轮为「采样抽屉快照上报接线 + 别线 RULES.md 未落账记忆独立 chore 落账」的 HEAD 打新基线
`v-baseline-2026-11-24-f`，作为**当前最新回滚点**保留；它取代上方 11-24-e 成为最新基线（11-24-e 退为次新）。
本轮含代码改动（app.js 新增 `reportSampling()`，boot 期与 s-apply 提交后各上报一次采样配置快照；
http_server.py 新增 `SAMPLING_SNAPSHOT` 落盘路径 + `_api_sampling_snapshot` 处理器 + 路由分支）+ 新静态接线
门禁 `tests/test_sampling_snapshot_wiring.mjs`（13/13，含 2 条 decoy 差分证 load-bearing）登记 SUITES 主区；
并独立 chore 落账别线 RULES.md 2 条（PowerShell 写含中文 py 落 GBK、win32com `NameSpace(10)` 大写 S）。
已实测：新门禁单跑 13/13 PASS；全套回归（含 post-green）ALL GREEN，post-green `VERDICT: TAG IS A WORKING
ROLLBACK POINT (ALL GREEN)`；numstat==--ignore-cr-at-eol 零行尾污染；按铁律「先 main 后单 tag」先把 main
推上 origin 坐实 0 0，再把 `-f` 单独推上远端（`git ls-remote v-baseline-2026-11-24-f^{}=df7b012` 解引用坐实），
并纳入 E/F 双盘 `--all` bundle（最新 bundle 两盘逐字节一致 MD5 同、HEAD/commit/tag 三计数全对、main 可达、clone 演练复现）。

| tag（保留） | 指向 commit（40 位） | 当日语义 |
|---|---|---|
| v-baseline-2026-11-24-f | df7b012448792ef6debee1d1f562c69b8fdf25b1 | feat(sampling): 采样抽屉快照上报接线 + 后端 /api/sampling-snapshot 落盘点 + 别线 RULES.md 落账（全绿锚点） |

### 重建命令（如需精确恢复当前回滚点 f）

```bat
git tag -a v-baseline-2026-11-24-f df7b012448792ef6debee1d1f562c69b8fdf25b1 -m "baseline 2026-11-24-f: sampling drawer snapshot wiring (reportSampling + /api/sampling-snapshot) + prior-line RULES landing; full regression incl. post-green ALL GREEN (VERDICT=WORKING ROLLBACK POINT); main synced to origin; single tag pushed; E/F bundle byte-identical"
```

## 2026-11-24 系列（继2）：新增命名回滚点 g（账本登记 commit，保留）

本轮为「账本登记 commit `de62e1e`」补打命名回滚点 `v-baseline-2026-11-24-g`（此前已打的 `-f` 指向
其父 commit `df7b012`，`-g` 把"账本同步点"本身也纳入命名回滚点）。`de62e1e` 为纯文档登记 commit
（仅 baseline-tag-archive.md 追加 -f 当前回滚点节），无代码改动；已实测：它是上一轮 bundle
`strata-bundle-20261124-185904` 的权威 HEAD（HEAD/commits=825/tags=73/main 可达 四计数全对、clone
演练复现），`origin/main` 已同步至 `de62e1e`（`0 0`）。本轮把 `-g` 单推 origin（main 已就绪，仅新增
此一个 tag），再登记进本账本，并随后 push + bundle 滚动固化（让 `-g` 进新一轮 E/F 双盘 bundle）。

| tag（保留） | 指向 commit（40 位） | 当日语义 |
|---|---|---|
| v-baseline-2026-11-24-g | de62e1eeaaa322c05381c6da396fe9dd0c4bead3 | docs(ledger): register -f as current rollback point（账本登记点本身命名为回滚点；doc-only；已作 bundle 权威 HEAD 四计数全对+clone 演练复现） |

### 重建命令（如需精确恢复命名回滚点 g）

```bat
git tag -a v-baseline-2026-11-24-g de62e1eeaaa322c05381c6da396fe9dd0c4bead3 -m "baseline 2026-11-24-g: ledger-sync commit de62e1e (register v-baseline-2026-11-24-f as current rollback point). Doc-only; captured as authoritative HEAD of E/F bundle strata-bundle-20261124-185904 (four-counts OK + clone-rehearsal); origin/main synced to de62e1e."
```


## 2026-11-24 系列（继 3）：补登命名回滚点 h（消除账本 g→b 断层）

本轮补登此前已打但本账本当时未登记的命名回滚点 `v-baseline-2026-11-24-h`（其时账本停在 `-g`）。
`-h` 为纯代码功能锚点 `feat(auto-resume)`：early-done 续跑通道增「悬空 narration」子类，无 plan 块也能续跑被打断的承诺。
其 tag message 自述：同 anchor `78c5142` 曾有的 `v-baseline-2026-11-27-a` 已被删除并由 `-h` 取代（历史事实，如实记录）；
本轮据 `git merge-base --is-ancestor` 坐实 anc=0 在 HEAD 链上，补登仅为账本与 tag 历史对齐，不改动该 commit 本身。

| tag（保留） | 指向 commit（40 位） | 当日语义 |
|---|---|---|
| v-baseline-2026-11-24-h | 78c5142387c55e2ccff522f6fe49ff9c6cfb6a87 | feat(auto-resume): early-done lane 增「悬空 narration」子类，无 plan 块也能续跑被打断的承诺 |

### 重建命令（如需精确恢复命名回滚点 h）

```bat
git tag -a v-baseline-2026-11-24-h 78c5142387c55e2ccff522f6fe49ff9c6cfb6a87 -m "baseline (real-date aligned): early-done narration sub-lane at 78c5142 (pushed to origin/main). Sole rollback anchor: SUPERSEDES and replaces the now-deleted v-baseline-2026-11-27-a (same anchor 78c5142). local only, not pushed, per repo convention."
```

## 2026-11-25 系列（前序）：补登命名回滚点 a（消除账本断层）

本轮补登此前已打但本账本当时未登记的命名回滚点 `v-baseline-2026-11-25-a`（其时账本停在 `-g`）。
`-a` 锚点 `fix(models)`：为选中本地模型 `qwen3.8-flash-next-iq3_s` 声明 context_window 131072（kind=local + 空 base_url
模型须在 config/models.json 声明 context_window，否则后端 ctx_window() 回退探测与前端分母不一致致低占用误判 overflow）。
本轮据 `git merge-base --is-ancestor` 坐实 anc=0 在 HEAD 链上；`-a` 已在 origin 远端。补登仅为账本与 tag 历史对齐。

| tag（保留） | 指向 commit（40 位） | 当日语义 |
|---|---|---|
| v-baseline-2026-11-25-a | e73c3d5321e93d8cb9f59c2a7c04937e15a5f585 | fix(models): declare context_window 131072 for selected local model qwen3.8-flash-next-iq3_s（含 RULES 规则：local+空 base_url 模型必须声明 context_window） |

### 重建命令（如需精确恢复命名回滚点 a）

```bat
git tag -a v-baseline-2026-11-25-a e73c3d5321e93d8cb9f59c2a7c04937e15a5f585 -m "v-baseline 2026-11-25-a: fix(models) ctx_window 131072 for qwen3.8-flash-next-iq3_s"
```

## 2026-11-25 系列：当前回滚点（保留）

本轮为 `chore(config) models.json 运行态漂移落账` 的 HEAD `ab58007` 打新基线 `v-baseline-2026-11-25-b`，
作为**当前最新回滚点**保留（取代此前已打 tag 但本账本当时未登记的 `-h` / `-a`）。
本轮已实测：`git fsck --full` 对象库健康（仅 dangling，无 missing/broken/fatal）；E/F 双盘 bundle
`strata-bundle-20261125-002954` 共有 14 份逐名 MD5 全一致、无镜像分叉；`origin/main` 已快进同步至 `ab58007`
（`0 0`），`-b` 已单推 origin（`* [new tag]`，解引用 commit `ab58007`）。

| tag（保留） | 指向 commit（40 位） | 当日语义 |
|---|---|---|
| v-baseline-2026-11-25-b | ab580073b2a5fb2dfcf4f39697112fb4ab2f0153 | chore(config): models.json daemon 运行态漂移落账（模型列表重排 + 补全 ctx_in/context_window）；fsck 健康 + E/F bundle 字节一致 + origin/main 已同步 |

### 重建命令（如需精确恢复命名回滚点 b）

```bat
git tag -a v-baseline-2026-11-25-b ab580073b2a5fb2dfcf4f39697112fb4ab2f0153 -m "baseline 2026-11-25-b: chore(config) models.json drift landing at ab58007. Verified this round: git fsck --full clean (only dangling, no missing/broken/fatal); E/F bundle strata-bundle-20261125-002954 byte-identical both drives (14 common MD5 all OK); origin/main synced to ab58007 (0 0)."
```

## 2026-11-25 系列（继）：补登命名回滚点 c（账本登记 commit 本身作回滚点，对齐 a/b/c）

本轮补登命名回滚点 `v-baseline-2026-11-25-c`，指向上一登记 commit `ea2d93d` 本身，沿用 `-g`
「账本登记点本身命名作回滚点」惯例，让登记 commit 也成为命名回滚点。`ea2d93d` 为纯文档登记 commit
（仅本账本追加 `-b` 当前回滚点节），无代码改动。本轮补登使本「2026-11-25 系列」小节的 a/b/c 三 tag 完全对齐。
`-c` 为本地 tag（按仓库惯例未自动推 origin，远端同步留待主人另行拍板）。

| tag（保留） | 指向 commit（40 位） | 当日语义 |
|---|---|---|
| v-baseline-2026-11-25-c | ea2d93dbca09451fd6c41784198f01966cba47a3 | docs(ledger): register v-baseline-2026-11-25-b as current rollback point（账本登记 commit ea2d93d 本身命名作回滚点；doc-only；对齐 a/b/c 三 tag） |

### 重建命令（如需精确恢复命名回滚点 c）

```bat
git tag -a v-baseline-2026-11-25-c ea2d93dbca09451fd6c41784198f01966cba47a3 -m "baseline 2026-11-25-c: ledger-sync commit ea2d93d (register v-baseline-2026-11-25-b as current rollback point, models.json drift @ab58007). Doc-only; naming the ledger-registration commit itself as a rollback point, per the -g convention."
```
## 2026-11-25 系列（续）：当前回滚点 e（classifyTool 抽离 + realpage copy-list 锁，全套绿）

本轮打命名回滚点 `v-baseline-2026-11-25-e`，指向 commit `c6568a9`（`refactor(web): extract classifyTool+TEST_RE+FILE_TOOL_BASE into app_utils.js`）：把工具结果分类主题组（classifyTool 及私有常量 TEST_RE / FILE_TOOL_BASE）从 app.js 整搬进 app_utils.js（连常量同搬、调用点 app.js 不变、靠 app_utils 先于 app.js 加载共享全局）。随抽离同步更新四个 harness（contract/jsdom 导出与实测、autoverify boot 拼接、realpage 复制清单补 app_utils.js）。本轮实测全套回归 ALL GREEN。

`-e` 为 annotated tag，按主人拍板 push origin main 后单独 `git push origin v-baseline-2026-11-25-e` 推到远端（已在远端）。后续 de4fe16（realpage copy-list 契约锁）已另 push 使 origin/main 前进，但 `-e` 仍锁 c6568a9 不变。

| tag（保留） | 指向 commit（40 位） | 当日语义 |
|---|---|---|
| v-baseline-2026-11-25-e | c6568a9d72fb57a70dafdea85ca4a6608c97f820 | refactor(web): classifyTool+TEST_RE+FILE_TOOL_BASE extracted app.js→app_utils.js；连常量同搬、调用点不变；4 个 harness 同步；全套回归 ALL GREEN（已在远端） |

### 重建命令（如需精确恢复命名回滚点 e）

```bat
git tag -a v-baseline-2026-11-25-e c6568a9d72fb57a70dafdea85ca4a6608c97f820 -m "baseline: classifyTool+TEST_RE+FILE_TOOL_BASE extracted to app_utils.js; full regression ALL GREEN"
```

## 2026-11-25 系列（续）：当前回滚点 g（assembleStreamBubbles+computeWaterfall 抽离，全套绿）

本轮打命名回滚点 `v-baseline-2026-11-25-g`，指向 commit `704c3d0b5`（`refactor(web): extract assembleStreamBubbles+computeWaterfall into app_utils.js`）：把「流式/会话记录纯变换」二件套（assembleStreamBubbles 按 session 分组折叠多块气泡；computeWaterfall 把 chunk_timeline 折叠成瀑布阶段段）从 app.js 整搬进 app_utils.js，连调用点不变、靠 app_utils 先于 app.js 加载共享全局；随抽离同步 contract 导出集 + test_session_stream / test_stream_debug 两 harness。chipForBackspace 经研判依赖真 DOM 未搬。本轮实测全套回归 ALL GREEN。

`-g` 为 annotated tag，按主人拍板 push origin main 后单独 `git push origin v-baseline-2026-11-25-g` 推到远端（已在远端）。并已 `git bundle --keep 14` 把含 -f/-g 的回滚点固化进 E/F 双盘（HEAD 704c3d0→82 tag 一致、clone 演练通过）。

| tag（保留） | 指向 commit（40 位） | 当日语义 |
|---|---|---|
| v-baseline-2026-11-25-e | c6568a9d72fb57a70dafdea85ca4a6608c97f820 | refactor(web): classifyTool 抽离 + realpage copy-list 锁 |
| v-baseline-2026-11-25-f | e458249170c1a382efde04d13ff393d9332be213 | refactor(web): think 流三件套 snapSent+toolSeq+noteStreamPhase 抽离 |
| v-baseline-2026-11-25-g | 704c3d0b5c8e506247c338860ea80e68cb621212 | refactor(web): 流式记录二件套 assembleStreamBubbles+computeWaterfall 抽离 |

续抽落账点 `df0bc32f5`（`refactor(web): extract nebTaskFromTool+inflightToolName into app_utils.js`）是 `-g` 的下一代 commit（工具/任务名纯解析二件套），暂未打 tag、未单独 bundle，已在 main+远端，留作下一个 baseline 候选。

### 重建命令（如需精确恢复命名回滚点 g）

```bat
git tag -a v-baseline-2026-11-25-g 704c3d0b5c8e506247c338860ea80e68cb621212 -m "baseline: stream-record duo extracted to app_utils.js; full regression ALL GREEN"
```

## 2026-11-25 系列（续）：当前最新回滚点升级为 k（后端模块化第一步：serve/tokenizer.py，全套绿）

本轮打命名回滚点 `v-baseline-2026-11-25-k`，指向 commit `f4f7d4d75`（`refactor(serve): extract tokenizer
family out of server.py into serve/tokenizer.py`）：把 7,290 行单体 `serve/server.py` 里彼此零耦合的「增量解码
+ 停止串」一族（ByteTokenizer / Detokenizer / stop_strings + OPENAI_MAX_STOP / StopMatcher）整搬进新模块
`serve/tokenizer.py`，仅依赖 stdlib codecs、无 server 全局；调用点保持原名经 try/except import 兜回。随抽离
在 `test_pure_modules.py` 加第 12 个纯模块（3 个 load-bearing 测试）并在 CHANGELOG 补 Changed 条目（中英）。
本轮实测全套回归 ALL GREEN。这是抽离链自 app_utils（前端 app.js）转向**后端 server.py** 的第一个命名回滚点。
取代此前未及逐一登记的本日历史点（-h v0.1.0 角标、-i mdmedia+compact 链、-j spark 族）成为当前最新回滚点。

| tag | commit | 性质 |
|---|---|---|
| v-baseline-2026-11-25-k | `f4f7d4d753f6ba1be6aa9964c7fff5ca15b070eb` | refactor(serve): tokenizer 族抽离（后端模块化第一步；全套回归 ALL GREEN；已实测 ls-remote 在远端） |

**是否已在远端**：已在远端（本轮 push origin main + push origin v-baseline-2026-11-25-k，main 0 0 同步，
ls-remote 命中 tag -k；bundle `strata-bundle-20261125-135313` 已含 -k，E/F 双盘 clone 演练复现）。

### 重建命令（如需精确恢复命名回滚点 k）

```bat
git tag -a v-baseline-2026-11-25-k f4f7d4d753f6ba1be6aa9964c7fff5ca15b070eb -m "baseline: lock rollback point at f4f7d4d (first back-end extraction: serve/tokenizer.py family); full regression ALL GREEN"
```

## 2026-11-25 系列（续）：当前最新回滚点升级为 l（后端模块化第二步：serve/approval.py，全套绿）

本轮打命名回滚点 `v-baseline-2026-11-25-l`，指向 commit `5f136f1a2`（`refactor(serve): extract approval
family out of server.py into serve/approval.py`）：把 serve/server.py 里彼此零耦合的「工具审批策略」一族
（_DESTRUCTIVE_SHELL / _DESTRUCTIVE_SYMBOLS / _APPROVAL_TOOLS / _needs_approval / _auto_deny / _approval_desc）
整搬进新模块 `serve/approval.py`，仅依赖 stdlib json + re、无 server 全局；`_PERM_TIERS` 留下，调用点保持原名
经 try/except import 兜回。随抽离把 tests/test_registry_server.py 的 approval.yaml↔frozenset 文本对账抓取源由
server.py 改到 approval.py（load-bearing），并在 test_pure_modules.py 加第 13 个纯模块（3 个 load-bearing 测试）。
本轮实测全套回归 ALL GREEN。这是抽离链后端 server.py 的第二个命名回滚点（继 -k tokenizer 之后）。

| tag | commit | 性质 |
|---|---|---|
| v-baseline-2026-11-25-l | `5f136f1a2c24ea90725827726731ccb9e4115510` | refactor(serve): approval 族抽离（后端模块化第二步；全套回归 ALL GREEN；已实测 ls-remote 在远端） |

**是否已在远端**：已在远端（本轮 push origin main + push origin v-baseline-2026-11-25-l，main 0 0 同步，
ls-remote 命中 tag -l；bundle `strata-bundle-20261125-143554` 已含 -l，E/F 双盘 clone 演练复现）。

### 重建命令（如需精确恢复命名回滚点 l）

```bat
git tag -a v-baseline-2026-11-25-l 5f136f1a2c24ea90725827726731ccb9e4115510 -m "baseline: lock rollback point at 5f136f1 (second back-end extraction: serve/approval.py family); full regression ALL GREEN"
```

## 2026-11-25 系列（续）：当前最新回滚点升级为 m（后端模块化第三步：serve/conv_cache.py + bump 0.1.1-rc.1，全套绿）

本轮打命名回滚点 `v-baseline-2026-11-25-m`，指向 commit `be31910`（`feat(serve): extract conv_cache family
into serve/conv_cache.py + bump 0.1.1-rc.1`）：把 serve/server.py 里彼此零耦合的「会话缓存日志读取」一族
（`ConvCacheLog` 引擎 stderr 日志读取器 + `conversation_cache_view` Monitor 卡片组装）整搬进新模块
`serve/conv_cache.py`，仅依赖 stdlib os/re/time、无 server 全局；调用点保持原名经 try/except import 兜回，
无文本正则抓取源牵连（引用仅 server.py 两处调用点）；test_pure_modules.py 加第 14 个纯模块（2 个
load-bearing 测试）。同轮把 [Unreleased] 已验证内容固化进 CHANGELOG 新段 [0.1.1-rc.1] - 2026-11-25，并同步
bump VERSION 0.1.0 -> 0.1.1-rc.1（后端 /api/version 单源读 VERSION）与 index.html 静态兜底角标。本轮实测
全套回归 ALL GREEN。这是抽离链后端 server.py 的第三个命名回滚点（继 -k tokenizer、-l approval 之后）。

| tag | commit | 性质 |
|---|---|---|
| v-baseline-2026-11-25-m | `be319105105fb8ecdcdca802df8d41a9e16d5a76` | feat(serve): conv_cache 族抽离 + bump 0.1.1-rc.1（后端模块化第三步；全套回归 ALL GREEN；已实测 ls-remote 在远端） |

**是否已在远端**：已在远端（本轮 push origin main + push origin v-baseline-2026-11-25-m，main 0 0 同步，
ls-remote 命中 tag -m；bundle `strata-bundle-20261125-150412` 已含 -m，E/F 双盘 clone 演练复现）。

### 重建命令（如需精确恢复命名回滚点 m）

```bat
git tag -a v-baseline-2026-11-25-m be319105105fb8ecdcdca802df8d41a9e16d5a76 -m "baseline: lock rollback point at be31910 (3rd back-end extraction: serve/conv_cache.py; bump VERSION+CHANGELOG to 0.1.1-rc.1); full regression ALL GREEN"
```

## 2026-11-25 系列（续）：当前最新回滚点升级为 n（后端模块化第四步 serve/engine_diag.py + 模块化文档 + 固化正式发版 0.1.1，全套绿）

本轮打命名回滚点 `v-baseline-2026-11-25-n`，指向 commit `29e1f10`（release 0.1.1）：本轮含两笔——
`23c1588` 把 serve/server.py 里彼此零耦合的「引擎退出状态/启动日志诊断」一族（`start_failure_hint` /
`engine_exit_words` / `engine_crashed` / `start_log_marks` 四纯函数 + `DRAFT_HEAD_FAIL` / `DRAFT_HEAD_HINT` /
`_WIN_CRASH` / `TRANSIENT_START_MARKS` 四常量连搬）整搬进新模块 `serve/engine_diag.py`（仅 stdlib os/signal，
无 server 全局；try/except import 兜回），test_pure_modules.py 加第 15 个纯模块，并新建中英对照文档
`docs/backend-modularization(.en).md` 登记抽离链全量进度；`29e1f10` 把经全套回归反复 ALL GREEN 验证稳定的
0.1.1-rc.1 去 -rc 后缀固化为正式发版 0.1.1（VERSION + index.html 角标 + CHANGELOG 段头三处同步）并打 v0.1.1
版本 tag 触发 build-release.yml CI。`cpu_isa_words` / `start_exit_note` / `START_RETRIES` / `transient_start_failure`
（启动重试与 CPU 指令集探测＝异质职责）留在 server.py。本轮实测全套回归 ALL GREEN。这是抽离链后端 server.py
的第四个命名回滚点（继 -k tokenizer、-l approval、-m conv_cache 之后），也是第一个正式发版点。

| tag | commit | 性质 |
|---|---|---|
| v-baseline-2026-11-25-n | `29e1f10b60d7ec9e44ca1d11d03eb5ef945a3882` | release 0.1.1（engine_diag 抽离 + 模块化文档 + 去 RC 固化正式发版；全套回归 ALL GREEN；已实测 ls-remote 在远端） |

**是否已在远端**：已在远端（本轮 push origin main + push origin v0.1.1 + push origin v-baseline-2026-11-25-n，
main 0 0 同步，ls-remote 命中 tag -n；bundle `strata-bundle-20261125-153044` 已含 -n，E/F 双盘 clone 演练复现）。

### 重建命令（如需精确恢复命名回滚点 n）

```bat
git tag -a v-baseline-2026-11-25-n 29e1f10b60d7ec9e44ca1d11d03eb5ef945a3882 -m "baseline: lock rollback point at 29e1f10 (4th back-end extraction serve/engine_diag.py + backend-modularization doc + cut release 0.1.1 de-RC from 0.1.1-rc.1); full regression ALL GREEN"
```

## 2026-11-25 系列（续）：当前最新回滚点升级为 o（后端模块化第五步 serve/exceptions.py 异常层级，全套绿）

本轮打命名回滚点 `v-baseline-2026-11-25-o`，指向 commit `a6afc2a`（`feat(serve): extract exception hierarchy
into serve/exceptions.py`）：把 serve/server.py 里彼此零耦合的「引擎/会话异常层级」一族（`EngineDied` /
`EngineStarting` / `ClientGone` / `ModelBusy` / `EngineSilent`（继承 EngineDied）/ `EngineNonFinite` /
`SessionRefused`（带 kind→HTTP status 属性）/ `EngineStuck` / `GpuBusy`（带 retry_after）共 9 类）整搬进新模块
`serve/exceptions.py`。它们仅继承内置 RuntimeError/Exception/ValueError 或同族成员、零 import、零 server 全局；
9 类引用全在 server.py 内、无跨文件/无测试文本抓取源牵连，调用点经 try/except 双路径 import 兜回。AST out-deps=0
扫描坐实为当前最纯最内聚的零依赖族（真实差异 server.py 4 增/63 删）。test_pure_modules.py 加第 16 个纯模块
（一测试：fatal 继承链 + ValueError vs RuntimeError 三基类互不相同差分 + kind→status 映射 + retry_after 载荷），
docs/backend-modularization(.en).md 进度表加第 16 行，三处 16 模块对账一致。本轮实测全套回归 ALL GREEN。这是
抽离链后端 server.py 的第五个命名回滚点（继 -k/-l/-m/-n 之后）。

| tag | commit | 性质 |
|---|---|---|
| v-baseline-2026-11-25-o | `a6afc2a6ee1e8ea07b5740d77814a4044d9411b6` | feat(serve): exceptions 异常层级抽离（后端模块化第五步；全套回归 ALL GREEN；已实测 ls-remote 在远端） |

**是否已在远端**：已在远端（本轮 push origin main + push origin v-baseline-2026-11-25-o，main 0 0 同步，
ls-remote 命中 tag -o；bundle `strata-bundle-20261125-160340` 已含 -o，E/F 双盘 clone 演练复现）。

### 重建命令（如需精确恢复命名回滚点 o）

```bat
git tag -a v-baseline-2026-11-25-o a6afc2a6ee1e8ea07b5740d77814a4044d9411b6 -m "baseline: lock rollback point at a6afc2a (5th back-end extraction: serve/exceptions.py engine/session exception hierarchy; full regression ALL GREEN)"
```

## 2026-11-25 系列（续）：当前最新回滚点升级为 p（前端续抽链新一轮 serve/web/app_utils.js splitPath + 后端收官文档，全套绿）

本轮打命名回滚点 `v-baseline-2026-11-25-p`，指向 commit `58d0955`（`feat(web): extract splitPath into app_utils.js`）：
后端续抽链自然收尾后转前端 `app.js`（11,935 行单体）开新一轮，按同纪律扫出零依赖内聚纯叶子 `splitPath`（把绝对路径
拆成可点击面包屑段，Windows 风味 C:→C:\ 盘符根、前导 / → 根相对），与 app_utils.js 既有的 firstPath 同属「路径处理」
族，整搬进 `app_utils.js`。只引用参数 + String/Array/RegExp 内建、零 app.js 全局、零 DOM；全仓仅 app.js 两处引用、无
测试文本抓源，调用点保持原名。连带 test_app_utils_contract.mjs EXPORTS 加 splitPath、test_app_utils_jsdom.mjs 加行为门禁、
test_workspace_picker.mjs boot 链合并 app_utils.js+app.js 同作用域。同轮登记后端模块化收官小结（CHANGELOG）+ 账本顶栏
速览（o→p）。本轮实测全套回归 ALL GREEN。这是前端续抽链 spark 族停滞后新一轮的首个回滚点。

| tag | commit | 性质 |
|---|---|---|
| v-baseline-2026-11-25-p | `58d0955c379e8fc944b1b0372c91cb2294d21d09` | feat(web): splitPath 抽离进 app_utils.js（前端续抽链新一轮 + 后端收官文档；全套回归 ALL GREEN；已实测 ls-remote 在远端） |

**是否已在远端**：已在远端（本轮 push origin main + push origin v-baseline-2026-11-25-p，main 0 0 同步，
ls-remote 命中 tag -p；bundle `strata-bundle-20261125-164121` 已含 -p，E/F 双盘 clone 演练复现，keep-14 已裁剪）。

### 重建命令（如需精确恢复命名回滚点 p）

```bat
git tag -a v-baseline-2026-11-25-p 58d0955c379e8fc944b1b0372c91cb2294d21d09 -m "baseline: lock rollback point at 58d0955 (front-end chain new round: splitPath extracted into app_utils.js; back-end modularization wrap-up doc; full regression ALL GREEN)"
```

## 2026-11-25 系列（续）：当前最新回滚点升级为 q（前端续抽链第二轮 serve/web/app_utils.js proposalMarkdown，全套绿）

本轮打命名回滚点 `v-baseline-2026-11-25-q`，指向 commit `5e5cb71`（`feat(web): extract proposalMarkdown into app_utils.js`）：
沿 splitPath 那轮，同纪律（零依赖 AST out-deps=0、零 app.js 全局、零 DOM、零 mutation）扫出零依赖内聚纯叶子 
`proposalMarkdown`（把建议决策卡对象序列化为人类可读 markdown：标题 + 验证状态 + 选项对照表 + 验证方式 + 下一步），与 
app_utils.js 既有的 mdKindOf/mdImageTag 同属「markdown 渲染」族，整搬进 `app_utils.js`。只引用参数字段 + Array/String/
模板内建；全仓仅 app.js 两处引用（saveProposalToFile 里 1 调用点 + 1 定义）、无测试正则抓源，调用点保持原名。连带 
test_app_utils_contract.mjs EXPORTS 加 proposalMarkdown、test_app_utils_jsdom.mjs 加 5 项行为门禁、test_proposal_card.mjs 
boot 清单 Object.assign 补 proposalMarkdown（outside-only 下 function 不跨 win.eval 作用域）。同轮 CHANGELOG 登记前端续抽
链第二轮条目 + 账本符号清单补 #35 proposalMarkdown（标题计数 34→35）+ 顶栏速览（p→q）。本轮实测全套回归 ALL GREEN。

| tag | commit | 性质 |
|---|---|---|
| v-baseline-2026-11-25-q | `5e5cb71fe9a73d95f38d9b9926063b9de3c78308` | feat(web): proposalMarkdown 抽离进 app_utils.js（前端续抽链第二轮 markdown 渲染族；全套回归 ALL GREEN；已实测 ls-remote 在远端） |

**是否已在远端**：已在远端（本轮 push origin main + push origin v-baseline-2026-11-25-q，main 0 0 同步，
ls-remote 命中 tag -q；bundle `strata-bundle-20261125-171323` 已含 -q，E/F 双盘 clone 演练复现，keep-14 已裁剪）。

### 重建命令（如需精确恢复命名回滚点 q）

```bat
git tag -a v-baseline-2026-11-25-q 5e5cb71fe9a73d95f38d9b9926063b9de3c78308 -m "baseline: lock rollback point at 5e5cb71 (front-end chain round 2: proposalMarkdown extracted into app_utils.js markdown-render family; full regression ALL GREEN)"
```

### app_utils.js 抽离链全量符号清单（真相源 = tests/test_app_utils_contract.mjs 的 EXPORTS，共 42）

以下符号已由 app.js 整搬进 `serve/web/app_utils.js`，app.js 不再重复定义（contract 双向锁：app_utils 必定义 + app.js 必不重复定义）。
加载序铁律：index.html 必须先 `<script src="web/app_utils.js">` 再 `web/app.js`，靠 app_utils 先加载把下列符号暴露为全局供 app.js 调用点使用。

| # | 符号 | 主题组 |
|---|---|---|
| 1 | `timeStr` | misc 基础 |
| 2 | `fmtBytesSel` | misc 基础 |
| 3 | `parsePlanItems` | 计划/提案文本 |
| 4 | `extractNextSteps` | 计划/提案文本 |
| 5 | `extractProposalsFromText` | 计划/提案文本 |
| 6 | `detectLang` | misc 基础 |
| 7 | `firstPath` | 路径/作用域 |
| 8 | `nextScopeUp` | 路径/作用域 |
| 9 | `nextScopeDown` | 路径/作用域 |
| 10 | `clone` | misc 基础 |
| 11 | `classifyTool` | 工具结果分类 |
| 12 | `bugBoxSigKey` | bug-box 聚合 |
| 13 | `bugBoxStats` | bug-box 聚合 |
| 14 | `bugBoxGroups` | bug-box 聚合 |
| 15 | `thinkPeek` | think 文本纯变换 |
| 16 | `dedupeThink` | think 文本纯变换 |
| 17 | `configValue` | 无状态小工具 |
| 18 | `safeCut` | 无状态小工具 |
| 19 | `taskOrder` | 无状态小工具 |
| 20 | `pickSeed` | 无状态小工具 |
| 21 | `snapSent` | stream/think 路径 |
| 22 | `toolSeq` | stream/think 路径 |
| 23 | `noteStreamPhase` | stream/think 路径 |
| 24 | `assembleStreamBubbles` | 流式/会话记录 |
| 25 | `computeWaterfall` | 流式/会话记录 |
| 26 | `nebTaskFromTool` | 工具/任务名解析 |
| 27 | `inflightToolName` | 工具/任务名解析 |
| 28 | `mdKindOf` | markdown 渲染（按 url 判 kind） |
| 29 | `mdImageTag` | markdown 渲染（图片标签构造） |
| 30 | `buildCtxArr` | 上下文压缩（构造压缩输入数组） |
| 31 | `renderMsgForCompact` | 上下文压缩（逐消息渲染截断） |
| 32 | `sparkIsExecuted` | spark 执行判定（纯布尔） |
| 33 | `sparkTimeCompare` | spark 排序（纯比较器） |
| 34 | `splitPath` | 路径/作用域（本轮：app.js → app_utils.js） |
| 35 | `proposalMarkdown` | markdown 渲染（本轮：app.js → app_utils.js） |
| 36 | `designFileName` | 字符串/标识符规范化（本轮：app.js → app_utils.js） |
| 37 | `safeGroup` | 字符串/标识符规范化（本轮：app.js → app_utils.js） |
| 38 | `endpointKey` | 字符串/标识符规范化（本轮：app.js → app_utils.js） |
| 39 | `normalizeTags` | 字符串/标识符规范化（本轮：app.js → app_utils.js） |
| 40 | `toolResultText` | 字符串/标识符规范化（本轮：app.js → app_utils.js） |
| 41 | `_memEstTokens` | 记忆文本度量（本轮：app.js → app_utils.js） |
| 42 | `_memEntryCount` | 记忆文本度量（本轮：app.js → app_utils.js） |

## 2026-11-26 系列（续）：当前最新回滚点升级为 d（后端续抽链第 6 步 + flaky 修复 + app_utils 自述索引，全套绿）

主人拍板：push 本轮 1 个 commit 上 origin（behind=0 快进直推坐实 0 0），再给 HEAD 打命名回滚点 `-d`（annotated）。
`-d` 为 annotated tag，message 只写实跑验证过的事实（全套 --full ALL GREEN 含 post-green 钩子）。本轮 commit `505406e`：

| tag | commit | 内容 |
|---|---|---|
| v-baseline-2026-11-26-d | `505406e6741ce425202c43db7d32dcf4bbddac90` | refactor(serve): sampling 块抽入 req_args（byte-identical + 差分测试）+ 修 schedule-contract flaky + app_utils 自述索引（全套回归 ALL GREEN） |

**是否已在远端**：已在远端（本轮 push origin main 后单独 `git push origin v-baseline-2026-11-26-d` 推到远端，main 0 0 同步，ls-remote 命中 tag -d 解引用 == 505406e6741ce425202c43db7d32dcf4bbddac90）。

### 重建命令（如需精确恢复命名回滚点 d）

```bash
git tag -a v-baseline-2026-11-26-d 505406e6741ce425202c43db7d32dcf4bbddac90 -m "baseline: sampling block extracted to req_args (byte-identical, diff test), schedule-contract flaky fixed (bounded poll), app_utils 42-sym/14-family doc index. Full regression --full ALL GREEN (incl post-green hooks)."
```

## 2026-11-26 系列（续）：当前最新回滚点升级为 e（中英双账本对齐 + RULES 别线落账，纯文档）

主人拍板：push 本轮收尾 commit 上 origin（behind=0 快进直推坐实 0 0），再给最终 HEAD 打命名回滚点 `-e`（annotated）。因主人要求「en 账本与本轮收尾**一并**固化」，`-e` 打在项2+项3 完成后的最终 HEAD `b67480a6f693fd9781ea1117262ae4ffe743c358`（含双账本中英对齐 892619f + RULES 落账 b67480a），而非更早的 010a2ba。本轮两个独立 chore commit：

| tag | commit | 内容 |
|---|---|---|
| v-baseline-2026-11-26-e | `b67480a6f693fd9781ea1117262ae4ffe743c358` | docs(archive.en): en 账本补齐到 11-26 系列 + 补登 app_utils 42 符号清单节（中英完全对齐）+ chore(rules): 落账别线沉淀条目（纯文档，无代码改动） |

**是否已在远端**：已在远端（本轮 push origin main 后单独 `git push origin v-baseline-2026-11-26-e` 推到远端，main 0 0 同步，ls-remote 命中 tag -e 解引用 == b67480a6f693fd9781ea1117262ae4ffe743c358）。

### 重建命令（如需精确恢复命名回滚点 e）

```bash
git tag -a v-baseline-2026-11-26-e b67480a6f693fd9781ea1117262ae4ffe743c358 -m "baseline: en ledger fully aligned to zh (11-26 series backfill + app_utils 42-symbol inventory section) + RULES other-line drift landed. Doc-only; tag points at the double-ledger alignment + RULES landing commit b67480a."
```

## 2026-11-25 系列（续）：当前最新回滚点升级为 r（WorkBuddy 痕迹清理：137 测试锚点 + 展示文案 + 兜底路径，quick 全套绿）

本轮打命名回滚点 `v-baseline-2026-11-25-r`，指向 commit `835dad4`（`chore(workbuddy): purge stale WorkBuddy path traces from test harness + display + node fallback`）：清除项目迁移到 `E:\Nebula\NebulaBaize` 后残留的 WorkBuddy 时代路径。运行时早已干净（active mcp_servers.json 启动本地 .venv）；残留集中在测试网路径锚点与少量展示文案：

- **方案A**（load-bearing 测试锚点 + 展示文案）：137 个测试文件的 `createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/")` → `E:/Nebula/NebulaBaize/`（工作区根 node_modules 持真实 jsdom/playwright；旧 base 目录已不存在、原先仅靠 NODE_PATH 祖先回退命中）；i18n `mem.kb.path.ph` 占位符中英两处、`test_runtime_config_frontend.mjs` 桩路径、`setup.bat` 陈旧 python 候选行、`test_registry_server`/`test_skillhub` 文档示例 → 全部去 WorkBuddy。
- **方案B**（node/python 兜底 → 系统安装）：`run_tests.py`/`test_closeout_pixel.py` 的 node 兜底 → `E:\Program Files\nodejs\node.exe`；`browser_server._find_node()` 的 workbuddy node glob → `%ProgramFiles%\nodejs\*\node.exe`。
- **按改名铁律保留**：`audit.jsonl`/`logs`/`tool-log`/`config/.backups`/`*.bak-*`/「the old ROOT=E:\WorkBuddy bug」等历史叙事注释（「过去少量代码用 WorkBuddy」的真实化石，改动反而失真）。

本轮实测：`tools/run_tests.py --quick` 全套 **ALL GREEN**（含 i18n 1392 键×2 与全部 jsdom 网）；`--full` 仅 `test_shell_timeout`/`test_self_suicide_guard` 两 FAIL，二者均不引用改动锚点、单跑即 ALL GREEN（既有 flaky 经验坐实）。numstat==--ignore-cr-at-eol 零行尾污染；commit `835dad4` 已 push origin（fast-forward `b5dd74e..835dad4`，main 0 0 同步）。

| tag | commit | 性质 |
|---|---|---|
| v-baseline-2026-11-25-r | `835dad49e1b1f52af17bb96cf8c840c32a4d948d` | chore(workbuddy): 清理 137 测试 createRequire 锚点 + 展示文案 + node/python 兜底（WorkBuddy 痕迹清理；quick 全套 ALL GREEN；已实测 ls-remote 在远端） |

**是否已在远端**：已在远端（本轮 push origin main + push origin v-baseline-2026-11-25-r，main 0 0 同步，ls-remote 命中 tag -r 解引用 commit `835dad4`）。

### 重建命令（如需精确恢复命名回滚点 r）

```bat
git tag -a v-baseline-2026-11-25-r 835dad49e1b1f52af17bb96cf8c840c32a4d948d -m "WorkBuddy trace purge: 137 test createRequire anchors + display strings + node fallback; quick regression ALL GREEN"
```

## 2026-11-26 超前标号清理（在 11-25 创建却标 11-26，与时间序不符 · 删除 5 个）

主人拍板删除 5 个超前标号 tag：它们实际创建于 **2026-11-25**（见 `git for-each-ref --sort=-creatordate`：-a 17:27 / -b 17:53 / -c 18:22 / -d 20:06 / -e 20:28，均在 11-25），却用了 11-26 标号，与本仓「tag 名按 git 真实日期」惯例不符、与时间序倒挂。判据：被删 5 个 tag 指向的 commit 全部是 HEAD（master）的祖先（逐 tag `git merge-base --is-ancestor` 坐实 anc=0），删 tag **不丢任何 commit**——master 链已含它们；tag 仅是命名指针，按下方命令即可重建。本地删 + `git push origin --delete` 删远端两步都做。

| 已删 tag | 指向 commit（40 位） | 原语义（账本既有登记摘要） |
|---|---|---|
| v-baseline-2026-11-26-a | `fcb8f9b6df5da01c0d18efc78f3068f441391748` | 11-26 系列早期基线点（超前标号，11-25 创建） |
| v-baseline-2026-11-26-b | `ca99cc274415a9bb7903acd20af8d203441df347` | 11-26 系列早期基线点（超前标号，11-25 创建） |
| v-baseline-2026-11-26-c | `9d4699eed6a4fac7ffc16a016e801e4af4b6146b` | 11-26 系列早期基线点（超前标号，11-25 创建） |
| v-baseline-2026-11-26-d | `505406e6741ce425202c43db7d32dcf4bbddac90` | 后端续抽链第 6 步 sampling 抽入 req_args + flaky 修复 + app_utils 自述索引（全套 --full 绿） |
| v-baseline-2026-11-26-e | `b67480a6f693fd9781ea1117262ae4ffe743c358` | 中英双账本对齐 + 补登 app_utils 42 符号清单 + RULES 别线落账（纯文档） |

### 重建命令（如需精确恢复某个被删的超前标号 tag）

```bat
git tag -a v-baseline-2026-11-26-a fcb8f9b6df5da01c0d18efc78f3068f441391748 -m "superseded 11-26-series early baseline (created on 2026-11-25, date-order mismatch)"
git tag -a v-baseline-2026-11-26-b ca99cc274415a9bb7903acd20af8d203441df347 -m "superseded 11-26-series early baseline (created on 2026-11-25, date-order mismatch)"
git tag -a v-baseline-2026-11-26-c 9d4699eed6a4fac7ffc16a016e801e4af4b6146b -m "superseded 11-26-series early baseline (created on 2026-11-25, date-order mismatch)"
git tag -a v-baseline-2026-11-26-d 505406e6741ce425202c43db7d32dcf4bbddac90 -m "baseline: sampling block extracted to req_args (byte-identical, diff test), schedule-contract flaky fixed, app_utils 42-sym/14-family doc index. Full regression --full ALL GREEN"
git tag -a v-baseline-2026-11-26-e b67480a6f693fd9781ea1117262ae4ffe743c358 -m "baseline: en ledger fully aligned to zh (11-26 series backfill + app_utils 42-symbol inventory section) + RULES other-line drift landed. Doc-only"
```
