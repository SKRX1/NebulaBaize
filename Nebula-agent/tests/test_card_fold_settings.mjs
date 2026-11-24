/* Card-fold SETTINGS gate (2026-11-24): the two default-collapse switches — 调试页卡片默认折叠
 * (settings.debugFold, DEFAULT true) and 记忆页卡片默认折叠 (settings.memFold, DEFAULT false) —
 * must each ACTUALLY move the default fold state of their own cards.
 *
 * test_debug_section_collapse.mjs already locks the DEFAULT branch (debugFold on, memFold off)
 * end-to-end through the real click->storage->reload path. This gate closes the gap that gate
 * left open: the CONTROLLABILITY of the two switches themselves — flipping settings.debugFold /
 * settings.memFold at boot changes the fresh-boot fold state, and each switch only touches its
 * OWN card set (a clean single-variable differential proves the wiring is load-bearing, not a
 * dead checkbox). Plus: an explicit user toggle (strata.memCollapse key) still wins over both.
 *
 *   A1 fresh boot (no sampling): debug all 5 COLLAPSED, memory all EXPANDED (the shipped default).
 *   A2 settings.debugFold=false: debug EXPANDED (0 collapsed). Single-var vs A1 -> the switch moves it.
 *   A3 settings.debugFold=true : debug COLLAPSED (5). Pair with A2 -> the ONLY differing var is the switch.
 *   A4 settings.memFold=true  : memory COLLAPSED. Single-var vs A1 -> the switch moves it.
 *   A5 settings.memFold=false : memory EXPANDED (the default). Pair with A4 -> only var = the switch.
 *   A6 cross-isolation: debugFold flips memory's collapsed count stays 0; memFold flips debug stays put.
 *   A7 a user-toggled card ignores the switch: a memory card saved collapsed stays collapsed even with
 *      memFold=false; a debug card saved expanded stays expanded even with debugFold=true.
 *
 * Run: node tests/test_card_fold_settings.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import module from "module";
const require = module.createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "serve", "web");
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const i18nCode = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");

function boot(sampling, memCollapse) {   // pre-seed strata.sampling (settings) + strata.memCollapse (user toggles)
  const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
  const win = dom.window;
  win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
  win.cancelAnimationFrame = (id) => clearTimeout(id);
  win.EventSource = class { constructor() {} close() {} };   // app boots a session-stream; stub it silent
  win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ model: "m", max_context: 32768, servers: [], tools: 0 }) });
  win.localStorage.setItem("strata.lang", "en");
  if (sampling) win.localStorage.setItem("strata.sampling", JSON.stringify(sampling));
  if (memCollapse) win.localStorage.setItem("strata.memCollapse", JSON.stringify(memCollapse));
  win.eval(i18nCode);
  win.eval(appCode);   // applyMemSubTab() runs at boot end -> every card restored to its saved/default fold
  return win;
}

const dbg = (doc) => [...doc.querySelectorAll(".db-tabpanel[data-db]")].filter(c => c.classList.contains("is-collapsed")).map(c => c.dataset.db);
const mem = (doc) => [...doc.querySelectorAll(".mem-tabpanel[data-mem]")].filter(c => c.classList.contains("is-collapsed")).map(c => c.dataset.mem);

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

(async () => {
  // ---- A1: shipped default (no sampling) ----
  const w1 = boot();
  check("A1 default: all 5 debug cards COLLAPSED", dbg(w1.document).length === 5, JSON.stringify(dbg(w1.document)));
  check("A1 default: all memory cards EXPANDED", mem(w1.document).length === 0, JSON.stringify(mem(w1.document)));
  const dbgCountDefault = dbg(w1.document).length;

  // ---- A2 / A3: debugFold single-variable differential ----
  const wOff = boot({ debugFold: false });
  const wOn  = boot({ debugFold: true });
  const offCol = dbg(wOff.document), onCol = dbg(wOn.document);
  check("A2 debugFold=false -> debug EXPANDED (0 collapsed)", offCol.length === 0, JSON.stringify(offCol));
  check("A3 debugFold=true  -> debug COLLAPSED (5)", onCol.length === 5, JSON.stringify(onCol));
  check("A2+A3 LOAD-BEARING: flipping debugFold alone changes the debug fold count", offCol.length !== onCol.length, `${offCol.length} vs ${onCol.length}`);

  // ---- A4 / A5: memFold single-variable differential ----
  const wMemOn  = boot({ memFold: true });
  const wMemOff = boot({ memFold: false });
  const memOn = mem(wMemOn.document), memOff = mem(wMemOff.document);
  check("A4 memFold=true  -> memory COLLAPSED (>0)", memOn.length > 0, JSON.stringify(memOn));
  check("A5 memFold=false -> memory EXPANDED (0)", memOff.length === 0, JSON.stringify(memOff));
  check("A4+A5 LOAD-BEARING: flipping memFold alone changes the memory fold count", memOn.length !== memOff.length, `${memOn.length} vs ${memOff.length}`);
  const memTotal = memOn.length;   // how many memory cards exist; A6 asserts debugFold never touches this

  // ---- A6: cross-isolation (each switch only moves its OWN set) ----
  check("A6 debugFold=false does NOT collapse any memory card", mem(wOff.document).length === 0, JSON.stringify(mem(wOff.document)));
  check("A6 debugFold=true  does NOT collapse any memory card", mem(wOn.document).length === 0, JSON.stringify(mem(wOn.document)));
  check("A6 memFold=true  does NOT change the debug default (still 5 collapsed)", dbg(wMemOn.document).length === dbgCountDefault, JSON.stringify(dbg(wMemOn.document)));
  check("A6 memFold=false does NOT change the debug default (still 5 collapsed)", dbg(wMemOff.document).length === dbgCountDefault, JSON.stringify(dbg(wMemOff.document)));

  // ---- A7: an explicit user toggle wins over the switch (saved memCollapse short-circuits) ----
  // A memory card SAVED collapsed stays collapsed even when memFold=false (default off).
  const aMemKey = [...w1.document.querySelectorAll(".mem-tabpanel[data-mem]")][0].dataset.mem;
  const wUserMem = boot({ memFold: false }, { [aMemKey]: true });
  check("A7 user-collapsed memory card stays collapsed despite memFold=false",
    mem(wUserMem.document).includes(aMemKey), JSON.stringify(mem(wUserMem.document)));
  // A debug card SAVED expanded stays expanded even when debugFold=true (default on).
  const wUserDbg = boot({ debugFold: true }, { live: false });
  check("A7 user-expanded debug card stays expanded despite debugFold=true",
    !dbg(wUserDbg.document).includes("live"), JSON.stringify(dbg(wUserDbg.document)));

  console.log("");
  if (FAILURES.length) { console.log("FAILED (" + FAILURES.length + "): " + FAILURES.join(" | ")); process.exit(1); }
  console.log("CARD-FOLD-SETTINGS: ALL GREEN");
  process.exit(0);
})();
