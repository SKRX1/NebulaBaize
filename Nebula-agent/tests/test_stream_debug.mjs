/* Regression test for the streaming debug suite — Step1-F (client-side exception capture).
 *
 * Boots the REAL index.html + i18n.js + app.js in jsdom, then verifies:
 *
 *   F-A  window.__strataDebug is exposed and `current()` is null when no turn is live.
 *   F-B  a client-side exception thrown WHILE a turn is live is captured with the
 *        chunk index + bytes received so far, attached to the message, and exposed
 *        via __strataDebug (both `window.onerror` and `unhandledrejection` paths).
 *   F-C  de-dupe: the same throw surfacing as both error + unhandledrejection is
 *        recorded once.
 *   F-D  a mock SSE stream driven through streamAssistant increments chunkIndex
 *        (per data event) and bytes (per read) correctly, and [DONE] ends cleanly.
 *
 * Run: node tests/test_stream_debug.mjs
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
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
win.localStorage.setItem("strata.lang", "en");

// Boot-time fetch mock (health / mcp / metrics). The chat stream is overridden per-test below.
win.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model", max_context: 32768 }) };
  if (u.includes("metrics")) return { ok: true, status: 200, json: async () => ({ engine: { max_context: 32768 } }) };
  if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
  return { ok: true, status: 200, json: async () => ({}) };
};

let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
// Expose the Step1-F internals + a direct-eval stubber so the test can no-op the
// heavy renderers without touching app.js itself.
appCode += `
;window.__api = Object.assign(window.__api || {}, {
  _dbg, streamAssistant, t,
  renderBugBox, bugBoxSave, bugBoxFindByTs, bugBoxExpanded, getBugShowLimit: () => BUGBOX_SHOW_LIMIT,
  openDebug, renderDebug, diagnoseStream, buildDebugEvidence,
  fetchLatestRequest, buildRequestCurl, renderGatewayDebug, copyRequestCurl,
  fetchAllRequests, computeWaterfall, reconcileRender, normalizeForReconcile,
  getBusy: () => busy,
  getSettings: () => settings, setSettings: (s) => { settings = Object.assign({}, settings, s); },
  getMessages: () => messages, setMessages: (m) => { messages = m; },
  getSessions: () => sessions, setSessions: (s) => { sessions = s; },
  setActiveId: (id) => { activeId = id; },
});
window.__stub = (name, fn) => { try { eval(name + ' = fn'); } catch (e) {} };`;
win.eval(appCode);
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = win.__api;
const dbg = win.__strataDebug;
const _dbg = api._dbg;

let pass = true;

// ============================================================ F-A: exposure
console.log("\n=== F-A: __strataDebug exposure ===");
{
  check("window.__strataDebug exists", !!dbg);
  check("current() is null when no turn is live", dbg && dbg.current === null);
  check("_dbg buffer is defined", !!_dbg);
}

// ============================================================ F-B: capture during a live turn
console.log("\n=== F-B: client exception captured with chunk/byte context ===");
{
  const turn = { _clientErrors: [] };
  _dbg.turn = turn; _dbg.chunkIndex = 7; _dbg.bytes = 321; _dbg.errors = []; _dbg.lastError = null; _dbg._lastTs = 0;
  // Simulate a real crash surfacing via window.onerror (e.g. a throw inside a rAF paint).
  win.dispatchEvent(new win.ErrorEvent("error", { message: "boom in paint", error: new Error("boom in paint") }));
  await sleep(10);
  check("one client error recorded", _dbg.errors.length === 1, "got " + _dbg.errors.length);
  const rec = _dbg.errors[0] || {};
  check("recorded at the right chunk index", rec.chunkIndex === 7, "chunkIndex=" + rec.chunkIndex);
  check("recorded with the right byte count", rec.bytes === 321, "bytes=" + rec.bytes);
  check("message captured", rec.msg === "boom in paint", JSON.stringify(rec.msg));
  check("stack captured", typeof rec.stack === "string" && rec.stack.length > 0 && /boom in paint/.test(rec.stack), JSON.stringify((rec.stack || "").slice(0, 20)));
  check("attached to the message object", turn._clientErrors.length === 1);
  check("phase is window.onerror", rec.phase === "window.onerror", rec.phase);
  check("__strataDebug.current exposes it", dbg.current && dbg.current.errors.length === 1);
  check("__strataDebug.errorsFor(message) returns it", dbg.errorsFor(turn).length === 1);
  _dbg.turn = null; _dbg.errors = []; _dbg.lastError = null; _dbg._lastTs = 0; turn._clientErrors = [];
}

// ============================================================ F-B2: unhandledrejection path
console.log("\n=== F-B2: unhandledrejection path ===");
{
  const turn = { _clientErrors: [] };
  _dbg.turn = turn; _dbg.chunkIndex = 2; _dbg.bytes = 88; _dbg.errors = []; _dbg.lastError = null; _dbg._lastTs = 0;
  win.dispatchEvent(new win.PromiseRejectionEvent("unhandledrejection", { promise: Promise.resolve(), reason: new Error("async crash") }));
  await sleep(10);
  check("one client error recorded via unhandledrejection", _dbg.errors.length === 1, "got " + _dbg.errors.length);
  check("phase is unhandledrejection", (_dbg.errors[0] || {}).phase === "unhandledrejection");
  check("attached to the message object", turn._clientErrors.length === 1);
  _dbg.turn = null; _dbg.errors = []; _dbg.lastError = null; _dbg._lastTs = 0; turn._clientErrors = [];
}

// ============================================================ F-C: de-dupe
console.log("\n=== F-C: same throw on both events is de-duped ===");
{
  const turn = { _clientErrors: [] };
  _dbg.turn = turn; _dbg.chunkIndex = 4; _dbg.bytes = 200; _dbg.errors = []; _dbg.lastError = null; _dbg._lastTs = 0;
  const err = new Error("double surfaced");
  win.dispatchEvent(new win.ErrorEvent("error", { message: "double surfaced", error: err }));
  win.dispatchEvent(new win.PromiseRejectionEvent("unhandledrejection", { promise: Promise.resolve(), reason: err }));
  await sleep(20);
  check("de-duped to a single record", _dbg.errors.length === 1, "got " + _dbg.errors.length);
  _dbg.turn = null; _dbg.errors = []; _dbg.lastError = null; _dbg._lastTs = 0; turn._clientErrors = [];
}

// ============================================================ F-D: counters via a mock SSE stream
console.log("\n=== F-D: chunk/byte counters increment through streamAssistant ===");
{
  // No-op the heavy / side-effecting renderers + post-processors so the run is deterministic.
  // No-op the heavy / side-effecting renderers + post-processors. Return-value-consuming
  // pure functions (extractNextSteps, applyPlan) are left real so the stream wiring stays honest.
  for (const n of ["updateAssistant", "renderChat", "renderInspector", "renderStats", "tickToolTimers",
                   "scrollDown", "settleBottom", "maybeAutoResume", "maybeAutoDrive", "maybeAutoLearn",
                   "maybeProposeMemory", "maybeProposeDesign", "maybeAutoCompact", "saveChat", "saveSessions",
                   "recordInterruption", "noteStreamPhase", "extractProposalsFromText", "onTool", "onApproval",
                   "markTruncatedIfCut", "recordSpeedBaseline", "renderNextSteps",
                   "noteSeedUsed", "bumpNebDone", "gatewayIsDown"]) {
    win.__stub(n, () => {});
  }
  const enc = new TextEncoder();
  const chunks = [
    enc.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n'),
    enc.encode('data: {"choices":[{"delta":{"content":" world"}}]}\n'),
    enc.encode('data: [DONE]\n'),
  ];
  let ci = 0;
  win.fetch = async () => ({
    ok: true, status: 200,
    body: { getReader: () => ({ read: async () => (ci < chunks.length ? { value: chunks[ci++], done: false } : { value: undefined, done: true }) }) },
  });
  // Provide a minimal session + a user message so streamAssistant can build its request.
  api.setSessions([{ id: "s1", workspace: null }]);
  api.setActiveId("s1");
  api.setMessages([{ role: "user", text: "hi" }]);
  api.setSettings({ recall: false });

  try { await api.streamAssistant(); } catch (e) { /* a stubbed render may surface; counters already recorded */ }

  check("chunkIndex counts every SSE data event (3)", _dbg.chunkIndex === 3, "chunkIndex=" + _dbg.chunkIndex);
  check("bytes received is positive", _dbg.bytes > 0, "bytes=" + _dbg.bytes);
  check("turn capture window closed after stream", _dbg.turn === null);
}

