/* Differential gate (flipped 2026-11-07 to the contract feature 970469b introduced:
   "shell-engine hide"). The sidebar task-panel "Engine waterline" sub-row shows the engine
   side's real shared-pool occupancy ONLY for a REAL llama.cpp engine (self-reported cap ~=
   the declared window). For a SHELL engine (a custom-API endpoint whose self-reported cap is
   a placeholder that disagrees with the declared window by >2%), the row is HIDDEN, because
   its engine-side read-out is semantically unclean (fake denominator + a level that reads
   0 while idle). This is a deliberate behaviour change from the 2026-11-02 gate, which only
   had available/available:false/null; the old A assertion (available + maxTokens>0 -> visible)
   was written with maxTokens=32768 vs a 131K declared window, which under the new contract is
   exactly the SHELL case, so it now correctly hides. This flip is an expected, intentional
   contract migration (feature 970469b), not a regression.

Contract (real app.js + real i18n.js + real index.html, jsdom) in renderInspector():
  A. REAL engine (available, maxTokens ~= maxCtx) + busy + used>0  -> visible, "Engine pool <pct>%" + used/max.
  B. SHELL engine (available, maxTokens far from maxCtx)           -> hidden=true  (the new shell-hide).
  C. control: engineMonitor null                                    -> hidden=true.
  D. control: available:false                                       -> hidden=true.
  R. reversible: real engine busy with a new pct                    -> visible, shows the recomputed pct.
  Static locks: index.html has id="ins-engine"; i18n defines insp.engine + insp.engine.tip (zh+en).

Run: node tests/test_engine_waterline.mjs
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..", "serve", "web");
const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const i18n = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
const app = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

// static locks
check("static: index.html has #ins-engine", html.includes('id="ins-engine"'));
check("static: i18n defines insp.engine (zh+en)",
  (i18n.match(/"insp\.engine"\s*:/g) || []).length === 2, "count=" + (i18n.match(/"insp\.engine"\s*:/g) || []).length);
check("static: i18n defines insp.engine.tip (zh+en)",
  (i18n.match(/"insp\.engine\.tip"\s*:/g) || []).length === 2);
check("static: app.js polls api/monitor", app.includes('fetch("api/monitor"'));
// shell-hide contract anchor: the shell detection line must exist (guards against silent revert)
check("static: app.js computes shell-engine hide",
  app.includes("Math.abs(mx - decl) / decl") || app.includes("Math.abs(mx-decl)/decl"));

const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window, doc = win.document;
win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){}, dispatchEvent(){ return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
win.localStorage.setItem("strata.lang", "en");
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
win.eval(i18n);
win.eval(app + `
;window.__api = {
  renderInspector,
  setEngine: (v) => { engineMonitor = v; },
  setMaxCtx: (v) => { maxCtx = v; },
  setUsed: (v) => { lastPromptTokens = v; },
  setTab: (v) => { tab = v; },
  setBusy: (v) => { busy = v; },
};`);
const api = win.__api;
const el = () => doc.getElementById("ins-engine");
api.setMaxCtx(131072); api.setUsed(20000); api.setTab("chat");
api.setBusy({ controller: null, msg: {} });   // a turn is in flight -> not idle, so the pct branch renders

// A. REAL engine: self-reported cap ~= declared window -> visible, shows "Engine pool" + recomputed pct + used/max
//    used=24000 / max=131072 -> epct = round(100*24000/131072) = 18
api.setEngine({ available: true, context: { usedTokens: 24000, maxTokens: 131072, pct: 73 } });
api.renderInspector();
let a = el();
check("A REAL engine visible when available (cap ~= declared)", a && a.hidden === false, "hidden=" + (a && a.hidden));
check("A shows Engine pool + recomputed pct", (a.textContent || "").includes("Engine pool") && (a.textContent || "").includes("18%"),
  "txt=" + (a && a.textContent));

// B. SHELL engine: self-reported cap (placeholder 32768) disagrees with declared 131072 by >2% -> HIDDEN (new shell-hide contract)
api.setEngine({ available: true, context: { usedTokens: 24000, maxTokens: 32768, pct: 73 } });
api.renderInspector();
let b = el();
check("B SHELL engine hidden (cap far from declared - new hide)", b && b.hidden === true, "hidden=" + (b && b.hidden));

// C. control: engineMonitor null -> hidden
api.setEngine(null);
api.renderInspector();
let c = el();
check("C hidden when engine null (control)", c && c.hidden === true, "hidden=" + (c && c.hidden));

// D. control: available:false -> hidden
api.setEngine({ available: false });
api.renderInspector();
let d = el();
check("D hidden when available:false (control)", d && d.hidden === true, "hidden=" + (d && d.hidden));

// R. reversible: a REAL engine with a new occupancy -> visible again with the recomputed pct (not a one-shot)
//    used=19660 / max=131072 -> epct = round(100*19660/131072) = 15
api.setEngine({ available: true, context: { usedTokens: 19660, maxTokens: 131072, pct: 15 } });
api.renderInspector();
let r = el();
check("R reversible: real engine visible again with new pct", r && r.hidden === false && (r.textContent || "").includes("15%"),
  "txt=" + (r && r.textContent));

console.log(FAILURES.length ? ("\nENGINE WATERLINE: " + FAILURES.length + " FAILED") : "\nENGINE WATERLINE: ALL PASSED");
process.exit(FAILURES.length ? 1 : 0);
