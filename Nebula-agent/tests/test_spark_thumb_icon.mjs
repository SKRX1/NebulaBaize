/* POST-FIX BEHAVIOR gate for "spark note DELETE BUTTON icon disappears after SAVE (blank shell)" — REAL
 * icon() + REAL sanitizeHtml via the gate-standard jsdom-boot (createRequire + eval app.js), NOT a hand-stub.
 * FIXED 2026-11-02: the USE-href whitelist was broadened from "only a bare # fragment" to ALSO accept the
 * in-page sprite file path web/sprite.svg#... because icon() emits EXACTLY that href; without it the
 * delete-button <use> was emptied on SAVE -> blank icon -> dead-shell delete button (the reported symptom).
 *
 * Differential pairs (real net, real functions):
 *   FIX       : the REAL icon("trash") href #i-trash now SURVIVES sanitize (delete button renders).
 *   CONTROL   : a bare #i-trash href still survives (the original whitelist behaviour is intact).
 *   XSS NET   : an off-site href (http://evil/x.svg#i-trash) is STILL stripped (the broadening did NOT open a hole).
 * Run standalone: node tests/test_spark_thumb_icon.mjs
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
const check = (label, cond) => { console.log("  " + (cond ? "OK   " : "FAIL ") + label + (cond ? "" : "  <-- BROKEN")); if (!cond) FAILURES.push(label); };

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1/", runScripts: "outside-only" });
const win = dom.window;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += "\n;window.__sanitize = sanitizeHtml; window.__icon = icon;";
win.eval(appCode);
check("sanitizeHtml boots", typeof win.__sanitize === "function");
check("icon boots", typeof win.__icon === "function");

function hrefAfterSanitize(htmlStr) {
  const d = win.document.createElement("div");
  d.innerHTML = win.__sanitize(htmlStr);
  const use = d.querySelector("use");
  return use ? (use.getAttribute("href") || use.getAttribute("xlink:href") || "") : "(no use)";
}

// FIX: the REAL chip the delete button renders — icon("trash") emits <use href="#i-trash">
const realChip = `text <span class="ce-thumb" contenteditable="false" data-pid="1"><span class="ce-thumb__box"><img class="inline-ce-img" src="data:image/png;base64,AAA"><button type="button" class="ce-thumb__x" data-delpid="1" aria-label="x">${win.__icon("trash")}</button></span></span>`;
const realHref = hrefAfterSanitize(realChip);
console.log("  REAL trash-icon href after SAVE:", JSON.stringify(realHref));
check("FIX: the real in-page trash href #i-trash now SURVIVES sanitize (delete button renders, no longer a dead shell)", realHref === "#i-trash");

// CONTROL: a bare # fragment href still survives (original whitelist behaviour intact)
const bareChip = `text <span class="ce-thumb"><span class="ce-thumb__box"><button class="ce-thumb__x"><svg><use href="#i-trash"/></svg></button></span></span>`;
const bareHref = hrefAfterSanitize(bareChip);
console.log("  BARE #href after sanitize:", JSON.stringify(bareHref));
check("CONTROL: a bare # fragment href still survives (original whitelist behaviour intact)", bareHref === "#i-trash");

// XSS NET: an off-site href is STILL stripped -- the broadening did NOT open a security hole
const evilChip = `text <span class="ce-thumb"><span class="ce-thumb__box"><button class="ce-thumb__x"><svg><use href="http://evil.example.com/x.svg#i-trash"/></svg></button></span></span>`;
const evilHref = hrefAfterSanitize(evilChip);
console.log("  XSS off-site href after sanitize:", JSON.stringify(evilHref));
check("XSS NET: an off-site href is STILL stripped (broadening the in-page sprite prefix did NOT open a hole)", evilHref === "");

console.log("\nTHUMB-ICON-POSTFIX: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
