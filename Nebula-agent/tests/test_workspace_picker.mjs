/* Regression test for the workspace picker's folder browser.

   The browser's own "Browse" (File System Access API) cannot reveal a folder's absolute
   path, so the picker used to either warn or, worse, silently create a new empty folder
   under the server root while the user thought they had picked a real one. This test pins
   the replacement: an in-app browser that reads the tree from the server and returns the
   absolute path, plus an always-visible resolved-path line.

   Run: node tests/test_workspace_picker.mjs
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(path.resolve(HERE, ".."), "serve", "web");

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const dom = new JSDOM(fs.readFileSync(path.join(WEB, "index.html"), "utf8"),
                      {url: "http://127.0.0.1:8765/", runScripts: "outside-only"});
const win = dom.window, doc = dom.window.document;
win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.matchMedia = () => ({matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; }});
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
win.confirm = () => true;
win.localStorage.setItem("strata.lang", "en");

// A fake filesystem the mocked /workspace/list serves. Each absolute path maps to its
// immediate sub-folders. Missing -> exists:false. This is the server's view of the disk.
const FS = {
  "C:\\": ["Users", "Work", "Windows"],
  "C:\\Users": ["sk", "admin"],
  "C:\\Users\\sk": ["Documents", "my-project", "secret-project"],
  "C:\\Users\\sk\\my-project": ["src", "tests"],
  "C:\\Users\\sk\\Documents": ["report.docx"],
};
function answerFor(url) {
  const q = String(url).split("?")[1] || "";
  const m = q.match(/path=([^&]*)/);
  const raw = m ? decodeURIComponent(m[1]) : "";
  const drives = Object.keys(FS).filter((k) => k.endsWith(":\\")).map((p) => ({name: p.replace(":\\", ":"), path: p}));
  const places = [{name: "项目根目录", path: "C:\\Work"}];
  if (!raw) return {drives, places, listing: null};
  const norm = raw.replace(/\//g, "\\");
  const dirs = (FS[norm] || []).map((n) => ({name: n, path: norm.endsWith("\\") ? norm + n : norm + "\\" + n, hidden: n.startsWith(".")}));
  const exists = norm in FS;
  const parent = exists && !/:\\$/.test(norm) ? norm.slice(0, norm.lastIndexOf("\\")) : null;
  return {drives, places, listing: {path: norm, parent, dirs, exists, readable: exists}};
}
const creates = [];
win.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("workspace/list")) return {ok: true, status: 200, json: async () => answerFor(u)};
  if (u.includes("workspace/create")) {
    const body = JSON.parse(opts.body || "{}");
    const path = "C:\\Work\\" + body.name;          // the server would create under its root
    creates.push(path);
    return {ok: true, status: 200, json: async () => ({path})};
  }
  if (u.includes("models/config")) return {ok: true, status: 200, json: async () => ({selected: "self", models: [{id: "self", name: "self", kind: "local", base_url: ""}]})};
  if (u.endsWith("health")) return {ok: true, status: 200, json: async () => ({model: "m", max_context: 32768})};
  return {ok: true, status: 200, json: async () => ({})};
};

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
let code = fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8");  // app_utils before app.js (matches index.html)
code += `
;window.__api = {
  openBrowser, closeBrowser, wbLoad, wbChoose, updateResolved,
  pathVal: () => document.getElementById("ws-path").value,
  resolvedText: () => document.getElementById("ws-resolved").textContent,
  resolvedClass: () => document.getElementById("ws-resolved").className,
  browseRows: () => [...document.querySelectorAll("#ws-browse-list .ws-browse__row")].map((r) => r.dataset.path),
  browseCurrent: () => document.getElementById("ws-browse-current").textContent,
  places: () => [...document.querySelectorAll("#ws-browse-places .ws-browse__place")].map((b) => b.dataset.path),
  noteHidden: () => document.getElementById("ws-browse-note").hidden,
};`;
win.eval(code);
const api = win.__api;
const $ = (id) => doc.getElementById(id);
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const byData = (sel, p) => [...doc.querySelectorAll(sel)].find((n) => n.dataset.path === p);

console.log("\n=== T1: 浏览 opens the in-app browser with drive/place shortcuts ===");
$("ws-pick").click();
await wait();
check("the browser modal opened", !$("ws-browse").hidden);
check("drives/places shortcuts are rendered  " + JSON.stringify(api.places()),
      api.places().length >= 2 && api.places().includes("C:\\"));
check("at root (no path yet) the folder list is empty — you start from a drive", api.browseRows().length === 0);

console.log("\n=== T2: clicking a drive descends into it ===");
byData("#ws-browse-places .ws-browse__place", "C:\\").click();
await wait();
check("the list now shows that drive's folders  " + JSON.stringify(api.browseRows()),
      JSON.stringify(api.browseRows()) === JSON.stringify(["C:\\Users", "C:\\Work", "C:\\Windows"]));
check("the breadcrumb path follows  " + JSON.stringify($("ws-browse-current").textContent),
      $("ws-browse-current").textContent === "C:\\");
check("no crash note for an existing folder", api.noteHidden() === true);

console.log("\n=== T3: clicking a folder descends one level ===");
byData("#ws-browse-list .ws-browse__row", "C:\\Users").click();
await wait();
check("the list now shows that folder's children (+ an up row)  " + JSON.stringify(api.browseRows()),
      JSON.stringify(api.browseRows()) === JSON.stringify(["C:", "C:\\Users\\sk", "C:\\Users\\admin"]));
check("the breadcrumb path follows  " + JSON.stringify($("ws-browse-current").textContent),
      $("ws-browse-current").textContent === "C:\\Users");

console.log("\n=== T3b: a place shortcut jumps straight there ===");
byData("#ws-browse-places .ws-browse__place", "C:\\Work").click();
await wait();
check("jumping to a place shows its contents  " + JSON.stringify(api.browseRows()),
      JSON.stringify(api.browseRows()) === JSON.stringify([]));

console.log("\n=== T4: choosing returns the REAL absolute path, never a leaf name ===");
await api.wbLoad("C:\\Users\\sk\\my-project");
check("the current target is the full path  " + JSON.stringify(api.browseCurrent()),
      api.browseCurrent() === "C:\\Users\\sk\\my-project");
api.wbChoose();
check("the picker input now holds the absolute path", api.pathVal() === "C:\\Users\\sk\\my-project");
check("the browser modal closed", $("ws-browse").hidden);

console.log("\n=== T5: the resolved line shows the absolute path and its existence ===");
$("ws-path").value = "C:\\Users\\sk\\Documents";
$("ws-path").dispatchEvent(new win.Event("input"));
await wait(420);                                 // debounce is 350ms
check("an existing path reads as OK  " + JSON.stringify(api.resolvedText()),
      api.resolvedText() === "C:\\Users\\sk\\Documents" && /ok/.test(api.resolvedClass()));

console.log("\n=== T6: a non-existent path is flagged, not silently accepted ===");
$("ws-path").value = "C:\\Users\\sk\\nope";
$("ws-path").dispatchEvent(new win.Event("input"));
await wait(420);
check("a missing path reads as BAD  " + JSON.stringify(api.resolvedClass()), /bad/.test(api.resolvedClass()));

console.log("\n=== T7: a missing folder in the browser does not throw — it shows a note ===");
await api.wbLoad("C:\\Users\\sk\\nope");
check("no rows for a missing folder", api.browseRows().length === 0);
check("the gone-note is shown", api.noteHidden() === false);

// backdrop no longer closes the workspace FORM modal; Esc is the keyboard exit (2026-11-22)
console.log("\n=== T8: ws-modal survives a backdrop click (typed path kept); only Esc closes it ===");
$("ws-modal").hidden = false;                                  // fixture: open the picker
$("ws-path").value = "C:\\Users\\sk\\half-typed";
$("ws-modal").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
check("a backdrop click does NOT close the form (typed path survives, load-bearing)",
      $("ws-modal").hidden === false && $("ws-path").value === "C:\\Users\\sk\\half-typed");
$("ws-modal").dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
check("Escape still closes it (explicit keyboard exit intact)", $("ws-modal").hidden === true);

console.log("");
if (FAILURES.length) {
  console.log(`WORKSPACE PICKER: ${FAILURES.length} FAILED`);
  FAILURES.forEach((f) => console.log("  - " + f));
} else {
  console.log("WORKSPACE PICKER: ALL PASSED");
}
process.exit(FAILURES.length ? 1 : 0);
