/* Differential regression for the pre-condense CHAIN-ACTIVE GUARD (2026-10-23).
 *
 * The chunked pre-compaction path used to fire on EVERY over-budget auto compaction, including
 * mid-task, which is exactly the "interruption" users report (multiple serial summarise round
 * trips inserted into a live task, plus per-chunk toasts). Guard (compactConversation:3351):
 *   when auto==true AND autoDriveDepth>0 (the auto-drive chain is still running) -> DO NOT chunk:
 *   roll pendingCompact/resumeSnapshot back and return. The chain's own tail (exhausted/idle)
 *   fires the compaction normally. Manual path (auto==false) is NOT guarded.
 * Noise reduction (precondenseAndCompact:3308): a single toast at the FIRST fold carrying the
 *   total chunk count, not one per chunk.
 *
 * Differential design (same oversized seed, only the chain depth changes):
 *   Q1 guard:    auto=true, autoDriveDepth>0  -> NO summarise issued; pendingCompact rolled back
 *   Q2 control:  auto=true, autoDriveDepth==0 -> chunking fires (>=2 summarise) as before
 *   Q3 manual:   auto=false, autoDriveDepth>0 -> guard skipped (manual), chunking fires
 *   Q4 noise:    on the Q2 chunking run, the chunking toast appears EXACTLY once (first fold)
 *
 * Run: node tests/test_precondense_guard.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "serve", "web");
const src = readFileSync(join(WEB, "app.js"), "utf8");

function grab(name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing function ${name}`);
  if (src.slice(Math.max(0, start - 6), start).trimEnd().endsWith("async")) start = src.lastIndexOf("async", start);   // keep the async prefix
  let depth = 0, i = src.indexOf("{", start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? "OK  " : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  cond ? pass++ : fail++;
};
const t = (k, a) => k.replace(/\{\w+\}/g, () => (a && Object.values(a)[0] != null ? String(Object.values(a)[0]) : ""));

// Same oversized seed for every quadrant; only chain depth / auto flag changes.
const big = "任务背景。".repeat(6000);            // ~30000 chars each -> history (~60k) far exceeds the 24000 budget (maxCtx=0)
const seed = () => ([
  { role: "user", text: big, time: 1 },
  { role: "assistant", text: big + "执行日志。", time: 2 },
  { role: "user", text: "最后一个问题", time: 3 },
  { role: "assistant", text: "已回答。", time: 4 },
]);

const GRABS = {
  compactReqBudgetChars: grab("compactReqBudgetChars"),
  renderMsgForCompact: grab("renderMsgForCompact"),
  splitForCompact: grab("splitForCompact"),
  taskResumeSnapshot: grab("taskResumeSnapshot"),
  precondenseAndCompact: grab("precondenseAndCompact"),
  compactConversation: grab("compactConversation"),
};

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Isolated scope running the REAL grabbed functions against stubbed I/O.
async function makeScope(seedMessages, opts = {}) {
  const calls = { summarise: [], finalSend: 0, toasts: [], saved: 0, confirmed: 0 };
  const scope = {
    calls,
    settings: { autocompact: true, compactTarget: 25 },
    maxCtx: 0, activeId: "s1",
    messages: seedMessages, busy: null, chunkedCompacting: false,
    pendingCompact: false, resumeSnapshot: null, autoDriveDepth: opts.autoDriveDepth || 0,
    confirmYes: opts.confirmYes !== false,
    $: () => ({ value: "" }),
    t,
  };
  const S = new AsyncFunction("env", `
    const settings = env.settings;
    let maxCtx = env.maxCtx, activeId = env.activeId;
    let messages = env.messages, busy = env.busy, chunkedCompacting = env.chunkedCompacting;
    let pendingCompact = env.pendingCompact, resumeSnapshot = env.resumeSnapshot, autoDriveDepth = env.autoDriveDepth;
    const calls = env.calls;
    const t = env.t;
    const $ = (id) => env.$(id);
    const confirm = () => { calls.confirmed++; return env.confirmYes; };
    const toast = (kind, title) => { calls.toasts.push({ kind, title }); };
    const headers = () => ({});
    const estMsgChars = (m) => String(m.text || m.content || "").length;
    const computeTailBudgetChars = () => 1e9;
    const saveChat = () => { calls.saved++; };
    const renderChat = () => {};
    const ceText = (el) => (el && (el.textContent || el.value)) || "";
    const ceSetText = (el, txt) => { if (el) el.textContent = txt; };
    const autosize = () => {};
    const send = () => { calls.finalSend++; };
    const llmSummarize = async () => { calls.summarise.push(1); return "summary " + calls.summarise.length; };
    const compactReqBudgetChars = ${GRABS.compactReqBudgetChars};
    const renderMsgForCompact = ${GRABS.renderMsgForCompact};
    const splitForCompact = ${GRABS.splitForCompact};
    const taskResumeSnapshot = ${GRABS.taskResumeSnapshot};
    const precondenseAndCompact = ${GRABS.precondenseAndCompact};
    const compactConversation = ${GRABS.compactConversation};
    return { run: async (auto) => { await compactConversation(auto); },
      get: () => ({ pendingCompact, resumeSnapshot, chunkedCompacting }) };
  `);
  const api = await S(scope);
  return { calls, api };
}

const main = async () => {
  // Q1 guard: auto + chain active -> nothing summarised, pendingCompact rolled back.
  console.log("=== Q1 guard: auto + chain-active defers (no summarise) ===");
  {
    const s = await makeScope(seed(), { autoDriveDepth: 2 });
    await s.api.run(true);
    await new Promise((r) => setTimeout(r, 30));
    check("Q1 no summarise issued (guard defers)", s.calls.summarise.length === 0, `got ${s.calls.summarise.length}`);
    check("Q1 no final compact send issued", s.calls.finalSend === 0, `got ${s.calls.finalSend}`);
    check("Q1 pendingCompact rolled back to false", s.api.get().pendingCompact === false);
    check("Q1 resumeSnapshot rolled back to null", s.api.get().resumeSnapshot === null);
  }

  // Q2 control: auto + chain idle -> chunking fires as before (differential anchor for Q1).
  console.log("\n=== Q2 control: auto + chain-idle chunking fires ===");
  {
    const s = await makeScope(seed(), { autoDriveDepth: 0 });
    await s.api.run(true);
    await new Promise((r) => setTimeout(r, 60));
    check("Q2 summarise issued (>=2 folds)", s.calls.summarise.length >= 2, `got ${s.calls.summarise.length}`);
    check("Q2 final compact send fired after folding", s.calls.finalSend === 1, `got ${s.calls.finalSend}`);
    // Q4 noise: the chunking toast appears exactly once (first fold carries the total).
    const chunkToasts = s.calls.toasts.filter((x) => /chunking|分段/.test(String(x.title)));
    check("Q4 noise: chunking toast appears EXACTLY once", chunkToasts.length === 1, `got ${chunkToasts.length}`);
  }

  // Q3 manual: auto=false + chain active -> guard skipped (only auto is guarded), chunking fires.
  console.log("\n=== Q3 manual: auto=false, chain active -> guard skipped ===");
  {
    const s = await makeScope(seed(), { autoDriveDepth: 2, confirmYes: true });
    await s.api.run(false);
    await new Promise((r) => setTimeout(r, 60));
    check("Q3 confirm asked (manual path)", s.calls.confirmed === 1, `got ${s.calls.confirmed}`);
    check("Q3 summarise issued (manual not guarded)", s.calls.summarise.length >= 2, `got ${s.calls.summarise.length}`);
    check("Q3 final compact send fired", s.calls.finalSend === 1, `got ${s.calls.finalSend}`);
  }

  console.log();
  if (fail) { console.log(`FAILED (${fail}):`); process.exit(1); }
  console.log("PRECONDENSE-GUARD: ALL PASSED");
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
