/* jsdom behaviour gate - per-tab sidebar visibility settings (gear modal + switches).
   Locks the feature: a settings modal lets the user pick which tabs show the LEFT sidebar,
   switches take effect IMMEDIATELY (no reload), and "reset to default" actually works.

   User-approved acceptance (verbatim intent):
     * images + tools tabs are HIDDEN by default;
     * clicking a switch takes effect immediately;
     * "reset to default" must actually do something.

   A) DOM skeleton present: #sidebar-modal + the three buttons + 10 data-sidevis switch rows.
   B) DEFAULT state: DEFAULTS.sidebarTabs = the 8 SHOW tabs and does NOT include images/tools
      (so those two views start with the sidebar hidden).
   C) Immediate effect: click the "images" switch row -> that row's aria-checked flips TRUE,
      settings.sidebarTabs now includes images, and it is PERSISTED to localStorage. (load-bearing
      single-variable: a row that never calls setSidebarTabVisible would not move the list/LS.)
   D) Reset works (user-named check): first DEVIATE (click "hide all" -> empty SHOW list), then
      click "reset" -> list snaps back to DEFAULTS, localStorage updated, and the modal switches
      re-render (images/tools back to false, chat back to true).
   E) USER EXACT PATH: from clean default, OPEN images, then RESET -> images go back to HIDDEN.
      This is the exact reported sequence; it is load-bearing because the shallow-copy shared-array
      bug (setSidebarTabVisible now slices a copy) would otherwise let the reset re-show images.

   Run: node tests/test_sidebar_visibility_jsdom.mjs
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
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
const i18nSrc = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

// Expose module-scope symbols the test needs (top-level let/const are NOT visible across evals,
// so every read must ride through __api defined inside the SAME boot eval).
appCode += `
;window.__api = {
  DEFAULTS,
  getSettings: () => settings,
  getTab: () => tab,
  sidebarVisApply,
  renderSidebarSettings,
  $,
};`;

const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost:8099/", pretendToBeVisual: true });
const win = dom.window;
win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
win.IntersectionObserver = class { constructor(cb){this.cb=cb;} observe(){} unobserve(){} disconnect(){} takeRecords(){return [];} };
win.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
win.cancelAnimationFrame = (id) => clearTimeout(id);
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ shared: false }) });

win.eval(i18nSrc);
win.eval(appCode);   // real app.js boots; bindSidebarSettings() runs and wires the onclicks live

const api = win.__api;
const LS = () => { try { return JSON.parse(win.localStorage.getItem("strata.sampling") || "{}"); } catch (e) { return {}; } };
const row = (name) => win.document.querySelector(`#sidebar-modal [data-sidevis="${name}"]`);

console.log("\n=== A. DOM skeleton present ===");
check("#sidebar-modal exists", !!api.$("sidebar-modal"));
check("three buttons exist", ["sidevis-all", "sidevis-none", "sidevis-reset"].every((id) => !!api.$(id)));
check("10 data-sidevis switch rows present", win.document.querySelectorAll("#sidebar-modal [data-sidevis]").length === 10);

console.log("\n=== B. DEFAULT state: images + tools hidden, 8 tabs shown ===");
{
  const def = api.DEFAULTS.sidebarTabs;
  check("DEFAULTS.sidebarTabs has 8 entries", Array.isArray(def) && def.length === 8, JSON.stringify(def));
  check("images NOT in default SHOW list (hidden by default)", !def.includes("images"));
  check("tools NOT in default SHOW list (hidden by default)", !def.includes("tools"));
  check("chat/spark/debug/memory/schedule/monitor/about/donate are shown",
    ["chat", "spark", "debug", "memory", "schedule", "monitor", "about", "donate"].every((x) => def.includes(x)));
  // Fresh boot with empty storage: settings falls back to DEFAULTS.
  const live = api.getSettings().sidebarTabs;
  check("live settings.sidebarTabs equals DEFAULTS on fresh boot",
    JSON.stringify(live) === JSON.stringify(def), JSON.stringify(live));
  check("sidebarVisApply(images) HIDES sidebar (body.no-sidebar)", (() => {
    api.sidebarVisApply("images");
    return win.document.body.classList.contains("no-sidebar");
  })());
  check("sidebarVisApply(chat) SHOWS sidebar (no no-sidebar)", (() => {
    api.sidebarVisApply("chat");
    return !win.document.body.classList.contains("no-sidebar");
  })());
}

console.log("\n=== C. Switch takes effect IMMEDIATELY (click images -> shown + persisted) ===");
{
  const r = row("images");
  check("images row starts aria-checked=false", r.getAttribute("aria-checked") === "false", r.getAttribute("aria-checked"));
  r.onclick();   // the live onclick bound at boot
  check("after click, images row aria-checked=true", r.getAttribute("aria-checked") === "true", r.getAttribute("aria-checked"));
  check("after click, settings.sidebarTabs includes images", api.getSettings().sidebarTabs.includes("images"));
  check("after click, persisted to localStorage (shows images)", (LS().sidebarTabs || []).includes("images"), JSON.stringify(LS().sidebarTabs));
}

console.log("\n=== D. Reset to default WORKS (deviate -> reset snaps back) ===");
{
  // Deviate hard: hide all.
  api.$("sidevis-none").onclick();
  check("after hide-all, SHOW list empty", Array.isArray(api.getSettings().sidebarTabs) && api.getSettings().sidebarTabs.length === 0);
  check("after hide-all, images row aria-checked=false", row("images").getAttribute("aria-checked") === "false");
  // The user-named check: reset must actually restore DEFAULTS.
  api.$("sidevis-reset").onclick();
  const def = api.DEFAULTS.sidebarTabs;
  check("after reset, SHOW list == DEFAULTS", JSON.stringify(api.getSettings().sidebarTabs) === JSON.stringify(def), JSON.stringify(api.getSettings().sidebarTabs));
  check("after reset, images/tools hidden again (false)", row("images").getAttribute("aria-checked") === "false" && row("tools").getAttribute("aria-checked") === "false");
  check("after reset, chat shown again (true)", row("chat").getAttribute("aria-checked") === "true");
  check("after reset, localStorage persisted == DEFAULTS", JSON.stringify(LS().sidebarTabs) === JSON.stringify(def), JSON.stringify(LS().sidebarTabs));
}

console.log("\n=== E. USER EXACT PATH: from clean default -> OPEN images -> RESET -> images HIDDEN again ===");
{
  const def = api.DEFAULTS.sidebarTabs;
  check("E-pre: start from clean default (images hidden, aria-checked=false)",
    row("images").getAttribute("aria-checked") === "false" && JSON.stringify(api.getSettings().sidebarTabs) === JSON.stringify(def));
  row("images").onclick();   // step 1: OPEN the images tab
  check("E-1: after OPEN, images aria-checked=true + settings includes it",
    row("images").getAttribute("aria-checked") === "true" && api.getSettings().sidebarTabs.includes("images"));
  check("E-1: DEFAULTS.sidebarTabs NOT polluted by the open (still clean 8, no images)",
    api.DEFAULTS.sidebarTabs.length === 8 && !api.DEFAULTS.sidebarTabs.includes("images"),
    JSON.stringify(api.DEFAULTS.sidebarTabs));
  api.$("sidevis-reset").onclick();   // step 2: click RESET
  // step 3: images must go BACK to hidden (the load-bearing check the fix guarantees)
  check("E-2: after RESET, images aria-checked back to false (the exact user check)",
    row("images").getAttribute("aria-checked") === "false", "got=" + row("images").getAttribute("aria-checked"));
  check("E-2: after RESET, settings.sidebarTabs == clean DEFAULTS (no images)",
    JSON.stringify(api.getSettings().sidebarTabs) === JSON.stringify(def), JSON.stringify(api.getSettings().sidebarTabs));
  check("E-2: after RESET, localStorage persisted == clean DEFAULTS",
    JSON.stringify(LS().sidebarTabs) === JSON.stringify(def), JSON.stringify(LS().sidebarTabs));
}

console.log("\nRESULT: " + (FAILURES.length === 0 ? "ALL PASS" : "FAILURES: " + FAILURES.join(", ")));
process.exit(FAILURES.length === 0 ? 0 : 1);