// ============================================================ G: debug drawer + diagnosis (Step1-G)
console.log("\n=== G: debug drawer + one-click diagnosis ===");
{
  // The debug tab button + full page view exist in the booted DOM (2026-10-27 migration).
  check("debug tab button exists in DOM", !!doc.getElementById("tab-btn-debug"));
  check("debug page view exists in DOM", !!doc.getElementById("view-debug"));
  check("debug list container exists", !!doc.getElementById("debug-list"));

  // openDebug routes through showTab: true shows the debug page, false routes back to chat.
  api.openDebug(true);
  check("openDebug(true) shows the debug page", doc.getElementById("view-debug").hidden === false);
  api.openDebug(false);
  check("openDebug(false) routes back to chat", doc.getElementById("view-debug").hidden === true);

  // A finished assistant turn carrying a captured client error renders into the list.
  const turn = {
    role: "assistant", text: "did some work", clientError: true,
    _clientErrors: [{ ts: Date.now(), phase: "window.onerror", msg: "boom in paint", stack: "Error: boom in paint\n    at updateAssistant", chunkIndex: 3, bytes: 99 }],
  };
  api.setMessages([{ role: "user", text: "hi" }, turn]);
  api.renderDebug();
  const dbgHtml = doc.getElementById("debug-list").innerHTML;
  check("renderDebug shows the captured error message", /boom in paint/.test(dbgHtml), dbgHtml.slice(0, 60));
  check("renderDebug shows the chunk position", /第 3 分块/.test(dbgHtml));
  check("renderDebug flags it as a front-end anomaly", dbgHtml.includes(api.t("debug.flag.client")), dbgHtml.slice(0, 60));

  // One-click diagnosis picks the client-error verdict for that turn (msg is interpolated only on that branch).
  const verdict = await api.diagnoseStream();
  check("diagnoseStream returns a client-error verdict", verdict.includes("boom in paint"), JSON.stringify(verdict.slice(0, 40)));

  // Evidence blob is self-contained.
  const ev = api.buildDebugEvidence();
  check("evidence blob carries the header + model", /流式调试证据/.test(ev) && /model:/.test(ev), ev.slice(0, 40));
  check("evidence blob includes the captured turn", /clientErrors/.test(ev));

  // No-anomaly state renders the empty hint.
  api.setMessages([{ role: "user", text: "hi" }, { role: "assistant", text: "clean" }]);
  api.renderDebug();
  check("renderDebug shows empty hint when clean", doc.getElementById("debug-list").innerHTML.includes(api.t("debug.none")));
}

