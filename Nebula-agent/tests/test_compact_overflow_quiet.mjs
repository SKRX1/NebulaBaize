/* Differential gate for the compact-overflow quiet fix (2026-11-02).
 *
 * Backend emits the SSE error "upstream error: context window exceeded even when
 * compacting" when a compaction request ITSELF is refused by the model window. That
 * error is OWNED by the frontend pendingCompact branch (app.js), which surfaces ONE
 * accurate chunkfail notice and reroutes through the chunked path -- the escape hatch
 * that works. The generic catch path must therefore NOT ALSO draw its scary "request
 * failed" red toast for this exact wording (that DOUBLE-reports it on a quiet path).
 *
 * The bug this gate locks: the generic catch path used to draw the red "request failed"
 * toast for this error too. Fix: the generic toast is skipped when this turn is a
 * compact turn (pendingCompact) AND the error matches this wording; the pendingCompact
 * branch is then the single owner (one accurate quiet notice, no generic red banner).
 *
 * Single-variable differential pair -- both drive the REAL app.js (jsdom boot), both
 * reach the same path via the compact button (disabled=false then click, the same way
 * the existing chunked-compact gate drives it -- the startup inspector disables the button
 * at 0 usage), the ONLY difference is the wording the mocked fetch streams back as an SSE
 * data:{error} chunk (so it throws like a real stream error and reaches the catch):
 *   TARGET  compact turn + THIS wording   -> generic red banner count == 0 (guard quiets it)
 *   CONTROL compact turn + a PLAIN error   -> generic red banner count == 1 (guard not matched)
 * Both must actually reach the stream (fetch-calls >= 1) so a 0-banner TARGET is real, not
 * "the chain never ran". Diagnostic logs the fetch-call count and every toast title painted.
 * Plus a static source lock on the guard condition (RED on the old unguarded code).
 *
 * Run: node tests/test_compact_overflow_quiet.mjs
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

const OVERFLOW_MSG = "upstream error: context window exceeded even when compacting";
const PLAIN_MSG = "some normal upstream failure";
const GENERIC_TOAST_TITLE_EN = "The request failed";   // i18n en title of the generic red toast

const seedSmall = [
  { role: "user", text: "hello there", time: 1 },
  { role: "assistant", text: "general reply", time: 2 },
];

function makeDom() {
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
  win.localStorage.setItem("strata.chat", JSON.stringify(seedSmall));
  return { dom, win, doc };
}

function sseError(message) {
  const enc = new TextEncoder();
  const chunks = [`data: ${JSON.stringify({ error: { message } })}\n`, "data: [DONE]\n"];
  return { ok: true, status: 200, json: async () => ({}),
    body: { getReader() { let i = 0; return { read() {
      if (i < chunks.length) return Promise.resolve({ value: enc.encode(chunks[i++]), done: false });
      return Promise.resolve({ value: undefined, done: true });
    } }; } } };
}

function attachFetch(win, message, calls) {
  win.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model" }) };
    if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
    if (u.endsWith("v1/chat/completions")) { calls.push(1); return sseError(message); }
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function toastTitles(doc) {
  return [...doc.querySelectorAll("#toasts .st-toast__title")].map((n) => n.textContent);
}

const main = async () => {
  const src = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
  check("static: generic toast guarded by pendingCompact+wording",
    /if \(!\(pendingCompact && \/context window exceeded even when compacting\/i\.test\(m\.error\)\)\)/.test(src));

  console.log("=== TARGET: compact turn + THIS wording -> NO generic red banner (guard quiets it) ===");
  const T = makeDom();
  T.win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
  T.win.eval(src);
  await sleep(30);
  const callsT = [];
  attachFetch(T.win, OVERFLOW_MSG, callsT);
  T.win.confirm = () => true;
  const btnT = T.doc.querySelector("#ins-compact"); btnT.disabled = false;   // startup disables it at 0 usage
  btnT.click();
  await sleep(6000);
  const titlesT = toastTitles(T.doc);
  console.log("  DIAG fetch-calls=" + callsT.length + " toast-titles=" + JSON.stringify(titlesT));
  check("TARGET: chain reached the stream", callsT.length >= 1, `calls=${callsT.length}`);
  check("TARGET: generic red banner count == 0", titlesT.filter((x) => x === GENERIC_TOAST_TITLE_EN).length === 0);

  console.log("\n=== CONTROL: compact turn + a PLAIN error -> generic red banner DOES fire ===");
  const C = makeDom();
  C.win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
  C.win.eval(src);
  await sleep(30);
  const callsC = [];
  attachFetch(C.win, PLAIN_MSG, callsC);
  C.win.confirm = () => true;
  const btnC = C.doc.querySelector("#ins-compact"); btnC.disabled = false;
  btnC.click();
  await sleep(6000);
  const titlesC = toastTitles(C.doc);
  console.log("  DIAG fetch-calls=" + callsC.length + " toast-titles=" + JSON.stringify(titlesC));
  check("CONTROL: chain reached the stream", callsC.length >= 1, `calls=${callsC.length}`);
  check("CONTROL: generic red banner count == 1", titlesC.filter((x) => x === GENERIC_TOAST_TITLE_EN).length === 1);

  if (FAILURES.length) { console.log(`\nFAILED (${FAILURES.length}):`); for (const f of FAILURES) console.log("  - " + f); process.exit(1); }
  console.log("\nCOMPACT-OVERFLOW-QUIET: ALL GREEN");
  T.win.close(); C.win.close();
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
