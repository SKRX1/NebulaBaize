/* Zombie-running finalize gate (2026-10-27, two decided items).

Background (the screenshot): a long shell command still running, its card OPEN,
the title stuck on "Error", with "shell_exec still-running 495s" streaming under
it. The seconds kept climbing (495 -> 525). Two distinct bugs lived here:

  A. title mis-colour  -- locked by tests/test_tool_progress_label.mjs (the A+B
     three-state fix: running = neutral, only ok===false = red, ok===true = result).

  B. THIS gate -- a card left in state "running" after the turn function returns
     is a ZOMBIE: the live tick timer scans
       root.querySelectorAll('.tool-call[data-state="running"]')
     every 500ms forever, and the seconds keep accumulating on a card whose turn
     is already dead. The fix (app.js, reached on every completion path) flips a
     leftover running/writing card to a TERMINAL state so it drops out of the tick
     selector. This gate locks that finalize so a zombie cannot survive a turn end.

Differential (language locked en):
  1. a running card whose turn has FINALIZED (state moved to terminal) must NOT
     match the tick selector anymore  -> the live scan finds ZERO running nodes.
  2. a live running card (control) DOES match the tick selector  -> proves the
     selector genuinely keys on data-state=running, so "1" is attributable to the
     finalize moving the state, not to the card vanishing.
  3. the finalized card is a TERMINAL state (not running/writing)  -> the finalize
     condition `state==="writing"||state==="running"` would skip it  -> tick stops.
  The only difference between probe 1 and probe 2 is whether finalize ran, so the
  delta (scan finds 0 vs finds 1) is attributable to the finalize alone.

Run standalone: node tests/test_zombie_running_finalize.mjs
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

const src = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

// --- static locks: the finalize must exist and reach every completion path ----------
// 1) the finalize that moves a leftover running card to a terminal state exists in source.
check("finalize moves leftover running/writing card to a terminal state",
  /for \(const t of m\.tools \|\| \[\]\) if \(t\.state === "writing" \|\| t\.state === "running"\) \{ t\.state = "skipped"; t\.ms = null; \}/.test(src));
// 2) the live tick is driven by a per-turn timer that is cleared in finally.
check("live timer is cleared on turn end (finally clearInterval(liveTimer))",
  /finally \{[\s\S]{0,40}clearInterval\(liveTimer\)/.test(src));
// 3) the tick scan keys on data-state="running" (the selector a finalized card must escape).
check("tick scan keys on data-state=running",
  src.includes('.tool-call[data-state="running"]'));

// --- runtime differential through the REAL render path ---------------------------------
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1/", runScripts: "outside-only" });
const win = dom.window;
const doc = win.document;

win.matchMedia = () => ({ matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
win.localStorage.setItem("strata.lang", "en");
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8") +
  ';window.__api = { toolHtml, t };');
const api = win.__api;

// Reproduce the EXACT finalize statement from app.js as a function (single source of
// truth: the same `state==="writing"||state==="running"` predicate the gate locks).
const finalizeLine = src.split(/\r?\n/).find((l) => l.includes('t.state === "writing" || t.state === "running"'));
check("finalize statement line found in source", !!finalizeLine);
// Evaluate it in THIS realm against a passed array via a thin wrapper.
const finalizeFn = (0, eval)("(function(m){ " + finalizeLine.trim().replace(/^for /, "for ") + " })");
check("finalize boots as a runnable function", typeof finalizeFn === "function");

// tick scan, using the REAL selector string from app.js.
const TICK_SELECTOR = '.tool-call[data-state="running"]';
const scanRunning = (root) => root.querySelectorAll(TICK_SELECTOR).length;

// Render a card into a host, then run finalize on its owning message, then re-render.
function renderCard(container, tool) {
  container.innerHTML = api.toolHtml(tool, "t0", null);
}

// probe 1 -- ZOMBIE: card was running, finalize runs (turn ended) -> leaves the tick set.
{
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const message = { tools: [{ id: "z1", name: "shell_exec", server: "shell", tool: "shell_exec",
                              state: "running", result: "still-running 495s", open: true }] };
  renderCard(host, message.tools[0]);
  check("probe1 before: live running card IS in the tick scan", scanRunning(host) === 1, "found=" + scanRunning(host));
  finalizeFn(message);
  const stateAfter = message.tools[0].state;
  renderCard(host, message.tools[0]);
  const after = scanRunning(host);
  check("probe1 after finalize: zombie is TERMINAL (not running/writing)",
        stateAfter !== "running" && stateAfter !== "writing", "state=" + stateAfter);
  check("probe1 after finalize: tick scan finds ZERO running cards (tick stops)",
        after === 0, "found=" + after);
}

// probe 2 -- control: an untouched live running card STAYS in the tick scan.
{
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  const message = { tools: [{ id: "c1", name: "shell_exec", server: "shell", tool: "shell_exec",
                              state: "running", result: "still-running 600s", open: true }] };
  renderCard(host, message.tools[0]);
  // no finalize on this one -- it belongs to a turn that has not ended.
  const found = scanRunning(host);
  check("probe2 control: live running card (no finalize) stays in tick scan",
        found === 1, "found=" + found);
}

// --- differential integrity: finalize alone flips 1 -> 0 on the SAME card shape -----
{
  const shape = () => [{ id: "d", name: "shell_exec", server: "shell", tool: "shell_exec",
                         state: "running", result: "x", open: true }];
  const hostA = doc.createElement("div"); doc.body.appendChild(hostA);
  const msgA = { tools: shape() };
  renderCard(hostA, msgA.tools[0]);
  const beforeA = scanRunning(hostA);
  finalizeFn(msgA);
  renderCard(hostA, msgA.tools[0]);
  const afterA = scanRunning(hostA);
  check("differential: finalize alone drives the tick scan from 1 to 0",
        beforeA === 1 && afterA === 0, `${beforeA}->${afterA}`);
}

console.log("");
if (FAILURES.length) {
  console.log("FAILED (" + FAILURES.length + "): " + FAILURES.join(" | "));
  process.exit(1);
}
console.log("ZOMBIE-RUNNING-FINALIZE: ALL GREEN");
process.exit(0);
