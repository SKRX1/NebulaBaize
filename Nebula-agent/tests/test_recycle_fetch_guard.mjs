/* Runtime regression for the renderRecycle family (bug:unhandledrejection, app.js).
 *
 * Root cause (one-hand evidence, 2026-11-13 09:46):
 *   renderRecycle / renderRecycleBin / renderRecycleAudit are all async and each does
 *   `await fetch("api/recycle", ...)`. On a network blip the fetch rejects with
 *   TypeError("Failed to fetch"); inside an async function that becomes a rejected promise.
 *   They are invoked FIRE-AND-FORGET (showTab:198 calls renderRecycle() with no await/.catch,
 *   and renderRecycle calls renderRecycleBin/Audit at :10254/10255 without await), so the
 *   rejection had nowhere to go -> global unhandledrejection. Each function now has its own
 *   try/catch: renderRecycle falls back to the existing recycle.err placeholder, the two
 *   sub-renderers keep their last data and no-op.
 *
 * Why the capture lives at the NODE process layer, not jsdom window:
 *   jsdom does NOT dispatch `unhandledrejection` for a plain floating promise rejection — only
 *   for some event-loop paths. So a window-listener counter reads 0 even when a guard is stripped.
 *   The faithful model of "the rejection escaped with nobody to catch it" is node's own
 *   process.on('unhandledRejection'): each realm runs ONE function fire-and-forget, so if the
 *   function's own try/catch is present its returned promise RESOLVES (no unhandled rejection);
 *   if the guard is stripped (control) the returned promise REJECTS and, with no .catch at the
 *   call site, node's global unhandledRejection FIRES. Realms run serially to avoid cross-talk.
 *
 * LOAD-BEARING DIFF: fix realm (guard present) MUST show 0 unhandled rejections; control realm
 * (guard stripped) MUST show >=1 for that same function — fix strictly beats control.
 *
 * Run standalone: node tests/test_recycle_fetch_guard.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("E:/Nebula/NebulaBaize/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "serve", "web");

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const i18nSrc = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
const APP_BASE = fs.readFileSync(path.join(WEB, "app.js"), "utf8").replace(/\r\n/g, "\n");  // literals below use LF; working-tree app.js is CRLF -> normalize so includes()/replace() compare apples-to-apples

// exact on-disk substrings (the fix as landed) and the guard-stripped "control" variants
const RC_FIX = '  let j;\n  try { const r = await fetch("api/recycle", {method: "POST", headers: headers(true), body: JSON.stringify({action: "scan", workspace: ws, categories: recycleCheckedCats(), retention_hours: recycleRetentionH()})}); j = await r.json(); } catch (e) { box.innerHTML = \'<div class="muted small">\' + esc(t("recycle.err")) + \'</div>\'; return; }';
const RC_CTRL = '  let j;\n  { const r = await fetch("api/recycle", {method: "POST", headers: headers(true), body: JSON.stringify({action: "scan", workspace: ws, categories: recycleCheckedCats(), retention_hours: recycleRetentionH()})}); j = await r.json(); }';

const BIN_FIX = 'async function renderRecycleBin(ws) {\n  if (!$("recycle-bin")) return;\n  try {\n    const r = await fetch("api/recycle", {method: "POST", headers: headers(true), body: JSON.stringify({action: "scan", workspace: ws})});\n    const j = await r.json();\n    recycleBinData = (j && j.in_bin) || [];\n    paintRecycleBin();\n  } catch (e) { /* network blip: keep last data, no-op */ }\n}';
const BIN_CTRL = 'async function renderRecycleBin(ws) {\n  if (!$("recycle-bin")) return;\n  {\n    const r = await fetch("api/recycle", {method: "POST", headers: headers(true), body: JSON.stringify({action: "scan", workspace: ws})});\n    const j = await r.json();\n    recycleBinData = (j && j.in_bin) || [];\n    paintRecycleBin();\n  }\n}';

const AUD_FIX = 'async function renderRecycleAudit(ws) {\n  if (!$("recycle-audit")) return;\n  try {\n    const r = await fetch("api/recycle", {method: "POST", headers: headers(true), body: JSON.stringify({action: "audit", workspace: ws})});\n    const j = await r.json();\n    recycleAuditData = (j && j.audit) || [];\n    paintRecycleAudit();\n  } catch (e) { /* network blip: keep last data, no-op */ }\n}';
const AUD_CTRL = 'async function renderRecycleAudit(ws) {\n  if (!$("recycle-audit")) return;\n  {\n    const r = await fetch("api/recycle", {method: "POST", headers: headers(true), body: JSON.stringify({action: "audit", workspace: ws})});\n    const j = await r.json();\n    recycleAuditData = (j && j.audit) || [];\n    paintRecycleAudit();\n  }\n}';

