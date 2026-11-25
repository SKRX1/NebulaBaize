/* Regression test for "the connection dropped mid-turn" vs "the request failed" (2026-10-20).

Why this file exists: a real session died at round 12 / 8m14s with a red "network error" banner
and simply STOPPED -- the task was half done, 12 tool calls in, and the user had to notice and
press Continue by hand. Forensics (logs/interrupt-log.jsonl + logs/turn.jsonl) showed the gateway
had recorded the very same moment as `ending: client_gone`, i.e. its write to the browser failed:
the TCP link was reset, NOT the turn. The gateway survived (same PID before and after).

The frontend, however, funnelled the browser's `TypeError: network error` from reader.read() into
`m.error` -- the FATAL bucket. Two recovery paths then refused to act, by design:

    markTruncatedIfCut(): if (sawDone || !m || m.error || ...) return false;   // never marked
    maybeAutoResume():    if (m.stopped || m.error) return false;             // never resumed

so a pure transport hiccup parked a red banner on a half-finished task. A dropped CONNECTION is
not a failed REQUEST; it is exactly the `truncated` case both functions were built for.

Contract (boots the REAL index.html + i18n.js + app.js and drives the REAL streaming loop):
  transport cut    reader.read() rejects with TypeError -> m.error stays EMPTY, m.truncated set,
                   m.cutError keeps the raw text, the answered text survives, the orphaned server
                   turn is cancelled, and auto-resume arms itself.
  per-engine text  Chrome "network error", Firefox "NetworkError when attempting to fetch
                   resource.", Safari "Load failed", and a plain Error mentioning "connection
                   reset" all classify as transport.
  no progress      a transport failure before ANY output has nothing to continue -> reported as a
                   real error (no truncated, no auto-resume) instead of retrying forever.
  real error       an upstream `{"error":{...}}` chunk stays FATAL: no truncation, no resume.
  abort            a human Stop stays `stopped`: not an error, not a truncation.
  healthy          a normal `[DONE]` turn is untouched by any of this.
  log              the interruption record is `kind: truncated` AND still carries the raw
                   transport text in `error` -- classification without losing the evidence.

Run: node tests/test_conn_cut_resume.mjs
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

const enc = new TextEncoder();
const stops = [];            // POST api/chat/stop  (the orphaned server turn)
const ilog = [];             // POST api/interrupt-log
let CANDED = [];             // chunks to emit before the failure
let CUT_ERR = null;          // what reader.read() rejects with once the chunks run out
let CUT_AFTER = Infinity;    // how many chunks to emit first

function cutResponse() {
  const bufs = CANDED.map((c) => enc.encode(c));
  let i = 0;
  return {
    ok: true, status: 200,
    body: {
      getReader() {
        return {
          read() {
            if (i < bufs.length && i < CUT_AFTER) return Promise.resolve({ value: bufs[i++], done: false });
            if (CUT_ERR) return Promise.reject(CUT_ERR);
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    },
  };
}

win.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.endsWith("v1/chat/completions")) return cutResponse();
  if (u.endsWith("api/chat/stop")) {
    stops.push(opts.body ? JSON.parse(opts.body) : null);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  if (u.includes("api/interrupt-log")) {
    ilog.push(opts.body ? JSON.parse(opts.body).entry : null);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const appCode = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(appCode + `
;window.__api = {
  streamAssistant, maybeAutoResume, syncBanners, isTransportError, noticeText,
  updateAssistant, spySend: () => { window.__sendCalls = 0; send = function () { window.__sendCalls++; }; },
  seed: (text) => { messages = [{role: "user", text}]; },
  last: () => messages[messages.length - 1],
  quiet: () => { settings.autoresume = false; settings.autosteps = false;
                 settings.autolearn = false; settings.autoMemory = false;
                 settings.autocompact = false; settings.recall = false; },
  allowResume: (v) => { settings.autoresume = v; },
  getPendingResume: () => pendingResume,
  clearPendingResume: () => { if (pendingResume) clearTimeout(pendingResume.timer); pendingResume = null; },
  resetChain: () => { autoResumeChain = 0; },
  typeError: (msg) => new TypeError(msg),
};`);
const api = win.__api;
api.quiet();

// Run one turn that emits `chunks` (up to `after`), then fails with `err` (null = clean stop).
async function turn(chunks, err = null, after = Infinity) {
  CANDED = chunks; CUT_ERR = err; CUT_AFTER = after;
  stops.length = 0; ilog.length = 0;
  api.seed("keep working on the game");
  await api.streamAssistant();
  return api.last();
}
const NET_ERR = () => api.typeError("network error");

console.log("CONNECTION CUT vs REQUEST FAILURE:");

// C1: the reported bug -- link reset mid-turn with real progress made
{
  const m = await turn([
    'data: {"choices":[{"delta":{"reasoning_content":"planning the next chunk..."}}]}\n\n',
    'data: {"strata_mcp":{"event":"tool","id":"t1","name":"filesystem__write"}}\n\n',
    'data: {"choices":[{"delta":{"content":"wrote chunk c09"}}]}\n\n',
  ], NET_ERR());
  check("cut with progress -> m.error stays empty", !m.error, JSON.stringify(m.error));
  check("cut with progress -> marked truncated", m.truncated === true);
  check("cut with progress -> raw text kept in cutError", m.cutError === "network error", JSON.stringify(m.cutError));
  check("cut with progress -> answered text preserved", m.text === "wrote chunk c09", JSON.stringify(m.text));
  check("cut with progress -> thinking preserved", (m.reasoning || "").length > 0);
  check("cut with progress -> orphaned server turn cancelled", stops.length === 1, JSON.stringify(stops));

  api.allowResume(true);
  check("cut with progress -> auto-resume arms", api.maybeAutoResume(m) === true);
  api.clearPendingResume();
  api.allowResume(false);

  const bubble = win.document.createElement("div");
  api.syncBanners(bubble, m);
  check("cut with progress -> banner says it was cut, not failed",
        !!bubble.querySelector(".msg-notice") && !bubble.querySelector(".msg-error"));
}

// C2: the same interruption is logged as `truncated` yet keeps the raw reason
{
  const rec = ilog[ilog.length - 1];
  check("log -> kind is truncated", rec && rec.kind === "truncated", rec ? rec.kind : "no record");
  check("log -> raw transport text retained", rec && rec.error === "network error", rec ? rec.error : "no record");
  check("log -> not reported as a fatal error", rec && rec.truncated === true && rec.stopped === false);
}

// C3: nothing produced yet -> that really is a failed request, not something to resume
{
  const m = await turn([], NET_ERR(), 0);
  check("no progress -> reported as error", m.error === "network error", JSON.stringify(m.error));
  check("no progress -> not truncated", !m.truncated);
  api.allowResume(true);
  check("no progress -> no auto-resume", api.maybeAutoResume(m) === false);
  api.allowResume(false);
  api.clearPendingResume();
}

// C4: an upstream error chunk stays FATAL even after progress (retrying would repeat it)
{
  const m = await turn([
    'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
    'data: {"error":{"message":"upstream error: context window exceeded"}}\n\n',
  ]);
  check("upstream error -> fatal, not truncated", m.error && !m.truncated, JSON.stringify(m.error));
  api.allowResume(true);
  check("upstream error -> no auto-resume", api.maybeAutoResume(m) === false);
  api.allowResume(false);
  api.clearPendingResume();
}

// C5: a human Stop is neither an error nor a truncation
{
  const abort = new win.DOMException("Aborted", "AbortError");
  const m = await turn(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n'], abort);
  check("abort -> stopped only", m.stopped === true && !m.error && !m.truncated,
        `stopped=${m.stopped} error=${m.error} truncated=${m.truncated}`);
}

// C6: every engine spells the same failure differently -- all must classify as transport
{
  const cases = [
    ["Chrome body-stream", api.typeError("network error")],
    ["Firefox", api.typeError("NetworkError when attempting to fetch resource.")],
    ["Safari", api.typeError("Load failed")],
    ["plain Error / proxy reset", new win.Error("read ECONNRESET")],
    ["plain Error / window reset", new win.Error("net::ERR_CONNECTION_RESET")],
  ];
  for (const [label, err] of cases) {
    check(`${label} -> transport`, api.isTransportError(err) === true);
  }
  check("a 4xx-style message is not transport",
        api.isTransportError(new win.Error("HTTP 401")) === false);
  check("an upstream error message is not transport",
        api.isTransportError(new win.Error("upstream error: boom")) === false);
}

// C7: a healthy turn is untouched
{
  const m = await turn([
    'data: {"choices":[{"delta":{"content":"all done"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  check("healthy turn -> clean, no cutError", !m.truncated && !m.error && !m.cutError);
  check("healthy turn -> no orphan cancel", stops.length === 0);
  check("healthy turn -> content intact", m.text === "all done", JSON.stringify(m.text));
}

// C8: the Continue button is the user's way to pick a CUT turn back up. After the watchdog
// brings 8099 back, the gate (app.js updateAssistant) must SHOW it for a truncated turn and
// keep it hidden for a clean one (differential -> the gate is load-bearing on m.truncated, not
// always-on); clicking it must hand the task to send() (the resume path).
{
  const el = win.document.createElement("div");
  el.className = "st-msg st-msg--assistant";
  el.innerHTML = `<div class="st-bubble"></div><div class="next-steps" hidden></div>` +
    `<div class="proposals" hidden></div><div class="st-msg__meta"><span class="meta-text"></span>` +
    `<span class="msg-stats" hidden></span>` +
    `<button class="st-btn continue-btn" data-action="continue" hidden>CONTINUE</button>` +
    `<button class="st-btn msg-fold" data-action="fold" hidden></button>` +
    `<button class="st-btn st-btn--icon" data-msg-copy>copy</button>` +
    `<button class="st-btn st-btn--icon" data-action="regen">regen</button></div>`;
  (win.document.getElementById("chat") || win.document.body).appendChild(el);   // the click delegate lives on #chat
  const mk = (m) => { api.updateAssistant(el, m, false); return el.querySelector(".continue-btn"); };
  const cutBtn = mk({ role: "assistant", text: "half an answer", truncated: true, tools: [], meta: "" });
  check("C8 cut turn -> the Continue button is shown", cutBtn && cutBtn.hidden === false);
  const cleanBtn = mk({ role: "assistant", text: "all done", tools: [], meta: "" });
  check("C8 clean turn -> the Continue button stays hidden (gate keys on m.truncated)", cleanBtn && cleanBtn.hidden === true);
  mk({ role: "assistant", text: "half an answer", truncated: true, tools: [], meta: "" });
  api.spySend();
  el.querySelector(".continue-btn").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  check("C8 click Continue -> resumes the task via send()", win.__sendCalls === 1, "sendCalls=" + win.__sendCalls);
  el.remove();
}

console.log("");
api.clearPendingResume();
if (FAILURES.length) {
  console.log("CONN-CUT-RESUME: " + FAILURES.length + " FAILED");
  for (const f of FAILURES) console.log("  - " + f);
  process.exit(1);
} else {
  console.log("CONN-CUT-RESUME: ALL PASSED");
  process.exit(0);   // boot wires a setInterval; exit cleanly so the suite never hangs
}
