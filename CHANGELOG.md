# Changelog

本项目的所有显著改动都记录在此文件。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

本项目のすべての主な変更点は本書に記録します。

All notable changes to this project are documented in this file.

## [Unreleased]

### Changed / 变更

- **账本分段登记 POC（11-21 j-k / 10-30 a-q）+ `-i` 续位**（2026-11-26，纯文档，低风险）：在 ledger-tag 门禁「只对已登记日判窗内缺」的机制下，对结构适用的历史老日期做低风险分段登记：11-21 现存真实连续段 j-k、10-30 现存真实连续段 a-q（三老日期画像实测——10-31 含多字母 `ctx` 且乱序、11-02 仅单字母 `f`，均结构不适用连续性窗，据实不强开保持窗 OFF）。给 11-21 POC 落地点 `de5b1ac` 打命名回滚点 `v-baseline-2026-11-26-i`（续 a-h 之后），账本中英各 append 对应登记节 + 速览升级 i。门禁 LEDGER-TAG 全程 ALL GREEN；quick 全套 250 ALL GREEN（含差分 S8 真仓自举）；权威 HEAD 上 `--full` incl. post-green ALL GREEN。
  - *Ledger segmented-registration POC (11-21 j-k / 10-30 a-q) + `-i` rollback point* (2026-11-26, pure doc, low risk): under the ledger-tag gate's "only check in-window gaps on registered days" mechanism, low-risk segmented registration is applied to structurally-applicable old dates: 11-21's surviving contiguous run j-k and 10-30's surviving contiguous run a-q (measured three-old-date profile: 10-31 has the multi-letter `ctx` and is out-of-order, 11-02 has only the single letter `f` -- neither is structurally applicable to a contiguity window, so both are kept OFF as measured). The 11-21 POC landing point `de5b1ac` is pinned by named rollback point `v-baseline-2026-11-26-i` (after a-h); both ledgers gain the matching registration section and the overview is upgraded to i. LEDGER-TAG stays ALL GREEN throughout; quick suite 250 ALL GREEN (incl. the S8 real-repo self-boot); `--full` incl. post-green is ALL GREEN at the authoritative HEAD.

- **账本↔tag deref 一致性门禁三件套（ledger-tag gate）**（2026-11-26，纯工具 + 文档，低风险）：把曾发生一次的「git 已有某 baseline tag 但中英账本未登记该 tag 行」-e 类滞后断层，从人工核对固化为自动门禁三件套——① `tools/ledger_tag_parity.py`：三道判据（账本每行声明的 tag 必在 git 存在且 deref commit 与声明 sha 一致 / 中英两账本登记 tag 名集合完全相同防单边漂移 / 对账本已登记的每个日期，其登记字母 [min,max] 区间内若 git 真实存在的单字母 tag 未登记即报「账本内断层」）；② `tests/test_ledger_tag_parity.py` 8 用例差分锁（登记进 run_tests SUITES·QUICK，S1 缺字母必红 / S2 补上必绿等，含 S8 真仓自举全绿）；③ `.github/workflows/ledger-tag.yml`（push main / PR / 手动三触发，`fetch-depth: 0 + git fetch --tags --force` 抓全 tag，与本地共用同一 `run_checks` 真相源）。随附向中英双账本补登 11-22(a-h)/11-23(a-c)/11-24(a-h) 早期 tag 扩宽连续性窗。实测：门禁 ALL GREEN、差分 8 用例全绿、quick 全套 250 ALL GREEN、CI 对 headSha `d170ed1` 实跑 completed/success。命名回滚点 `v-baseline-2026-11-26-h`（deref=`d170ed1`）。
  - *Ledger<->tag deref parity gate (three-piece set)* (2026-11-26, pure tooling + docs, low risk): turns the once-occurring -e class lag gap — git already has a baseline tag but the zh/en ledger never recorded that tag row — from a manual cross-check into an automatic three-piece gate. (1) `tools/ledger_tag_parity.py`: three criteria — every tag declared in a ledger row must exist in git with its deref commit matching the declared sha; the zh and en ledgers must register identical tag-name sets (anti one-sided-drift); and for every date the ledger has registered, if a single-letter tag that really exists in git for that date falls inside the registered [min,max] letter range but is itself unregistered, it is reported as an in-ledger gap. (2) `tests/test_ledger_tag_parity.py`, an 8-case differential lock registered in run_tests SUITES (QUICK): S1 a missing letter MUST be red, S2 filled MUST be green, etc., incl. S8 real-repo self-boot green. (3) `.github/workflows/ledger-tag.yml` (push main / PR / manual; `fetch-depth: 0 + git fetch --tags --force` to grab all tags), sharing one `run_checks` source of truth with local. Backfills the 11-22(a-h)/11-23(a-c)/11-24(a-h) early tags into both ledgers to widen the continuity window. Verified: the gate ALL GREEN, the 8 differential cases green, quick suite 250 ALL GREEN, CI ran completed/success on headSha `d170ed1`. Named rollback point `v-baseline-2026-11-26-h` (deref=`d170ed1`).