for (const [name, sub] of [['RC_FIX', RC_FIX], ['BIN_FIX', BIN_FIX], ['AUD_FIX', AUD_FIX]]) {
  check(`app.js still contains the landed ${name} guard`, APP_BASE.includes(sub));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// node-process-level capture: this is the real "nobody caught it" signal jsdom can't provide.
let nodeRejections = 0;
process.on("unhandledRejection", () => { nodeRejections++; });

// Boot ONE realm, call ONE function fire-and-forget, settle, return how many rejections escaped
// to the node global handler. `mut` is a [from,to] pair (control variant) applied to the app code.
async function driveRealm(appCode, callName, mut) {
  nodeRejections = 0;
  const code = mut ? appCode.replace(mut[0], mut[1], 1) : appCode;
  if (mut) check(`[${callName}] control variant differs from landed code`, code !== appCode);
  const dom = new JSDOM(fs.readFileSync(path.join(WEB, "index.html"), "utf8"),
    { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
  const win = dom.window, doc = win.document;
  win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
  win.matchMedia = () => ({ matches: false, media: "", onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
  if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
  win.localStorage.setItem("strata.lang", "en");
  if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }

  // the failure mode: fetch REJECTS exactly like a transport blip
  win.fetch = async () => { const e = new TypeError("Failed to fetch"); e.name = "TypeError"; throw e; };

  // silence jsdom's own noisy boot side-effect (initSessionStream) without changing the logic under test
  const origErr = console.error; console.error = () => {};
  // expose entry points + override activeSession IN THE SAME REALM (cross-realm top-level
  // function reassignment is unreliable under runScripts:outside-only)
  const code2 = code + '\n;activeSession = () => ({ workspace: "C:/fixture-ws" });'
    + '\n;window.__api = { renderRecycle, renderRecycleBin, renderRecycleAudit };';
  win.eval(i18nSrc);
  win.eval(code2);
  console.error = origErr;
  await sleep(30);
  win.__api[callName]("C:/fixture-ws");   // fire-and-forget (no await, no .catch) — exactly how the app calls them
  await sleep(150);                        // let any escaped rejection settle onto the node global handler
  const boxTxt = (callName === 'renderRecycle') ? ((doc.getElementById('recycle-list') || {}).textContent || '') : '';
  win.close();
  return { escaped: nodeRejections, boxTxt };
}

// 2026-11: contention hardening. The node-layer capture is timing-sensitive (a realm's escaped
// rejection must land on the process-global handler before the settle window closes). Run the
// realm up to `tries` times; the FIRST time the predicate holds we pass. A persistent miss after
// all tries is a REAL failure (the guard is genuinely absent / genuinely not escaping).
async function driveRealmUntil(appCode, callName, mut, predicate, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await driveRealm(appCode, callName, mut);
    if (predicate(last)) return { ...last, attempts: i + 1 };
  }
  return { ...last, attempts: tries };
}

const main = async () => {
  console.log("=== FIX realm (guard present): function swallows it -> nothing escapes ===");
  const rc = await driveRealmUntil(APP_BASE, "renderRecycle", null, (r) => r.escaped === 0 && /scan failed/i.test(r.boxTxt));
  check("FIX renderRecycle -> 0 escape (recycle.err placeholder shown)", rc.escaped === 0 && /scan failed/i.test(rc.boxTxt),
    `escaped=${rc.escaped} box=${JSON.stringify(rc.boxTxt.slice(0, 40))}${rc.attempts > 1 ? ` attempts=${rc.attempts}` : ""}`);
  const bin = await driveRealmUntil(APP_BASE, "renderRecycleBin", null, (r) => r.escaped === 0);
  check("FIX renderRecycleBin -> 0 escape", bin.escaped === 0, `escaped=${bin.escaped}${bin.attempts > 1 ? ` attempts=${bin.attempts}` : ""}`);
  const aud = await driveRealmUntil(APP_BASE, "renderRecycleAudit", null, (r) => r.escaped === 0);
  check("FIX renderRecycleAudit -> 0 escape", aud.escaped === 0, `escaped=${aud.escaped}${aud.attempts > 1 ? ` attempts=${aud.attempts}` : ""}`);

  console.log("\n=== CONTROL diff (guard stripped): the SAME function MUST let it escape ===");
  const rcC = await driveRealmUntil(APP_BASE, "renderRecycle", [RC_FIX, RC_CTRL], (r) => r.escaped >= 1);
  check("CONTROL renderRecycle -> rejection ESCAPES", rcC.escaped >= 1, `escaped=${rcC.escaped}${rcC.attempts > 1 ? ` attempts=${rcC.attempts}` : ""}`);
  const binC = await driveRealmUntil(APP_BASE, "renderRecycleBin", [BIN_FIX, BIN_CTRL], (r) => r.escaped >= 1);
  check("CONTROL renderRecycleBin -> rejection ESCAPES", binC.escaped >= 1, `escaped=${binC.escaped}${binC.attempts > 1 ? ` attempts=${binC.attempts}` : ""}`);
  const audC = await driveRealmUntil(APP_BASE, "renderRecycleAudit", [AUD_FIX, AUD_CTRL], (r) => r.escaped >= 1);
  check("CONTROL renderRecycleAudit -> rejection ESCAPES", audC.escaped >= 1, `escaped=${audC.escaped}${audC.attempts > 1 ? ` attempts=${audC.attempts}` : ""}`);

  console.log();
  if (FAILURES.length) { console.log(`FAILED (${FAILURES.length}):`); for (const f of FAILURES) console.log("  - " + f); process.exit(1); }
  console.log("RECYCLE-FETCH-GUARD: ALL PASSED");
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
