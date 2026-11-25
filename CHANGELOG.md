# Changelog

本项目的所有显著改动都记录在此文件。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

本项目のすべての主な変更点は本書に記録します。

All notable changes to this project are documented in this file.

## [Unreleased]

### Changed / 变更

- **`serve/exceptions.py` 抽离（后端模块化第五步）** — 续抽链第五族：把 serve/server.py 里彼此零耦合的「引擎/会话
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
