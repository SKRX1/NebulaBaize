/* Differential contract for the "compression target" slider (2026-10).

Boots the REAL app.js in jsdom and verifies the slider actually moves the post-compact tail
budget -- the whole point of the feature. computeTailBudgetChars() was extracted from the inline
rebuild formula so this can assert it.

  D1  the slider MOVES the budget: target 50% > default 25% > 5% (strictly increasing). Without
      this the slider would be decorative.
  D2  an empty/zero stored value falls back to the default 25 (old saves keep prior behaviour).

Asserts use pure-ASCII words / numbers only (Chinese is display-only, per the test rule).
Run: node tests/test_compact_target.mjs
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
win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
win.localStorage.setItem("strata.lang", "en");
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(appCode + `
;window.__api = {
  computeTailBudgetChars,
  setMaxCtx: (v) => { maxCtx = v; },
  setTarget: (v) => { settings.compactTarget = v; },
};`);
const api = win.__api;

console.log("COMPRESSION TARGET SLIDER (differential):");

api.setMaxCtx(262144);

// D1: the slider must actually move the budget. Default field value is 25 (from DEFAULTS);
// pin explicit values and assert strict monotonicity.
api.setTarget(50);
const b50 = api.computeTailBudgetChars();
api.setTarget(25);
const b25 = api.computeTailBudgetChars();
api.setTarget(5);
const b5 = api.computeTailBudgetChars();
check("target 50% > default 25% > 5% (the slider moves it)", b50 > b25 && b25 > b5,
      `b5=${b5} b25=${b25} b50=${b50}`);
check("default 25% matches the historical formula (maxCtx*3*0.25)", b25 === Math.floor(262144 * 3 * 0.25),
      String(b25));

// D2: an old save without the field falls back to 25 (compat path).
api.setTarget(0);
check("empty/zero target falls back to default 25", api.computeTailBudgetChars() === b25,
      String(api.computeTailBudgetChars()));

console.log("\nCOMPACT-TARGET: " + (FAILURES.length ? "FAILURES: " + FAILURES.join(", ") : "ALL PASSED"));
process.exit(FAILURES.length ? 1 : 0);
