/* Differential gate for the composer/edit-area contenteditable migration (2026-10-29, plan A).
 *
 * The composer #input and the edit modal #edit-area were migrated from <textarea> to
 * contenteditable divs. The send/read path now goes through ceText()/ceSetText()/isCE().
 * The jsdom sandbox (this gate's runtime) does NOT implement innerText, isContentEditable,
 * document.NodeFilter.SHOW_TEXT, or queryCommandSupported -- so every helper must have a
 * textContent / getAttribute / window.NodeFilter fallback that still produces a CORRECT
 * result when a gate exercises it for real. The browser keeps its authoritative path.
 *
 * Differential design (positive = contenteditable, negative = a real textarea):
 *   P1  isCE(#input contenteditable div) -> true   (via getAttribute fallback in jsdom)
 *   P2  ceText after ceSetText round-trips exactly
 *   P3  insertPlaceholder lands a [img:N] tag (no selection in jsdom -> appendChild fallback)
 *   P4  removePlaceholder clears it again (TreeWalker via window.NodeFilter fallback)
 *   N1  isCE(a real <textarea>) -> false            (negative: the value branch stays intact)
 *   N2  a textarea keeps .value semantics (value read/write unaffected by the migration)
 *
 * Run: node tests/test_ce_text_extract.mjs
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
const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window;
const doc = win.document;
win.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8") + `
;window.__api = { ceText, ceSetText, isCE, insertPlaceholder, removePlaceholder, attachNextPid };`;
win.eval(appCode);
const api = win.__api;

for (const name of ["ceText", "ceSetText", "isCE", "insertPlaceholder", "removePlaceholder"]) {
  check(`helper boots as a real function: ${name}`, typeof api[name] === "function");
}

// ---- positive arm: the migrated contenteditable composer -------------------------------
const inp = doc.getElementById("input");
check("P0 composer is now a contenteditable div", inp && inp.tagName === "DIV" && inp.getAttribute("contenteditable") === "true");

check("P1 isCE(contenteditable composer) is true", api.isCE(inp) === true);

api.ceSetText(inp, "hello world");
check("P2 ceText round-trips what ceSetText wrote", api.ceText(inp) === "hello world", JSON.stringify(api.ceText(inp)));

check("P3 insertPlaceholder lands a [img:N] tag (no-selection appendChild fallback)", (() => {
  const pid = api.attachNextPid();
  api.insertPlaceholder(pid);
  return api.ceText(inp).includes(`[img:${pid}]`);
})());

check("P4 removePlaceholder clears it again (TreeWalker via window.NodeFilter)", (() => {
  // re-find the pid we just inserted (attachNextPid is monotonic, so re-derive from the text)
  const m = /\[img:(\d+)\]/.exec(api.ceText(inp));
  if (!m) return false;
  api.removePlaceholder(+m[1]);
  return !api.ceText(inp).includes(`[img:${m[1]}]`);
})());

// ---- negative arm: a real textarea keeps its .value semantics (migration did not touch it) --
const ta = doc.createElement("textarea");
ta.value = "typed via value";
doc.body.appendChild(ta);
check("N1 isCE(a real textarea) is false", api.isCE(ta) === false);
check("N2 a textarea still reads/writes through .value", ta.value === "typed via value");

console.log("\nCE-TEXT-EXTRACT: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
