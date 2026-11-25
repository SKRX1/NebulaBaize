/* Regression gate for the SELF-EVOLVING FIX LOOP (bug collection box + auto-fix driver).
 *
 * What it locks (the contract this feature introduced — all logic, no pixels):
 *   Capture     every fresh bug enters the box with status 'open'.
 *   State machine  setBugStatus flips open->fixing and persists (the JSONL leg gets an echo).
 *   Push marks fixing   pushBugFix flags the record fixing BEFORE sending (pre-feedback-loop).
 *   Idle driver   autofixTick: OFF => nothing; ON => takes the OLDEST open one and marks it
 *                 fixing immediately, sends exactly ONE task, never re-picks it (anti self-feed).
 *   Verified leaves   markBugVerified flips to verified, echoes the audit, and REMOVES it from
 *                 the box (the append-only JSONL keeps the trail).
 *   Render badge  a non-open record renders a status badge in the DOM.
 *
 * Differential double-probe: every assertion must be able to go RED (a dead/stub state machine
 * fails here). A boot stub replaces send/postQuiet with recorders so nothing hits the network.
 * Run: node tests/test_autofix_loop.mjs
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
win.localStorage.setItem("strata.lang", "en");   // en so i18n labels are deterministic ("Fixing"/"Verified")

// minimal fetch stub (the app's boot + any postQuiet path never really hits the wire)
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const appCode = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
const injected = appCode + `
;send = async (human = true) => { window.__send.push(ceText(document.getElementById("input"))); };
postQuiet = (url, body) => { window.__pq.push({ url, body }); };
window.__send = [];
window.__pq = [];
window.__api = {
  bugBoxEntries, bugBoxSave, setBugStatus, markBugVerified, autofixTick, pushBugFix,
  _recordBugCapture, renderBugBox, t,
  setSettings: (patch) => { settings = { ...settings, ...patch }; },
};`;
win.eval(injected);
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));

const api = win.__api;
const BUGBOX_KEY = "bugBox";
const box = () => JSON.parse(win.localStorage.getItem("strata." + BUGBOX_KEY) || "[]");
const setBox = (arr) => win.localStorage.setItem("strata." + BUGBOX_KEY, JSON.stringify(arr));
const clearCounters = () => { win.__send.length = 0; win.__pq.length = 0; };

// start from an empty box so each test is deterministic
setBox([]);
api.setSettings({ autofix: false });

console.log("SELF-EVOLVING FIX LOOP:");

// ── 1. capture stamps every fresh bug as open ───────────────────────────────────
{
  setBox([]);
  api._recordBugCapture("window.onerror", { message: "boom-1", stack: "stack-1" });
  const e = box()[0];
  check("1. capture writes one record", box().length === 1, "got " + box().length);
  check("1. fresh bug status is open", e && e.status === "open", JSON.stringify(e && e.status));
}

// ── 2. state machine: setBugStatus flips open->fixing and echoes the JSONL leg ───
{
  setBox([{ ts: 1000, kind: "bug:window.onerror", status: "open", msg: "a", stack: "" }]);
  clearCounters();
  const ok = api.setBugStatus(1000, "fixing");
  const e = box().find((x) => x.ts === 1000);
  check("2. setBugStatus returns true", ok === true);
  check("2. status flipped to fixing", e && e.status === "fixing", JSON.stringify(e && e.status));
  check("2. JSONL audit echo fired", win.__pq.length === 1 && win.__pq[0].url === "api/interrupt-log", JSON.stringify(win.__pq.map((p) => p.url)));
  // RED-probe: a non-existent ts must be a no-op false
  check("2. missing ts -> false (not a dead stub)", api.setBugStatus(999999, "fixing") === false);
}

// ── 3. push marks fixing BEFORE sending (anti feedback loop) ────────────────────
{
  setBox([{ ts: 2000, kind: "bug:window.onerror", status: "open", msg: "boom-2", stack: "s", sourceTab: "chat" }]);
  clearCounters();
  api.pushBugFix("2000");
  const e = box().find((x) => x.ts === 2000);
  check("3. pushBugFix sent one task", win.__send.length === 1, "send calls=" + win.__send.length);
  check("3. pushed input carries the bug", win.__send[0] && win.__send[0].includes("boom-2"));
  check("3. pushed record marked fixing", e && e.status === "fixing", JSON.stringify(e && e.status));
}

// ── 4. idle driver ──────────────────────────────────────────────────────────────
{
  // OFF => does nothing even with an open bug
  setBox([{ ts: 3000, kind: "bug:x", status: "open", msg: "m", stack: "" }]);
  api.setSettings({ autofix: false });
  clearCounters();
  api.autofixTick();
  check("4. OFF: no send", win.__send.length === 0);

  // ON + two open bugs => takes the OLDEST, marks it fixing, sends exactly ONE
  setBox([
    { ts: 5000, kind: "bug:x", status: "open", msg: "newer", stack: "" },
    { ts: 4000, kind: "bug:x", status: "open", msg: "oldest", stack: "", sourceTab: "chat" },
  ]);
  api.setSettings({ autofix: true });
  clearCounters();
  api.autofixTick();
  check("4. ON: sends exactly one", win.__send.length === 1, "send calls=" + win.__send.length);
  check("4. picks the OLDEST open (ts 4000)", win.__send[0] && win.__send[0].includes("oldest"), JSON.stringify(win.__send[0]));
  const oldest = box().find((x) => x.ts === 4000);
  const newer = box().find((x) => x.ts === 5000);
  check("4. oldest marked fixing (no re-pick)", oldest && oldest.status === "fixing", JSON.stringify(oldest && oldest.status));
  check("4. the other stays open", newer && newer.status === "open", JSON.stringify(newer && newer.status));

  // anti-self-feed: next idle takes the NEXT oldest open (the 5000), never re-picks 4000 (now fixing)
  clearCounters();
  api.autofixTick();
  check("4. anti-self-feed: next tick picks the next open", win.__send[0] && win.__send[0].includes("newer"), JSON.stringify(win.__send[0]));

  // nothing left open => idle does nothing
  clearCounters();
  api.autofixTick();
  check("4. no open left -> no send", win.__send.length === 0);
}

// ── 5. verified leaves the box; audit stays in the JSONL echo ────────────────────
{
  setBox([{ ts: 6000, kind: "bug:x", status: "fixing", msg: "m", stack: "" }]);
  clearCounters();
  const ok = api.markBugVerified(6000);
  check("5. markBugVerified returns true", ok === true);
  check("5. verified leaves the box", box().length === 0, "box=" + JSON.stringify(box()));
  check("5. JSONL audit echo still fired before removal", win.__pq.length === 1 && win.__pq[0].url === "api/interrupt-log", JSON.stringify(win.__pq.map((p) => p.url)));
  check("5. missing ts -> false", api.markBugVerified(999999) === false);
}

// ── 6. render shows a status badge for a non-open record ─────────────────────────
{
  setBox([{ ts: 7000, kind: "bug:x", status: "fixing", msg: "m", stack: "" }]);
  const host = doc.getElementById("bugbox-list");
  api.renderBugBox();
  check("6. fixing badge rendered (status element)", host && host.innerHTML.includes("badge--status"), host ? host.innerHTML.slice(0, 120) : "no host");
  // open row shows NO status badge (noise-free) -> differential that the badge is status-driven
  setBox([{ ts: 8000, kind: "bug:x", status: "open", msg: "m", stack: "" }]);
  api.renderBugBox();
  check("6. open row has NO status badge", host && !host.innerHTML.includes("badge--status"), host ? host.innerHTML.slice(0, 120) : "no host");
}

console.log("");
if (FAILURES.length) {
  console.log("AUTOFIX: " + FAILURES.length + " FAILED");
  for (const f of FAILURES) console.log("  - " + f);
  process.exit(1);
} else {
  console.log("AUTOFIX: ALL PASSED");
  process.exit(0);
}