- **baseline 回滚点 `v-baseline-2026-11-26-a` + image sentinel 高载 flaky 根治**（2026-11-26，纯文档 + 哨兵阈值，低风险）：给文档推进 commit `b673877`（README 门禁锚点列 -g→-u 推进 + 中英账本 -u 节补登）在今日真实日期下打命名回滚点 `v-baseline-2026-11-26-a`，为先前已清理超前标号之后 11-26 系列现存首个标号，无冲突；并将 `tools/image_e2e_sentinel.py` 的 `FAST_TIMEOUT_S` 由 60s 放宽到 75s（`SLOW_RATIO_MAX=3.0` 不动），消除 292 套件全套并发墙钟争用下 fast-path 60~63s 的反复 flaky（单跑实测仅 ~12s）。放宽后重跑 full 全套 **292 套件 FAIL=0 全绿**，post-green 钩子复验最新 tag = WORKING ROLLBACK POINT。全仓无测试锁定 60 这个值（grep 坐实）。
  - *baseline rollback point `v-baseline-2026-11-26-a` + image-sentinel high-load flaky root-caused* (2026-11-26, doc-only + sentinel threshold, low risk): named rollback point `v-baseline-2026-11-26-a` was cut at the doc-advance commit `b673877` (README gate-anchor column -g to -u + zh/en ledger -u section backfill) under the true date, the first surviving 11-26 number after the prior superseded-numbering cleanup, no conflict; and `tools/image_e2e_sentinel.py`'s `FAST_TIMEOUT_S` was relaxed 60s to 75s (`SLOW_RATIO_MAX=3.0` unchanged) to stop the repeated fast-path 60~63s flaky under 292-suite concurrent wall-clock contention (single-run ~12s). After the relaxation the full suite re-ran with **292 suites, 0 FAIL, ALL GREEN**, and the post-green hook verified the newest tag as a WORKING ROLLBACK POINT. No test locks the 60 value (grep-confirmed).

- **记忆文本度量族抽离到 `app_utils.js`（前端续抽链第四轮 · 42 符号刻度）** — 沿同纪律
  （零依赖 AST out-deps=0、零 app.js 全局、零 DOM、零 mutation）扫出同族内聚的「记忆文本度量」
  纯叶子两个：`_memEstTokens`（对一段记忆 store 文本做 CJK 加权 token 粗估）、`_memEntryCount`
  （数出非注释行数）。二者职责同质：都作用于一份 .md 记忆正文、返回一个纯度量值，均只引用入参
  + String/Array/Math 内建；字节逐字一致整搬。app_utils.js 顶部族分组索引随之扩到 42 符号 / 14 族。
  - **连带面**：`test_app_utils_contract.mjs` EXPORTS 40→42；`test_app_utils_jsdom.mjs` HELPERS/EXPOSE 补齐两个；
  `test_mem_chunk_compact.mjs`、`test_ws_persona_count.mjs` 两测试 boot 此前只 eval app.js，运行时经 persona/compact
  路径间接调用 `_memEstTokens`，补拼 app_utils.js boot（classic script 下 app_utils 全局先于 app.js 可见）。
  - *Memory-text-metrics family extracted into `app_utils.js` (front-end chain, round 4 — 42-symbol milestone):*
  same discipline surfaced two cohesive leaves: `_memEstTokens` (CJK-weighted token estimate over a memory-store
  blob) and `_memEntryCount` (non-comment line count). Both measure a .md memory body and return a pure number,
  referencing only their argument plus String/Array/Math builtins; byte-for-byte identical move. The FAMILY INDEX
  header grows to 42 symbols / 14 families.
  - *Blast radius:* `test_app_utils_contract.mjs` EXPORTS 40→42; `test_app_utils_jsdom.mjs` HELPERS/EXPOSE gains the two;
  `test_mem_chunk_compact.mjs` and `test_ws_persona_count.mjs` booted by evaluating app.js only and reach
  `_memEstTokens` through the persona/compact path at runtime, so their boot now prepends app_utils.js.
- **字符串/标识符规范化族抽离到 `app_utils.js`（前端续抽链第三轮 · 40 符号刻度）** — 继 proposalMarkdown 那轮，同纪律
  （零依赖 AST out-deps=0、零 app.js 全局、零 DOM、零 mutation）扫出同族内聚的「字符串/标识符规范化」纯叶子五个：
  `designFileName`（标题→安全 .md 文件名）、`safeGroup`（组名→去非法字符）、`endpointKey`（URL→匹配键）、
  `normalizeTags`（标签→去重数组）、`toolResultText`（任意值→字符串）。五者职责同质：纯文本输入 → 规范输出，
  均只引用参数 + Array/String/JSON 内建，零 DOM、零 app.js 全局、不改变字入参；调用点保持原名。字节逐字一致整搬。
  同时在 `app_utils.js` 顶部新增一段「族分组索引」注释：按 13 个职责族逐列 40 个导出符号（含本轮新增五个），
  便于定位与防漏抽。
  - **连带面**：`test_app_utils_contract.mjs` EXPORTS 35→40；`test_app_utils_jsdom.mjs` HELPERS/EXPOSE 补齐五个；
  三个以「只 eval app.js / 拼 app_utils」方式 boot 的测试因调用这些符号需补 `app_utils.js` boot：
  `test_tool_result_content.mjs`（直接引 toolResultText）、`test_spark_edit_nodrag.mjs`（spark 添加流程调 normalizeTags）
  补拼 app_utils boot；`test_stream_intel.mjs`（designFileName）、`test_auto_memory.mjs`（safeGroup）已拼 app_utils 无需改。
  - *String/identifier-normalization family extracted into `app_utils.js` (front-end chain, round 3 — 40-symbol milestone):*
  following the proposalMarkdown round, the same discipline (zero external dependency AST out-deps=0, zero app.js globals,
  zero DOM, no mutation) surfaced five cohesive leaves of the string/identifier-normalization family: `designFileName`
  (title → safe .md filename), `safeGroup` (group name → strip illegal chars), `endpointKey` (URL → match-key),
  `normalizeTags` (tags → deduped array), `toolResultText` (any value → string). All five share one responsibility —
  plain-text input → normalized output — and reference only their argument plus Array/String/JSON builtins, with zero DOM,
  zero app.js globals and no input mutation; call sites keep their original names. Byte-for-byte identical move. A new
  family-index header comment at the top of `app_utils.js` lists all 40 exported symbols grouped into 13 responsibility
  families (including the five added this round) for orientation and anti-miss extraction.
  - *Blast radius:* `test_app_utils_contract.mjs` EXPORTS 35→40; `test_app_utils_jsdom.mjs` HELPERS/EXPOSE gains the five;
  three jsdom tests that boot by evaluating app.js (with app_utils pre-concatenated or not) and call these symbols needed
  the app_utils boot added: `test_tool_result_content.mjs` (references toolResultText directly) and `test_spark_edit_nodrag.mjs`
  (spark-add flow calls normalizeTags) got app_utils prepended to their boot; `test_stream_intel.mjs` (designFileName) and
  `test_auto_memory.mjs` (safeGroup) already concatenate app_utils and needed no change.
