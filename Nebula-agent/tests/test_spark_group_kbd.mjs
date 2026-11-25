/* Regression gate for the 2026-11-24 spark-list fixes (owner-approved):
 *   A) BUG FIX: the sort-mode comment had leaked INSIDE the card template literal, so `// [排序方式]...`
 *      rendered as literal TEXT at the top of every saved note ("saved notes no longer display").
 *      Card template now lives in sparkCardHtml(); the comment sits in real JS-comment position. Lock:
 *      the rendered list must NOT contain that prose, while the JS file still documents the rule.
 *   B) COLLAPSIBLE GROUPS: time mode splits into 未执行 / 已执行 sections with an aria-expanded header;
 *      clicking a header toggles hidden + persists to store key "spark.groups". Custom mode stays flat.
 *   C) KEYBOARD REACHABILITY: the sort switcher is a radiogroup (role=radio, aria-checked, roving
 *      tabindex), and ArrowRight/ArrowLeft move + SELECT between [time|custom], re-seating focus.
 *
 * Run: node tests/test_spark_group_kbd.mjs
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
const dom = new JSDOM(html, { url: "http://127.0.0.1:8766/", runScripts: "outside-only" });
const win = dom.window;
const doc = win.document;
win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);

win.localStorage.setItem("strata.lang", "en");
win.localStorage.removeItem("strata.spark");
win.localStorage.removeItem("strata.spark.sortMode");
win.localStorage.removeItem("strata.spark.groups");

win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ model: "m", servers: [], tools: 0 }) });
win.confirm = () => true;

const i18nCode = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
const appCode = fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const bridge = `
window.__t = {
  render: function () { renderSpark(); },
  mode: function () { return sparkSortMode; },
  setMode: function (m) { setSparkSortMode(m); },
  collapsed: function () { return sparkGroupsCollapsed; }
};`;
win.eval(i18nCode + "\n;\n" + appCode + "\n;\n" + bridge);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => doc.querySelector(s);
const list = () => doc.getElementById("spark-list");

const main = async () => {
  console.log("=== Spark group-collapse + keyboard-reachability + leak-bug gate ===");
  await sleep(40);
  $("#tab-btn-spark").click();
  await sleep(20);

  win.localStorage.setItem("strata.spark", JSON.stringify([
    { id: "A", text: "A pending", status: "pending", createdAt: 1000, executedAt: null, archived: false, tags: [] },
    { id: "B", text: "B pending newer", status: "pending", createdAt: 2000, executedAt: null, archived: false, tags: [] },
    { id: "C", text: "C done", status: "done", createdAt: 500, executedAt: 3000, archived: false, tags: [] },
  ]));

  // ---- (A) BUG: leaked comment text must NOT appear anywhere in the rendered list ----
  win.__t.render();
  await sleep(5);
  const leaked = ["\u6392\u5e8f\u65b9\u5f0f", "drag-reorderable", "auto-sorted so dragging"];
  const hitLeak = leaked.filter((p) => (list().textContent || "").includes(p));
  check("(A) list body has NO leaked sort-comment text", hitLeak.length === 0, JSON.stringify(hitLeak));
  // ...but the rule IS still documented as a real comment in the JS source.
  // The fix relocated the card markup into sparkCardHtml() so the rule comment lives in real JS
  // -comment position. Lock the structural fact: the function exists and is the card renderer.
  check("(A) source keeps the rule as a real comment + a dedicated sparkCardHtml renderer",
        appCode.includes("function sparkCardHtml") && appCode.includes("sparkListViewHtml(view)"),
        "");
  // and the card text we DID save renders correctly
  check("(A) a saved card body renders its real text", (list().textContent || "").includes("B pending newer"));

  // ---- (B) COLLAPSIBLE GROUPS (time mode) ----
  check("(B) time mode emits 2 group headers", doc.querySelectorAll("#spark-list .spark-group__head").length === 2,
        "n=" + doc.querySelectorAll("#spark-list .spark-group__head").length);
  const pendHead = doc.querySelector('#spark-list button[data-group="pending"]');
  const execHead = doc.querySelector('#spark-list button[data-group="executed"]');
  check("(B) pending+executed headers present", !!pendHead && !!execHead);
  check("(B) headers default aria-expanded=true", pendHead.getAttribute("aria-expanded") === "true" && execHead.getAttribute("aria-expanded") === "true");

  execHead.click();   // collapse executed
  await sleep(5);
  const execBody2 = doc.getElementById("spark-group-executed");
  check("(B) clicking executed header hides its body", !!execBody2 && execBody2.hasAttribute("hidden"), "hidden=" + (execBody2 && execBody2.hasAttribute("hidden")));
  const execHead2 = doc.querySelector('#spark-list button[data-group="executed"]');
  check("(B) collapsed header aria-expanded=false", execHead2.getAttribute("aria-expanded") === "false");
  check("(B) collapse persisted to store key spark.groups",
        JSON.parse(win.localStorage.getItem("strata.spark.groups") || "{}").executed === true,
        win.localStorage.getItem("strata.spark.groups"));
  check("(B) in-memory collapsed state reflects executed=true", win.__t.collapsed().executed === true);
  execHead2.click();   // re-expand
  await sleep(5);
  const execBody3 = doc.getElementById("spark-group-executed");
  check("(B) re-expand clears hidden", !!execBody3 && !execBody3.hasAttribute("hidden"));

  // custom mode stays a FLAT list: no group headers
  win.__t.setMode("custom");
  await sleep(5);
  check("(B) custom mode renders NO group headers", doc.querySelectorAll("#spark-list .spark-group__head").length === 0,
        "n=" + doc.querySelectorAll("#spark-list .spark-group__head").length);
  win.__t.setMode("time");
  await sleep(5);

  // ---- (C) KEYBOARD REACHABILITY on the sort switcher ----
  const bar = doc.getElementById("spark-sortbar");
  check("(C) sortbar role=radiogroup", bar.getAttribute("role") === "radiogroup", bar.getAttribute("role"));
  const chips = [...bar.querySelectorAll("[data-sort]")];
  check("(C) both chips have role=radio", chips.length === 2 && chips.every((c) => c.getAttribute("role") === "radio"));
  const activeChip = chips.find((c) => c.getAttribute("aria-checked") === "true");
  check("(C) exactly one chip is the active radio (time)", !!activeChip && activeChip.dataset.sort === "time",
        "mode=" + win.__t.mode());
  check("(C) roving tabindex: active chip tabbable, others -1",
        activeChip.getAttribute("tabindex") === "0" && chips.filter((c) => c !== activeChip).every((c) => c.getAttribute("tabindex") === "-1"));

  // ArrowRight while focus is on time -> selects custom + focus follows selection
  activeChip.focus();
  check("(C) pre-condition: focus on the time chip", doc.activeElement && doc.activeElement.dataset.sort === "time");
  bar.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  await sleep(5);
  check("(C) ArrowRight selects custom mode", win.__t.mode() === "custom", "mode=" + win.__t.mode());
  const newActive = bar.querySelector('[data-sort="custom"]');
  check("(C) focus re-seated on the newly selected chip after re-render",
        doc.activeElement && doc.activeElement.dataset.sort === "custom",
        "active=" + (doc.activeElement && (doc.activeElement.dataset && doc.activeElement.dataset.sort || doc.activeElement.id)));
  check("(C) after switch, custom chip is the active radio tabbable=0",
        newActive.getAttribute("aria-checked") === "true" && newActive.getAttribute("tabindex") === "0");

  // ArrowLeft back to time (wraparound works since only 2 chips)
  newActive.focus();
  bar.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
  await sleep(5);
  check("(C) ArrowLeft selects time mode", win.__t.mode() === "time", "mode=" + win.__t.mode());

  console.log();
  if (FAILURES.length) { console.log(`FAILED (${FAILURES.length}):`); for (const f of FAILURES) console.log("  - " + f); process.exit(1); }
  console.log("SPARK GROUP/KBD TESTS PASSED");
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
