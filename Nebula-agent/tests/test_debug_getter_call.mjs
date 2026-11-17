/* Regression for `d.current is not a function` (bug:window.onerror, app.js renderDebug).
 *
 * Root cause (one-hand evidence, 2026-11-13 09:48):
 *   window.__strataDebug.current is a GETTER — reading it returns the live-capture OBJECT
 *   ({chunkIndex, bytes, errors}) or null. But renderDebug() and buildDebugEvidence() both did
 *   `d && d.current ? d.current() : null` — they treated the getter as if it were a FUNCTION.
 *   A truthy getter value (the object) passes the `d.current ?` check, then `()` invokes a
 *   non-function -> "d.current is not a function". renderDebug is called SYNCHRONOUSLY from the
 *   live-stream timer (app.js:7700: `if (tab === "debug") { renderDebug(); ... }`), so the throw
 *   surfaces as window.onerror (not an unhandled rejection) — exactly what the report shows.
 *
 * This test drives that exact path: boot the page, arm a live capture (so the getter returns a real
 * object), switch to the debug tab, and let renderDebug() run. With the fix it renders the live line;
 * without it (call sites back to `d.current()`) the getter-as-function throws and the live line is gone.
 *
 * Run standalone: node tests/test_debug_getter_call.mjs
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
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
win.localStorage.setItem("strata.lang", "zh");
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }

win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

// arm a live capture so the getter returns a real object when renderDebug runs
let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += `
;window.__armLive = () => {
  const m = { role: "assistant", text: "", time: Date.now() };
  _dbg.turn = m; _dbg.chunkIndex = 3; _dbg.bytes = 2048; _dbg.errors = [{ ts: Date.now(), phase: "x", msg: "y", stack: "" }];
  busy = { msg: m, controller: new AbortController(), sessionId: activeId, origin: activeSession() };
  tab = "debug";
  return m;
};
window.__api = { renderDebug, buildDebugEvidence };`;
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(appCode);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// static lock: the getter must be READ as a property, never invoked as a function
const srcLines = fs.readFileSync(path.join(WEB, "app.js"), "utf8").split(/\r?\n/);
const getterDefined = srcLines.some((l) => /get\s+current\s*\(\s*\)/.test(l));
const buggyCalls = srcLines.filter((l) => /d\.current\s*\(\s*\)/.test(l));
check("__strataDebug.current is DEFINED as a getter", getterDefined);
check("no call site invokes the getter as a function (d.current())", buggyCalls.length === 0, `found ${buggyCalls.length}`);

const main = async () => {
  console.log("\n=== live-capture renderDebug: getter read as property, not called ===");
  await sleep(30);

  const api = win.__api;
  // arm a live capture FIRST so the getter has a real capture to return
  const armed = win.__armLive();
  check("armed a live capture", !!armed);

  // reading the getter directly must give the capture OBJECT (NOT a function) — invoking it as `()` is the crash
  const c = win.__strataDebug.current;
  check("reading __strataDebug.current yields the capture object", !!c && typeof c !== "function" && c.chunkIndex === 3 && c.bytes === 2048 && Array.isArray(c.errors) && c.errors.length === 1);
  check("typeof current is NOT function (it is a getter)", typeof c !== "function");

  // run renderDebug() exactly like the live-stream timer does (synchronous call)
  const threw = (() => { try { api.renderDebug(); return null; } catch (e) { return e; } })();
  check("renderDebug() on a live capture does NOT throw", threw === null, threw ? String(threw) : "");

  // the live line must render through the getter path: "已收 3 分块 / 2048 字节" + the captured exception note
  const list = doc.getElementById("debug-list");
  const txt = (list && list.textContent) || "";
  check("renderDebug rendered the LIVE capture line via the getter", /3/.test(txt) && /2048/.test(txt), JSON.stringify(txt.slice(0, 80)));
  check("renderDebug counted the captured frontend exception", /异常|exception/.test(txt), JSON.stringify(txt.slice(0, 120)));

  // buildDebugEvidence runs on the same getter — must not throw either
  const threw2 = (() => { try { const ev = api.buildDebugEvidence(); return { e: null, n: (ev || []).length }; } catch (e) { return { e, n: 0 }; } })();
  check("buildDebugEvidence() does NOT throw on the same getter", threw2.e === null, threw2.e ? String(threw2.e) : "");

  console.log();
  if (FAILURES.length) { console.log(`FAILED (${FAILURES.length}):`); for (const f of FAILURES) console.log("  - " + f); win.close(); process.exit(1); }
  console.log("DEBUG-GETTER-CALL: ALL PASSED");
  win.close();
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
