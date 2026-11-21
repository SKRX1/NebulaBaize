/* ROOT-CAUSE pin for "spark thumbnail shows only the circle, image broken" — REAL sanitizeHtml
 * via the gate-standard jsdom-boot (createRequire + eval app.js), NOT a hand-stub.
 * Feeds three src shapes through the REAL sanitizer and reads back which survive:
 *   DATA URL  (data:image/png;base64,...)  -> whitelist data:image/ -> MUST survive (paste path keeps this)
 *   ABSOLUTE  (/data/uploads/x.png)        -> whitelist -> survives
 *   RELATIVE  (uploads/x.png, NO leading slash, OLD format) -> NOT in whitelist -> STRIPPED = broken image (circle only)
 * Conclusion: the ONLY src the sanitizer strips is the OLD relative "uploads/x.png" (no leading slash).
 *   So a note whose stored src is that old relative form -> sanitizer strips it -> broken img -> only the circle shows.
 *   A note that still has a live data URL -> src survives -> it should NOT be broken (proving the broken ones carry the old stripped src).
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
appCode += "\n;window.__sanitize = sanitizeHtml;";
win.eval(appCode);
check("sanitizeHtml boots", typeof win.__sanitize === "function");

function srcOf(htmlStr) {
  const d = win.document.createElement("div");
  d.innerHTML = win.__sanitize(htmlStr);
  const img = d.querySelector("img");
  return img ? (img.getAttribute("src") || "") : "(no img)";
}
const DT = "data:image/png;base64,AAA";
const ABS = "/data/uploads/x.png";
const REL = "uploads/x.png";   // OLD format, NO leading slash

const sData = srcOf(`text <img src="${DT}"><button class="ce-thumb__x"></button>`);
const sAbs  = srcOf(`text <img src="${ABS}"><button class="ce-thumb__x"></button>`);
const sRel  = srcOf(`text <img src="${REL}"><button class="ce-thumb__x"></button>`);
console.log("  DATA src out:", JSON.stringify(sData));
console.log("  ABS  src out:", JSON.stringify(sAbs));
console.log("  REL  src out:", JSON.stringify(sRel));

check("DATA URL src SURVIVES sanitize (paste path is safe, so a still-broken note is NOT a data-URL note)", sData === DT);
check("ABSOLUTE /data/uploads/ src SURVIVES", sAbs === ABS);
check("RELATIVE old uploads/ src is STRIPPED (this is the broken-image root: old format -> sanitizer strips -> only circle shows)", sRel === "");

console.log("\nSANITIZE-SRC ROOTCAUSE: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
