/* Regression test for the per-turn stats footer (底部统计条).
 *
 * Bug this pins: a turn that DIED mid-flight (upstream 400 / stop) lost its whole footer — the
 * duration, thinking time and round chips vanished, so the run looked like it had never happened.
 * Cause: `m.stats` was only built `if (n != null)` (n = usage.completion_tokens), and an errored
 * turn never receives a usage chunk. Second cause: multi-round agent turns kept only the LAST
 * usage chunk, so the "prompt → generated" figure reported one round instead of the turn total.
 *
 * Boots the REAL app.js + i18n.js in jsdom and drives streamAssistant() against a fake SSE upstream.
 * Run: node tests/test_turn_stats.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..", "serve", "web");

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

// The SSE body of the NEXT chat/completions call. Each entry is one `data:` payload line.
let STREAM = [];
const encoder = new TextEncoder();
const sseResp = (lines) => {
  let i = 0;
  return {
    ok: true, status: 200,
    headers: { get: () => "text/event-stream" },
    body: {
      getReader: () => ({
        read: async () => (i < lines.length
          ? { done: false, value: encoder.encode(lines[i++] + "\n") }
          : { done: true, value: undefined }),
      }),
    },
  };
};

win.fetch = async (url) => {
  const u = String(url);
  if (u.includes("chat/completions")) return sseResp(STREAM);
  if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model", max_context: 32768 }) };
  if (u.includes("metrics")) return { ok: true, status: 200, json: async () => ({ engine: { max_context: 32768 } }) };
  if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
  if (u.includes("models")) return { ok: true, status: 200, json: async () => ({ models: [], ok: true }) };
  return { ok: true, status: 200, json: async () => ({}) };
};

let appCode = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
appCode += `
;window.__api = {
  run: (prompt) => { messages.length = 0; messages.push({role:'user', text: prompt}); return streamAssistant(); },
  last: () => messages[messages.length - 1],
  statsFooter: () => { const all = document.querySelectorAll('.msg-stats'); return all.length ? all[all.length - 1] : null; },
  setMaxCtx: (n) => { maxCtx = n; },
  renderStats, msgEl,
};`;
win.eval(appCode);
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
const api = win.__api;

// ── 1) a failed turn must STILL keep its footer (the reported bug) ─────────────
console.log("\n=== 1: upstream error mid-turn keeps the stats footer ===");
{
  STREAM = [
    'data: {"choices":[{"delta":{"content":"开始写入…"}}]}',
    'data: {"error":{"message":"upstream error: HTTP Error 400: Bad Request"}}',
    "data: [DONE]",
  ];
  await api.run("改一下 buildMenu");
  const m = api.last();
  check("the turn is marked failed", !!m.error, m.error || "(no error)");
  check("stats were still recorded", !!m.stats, JSON.stringify(m.stats || null));
  const st = m.stats || {};
  check("duration is known", st.dur != null && st.dur >= 0, String(st.dur));
  check("no usage arrived -> completion is null", st.completion == null, String(st.completion));
  check("stats flagged as partial", st.partial === true, String(st.partial));
  const box = api.statsFooter();
  check("the footer is VISIBLE (was hidden before the fix)", !!box && box.hidden === false,
    box ? `hidden=${box.hidden}` : "no .msg-stats");
  check("the footer shows the duration", !!box && /秒|s\b|:/.test(box.textContent), box && box.textContent.trim());
  check("it says usage was not reported", !!box && /no usage reported/.test(box.textContent), box && box.textContent.trim());
  check("no bogus context chip", !!box && !/%/.test(box.textContent), box && box.textContent.trim());
}

// ── 2) a multi-round turn sums every round's completion tokens ────────────────
console.log("\n=== 2: multi-round turn reports the turn total, not the last round ===");
{
  STREAM = [
    'data: {"choices":[{"delta":{"content":"第一段"}}]}',
    'data: {"usage":{"prompt_tokens":5000,"completion_tokens":40,"completion_tokens_details":{"reasoning_tokens":10}}}',
    'data: {"choices":[{"delta":{"content":"第二段"}}]}',
    'data: {"usage":{"prompt_tokens":5200,"completion_tokens":60,"completion_tokens_details":{"reasoning_tokens":20}}}',
    "data: [DONE]",
  ];
  await api.run("继续做");
  const m = api.last();
  const st = m.stats || {};
  check("no error", !m.error, m.error || "");
  check("completion sums both rounds (40+60)", st.completion === 100, String(st.completion));
  check("reasoning tokens sum both rounds (10+20)", st.reasoningTokens === 30, String(st.reasoningTokens));
  check("prompt reflects the newest round", st.prompt === 5200, String(st.prompt));
  check("not flagged partial", st.partial === false, String(st.partial));
  const box = api.statsFooter();
  check("token chip shows the accumulated pair", !!box && /5\.2k\s*→\s*100/.test(box.textContent), box && box.textContent.trim());
}

// ── 3) renderStats tolerates ctxUsed=null (no NaN%) ───────────────────────────
console.log("\n=== 3: a stats row with an unknown context usage renders no ctx chip ===");
{
  const m = { role: "assistant", text: "x", time: Date.now(),
    stats: { dur: 12, prompt: null, completion: null, ctxUsed: null, ctxMax: 32768, partial: true, thinkSecs: 3.2 } };
  const el = api.msgEl(m, 0);
  doc.getElementById("chat").appendChild(el);
  api.renderStats(el, m, false);
  const box = el.querySelector(".msg-stats");
  check("footer visible", !!box && box.hidden === false);
  check("no NaN / % chip", !!box && !/NaN|%/.test(box.textContent), box && box.textContent.trim());
  check("thinking time still shown", !!box && /3\.2/.test(box.textContent), box && box.textContent.trim());
  el.remove();
}

console.log("");
if (FAILURES.length) {
  console.log("TURN STATS: " + FAILURES.length + " FAILED");
  FAILURES.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("TURN STATS: ALL PASSED");
process.exit(0);   // jsdom keeps the app's polling timers alive; end the run explicitly
