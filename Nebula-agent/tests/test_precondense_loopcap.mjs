/* Differential regression for the compaction INFINITE-LOOP fix (2026-11).
 *
 * ROOT CAUSE (read-real): at 100% occupancy a manual/auto compact -> precondenseAndCompact
 * folds the history, then a single-shot compact fires. On a genuinely-full window the compact
 * request ALSO overflows -> gateway 400s "context window exceeded even when compacting"
 * (http_server:2619). The finalize hook (app.js ~7520) rolled back and RE-ENTERED
 * precondenseAndCompact with no cap -> compacted 20+ times in a row.
 *
 * FIX A (app.js): module global precondenseDepth + cap. finalize re-entry is gated:
 *   depth >= cap -> stop, clear, surface insp.compact.loopstop (self-rescue). A real
 *   compaction success resets depth; a fresh manual compact resets depth.
 * FIX B (app.js): measuredInjectTokens() feeds compactReqBudgetChars/compactChunkMaxTokens as
 *   a floor, so an over-10% injection (rules+knowledge+schemas) shrinks the compact budget and
 *   the single-shot compact actually fits -- fewer chats enter the loop at all.
 * FIX C (config): the cap is settings.precondenseMax (drawer slider, default PRECONDENSE_MAX=2)
 *   read through precondenseCap(); PRECONDENSE_MAX stays the hard default/fallback.
 *
 * Differential design:
 *   Q1 escape:  depth 0 < cap -> finalize re-entry CALLS precondense (escape hatch used)
 *   Q2 capfire: depth == cap  -> finalize re-entry does NOT call precondense, fires loopstop, resets depth
 *   Q3 reset:   a manual compact resets a stale depth to 0 (a fresh user action is never blocked)
 *   Q4 B-cal:   a big measured injection SHRINKS compactReqBudgetChars vs a near-empty one
 *   Q5 config:  settings.precondenseMax=3 RAISES the cap -- depth 2 no longer trips, escape runs
 *   static locks: PRECONDENSE_MAX=2 (default), precondenseCap() gate + keys, slider + i18n, injectTok floor
 *
 * Run: node tests/test_precondense_loopcap.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "serve", "web");
const src = readFileSync(join(WEB, "app_utils.js"), "utf8") + "\n" + readFileSync(join(WEB, "app.js"), "utf8");
const i18n = readFileSync(join(WEB, "i18n.js"), "utf8");
const html = readFileSync(join(WEB, "index.html"), "utf8");

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? "OK  " : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  cond ? pass++ : fail++;
};
const t = (k, a) => k.replace(/\{\w+\}/g, () => (a && Object.values(a)[0] != null ? String(Object.values(a)[0]) : ""));

function grab(name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing function ${name}`);
  if (src.slice(Math.max(0, start - 6), start).trimEnd().endsWith("async")) start = src.lastIndexOf("async", start);
  let depth = 0, i = src.indexOf("{", start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

const GRABS = {
  precondenseCap: grab("precondenseCap"),
  measuredInjectTokens: grab("measuredInjectTokens"),
  estMsgChars: grab("estMsgChars"),
  compactReqBudgetChars: grab("compactReqBudgetChars"),
  compactConversation: grab("compactConversation"),
  taskResumeSnapshot: grab("taskResumeSnapshot"),
  renderMsgForCompact: grab("renderMsgForCompact"),
  splitForCompact: grab("splitForCompact"),
  precondenseAndCompact: grab("precondenseAndCompact"),
};

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Isolated scope. finalizeReentry mirrors the app.js ~7520 overflow re-entry block verbatim
// (the block is inline inside streamAssistant and not independently grabbable); a static lock
// below asserts the source still contains that exact decision, so the mirror stays honest.
async function makeScope(seedMessages, opts = {}) {
  const calls = { summarise: [], finalSend: 0, toasts: [], saved: 0, confirmed: 0 };
  const scope = {
    calls,
    settings: { autocompact: true, compactTarget: 25, precondenseMax: opts.precondenseMax },
    maxCtx: opts.maxCtx != null ? opts.maxCtx : 0,
    activeId: "s1",
    lastPromptTokens: opts.lastPromptTokens || 0,
    messages: seedMessages, busy: null, chunkedCompacting: false,
    pendingCompact: false, resumeSnapshot: null,
    autoDriveDepth: opts.autoDriveDepth || 0,
    precondenseDepth: opts.precondenseDepth || 0,
    confirmYes: opts.confirmYes !== false,
    $: () => ({ value: "" }),
    t,
  };
  const S = new AsyncFunction("env", `
    const settings = env.settings;
    let maxCtx = env.maxCtx, activeId = env.activeId, lastPromptTokens = env.lastPromptTokens;
    let messages = env.messages, busy = env.busy, chunkedCompacting = env.chunkedCompacting;
    let pendingCompact = env.pendingCompact, resumeSnapshot = env.resumeSnapshot, autoDriveDepth = env.autoDriveDepth;
    let continueRequested = false;
    let precondenseDepth = env.precondenseDepth;
    const PRECONDENSE_MAX = 2;
    const calls = env.calls;
    const t = env.t;
    const _compactInjectTok = () => { const b = maxCtx > 0 ? maxCtx : 16384; return Math.max(8000, Math.floor(b * 0.10), measuredInjectTokens()); };
    const $ = (id) => env.$(id);
    const confirm = () => { calls.confirmed++; return env.confirmYes; };
    const askConfirm = async () => { calls.confirmed++; return env.confirmYes; };  // 2026-11-26 compactConversation now awaits this
    const toast = (kind, title) => { calls.toasts.push({ kind, title }); };
    const headers = () => ({});
    const computeTailBudgetChars = () => 1e9;
    const saveChat = () => { calls.saved++; };
    const renderChat = () => {};
    const ceText = (el) => (el && (el.textContent || el.value)) || "";
    const ceSetText = (el, txt) => { if (el) el.textContent = txt; };
    const autosize = () => {};
    const send = () => { calls.finalSend++; };
    const llmSummarize = async () => { calls.summarise.push(1); return "summary " + calls.summarise.length; };
    const precondenseCap = ${GRABS.precondenseCap};
    const estMsgChars = ${GRABS.estMsgChars};
    const measuredInjectTokens = ${GRABS.measuredInjectTokens};
    const compactReqBudgetChars = ${GRABS.compactReqBudgetChars};
    const precondenseAndCompact = ${GRABS.precondenseAndCompact};
    const renderMsgForCompact = ${GRABS.renderMsgForCompact};
    const splitForCompact = ${GRABS.splitForCompact};
    const taskResumeSnapshot = ${GRABS.taskResumeSnapshot};
    const compactConversation = ${GRABS.compactConversation};
    // verbatim mirror of the finalize overflow re-entry gate (app.js ~7520):
    const finalizeReentry = (auto) => {
      if (precondenseDepth >= precondenseCap()) {
        precondenseDepth = 0;
        toast("err", t("insp.compact.loopstop.title"), t("insp.compact.loopstop.msg"), 12000);
        return;
      }
      precondenseAndCompact(auto);
    };
    return {
      run: async (auto) => { await compactConversation(auto); },
      reentry: (auto) => finalizeReentry(auto),
      get: () => ({ precondenseDepth, chunkedCompacting }),
      budget: () => compactReqBudgetChars(),
    };
  `);
  const api = await S(scope);
  return { calls, api };
}

const big = "任务背景。".repeat(6000);
const seed = () => ([
  { role: "user", text: big, time: 1 },
  { role: "assistant", text: big + "执行日志。", time: 2 },
]);

const main = async () => {
  console.log("=== Q1 escape: depth 0 < cap -> finalize re-entry USES the escape hatch ===");
  {
    const s = await makeScope(seed(), { autoDriveDepth: 0 });
    s.api.reentry(true);
    await new Promise((r) => setTimeout(r, 60));
    check("Q1 precondense was invoked (escape hatch used)", s.calls.summarise.length >= 1, `summarise ${s.calls.summarise.length}`);
    check("Q1 no loopstop toast", !s.calls.toasts.some((x) => /loopstop|停止/i.test(String(x.title))));
    check("Q1 depth incremented past first fold", s.api.get().precondenseDepth >= 1, `depth ${s.api.get().precondenseDepth}`);
    console.log("    [diag Q1] toasts:", JSON.stringify(s.calls.toasts), "finalSend", s.calls.finalSend, "saved", s.calls.saved);
  }

  console.log("\n=== Q2 capfire: depth == cap -> finalize re-entry STOPS + fires loopstop ===");
  {
    const s = await makeScope(seed(), { autoDriveDepth: 0, precondenseDepth: 2 });
    s.api.reentry(true);
    await new Promise((r) => setTimeout(r, 60));
    check("Q2 NO precondense invoked (loop capped)", s.calls.summarise.length === 0, `summarise ${s.calls.summarise.length}`);
    const stops = s.calls.toasts.filter((x) => /loopstop|停止|stopped/i.test(String(x.title)));
    check("Q2 loopstop self-rescue toast fired", stops.length === 1, `toasts ${stops.length}`);
    check("Q2 depth reset to 0 after cap fired", s.api.get().precondenseDepth === 0, `depth ${s.api.get().precondenseDepth}`);
  }

  console.log("\n=== Q3 reset: a fresh manual compact clears a stale depth ===");
  {
    // depth starts stale at 2; manual compactConversation resets it, so the fold runs, not blocked.
    const s = await makeScope(seed(), { autoDriveDepth: 2, confirmYes: true, precondenseDepth: 2 });
    await s.api.run(false);
    await new Promise((r) => setTimeout(r, 60));
    check("Q3 manual compact not blocked by stale depth (fold fired)", s.calls.summarise.length >= 1, `summarise ${s.calls.summarise.length}`);
  }

  console.log("\n=== Q4 B-calibrate: a big measured injection shrinks the compact budget ===");
  {
    // Same window; big injection (lastPromptTokens far above the message-token estimate) vs a tiny one.
    const withInject = await makeScope(seed(), { maxCtx: 131072, lastPromptTokens: 60000 }); // messages ~30k tok -> injection ~30k
    const noInject = await makeScope(seed(), { maxCtx: 131072, lastPromptTokens: 0 });          // injection 0
    const bInject = withInject.api.budget();
    const bNone = noInject.api.budget();
    check("Q4 measured injection reduces the budget", bInject < bNone, `bInject ${bInject} < bNone ${bNone}`);
  }

  console.log("\n=== Q5 config: settings.precondenseMax=3 raises the cap (depth 2 escapes) ===");
  {
    // With the slider raised to 3, a depth of 2 is UNDER the cap -> the escape hatch runs, no loopstop.
    const s = await makeScope(seed(), { autoDriveDepth: 0, precondenseDepth: 2, precondenseMax: 3 });
    s.api.reentry(true);
    await new Promise((r) => setTimeout(r, 60));
    check("Q5 raised cap lets depth 2 escape (precondense invoked)", s.calls.summarise.length >= 1, `summarise ${s.calls.summarise.length}`);
    check("Q5 no loopstop at depth 2 when cap is 3", !s.calls.toasts.some((x) => /loopstop|停止|stopped/i.test(String(x.title))));
  }

  console.log("\n=== static locks (anti-drift) ===");
  check("PRECONDENSE_MAX = 2 present (hard default/fallback)", /const PRECONDENSE_MAX = 2;/.test(src));
  check("precondenseCap() getter defined", /function precondenseCap\(\) \{ const v = \+settings\.precondenseMax; return v >= 1 \? v : PRECONDENSE_MAX; \}/.test(src));
  check("finalize gate reads precondenseDepth >= precondenseCap()", src.includes("if (precondenseDepth >= precondenseCap()) {"));
  check("loopstop toast key used in finalize", src.includes('t("insp.compact.loopstop.title")') && src.includes('t("insp.compact.loopstop.msg")'));
  check("success path resets precondenseDepth", src.includes("precondenseDepth = 0;   // A: a real compaction succeeded"));
  check("manual compact resets precondenseDepth", src.includes("if (!auto) precondenseDepth = 0;"));
  check("DEFAULTS carries precondenseMax: 2", /compactTarget: 25, precondenseMax: 2,/.test(src));
  check("drawer loads s-precondmax from settings.precondenseMax", src.includes('$("s-precondmax").value = (+s.precondenseMax >= 1) ? +s.precondenseMax : 2;'));
  check("drawer saves precondenseMax from slider", src.includes('precondenseMax: (+(+$("s-precondmax").value) || 2) >= 1 ? +(+$("s-precondmax").value) : 2,'));
  check("compactReqBudgetChars injectTok uses shared _compactInjectTok (measuredInjectTokens floor)", /const injectTok = _compactInjectTok\(\)/.test(src) && /function _compactInjectTok\(\)[\s\S]*?measuredInjectTokens\(\)/.test(src));
  check("compactChunkMaxTokens injectTok uses measuredInjectTokens floor", (src.match(/measuredInjectTokens\(\)/g) || []).length >= 3);
  check("i18n loopstop keys defined (zh+en)", (i18n.match(/insp\.compact\.loopstop\.title/g) || []).length === 2 && (i18n.match(/insp\.compact\.loopstop\.msg/g) || []).length === 2);
  check("index.html has s-precondmax slider wired to drawer.precondmax", html.includes("id=\"s-precondmax\"") && /type="range"[^\n]*id="s-precondmax"/.test(html) && html.includes('data-i18n="drawer.precondmax"'));
  check("i18n drawer.precondmax keys defined (zh+en)", (i18n.match(/drawer\.precondmax"/g) || []).length === 2 && (i18n.match(/drawer\.precondmax\.hint"/g) || []).length === 2);

  console.log(`\nPRECONDENSE-LOOPCAP: ${fail ? "FAILED" : "ALL PASSED"} (${pass} pass, ${fail} fail)`);
  process.exit(fail ? 1 : 0);
};
main();
