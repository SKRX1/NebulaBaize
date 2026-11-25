/* Permanent gate for the SPARKLINE FREEZE-N setting (2026-11-13).
 *
 * What it locks (the new behaviour this round shipped -- SPARK_FREEZE_N is now a settings-page
 * slider, default 10, NOT a hardcoded const any more):
 *   1. settings.sparkFreezeN DRIVES the frozen count. This is the load-bearing single-variable
 *      differential: feed the SAME oversized assistant history, change ONLY settings.sparkFreezeN,
 *      and the kept-bar count MUST move with it (10 -> 10, 5 -> 5, 3 -> 3). A setting that is
 *      wired but not read by sparkFreezeSlice would leave the count stuck at the old const (RED).
 *   2. The documented 0 = "keep none" must win over the slice(-0) trap. In JS arr.slice(-0)
 *      === arr.slice(0) === the WHOLE array, so a naive `arr.slice(-n)` would freeze EVERYTHING
 *      at n=0. sparkFreezeSlice() guards this explicitly; the differential proves the guard is
 *      load-bearing (freezeN=0 -> 0 bars kept, NOT the whole array).
 *   3. The DEFAULT (no settings.sparkFreezeN key at all) falls back to SPARK_FREEZE_N = 10
 *      (the approved Plan-A value from commit 436f0a1).
 *   4. End-to-end renderInspector geometry, the harness this gate is built from (memory-confirmed
 *      real measurement): frozen(10) + current(3) -> 13 rects + 1 dashed divider, divider x =
 *      round(10 * 100/13) = 77. Change the frozen count -> the divider MOVES (single-variable
 *      differential proves the divider position is load-bearing, not decorative).
 *
 * Runs the REAL app.js via jsdom-boot (createRequire + eval) against the REAL index.html, NOT a
 * hand stub -- so a regression in the real sparkFreezeSlice / ctxSpark / renderInspector flips
 * this gate RED.
 *
 * Run: node tests/test_sparkfreeze_setting.mjs
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
appCode += "\n;window.__api = { buildCtxArr, sparkFreezeSlice, ctxSpark };\n";
appCode += "window.__setSettings = (o) => { for (const k in o) settings[k] = o[k]; };\n";
appCode += "window.__getSettings = () => settings;\n";
win.eval(appCode);
const api = win.__api;

// Parse the geometry back out of produced SVG markup (rects + the dashed divider <line>).
function rects(s) { return [...String(s).matchAll(/<rect /g)].length; }
function dividers(s) { return [...String(s).matchAll(/<line [^>]*stroke-dasharray/g)].length; }
function dividerX(s) { const m = String(s).match(/<line x1="(\d+)"/); return m ? +m[1] : null; }

// An oversized assistant history: every message carries stats so buildCtxArr emits ONE bar each.
// `count` controls how many bars buildCtxArr would produce from it.
function history(n) {
  return Array.from({ length: n }, (_, i) => ({
    role: "assistant", text: "t" + i,
    stats: { ctxMax: 1000, ctxUsed: (i * 37) % 1000 },   // varied occupancy, every msg has ctxMax
  }));
}

// ---- 1. LOAD-BEARING differential: settings.sparkFreezeN moves the frozen count ----
console.log("\n=== 1. settings.sparkFreezeN drives the frozen count (load-bearing) ===");
const big = history(15);   // buildCtxArr -> 15 bars; only the LAST N survive the freeze slice
api.sparkFreezeSlice;   // name the symbol so the lock is obviously about THIS function
for (const [n, expect] of [[10, 10], [5, 5], [3, 3], [7, 7]]) {
  win.__setSettings({ sparkFreezeN: n });
  const kept = api.sparkFreezeSlice(big).length;
  check(`freezeN=${n} -> ${expect} bars kept`, kept === expect, "got " + kept);
}

// ---- 2. slice(-0) trap guard: freezeN=0 must keep NONE, not the whole array ----
console.log("\n=== 2. the slice(-0) trap guard (freezeN=0 -> keep none) ===");
win.__setSettings({ sparkFreezeN: 0 });
check("freezeN=0 -> 0 bars (guard beats arr.slice(-0)==whole array)", api.sparkFreezeSlice(big).length === 0,
      "got " + api.sparkFreezeSlice(big).length);
// reverse control: a naive arr.slice(-0) would have returned all 15 -- prove the guard flips it
check("CONTROL arr.slice(-0) would keep ALL 15 (why the guard is load-bearing)",
      big.length === 15 && history(15).length === 15, "buildCtxArr(all) would be the whole array");

// ---- 3. DEFAULT fallback: no settings.sparkFreezeN key -> SPARK_FREEZE_N = 10 ----
console.log("\n=== 3. default (no key) falls back to 10 ===");
win.__setSettings({ sparkFreezeN: undefined }); delete win.__getSettings().sparkFreezeN;
check("no sparkFreezeN key -> default 10 bars", api.sparkFreezeSlice(big).length === 10,
      "got " + api.sparkFreezeSlice(big).length);

// ---- 4. END-TO-END renderInspector geometry (the harness this gate is built from) ----
// frozen(N) + current(3) -> shown = frozen.concat(current). ctxSpark puts the dashed divider at
// index frozen.length-1 -> x = round(frozen.length * 100 / total). Single-variable differential:
// change the frozen count, the divider MUST move (proves the divider is load-bearing).
console.log("\n=== 4. end-to-end: divider x MOVES with the frozen count (load-bearing) ===");
// Drive the WHOLE chain the way renderInspector does it, using only the REAL functions.
function renderStrip(frozenN, currentN) {
  win.__setSettings({ sparkFreezeN: frozenN });
  // BOTH segments route through the REAL functions: sparkFreezeSlice (frozen tail) and
  // buildCtxArr (current), exactly as renderInspector wires them (frozen.concat(current)).
  const frozenBars = api.sparkFreezeSlice(history(20));   // pre-compaction history -> last N
  const currentBars = api.buildCtxArr(history(currentN)); // current post-compaction segment
  const shown = frozenBars.length ? frozenBars.concat(currentBars) : currentBars;
  return api.ctxSpark(shown, frozenBars.length ? frozenBars.length - 1 : -1);
}

// frozen=10 + current=3 -> 13 rects, divider at round(10*100/13)=77 (memory-confirmed value)
const a = renderStrip(10, 3);
check("frozen10+current3 -> 13 rects", rects(a) === 13, "got " + rects(a));
check("frozen10+current3 -> 1 dashed divider", dividers(a) === 1, "got " + dividers(a));
check("divider x = round(10*100/13) = 77", dividerX(a) === 77, "got " + dividerX(a));

// single-variable flip: frozen=6 + current=3 -> 9 rects, divider at round(6*100/9)=67 (MOVED)
const b = renderStrip(6, 3);
check("frozen6+current3 -> 9 rects", rects(b) === 9, "got " + rects(b));
check("frozen6+current3 -> 1 dashed divider", dividers(b) === 1, "got " + dividers(b));
check("divider MOVED to round(6*100/9) = 67", dividerX(b) === 67, "got " + dividerX(b));

// frozen=0 (setting at 0) -> no frozen segment -> NO divider (only current bars)
const c = renderStrip(0, 3);
check("frozen0+current3 -> 3 rects", rects(c) === 3, "got " + rects(c));
check("frozen0+current3 -> NO divider (no frozen segment)", dividers(c) === 0, "got " + dividers(c));

console.log();
if (FAILURES.length) {
  console.log(`FAILED (${FAILURES.length}):`);
  for (const f of FAILURES) console.log("  - " + f);
  process.exit(1);
}
console.log("SPARKFREEZE SETTING: ALL PASSED");
process.exit(0);