- **`proposalMarkdown` 抽离到 `app_utils.js`（前端续抽链第二轮 · markdown 渲染族）** — 沿续 splitPath 那轮，同纪律
  （零依赖 AST out-deps=0、零 app.js 全局、零 DOM、零 mutation）扫出零依赖内聚纯叶子 `proposalMarkdown`：
  把建议决策卡对象序列化为人类可读 markdown（标题 + 验证状态 + 选项对照表 + 验证方式 + 下一步）。
  它与 app_utils.js 里既有的 `mdKindOf`/`mdImageTag` 同属「markdown 渲染」族，整搬后天然内聚。它只引用参数字段 +
  Array/String/模板内建，零 app.js 全局、零 DOM、不改变字入参；全仓仅 app.js 两处引用（`saveProposalToFile` 里的
  1 调用点 + 1 定义）、无测试正则抓源；调用点保持原名（classic script 全局声明、app_utils.js 先于 app.js 加载）。
  字节逐字一致整搬。
  - **连带面**：`test_app_utils_contract.mjs` EXPORTS 集合加 `proposalMarkdown`（L2a 定义 / L2b 不重定义锁全绿）；
  `test_app_utils_jsdom.mjs` 的 HELPERS/EXPOSE 加 `proposalMarkdown` 并补 5 项行为门禁（title+options→表格、仅
  title→无表格、verified true/false→已验证/待验证状态词、evidence/next 字段渲染）；`test_proposal_card.mjs` 的
  `Object.assign(window,{...})` boot 清单补 `proposalMarkdown`（outside-only 下 function 不跨 win.eval 作用域，需在
  app_utils eval 时重新发布到 window，后续 injected eval 的裸引用才能经 global lookup 命中）。
  - *`proposalMarkdown` extracted into `app_utils.js` (front-end chain, round 2 — markdown-render family):* continuing
  the splitPath round, the same discipline (zero external dependency AST out-deps=0, zero app.js globals, zero DOM, no
  mutation) surfaced the cohesive leaf `proposalMarkdown` — it serialises a proposal decision-card object into a
  human-readable markdown document (title + verified-state + options comparison table + evidence + next). It belongs to
  the same *markdown-render* family as the existing `mdKindOf`/`mdImageTag` already in app_utils.js, so the move is
  naturally cohesive. It references only its argument’s fields plus Array/String/template builtins — zero app.js globals,
  zero DOM, does not mutate its input; across the whole tree it is referenced in exactly two places in app.js (one call
  site inside `saveProposalToFile` + one definition), with no regex-source capture, and the call site keeps its original
  name (classic-script global declaration, app_utils.js loads before app.js). Byte-for-byte identical move.
  - *Blast radius:* `test_app_utils_contract.mjs` EXPORTS gains `proposalMarkdown` (L2a defines / L2b no-redefine locks
  stay green); `test_app_utils_jsdom.mjs` gains `proposalMarkdown` in HELPERS/EXPOSE plus a 5-assertion behaviour gate
  (title+options→table, title-only→no table, verified true/false→state wording, evidence/next fields); and
  `test_proposal_card.mjs`’s `Object.assign(window,{...})` boot list gains `proposalMarkdown` (under jsdom
  outside-only, a top-level `function` does not cross `win.eval` scopes, so it must be re-published onto window during
  the app_utils eval for the later injected eval’s bare reference to resolve).
