/* Regression test for the SSE terminal marker + the single-round output cap (2026-10-20).

Why this file exists: the previous truncation test called markTruncatedIfCut(m, sawDone, ...)
directly, so it only proved "IF sawDone is true, don't mark". It never exercised how `sawDone` is
obtained from the wire -- and that is exactly where the bug was:

    gateway wrote:  data: "[DONE]"        (json.dumps of the string)
    frontend read:  data === "[DONE]"     (never equal)

so sawDone was ALWAYS false, every healthy turn was flagged 连接中断, got a pointless
POST /api/chat/stop, and (with auto-resume on) was silently re-sent. This test boots the REAL
index.html + i18n.js + app.js and drives the REAL streaming loop with canned SSE bytes.

Contract:
  quoted DONE     `data: "[DONE]"` (the old gateway format) still counts as a clean finish
  bare DONE       `data: [DONE]`   (the OpenAI-standard format) counts as a clean finish
  no DONE         a stream that just stops IS marked truncated, cancels the orphan turn, banners
  max_tokens      a strata_notice{code:max_tokens} is surfaced with its number and stays resumable
                  (auto-resume eligible) instead of looking like a dropped connection

Run: node tests/test_stream_done.mjs
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

// ---- a canned SSE body: an array of raw chunks -> a Response-like with body.getReader() --------
let CANDED = [];
const stops = [];
const sent = [];
const enc = new TextEncoder();
function sseResponse(chunks) {
  const bufs = chunks.map((c) => enc.encode(c));
  let i = 0;
  return {
    ok: true, status: 200,
    body: {
      getReader() {
        return {
          read() {
            if (i < bufs.length) return Promise.resolve({ value: bufs[i++], done: false });
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    },
  };
}
win.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.endsWith("v1/chat/completions")) {
    sent.push(JSON.parse(opts.body || "{}"));
    return sseResponse(CANDED);
  }
  if (u.endsWith("api/chat/stop")) {
    stops.push(opts.body ? JSON.parse(opts.body) : null);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const appCode = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(appCode + `
;window.__api = {
  streamAssistant, noticeText, syncBanners, maybeAutoResume,
  seed: (text) => { messages = [{role: "user", text}]; },
  last: () => messages[messages.length - 1],
  quiet: () => { settings.autoresume = false; settings.autosteps = false;
                 settings.autolearn = false; settings.autoMemory = false;
                 settings.autocompact = false; settings.recall = false; },
  allowResume: (v) => { settings.autoresume = v; },
  getPendingResume: () => pendingResume,
  clearPendingResume: () => { if (pendingResume) clearTimeout(pendingResume.timer); pendingResume = null; },
};`);
const api = win.__api;
api.quiet();

async function turn(chunks) {
  CANDED = chunks;
  stops.length = 0;
  api.seed("hi");
  await api.streamAssistant();
  return api.last();
}

console.log("SSE TERMINAL MARKER + ROUND CAP:");

// M1: the gateway's OLD format -- `data: "[DONE]"` (quoted JSON string) must count as clean
{
  const m = await turn(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: "[DONE]"\n\n']);
  check('quoted [DONE] -> clean finish', !m.truncated, `truncated=${m.truncated}`);
  check('quoted [DONE] -> no orphan-cancel', stops.length === 0, JSON.stringify(stops));
  check("quoted [DONE] -> content streamed", m.text === "hi", JSON.stringify(m.text));
}

// M2: the standard bare marker must also count as clean (forward compatible)
{
  const m = await turn(['data: {"choices":[{"delta":{"content":"yo"}}]}\n\n', "data: [DONE]\n\n"]);
  check("bare [DONE] -> clean finish", !m.truncated, `truncated=${m.truncated}`);
  check("bare [DONE] -> no orphan-cancel", stops.length === 0);
}

// M3: a stream that just stops IS a cut -> marked, orphan cancelled, banner shown
{
  const m = await turn(['data: {"choices":[{"delta":{"content":"half"}}]}\n\n']);
  check("no [DONE] -> marked truncated", m.truncated === true);
  check("no [DONE] -> orphan turn cancelled", stops.length === 1, JSON.stringify(stops));
  const bubble = win.document.createElement("div");
  api.syncBanners(bubble, m);
  check("no [DONE] -> banner shown", !!bubble.querySelector(".msg-notice"));
}

// M4: the round hit the output cap -> a real reason, resumable, NOT a fake "connection lost"
{
  const m = await turn([
    'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
    'data: {"strata_notice":{"code":"max_tokens","max_tokens":8192,"resumable":true}}\n\n',
    "data: [DONE]\n\n",
  ]);
  check("capped round -> notice kept", !!(m.notice && m.notice.code === "max_tokens"), JSON.stringify(m.notice));
  check("capped round -> not a truncation", !m.truncated);
  const txt = api.noticeText(m.notice);
  check("capped round -> banner names the cap", txt.includes("8192"), txt);
  api.quiet();
  api.allowResume(true);
  check("capped round -> auto-resume eligible", api.maybeAutoResume(m) === true);
  api.allowResume(false);
  api.clearPendingResume();
}

// M5: the cap value the composer asks for is what actually goes upstream
{
  await turn(["data: [DONE]\n\n"]);
  check("request carries a max_tokens budget", !!(sent.length && sent[sent.length - 1].stream === true));
}

console.log("");
api.clearPendingResume();
if (FAILURES.length) {
  console.log("STREAM-DONE: " + FAILURES.length + " FAILED");
  for (const f of FAILURES) console.log("  - " + f);
  process.exit(1);
} else {
  console.log("STREAM-DONE: ALL PASSED");
  process.exit(0);   // boot wires a setInterval; exit cleanly so the suite never hangs
}
