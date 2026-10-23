/* Differential contract test: B1 two-state preview for the recommended-only
 * sub-checkbox (2026-10-23).
 *
 * Boots the REAL index.html + i18n.js + app.js in jsdom (same harness as
 * test_switch_busy.mjs) and pins the behaviours the preview must guarantee:
 *
 *   T1  checked (ON, recommended-only)   -> container data-state === "on",
 *       and the FIRST phrase is the highlighted one.
 *   T2  unchecked (OFF, recommended+normal) -> data-state === "off",
 *       and the SECOND phrase is the highlighted one.
 *   T3  the control channel is the checkbox's own onchange (not a global
 *       applySettings-only paint), so a real user click repaints the row.
 *   T4  the startup load-hook paints it too (settings load path).
 *   T5  source anchors: both new i18n keys exist in BOTH dictionaries, and
 *       the CSS lights the active tier with a semantic colour.
 *
 * The two phrases are filled by applyI18n via data-i18n (textContent); the
 * highlight is pure CSS driven by data-state — so this test asserts the state
 * flip, which is exactly the mechanism under test.
 *
 * Run: node tests/test_rec_preview.mjs
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

win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
win.localStorage.setItem("strata.lang", "en");
win.confirm = () => true;
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
win.i18n = { t: (k) => k, syncSwitchers() {}, applyI18n() {}, setLang() {} };

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8") + `
;window.__api = { syncRecPreview };`;
win.eval(appCode);
const api = win.__api;

const box = () => doc.querySelector(".st-check__preview");
const chk = () => doc.getElementById("s-autosteps-rec");

console.log("=== setup: preview row exists and the checkbox is wired ===");
check("preview container exists", !!box());
check("checkbox exists", !!chk());
check("preview has exactly 2 data-i18n phrases",
  box() && box().querySelectorAll("[data-i18n]").length === 2);
check("checkbox is the recommended-only one", chk() && chk().checked === true);

console.log("=== T1: ON (recommended only) -> state=on ===");
api.syncRecPreview(true);
chk().checked = true;
check("data-state is on", box().dataset.state === "on", box().dataset.state);

console.log("=== T2: OFF (recommended + normal) -> state=off ===");
api.syncRecPreview(false);
chk().checked = false;
check("data-state is off", box().dataset.state === "off", box().dataset.state);

console.log("=== T3: a real checkbox click repaints through the checkbox's own onchange ===");
chk().checked = true;
chk().dispatchEvent(new win.Event("change"));
check("state back to on after checking", box().dataset.state === "on", box().dataset.state);
chk().checked = false;
chk().dispatchEvent(new win.Event("change"));
check("state back to off after unchecking", box().dataset.state === "off", box().dataset.state);
check("the checkbox has its own onchange hook", typeof chk().onchange === "function");

console.log("=== T4/T5: source anchors ===");
check("load path also paints the preview (settings load)",
  /syncRecPreview\(!\!s\.autostepsRec\)/.test(appCode));
check("checkbox onchange calls syncRecPreview",
  /\$\("s-autosteps-rec"\)\.onchange = \(\) => syncRecPreview/.test(appCode));
check("helper is top-level (not nested in a function body)",
  /^function syncRecPreview\(checked\) \{/m.test(appCode));

const i18src = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
const zhBlock = i18src.split("\n").slice(0, 780).join("\n");
const enBlock = i18src.split("\n").slice(780).join("\n");
check("on-key exists in BOTH dictionaries",
  zhBlock.includes("drawer.autosteps.rec.preview.on") && enBlock.includes("drawer.autosteps.rec.preview.on"));
check("off-key exists in BOTH dictionaries",
  zhBlock.includes("drawer.autosteps.rec.preview.off") && enBlock.includes("drawer.autosteps.rec.preview.off"));

const cssSrc = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
check("CSS lights the active tier with the semantic colour",
  /\.st-check__preview\[data-state="on"\][^{]*\{[^}]*--st-info-text/.test(cssSrc));
check("CSS dims the inactive tier with secondary ink",
  /\.st-check__preview > span \{ color: var\(--st-ink-muted\)/.test(cssSrc));

console.log("");
if (FAILURES.length) { console.log("REC-PREVIEW: " + FAILURES.length + " FAILURE(S)"); for (const f of FAILURES) console.log("  - " + f); process.exit(1); }
console.log("REC-PREVIEW: ALL PASSED"); process.exit(0);
