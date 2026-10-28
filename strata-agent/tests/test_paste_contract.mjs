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

const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
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

console.log("\nREGRESSION: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
