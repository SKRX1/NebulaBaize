/* Regression test for the streaming-conversation upgrades (A + B batches).
 *
 * Boots the REAL index.html + i18n.js + app.js in jsdom, then drives a chat stream that
 * mixes reasoning, content, two MCP tool calls, a usage block, and a mid-stream error.
 * Asserts the behaviours added/changed in the A/B work:
 *
 *   A2  thinking time chip appears in the per-turn stats footer
 *   A3  a mid-stream error does NOT wipe already-rendered content — the partial answer
 *       and the tool calls stay on screen, with the error appended as a banner
 *   B4  a tool that finishes is collapsed; a tool that is still running (call, no result)
 *       is auto-expanded
 *   B5  the per-turn stats footer shows the tool-round progress ("Round 2")
 *
 * Run: node tests/test_stream_features.mjs
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
win.matchMedia = () => ({ matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") {
  win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
}
if (typeof win.cancelAnimationFrame !== "function") {
  win.cancelAnimationFrame = (id) => clearTimeout(id);
}
// Force English so string assertions stay stable.
win.localStorage.setItem("strata.lang", "en");

// --- fetch mock: health + mcp + a chat SSE stream that mixes everything ---
const calls = [];
const enc = new TextEncoder();
function streamResponse(chunks) {
  let i = 0;
  return {
    ok: true, status: 200, json: async () => ({}),
    body: { getReader() { return { read() {
      if (i < chunks.length) return Promise.resolve({ value: enc.encode(chunks[i++]), done: false });
      return Promise.resolve({ value: undefined, done: true });
    } }; } },
  };
}
win.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
  if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model", max_context: 32768 }) };
  if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
  if (u.endsWith("v1/chat/completions")) {
    return streamResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Let me think about this." } }] })}\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Here is " } }] })}\n`,
      `data: ${JSON.stringify({ strata_mcp: { event: "call", id: "t1", name: "fs", server: "filesystem", tool: "read", arguments: { path: "a.txt" }, round: 1 } })}\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "the answer." } }] })}\n`,
      `data: ${JSON.stringify({ strata_mcp: { event: "result", id: "t1", ok: true, text: "file contents", chars: 13, ms: 42 } })}\n`,
      `data: ${JSON.stringify({ strata_mcp: { event: "call", id: "t2", name: "shell", server: "shell", tool: "run", arguments: { cmd: "ls" }, round: 2 } })}\n`,
      `data: ${JSON.stringify({ usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 100 } } })}\n`,
      `data: ${JSON.stringify({ error: { message: "engine blew up mid-stream" } })}\n`,
    ]);
  }
  return { ok: true, status: 200, json: async () => ({}) };
};
win.confirm = () => true;

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  console.log("=== streaming upgrades (A+B) regression ===");
  await sleep(60);                       // let boot (loadHealth/loadMcp) settle

  const input = doc.getElementById("input");
  check("input present", !!input);
  input.value = "Do the thing.";
  const sendBtn = doc.getElementById("send-btn");
  let threw = null;
  try { if (sendBtn) sendBtn.click(); } catch (e) { threw = e; }
  check("send did not throw synchronously", threw === null, threw ? String(threw) : "");

  await sleep(150);                      // let the (mocked) stream finish + finalize

  // messages: index 0 = the user prompt we sent, index 1 = the assistant reply
  const msgs = doc.querySelectorAll("#chat .st-msg");
  check("two messages rendered (user + assistant)", msgs.length === 2, `len=${msgs.length}`);
  const asm = msgs.length ? doc.querySelector('#chat .st-msg[data-i="1"]') : null;
  check("assistant message present", !!asm);
  const bubble = asm ? asm.querySelector(".st-bubble") : null;
  check("bubble present", !!bubble);

  console.log("\n=== A3: error must NOT wipe rendered content ===");
  const bubbleText = bubble ? bubble.textContent : "";
  // streamed text and tool blocks are interleaved inside the bubble, so assert both halves
  check("partial answer text preserved", /Here is/.test(bubbleText) && /the answer\./.test(bubbleText), JSON.stringify(bubbleText.slice(0, 80)));
  // the thought block is lazy-rendered only when expanded; open it to verify the reasoning survived
  const think = asm ? asm.querySelector("details.st-think") : null;
  if (think && !think.open) { think.open = true; think.dispatchEvent(new win.Event("toggle", { bubbles: true })); }
  const thinking = asm ? asm.querySelector(".thinking") : null;
  check("reasoning preserved", !!thinking && /Let me think about this\./.test(thinking.textContent),
    thinking ? JSON.stringify(thinking.textContent.slice(0, 40)) : "no .thinking");
  // the finished tool is collapsed, so only its summary (name + server) is in the DOM, not its args
  check("tool call rendered", /read/.test(bubbleText) && /filesystem/.test(bubbleText));
  const errBanner = bubble ? bubble.querySelector(".msg-error") : null;
  check("error appended as banner (not replacing content)", !!errBanner && /engine blew up/.test(errBanner.textContent));

  console.log("\n=== B4: tool auto expand/collapse ===");
  const t1 = doc.querySelector('.tool-call[data-state="done"]');
  check("finished tool present", !!t1);
  check("finished tool is collapsed", !!t1 && !t1.hasAttribute("open"));
  const t2 = doc.querySelector('.tool-call[data-state="skipped"]');
  check("running (no-result) tool present", !!t2, t2 ? `state=${t2.getAttribute("data-state")}` : "missing");
  check("running tool is auto-expanded", !!t2 && t2.hasAttribute("open"));

  console.log("\n=== A2 + B5: per-turn stats footer ===");
  const stats = msgs.length ? msgs[msgs.length - 1].querySelector(".msg-stats") : null;
  check("stats footer present", !!stats);
  const statsText = stats ? stats.textContent : "";
  check("duration chip present", /s$|second|秒/.test(statsText) || /\d+:\d\d/.test(statsText));
  check("thinking-time chip present (A2)", /Think/.test(statsText), JSON.stringify(statsText));
  check("tool-round chip present (B5)", /Round 2/.test(statsText), JSON.stringify(statsText));

  console.log("\n=== busy released ===");
  check("send button re-enabled after stream", sendBtn && sendBtn.disabled === false,
    sendBtn ? `disabled=${sendBtn.disabled}` : "no send-btn");

  console.log();
  if (FAILURES.length) {
    console.log(`FAILED (${FAILURES.length}):`);
    for (const f of FAILURES) console.log("  - " + f);
    process.exit(1);
  }
  console.log("STREAM FEATURES: ALL PASSED");
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
