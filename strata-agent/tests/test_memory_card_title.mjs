/* Contract gate: memory-card rows rendered through .kb-source__name must carry a title
 * so the single-line-ellipsis CSS (app.css `.kb-source__name { text-overflow: ellipsis }`)
 * does not silently truncate the visible text — hovering must reveal the FULL entry.
 *
 * Why this exists
 * ---------------
 * The panel showed truncated entries. Root cause: app.css single-line ellipsis on
 * .kb-source__name. Fix (approved plan A): add title="full text" to each memory-card row.
 * This gate locks BOTH layers so the fix cannot regress (it already got wiped once in an
 * uncommitted window and had to be re-landed):
 *   1) static lock — the four memory-card render sites must emit a title attribute, and
 *      esc() must escape double quotes (the exact char that would break title="...");
 *   2) runtime differential — feed a full text that CONTAINS double quotes (the dangerous
 *      char) through the REAL esc() and parse it back through jsdom:
 *        - probe A (escaped): title parses back to the FULL text  -> hover shows everything;
 *        - probe B (raw, no esc): title gets truncated by the quote -> proves esc is the
 *          necessary condition for "the full text fits inside title=...".
 *      The only difference between A and B is esc — so the delta is attributable to esc alone.
 *
 * Run standalone: node tests/test_memory_card_title.mjs
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

const src = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");

// --- static lock: the four render sites + esc + the root-cause CSS rule -----------------
// substring checks (not regex) so the single/double quotes inside cannot be mangled.
const STATIC = [
  ['rules-draft   (single-quote template)', 'title="\' + esc(e2) + \'">\' + esc(e2)'],
  ["weekly        (template literal)",        'title="${esc(e.text)}">${esc(e.text)'],
  ["auto-pending  (template literal)",        'title="${esc(e2)}">${esc(e2)'],
  ["audit         (template literal)",        'title="${esc(a.text)}">${esc(a.text)'],
];
for (const [label, needle] of STATIC) {
  check(`app.js render site has title: ${label}`, src.includes(needle));
}
// esc() must escape the double quote — the char that would otherwise break title="...".
check("app.js esc() escapes double quotes", /const esc = [\s\S]{0,200}"/.test(src) && /&quot;/.test(src));
// the root cause we are guarding against must still be the single-line ellipsis rule.
check("app.css .kb-source__name allows wrapping (plan-A widened ellipsis)", /\.kb-source__name\s*\{[^}]*white-space:\s*normal/.test(css));

// --- runtime differential through the REAL esc() -----------------------------------------
// grab the real esc definition line from source and evaluate it in this realm.
const escLine = src.split(/\r?\n/).find((l) => l.trim().startsWith("const esc = "));
check("esc definition line found in source", !!escLine);
const esc = (0, eval)("(function(){ " + escLine + " ; return esc; })()");
check("boots as a real function: esc", typeof esc === "function");

const dom = new JSDOM("<!doctype html><body></body>", { url: "http://127.0.0.1/" });
const doc = dom.window.document;

// the dangerous char (a double quote) sits inside — this is exactly what would truncate title.
const FULL = 'Remember: the word "PARROT" and the phrase don\'t-quote-me must BOTH survive in the tooltip';

// helper: build <span class="kb-source__name" title="X">Y</span>, parse it back, read title.
function titleOf(escapedInner, displayInner) {
  const box = doc.createElement("div");
  box.innerHTML = '<span class="kb-source__name" title="' + escapedInner + '">' + displayInner + "</span>";
  return box.firstChild.getAttribute("title");
}

// probe A — production path: esc() the text for BOTH title and display (what the 4 sites do).
const escFull = esc(FULL);
const probeA = titleOf(escFull, escFull);
check("probe A: title parses back to the FULL text (hover reveals everything)", probeA === FULL, JSON.stringify(probeA));

// probe B — differential control: raw text straight into title="..." with NO esc.
// the embedded double quote closes the attribute early -> title is truncated -> NOT the full text.
const probeB = titleOf(FULL, esc(FULL));
check("probe B: without esc the raw double quote truncates the title", probeB !== FULL, JSON.stringify(probeB));
check("probe B: truncated value is strictly shorter than the full text", (probeB || "").length < FULL.length, "len=" + (probeB || "").length + " vs " + FULL.length);

// differential integrity: A == full, B != full — the delta is caused by esc alone (same input).
check("differential: esc is the necessary condition (A passes, B fails, same input)",
  probeA === FULL && probeB !== FULL);

console.log("");
if (FAILURES.length) {
  console.log("FAILED (" + FAILURES.length + "): " + FAILURES.join(" | "));
  process.exit(1);
}
console.log("MEMORY-CARD-TITLE: ALL GREEN");
process.exit(0);