// ============================================================ Step4-D: gateway-side debug + cURL replay
console.log("\n=== Step4-D: gateway-side debug drawer + cURL replay ===");
{
  // D-A: the gateway debug section is wired into the same debug drawer.
  check("gateway replay button (#debug-curl) exists", !!doc.getElementById("debug-curl"));
  check("gateway record container (#debug-gw-body) exists", !!doc.getElementById("debug-gw-body"));
  check("sub-tab bar + three panels wired on the page", doc.querySelectorAll(".db-subtabs").length === 1 && doc.querySelectorAll(".db-tabpanel").length === 3);
  // D-A: anchor-nav behaviour (the click-to-locate contract). Every assertion here is differential:
  //   - highlight follows the click (aria-selected moves to exactly the clicked sub-tab);
  //   - anchor nav keeps EVERY panel shown (no hide-switch), so is-active stays on all three;
  //   - clicking scrolls/locates the matching panel (scrollIntoView fired for that data-db only).
  // Remove either A1 (add is-active) or A2 (scrollIntoView) and the matching check goes RED.
  {
    const subtabs = [...doc.querySelectorAll(".db-subtab")];
    const panels = [...doc.querySelectorAll(".db-tabpanel")];
    win.__scrolled = [];
    panels.forEach((p) => { p.scrollIntoView = () => { win.__scrolled.push(p.dataset.db); }; });
    const target = subtabs.find((b) => b.dataset.db === "bugbox");
    target.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    check("D-A. click a sub-tab highlights it (aria-selected follows, only the clicked one)", target.getAttribute("aria-selected") === "true" && subtabs.filter((b) => b.getAttribute("aria-selected") === "true").length === 1);
    check("D-A. anchor nav keeps every panel shown (is-active stays on all three)", panels.every((p) => p.classList.contains("is-active")));
    check("D-A. click scrolls/locates the matching panel (anchor nav)", win.__scrolled.includes("bugbox"), JSON.stringify(win.__scrolled));
  }

  // D-B: bug-box long-list perf (aligns the memory page, approved 2026-10-27): default-collapse
  //   every row to its head line, cap the first paint at BUGBOX_SHOW_LIMIT + a load-more button,
  //   and grow the page on load-more. Differential: drop default-collapse / the slice cap / the
  //   load-more wiring and the matching check goes RED.
  {
    const seed = [];
    for (let i = 0; i < 60; i++) seed.push({ ts: 1700000000000 + i, kind: "k", sourceTab: "chat", msg: "m" + i, stack: "s", status: "open" });   // unique msg = unique signature, so signature-merge keeps 60 separate groups (this test measures pagination, not dedupe)
    api.bugBoxSave(seed);
    api.renderBugBox();
    const list = doc.getElementById("bugbox-list");
    const rows = () => [...list.querySelectorAll(".debug-item--bug")];
    check("D-B. first paint is capped at BUGBOX_SHOW_LIMIT (50) rows", rows().length === 50, "got " + rows().length);
    check("D-B. every default row is collapsed (head-line only)", rows().every((r) => r.classList.contains("is-collapsed")));
    check("D-B. a load-more button is present when rows exceed the cap", !!list.querySelector("[data-bugmore]"));
    // grow the page: load-more must append the rest
    list.querySelector("[data-bugmore]").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    check("D-B. load-more grows the first page to all 60", rows().length === 60, "got " + rows().length);
    // expand one collapsed row by clicking it; it must drop is-collapsed, the rest stay collapsed
    const clickedKey = rows()[0].getAttribute("data-bugtoggle");
    rows()[0].dispatchEvent(new win.MouseEvent("click", { bubbles: true }));   // innerHTML rebuilds every row; re-query below
    const expandedRow = rows().find((r) => r.getAttribute("data-bugtoggle") === clickedKey);
    check("D-B. clicking a collapsed row expands it (is-collapsed dropped)", !!expandedRow && !expandedRow.classList.contains("is-collapsed"));
    check("D-B. the other rows stay collapsed", rows().filter((r) => r !== expandedRow).every((r) => r.classList.contains("is-collapsed")));
  }
  check("bug box container (#bugbox-list) wired on the page", !!doc.getElementById("bugbox-list"));

  // D-B: fetchLatestRequest reads the most-recent record from the /api/requests monitor.
  const gwRec = {
    id: "abc123", path: "/v1/chat/completions", model: "test-model",
    started_at: 1700000000, state: "done", stream: true,
    input: JSON.stringify({ model: "test-model", stream: true, messages: [{ role: "user", content: "ping" }] }),
    input_truncated: false, output: "pong", chunk_timeline: [
      { t: 0.001, type: "thinking", bytes: 12 },
      { t: 0.02, type: "content", bytes: 8 },
      { t: 0.05, type: "usage", bytes: 6 },
      { t: 0.06, type: "done", bytes: 0 },
    ],
    last_chunk_type: "done", end_reason: "done", resumable: false, wallclock_s: 0.07,
  };
  win.fetch = async (url) => {
    const u = String(url);
    if (u.includes("api/requests")) return { ok: true, status: 200, json: async () => ({ requests: [gwRec] }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const latest = await api.fetchLatestRequest();
  check("fetchLatestRequest returns the latest record", latest && latest.id === "abc123", JSON.stringify(latest && latest.id));

  // D-C: buildRequestCurl turns a record into an exact-replay curl.
  const curl = api.buildRequestCurl(gwRec);
  check("curl uses streaming flag -N", curl.includes("-N"));
  check("curl uses POST method", curl.includes("-X POST"));
  check("curl targets the recorded path", curl.includes("/v1/chat/completions"));
  check("curl carries an Authorization bearer header", /Authorization: Bearer/.test(curl));
  check("curl embeds the request body", curl.includes('"content":"ping"'));
  check("curl single-quotes the body for the shell", curl.includes("-d '"));
  // single-quote escaping: a body containing ' must be escaped as '\''
  const tricky = { ...gwRec, input: JSON.stringify({ say: "it's" }) };
  const curl2 = api.buildRequestCurl(tricky);
  check("curl escapes embedded single quotes", curl2.includes("it'\\''s"), curl2.slice(0, 80));

  // D-D: renderGatewayDebug paints the chunk summary + breakpoint verdict into #debug-gw-body.
  await api.renderGatewayDebug();
  const gwHtml = doc.getElementById("debug-gw-body").innerHTML;
  check("gw debug renders chunk count", /分块 4/.test(gwHtml), gwHtml.slice(0, 60));
  check("gw debug shows the last chunk type", /末块 done/.test(gwHtml));
  check("gw debug shows the breakpoint end_reason", /断点 done/.test(gwHtml));
  check("gw debug flags non-resumable", gwHtml.includes(api.t("debug.gw.notresumable")), gwHtml.slice(0, 60));

  // empty / no-record state renders the empty hint instead of crashing.
  win.fetch = async (url) => {
    const u = String(url);
    if (u.includes("api/requests")) return { ok: true, status: 200, json: async () => ({ requests: [] }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await api.renderGatewayDebug();
  check("gw debug shows empty hint when no record", doc.getElementById("debug-gw-body").innerHTML.includes(api.t("debug.gw.empty")));

  // a record with input_truncated cannot be replayed: buildRequestCurl returns null.
  const truncated = { ...gwRec, input_truncated: true, input: JSON.stringify({ model: "x", messages: [] }) };
  check("buildRequestCurl returns null when body truncated", api.buildRequestCurl(truncated) === null);

  // resumable record is flagged as such.
  const resumableRec = { ...gwRec, end_reason: "notice:empty_round", resumable: true };
  win.fetch = async (url) => {
    const u = String(url);
    if (u.includes("api/requests")) return { ok: true, status: 200, json: async () => ({ requests: [resumableRec] }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await api.renderGatewayDebug();
  check("gw debug flags a resumable record", doc.getElementById("debug-gw-body").innerHTML.includes(api.t("debug.gw.resumable")));
}

// ============================================================ Step3-B: turn time waterfall + backlog
console.log("\n=== Step3-B: turn time waterfall + session-grouped backlog ===");
{
  const mkRec = (id, sid, tl) => ({
    id, session_id: sid, path: "/v1/chat/completions", model: "test-model",
    started_at: 1700000000 + Number(id), state: "done", stream: true,
    chunk_timeline: tl, duration_s: tl.length ? Math.max.apply(null, tl.map((e) => e.t)) : 0,
    last_chunk_type: tl.length ? tl[tl.length - 1].type : null, end_reason: "done", resumable: false,
  });
  const tlA = [
    { t: 0.001, type: "thinking", bytes: 12 }, { t: 0.02, type: "content", bytes: 8 },
    { t: 0.05, type: "usage", bytes: 6 }, { t: 0.06, type: "done", bytes: 0 },
  ];
  const tlB = [
    { t: 0.002, type: "thinking", bytes: 5 }, { t: 0.03, type: "tool_call", bytes: 9 },
    { t: 0.40, type: "tool_result", bytes: 20 }, { t: 0.42, type: "content", bytes: 4 },
    { t: 0.43, type: "done", bytes: 0 },
  ];
  const recs = [mkRec(3, "sX", tlB), mkRec(2, "sX", tlA), mkRec(1, "sY", tlA)];
  win.fetch = async (url) => {
    const u = String(url);
    if (u.includes("api/requests")) return { ok: true, status: 200, json: async () => ({ requests: recs }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };

  // computeWaterfall: phase attribution from the timeline.
  const wfA = api.computeWaterfall(recs[1]);
  const kindsA = wfA.segs.map((s) => s.kind);
  check("waterfall derives queue+think+gen+tail", ["queue", "think", "gen", "tail"].every((k) => kindsA.includes(k)), kindsA.join(","));
  const wfB = api.computeWaterfall(recs[0]);
  const kindsB = wfB.segs.map((s) => s.kind);
  check("waterfall attributes tool spans to 'tool'", kindsB.includes("tool"), kindsB.join(","));
  check("waterfall total equals the frozen duration_s", Math.abs(wfB.total - 0.43) < 1e-9, "total=" + wfB.total);
  check("waterfall is null for an empty timeline", api.computeWaterfall({ chunk_timeline: [] }) === null);

  // renderGatewayDebug paints the waterfall bar + a session-grouped backlog.
  await api.renderGatewayDebug();
  const gh = doc.getElementById("debug-gw-body").innerHTML;
  check("gw debug renders the waterfall bar (.wf)", /class="wf"/.test(gh));
  check("gw debug shows the waterfall title", gh.includes(api.t("debug.wf.title")));
  check("gw debug renders the backlog section", gh.includes(api.t("debug.wf.backlog")));
  check("gw debug groups the backlog by session (>=2 groups)", (gh.match(/wf-group__head/g) || []).length >= 2, "groups=" + (gh.match(/wf-group__head/g) || []).length);
}

// ============================================================ Step4-E: render reconciliation
console.log("\n=== Step4-E: render reconciliation (raw stream vs rendered bubble) ===");
{
  // Faithful render: the rendered text contains the raw model output (markdown stripped from both).
  const raw1 = "# Title\n\nHello **world**, this is `code` and a list:\n- a\n- b\n\nDone.";
  const ren1 = "Title\nHello world, this is code and a list: a b\nDone.";
  const v1 = api.reconcileRender(raw1, ren1);
  check("reconcile: faithful render is 'ok'", v1.status === "ok", JSON.stringify(v1));
  check("reconcile: ok keeps rawLen > 0", v1.rawLen > 0);

  // A dropped chunk at the tail is detected as a divergence.
  const raw2 = "The quick brown fox jumps over the lazy dog near the river bank.";
  const ren2 = "The quick brown fox jumps over the lazy dog";
  const v2 = api.reconcileRender(raw2, ren2);
  check("reconcile: dropped tail is 'diverged'", v2.status === "diverged", JSON.stringify(v2));
  check("reconcile: divergence reports missing length", v2.missing > 0, "missing=" + v2.missing);

  // Structured blocks (proposal/next-steps/plan) are intentionally moved out of the bubble, so a
  // raw body carrying them must still reconcile as 'ok' (they are stripped from both sides).
  const raw3 = "Here is the answer.\n```proposal\n- do X\n- do Y\n```\nAnd ```nextsteps\n1. next\n``` that's it.";
  const ren3 = "Here is the answer. And that's it.";
  const v3 = api.reconcileRender(raw3, ren3);
  check("reconcile: structured blocks stripped -> still 'ok'", v3.status === "ok", JSON.stringify(v3));

  // Empty raw => ok (nothing to reconcile).
  check("reconcile: empty raw is 'ok'", api.reconcileRender("", "anything").status === "ok");

  // normalizeForReconcile collapses markdown + whitespace symmetrically.
  const n = api.normalizeForReconcile("  A **B** `C`\n\nD  ");
  check("normalize strips markdown + collapses whitespace", n === "A B C D", JSON.stringify(n));
}

console.log("\n" + (FAILURES.length ? `FAILED (${FAILURES.length}): ${FAILURES.join(", ")}` : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
