/* jsdom behaviour gate - ROOT-CAUSE lock for the "sidebar silently all-hidden" bug.

   Reported symptom (screenshot): after pushing a spark (note) into the chat task, the LEFT
   sidebar went hidden on EVERY tab; only "reset to default" fixed it.

   Root cause: the sampling "Apply" handler (app.js s-apply) rebuilds the WHOLE settings object
   with an object literal that does NOT carry sidebarTabs. That leaves the in-memory
   settings.sidebarTabs === undefined. sidebarVisApply() used to read `settings.sidebarTabs || []`
   -> [] -> the show-list looks empty -> body gets .no-sidebar on every tab. (Persistence via the
   separate strata.sidebar.tabs key was fine, so a reload restored it -- but the live session stayed
   broken until reset.)

   Fix: sidebarVisApply()/renderSidebarSettings() now read the AUTHORITATIVE strata.sidebar.tabs key
   through sidebarShowList(), not the volatile in-memory field. So any path that rebuilds settings
   (s-apply or future ones) can no longer blank the sidebar at runtime.

   The gate is load-bearing: revert sidebarVisApply to `settings.sidebarTabs || []` and C-1 goes red
   (the simulated clobber would hide chat).

   Run: node tests/test_sidevis_sapply_clobber_jsdom.mjs
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

appCode += `
;window.__api = {
  DEFAULTS,
  getSettings: () => settings,
  sidebarVisApply,
  sidebarShowList,
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
win.eval(appCode);

const api = win.__api;
const noSidebar = () => win.document.body.classList.contains("no-sidebar");
const setAuthKey = (arr) => win.localStorage.setItem("strata.sidebar.tabs", JSON.stringify(arr));

console.log("\n=== A. helper reads the authoritative key (not the in-memory field) ===");
{
  const def = api.DEFAULTS.sidebarTabs;
  setAuthKey(def);
  // memory field disagrees with the key -> helper MUST follow the key
  api.getSettings().sidebarTabs = ["chat"];
  const got = api.sidebarShowList();
  check("A-1: sidebarShowList returns the strata.sidebar.tabs key, not settings.sidebarTabs",
    JSON.stringify(got) === JSON.stringify(def), JSON.stringify(got));
}

console.log("\n=== B. THE CLOBBER SCENARIO (spark push -> s-apply rebuilt settings, sidebarTabs gone) ===");
{
  const def = api.DEFAULTS.sidebarTabs;
  setAuthKey(def);                 // authoritative key holds the full show list (chat present)
  api.getSettings().sidebarTabs = undefined;   // simulate s-apply's rebuild dropping the field
  api.sidebarVisApply("chat");     // showTab("chat") path
  check("B-1: chat still shows the sidebar after settings.sidebarTabs was clobbered to undefined",
    !noSidebar(), "no-sidebar=" + noSidebar());
  api.sidebarVisApply("images");   // images is NOT in DEFAULTS -> must hide
  check("B-2: images (not in show list) still hides the sidebar (single-variable contrast)",
    noSidebar(), "no-sidebar=" + noSidebar());
}

console.log("\n=== C. load-bearing differential: with BOTH sources blank, fallback = [] -> hidden ===");
{
  win.localStorage.removeItem("strata.sidebar.tabs");   // authoritative key absent
  api.getSettings().sidebarTabs = undefined;            // and in-memory field also gone
  api.sidebarVisApply("chat");
  check("C-1: no key + no field -> empty show list -> chat hidden (proves the helper is what rescues B-1)",
    noSidebar(), "no-sidebar=" + noSidebar());
}

console.log("\nRESULT: " + (FAILURES.length === 0 ? "ALL PASS" : "FAILURES: " + FAILURES.join(", ")));
process.exit(FAILURES.length === 0 ? 0 : 1);
