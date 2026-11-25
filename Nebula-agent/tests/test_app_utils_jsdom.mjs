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

const HELPERS = ["timeStr", "fmtBytesSel", "parsePlanItems", "extractNextSteps", "extractProposalsFromText", "detectLang", "classifyTool"];
// publish the three function declarations onto window (model classic-script globals)
const EXPOSE = `
;window.timeStr = typeof timeStr === "function" ? timeStr : undefined;
;window.fmtBytesSel = typeof fmtBytesSel === "function" ? fmtBytesSel : undefined;
;window.parsePlanItems = typeof parsePlanItems === "function" ? parsePlanItems : undefined;
;window.extractNextSteps = typeof extractNextSteps === "function" ? extractNextSteps : undefined;
;window.extractProposalsFromText = typeof extractProposalsFromText === "function" ? extractProposalsFromText : undefined;
;window.detectLang = typeof detectLang === "function" ? detectLang : undefined;
;window.classifyTool = typeof classifyTool === "function" ? classifyTool : undefined;
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

// detectLang: ascii -> en, cjk-dominant -> zh, empty -> en
check("detectLang('hello world') === 'en'  " + JSON.stringify(win.detectLang("hello world")),
      win.detectLang("hello world") === "en");
check("detectLang(纯中文) === 'zh'  " + JSON.stringify(win.detectLang("这是一段中文文本")),
      win.detectLang("这是一段中文文本") === "zh");
check("detectLang('') === 'en' (empty defaults en)", win.detectLang("") === "en");

// classifyTool: tool-result classifier (file vs test), now lives in app_utils.js.
// It calls firstPath from the same module -> bootUtil(utilSrc) eval already binds it.
{
  const fileTool = { server: "filesystem", tool: "filesystem__write", arguments: { path: "a/b/c.txt" }, ok: true };
  const fc = win.classifyTool(fileTool);
  check("classifyTool(file write) -> kind file + path  " + JSON.stringify(fc),
        !!fc && fc.kind === "file" && fc.path === "a/b/c.txt" && fc.ok === true);
  const shell = { server: "shell", tool: "shell__exec", arguments: "python tests/test_login.py", result: "9 passed in 1.2s", ok: true };
  const sc = win.classifyTool(shell);
  check("classifyTool(green pytest) -> kind test + ok true  " + JSON.stringify(sc),
        !!sc && sc.kind === "test" && sc.ok === true && sc.passed === 9 && sc.failed === 0);
  const redshell = { server: "shell", tool: "shell__exec", arguments: "pytest tests/test_login.py", result: "8 passed, 2 failed", ok: true };
  const rc = win.classifyTool(redshell);
  check("classifyTool(red pytest) -> kind test + ok false + failed 2  " + JSON.stringify(rc),
        !!rc && rc.kind === "test" && rc.ok === false && rc.failed === 2);
  const non = { server: "websearch", tool: "websearch__search", arguments: "hello" };
  check("classifyTool(non file/test) -> null  " + JSON.stringify(win.classifyTool(non)),
        win.classifyTool(non) === null);
  check("classifyTool(null) -> null (no throw)", win.classifyTool(null) === null);
}

// extractNextSteps: pulls the ```next-steps``` fence, parses * / ! / ? markers + label:detail, strips fence from text
{
  const r = win.extractNextSteps("前言\n```next-steps\n* 做X：详情A\n! 风险Y：详情B\n? 等确认Z：详情C\n```");
  check("extractNextSteps strips the fence from the prose  " + JSON.stringify(r.text),
        r.text === "前言" || !/next-steps/.test(r.text));
  const got = JSON.stringify(r.steps);
  const want = JSON.stringify([
    { label: "做X", detail: "详情A", recommended: true, avoid: false, hold: false },
    { label: "风险Y", detail: "详情B", recommended: false, avoid: true, hold: false },
    { label: "等确认Z", detail: "详情C", recommended: false, avoid: false, hold: true },
  ]);
  check("extractNextSteps parses */!/? markers + label:detail  " + got, got === want);
  const none = win.extractNextSteps("no fence here");
  check("extractNextSteps without a fence -> {text kept, steps:[]}",
        none.text === "no fence here" && none.steps.length === 0);
}

// extractProposalsFromText: lifts complete ```proposal``` JSON fences into m.proposals, strips them from m.text
{
  const m = { text: '前文\n```proposal\n{"title":"T1","verdict":"推荐"}\n```\n后文' };
  win.extractProposalsFromText(m);
  check("extractProposalsFromText lifted the proposal  " + JSON.stringify(m.proposals && m.proposals.map((p) => p.title)),
        !!(m.proposals && m.proposals.length === 1 && m.proposals[0].title === "T1" && m.proposals[0].verdict === "推荐"));
  check("extractProposalsFromText set id + verified + dismissed defaults",
        !!m.proposals[0].id && m.proposals[0].verified === false && m.proposals[0].dismissed === false);
  check("extractProposalsFromText removed the fence from m.text  " + JSON.stringify(m.text),
        !/```proposal/.test(m.text) && m.text.includes("前文") && m.text.includes("后文"));
  // an open (still-streaming) fence is left untouched until closed
  const m2 = { text: '```proposal\n{"title":"half"' };
  win.extractProposalsFromText(m2);
  check("extractProposalsFromText leaves an OPEN fence in text (no half-parsed object)",
        !m2.proposals && /```proposal/.test(m2.text));
  win.extractProposalsFromText(null);   // must not throw
  win.extractProposalsFromText({});      // must not throw
  check("extractProposalsFromText tolerates null / empty arg", true);
}

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
  check("after full boot the fence extractors + detectLang are still callable",
        typeof w.extractNextSteps === "function" && typeof w.extractProposalsFromText === "function"
        && w.detectLang("中文文本") === "zh");
}

console.log("\n=== decoy diff: removing a helper from app_utils flips it red ===");
{
  const broken = utilSrc.replace(/function\s+fmtBytesSel\s*\([\s\S]*?\n\}/, "");
  const w2 = bootUtil(broken);
  check("decoy: with fmtBytesSel removed, runtime check WOULD fail", typeof w2.fmtBytesSel !== "function");

  const broken2 = utilSrc.replace(/function\s+detectLang\s*\([\s\S]*?\n\}/, "");
  const w3 = bootUtil(broken2);
  check("decoy: with detectLang removed, runtime check WOULD fail", typeof w3.detectLang !== "function");
}

console.log("");
if (FAILURES.length) {
  console.log(`APP_UTILS GATE: ${FAILURES.length} FAILED`);
  FAILURES.forEach((f) => console.log("  - " + f));
} else {
  console.log("APP_UTILS GATE: ALL PASSED");
}
process.exit(FAILURES.length ? 1 : 0);