- **`splitPath` 抽离到 `app_utils.js`（前端续抽链新一轮）** — 后端续抽链自然收尾后转回前端
  `app.js`（11,935 行单体）。按同一纪律扫出零依赖内聚纯叶子 `splitPath`：把绝对路径拆成可点击
  面包屑段，每段携自己的绝对前缀（Windows 风味：`C:`→`C:\` 盘符根、前导 `/` → 根相对）。它与 app_utils.js 里
  既有的 `firstPath` 同属「路径处理」族，整搬后天然内聚。它只引用参数 + `String`/`Array`/`RegExp` 内建，零
  app.js 全局、零 DOM；全仓仅 app.js 两处引用（1 调用点 + 1 定义）、无测试文本抓源，调用点保持原名不改
  （classic script 全局声明、app_utils.js 先于 app.js 加载）。字节逐字一致整搬。
  - **连带面**：`test_app_utils_contract.mjs` 的 EXPORTS 集合加 `splitPath`（L2a 定义 / L2b 不重定义锁全绿）；
  `test_app_utils_jsdom.mjs` 的 HELPERS/EXPOSE 加 `splitPath` 并补行为门禁：drive-letter 臂（`C:`→`C:\`）、
  前导斜杠根臂（`/x`→`\x` 而非裸 `x`）、相对路径臂（首段保持裸 `a`）、空/null → `[]` 不抛。
  前一轮前端链停在 spark 族，本轮路径处理族 `splitPath` 开启新一轮。

  - *`splitPath` extracted into `app_utils.js` (front-end chain, new round):* after the back-end chain concluded
  naturally, the extraction moved back to the front-end `app.js` (an 11,935-line monolith). The same discipline
  surfaced the zero-dependency cohesive leaf `splitPath` — it splits an absolute path into clickable breadcrumb
  segments, each carrying its own absolute prefix (Windows-flavoured: `C:`→`C:\` drive root, a leading `/` is
  root-relative). It sits in the same *path-handling* family as the existing `firstPath` already in app_utils.js, so
  the move is naturally cohesive. It references only its argument plus `String`/`Array`/`RegExp` builtins — zero
  app.js globals, zero DOM; across the whole tree it is referenced in exactly two places in app.js (one call site +
  one definition), with no textual-capture source, and the call site keeps its original name (classic-script global
  declaration, app_utils.js loads before app.js). Byte-for-byte identical move.
  - *Blast radius:* `test_app_utils_contract.mjs` EXPORTS gains `splitPath` (the L2a defines / L2b no-redefine locks
  stay green); `test_app_utils_jsdom.mjs` gains `splitPath` in HELPERS/EXPOSE plus a behaviour gate — the drive-letter
  arm (`C:`→`C:\`), the leading-slash root arm (`/x`→`\x`, not bare `x`), the relative-path arm (first segment stays
  bare `a`) and empty/null → `[]` without throwing. The front-end chain had paused at the spark family; this round
  opens a new one with the path-handling `splitPath`.
- **后端模块化收官小结（续抽链第 1–5 步，自然收尾）** — `serve/server.py` 原为 **7,290 行**单体，按
  「零外部依赖（AST out-deps=0）、零模块全局、零 mutation」纪律，逐族整搬内聚纯叶子到独立 `serve/*.py`，
  累计五步：① `serve/tokenizer.py`（分词 / 上下文窗口计算）② `serve/approval.py`（工具审批分级）
  ③ `serve/conv_cache.py`（引擎会话缓存日志读取 + Monitor 缓存卡视图）④ `serve/engine_diag.py`（引擎
  退出状态词 / 崩溃判定 / draft-head 提示 / GPU-runtime marks）⑤ `serve/exceptions.py`（引擎/会话异常层级，9 类，
  零 import）。每步均打命名回滚点 tag + `git bundle` E/F 双盘快照，全套回归 ALL GREEN。server.py 逐族
  瘦身：第五步（exceptions）令其从 6,985 行减到 **6,926 行**；整条链从 7,290 行单体累计降到 6,926 行
  （累计约减 364 行）。随后重扫 AST out-deps=0：唯一内聚族 `_recycle_send_to_bin` / `_recycle_restore_file`
  触发候选质量下降停止条件——该对跨 `runtime/http_server.py` + `serve/server.py` 两个子系统各存一份
  共享 helper，被 `tests/test_recycle_xplat_dispatch.py` X4 锁死「两份 helper 源码逐字节相同」反漂移，抽成
  单模块会破坏 `extract_helper` 字节抓取契约、需连带改测试，属非等价改动；其余纯叶子全是零散单函数
  不成族——后端续抽链到此自然收尾；server.py 下一阶段拆分需换切面（如按路由 handler 分组），已非
  「摘纯叶子」能覆盖。
  - *Back-end modularization wrap-up (chain steps 1–5, concluded naturally):* `serve/server.py` was a **7,290-line**
  monolith; following *zero external dependency (AST out-deps=0), zero module globals, zero mutation*, cohesive pure
  leaves were lifted family-by-family into standalone `serve/*.py` across five steps — `tokenizer` → `approval` →
  `conv_cache` → `engine_diag` → `exceptions` (the 9-class engine/session exception hierarchy, zero imports). Each step
  cut a named rollback tag + a `git bundle` E/F dual-drive snapshot with a full regression ALL GREEN. Step 5 cut the
  file from 6,985 to **6,926** lines; over the whole chain the 7,290-line monolith came down to 6,926 (≈ 364 lines
  removed in total). Re-scanning AST out-deps=0 then surfaced only the `_recycle_send_to_bin` / `_recycle_restore_file`
  pair as a family, which hit the diminishing-returns stop condition: that pair is duplicated across `runtime/http_server.py`
  and `serve/server.py`, and `tests/test_recycle_xplat_dispatch.py` X4 locks the two copies byte-identical (anti-drift)
  — extracting one module breaks the `extract_helper` byte-capture contract and needs a test rewrite, so it is not an
  equivalence move; every remaining pure leaf is a one-off singleton forming no family. The back-end chain thus concluded
  naturally; further splitting server.py needs a different cut (e.g. by route handler), which *lift-a-pure-leaf* no longer
  covers.
- **`serve/exceptions.py` 抽离 — 续抽链第五族：把 serve/server.py 里彼此零耦合的「引擎/会话
  异常层级」一族整搬进新模块 `serve/exceptions.py`：`EngineDied` / `EngineStarting` / `ClientGone` / `ModelBusy` /
  `EngineSilent`（继承 `EngineDied`）/ `EngineNonFinite` / `SessionRefused`（带 kind→HTTP `status` 属性）/
  `EngineStuck` / `GpuBusy`（带 `retry_after`）九类异常。它们仅继承内置 `RuntimeError`/`Exception`/`ValueError` 或
  同族成员，零 import、零 server 全局；所有 raise / except 调用点保持原名经 try/except 双路径 import 兜回（9 类
  引用全在 server.py 内、无跨文件/无测试文本抓取源牵连）。AST out-deps=0 扫描坐实为当前最纯最内聚的零依赖族。
  - **连带面**：无文本正则抓取源牵连；`test_pure_modules.py` 加第 16 个纯模块 `serve/exceptions`（一测试：
  EngineSilent<EngineDied 的 fatal 继承 + ValueError vs RuntimeError 三基类互不相同差分防误接线 +
  SessionRefused kind→status 映射（storage 507/invalid 400/memory 503/未知回退 io 500）+ published 标志 +
  GpuBusy retry_after 载荷与默认 None），带 load-bearing 差分。`docs/backend-modularization(.en).md` 进度表加
  第 16 行续抽链第 5 步；backend-modularization / test_pure_modules docstring / run_tests 三处 16 模块对账一致。

  *`serve/exceptions.py` extraction (fifth back-end modularization step):* the fifth chain family — the mutually
  decoupled *engine / session exception hierarchy* — is lifted whole out of `serve/server.py` into a new module
  `serve/exceptions.py`: `EngineDied` / `EngineStarting` / `ClientGone` / `ModelBusy` / `EngineSilent` (subclassing
  `EngineDied`) / `EngineNonFinite` / `SessionRefused` (with its kind->HTTP `status` property) / `EngineStuck` /
  `GpuBusy` (with `retry_after`), nine exception classes. They inherit only builtins (RuntimeError / Exception /
  ValueError) or one another — zero imports, zero server globals; every raise / except site keeps its original name
  through a try/except double-path import (all 9 classes' references live inside server.py, no cross-file or textual-
  capture-source fallout). The AST out-deps=0 scan confirms this is the purest, most cohesive zero-dependency family
  right now.
  - *Blast radius:* no textual-regex capture source was involved; `test_pure_modules.py` gains its 16th module
  `serve/exceptions` with one test (EngineSilent<EngineDied fatal inheritance + a three-bases-are-distinct
  ValueError-vs-RuntimeError differential guarding against a mis-wired base move + SessionRefused kind->status mapping
  (storage 507 / invalid 400 / memory 503 / unknown -> io 500) + the published flag + GpuBusy's retry_after load and
  None default), with a load-bearing differential. `docs/backend-modularization(.en).md` gains a 16th row (chain step
  5); backend-modularization / the test_pure_modules docstring / run_tests stay in lockstep at 16 modules.

## [0.1.1] - 2026-11-25

### Changed / 变更

- **app_utils 纯函数抽离链（阶段性）** — 按「零 DOM、零 app.js 模块全局、无 mutation」纪律，从单体 `app.js` 持续摘取内聚纯叶子移入 `app_utils.js`。本轮 spark 族：`sparkIsExecuted`（判定便签是否已执行：`executedAt` 已设或 `status==done`）+ `sparkTimeCompare`（时间模式排序比较器：未执行置顶、新建在上，已执行置底、最近执行在上）整搬（commit `8d8a27d`），二者同族彼此依赖、对外零依赖；前序已固化 `buildCtxArr`+`renderMsgForCompact`、`mdKindOf`+`mdImageTag`+`MD_EXT_*` 等纯叶子。
  - **连带面**：5 个 jsdom boot 类回归 harness（`test_spark_sort` / `test_spark_edit_imgdrag` / `test_spark_group_kbd` / `test_spark_thumb_delete` / `test_spark_image_only_save`）的 `appCode` 读源改为先拼 `app_utils.js` 再拼 `app.js`，确保 boot 作用域能解析已搬离的符号（`test_app_utils_contract.mjs` EXPORTS 双向锁同步扩面）。

  *app_utils pure-function extraction chain (milestone):* by the discipline of *no DOM, no other app.js module globals, no mutation*, cohesive pure leaves are steadily lifted from the monolithic `app.js` into `app_utils.js`. This round the spark family: `sparkIsExecuted` (a note has run when `executedAt` is set or `status==done`) + `sparkTimeCompare` (the time-mode sort comparator: unexecuted on top / newest-created first, executed below / most-recently-executed first) moved whole (commit `8d8a27d`); the two depend only on each other and on nothing else. Earlier in the chain, `buildCtxArr`+`renderMsgForCompact` and `mdKindOf`+`mdImageTag`+`MD_EXT_*` were already extracted.
  - *Blast radius:* 5 jsdom boot-style regression harnesses (`test_spark_sort` / `test_spark_edit_imgdrag` / `test_spark_group_kbd` / `test_spark_thumb_delete` / `test_spark_image_only_save`) now prepend `app_utils.js` before `app.js` in their `appCode` read so the boot scope can resolve the extracted symbols (`test_app_utils_contract.mjs` EXPORTS double-lock extended in step).
- **`serve/tokenizer.py` 抽离（后端模块化第一步）** — 把 serve/server.py（7,290 行单体）里彼此零耦合的
  「增量解码 + 停止串」一族整搬进新模块 `serve/tokenizer.py`：`ByteTokenizer`（测试用字节分词替身：每
  UTF-8 字节一个 id、special 为 id≥256）、`Detokenizer`（增量解码，跨 token 拆分的多字节字符挂起至完整）、
  `stop_strings` + `OPENAI_MAX_STOP`（解析 OpenAI `stop` / Anthropic `stop_sequences`，越限/错型抛 400）、
  `StopMatcher`（在首个停止串处截断，挂住可能开启停止串的尾部）。仅依赖 stdlib codecs、无 server 全局。
  调用点（构造 / `stop_strings`）保持原名经 try/except import 兜回。
  - **连带面**：`test_pure_modules.py`（纯模块行为锁文件）新增第 12 个模块 `serve/tokenizer` 的三个测试
  （字节往返 / 增量解码挂起 / stop 上限与错型 400 + StopMatcher 挂尾），均带 load-bearing 差分。

  *`serve/tokenizer.py` extraction (first back-end modularization step):* the mutually decoupled
  *incremental-decode + stop-string* family is lifted whole out of the 7,290-line `serve/server.py` monolith into
  a new module `serve/tokenizer.py`: `ByteTokenizer` (a test stand-in tokenizer: one id per UTF-8 byte, specials
  as ids >= 256), `Detokenizer` (incremental decode; a multi-byte character split across tokens is held until
  complete), `stop_strings` + `OPENAI_MAX_STOP` (parse OpenAI `stop` / Anthropic `stop_sequences`; over-cap /
  wrong-type raise a 400) and `StopMatcher` (cut at the first stop string, holding back a tail that could still
  start one). Depends on stdlib `codecs` only, no server globals. Call sites keep their original names via a
  try/except import.
  - *Blast radius:* `test_pure_modules.py` gains its 12th module `serve/tokenizer` with three tests (byte
  round-trip / incremental hold / stop cap-and-type 400 + StopMatcher hold-tail), each with a load-bearing
  differential.
- **`serve/approval.py` 抽离（后端模块化第二步）** — 延续 tokenizer 抽离链，把 serve/server.py 里彼此零耦合的
  「工具审批策略」一族整搬进新模块 `serve/approval.py`：`_DESTRUCTIVE_SHELL` / `_DESTRUCTIVE_SYMBOLS`（破坏性
  shell 命令的两组正则：词边界式 rm -rf 与分隔符锚定式 `> /dev/sda`/fork 炸弹）、`_APPROVAL_TOOLS`（六个 registry
  写操作的 frozenset）、`_needs_approval` / `_auto_deny` / `_approval_desc` 三个纯谓词。仅依赖 stdlib json + re、无
  server 全局（AST out-deps 扫描坐实 free names 仅 json/re + 参数名）。`_PERM_TIERS`（tier 列表，run_with_mcp 用）
  留下。调用点保持原名经 try/except import 兜回。
  - **连带面**：`tests/test_registry_server.py` 的 approval.yaml↔frozenset 文本对账，抓取源由 serve/server.py
  改到 serve/approval.py（load-bearing，docstring 同步更新）；`test_pure_modules.py` 加第 13 个纯模块
  `serve/approval`（三测试：六写操作 gate / 破坏性 shell deny + 词边界 vs 分隔符两组正则 / desc 320 字截断，
  均带 load-bearing 差分）。

  *`serve/approval.py` extraction (second back-end modularization step):* continuing the tokenizer chain, the
  mutually decoupled *tool-approval policy* family is lifted whole out of `serve/server.py` into a new module
  `serve/approval.py`: `_DESTRUCTIVE_SHELL` / `_DESTRUCTIVE_SYMBOLS` (the two destructive-shell regexes — word-
  boundary `rm -rf` and separator-anchored `> /dev/sda` / fork-bomb forms), `_APPROVAL_TOOLS` (the frozenset of the
  six registry mutations), and the three pure predicates `_needs_approval` / `_auto_deny` / `_approval_desc`.
  Depends on stdlib `json` + `re` only, no server globals (AST out-deps scan: free names are json/re + parameters).
  `_PERM_TIERS` (the tier tuple, used by run_with_mcp) stays. Call sites keep their original names via a try/except
  import.
  - *Blast radius:* `tests/test_registry_server.py`'s approval.yaml↔frozenset textual lockstep now reads its
  capture source from serve/approval.py instead of serve/server.py (load-bearing; docstring updated in step), and
  `test_pure_modules.py` gains its 13th module `serve/approval` with three tests (six-mutation gate / destructive-
  shell deny covering both the word-boundary and separator-anchored regex sets / desc 320-char cap), each with a
  load-bearing differential.

- **`serve/conv_cache.py` 抽离（后端模块化第三步）** — 延续 tokenizer→approval 抽离链，把 serve/server.py 里彼此
  零耦合的「会话缓存日志读取」一族整搬进新模块 `serve/conv_cache.py`：`ConvCacheLog`（解析引擎 stderr 里
  `conversation cache: parked/restored ...` 行、维护 parked/bytes/evictions/parks/restores 累计态的日志读取器，
  只读 stdlib os/re/time）+ `conversation_cache_view`（由入参 info/hist/totals/parked 组装 Monitor「会话缓存」卡片
  dict，零外部依赖）。AST out-deps 扫描坐实 free names 仅 os/re/time + 参数名、无 server 全局；调用点（构造 +
  Monitor 卡片）保持原名经 try/except import 兜回。
  - **连带面**：无文本正则抓取源牵连（引用仅 server.py 两处调用点）；`test_pure_modules.py` 加第 14 个纯模块
  `serve/conv_cache`（二测试：view 卡片的 int>0 opt-in 门 + totals/parked 拼装 + 停用边界 / 日志解析的 park vs
  skip vs restore 计数 + dropped-superseded 仅改 parked + evictions），均带 load-bearing 差分。

  *`serve/conv_cache.py` extraction (third back-end modularization step):* continuing the tokenizer→approval chain,
  the mutually decoupled *conversation-cache log reader* family is lifted whole out of `serve/server.py` into a new
  module `serve/conv_cache.py`: `ConvCacheLog` (parses the engine's `conversation cache: parked/restored ...`
  stderr lines into running parked/bytes/evictions/parks/restores state; stdlib os/re/time only) +
  `conversation_cache_view` (assembles the Monitor conversation-cache card dict purely from its arguments
  info/hist/totals/parked, zero external deps). The AST out-deps scan confirms the free names are os/re/time +
  parameters, no server globals; call sites keep their original names via a try/except import.
  - *Blast radius:* no textual-regex capture source was involved (only two call sites in server.py);
  `test_pure_modules.py` gains its 14th module `serve/conv_cache` with two tests (the view card's int>0 opt-in gate
  + totals/parked splat + disabled boundaries / log-parse park-vs-skip-vs-restore counting + dropped-superseded
  only touching parked + evictions), each with a load-bearing differential.
- **`serve/engine_diag.py` 抽离（后端模块化第四步）** — 续抽链第四族：把 serve/server.py 里彼此零耦合的「引擎
  退出状态/启动日志诊断」一族整搬进新模块 `serve/engine_diag.py`：`start_failure_hint`（MTP draft-head 未塞进
  VRAM 时从引擎自身 `strata mtp:` 行给建议，否则用文字版提示）+ `engine_exit_words`（进程退出状态译成词：POSIX
  信号 / Windows NTSTATUS）+ `engine_crashed`（判定引擎是否被系统终结＝崩溃而非自行退出）+ `start_log_marks`
  （日志里命中的 GPU-runtime 失败标记）四个纯函数，连同其读取的 `DRAFT_HEAD_FAIL` / `DRAFT_HEAD_HINT` /
  `_WIN_CRASH` / `TRANSIENT_START_MARKS` 四常量一并搬出。AST out-deps 扫描坐实 free names 仅 stdlib os/signal +
  这些族内常量、无 server 全局；调用点保持原名经 try/except import 兜回。`cpu_isa_words` / `start_exit_note` /
  `START_RETRIES` / `transient_start_failure`（启动重试与 CPU 指令集探测＝异质职责）留在 server.py（后者读
  `TRANSIENT_START_MARKS` 经 import 兜回）。
  - **连带面**：无文本正则抓取源牵连（server.py 内多处调用点 + transient_start_failure 读常量均经 import 兜回）；
  `test_pure_modules.py` 加第 15 个纯模块 `serve/engine_diag`（二测试：exit_words 的表内 vs 段内未列 vs 普通退出码
  三路差分 + crashed 的 NTSTATUS 真/普通退出假/None 假 / start_log_marks 仅返回命中项 + start_failure_hint 非
  draft-head 短语返空、命中则拼出 mtp 建议），均带 load-bearing 差分。

  *`serve/engine_diag.py` extraction (fourth back-end modularization step):* the fourth chain family — the mutually
  decoupled *engine exit-status / start-log diagnostics* family is lifted whole out of `serve/server.py` into a new
  module `serve/engine_diag.py`: `start_failure_hint` (MTP draft-head-did-not-fit advice from the engine's own
  `strata mtp:` lines, else the advice in words) + `engine_exit_words` (a process exit status rendered in words:
  POSIX signal / Windows NTSTATUS) + `engine_crashed` (True when the system ended the engine — a crash, not a clean
  exit) + `start_log_marks` (which GPU-runtime failure texts the log holds), four pure functions lifted together
  with the four constants they read (`DRAFT_HEAD_FAIL` / `DRAFT_HEAD_HINT` / `_WIN_CRASH` / `TRANSIENT_START_MARKS`).
  The AST out-deps scan confirms the free names are stdlib os/signal + these in-family constants, no server globals;
  call sites keep their original names via a try/except import. `cpu_isa_words` / `start_exit_note` / `START_RETRIES` /
  `transient_start_failure` (start-retry + CPU-instruction-set probe, a heterogeneous responsibility) stay in
  server.py (the last one reads `TRANSIENT_START_MARKS` through the import shim).
  - *Blast radius:* no textual-regex capture source was involved (several call sites in server.py +
  transient_start_failure reading the constant, all through the import shim); `test_pure_modules.py` gains its 15th
  module `serve/engine_diag` with two tests (exit_words' in-table vs in-range-not-listed vs plain-exit-code
  three-way differential + crashed's NTSTATUS-true / plain-exit-false / None-false / start_log_marks returning only
  matched marks + start_failure_hint returning empty off the draft-head phrase and building the mtp advice on a hit),
  each with a load-bearing differential.

### Fixed / 修复

- **侧边栏「所有标签页突然全部隐藏」bug** — 把便签推送到对话（或任意触发采样保存的操作）后，左侧任务栏会在【每个】标签页一起变隐藏、所有显隐开关显示为关，只有点「恢复默认」才救回（commit `a75ab84`）：
  - **根因**：采样抽屉「应用」按钮（`s-apply`）用对象字面量**整体重建 `settings`，但字面量漏了 `sidebarTabs` 字段** → 运行期内存里的 `settings.sidebarTabs` 变成 `undefined`。`sidebarVisApply` 旧写法读 `settings.sidebarTabs || []` 退化成空数组 → body 在每个标签页都被加 `no-sidebar`，侧边栏全关。持久化的独立键 `strata.sidebar.tabs` 本身没坏，所以刷新/恢复默认可临时救回，但运行期一直卡在隐藏态。复现路径：便签推送 → `executeSpark` 调 `showTab("chat")` → `sidebarVisApply` 读到被抹掉的字段。
  - **修复**：`sidebarVisApply` / `renderSidebarSettings` 改经新 helper `sidebarShowList()` **直接读权威独立键 `strata.sidebar.tabs`**（缺失才回退内存字段、再回退空列表），契合既有「`sidebar.tabs` 才是权威源、`sampling` 键不含 `sidebarTabs`」的解耦设计。任何重建 `settings` 的路径都不再能在运行期抹掉侧边栏。
  - 回归门禁：`tests/test_sidevis_sapply_clobber_jsdom.mjs`（A helper 读权威键 / B 抹掉内存字段后 chat 仍显示侧边栏 / C 单变量差分：key+字段都缺才退化隐藏，证 helper 是 B-1 的真兜回）。

  *Sidebar silently hidden on every tab:* pushing a spark into the chat (or any action that triggers a sampling save) used to hide the left sidebar on EVERY tab at once, with all show-switches reading off — only “Reset to default” would bring it back. Root cause: the sampling drawer’s Apply button rebuilds the whole `settings` object with a literal that omits `sidebarTabs`, so the in-memory `settings.sidebarTabs` went `undefined`; `sidebarVisApply` then read `|| []` → empty → `body.no-sidebar` on every tab. The independent `strata.sidebar.tabs` key itself was intact (hence a reload/Reset recovered it), but the live session stayed hidden. Fix: `sidebarVisApply` / `renderSidebarSettings` now read the authoritative `strata.sidebar.tabs` key via a new `sidebarShowList()` helper (falling back to the field, then empty), matching the existing decoupling design where `sidebar.tabs` is the source of truth and the `sampling` key carries no `sidebarTabs`. Gated by `tests/test_sidevis_sapply_clobber_jsdom.mjs` (load-bearing single-variable differential).

## [0.1.0] - 2026-11-24

### Added / 新增

- **采样设置双层默认值模型（方案A）** — 采样抽屉「重置 / 设为默认值 / 应用」三个按钮的语义重新划分（commit `25fc4c9`）：
  - **设为默认值**：先把当前界面值 `应用`（写入 `sampling` 键、立即生效），再把它固化进新的 `sampling.default` 键——即「重置时会回到的基线」。
  - **重置**：恢复到 `sampling.default`；**若从未设过默认值则回落出厂 `DEFAULTS`**，永不落空。重置只刷新抽屉界面，仍需点「应用」才写盘。
  - **应用**：语义不变（把当前界面值写入 `sampling` 键）。
  - 三按钮的悬浮提示文案已同步更新（中英双语）以反映新语义。
  - 回归门禁：`tests/test_sampling_default_layer_jsdom.mjs`（L1 双写 / L2 取消不写 / L3 有默认回落基线 / L4 无默认回落出厂 / L3-vs-L4 单变量差分 load-bearing / L5 重置只刷界面不落盘）。

  *Sampling drawer two-layer default model (Plan A):* **Set to default** now applies the on-screen values (writes `sampling`, takes effect immediately) and then freezes them into a new `sampling.default` key — the baseline Reset returns to. **Reset** restores `sampling.default`, falling back to factory `DEFAULTS` when none was ever set (never blank); it only updates the form, pressing Apply is still required to persist. **Apply** is unchanged. Tooltips updated in both languages. Gated by `tests/test_sampling_default_layer_jsdom.mjs`.

- **调试页 / 记忆页卡片默认折叠双开关（对称）** — 新增两个设置抽屉开关（commit `e6c3453`）：「调试页卡片默认折叠」`settings.debugFold`（默认开=折叠）与「记忆页卡片默认折叠」`settings.memFold`（默认关=展开）。两者各自只管自己的卡片、互不越界；用户对某张卡的手动展开/折叠仍被记住并优先于开关。回归门禁：`tests/test_card_fold_settings.mjs`（四象限可控 + 单变量差分 load-bearing + 跨隔离 + 用户手动优先）。

  *Debug / memory card default-collapse switches (symmetric):* `settings.debugFold` (default on = collapsed) and `settings.memFold` (default off = expanded), each scoped to its own cards; a per-card manual toggle is remembered and wins over the switch. Gated by `tests/test_card_fold_settings.mjs`.
