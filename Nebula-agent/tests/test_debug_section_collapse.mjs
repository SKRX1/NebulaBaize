/* Debug-drawer section-card collapse persistence — end-to-end gate (2026-11-22).
 *
 * The debug page reuses the memory page's .mem-tabpanel cards for its five sections
 * (bugbox / live / gateway / recycle / probe), keyed by data-db. A past bug keyed all
 * five to `undefined` (cards had data-db, not data-mem), so they shared one localStorage
 * slot and ALWAYS opened expanded. This gate locks the fix through the page's own code:
 *
 *   C1 fresh boot (empty storage) -> all five debug cards start COLLAPSED (the user's ask).
 *   C2 memory cards stay EXPANDED on a fresh boot (the default was NOT changed for memory).
 *   C3 a real click on a debug card's title row drops is-collapsed AND writes that data-db
 *      key into strata.memCollapse (the real delegation -> storage round trip).
 *   C4 simulated refresh (fresh boot carrying the same localStorage) restores that card
 *      expanded and every other debug card collapsed -- survives restart of the gateway.
 *   C5 differential: same storage, but the card NOT clicked stays collapsed.
 *
 * Run: node tests/test_debug_section_collapse.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import constRequire from "module";
const require = constRequire.createRequire("E:/Nebula/NebulaBaize/");
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
const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const i18nCode = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");

function boot(prefill) {   // prefill = the previous session's storage; restored BEFORE app.js boots
  const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
  const win = dom.window;
  Object.keys(prefill || {}).forEach((k) => win.localStorage.setItem(k, prefill[k]));
  win.TextDecoder = TextDecoder;
  win.TextEncoder = TextEncoder;
  win.AbortController = AbortController;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
  if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
  win.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model", max_context: 32768 }) };
    if (u.includes("metrics")) return { ok: true, status: 200, json: async () => ({ engine: { max_context: 32768 } }) };
    if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  win.localStorage.setItem("strata.lang", "en");
  win.eval(i18nCode);
  win.eval(appCode);   // applyMemSubTab() runs at boot end: every card restored to its saved/default fold
  return win;
}

const carry = (win) => {
  const c = {};
  for (let i = 0; i < win.localStorage.length; i++) { const k = win.localStorage.key(i); c[k] = win.localStorage.getItem(k); }
  return c;
};
const collapsedSet = (doc, sel) =>
  [...doc.querySelectorAll(sel)].filter((c) => c.classList.contains("is-collapsed")).map((c) => c.dataset.db || c.dataset.mem);

(async () => {
  // ============ leg 1: fresh boot (empty storage) ============
  const win1 = boot();
  const doc1 = win1.document;

  const dbgCards = [...doc1.querySelectorAll(".db-tabpanel")];
  check("setup: five debug cards exist", dbgCards.length === 5, "got " + dbgCards.length);
  const allDbgCollapsed = collapsedSet(doc1, ".db-tabpanel");
  check("C1 fresh boot: ALL five debug sections start COLLAPSED", allDbgCollapsed.length === 5, JSON.stringify(allDbgCollapsed));

  // differential default: memory cards default EXPANDED (the change is scoped to debug sections)
  const memCollapsedOnFresh = collapsedSet(doc1, ".mem-tabpanel[data-mem]");
  check("C2 fresh boot: memory sections stay EXPANDED by default", memCollapsedOnFresh.length === 0, JSON.stringify(memCollapsedOnFresh));

  // ============ leg 2: real click on one debug card title row ============
  // The delegation ignores clicks on button/input/label/select/a, so target the title span.
  const targetDb = "live";   // the 调试 section
  const card = doc1.querySelector('.db-tabpanel[data-db="' + targetDb + '"]');
  const head = card.querySelector(".req-head");
  const title = head.querySelector(".card-title") || head;   // click the label, not the head's buttons
  title.dispatchEvent(new win1.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));

  const nowCollapsed = [...doc1.querySelectorAll(".db-tabpanel")].filter((c) => c.classList.contains("is-collapsed")).map((c) => c.dataset.db);
  check("C3a click expanded the target card (is-collapsed dropped)", !nowCollapsed.includes(targetDb), JSON.stringify(nowCollapsed));
  check("C3b the other four debug cards remain collapsed", nowCollapsed.length === 4 && !nowCollapsed.includes(targetDb), JSON.stringify(nowCollapsed));

  const stored = JSON.parse(win1.localStorage.getItem("strata.memCollapse") || "{}");
  check("C3c the click wrote the data-db key into strata.memCollapse",
    Object.prototype.hasOwnProperty.call(stored, targetDb) && stored[targetDb] === false &&
    !Object.prototype.hasOwnProperty.call(stored, "undefined"),
    JSON.stringify(stored));
  check("C3d no stray 'undefined' key was ever written (the old shared-slot bug)",
    !Object.prototype.hasOwnProperty.call(stored, "undefined"), JSON.stringify(Object.keys(stored)));

  // ============ leg 3: simulated refresh (gateway restart) ============
  const win2 = boot(carry(win1));
  const afterReload = [...win2.document.querySelectorAll(".db-tabpanel")].filter((c) => c.classList.contains("is-collapsed")).map((c) => c.dataset.db);
  check("C4 after refresh the clicked card stays EXPANDED", !afterReload.includes(targetDb), JSON.stringify(afterReload));
  check("C5 differential: the unclicked debug cards stay COLLAPSED after refresh", afterReload.length === 4, JSON.stringify(afterReload));

  // ============ leg 4: collapse an EXPANDED card back, refresh, confirm it persists folded ============
  // (both directions of the contract; a debug card defaults collapsed, so first expand two then
  //  collapse one back to exercise the true->false write surviving reload.)
  const gw = doc1.querySelector('.db-tabpanel[data-db="gateway"]');
  (gw.querySelector(".req-head .card-title") || gw.querySelector(".req-head")).dispatchEvent(new win1.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
  const gwTitle2 = gw.querySelector(".req-head .card-title") || gw.querySelector(".req-head");
  gwTitle2.dispatchEvent(new win1.MouseEvent("click", { bubbles: true }));   // collapse it back
  await new Promise((r) => setTimeout(r, 10));
  const stored4 = JSON.parse(win1.localStorage.getItem("strata.memCollapse") || "{}");
  check("C6a re-collapsing an expanded debug card persists gateway=true", stored4.gateway === true, JSON.stringify(stored4));
  const win4 = boot(carry(win1));
  const gw4 = win4.document.querySelector('.db-tabpanel[data-db="gateway"]');
  check("C6b after refresh the re-collapsed card is folded again", gw4.classList.contains("is-collapsed"));

  console.log("");
  if (FAILURES.length) { console.log("FAILED (" + FAILURES.length + "): " + FAILURES.join(" | ")); process.exit(1); }
  console.log("DEBUG-SECTION-COLLAPSE: ALL GREEN");
  process.exit(0);
})();
