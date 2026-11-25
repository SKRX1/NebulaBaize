/* Differential contract test for memExpandAll (A+C landing, 2026-10-26).
 * Grabs the REAL function from app.js source, evals it in this realm with a jsdom DOM,
 * and asserts:
 *   probe A (expand): items whose body was lazy-loaded (data-loaded) become visible;
 *   probe B (fold):   all bodies end hidden.
 * The delta between A and B is caused by the expand flag alone (same DOM).
 * Run standalone: node tests/test_mem_expand_all.mjs
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
const check = (label, cond, extra="") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const src = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const lines = src.split(/\r?\n/);

// grab the full function block from its def line to its closing brace
const di = lines.findIndex((l) => l.trim().startsWith("function memExpandAll("));
check("memExpandAll definition found in source", di >= 0);
if (di < 0) { console.log("no def -> abort"); process.exit(1); }
let end = di;
while (end < lines.length && !(lines[end].trim() === "}")) end++;
const fnSrc = lines.slice(di, end + 1).join("\n");

const dom = new JSDOM(`<!doctype html><body>
  <div class="kb-panel__list" id="mem-kb-list">
    <div class="mem-kb-item"><div class="kb-source"><button data-kb-view="x">view</button></div><pre class="mem-src-body" hidden data-loaded="1"></pre></div>
    <div class="mem-kb-item"><div class="kb-source"><button data-kb-view="y">view</button></div><pre class="mem-src-body" hidden></pre></div>
  </div></body>`, { url: "http://127.0.0.1/" });
global.document = dom.window.document;

// $ helper as in app.js
const $ = (id) => document.getElementById(id);
globalThis.$ = $;

const fn = (0, eval)("(" + fnSrc + ")");
check("boots as a real function: memExpandAll", typeof fn === "function");

function bodiesHidden() {
  return [...document.querySelectorAll(".mem-kb-item .mem-src-body")].map((p) => p.hidden);
}

// --- probe A: expand ---
// reset
document.querySelectorAll(".mem-src-body").forEach((p)=>{ p.hidden=true; });
document.querySelector('.mem-kb-item .mem-src-body[data-loaded]').setAttribute("data-loaded","1");
fn("mem-kb-list", true);
const afterExpand = bodiesHidden();
// item 0 (loaded) must be visible (false). item 1 (not loaded, has data-kb-view button) ->
// lazy path triggers click; jsdom has no async loader wired so it stays hidden in the probe,
// but the CODE PATH for a loaded body must flip to visible -> that is the assertion.
check("probe A (expand): lazy-loaded body becomes visible", afterExpand[0] === false, JSON.stringify(afterExpand));

// --- probe B: fold ---
document.querySelectorAll(".mem-src-body").forEach((p)=>{ p.hidden=false; });
fn("mem-kb-list", false);
const afterFold = bodiesHidden();
check("probe B (fold): every body ends hidden", afterFold.every((h)=>h===true), JSON.stringify(afterFold));

// differential integrity: same DOM, only the flag differs -> A reveals loaded, B hides all
check("differential: expand vs fold differ on the same input", afterExpand[0]===false && afterFold.every(h=>h===true));

console.log("");
if (FAILURES.length) { console.log("FAILED ("+FAILURES.length+"): "+FAILURES.join(" | ")); process.exit(1); }
console.log("MEM-EXPAND-ALL: ALL GREEN");
process.exit(0);
