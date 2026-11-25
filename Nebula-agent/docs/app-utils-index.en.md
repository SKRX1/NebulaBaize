# app_utils.js Symbol Index · 42 symbols / 14 families

**[简体中文](app-utils-index.md)** | English

`serve/web/app_utils.js` is the set of **shared pure functions** extracted from `app.js` by the
extraction chain (a classic script, loaded BEFORE `app.js`; top-level function declarations land on
the global scope, so app.js call sites keep their original names). The truth source for the export
set is `EXPORTS` in `tests/test_app_utils_contract.mjs`. This file registers each symbol's purpose
by family, so it is easy to locate and reuse later.

> **Before reusing, confirm it really can be reused**: every function here touches only standard
> globals (Date/Number/String/RegExp) or other app_utils members — it does NOT reference app.js's
> top-level mutable state (messages/settings/…) or the DOM. If your case needs DOM/state, keep it
> in app.js; do not force it into app_utils.

| Family | Purpose (one line) | Symbols |
|---|---|---|
| **F1 formatting** | humanise timestamps and byte counts (binary units, 1 decimal) | `timeStr`, `fmtBytesSel` |
| **F2 plan parsing** | parse markdown plan text (`- [x]`/`* [ ]` checklists) into `{done,label}` items | `parsePlanItems` |
| **F3 next-steps / proposal extraction** | pull the next-steps block and proposal cards out of a reply, and detect the reply's main language | `extractNextSteps`, `extractProposalsFromText`, `detectLang` |
| **F4 path / scope** | take the first path in a tool arg, split a path into per-segment absolute prefixes, scope up/down, deep clone | `firstPath`, `splitPath`, `nextScopeUp`, `nextScopeDown`, `clone` |
| **F5 tool classifier** | classify a tool result as file-write / test / etc. (for badge & audit colouring) | `classifyTool` |
| **F6 bug-box aggregation** | signature key, stats and grouping of bug-box entries | `bugBoxSigKey`, `bugBoxStats`, `bugBoxGroups` |
| **F7 thinking preprocessing** | take a one-line thought preview (skipping fenced code) and de-duplicate thought slices | `thinkPeek`, `dedupeThink` |
| **F8 misc helpers** | read a config value, safe truncation, task ordering, seed picking | `configValue`, `safeCut`, `taskOrder`, `pickSeed` |
| **F9 stream accounting** | snapshot-sent marker, tool sequence, stream-phase annotation | `snapSent`, `toolSeq`, `noteStreamPhase` |
| **F10 stream-bubble assembly** | assemble stream records into bubbles and compute the timing waterfall | `assembleStreamBubbles`, `computeWaterfall` |
| **F11 in-flight tool / task** | derive a Nebula task from a tool, get the current in-flight tool name | `nebTaskFromTool`, `inflightToolName` |
| **F12 markdown render** | decide media type by URL, build the image tag, render a proposal (with the `MD_EXT_*` extension sets) | `mdKindOf`, `mdImageTag`, `proposalMarkdown` |
| **F13 identifier normalisation** | design file name / safe group name / endpoint key / tag normalisation, tool-result to text | `designFileName`, `safeGroup`, `endpointKey`, `normalizeTags`, `toolResultText` |
| **F14 memory text metrics** | estimate token count and entry count (memory-card summary / threshold decisions) | `_memEstTokens`, `_memEntryCount` |
| **compaction (not family-fenced)** | assemble the outgoing context array; render one message for compaction | `buildCtxArr`, `renderMsgForCompact` |
| **spark (not family-fenced)** | decide whether a spark was executed; compare/order sparks by time | `sparkIsExecuted`, `sparkTimeCompare` |

## Extraction discipline (why these are safe to externalise)

- **AST out-deps = 0**: before each extraction a scanner confirms every "module-global name" a
  function references is stdlib / an app_utils member / its own parameter — it references **no
  app.js top-level mutable state or DOM**. A reference to a DOM global disqualifies purity, so it
  stays in app.js.
- **Byte-for-byte equivalent move**: moved out of app.js verbatim, the function body is not rewritten.
- **One contract lock per family**: `tests/test_app_utils_contract.mjs` locks the export set;
  `tests/test_app_utils_jsdom.mjs` feeds real inputs for runtime assertions.
- **No cross-topic families**: pure-but-unrelated functions are not lumped into one family (e.g. RAM
  alert vs sampling validation).

## Current state

The extraction chain has concluded: scanning all 435 top-level functions in app.js leaves only
1–24-line fragmentary single functions as "pure" candidates, none forming a family — the candidate
pool is exhausted. **42 symbols / 14 families** is the current stable ceiling, rollback point
`v-baseline-2026-11-26-c`. When adding a new pure function that genuinely has no DOM/state
dependency and matches an existing family's topic, extend it here and sync this index and the
`EXPORTS` contract lock.
