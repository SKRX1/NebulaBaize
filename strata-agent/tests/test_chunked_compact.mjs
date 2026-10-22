/* Regression test for chunked pre-compaction (2026-10-20).
 *
 * The old compact put the WHOLE history + "summarise" into one request. When the history itself
 * exceeded the model window the compact 400ed ("context window exceeded even when compacting") and
 * compaction could never run. Now compactConversation() folds the history in bounded chunks first
 * (each with strata_compact:true), then runs the normal single-shot compact on the condensed
 * transcript. Asserts:
 *   Phase A (success):
 *     1. oversized history -> >=2 bounded summarise calls, each with strata_compact:true
 *     2. every chunk request body stays under the per-request budget
 *     3. the final single-shot compact turn runs on the CONDENSED transcript (small payload)
 *     4. the finish hook rebuilds messages as [system 对话压缩摘要, ...tail] and persists it
 *   Phase B (summariser 500s):
 *     5. the pre-condense fails -> history left UNTOUCHED, no final compact turn fired
 *
 * Run: node tests/test_chunked_compact.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "serve", "web");

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const COMPACT_SYS_PREFIX = "你是对话压缩器";
const COMPACT_PROMPT_MARKER = "请压缩我们到目前为止的对话";
const BUDGET_CHARS = 43200;          // maxCtx=0 -> max(6000, 24000*1.8)

function makeDom(seedMessages) {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
  const win = dom.window;
  const doc = win.document;
  win.TextDecoder = TextDecoder;
  win.TextEncoder = TextEncoder;
  win.AbortController = AbortController;
  win.matchMedia = () => ({ matches: false, media: "", onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
  if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
  win.localStorage.setItem("strata.lang", "en");
  win.localStorage.setItem("strata.chat", JSON.stringify(seedMessages));
  return { dom, win, doc };
}

function sseResponse(text) {
  const enc = new TextEncoder();
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`,
    "data: [DONE]\n",
  ];
  return { ok: true, status: 200, json: async () => ({}),
    body: { getReader() { let i = 0; return { read() {
      if (i < chunks.length) return Promise.resolve({ value: enc.encode(chunks[i++]), done: false });
      return Promise.resolve({ value: undefined, done: true });
    } }; } } };
}

// ── Phase A: oversized history compacts via chunks ────────────────────────────
const bigA = "任务背景A。".repeat(3000);   // 18000 chars each
const bigB = "执行日志B。".repeat(3000);
const seedA = [
  { role: "user", text: bigA, time: 1 },
  { role: "assistant", text: bigB, time: 2 },
  { role: "user", text: bigA, time: 3 },
  { role: "assistant", text: bigB, time: 4 },
  { role: "user", text: "最后一个小问题", time: 5 },
  { role: "assistant", text: "已回答。", time: 6 },
];

function reasoningOnlyResponse(text) {          // Phase C: small quantized models emit reasoning_content only, content empty
  const enc = new TextEncoder();
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: text } }] })}\n`,
    "data: [DONE]\n",
  ];
  return { ok: true, status: 200, json: async () => ({}),
    body: { getReader() { let i = 0; return { read() {
      if (i < chunks.length) return Promise.resolve({ value: enc.encode(chunks[i++]), done: false });
      return Promise.resolve({ value: undefined, done: true });
    } }; } } };
}

const A = makeDom(seedA);
const winA = A.win, docA = A.doc;
const callsA = [];
winA.fetch = async (url, opts = {}) => {
  const u = String(url); const method = opts.method || "GET";
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model" }) };
  if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
  if (u.endsWith("v1/chat/completions")) {
    const isSummarise = body && body.messages && body.messages[0] && String(body.messages[0].content || "").startsWith(COMPACT_SYS_PREFIX);
    callsA.push({ body, isSummarise });
    if (isSummarise) return sseResponse("分段摘要" + callsA.filter(c => c.isSummarise).length + "。");
    return sseResponse("最终摘要：任务已完成。");
  }
  return { ok: true, status: 200, json: async () => ({}) };
};
winA.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
winA.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  console.log("=== phase A: chunked pre-compaction success ===");
  await sleep(30);
  const totalChars = seedA.reduce((s, m) => s + (m.text || "").length, 0);
  check("seeded history exceeds the single-request budget", totalChars > BUDGET_CHARS, `total=${totalChars} budget=${BUDGET_CHARS}`);

  winA.confirm = () => true;                 // manual path dialog (function decls aren't reachable via eval scope)
  const btnA = docA.querySelector("#ins-compact");
  btnA.disabled = false;                     // startup inspector disables it at 0 usage
  btnA.click();
  // wait until the compact turn finished and messages were rebuilt (poll up to 8s)
  let persisted = null;
  for (let t = 0; t < 150; t++) {
    await sleep(100);
    try { persisted = JSON.parse(winA.localStorage.getItem("strata.chat")); } catch (e) { persisted = null; }
    // the FINAL summary (mocked text) only lands after the single-shot compact turn + finish hook
    if (persisted && persisted[0] && /最终摘要/.test(persisted[0].content || "")) break;
  }
  await sleep(200);

  const sums = callsA.filter((c) => c.isSummarise);
  check(">=2 bounded summarise calls issued", sums.length >= 2, `got ${sums.length}`);
  check("every summarise call carries strata_compact:true", sums.every((c) => c.body.strata_compact === true));
  check("every summarise call carries an adaptive max_tokens (positive, <=4096)",
    sums.every((c) => Number.isInteger(c.body.max_tokens) && c.body.max_tokens > 0 && c.body.max_tokens <= 4096),
    sums.map((c) => c.body.max_tokens).join(","));
  const oversized = sums.filter((c) => c.body.messages[1].content.length > BUDGET_CHARS + 2000);
  check("every chunk request body stays under the budget", oversized.length === 0,
    oversized.length ? `max=${Math.max(...oversized.map((c) => c.body.messages[1].content.length))}` : "");
  check("summaries are folded (later chunks merge earlier summary)",
    sums.length >= 2 && /此前累计摘要/.test(sums[sums.length - 1].body.messages[1].content));

  const finalTurn = callsA.find((c) => !c.isSummarise && c.body.messages.some((m) => {
    const s = String(m.content || "");
    return s.includes(COMPACT_PROMPT_MARKER) || s.includes("Compress our conversation so far");
  }));
  check("final single-shot compact turn fired", !!finalTurn);
  if (finalTurn) {
    const nonSys = finalTurn.body.messages.filter((m) => m.role !== "system");
    const condChars = finalTurn.body.messages.reduce((s, m) => s + String(m.content || "").length, 0);
    check("final compact payload is the CONDENSED transcript (fits one request)", condChars <= BUDGET_CHARS + 2000, `chars=${condChars}`);
    check("final compact payload keeps a recent tail", nonSys.length >= 2, `nonSys=${nonSys.length}`);
  }
  check("messages rebuilt as [system 对话压缩摘要, ...tail]",
    !!persisted && persisted[0] && persisted[0].role === "system" && /对话压缩摘要/.test(persisted[0].content),
    persisted && persisted[0] ? JSON.stringify((persisted[0].content || "").slice(0, 30)) : "no persist");
  check("final summary text present in the rebuilt system message",
    !!persisted && /最终摘要/.test((persisted[0] && persisted[0].content) || ""));
  check("compacted transcript is far smaller than the original",
    !!persisted && persisted.length < seedA.length,
    `orig=${seedA.length} now=${persisted ? persisted.length : "?"}`);

  // ── Phase B: summariser fails -> history untouched ──────────────────────────
  console.log("\n=== phase B: summariser failure keeps history intact ===");
  const B = makeDom(seedA);
  const winB = B.win, docB = B.doc;
  const callsB = [];
  winB.fetch = async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model" }) };
    if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
    if (u.endsWith("v1/chat/completions")) {
      const isSummarise = body && body.messages && body.messages[0] && String(body.messages[0].content || "").startsWith(COMPACT_SYS_PREFIX);
      callsB.push({ isSummarise });
      return { ok: false, status: 500, json: async () => ({ error: { message: "boom" } }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  winB.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
  winB.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
  await sleep(30);
  winB.confirm = () => true;
  const btnB = docB.querySelector("#ins-compact");
  btnB.disabled = false;
  btnB.click();
  await sleep(4000);                          // 1 call + 1 retry (0.8s backoff) then the failure path

  const sumB = callsB.filter((c) => c.isSummarise);
  check("summariser was attempted (with retry)", sumB.length >= 1, `got ${sumB.length}`);
  check("NO final compact turn fired on failure",
    callsB.every((c) => c.isSummarise), `nonSummarise=${callsB.filter((c) => !c.isSummarise).length}`);
  const afterB = JSON.parse(winB.localStorage.getItem("strata.chat"));
  check("history left UNTOUCHED after failure",
    afterB.length === seedA.length && !(afterB[0].content || "").includes("对话压缩摘要"),
    `len=${afterB.length}`);

  console.log("=== phase C: reasoning-only summariser succeeds (fix: reasoning counts as content) ===");
  const C = makeDom(seedA.slice());
  const winC = C.win, docC = C.doc;
  const callsC = [];
  winC.fetch = async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model" }) };
    if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
    if (u.endsWith("v1/chat/completions")) {
      const isSummarise = body && body.messages && body.messages[0] && String(body.messages[0].content || "").startsWith(COMPACT_SYS_PREFIX);
      callsC.push({ body, isSummarise });
      if (isSummarise) return reasoningOnlyResponse("reasoning-only 分段摘要" + callsC.filter(c => c.isSummarise).length + "。");
      return sseResponse("最终摘要：任务已完成。");
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  winC.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
  winC.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
  await sleep(30);
  winC.confirm = () => true;
  const btnC = docC.querySelector("#ins-compact");
  btnC.disabled = false;
  btnC.click();
  let persistedC = null;
  for (let k = 0; k < 150; k++) { await sleep(100); persistedC = JSON.parse(winC.localStorage.getItem("strata.chat")); if (persistedC && persistedC[0] && /最终摘要/.test(persistedC[0].content || "")) break; }
  await sleep(200);
  const sumsC = callsC.filter((c) => c.isSummarise);
  check("C: reasoning-only summarise calls issued", sumsC.length >= 2, "got " + sumsC.length);
  const finalC = callsC.find((c) => !c.isSummarise && c.body.messages.some((m) => String(m.content || "").includes(COMPACT_PROMPT_MARKER) || String(m.content || "").includes("Compress our conversation so far")));
  check("C: NO empty-summary failure (final single-shot compact turn fired)", !!finalC);
  check("C: history REBUILT from reasoning (not left untouched)", !!persistedC && persistedC[0] && persistedC[0].role === "system" && /对话压缩摘要/.test(persistedC[0].content), persistedC && persistedC[0] ? JSON.stringify((persistedC[0].content || "").slice(0, 30)) : "no persist");
  C.win.close();

  console.log();
  if (FAILURES.length) { console.log(`FAILED (${FAILURES.length}):`); for (const f of FAILURES) console.log("  - " + f); A.win.close(); B.win.close(); process.exit(1); }
  console.log("CHUNKED-COMPACT: ALL PASSED");
  A.win.close(); B.win.close();
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
