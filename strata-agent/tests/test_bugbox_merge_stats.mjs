/* Differential gate for the Bug-inbox DEDUPE + STATS bar (approved 2026-10-28).
 *
 * What it locks (logic, no pixels — jsdom runs the real renderBugBox over real data):
 *   Merge display   N same-signature rows fold into ONE representative row + a "xN" badge.
 *   Stats bar       counts the four numbers over the FULL box by status.
 *   Merge button    _bugboxMergeDups physically folds same-signature rows in the localStorage
 *                   mirror only (the JSONL archive is untouched).
 *
 * Every assertion has a control group so a dead/stub render can go RED. en i18n so labels
 * are deterministic. Run: node tests/test_bugbox_merge_stats.mjs
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

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1/", runScripts: "outside-only" });
const win = dom.window;
const doc = win.document;

win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
win.localStorage.setItem("strata.lang", "en");   // deterministic en labels

win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const injected = appCode + `
;toast = (kind, title, text, ms, action) => { window.__lastToastAction = action; };   // capture the undo action (E block)
;send = async () => { window.__send.push(1); };
postQuiet = () => {};
window.__send = [];
window.__api = { renderBugBox, bugBoxSigKey, _bugboxMergeDups, _bugboxClearAll, t };
`;
win.eval(injected);
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));

const api = win.__api;
const BUGBOX_KEY = "bugBox";
const box = () => JSON.parse(win.localStorage.getItem("strata." + BUGBOX_KEY) || "[]");
const setBox = (arr) => win.localStorage.setItem("strata." + BUGBOX_KEY, JSON.stringify(arr));
const rows = () => doc.querySelectorAll("#bugbox-list .debug-item").length;
const xbadge = () => doc.getElementById("bugbox-list").innerHTML.includes("\u00d7");   // the xN dup badge

console.log("BUGBOX MERGE + STATS:");

// ── A. merge display: same signature folds to ONE row + xN badge ──────────────────
setBox([
  { ts: 1, kind: "bug:window.onerror", status: "open", sig: "SAME", msg: "SAME", stack: "" },
  { ts: 2, kind: "bug:window.onerror", status: "open", sig: "SAME", msg: "SAME", stack: "" },
  { ts: 3, kind: "bug:window.onerror", status: "open", sig: "SAME", msg: "SAME", stack: "" },
]);
api.renderBugBox();
check("A1. three same-signature rows render as ONE row", rows() === 1, "rows=" + rows());
check("A1. the merged row carries an xN badge", doc.getElementById("bugbox-list").innerHTML.includes("\u00d73"));
// control: three DISTINCT signatures must NOT collapse
setBox([
  { ts: 1, kind: "bug:x", status: "open", sig: "AA", msg: "AA", stack: "" },
  { ts: 2, kind: "bug:x", status: "open", sig: "BB", msg: "BB", stack: "" },
  { ts: 3, kind: "bug:x", status: "open", sig: "CC", msg: "CC", stack: "" },
]);
api.renderBugBox();
check("A2. control: three distinct signatures render as THREE rows", rows() === 3, "rows=" + rows());
check("A2. control: no xN badge when nothing merges", !xbadge());

// ── B. stats bar: four numbers over the full box, by status ───────────────────────
// legacy rows with no status field must count as open (the !status branch)
setBox([
  { ts: 10, kind: "bug:x", status: "open",     sig: "a", msg: "a", stack: "" },
  { ts: 11, kind: "bug:x", sig: "b", msg: "b", stack: "" },                    // legacy -> counts as open
  { ts: 12, kind: "bug:x", status: "fixing",   sig: "c", msg: "c", stack: "" },
  { ts: 13, kind: "bug:x", status: "verified", sig: "d", msg: "d", stack: "" },
]);
api.renderBugBox();
const h1 = doc.getElementById("bugbox-hero").innerHTML;
check("B1. total = 4",  /Total\s*<b[^>]*>4<\/b>/.test(h1), "no match");
check("B1. open = 2",   /Open\s*<b[^>]*>2<\/b>/.test(h1), "no match");
check("B1. fixing = 1", /Fixing\s*<b[^>]*>1<\/b>/.test(h1), "no match");
check("B1. verified = 1", /Verified\s*<b[^>]*>1<\/b>/.test(h1), "no match");
// control: a single open row -> 1/1/0/0 (proves the counters are status-driven, not hardcoded)
setBox([{ ts: 20, kind: "bug:x", status: "open", sig: "z", msg: "z", stack: "" }]);
api.renderBugBox();
const h2 = doc.getElementById("bugbox-hero").innerHTML;
check("B2. control: total = 1",  /Total\s*<b[^>]*>1<\/b>/.test(h2), "no match");
check("B2. control: open = 1",   /Open\s*<b[^>]*>1<\/b>/.test(h2), "no match");
check("B2. control: fixing = 0", /Fixing\s*<b[^>]*>0<\/b>/.test(h2), "no match");

// ── C. merge button: physically folds same-signature rows in the mirror ────────────
setBox([
  { ts: 30, kind: "bug:x", status: "open", sig: "DUP", msg: "DUP", stack: "", count: 1 },
  { ts: 31, kind: "bug:x", status: "open", sig: "DUP", msg: "DUP", stack: "", count: 1 },
  { ts: 32, kind: "bug:x", status: "open", sig: "DUP", msg: "DUP", stack: "", count: 1 },
]);
api._bugboxMergeDups();
const merged = box();
check("C1. three same-signature rows collapse to ONE stored row", merged.length === 1, "stored=" + merged.length);
check("C1. the kept row carries count = 3", merged[0] && merged[0].count === 3, JSON.stringify(merged[0] && merged[0].count));
// control: distinct signatures must NOT be folded (nothing to merge -> box unchanged, 3 rows)
setBox([
  { ts: 40, kind: "bug:x", status: "open", sig: "P", msg: "P", stack: "", count: 1 },
  { ts: 41, kind: "bug:x", status: "open", sig: "Q", msg: "Q", stack: "", count: 1 },
  { ts: 42, kind: "bug:x", status: "open", sig: "R", msg: "R", stack: "", count: 1 },
]);
api._bugboxMergeDups();
check("C2. control: distinct signatures stay THREE rows", box().length === 3, "stored=" + box().length);


// D. search/filter: text search + status filter narrow the displayed list
{
  setBox([
    { ts: 50, kind: "bug:x", status: "open",     sig: "A", msg: "alpha-unique", stack: "" },
    { ts: 51, kind: "bug:x", status: "fixing",   sig: "B", msg: "beta-unique",  stack: "" },
    { ts: 52, kind: "bug:x", status: "verified", sig: "C", msg: "gamma-unique", stack: "" },
  ]);
  const searchEl = doc.getElementById("bugbox-search");
  const filterEl = doc.getElementById("bugbox-filter");
  // D1: text search narrows to 1 row
  if (searchEl) searchEl.value = "beta";
  if (filterEl) filterEl.value = "";
  api.renderBugBox();
  check("D1. text search narrows to 1 row", rows() === 1, "rows=" + rows());
  // D2: status filter narrows to 1 fixing row
  if (searchEl) searchEl.value = "";
  if (filterEl) filterEl.value = "fixing";
  api.renderBugBox();
  check("D2. status filter narrows to 1 fixing row", rows() === 1, "rows=" + rows());
  // D3 control: no filter -> all 3 groups
  if (searchEl) searchEl.value = "";
  if (filterEl) filterEl.value = "";
  api.renderBugBox();
  check("D3. control: no filter shows all 3 groups", rows() === 3, "rows=" + rows());
}


// E. Clear all: bulk-empties the box, toast undo restores it (control proves the clear really clears)
{
  setBox([
    { ts: 60, kind: "bug:x", status: "open", sig: "S1", msg: "one", stack: "" },
    { ts: 61, kind: "bug:x", status: "fixing", sig: "S2", msg: "two", stack: "" },
    { ts: 62, kind: "bug:x", status: "verified", sig: "S3", msg: "three", stack: "" },
  ]);
  win.confirm = () => true;            // stub native confirm (jsdom native returns undefined)
  win.__lastToastAction = null;
  api._bugboxClearAll();
  check("E1. clear all empties the box (3 -> 0)", box().length === 0, "stored=" + box().length);
  if (win.__lastToastAction && win.__lastToastAction.run) win.__lastToastAction.run();   // user clicks Undo in the toast
  check("E1. undo restores all 3 entries", box().length === 3, "stored=" + box().length);
  // E2 control: declined confirm must NOT clear
  win.confirm = () => false;
  api._bugboxClearAll();
  check("E2. control: declined confirm keeps all 3 entries", box().length === 3, "stored=" + box().length);
}

console.log("");
if (FAILURES.length) {
  console.log("MERGE STATS: " + FAILURES.length + " FAILED");
  for (const f of FAILURES) console.log("  - " + f);
} else {
  console.log("MERGE STATS: ALL PASSED");
}
process.exit(FAILURES.length ? 1 : 0);
