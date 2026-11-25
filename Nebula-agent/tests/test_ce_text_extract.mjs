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
;window.__api = { ceText, ceSetText, isCE, insertPlaceholder, removePlaceholder, attachNextPid, sparkHtmlToText };`;
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

// ---- differential arm: text that landed INSIDE an atomic data-pid chip must survive
//      ceText(). This is the reported bug: after a paste the real-browser caret can drop
//      inside the atomic chip, so ceTextFromDom must descend into the chip and collect its
//      text nodes, while SKIPPING the hover BUTTON so its icon label never pollutes.
//      We build the real post-paste DOM directly (a data-pid span), not via
//      insertPlaceholder (which in jsdom has no selection and only appends a text anchor).
check("P6 text node INSIDE a data-pid chip is preserved (the reported bug; fails on pre-fix code)", (() => {
  api.ceSetText(inp, "");
  const span = doc.createElement("span");
  span.className = "ce-thumb";
  span.setAttribute("data-pid", "77");
  span.appendChild(doc.createTextNode("user typed inside"));   // caret dropped inside the atomic chip
  inp.appendChild(span);
  const txt = api.ceText(inp);
  return txt.includes("[img:77]") && txt.includes("user typed inside");
})());

check("P7 leading text + chip + trailing text all survive interleaved", (() => {
  api.ceSetText(inp, "lead ");
  const span = doc.createElement("span");
  span.className = "ce-thumb";
  span.setAttribute("data-pid", "78");
  inp.appendChild(span);
  inp.appendChild(doc.createTextNode(" trail"));
  const txt = api.ceText(inp);
  return txt.includes("lead") && txt.includes("[img:78]") && txt.includes("trail");
})());

check("N3 BUTTON label inside a data-pid chip does NOT pollute ceText (negative control)", (() => {
  api.ceSetText(inp, "");
  const span = doc.createElement("span");
  span.className = "ce-thumb";
  span.setAttribute("data-pid", "79");
  const btn = doc.createElement("button");
  btn.appendChild(doc.createTextNode("BUTTON_LABEL_XYZ"));
  span.appendChild(btn);
  inp.appendChild(span);
  const txt = api.ceText(inp);
  return !txt.includes("BUTTON_LABEL_XYZ") && txt.includes("[img:79]");
})());

// ---- differential arm: a URL copied from a web page lands as an <a href="URL">TITLE</a> node
//      in the contenteditable composer, and the URL lives ONLY in the href ATTRIBUTE. A plain-text
//      read (innerText/textContent) silently drops attributes, so the sent message and the bubble
//      carried just the title and the model never saw the link (reported bug 2026-11). The fix
//      degrades the anchor to LOSSLESS plain text "TITLE (URL)" -- plain on purpose: user bubbles
//      with no image anchor render through b.textContent, so markdown link syntax would show up as
//      literal brackets instead of a link.
check("P8 pasted <a href> keeps its URL in ceText output (the reported bug; RED on pre-fix code)", (() => {
  api.ceSetText(inp, "");
  const a = doc.createElement("a");
  a.setAttribute("href", "https://github.com/Niko1221/Strata/releases/tag/v0.2.17");
  a.appendChild(doc.createTextNode("Release Strata 0.2.17 \u00b7 Niko1221/Strata"));
  inp.appendChild(a);
  const txt = api.ceText(inp);
  return txt.includes("https://github.com/Niko1221/Strata/releases/tag/v0.2.17")
      && txt.includes("Release Strata 0.2.17");
})());

check("P9 link text + surrounding text survive interleaved, URL preserved", (() => {
  api.ceSetText(inp, "read this: ");
  const a = doc.createElement("a");
  a.setAttribute("href", "https://example.org/release");
  a.appendChild(doc.createTextNode("the release notes"));
  inp.appendChild(a);
  inp.appendChild(doc.createTextNode(" and summarize"));
  const txt = api.ceText(inp);
  return txt.includes("read this:") && txt.includes("https://example.org/release") && txt.includes("summarize");
})());

check("N4 bare-URL anchor is NOT duplicated (negative control: href == visible text)", (() => {
  api.ceSetText(inp, "");
  const a = doc.createElement("a");
  a.setAttribute("href", "https://example.com/a");
  a.appendChild(doc.createTextNode("https://example.com/a"));
  inp.appendChild(a);
  const txt = api.ceText(inp);
  return (txt.match(/https:\/\/example\.com\/a/g) || []).length === 1;
})());

check("N5 in-page #fragment anchor gets NO URL appended (negative control)", (() => {
  api.ceSetText(inp, "");
  const a = doc.createElement("a");
  a.setAttribute("href", "#section-2");
  a.appendChild(doc.createTextNode("jump to section 2"));
  inp.appendChild(a);
  const txt = api.ceText(inp);
  return txt === "jump to section 2";
})());


// ---- differential arm (2026-11, round 2): spark's plain-text extractor sparkHtmlToText has the
//      SAME root cause as the old ceText bug: it reads d.textContent, so a pasted <a href="URL">
//      TITLE</a> loses the URL when a TEXT-ONLY spark is pushed into chat (sparkToPush no-image
//      branch, app.js:6412). Fix: the same "TITLE (URL)" lossless degradation. P10 is RED on the
//      pre-fix code; N6/N7 are the same negative controls as N4/N5.
check("P10 sparkHtmlToText keeps the URL of a pasted <a href> (spark push bug; RED pre-fix)", (() => {
  const html = '<div>please read: <a href="https://github.com/Niko1221/Strata/releases/tag/v0.2.17">Release Strata 0.2.17 \u00b7 Niko1221/Strata</a> thanks</div>';
  const out = api.sparkHtmlToText(html);
  return out.includes("https://github.com/Niko1221/Strata/releases/tag/v0.2.17")
      && out.includes("Release Strata 0.2.17");
})());

check("N6 sparkHtmlToText does NOT duplicate a bare-URL anchor (negative: href == text)", (() => {
  const out = api.sparkHtmlToText('<div><a href="https://example.com/a">https://example.com/a</a></div>');
  return (out.match(/https:\/\/example\.com\/a/g) || []).length === 1;
})());

check("N7 sparkHtmlToText appends NO URL for #fragment anchors (negative control)", (() => {
  const out = api.sparkHtmlToText('<div><a href="#section-2">jump to section 2</a></div>');
  return out === "jump to section 2";
})());


console.log("\nCE-TEXT-EXTRACT: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
