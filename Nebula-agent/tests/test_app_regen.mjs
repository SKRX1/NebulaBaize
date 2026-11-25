/* Regression test for the "regenerate" (重生成) button bug.
 *
 * Root cause (2026-10-17): doRegenerate() did `messages = messages.slice(0, i)` then
 * `messages.pop()`. That deleted the USER message (the one at i-1), not the assistant
 * being regenerated, so `userText(messages[userIdx])` read `undefined` and threw a
 * TypeError. Because `busy` / setBusy(true) had already run, the throw left the UI
 * stuck/disabled (looked blank) and send() was never reached — the backend/model got
 * no request either.
 *
 * The test loads the REAL index.html + i18n.js + app.js in jsdom, seeds a 2-message
 * conversation, clicks regenerate on the assistant turn, and asserts:
 *   1. doRegenerate does not throw synchronously.
 *   2. exactly one POST to v1/chat/completions happens.
 *   3. the request payload contains the user prompt exactly once (no duplicate, no missing).
 *   4. after the stream finishes, busy is cleared (send button re-enabled).
 *   5. the regenerated assistant reply is rendered into #chat.
 *
 * Run: node tests/test_app_regen.mjs
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

// The full document so every $("id") app.js touches actually exists.
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");

const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window;
const doc = win.document;

// --- globals app.js touches during a stream (jsdom doesn't always provide them) ---
win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
// jsdom lacks matchMedia; the app uses it for the dark-mode listener.
win.matchMedia = () => ({ matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") {
  win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
}
if (typeof win.cancelAnimationFrame !== "function") {
  win.cancelAnimationFrame = (id) => clearTimeout(id);
}

// Force English so any string assertions stay stable.
win.localStorage.setItem("strata.lang", "en");

// Seed a 2-message conversation: a user prompt and its assistant reply, then regenerate the reply.
const seeded = [
  { role: "user", text: "What is 2+2?", time: 1 },
  { role: "assistant", text: "The answer is 4.", time: 2 },
];
win.localStorage.setItem("strata.chat", JSON.stringify(seeded));

// --- fetch mock: capture the chat request, answer with a tiny SSE stream ---
const calls = [];
function streamResponse(chunks) {
  let i = 0;
  const enc = new TextEncoder();
  return {
    ok: true, status: 200, json: async () => ({}),
    body: {
      getReader() {
        return {
          read() {
            if (i < chunks.length) return Promise.resolve({ value: enc.encode(chunks[i++]), done: false });
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    },
  };
}
win.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method || "GET";
  calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : null });
  if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model" }) };
  if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
  if (u.endsWith("v1/chat/completions")) {
    return streamResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Regenerated answer." } }] })}\n`,
      "data: [DONE]\n",
    ]);
  }
  return { ok: true, status: 200, json: async () => ({}) };
};
win.confirm = () => true;

// i18n first (app.js binds window.i18n), then the app.
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  console.log("=== regenerate (重生成) regression ===");

  // give the app boot (loadHealth/loadMcp) a moment
  await sleep(30);

  // The seeded conversation is rendered; click the regenerate button on the assistant
  // reply (index 1) — this drives the REAL click handler → doRegenerate(), exactly as a user does.
  const regenBtn = doc.querySelector('#chat .st-msg[data-i="1"] [data-action="regen"]');
  check("regenerate button present on assistant message", !!regenBtn);

  let threw = null;
  try {
    if (regenBtn) regenBtn.click();
  } catch (e) {
    threw = e;
  }
  // Note: a throw inside a jsdom event listener is reported on the virtual console rather than
  // propagated here, so the authoritative signal is the request count below (the old bug threw
  // before send(), so 0 chat requests; the fix issues exactly 1).
  check("click handler did not throw synchronously", threw === null, threw ? String(threw) : "");

  // let the (mocked) stream finish and finalize
  await sleep(80);

  const chatCalls = calls.filter((c) => c.url.endsWith("v1/chat/completions"));
  check("exactly one chat completion request", chatCalls.length === 1, `got ${chatCalls.length}`);
  if (chatCalls.length === 1) {
    const sent = chatCalls[0].body.messages;
    const users = sent.filter((m) => m.role === "user");
    const assistantsInHistory = sent.filter((m) => m.role === "assistant");
    check("payload carries the user prompt", users.length === 1 && users[0].content === "What is 2+2?",
      JSON.stringify(users.map((m) => m.content)));
    check("payload has no stray/duplicate assistant entry", assistantsInHistory.length === 0,
      `assistants=${assistantsInHistory.length}`);
    // System prompts (BASE_SYSTEM / persona / workspace / RAG) are injected by design, so the
    // honest assertion is that no *conversation* history survives: exactly one non-system
    // message, the user prompt. (An older `sent.length === 1` predates system-prompt injection.)
    check("payload has exactly one non-system message (the user prompt)",
      sent.filter((m) => m.role !== "system").length === 1,
      `roles=${JSON.stringify(sent.map((m) => m.role))}`);
  }

  // busy must be cleared so the UI is usable again
  const sendBtn = doc.getElementById("send-btn");
  check("send button re-enabled after stream", sendBtn && sendBtn.disabled === false,
    sendBtn ? `disabled=${sendBtn.disabled}` : "no send-btn");

  // the regenerated reply must be rendered into the chat
  const msgs = doc.querySelectorAll("#chat .st-msg");
  check("chat shows 2 messages (user + regenerated assistant)", msgs.length === 2, `len=${msgs.length}`);
  const lastText = msgs.length ? msgs[msgs.length - 1].textContent : "";
  check("regenerated reply rendered", /Regenerated answer\./.test(lastText), JSON.stringify(lastText.slice(0, 40)));

  console.log();
  if (FAILURES.length) {
    console.log(`FAILED (${FAILURES.length}):`);
    for (const f of FAILURES) console.log("  - " + f);
    process.exit(1);
  }
  console.log("REGEN: ALL PASSED");
  // jsdom keeps timers/handles alive, so without an explicit teardown the process prints
  // the summary and then hangs forever (it has to be killed). Match test_stream_intel.mjs.
  win.close();
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
