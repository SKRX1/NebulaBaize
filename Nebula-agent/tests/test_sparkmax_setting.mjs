/* Permanent gate for the SPARKLINE DISPLAY-CAP setting (2026-11-13).
 *
 * What it locks (the new behaviour this round shipped -- SPARK_MAX_BARS is now a settings-page
 * slider, default 24, NOT just a hardcoded const any more):
 *   1. settings.sparkMaxBars DRIVES the display cap. This is the load-bearing single-variable
 *      differential: feed the SAME oversized arr (40 bars), change ONLY settings.sparkMaxBars,
 *      and the drawn-bar count MUST move with it (8 -> 8, 24 -> 24, 12 -> 12). A setting that is
 *      wired to the DOM but NOT read by ctxSpark would leave the count stuck at the old const
 *      SPARK_MAX_BARS=24 for every case -> RED. The 8 -> 8 row is the one that catches it.
 *   2. Cap ABOVE the data length shows ALL bars (proves the cap is a ceiling, not a fixed slice
 *      length -- 40 bars under cap 60 -> 40 drawn, not 24).
 *   3. The DEFAULT (no settings.sparkMaxBars key at all) falls back to SPARK_MAX_BARS = 24
 *      (the approved value from commit ed0adeb).
 *   4. Below-cap input shows all (no roll-off yet) -- guards the `arr.length > maxBars` boundary.
 *
 * Runs the REAL app.js via jsdom-boot (createRequire + eval) against the REAL index.html, NOT a
 * hand stub -- so a regression in the real ctxSpark / buildCtxArr flips this gate RED.
 *
 * Run: node tests/test_sparkmax_setting.mjs
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

// Boot the REAL page so app.js runs against a real DOM (boot needs these globals).
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window;
win.matchMedia = () => ({ matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function")
  win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (!win.document.getElementById("toasts")) { const d = win.document.createElement("div"); d.id = "toasts"; win.document.body.appendChild(d); }
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

// Expose the REAL functions + the live `settings` object out of app.js's strict scope by appending
// an assignment to the SAME eval (module-scope const/function stay reachable inside that realm).
let appCode = fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += "\n;window.__api = { buildCtxArr, ctxSpark };\n";
appCode += "window.__setSettings = (o) => { for (const k in o) settings[k] = o[k]; };\n";
appCode += "window.__getSettings = () => settings;\n";
win.eval(appCode);
const api = win.__api;

// Parse the geometry back out of produced SVG markup (one <rect> per drawn bar).
function rects(s) { return [...String(s).matchAll(/<rect /g)].length; }

// An oversized assistant history: every message carries stats so buildCtxArr emits ONE bar each.
function history(n) {
  return Array.from({ length: n }, (_, i) => ({
    role: "assistant", text: "t" + i,
    stats: { ctxMax: 1000, ctxUsed: (i * 37) % 1000 },
  }));
}

// ---- 1. LOAD-BEARING differential: settings.sparkMaxBars moves the drawn-bar count ----
console.log("\n=== 1. settings.sparkMaxBars drives the display cap (load-bearing) ===");
const big = history(40);   // buildCtxArr -> 40 bars; only the last `cap` survive the window
const bigArr = api.buildCtxArr(big);
check("buildCtxArr(40 msgs) -> 40 bars before capping", bigArr.length === 40, "got " + bigArr.length);
for (const [cap, expect] of [[8, 8], [24, 24], [12, 12]]) {
  win.__setSettings({ sparkMaxBars: cap });
  const n = rects(api.ctxSpark(bigArr, -1));
  check(`sparkMaxBars=${cap} -> ${expect} bars drawn`, n === expect, "got " + n);
}
// reverse control: if ctxSpark IGNORED settings and used the dead const, the cap=8 row would be 24.
win.__setSettings({ sparkMaxBars: 8 });
check("CONTROL a settings-ignoring ctxSpark would give 24 (why cap=8 -> 8 is load-bearing)",
      rects(api.ctxSpark(bigArr, -1)) === 8, "got " + rects(api.ctxSpark(bigArr, -1)));

// ---- 2. cap ABOVE data length -> show ALL (proves cap is a ceiling, not a fixed slice) ----
console.log("\n=== 2. cap above the data length shows all bars (ceiling, not fixed slice) ===");
win.__setSettings({ sparkMaxBars: 60 });
check("sparkMaxBars=60, 40 bars -> all 40 drawn (no cap hit)", rects(api.ctxSpark(bigArr, -1)) === 40,
      "got " + rects(api.ctxSpark(bigArr, -1)));

// ---- 3. DEFAULT fallback: no settings.sparkMaxBars key -> SPARK_MAX_BARS = 24 ----
console.log("\n=== 3. default (no key) falls back to 24 ===");
delete win.__getSettings().sparkMaxBars;
check("no sparkMaxBars key -> default 24 bars", rects(api.ctxSpark(bigArr, -1)) === 24,
      "got " + rects(api.ctxSpark(bigArr, -1)));

// ---- 4. below-cap input shows all (the arr.length > maxBars boundary, no roll-off) ----
console.log("\n=== 4. below-cap input shows all (boundary guard) ===");
win.__setSettings({ sparkMaxBars: 8 });
const smallArr = api.buildCtxArr(history(6));
check("sparkMaxBars=8, 6 bars -> all 6 (below cap, no roll-off)", rects(api.ctxSpark(smallArr, -1)) === 6,
      "got " + rects(api.ctxSpark(smallArr, -1)));

console.log();
if (FAILURES.length) {
  console.log(`FAILED (${FAILURES.length}):`);
  for (const f of FAILURES) console.log("  - " + f);
  process.exit(1);
}
console.log("SPARKMAX SETTING: ALL PASSED");
process.exit(0);
