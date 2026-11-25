/* Regression gate for the app_utils.js pure-leaf extraction.
 *
 * timeStr / fmtBytesSel / parsePlanItems were moved out of app.js into a
 * classic-script module loaded BEFORE app.js (index.html). This gate proves the
 * extraction is (a) behavioural — each helper is a real function that produces
 * correct output for minimal inputs — and (b) structurally load-bearing:
 *   - app_utils.js defines them;
 *   - app.js NO LONGER defines them (they were truly removed, not duplicated);
 *   - index.html loads app_utils.js before app.js (so call sites resolve);
 *   - app.js still CALLS them (the call sites were left intact);
 *   - booting i18n.js + app_utils.js + app.js together in load order leaves the
 *     three helpers callable (no ReferenceError at boot, simulating the browser).
 * A decoy (delete a helper from app_utils.js) must flip that helper's runtime
 * check red, proving the assertions are load-bearing.
 *
 * NOTE: jsdom's runScripts:"outside-only" keeps window.eval in its own lexical
 * scope, so a top-level `function` does NOT land on window the way a real
 * <script src> (classic script) would. EXPOSE re-publishes the helpers onto
 * window in the same eval scope to faithfully model classic-script globalisation;
 * `typeof name` never throws on an undeclared identifier, so the decoy still works.
 *
 * Run: node tests/test_app_utils_jsdom.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(path.resolve(HERE, ".."), "serve", "web");

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const HELPERS = ["timeStr", "fmtBytesSel", "parsePlanItems"];
// publish the three function declarations onto window (model classic-script globals)
const EXPOSE = `
;window.timeStr = typeof timeStr === "function" ? timeStr : undefined;
;window.fmtBytesSel = typeof fmtBytesSel === "function" ? fmtBytesSel : undefined;
;window.parsePlanItems = typeof parsePlanItems === "function" ? parsePlanItems : undefined;
`;

const utilSrc = fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8");
const appSrc = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const i18nSrc = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
const htmlSrc = fs.readFileSync(path.join(WEB, "index.html"), "utf8");

function bootUtil(src) {
  const dom = new JSDOM("<!doctype html><body>", { runScripts: "outside-only" });
  const win = dom.window;
  win.eval(src + EXPOSE);
  return win;
}

console.log("\n=== runtime: each moved helper is callable + correct ===");
const win = bootUtil(utilSrc);

check("timeStr is a real function", typeof win.timeStr === "function");
check("fmtBytesSel is a real function", typeof win.fmtBytesSel === "function");
check("parsePlanItems is a real function", typeof win.parsePlanItems === "function");

const ts = win.timeStr(new Date(2000, 0, 1, 9, 5, 0).getTime());
check("timeStr returns HH:MM two-digit shape  " + JSON.stringify(ts),
      /^\d{2}[:.]\d{2}$/.test(String(ts)), "");

check("fmtBytesSel(2048) === '2.0 KB'  " + JSON.stringify(win.fmtBytesSel(2048)),
      win.fmtBytesSel(2048) === "2.0 KB");
check("fmtBytesSel(3145728) === '3.0 MB'  " + JSON.stringify(win.fmtBytesSel(3145728)),
      win.fmtBytesSel(3145728) === "3.0 MB");
check("fmtBytesSel boundary 1048575 is KB not MB  " + JSON.stringify(win.fmtBytesSel(1048575)),
      /KB$/.test(win.fmtBytesSel(1048575)));

const items = win.parsePlanItems("- [x] alpha\n* [ ] beta\nnot a task\n\n- [ ] gamma");
const expect = JSON.stringify([
  { done: true, label: "alpha" },
  { done: false, label: "beta" },
  { done: false, label: "not a task" },
  { done: false, label: "gamma" },
]);
check("parsePlanItems parses checkboxes & drops non-tasks  " + JSON.stringify(items),
      JSON.stringify(items) === expect);
check("parsePlanItems('') -> []  " + JSON.stringify(win.parsePlanItems("")),
      Array.isArray(win.parsePlanItems("")) && win.parsePlanItems("").length === 0);
check("parsePlanItems(null) -> [] (no throw)",
      Array.isArray(win.parsePlanItems(null)) && win.parsePlanItems(null).length === 0);

console.log("\n=== structure: moved (not duplicated), wired, call sites intact ===");
for (const fn of HELPERS) {
  check("app_utils.js defines " + fn, new RegExp("^function\\s+" + fn + "\\s*\\(", "m").test(utilSrc));
  check("app.js NO LONGER defines " + fn, !new RegExp("^function\\s+" + fn + "\\b", "m").test(appSrc));
  check("app.js still CALLS " + fn, new RegExp("\\b" + fn + "\\b").test(appSrc));
}
const oI = htmlSrc.indexOf("web/i18n.js");
const oU = htmlSrc.indexOf("web/app_utils.js");
const oA = htmlSrc.indexOf("web/app.js");
check("index.html loads app_utils.js exactly once", (htmlSrc.match(/web\/app_utils\.js/g) || []).length === 1);
check("load order i18n < app_utils < app.js  " + JSON.stringify([oI, oU, oA]),
      oI >= 0 && oI < oU && oU < oA);

console.log("\n=== boot chain: i18n.js + app_utils.js + app.js, helpers callable after boot ===");
{
  const dom = new JSDOM(fs.readFileSync(path.join(WEB, "index.html"), "utf8"),
                        { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  if (typeof w.requestAnimationFrame !== "function") w.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
  w.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  w.confirm = () => true;
  let booted = true;
  try {
    w.eval(i18nSrc);
    w.eval(utilSrc + EXPOSE);   // app_utils BEFORE app.js, mirroring index.html
    w.eval(appSrc);
  } catch (e) {
    booted = false;
    console.log("   boot threw: " + e.message);
  }
  check("app.js boots with app_utils loaded (no ReferenceError on the moved helpers)", booted);
  check("after full boot fmtBytesSel still callable + correct  " + JSON.stringify(w.fmtBytesSel && w.fmtBytesSel(2048)),
        typeof w.timeStr === "function" && w.fmtBytesSel(2048) === "2.0 KB");
}

console.log("\n=== decoy diff: removing a helper from app_utils flips it red ===");
{
  const broken = utilSrc.replace(/function\s+fmtBytesSel\s*\([\s\S]*?\n\}/, "");
  const w2 = bootUtil(broken);
  check("decoy: with fmtBytesSel removed, runtime check WOULD fail", typeof w2.fmtBytesSel !== "function");
}

console.log("");
if (FAILURES.length) {
  console.log(`APP_UTILS GATE: ${FAILURES.length} FAILED`);
  FAILURES.forEach((f) => console.log("  - " + f));
} else {
  console.log("APP_UTILS GATE: ALL PASSED");
}
process.exit(FAILURES.length ? 1 : 0);
