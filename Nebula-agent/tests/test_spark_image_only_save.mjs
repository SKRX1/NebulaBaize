/* Differential gate: a spark note with ONLY images (no text) must now SAVE.
 *
 * Reported bug 2026-11-03: pasting 1 or 2 images into the spark add box and leaving the body
 * empty could not be saved. Root cause: save handler derives text via sparkHtmlToText(html),
 * which for a pure-image body returns "" -> addSpark's old guard `if (!text) return false`
 * rejected it outright. The fix hoists sanitizeHtml above the guard and widens the accept to
 * "text is non-empty OR the sanitized HTML still carries an img with a valid src".
 *
 * CRITICAL test-fidelity note: the add-box chip's delete button holds a sprite <svg><use> (no
 * readable text node), so sparkHtmlToText() over a pure-image body returns a TRULY empty string.
 * The positive arms therefore prove the note was saved by the NEW helper branch, not the old
 * non-empty-text path -- which is exactly what must be verified.
 *
 * Differential design (positive = saved; negative arms prove the XSS net + empty-note rejection
 * are NOT weakened by the relaxation):
 *   P1  single image-only note via the REAL add-box handler -> SAVE (the fix, text truly "")
 *   P2  two-image note (both srcs survive, no text) -> SAVE (matches the screenshot scenario)
 *   N1  dangerous image-only note: javascript: src stripped by sanitize so no valid img remains
 *       -> still REJECTED (XSS net intact; we did not just "save any non-empty html")
 *   N2  empty text AND empty html -> still REJECTED (an empty note never silently lands)
 *   N3  plain-text-only note with NO image saves through the original path -> no regression
 *   plus direct helper differential on valid-src vs stripped-HTML.
 *
 * Run: node tests/test_spark_image_only_save.mjs
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
win.matchMedia = () => ({ matches: false, media: "", addEventListener() {}, removeEventListener() {} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
const appCode = fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8") + `
;window.__api = { sanitizeHtml, addSpark, hasValidImageHtml };`;
win.eval(appCode);
const api = win.__api;

for (const name of ["sanitizeHtml", "addSpark", "hasValidImageHtml"]) {
  check(`helper boots as a real function: ${name}`, typeof api[name] === "function");
}

const reset = () => win.localStorage.removeItem("strata.spark");

// The REAL chip HTML pasteImageToRich builds. Note the delete button holds a sprite <svg><use>
// (NO text node) -> sparkHtmlToText() over this body returns a truly empty string, so any save
// is proven to go through the NEW helper branch rather than the old non-empty-text path.
const ICON = `<svg class="st-icon"><use href="#i-trash"></use></svg>`;
function chip(pid, src, name) {
  return `<span class="ce-thumb" contenteditable="false" data-pid="${pid}" title="${escA(name)}">` +
         `<span class="ce-thumb__box">` +
           `<img class="inline-ce-img" src="${src}" alt="" title="${escA(name)}">` +   // no alt text either -> body has zero text nodes
           `<button type="button" class="ce-thumb__x" data-delpid="${pid}" aria-label="Remove">${ICON}</button>` +
         `</span></span>`;
}
function escA(s){ return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;"); }

// Fidelity: sparkHtmlToText over a pure-image chip body must be TRULY empty (so the save is helper-driven).
function textNodesEmpty(root){
  let has = false;
  (function w(n){ for(const c of Array.from(n.childNodes)){ if(c.nodeType===3){ if(c.textContent.trim()){has=true;} continue;} w(c); } })(root);
  return !has;
}
check("fidelity: sanitized pure-image chip body has NO readable text node (save must be helper-driven)", (() => {
  const clean = api.sanitizeHtml(chip("1","data:image/png;base64,AAAAIMGHEAD","imgA"));
  const d2 = doc.createElement("div"); d2.innerHTML = clean;
  return textNodesEmpty(d2);
})());

// ---- P1: single image-only note via the REAL add-box handler -> saves ----------------------
reset();
{
  const ed = doc.getElementById("spark-add-input");
  ed.innerHTML = chip("1", "data:image/png;base64,AAAAIMGHEAD", "imgA");
  doc.getElementById("spark-add-btn").click();       // real handler bound by bindSparks -> addSpark
  const stored = JSON.parse(win.localStorage.getItem("strata.spark") || "[]");
  check("P1 image-only note is SAVED via the add-box handler", stored.length === 1, `stored=${stored.length}`);
  if (stored[0]) {
    check("P1 stored html keeps the surviving image src", /data:image\/png;base64,AAAAIMGHEAD/.test(stored[0].html || ""));
    check("P1 stored text is empty yet the note exists (helper branch did it)", (stored[0].text || "") === "", `text=${JSON.stringify(stored[0].text)}`);
  }
}

// ---- P2: two-image note, no text -> saves (the screenshot scenario) ------------------------
reset();
{
  const ed = doc.getElementById("spark-add-input");
  ed.innerHTML = chip("1", "data:image/png;base64,AAAHEAD", "a") + " " + chip("2", "data:image/png;base64,BBBHEAD", "b");
  doc.getElementById("spark-add-btn").click();
  const stored = JSON.parse(win.localStorage.getItem("strata.spark") || "[]");
  check("P2 two-image (no text) note is SAVED", stored.length === 1, `stored=${stored.length}`);
}

// ---- N1: dangerous image-only note -> still rejected (XSS net intact) ----------------------
reset();
check("N1 dangerous-only-image (javascript: src stripped -> no valid img) stays REJECTED",
  api.addSpark("", "", '<img src="javascript:alert(1)">') === false);

// ---- N2: empty text AND empty html -> still rejected ----------------------------------------
check("N2 empty note (no text, no image) stays REJECTED", api.addSpark("", "", "") === false);
reset();

// ---- N3: plain-text-only note with NO image saves through original path -> no regression --
reset();
{
  const saved = api.addSpark("just a thought, no image", "", "");
  check("N3 plain-text note (no image) still saves via original text path", saved === true);
}

// ---- direct helper differential: valid-src surviving HTML -> true; stripped -> false -------
check("helper: sanitized single-image HTML returns TRUE when src survives", (() => {
  const clean = api.sanitizeHtml('<img class="inline-ce-img" src="/data/uploads/x.png">');
  return /src="\/data\/uploads\/x\.png"/.test(clean) && api.hasValidImageHtml(clean) === true;
})());
check("helper: dangerous image HTML (javascript: stripped -> no valid img src) returns FALSE", (() => {
  const clean = api.sanitizeHtml('<img src="javascript:alert(1)">');
  return !/src=/i.test(clean) && api.hasValidImageHtml(clean) === false;
})());

console.log("\nSPARK-IMAGE-ONLY-SAVE: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
