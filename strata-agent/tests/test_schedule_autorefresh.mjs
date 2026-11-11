/* Contract test: agent-tool schedule edits must auto-refresh the panel (plan A+B).

 *

 * Why this exists

 * ---------------

 * The bug: schedule__add/update/remove (an agent MCP tool) writes config/mcp_servers.json,

 * but the front-end sidebar (#schedule-list) only calls loadSchedule() once at boot — only the

 * on-panel +modal add/delete callbacks refresh it. So a task the AGENT creates shows up only

 * after a manual refresh. The fix:

 *   A (front, fallback): add loadSchedule() to the existing POLL_MS interval + focus +

 *      visibilitychange hooks, so coming back to the tab refreshes within one tick.

 *   B (back, instant): the gateway's scheduler host already detects the config change on its

 *      hot-reload tick and now broadcasts {schedule-changed:true} on the existing SSE channel;

 *      the front onmessage sees it and calls loadSchedule() immediately (no chat bubble).

 *

 * Locks (static + behavioural):

 *   1) POLL_MS interval now also calls loadSchedule (A1);

 *   2) visibilitychange-visible now also calls loadSchedule (A2);

 *   3) window focus now also calls loadSchedule (A3);

 *   4) SSE onmessage early-returns to loadSchedule on schedule-changed (B front);

 *   5) gateway _sched_audit_event broadcasts schedule-changed on schedule-reload (B back);

 *   6) BEHAVIOUR: boot, wrap loadSchedule IN THE SAME EVAL (a top-level function declaration

 *      binding — reassign it so the registered hooks call the wrapper), fire focus +

 *      visibilitychange, assert the wrapper ran -> proves A2/A3 are wired, not vacuous.

 *

 * Run standalone: node tests/test_schedule_autorefresh.mjs

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

const check = (label, cond) => {

  console.log("  " + (cond ? "OK   " : "FAIL ") + label);

  if (!cond) FAILURES.push(label);

};



const src = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");

const gw = fs.readFileSync(path.join(ROOT, "runtime", "gateway.py"), "utf8");



// --- static locks -------------------------------------------------------------

check("A1 POLL_MS interval also calls loadSchedule",

  /setInterval\(\(\)\s*=>\s*\{\s*pollModels\(\);\s*refreshIdleTimeout\(\);\s*loadSchedule\(\);\s*\},\s*POLL_MS\)/.test(src));

check("A2 visibilitychange-visible also calls loadSchedule",

  /document\.visibilityState === "visible"\)\s*\{\s*pollModels\(\);\s*refreshIdleTimeout\(\);\s*loadSchedule\(\);\s*\}/.test(src));

check("A3 window focus also calls loadSchedule",

  /addEventListener\("focus",\s*\(\)\s*=>\s*\{\s*pollModels\(\);\s*refreshIdleTimeout\(\);\s*loadSchedule\(\);\s*\}\)/.test(src));

check("B front SSE onmessage early-returns to loadSchedule on schedule-changed",

  /obj\["schedule-changed"\]\)\s*\{\s*loadSchedule\(\);\s*return;\s*\}/.test(src));

check("B back gateway broadcasts schedule-changed on schedule-reload",

  /==\s*"schedule-reload"[\s\S]{0,120}broadcast_stream\(\{"schedule-changed":\s*True\}\)/.test(gw));

check("loadSchedule is still DEFINED (the refresh target)",

  /async function loadSchedule\s*\(/.test(src));



// --- behaviour lock: wrap loadSchedule inside the eval, fire focus + vischange --

const dom = new JSDOM(html, { url: "http://127.0.0.1/", runScripts: "outside-only" });

const win = dom.window;

win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);

win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));

// loadSchedule is a top-level function declaration. Reassign the SAME binding so the

// already-registered focus/visibilitychange hooks now route through the wrapper, and expose

// the counter via the same realm (window.__api). This is the jsdom realm-visibility rule.

const probeCode = src + `

;(function () {

  var __orig = loadSchedule;

  window.__calls = 0;

  loadSchedule = function () { window.__calls++; return __orig.apply(this, arguments); };

  window.__fireFocus = () => window.dispatchEvent(new Event("focus"));

  window.__fireVis = () => document.dispatchEvent(new Event("visibilitychange"));

})();`;

win.eval(probeCode);

const callable = typeof win.__fireFocus === "function" && typeof win.__fireVis === "function";

check("boot wired a wrap-able loadSchedule binding", callable);



if (callable) {

  Object.defineProperty(win.document, "visibilityState", { configurable: true, get: () => "visible" });

  win.__fireFocus();

  check("firing window focus invokes loadSchedule (A3 is wired)", win.__calls >= 1);

  const before = win.__calls;

  win.__fireVis();

  check("firing visibilitychange(visible) invokes loadSchedule (A2 is wired)", win.__calls > before);

} else {

  check("firing window focus invokes loadSchedule (A3 is wired)", false);

  check("firing visibilitychange(visible) invokes loadSchedule (A2 is wired)", false);

}



console.log("\nREGRESSION: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));

process.exit(FAILURES.length ? 1 : 0);
