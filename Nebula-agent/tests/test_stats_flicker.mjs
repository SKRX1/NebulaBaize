/* Regression test for the "badges flicker while streaming" bug.
 *
 * Bug this pins: the per-turn stats footer (底部统计条：时长 / 思考 / tokens / 上下文 / 轮次) visibly
 * flickered during streaming. Cause: `renderStats` re-wrote `box.innerHTML` on EVERY call, and it is
 * called from `paint()` on every animation frame (~60x/s while tokens stream). Each call tore down and
 * re-inserted every chip + icon SVG, so the row flashed.
 *
 * The fix builds the live row ONCE and afterwards mutates only text nodes; the final row is written once
 * and cached by a signature. The sharpest way to pin that is identity: the same `<span class="stat--dur">`
 * (and the clock icon inside it) must survive many repaints. The OLD code failed this because it rebuilt.
 *
 * Boots the REAL app.js + i18n.js in jsdom; drives renderStats directly (no stream needed).
 * Run: node tests/test_stats_flicker.mjs
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
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

let appCode = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
appCode += `\n;window.__api = { renderStats, msgEl };`;
win.eval(appCode);
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
const api = win.__api;

// ── 1) streaming: many repaints, the footer DOM must stay put ────────────────
console.log("\n=== 1: live footer keeps its DOM nodes across ticks (no flicker) ===");
{
  const m = { role: "assistant", text: "", reasoning: "思考中", time: Date.now(), startAt: win.performance.now() - 1400 };
  const el = api.msgEl(m, 0);
  doc.getElementById("chat").appendChild(el);
  api.renderStats(el, m, true);

  const box = el.querySelector(".msg-stats");
  check("footer visible while streaming", !!box && box.hidden === false, box ? `hidden=${box.hidden}` : "no .msg-stats");
  check("marked as live mode", !!box && box.dataset.mode === "live", box && box.dataset.mode);

  const durNode = box.querySelector(".stat--dur");
  const svgNode = box.querySelector(".stat--dur .st-icon");
  const liveNode = box.querySelector(".stat--live");
  const vNode = box.querySelector(".stat--dur .stat__v");
  check("duration chip exists", !!durNode);
  check("clock icon rendered inside it", !!svgNode);
  check("duration text present", !!vNode && /\d/.test(vNode.textContent || ""), vNode && vNode.textContent);

  const t0 = vNode ? vNode.textContent : "";
  // mimic ~1s of animation-frame repaints with an advancing clock
  for (let i = 1; i <= 8; i++) {
    m.startAt = win.performance.now() - (1400 + i * 700);
    api.renderStats(el, m, true);
  }

  check("duration chip is the SAME node (not rebuilt)", box.querySelector(".stat--dur") === durNode);
  check("clock icon is the SAME node (not re-inserted)", box.querySelector(".stat--dur .st-icon") === svgNode);
  check("live chip is the SAME node", box.querySelector(".stat--live") === liveNode);
  const t1 = box.querySelector(".stat--dur .stat__v").textContent;
  check("clock still advanced (ticker alive)", t1 !== t0, `${t0} -> ${t1}`);
  check("no duplicate chips", box.querySelectorAll(".stat--dur").length === 1 && box.querySelectorAll(".stat--live").length === 1);

  // a tool round appears mid-stream: the round chip must be filled WITHOUT recreating the duration chip
  m.tools = [{ round: 1 }];
  api.renderStats(el, m, true);
  const rc = box.querySelector(".stat--round");
  check("round chip shown when a round exists", !!rc && rc.hidden === false);
  check("duration chip survived the round-chip update", box.querySelector(".stat--dur") === durNode);
  check("round text rendered", !!rc && /round|第/i.test(rc.textContent || ""), rc && rc.textContent);

  el.remove();
}

// ── 2) final row: written once, identical repaints are no-ops ────────────────
console.log("\n=== 2: finished footer is written once; identical repaints are no-ops ===");
{
  const m = { role: "assistant", text: "x", time: Date.now(), tools: [{ round: 2 }],
    stats: { dur: 14, prompt: 6300, completion: 471, ctxUsed: 1600, ctxMax: 32768, partial: false,
             thinkSecs: 10.6, tokS: 44.4, reasoningTokens: 100 } };
  const el = api.msgEl(m, 0);
  doc.getElementById("chat").appendChild(el);
  api.renderStats(el, m, false);

  const box = el.querySelector(".msg-stats");
  check("footer visible at end", !!box && box.hidden === false);
  check("marked as final mode", !!box && box.dataset.mode === "final", box && box.dataset.mode);
  const durNode = box.querySelector(".stat--dur");
  const chipCount = box.querySelectorAll(".stat").length;
  check("full chip set rendered", !!durNode && chipCount >= 5, String(chipCount));

  for (let i = 0; i < 6; i++) api.renderStats(el, m, false);
  check("final row NOT rebuilt on identical repaint", box.querySelector(".stat--dur") === durNode);
  check("chip count unchanged", box.querySelectorAll(".stat").length === chipCount);

  // a real change (a late usage chunk) must still update the row exactly once
  m.stats = { ...m.stats, completion: 500 };
  api.renderStats(el, m, false);
  check("changed stats DID update the row", /500/.test(box.textContent || ""), box.textContent);

  el.remove();
}

// ── 3) streaming -> final transition rebuilds once and settles ────────────────
console.log("\n=== 3: live -> final transition renders the full row once ===");
{
  const m = { role: "assistant", text: "answer", time: Date.now(), startAt: win.performance.now() - 3000,
    stats: { dur: 3, prompt: 1000, completion: 40, ctxUsed: 1000, ctxMax: 32768, partial: false, thinkSecs: 1.5 } };
  const el = api.msgEl(m, 0);
  doc.getElementById("chat").appendChild(el);
  api.renderStats(el, m, true);
  const box = el.querySelector(".msg-stats");
  check("live mode first", box.dataset.mode === "live");
  const liveDur = box.querySelector(".stat--dur");
  api.renderStats(el, m, false);
  check("now final mode", box.dataset.mode === "final");
  check("transition replaced the live skeleton (full row)", box.querySelector(".stat--dur") !== liveDur);
  const finalDur = box.querySelector(".stat--dur");
  api.renderStats(el, m, false);
  check("settled: no further rebuild", box.querySelector(".stat--dur") === finalDur);
  el.remove();
}

console.log("");
if (FAILURES.length) {
  console.log("STATS FLICKER: " + FAILURES.length + " FAILED");
  FAILURES.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("STATS FLICKER: ALL PASSED");
process.exit(0);   // jsdom keeps the app's polling timers alive; end the run explicitly
