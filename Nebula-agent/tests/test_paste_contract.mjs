/* Contract test: the paste / mixed-text-image helpers MUST really exist and really run.
 *
 * Why this exists
 * ---------------
 * The paste-image feature "looked done" — node --check was green, the suite was green —
 * yet pasting did nothing. Root cause: addFiles() CALLED attachNextPid()/insertPlaceholder()
 * but those functions were never DEFINED. A call to an undefined function is valid syntax,
 * so --check passes; no test exercised the paste path, so the suite passed; only running the
 * FileReader callback in a real browser threw ReferenceError. "Syntax green" hid a runtime crash.
 *
 * This suite locks the whole class of "call site exists but the definition is missing" bugs:
 *   1) the source must contain BOTH the definition AND a call site for each helper (the lock);
 *   2) the helper must boot as a real function in jsdom and produce a correct result on a
 *      minimal input — proving it is not just declared but actually runs.
 *
 * Run standalone: node tests/test_paste_contract.mjs
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
const check = (label, cond) => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label);
  if (!cond) FAILURES.push(label);
};

const src = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

// --- static lock: every helper must be DEFINED, not just called -------------------------
// The bug was exactly "only a call site, no definition". So we require the definition here.
for (const name of ["attachNextPid", "insertPlaceholder", "removePlaceholder", "mixedSegments"]) {
  check(`app.js DEFINES function ${name}`, new RegExp(`function\\s+${name}\\s*\\(`).test(src));
  check(`app.js CALLS ${name}(`, new RegExp(`[^\\w]${name}\\(`).test(src));
}
// the inline-image CSS that msgEl now emits must have a rule (or images render at full width)
const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
check("app.css styles .inline-msg-img", /\.inline-msg-img\s*\{/.test(css));

// --- runtime lock: boot the page and exercise each helper on a minimal input -----------
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1/", runScripts: "outside-only" });
const win = dom.window;
const doc = win.document;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += `
;window.__api = { attachNextPid, insertPlaceholder, removePlaceholder, mixedSegments,
  getInput:()=>ceText(document.getElementById("input")) };`;
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(appCode);
const api = win.__api;

for (const name of ["attachNextPid", "insertPlaceholder", "removePlaceholder", "mixedSegments"]) {
  check(`boots as a real function: ${name}`, typeof api[name] === "function");
}

// minimal behaviours — prove each one runs and produces the right shape
check("attachNextPid returns an increasing number", (() => {
  const a = api.attachNextPid(), b = api.attachNextPid();
  return Number.isFinite(a) && Number.isFinite(b) && b === a + 1;
})());

check("mixedSegments splits text/image interleaved", (() => {
  const seg = api.mixedSegments({ text: "before [img:1] after", images: [{ pid: 1, url: "data:image/png;base64,AAA", name: "x" }] });
  return Array.isArray(seg) && seg.length === 3 && seg[1].type === "image" && seg[0].text.trim() === "before";
})());

check("mixedSegments returns null with no placeholder (old layout preserved)",
  api.mixedSegments({ text: "plain text", images: [{ pid: 1, url: "data:image/png;base64,AAA", name: "x" }] }) === null);

check("insertPlaceholder writes a [img:N] tag into the composer", (() => {
  const inp = doc.getElementById("input");
  inp.textContent = "";
  api.insertPlaceholder(42);
  return inp.textContent.includes("[img:42]");
})());

check("removePlaceholder clears that tag again", (() => {
  api.removePlaceholder(42);
  return !doc.getElementById("input").textContent.includes("[img:42]");
})());

// --- A1 race-condition lock: DOM node + array entry must land BEFORE the upload await --------
// The bug: pasteImageToRich() pushed to the array and inserted the inline-DOM node only AFTER
// `await fetch(api/images/upload)` returned. A send/re-generate that fired the instant you pasted
// (before the slow upload came back) saw an empty array + no [img:N] anchor and dropped the image
// from the bubble. A1 lands them synchronously; the upload is now a background ref upgrade. This
// static lock pins that ordering so it can never regress back behind the await.
const _lines = src.split(/\r?\n/);
const _start = _lines.findIndex((l) => l.includes("async function pasteImageToRich"));
let _end = _start + 1;
while (_end < _lines.length && !/^(async\s+)?function\s/.test(_lines[_end])) _end++;
const _body = _lines.slice(_start, _end);
const _lineIdx = (needle) => { const j = _body.findIndex((l) => l.includes(needle)); return j < 0 ? Infinity : j; };
const _upload = _lineIdx("api/images/upload");
const _dom = Math.min(_lineIdx("execCommand"), _lineIdx("appendChild"));
const _push = _lineIdx("push(entry)");
check("A1: paste DOM node lands BEFORE the upload await", _dom < _upload);
check("A1: paste array entry lands BEFORE the upload await", _push < _upload);
check("A1: upload is the LAST step (background best-effort, never gates the paste)", _upload > Math.max(_dom, _push) && _upload < Infinity);

// --- delete-button ALWAYS-VISIBLE lock (was hover-only by design 9bd6a3b; user feedback 2026-10-31 -> made permanent) ---
// jsdom cannot compute CSS layout, so this is a STATIC source lock on the relaxed state: the .ce-thumb__x rule MUST default to a visible display (grid), NOT display:none. If a future edit snaps it back to hover-only, this reds. The :hover row staying as grid is fine (it is a no-op enhancer now).
const _thumbM = css.match(/\.ce-thumb__x \{[^\r\n]*\r?\n[^\r\n]*\}/); const _thumbRule = _thumbM ? _thumbM[0] : "";
check("delete-button rule found", !!_thumbRule);
check("delete button defaults to ALWAYS-VISIBLE (display grid, not hover-only)", !!_thumbRule && /display:\s*grid/.test(_thumbRule) && !/display:\s*none/.test(_thumbRule));

console.log("\nREGRESSION: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
