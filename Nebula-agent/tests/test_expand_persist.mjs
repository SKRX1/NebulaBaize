/* Differential gate: expand/collapse persistence (2026-10-30).
 * Locks, for BOTH the debug bug-box and the memory page item-level lists:
 *   static  : the persisted Set wiring (load at init + save at every toggle point)
 *   runtime : eval'd expandSetLoad/expandSetSave round-trip + corrupt-JSON fallback
 *   behavior: restoreMemExpand differential -- storage says "open" -> body visible,
 *             storage empty -> body stays hidden (same DOM, only storage differs).
 * memExpandAll itself stays pure (test_mem_expand_all.mjs evals it verbatim);
 * its persistence lives in memExpandAllPersisted, locked statically here.
 * Run standalone: node tests/test_expand_persist.mjs
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

// ---------- static wiring locks ----------
const count = (needle) => src.split(needle).length - 1;
check("S1 bugbox: init loads persisted set", count("const bugBoxExpanded = expandSetLoad('strata.bugBoxExpanded')") === 1);
check("S2 bugbox: both toggles persist (per-row + batch)", count("expandSetSave('strata.bugBoxExpanded', bugBoxExpanded)") === 2);
check("S3 memory: init loads both persisted sets", count('const memExpanded = { kb: expandSetLoad("strata.memExpand.kb"), notes: expandSetLoad("strata.memExpand.notes") }') === 1);
check("S4 memory: per-row kb toggle persists", count('expandSetSave("strata.memExpand.kb", memExpanded.kb)') === 2);
check("S5 memory: per-row notes toggle persists", count('expandSetSave("strata.memExpand.notes", memExpanded.notes)') === 2);
check("S6 memory: helper saves via the dynamic key", count('expandSetSave("strata.memExpand." + (listId === "mem-kb-list" ? "kb" : "notes"), set)') === 1);
check("S7 memory: restore called from both render tails", count('restoreMemExpand("mem-kb-list", memExpanded.kb)') === 1 && count('restoreMemExpand("mem-notes-list", memExpanded.notes)') === 1);
check("S8 memory: batch buttons route through the persisted wrapper", count("=> memExpandAllPersisted(") === 4 && count("function memExpandAllPersisted(") === 1);
check("S9 memExpandAll body stays pure (no new symbols inside)", /^function memExpandAll\(listId, expand\) \{\r?\n(?:(?!expandSet|memExpanded)[^\r\n]*\r?\n)*?\}/m.test(src));

// ---------- runtime: round-trip + corrupt fallback, via eval'd real helpers ----------
// grab supports single-line fns too (the storage helpers are written on one line).
const grabFn = (name) => {
  const lines = src.split(/\r?\n/);
  const di = lines.findIndex((l) => l.trim().startsWith(`function ${name}(`));
  if (di < 0) return null;
  if (lines[di].trim().endsWith("}")) return lines[di].trim();   // single-line function
  let end = di;
  while (end < lines.length && !(lines[end].trim() === "}")) end++;
  return lines.slice(di, end + 1).join("\n");
};
const store = {};
const env = new Function("localStorage", grabFn("expandSetLoad") + "\n" + grabFn("expandSetSave") + "\nreturn { expandSetLoad, expandSetSave };");
const storeStub = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
const lib = env(storeStub);
{
  const s = new Set(["a", "b"]);
  lib.expandSetSave("K", s);
  const back = lib.expandSetLoad("K");
  check("R1 save/load round-trip keeps every key", back.has("a") && back.has("b") && back.size === 2);
  store["BAD"] = "{not json";
  const fb = lib.expandSetLoad("BAD");
  check("R2 corrupt JSON falls back to empty set", fb.size === 0);
  store["OBJ"] = '{"x":1}';
  check("R3 non-array JSON falls back to empty set", lib.expandSetLoad("OBJ").size === 0);
}

// ---------- behavior: restoreMemExpand differential on a real jsdom DOM ----------
const dom = new JSDOM(`<!doctype html><body><div class="kb-panel__list" id="mem-kb-list">
  <div class="mem-kb-item"><div class="kb-source"><button data-kb-view="srcA">view</button></div><pre class="mem-src-body" hidden data-loaded="1"></pre></div>
  <div class="mem-kb-item"><div class="kb-source"><button data-kb-view="srcB">view</button></div><pre class="mem-src-body" hidden></pre></div>
</div></body>`, { url: "http://127.0.0.1/" });
global.document = dom.window.document;
const $ = (id) => document.getElementById(id);
let clicks = 0;
document.querySelector('[data-kb-view="srcB"]').addEventListener("click", () => { clicks++; });

const memExpanded = { kb: new Set(), notes: new Set() };
const realm = new Function("$", "document", "localStorage", "memExpanded",
  grabFn("expandSetLoad") + "\n" + grabFn("expandSetSave") + "\n" + grabFn("restoreMemExpand") +
  "\nreturn { restoreMemExpand };");
const rtl = realm($, dom.window.document, storeStub, memExpanded);

const bodies = () => [...document.querySelectorAll(".mem-src-body")].map((p) => p.hidden);

// negative leg first: storage empty -> both bodies stay hidden
memExpanded.kb = new Set();
rtl.restoreMemExpand("mem-kb-list", memExpanded.kb);
check("D1 storage empty (negative): both bodies stay hidden", bodies().every((h) => h === true), JSON.stringify(bodies()));

// positive leg: storage says srcA open (loaded path -> visible) and srcB open (lazy path -> its view button fires)
memExpanded.kb = new Set(["srcA", "srcB"]);
rtl.restoreMemExpand("mem-kb-list", memExpanded.kb);
check("D2 storage says open: loaded body becomes visible", bodies()[0] === false, JSON.stringify(bodies()));
check("D3 storage says open: unloaded body routed through its lazy view button", clicks === 1);
check("D4 differential integrity: same DOM, only storage differed", bodies()[0] === false);

console.log("");
if (FAILURES.length) { console.log("FAILED (" + FAILURES.length + "): " + FAILURES.join(" | ")); process.exit(1); }
console.log("EXPAND-PERSIST: ALL GREEN");
process.exit(0);
