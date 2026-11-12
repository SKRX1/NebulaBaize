/* Permanent gate for the context-trend BAR CHART (app.js ctxSpark).
 *
 * What it locks (the design guardrails the chart must keep):
 *   1. Each turn renders as its OWN <rect> (a bar), NOT a connecting polyline —
 *      per-turn occupancy is a discrete event, so a line implies phantom
 *      interpolation between samples. This is the single-variable differential:
 *      a multi-point input MUST produce multiple bars (a polyline that fakes
 *      continuity would collapse to one path element = RED).
 *   2. Every geometry coordinate is round-aligned to the integer pixel grid
 *      (design charter sec 2: without rounding a ~40px sparkline blurs).
 *   3. Bar width auto-shrinks with point count and leaves a gap so narrow bars
 *      never merge into a single blob (many-turn case shows a smaller width than
 *      the few-turn case).
 *   4. The CURRENT (last) bar carries a highlight stroke; the others do not.
 *   5. Colour tiers are the existing tokens only (no neon): >=90 danger,
 *      >=75 warn, else accent (design charter sec 5/7).
 *
 * This runs the REAL app.js via jsdom-boot (createRequire + eval), NOT a hand
 * stub — so a regression in the real ctxSpark (e.g. reverting to a polyline, or
 * dropping the pixel-grid rounding) flips this gate RED, not just the replica.
 *
 * Run: node tests/test_ctxspark_bars.mjs
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

// Boot the REAL page so app.js runs against a real DOM (boot needs these globals).
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window;
win.matchMedia = () => ({ matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function")
  win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (!doc0hasToasts()) { const d = win.document.createElement("div"); d.id = "toasts"; win.document.body.appendChild(d); }
function doc0hasToasts() { return !!win.document.getElementById("toasts"); }
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

// Expose ctxSpark out of app.js's strict scope by appending an assignment to the SAME eval.
let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += "\n;window.__api = { ctxSpark };";
win.eval(appCode);
const ctxSpark = win.__api.ctxSpark;

// Parse the geometry back out of the produced SVG markup.
function parse(htmlStr) {
  const rects = [...htmlStr.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="([^"]+)"( stroke="([^"]+)" stroke-width="([\d.]+)")?\/>/g)];
  return rects.map((m) => ({ x: m[1], y: m[2], w: +m[3], h: +m[4], fill: m[5], stroke: m[8] }));
}
const tier = (f) => f.replace("var(--st-", "").replace(")", "");

// ---- 1. one bar per turn (differential: many points -> many separate bars) ----
console.log("\n=== 1. one bar per turn, not a connecting polyline ===");
const multi = ctxSpark([12, 18, 30, 28, 55, 60]);
check("multi-point input yields >= 6 separate <rect> bars", parse(multi).length >= 6, "n=" + parse(multi).length);
check("output contains NO <polyline> (line encoding removed)", !/polyline/.test(multi), multi.slice(0, 40));

// ---- 2. geometry guard: every coordinate round-aligned (pixel-grid, sec 2) ----
console.log("\n=== 2. all coordinates are integers (pixel-grid alignment) ===");
const frac = (s) => String(s).includes(".");
const g = ctxSpark([13, 27, 41, 52, 66, 78, 83, 91, 35, 49]);
check("every x/y/width/height is an integer", parse(g).every((r) => !frac(r.x) && !frac(r.y) && Number.isInteger(r.w) && Number.isInteger(r.h)));

// ---- 3. bar width auto-shrinks with point count and leaves a gap ----
console.log("\n=== 3. bar width adapts to point count (gap preserved) ===");
const few = parse(ctxSpark([30, 80]));
const many = parse(ctxSpark(Array.from({ length: 30 }, (_, i) => Math.min(100, i * 4))));
check("many-turn bars are thinner than few-turn bars", many[0].w < few[0].w, `few=${few[0].w} many=${many[0].w}`);
check("all bars >= 1px wide (never vanish / never merge to 0)", many.every((r) => r.w >= 1));

// ---- 4. the current (last) bar carries a highlight stroke, the rest do not ----
console.log("\n=== 4. current (last) bar highlighted, others plain ===");
const hl = ctxSpark([20, 40, 60, 80, 50]);
const pr = parse(hl);
check("last bar has a stroke", pr[pr.length - 1].stroke !== undefined);
check("non-last bars have NO stroke", pr.slice(0, -1).every((r) => r.stroke === undefined));

// ---- 5. colour tiers are the existing tokens only, thresholds exact (sec 5/7) ----
console.log("\n=== 5. colour tiers exact (>=90 danger, >=75 warn, else accent) ===");
const bt = ctxSpark([74, 75, 89, 90]);   // boundary probes
const tiers = parse(bt).map((r) => tier(r.fill));
check("74 -> accent (below warn line)", tiers[0] === "accent", tiers[0]);
check("75 -> warn (at warn line)", tiers[1] === "warn", tiers[1]);
check("89 -> warn (below danger line)", tiers[2] === "warn", tiers[2]);
check("90 -> danger (at danger line)", tiers[3] === "danger", tiers[3]);
check("no colour token outside the 3 semantic tiers", parse(hl).every((r) => ["accent", "warn", "danger"].includes(tier(r.fill))));

// ---- 6. empty input stays empty (no crash, no ghost element) ----
console.log("\n=== 6. empty input -> empty string (no ghost bar) ===");
check("ctxSpark([]) === empty", ctxSpark([]) === "");

console.log();
if (FAILURES.length) {
  console.log(`FAILED (${FAILURES.length}):`);
  for (const f of FAILURES) console.log("  - " + f);
  process.exit(1);
}
console.log("CTXSPARK BARS: ALL PASSED");
process.exit(0);
