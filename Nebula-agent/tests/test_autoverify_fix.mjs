/* Regression gate for the AUTO-VERIFY-FIX loop (2026-11-13).
 *
 * What it locks (the contract this feature introduced — all logic, no pixels):
 *   Push records   pushBugFix records pendingFixTs = the bug it is fixing (before send()).
 *   Consume        streamAssistant moves pendingFixTs onto THIS turn's message (one-shot, same
 *                  pattern as resumeBadge). simulateConsumeOnMsg reproduces that exact line.
 *   Gate           maybeAutoVerifyFix verifies+ejects ONLY when THIS VERY TURN ran the bug's
 *                  regression test AND it came back green (classifyTool: kind test, ok true).
 *   Switch         settings.autoVerifyFix === false => never auto-eject (stay in fixing).
 *   Eject          a green gate routes through markBugVerified -> removed from the box (audit stays).
 *
 * LOAD-BEARING differential: the green-test path MUST eject; the three controls that strip exactly
 * one load-bearing input MUST NOT — (a) no test ran this turn, (b) the test ran but came back RED,
 * (c) the master switch is off. If any of those ejections happen the gate is decorative, not real.
 *
 * Run: node tests/test_autoverify_fix.mjs
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

win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
win.localStorage.setItem("strata.lang", "en");

win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const utilCode = fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8");
const appCode = utilCode + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const injected = appCode + `
;send = async (human = true) => { window.__send.push(ceText(document.getElementById("input"))); };
postQuiet = (url, body) => { window.__pq.push({ url, body }); };
window.__send = [];
window.__pq = [];
window.__api = {
  bugBoxEntries, bugBoxSave, markBugVerified, pushBugFix, setBugStatus,
  classifyTool, maybeAutoVerifyFix, t,
  getPendingFixTs: () => pendingFixTs,
  simulateConsumeOnMsg: (m) => { if (pendingFixTs) { m._fixBugTs = pendingFixTs; pendingFixTs = null; } return m; },
  setSettings: (patch) => { settings = { ...settings, ...patch }; },
};`;
win.eval(injected);
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));

const api = win.__api;
const box = () => JSON.parse(win.localStorage.getItem("strata.bugBox") || "[]");
const setBox = (arr) => win.localStorage.setItem("strata.bugBox", JSON.stringify(arr));
const clear = () => { win.__send.length = 0; win.__pq.length = 0; };

// a tool shape that classifyTool reads as a GREEN test run (server shell, cmd matches TEST_RE, result shows passed)
// real pytest-green output shape: no literal "failed" substring (the gate guards on /FAILED/i)
const greenTool = () => ({ server: "shell", name: "shell__exec", arguments: "python tests/test_bug.py", result: "7 passed in 0.12s", ok: true });
const redTool = () => ({ server: "shell", name: "shell__exec", arguments: "python tests/test_bug.py", result: "6 passed, 1 failed", ok: true });

// helper: push a fixing bug, consume onto a turn message carrying `tools`, run the gate, return ejected?
function runGate(ts, tools, settingsPatch) {
  setBox([{ ts, kind: "bug:unhandledrejection", status: "fixing", msg: "boom", stack: "s" }]);
  clear();
  api.setSettings(Object.assign({ autoVerifyFix: true }, settingsPatch || {}));
  api.pushBugFix(String(ts));                       // records pendingFixTs + sends
  const m = api.simulateConsumeOnMsg({ role: "assistant", text: "", tools }); // moves it onto the turn
  const pushedTs = api.getPendingFixTs();           // after consume it must be cleared to null
  const gateRet = api.maybeAutoVerifyFix(m);        // the action under test
  return { boxAfter: box(), sendCount: win.__send.length, pendingAfterConsume: pushedTs, mfix: m._fixBugTs };
}

console.log("AUTO-VERIFY-FIX:");

// ── 1. push records the ts (the hand-off that was missing) ──────────────────────
{
  setBox([{ ts: 11000, kind: "bug:x", status: "open", msg: "boom", stack: "s" }]);
  clear();
  api.pushBugFix("11000");
  check("1. pushBugFix sent one task", win.__send.length === 1, "send=" + win.__send.length);
  check("1. pushBugFix recorded pendingFixTs = the pushed ts", api.getPendingFixTs() === 11000, "got " + JSON.stringify(api.getPendingFixTs()));
}

// ── 2. consume moves pendingFixTs onto the turn (and clears the one-shot) ───────
{
  setBox([{ ts: 12000, kind: "bug:x", status: "fixing", msg: "boom", stack: "s" }]);
  clear();
  api.pushBugFix("12000");
  const m = { role: "assistant", text: "", tools: [greenTool()] };
  api.simulateConsumeOnMsg(m);
  check("2. consumed onto the message as _fixBugTs", m._fixBugTs === 12000, JSON.stringify(m._fixBugTs));
  check("2. one-shot cleared after consume", api.getPendingFixTs() === null, JSON.stringify(api.getPendingFixTs()));
}

// ── 3. THE GATE (load-bearing) — only a green test on a pushed fix ejects ───────
{
  const a = runGate(13000, [greenTool()], null);
  check("3. GREEN test this turn -> bug EJECTED from box", a.boxAfter.length === 0, "box=" + JSON.stringify(a.boxAfter.map((x) => x.status)));

  // CONTROL (a): no test ran this turn -> must STAY in fixing
  const ca = runGate(13100, [], null);
  check("CONTROL(no test ran) -> stays fixing, NOT ejected", ca.boxAfter.length === 1 && ca.boxAfter[0].status === "fixing", "box=" + JSON.stringify(ca.boxAfter.map((x) => x.status)));

  // CONTROL (b): test ran but RED -> must STAY in fixing
  const cb = runGate(13200, [redTool()], null);
  check("CONTROL(test RED) -> stays fixing, NOT ejected", cb.boxAfter.length === 1 && cb.boxAfter[0].status === "fixing", "box=" + JSON.stringify(cb.boxAfter.map((x) => x.status)));

  // CONTROL (c): master switch OFF -> must STAY in fixing even with a green test
  const cc = runGate(13300, [greenTool()], { autoVerifyFix: false });
  check("CONTROL(switch OFF) -> stays fixing, NOT ejected", cc.boxAfter.length === 1 && cc.boxAfter[0].status === "fixing", "box=" + JSON.stringify(cc.boxAfter.map((x) => x.status)));
}

// ── 4. not-a-pushed-turn (no _fixBugTs) -> no-op even with a green test ──────────
{
  setBox([{ ts: 14000, kind: "bug:x", status: "fixing", msg: "boom", stack: "s" }]);
  clear();
  api.setSettings({ autoVerifyFix: true });
  const m = { role: "assistant", text: "", tools: [greenTool()] };   // NO _fixBugTs (no push happened this turn)
  api.maybeAutoVerifyFix(m);
  check("4. a turn that did not push a fix -> no-op (stays fixing)", box().length === 1 && box()[0].status === "fixing", "box=" + JSON.stringify(box().map((x) => x.status)));
}

console.log("");
if (FAILURES.length) {
  console.log("AUTO-VERIFY-FIX: " + FAILURES.length + " FAILED");
  for (const f of FAILURES) console.log("  - " + f);
  process.exit(1);
} else {
  console.log("AUTO-VERIFY-FIX: ALL PASSED");
  process.exit(0);
}
