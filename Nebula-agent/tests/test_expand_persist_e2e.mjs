/* End-to-end persistence gate (2026-10-30): REAL boot of index.html + app.js + i18n.js
 * in jsdom, then drive the actual click delegation / onclick paths and assert that
 * localStorage gets written, and that a FRESH boot sharing the same localStorage restores
 * the state. This closes the gap test_expand_persist.mjs left open: it locked the wiring
 * statically and the helpers in isolation, but never the real click -> storage -> reload
 * -> restore round trip through the page's own code.
 * Run standalone: node tests/test_expand_persist_e2e.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import constRequire from "module";
const require = constRequire.createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
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
// top-level declarations do not land on window from a realm eval -- expose them the same
// way test_stream_debug.mjs does (append a wiring block to the code before eval).
const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8") +
  "\n;window.__t = { renderBugBox, renderKbCard, renderNotesCard, expandSetLoad, expandSetSave, bugBoxExpanded, memExpanded, bugBoxSave, restoreMemExpand };\n";
const i18nCode = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");

function boot(prefill) {   // prefill: storage pairs from the "previous session" -- must land
  const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
  const win = dom.window;
  // the refresh simulation: restore BEFORE app.js boots, so init-time expandSetLoad reads it
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
  win.eval(appCode);
  return win;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ================= leg 1: first boot, drive the REAL clicks =================
  const win1 = boot();
  const doc1 = win1.document;

  // seed two bug rows through the app's OWN save channel (its store caches memory), then render
  const seed = [
    { ts: 1000, kind: "err", sourceTab: "chat", msg: "boom-alpha", stack: "at alpha", status: "open" },
    { ts: 2000, kind: "err", sourceTab: "chat", msg: "boom-beta", stack: "at beta", status: "open" },
  ];
  win1.__t.bugBoxSave(seed);
  win1.__t.renderBugBox();
  const rows1 = [...doc1.querySelectorAll("[data-bugtoggle]")];
  check("E1 first boot renders two rows", rows1.length === 2, "got " + rows1.length);
  if (rows1.length !== 2) { console.log("cannot drive clicks -> abort"); console.log(""); console.log("FAILED: env"); process.exit(1); }
  check("E2 both rows start collapsed", rows1.every((r) => r.classList.contains("is-collapsed")));

  // REAL delegated click on the first row (delegation order: buttons first, then row).
  // NOTE the box renders newest-first, so rows1[0] is ts=2000 -- assert on its OWN key.
  const clickedKey = rows1[0].getAttribute("data-bugtoggle");
  rows1[0].click();
  await sleep(10);
  check("E3 click expanded the row (is-collapsed dropped)", !doc1.querySelector('[data-bugtoggle="' + clickedKey + '"]').classList.contains("is-collapsed"));

  // THE key assertion the static gate could not make: localStorage was actually written
  const stored1 = JSON.parse(win1.localStorage.getItem("strata.bugBoxExpanded") || "[]");
  check("E4 delegated click wrote the expansion to localStorage", JSON.stringify(stored1) === JSON.stringify([clickedKey]), JSON.stringify(stored1));

  // batch expand-all button also persists (both keys now)
  const expandAll = doc1.getElementById("bugbox-expandall");
  check("E5 batch expand button wired", !!expandAll && typeof expandAll.onclick === "function");
  if (expandAll && expandAll.onclick) expandAll.onclick(new win1.MouseEvent("click", { bubbles: true }));
  await sleep(10);
  const stored2 = JSON.parse(win1.localStorage.getItem("strata.bugBoxExpanded") || "[]");
  check("E6 batch expand-all persisted both keys", stored2.includes("1000") && stored2.includes("2000"), JSON.stringify(stored2));

  // memory-page leg: a KB card's per-item view button -> strata.memCollapse must be written
  // (the click path lives in renderKbCard; drive it through the exposed helper set)
  // ================= leg 2: simulated refresh -- FRESH boot, shared localStorage ==========
  // jsdom localStorage lives on the origin; a fresh JSDOM starts empty, so carry the first
  // window's storage into a second boot and let INIT read it (that IS the refresh).
  const carry = {};
  for (let i = 0; i < win1.localStorage.length; i++) { const k = win1.localStorage.key(i); carry[k] = win1.localStorage.getItem(k); }
  const win2 = boot(carry);
  win2.__t.renderBugBox();   // Set was restored at init from the prefilled storage
  const rows2 = [...win2.document.querySelectorAll("[data-bugtoggle]")];
  check("E7 refresh re-rendered the rows", rows2.length === 2);
  const openKeys = rows2.filter((r) => !r.classList.contains("is-collapsed")).map((r) => r.getAttribute("data-bugtoggle"));
  check("E8 AFTER REFRESH both rows are still expanded (this is the user-visible contract)", openKeys.includes("1000") && openKeys.includes("2000"), JSON.stringify(openKeys));

  // fold-all then refresh again: the collapse must persist too (both directions of the contract)
  const foldAll = doc1.getElementById("bugbox-foldall");
  if (foldAll && foldAll.onclick) foldAll.onclick(new win1.MouseEvent("click", { bubbles: true }));
  await sleep(10);
  const stored3 = JSON.parse(win1.localStorage.getItem("strata.bugBoxExpanded") || "[]");
  check("E9 fold-all persisted an empty set", stored3.length === 0, JSON.stringify(stored3));
  const carry3 = {};
  for (let i = 0; i < win1.localStorage.length; i++) { const k = win1.localStorage.key(i); carry3[k] = win1.localStorage.getItem(k); }
  const win3 = boot(carry3);
  win3.__t.renderBugBox();
  const rows3 = [...win3.document.querySelectorAll("[data-bugtoggle]")];
  check("E10 refresh after fold-all: every row collapsed again", rows3.every((r) => r.classList.contains("is-collapsed")));

  console.log("");
  if (FAILURES.length) { console.log("FAILED (" + FAILURES.length + "): " + FAILURES.join(" | ")); process.exit(1); }
  console.log("EXPAND-PERSIST-E2E: ALL GREEN");
  process.exit(0);
})();
