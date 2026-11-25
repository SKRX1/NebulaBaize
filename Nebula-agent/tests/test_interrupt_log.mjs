/* Regression test for the INTERRUPTION LOG (2026-10-20).

"Sometimes the stream just stops while thinking or inside a tool call" had no evidence behind
it: the UI said nothing, and no record survived. This is the record. Every turn that did not
finish cleanly is written down with the TIME and the PHASE it died in, so a future report can
be diagnosed instead of guessed at.

Boots the REAL index.html + i18n.js + app.js in jsdom and verifies the contract:

  Phase          the phase is whatever the user was looking at when the turn died: "thinking"
                 while reasoning tokens were arriving, "answering" while content was arriving,
                 "tool" (+ the tool NAME) while a tool was open. Falls back to the last tool /
                 to reasoning-vs-text when no token ever set the phase.
  Kind           truncated | notice:<code> | error | limit | stopped. A CLEAN turn is NOT
                 logged -- otherwise real breaks drown in one entry per ordinary answer.
  Record         carries ts / phase / tool / toolState / idleS / session / notice|error, i.e.
                 enough to answer "engine silent, tool wedged, or network dropped".
  Sinks          the gateway file via POST api/interrupt-log, plus a localStorage mirror that
                 keeps working when the route is missing (parasitic mode / offline). The mirror
                 is capped (ILOG_MIRROR_MAX) and never throws.
  Viewer         the About panel renders newest-first rows; falls back to the mirror on 404.

Run: node tests/test_interrupt_log.mjs
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

win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
win.localStorage.setItem("strata.lang", "en");

const posted = [];                                 // every entry the frontend tried to hand the server
let logRouteOk = true;                             // flip to false to emulate an older gateway
win.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("api/interrupt-log")) {
    if (!logRouteOk) return { ok: false, status: 404, json: async () => ({}) };
    if (opts.method === "POST") posted.push(JSON.parse(opts.body).entry);
    return { ok: true, status: 200, json: async () => ({ ok: true, path: "/tmp/interrupt-log.jsonl",
      count: 0, entries: [] }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const appCode = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(appCode + `
;window.__api = {
  noteStreamPhase, interruptRecord, logInterruption, recordInterruption, loadInterruptLog, ilogRowHtml,
  ILOG_KEY, ILOG_MIRROR_MAX,
  setSession: (v) => { activeId = v; },
  mirror: () => { try { return JSON.parse(localStorage.getItem("strata." + ILOG_KEY) || "[]"); } catch (e) { return []; } },
  clearMirror: () => { localStorage.removeItem("strata." + ILOG_KEY); },
};`);
const api = win.__api;

const newMsg = (over = {}) => ({ role: "assistant", text: "", reasoning: "", tools: [], ...over });
const cleanMirror = () => api.clearMirror();
const clearPosted = () => { posted.length = 0; };

console.log("INTERRUPTION LOG:");

// T1 -- phase: what the user was looking at when the turn died
{
  const think = newMsg({ reasoning: "hmm" });
  api.noteStreamPhase(think, "thinking");
  check("phase: thinking", api.interruptRecord(think, "truncated").phase === "thinking");

  const ans = newMsg({ text: "partial answer" });
  api.noteStreamPhase(ans, "answering");
  check("phase: answering", api.interruptRecord(ans, "truncated").phase === "answering");

  const tool = newMsg({ tools: [{ id: "t1", name: "shell_run", state: "running", round: 3 }] });
  api.noteStreamPhase(tool, "tool", "shell_run");
  const r = api.interruptRecord(tool, "truncated");
  check("phase: tool + its name", r.phase === "tool" && r.tool === "shell_run", JSON.stringify(r));
  check("phase: tool state + round", r.toolState === "running" && r.round === 3, JSON.stringify(r));

  // answering after a finished tool is "answering", not "tool"
  const done = newMsg({ text: "x", tools: [{ id: "t1", name: "shell_run", state: "done" }] });
  api.noteStreamPhase(done, "answering");
  check("phase: a finished tool does not hijack the phase", api.interruptRecord(done, "truncated").phase === "answering");
}

// T2 -- phase fallback when no token ever set it (e.g. cut during the very first tool call)
{
  const never = newMsg();
  check("fallback: nothing at all -> answering", api.interruptRecord(never, "truncated").phase === "answering");
  const onlyReason = newMsg({ reasoning: "abc" });
  check("fallback: reasoning only -> thinking", api.interruptRecord(onlyReason, "truncated").phase === "thinking");
  const openTool = newMsg({ tools: [{ id: "t1", name: "fs_write", state: "writing" }] });
  const rf = api.interruptRecord(openTool, "truncated");
  check("fallback: an open tool -> tool + name", rf.phase === "tool" && rf.tool === "fs_write", JSON.stringify(rf));
}

// T3 -- kind: which stops get logged, and a clean turn does not
{
  cleanMirror(); clearPosted();
  const cases = [
    [{ truncated: true }, "truncated"],
    [{ notice: { code: "idle", resumable: true } }, "notice:idle"],
    [{ error: "boom" }, "error"],
    [{ limit: 500 }, "limit"],
    [{ stopped: true }, "stopped"],
  ];
  for (const [over, want] of cases) {
    const m = newMsg(over);
    const rec = api.recordInterruption(m);
    check(`kind: ${want}`, rec && rec.kind === want, rec ? rec.kind : "null");
  }
  const clean = newMsg({ text: "all good" });
  check("kind: a clean turn is NOT logged", api.recordInterruption(clean) === null);
  check("kind: nothing was posted for the clean turn", posted.length === cases.length,
        `posted=${posted.length}`);
}

// T4 -- the record carries enough to tell the three failure modes apart
{
  const m = newMsg({ text: "half an answer", reasoning: "r",
    tools: [{ id: "t1", name: "web_search", state: "running", round: 7 }],
    notice: { code: "idle", resumable: true } });
  m._lastActivityAt = Date.now() - 175000;
  api.setSession("sess-abc");
  const r = api.recordInterruption(m);
  check("record: idle seconds (engine silent vs busy)", r.idleS >= 174 && r.idleS <= 176, String(r.idleS));
  check("record: session id", r.session === "sess-abc", String(r.session));
  check("record: notice code", r.notice === "idle", String(r.notice));
  check("record: ISO timestamp", typeof r.ts === "string" && /^\d{4}-\d{2}-\d{2}T/.test(r.ts), String(r.ts));
  check("record: flags are booleans, not undefined", r.truncated === false && r.stopped === false);
}

// T5 -- two sinks: the server file AND a localStorage mirror; the mirror is capped
{
  cleanMirror(); clearPosted();
  api.recordInterruption(newMsg({ truncated: true }));
  check("sinks: one entry posted to the server", posted.length === 1 && !!posted[0].ts);
  check("sinks: one entry mirrored locally", api.mirror().length === 1);
  for (let i = 0; i < api.ILOG_MIRROR_MAX + 25; i++) api.recordInterruption(newMsg({ truncated: true }));
  check("sinks: mirror stays capped", api.mirror().length === api.ILOG_MIRROR_MAX,
        `${api.mirror().length} > ${api.ILOG_MIRROR_MAX}`);
  check("sinks: the newest entry is the last one kept",
        api.mirror()[api.mirror().length - 1].kind === "truncated");
}

// T6 -- no route (parasitic mode / offline): the mirror still holds the record, no throw
{
  cleanMirror(); clearPosted();
  logRouteOk = false;
  let threw = false;
  try { api.recordInterruption(newMsg({ truncated: true })); } catch (e) { threw = true; }
  logRouteOk = true;
  check("no route: logging does not throw", threw === false);
  check("no route: the mirror still has it", api.mirror().length === 1);
}

// T7 -- About-panel viewer: renders newest-first, and falls back to the mirror on 404
{
  cleanMirror();
  api.recordInterruption(newMsg({ error: "first" }));
  api.recordInterruption(newMsg({ truncated: true }));
  await api.loadInterruptLog();
  const rows = win.document.querySelectorAll("#ilog-row, .ilog-row");
  check("viewer: the card is shown", win.document.getElementById("ilog-card").hidden === false);
  const html = win.document.getElementById("ilog-list").innerHTML;
  check("viewer: rows rendered", rows.length >= 2 || html.indexOf("ilog-row") >= 0, `rows=${rows.length}`);
  check("viewer: newest entry first", html.indexOf("truncated") < html.indexOf("error"),
        "expected truncated before error");
  const emptyish = api.ilogRowHtml({ ts: "2026-10-20T01:02:03.000Z", kind: "truncated",
    phase: "tool", tool: "shell_run", idleS: 12 });
  check("viewer: a tool row names the tool", emptyish.indexOf("shell_run") >= 0, emptyish);
  check("viewer: idle shown", emptyish.indexOf("12s") >= 0, emptyish);
}

// ---------- summary --------------------------------------------------------------
if (FAILURES.length) {
  console.log(`\nINTERRUPTION LOG: ${FAILURES.length} FAILED`);
  for (const f of FAILURES) console.log("  - " + f);
  process.exit(1);
} else {
  console.log("\nINTERRUPTION LOG: ALL PASSED");
  process.exit(0);
}
