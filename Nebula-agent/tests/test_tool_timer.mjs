/* Regression test for the streaming tool "timeout-wait" timer (流式工具超时等待计时器).

Boots the REAL index.html + i18n.js + app.js in jsdom and verifies the contract:
  Hidden-fast    a tool that has run < TOOL_TIMER_MIN_S (2s) shows no timer (no flicker).
  Elapsed        while progress keeps arriving (idle small) it shows "running {s}s", never warn/danger.
  Warn           idle >= 60% of the live idle ceiling -> amber, text has idle/max, bar ~66.7%.
  Danger         idle >= 90% of the live idle ceiling -> red pulse, text has remaining/max, bar ~94.4%.
  Idle governs   idle (last activity) is the signal, NOT elapsed: a long-running-but-active tool stays
                 normal; a short tool with a stale last-activity flips to warn.
  Non-running    done/error/skipped cards never show the timer (patchTool hides it; ticker skips them).
  Live value     the ceiling comes from /api/runtime-config (idle_timeout_s), NOT a hardcode: setting it
                 to a non-180 value moves the warn/danger thresholds proportionally.

Time is faked via Date.now so the 108s/162s thresholds are deterministic.

Run: node tests/test_tool_timer.mjs
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
win.localStorage.setItem("strata.lang", "en");

win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const injected = appCode + `
;window.__api = {
  toolHtml, patchTool, tickToolTimers,
  getIdleTimeout: () => idleTimeoutS,
  setIdleTimeout: (v) => { idleTimeoutS = v; },
};`;
win.eval(injected);
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));

const api = win.__api;

// ---- fake clock so the 108s/162s thresholds are deterministic ----------------------
let NOW = 1_700_000_000_000;
Date.now = () => NOW;
win.Date.now = () => NOW;

function runningNode(over = {}) {
  const host = doc.createElement("div");
  host.innerHTML = api.toolHtml({ tool: "fs_read", name: "fs_read", state: "running", round: 0, ...over }, 0, null);
  return { host, node: host.querySelector(".tool-call") };
}
const timerOf = (node) => node.querySelector(".tool-call__timer");
const barW = (node) => parseFloat(timerOf(node).querySelector(".tool-call__t-bar > i").style.width);

// ---------- tests ----------------------------------------------------------------
console.log("TOOL TIMEOUT-WAIT TIMER:");

// T1: fast tool (<2s) -> timer stays hidden (anti-flicker)
{
  const { host, node } = runningNode();
  api.tickToolTimers(host, { _lastActivityAt: NOW });
  check("fast (<2s): timer hidden", timerOf(node).hidden === true);
}

// T2: actively progressing (idle ~0) -> "running {s}s", no warn/danger, bar ~0
{
  const { host, node } = runningNode();
  node._t0 = NOW - 3000;
  api.tickToolTimers(host, { _lastActivityAt: NOW });
  const timer = timerOf(node);
  check("normal: visible", timer.hidden === false);
  check("normal: run text + elapsed", timer.querySelector(".tool-call__t-text").textContent.includes("3") && !timer.className.includes("warn") && !timer.className.includes("danger"));
  check("normal: bar near 0 (idle small)", barW(node) < 5, barW(node) + "%");
}

// T3: warn (idle 120s of 180s)
{
  const { host, node } = runningNode();
  node._t0 = NOW - 200000;
  api.tickToolTimers(host, { _lastActivityAt: NOW - 120000 });
  const timer = timerOf(node);
  check("warn: class --warn", timer.className.includes("tool-call__timer--warn"));
  const txt = timer.querySelector(".tool-call__t-text").textContent;
  check("warn: text has idle 120 and max 180", txt.includes("120") && txt.includes("180"), txt);
  check("warn: bar ~66.7%", Math.abs(barW(node) - 66.7) < 1, barW(node) + "%");
}

// T4: danger (idle 170s of 180s)
{
  const { host, node } = runningNode();
  node._t0 = NOW - 200000;
  api.tickToolTimers(host, { _lastActivityAt: NOW - 170000 });
  const timer = timerOf(node);
  check("danger: class --danger", timer.className.includes("tool-call__timer--danger"));
  const txt = timer.querySelector(".tool-call__t-text").textContent;
  check("danger: text has remaining 10 and max 180", txt.includes("10") && txt.includes("180"), txt);
  check("danger: bar ~94.4%", Math.abs(barW(node) - 94.4) < 1, barW(node) + "%");
}

// T5: non-running card never shows the timer
{
  const host = doc.createElement("div");
  host.innerHTML = api.toolHtml({ tool: "fs_read", name: "fs_read", state: "done", ok: true, result: "ok", ms: 1500, round: 0 }, 0, null);
  const node = host.querySelector(".tool-call");
  api.patchTool(node, { tool: "fs_read", name: "fs_read", state: "done", ok: true, result: "ok", ms: 1500, round: 0 }, 0, null);
  check("done: patchTool hides timer", timerOf(node).hidden === true);
  api.tickToolTimers(host, { _lastActivityAt: NOW - 999000 });   // even if wildly stale, ticker skips non-running
  check("done: ticker ignores it", timerOf(node).hidden === true);
}

// T6: idle is the governing signal, not elapsed
{
  const { host, node } = runningNode();
  node._t0 = NOW - 300000;                       // elapsed 300s (long-running)
  api.tickToolTimers(host, { _lastActivityAt: NOW - 1000 });   // but last progress 1s ago -> active
  const t1 = timerOf(node);
  check("active (idle small): normal despite long elapsed", t1.className === "tool-call__timer" && t1.querySelector(".tool-call__t-text").textContent.includes("running"), t1.querySelector(".tool-call__t-text").textContent);
  api.tickToolTimers(host, { _lastActivityAt: NOW - 130000 });  // progress went stale -> stalled
  const t2 = timerOf(node);
  check("stalled (idle large): warn despite short elapsed", t2.className.includes("--warn"), t2.className);
}

// T7: the ceiling is live (from /api/runtime-config), NOT hardcoded — set it to 100s and check thresholds move
{
  check("live value: default is 180", api.getIdleTimeout() === 180);
  api.setIdleTimeout(100);
  check("live value: setter applied", api.getIdleTimeout() === 100);
  const { host, node } = runningNode();
  node._t0 = NOW - 20000;                                   // 20s elapsed (irrelevant to idle)
  api.tickToolTimers(host, { _lastActivityAt: NOW - 60000 });   // idle 60s of 100s -> warn (60%)
  const t1 = timerOf(node);
  check("live value: warn at 60s/100s (not 108s/180s)", t1.className.includes("--warn"), t1.className);
  check("live value: warn text shows max 100", t1.querySelector(".tool-call__t-text").textContent.includes("100"), t1.querySelector(".tool-call__t-text").textContent);
  check("live value: warn bar 60%", Math.abs(barW(node) - 60) < 1, barW(node) + "%");
  api.tickToolTimers(host, { _lastActivityAt: NOW - 90000 });   // idle 90s of 100s -> danger (90%)
  const t2 = timerOf(node);
  check("live value: danger at 90s/100s (not 162s/180s)", t2.className.includes("--danger"), t2.className);
  const txt2 = t2.querySelector(".tool-call__t-text").textContent;
  check("live value: danger text remaining 10 & max 100", txt2.includes("10") && txt2.includes("100"), txt2);
  check("live value: danger bar 90%", Math.abs(barW(node) - 90) < 1, barW(node) + "%");
  api.setIdleTimeout(180);  // restore default
}

// ---------- summary --------------------------------------------------------------
console.log("");
if (FAILURES.length) {
  console.log("TOOL TIMER: " + FAILURES.length + " FAILED");
  for (const f of FAILURES) console.log("  - " + f);
  process.exit(1);
} else {
  console.log("TOOL TIMER: ALL PASSED");
  process.exit(0);   // boot wires a setInterval (pollModels/refreshIdleTimeout); exit cleanly so the suite doesn't hang
}
