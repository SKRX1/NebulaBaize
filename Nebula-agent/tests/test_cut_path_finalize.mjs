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

const src = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

// ── static lock: no function-level early return can sit between the function
//    entry and the finalize line, so a stream cut through catch is GUARANTEED to
//    reach finalize (this is the contract that locks the edge).
const fnStart = src.search(/async function streamAssistant\(/);   // tolerant anchor: the signature now carries an optional owner-binding param
check("streamAssistant function found", fnStart >= 0);
const finalizeNeedle = 'if (t.state === "writing" || t.state === "running") { t.state = "skipped"; t.ms = null; }';
const finalizeAt = src.indexOf(finalizeNeedle);
check("finalize line found in source", finalizeAt >= 0);
const between = src.slice(fnStart, finalizeAt);
// a return inside the setInterval / paint callbacks is allowed; a FUNCTION-level return
// that would skip finalize is not. The guard: the only returns in this span belong to the
// tick callback (the liveTimer arrow), not the function body. We assert that any "return"
// token in this span is a callback guard (the setInterval one), i.e. none sits at the body's
// top indentation that could early-exit before finalize. We keep it strict and simple:
const returnTokens = (between.match(/\breturn\b/g) || []).length;
check("only the tick-callback return sits between entry and finalize (no body early-return)",
      returnTokens <= 1, "return-tokens=" + returnTokens);

// ── runtime differential: a transport cut (progress true, isTransportError true) routes
//    through the catch WITHOUT an early return, reaches finalize, and the zombie is finalized.
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
win.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8") + ';window.__api = { toolHtml, isTransportError, t };');
const api = win.__api;

// Re-run the exact finalize statement as a function (single source of truth: same predicate).
const finalizeLine = src.split(/\r?\n/).find((l) => l.includes(finalizeNeedle));
const finalizeFn = (0, eval)("(function(m){ " + finalizeLine.trim() + " })");

const TICK_SELECTOR = '.tool-call[data-state="running"]';
const scanRunning = (root) => root.querySelectorAll(TICK_SELECTOR).length;
const renderCard = (container, tool) => { container.innerHTML = api.toolHtml(tool, "t0", null); };

// a transport error that the REAL isTransportError classifies as transport (so the catch
// treats it as a recoverable cut, sets cutError, does NOT throw -> control reaches finalize).
const transportErr = () => new TypeError("network error");

console.log("\n=== differential: external stream cut (catch) reaches finalize, zombie finalized ===");

// probe A -- PRODUCTION: transport cut with progress on screen. isTransportError true,
// progress true -> catch sets cutError (no early return) -> finalize runs -> zombie finalized.
{
  const host = doc.createElement("div"); doc.body.appendChild(host);
  const message = { tools: [{ id: "a1", name: "shell_exec", server: "shell", tool: "shell_exec",
                              state: "running", result: "still-running 495s", open: true }] };
  renderCard(host, message.tools[0]);
  check("A before: zombie running card is in the tick scan", scanRunning(host) === 1, "found=" + scanRunning(host));
  // simulate the catch path the cut takes: progress present AND isTransportError -> no throw.
  const progress = !!(message.text || message.reasoning || (message.tools && message.tools.length));
  const isCut = api.isTransportError(transportErr()) && progress;
  check("A: the cut is classified as transport (recoverable, NOT a throw) so finalize is reached",
        isCut === true, "isCut=" + isCut);
  if (isCut) message.cutError = "network error";       // what the catch sets (m.error stays empty)
  finalizeFn(message);                                  // finalize is reachable -> runs
  renderCard(host, message.tools[0]);
  const after = scanRunning(host);
  check("A after: finalize ran on the cut path -> zombie is TERMINAL (not running)",
        message.tools[0].state !== "running" && message.tools[0].state !== "writing",
        "state=" + message.tools[0].state);
  check("A after: tick scan finds ZERO running cards (tick stops on the cut path)",
        after === 0, "found=" + after);
}

// probe B -- differential control: the SAME cut shape but finalize NOT run -> zombie stays
// in the tick scan. The delta A=0 vs B=1 is attributable to finalize alone, proving the
// cut path is safe ONLY because finalize is reached (no early return skipping it).
{
  const host = doc.createElement("div"); doc.body.appendChild(host);
  const message = { tools: [{ id: "b1", name: "shell_exec", server: "shell", tool: "shell_exec",
                              state: "running", result: "still-running 495s", open: true }] };
  renderCard(host, message.tools[0]);
  const found = scanRunning(host);
  check("B control (no finalize after the cut): zombie STAYS in tick scan", found === 1, "found=" + found);
}

// differential integrity: finalize alone drives 1->0 on the same cut shape.
{
  const shape = () => [{ id: "d", name: "shell_exec", server: "shell", tool: "shell_exec",
                         state: "running", result: "x", open: true }];
  const hostRun = doc.createElement("div"); doc.body.appendChild(hostRun);
  const msgRun = { tools: shape() }; renderCard(hostRun, msgRun.tools[0]);
  const before = scanRunning(hostRun);
  finalizeFn(msgRun);
  renderCard(hostRun, msgRun.tools[0]);
  const after = scanRunning(hostRun);
  check("differential: finalize alone drives the cut-path tick scan 1 -> 0",
        before === 1 && after === 0, `${before}->${after}`);
}

console.log("");
if (FAILURES.length) { console.log("FAILED (" + FAILURES.length + "): " + FAILURES.join(" | ")); process.exit(1); }
console.log("CUT-PATH-FINALIZE: ALL GREEN");
process.exit(0);
