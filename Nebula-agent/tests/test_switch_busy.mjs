/* Differential contract test: view-switch while a task is streaming (2026-10-21).
 *
 * Boots the REAL index.html + i18n.js + app.js in jsdom (same harness as
 * test_sidebar_tree.mjs) and pins the six behaviours the switch-view feature
 * must guarantee:
 *
 *   T1  a running stream no longer blocks switching to another task; the
 *       originating session keeps the streaming message by REFERENCE (the
 *       saveChat shallow-copy trap would orphan it, so it must stay the live
 *       object), and the sidebar lights ONLY the originating row.
 *   T2  the badge follows busy.sessionId, not activeId: after switching away,
 *       the badge stays on the originator and the newly-shown task has none.
 *   T3  switching back to the originating task shows the streamed content.
 *   T4  clicking the originator's own row while it streams does nothing wrong
 *       (stays on it).
 *   T5  source anchors: the tail write-back is attributed to busy.sessionId
 *       (captured before `busy = null`), the scroll gates are same-source,
 *       and the i18n key exists in BOTH dictionaries.
 *   T6  idle case untouched: with busy null, a plain switch still works.
 *
 * Run: node tests/test_switch_busy.mjs
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
const doc = win.document;

win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
win.localStorage.setItem("strata.lang", "en");
win.confirm = () => true;
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

win.i18n = { t: (k) => k, syncSwitchers() {} };

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
let appCode = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
appCode += `
;window.__api = {
  renderSessions, selectSession, renderChat,
  getSessions: () => sessions, setSessions: (v) => { sessions = v; },
  setWorkspaces: (v) => { workspaces = v; },
  setActiveId: (id) => { activeId = id; }, getActiveId: () => activeId,
  getMessages: () => messages, setMessages: (v) => { messages = v; },
  getBusy: () => busy, setBusyObj: (v) => { busy = v; },
  findSession, findSessionLocal: findSession,
};`;
win.eval(appCode);

const api = win.__api;
const list = () => doc.getElementById("session-list");
const rowOf = (sid) => list().querySelector(`.st-session[data-sid="${sid}"]`);
const badgeOf = (sid) => rowOf(sid) && /running/.test(rowOf(sid).className);   // single-dot merge: indicator is the row .running class

const WS_A = "C:\\work\\alpha";

function freshSeed() {
  api.setSessions([
    {id: "s1", title: "alpha one", workspace: WS_A, permission: "auto", messages: [{role: "user", text: "a1"}], updatedAt: Date.now()},
    {id: "s2", title: "alpha two", workspace: WS_A, permission: "full", messages: [{role: "user", text: "a2"}], updatedAt: Date.now()},
    {id: "s3", title: "loose", workspace: "", permission: "auto", messages: [{role: "user", text: "l1"}], updatedAt: Date.now()},
  ]);
  api.setWorkspaces([{path: WS_A, name: "alpha", collapsed: false}]);
}

console.log("=== T1: switch away while s1 streams; originator keeps the live message ===");
freshSeed();
api.setActiveId("s1");
api.setMessages(api.getSessions()[0].messages);
const streamMsg = {role: "assistant", text: "half-streamed...", reasoning: "", time: Date.now()};
api.getMessages().push(streamMsg);           // s1 keeps it by REFERENCE (appends via its own array)
api.setBusyObj({controller: {abort() {}}, msg: streamMsg, stopId: "sX", sessionId: "s1"});
api.renderSessions();
check("originator row lights the badge", !!badgeOf("s1"));
check("other rows stay plain (no badge)", !badgeOf("s2") && !badgeOf("s3"));
console.log("=== T2: click another task while busy -> switch allowed, badge follows the originator ===");
const busyObj = {controller: {abort() {}}, msg: streamMsg, stopId: "sX", sessionId: "s1"};
api.setBusyObj(busyObj);
api.selectSession("s2");
check("we are now viewing s2", api.getActiveId() === "s2");
check("badge still on the ORIGINATOR s1 (not the viewed task)", !!badgeOf("s1"));
check("viewed task s2 has no badge", !badgeOf("s2"));
const s1 = api.getSessions().find((x) => x.id === "s1");
check("originator session holds the LIVE streaming object", s1.messages[s1.messages.length - 1] === streamMsg);
check("viewed session shows its own history", api.getMessages().some((m) => m.text === "a2"));

console.log("=== T3: switching back shows what streamed so far ===");
api.selectSession("s1");
check("back on the originator", api.getActiveId() === "s1");
check("the streamed message is visible in the array", api.getMessages().includes(streamMsg));

console.log("=== T4: clicking the originator's own row while it streams is a no-op ===");
const before = api.getActiveId();
api.selectSession("s1");
check("still on s1, nothing moved", api.getActiveId() === before);

console.log("=== T5: source anchors (tail attribution, scroll gates, dual i18n) ===");
check("tail captures busy.sessionId before busy=null", /const _ownerSid = busy\.sessionId, _origin = busy\.origin;/.test(appCode));
check("tail write-back is attributed to the originator", /_ownerSid && _ownerSid !== activeId/.test(appCode));
check("paint scrollDown is gated to the same source", /if \(busy\.sessionId === activeId\) scrollDown\(\)/.test(appCode));
check("live-timer scrollDown is gated to the same source", /streamingFollow && busy\.sessionId === activeId\) scrollDown/.test(appCode));
check("sidebar badge keys the originator", /busy && s\.id === busy\.sessionId/.test(appCode));
const i18src = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
check("i18n key exists in BOTH dictionaries", (i18src.match(/side\.running\.badge/g) || []).length === 2);
const cssSrc = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
check("badge CSS uses the gentle pulse (not steps(2))", /\.st-session__live \{[^}]*pulseDot/.test(cssSrc));
check("badge CSS is green", /\.st-session__live \{[^}]*--st-ok/.test(cssSrc));

console.log("=== T6: idle case untouched (busy null, plain switch works) ===");
api.setBusyObj(null);
freshSeed();
api.setActiveId("s1");
api.setMessages(api.getSessions()[0].messages);
api.renderSessions();
api.selectSession("s3");
check("idle switch still lands on s3", api.getActiveId() === "s3");
check("no badge anywhere when idle", !badgeOf("s1") && !badgeOf("s2") && !badgeOf("s3"));

console.log("");
if (FAILURES.length) { console.log("SWITCH-BUSY: " + FAILURES.length + " FAILURE(S)"); for (const f of FAILURES) console.log("  - " + f); process.exit(1); }
console.log("SWITCH-BUSY: ALL PASSED"); process.exit(0);
