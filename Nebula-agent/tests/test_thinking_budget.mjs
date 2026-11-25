/* 思维强度的「长度上限」必须真的发到引擎（2026-10-20）。

背景：抽屉里的「思考强度」只有 off/low/medium/high 四档 *effort*，从来没发过 *length*。引擎真正
的长度旋钮是 `reasoning_budget_tokens`（默认 0 = 不限），网关也从不转发。结果就是「高/中/低」只改
了思考*模式*、没改思考*长度*，名不副实。本次修复给 低/中/高 三档各配一个预算上限，并让网关转发；
「跟随模型」(auto) 则**两者都不发**，老老实实让引擎用默认（xhigh、不限）。

实测锁住的契约（真 index.html + 真 i18n.js + 真 app.js，打桩 fetch 驱动真流式循环）：
  1. thinkingBudget() 纯函数：低=1024 / 中=4096 / 高=32768；关闭(auto/off/乱码)=null；
  2. 选「低」→ 请求体 reasoning_effort="low" 且 reasoning_budget_tokens=1024；
  3. 选「中」→ "medium" + 4096；
  4. 选「高」→ "high"（引擎再映射到 xhigh）+ 32768；
  5. 选「关闭」→ reasoning_effort="off"，**不**带 budget（思考关了没有长度可言）；
  6. 选「跟随模型」→ 请求体**既无** reasoning_effort **也无** reasoning_budget_tokens（交给引擎）；
  7. i18n 的 out.* 文案已带长度上限，zh/en 都在。

Run: node tests/test_thinking_budget.mjs
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
win.matchMedia = () => ({ matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
win.localStorage.setItem("strata.lang", "en");

/* ── 请求体录制 + 一条健康的 SSE 流 ─────────────────────────────────────────── */
const bodies = [];          // every POST to v1/chat/completions
const enc = new TextEncoder();

function healthyStream() {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                              usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } })}\n\n`,
    "data: [DONE]\n\n",
  ].map((c) => enc.encode(c));
  let i = 0;
  return {
    ok: true, status: 200,
    body: { getReader: () => ({ read: () => (i < chunks.length
      ? Promise.resolve({ value: chunks[i++], done: false })
      : Promise.resolve({ value: undefined, done: true })) }) },
  };
}

win.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.endsWith("v1/chat/completions")) {
    bodies.push(opts.body ? JSON.parse(opts.body) : null);
    return healthyStream();
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval((fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8")) + `
;window.__api = {
  streamAssistant, thinkingBudget,
  setThinking: (v) => { settings.thinking = v; },
  getThinking: () => settings.thinking,
  newTurn: (text) => { messages = [{ role: "user", text, time: Date.now() }]; },
};`);
const api = win.__api;

async function turn(level) {
  api.setThinking(level);
  api.newTurn(`thinking ${level}`);
  await api.streamAssistant();
  return bodies[bodies.length - 1];
}

/* ═══════════ 1. thinkingBudget() 纯函数 ═══════════ */
console.log("\n=== 1: thinkingBudget() 映射 ===");
check("低 → 1024", api.thinkingBudget("low") === 1024);
check("中 → 4096", api.thinkingBudget("medium") === 4096);
check("高 → 32768", api.thinkingBudget("high") === 32768);
check("关闭 → null（无长度可言）", api.thinkingBudget("off") === null);
check("跟随模型 → null", api.thinkingBudget("auto") === null);
check("乱码 → null", api.thinkingBudget("bogus") === null);

/* ═══════════ 2-4. 低/中/高：effort + 预算同时发 ═══════════ */
console.log("\n=== 2: 低 ===");
{
  const b = await turn("low");
  check("reasoning_effort=low", b && b.reasoning_effort === "low", b && b.reasoning_effort);
  check("reasoning_budget_tokens=1024", b && b.reasoning_budget_tokens === 1024, b && String(b.reasoning_budget_tokens));
}
console.log("\n=== 3: 中 ===");
{
  const b = await turn("medium");
  check("reasoning_effort=medium", b && b.reasoning_effort === "medium", b && b.reasoning_effort);
  check("reasoning_budget_tokens=4096", b && b.reasoning_budget_tokens === 4096, b && String(b.reasoning_budget_tokens));
}
console.log("\n=== 4: 高 ===");
{
  const b = await turn("high");
  check("reasoning_effort=high（引擎再映射 xhigh）", b && b.reasoning_effort === "high", b && b.reasoning_effort);
  check("reasoning_budget_tokens=32768", b && b.reasoning_budget_tokens === 32768, b && String(b.reasoning_budget_tokens));
}

/* ═══════════ 5. 关闭：发 effort 但不发预算 ═══════════ */
console.log("\n=== 5: 关闭 ===");
{
  const b = await turn("off");
  check("reasoning_effort=off", b && b.reasoning_effort === "off", b && b.reasoning_effort);
  check("不带 reasoning_budget_tokens", b && !("reasoning_budget_tokens" in b));
}

/* ═══════════ 6. 跟随模型：两者都不发 ═══════════ */
console.log("\n=== 6: 跟随模型（auto）===");
{
  const b = await turn("auto");
  check("不带 reasoning_effort（交给引擎）", b && !("reasoning_effort" in b), b && JSON.stringify(b && b.reasoning_effort));
  check("不带 reasoning_budget_tokens（引擎默认，不限）", b && !("reasoning_budget_tokens" in b));
}

/* ═══════════ 7. i18n 文案 ═══════════ */
console.log("\n=== 7: i18n 文案 ===");
{
  const dict = win.i18n._dict;
  for (const k of ["drawer.thinking.out.low", "drawer.thinking.out.medium",
                   "drawer.thinking.out.high", "drawer.thinking.out.auto.free"])
    check(`zh+en 都有 ${k}`, !!dict.zh[k] && !!dict.en[k]);
  check("中 文案带 4K 上限", String(dict.zh["drawer.thinking.out.medium"]).includes("4K"));
  check("高 文案带 32K 上限", String(dict.zh["drawer.thinking.out.high"]).includes("32K"));
  check("跟随模型 文案说明不限", String(dict.zh["drawer.thinking.out.auto.free"]).includes("不限"));
}

console.log("");
if (FAILURES.length) {
  console.log(`FAILED (${FAILURES.length}): ` + FAILURES.join(" | "));
  process.exit(1);
}
console.log("THINKING-BUDGET: ALL GREEN");
process.exit(0);   // streamAssistant leaves a live-clock interval on the event loop; exit explicitly
