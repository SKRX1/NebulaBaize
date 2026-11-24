/* Regression test for the two-mode note sort (time vs custom) — 2026-11-24.
 *
 * Design (owner-approved):
 *   - sparkSortMode, own store key "spark.sortMode", default "time".
 *   - "time"  = render-only auto sort, NOT persisted. Group 1 (never executed) on top, newest
 *               createdAt first; group 2 (executed) below, executedAt DESC so the OLDEST executed
 *               sinks to the very bottom. Dragging is DISABLED (draggable=false) because an
 *               auto-sorted list should not be hand-dragged.
 *   - "custom"= the stored array order verbatim; switching time->custom seeds the stored array to
 *               the current time view (a sensible baseline) and ENABLES drag reorder.
 *
 * This gate drives the REAL handlers in jsdom:
 *   (1) time mode -> list order is [unexecuted newest, unexecuted older, executed newest, executed oldest]
 *   (2) time mode -> cards draggable=false
 *   (3) setSparkSortMode("custom") -> stored array re-seeded to that exact order; cards draggable=true
 *   (4) setSparkSortMode("time")   -> back to auto sort + draggable=false again
 *
 * Run: node tests/test_spark_sort.mjs
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

win.localStorage.setItem("strata.lang", "en");
win.localStorage.removeItem("strata.chat");
win.localStorage.removeItem("strata.spark_memory");
win.localStorage.removeItem("strata.spark.sortMode");

win.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model" }) };
  if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
  return { ok: true, status: 200, json: async () => ({}) };
};
win.confirm = () => true;

const i18nCode = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const bridge = `
window.__t = {
  render: function () { renderSpark(); },
  mode: function () { return sparkSortMode; },
  setMode: function (m) { setSparkSortMode(m); },
  cmp: function (a, b) { return sparkTimeCompare(a, b); },
  isExec: function (s) { return sparkIsExecuted(s); }
};`;
win.eval(i18nCode + "\n;\n" + appCode + "\n;\n" + bridge);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => doc.querySelector(s);
const listIds = () => [...doc.querySelectorAll("#spark-list .spark-item")].map((el) => el.dataset.id);
const dragFlags = () => [...doc.querySelectorAll("#spark-list .spark-item")].map((el) => el.getAttribute("draggable"));
const stored = () => JSON.parse(win.localStorage.getItem("strata.spark") || "[]");

const main = async () => {
  console.log("=== Spark two-mode sort (time vs custom) regression ===");
  await sleep(40);
  $("#tab-btn-spark").click();
  await sleep(20);

  // Seed a mix straight into storage: A/B unexecuted (createdAt old->new), C/D executed (executedAt).
  win.localStorage.setItem("strata.spark", JSON.stringify([
    { id: "A", text: "A pending old", status: "pending", createdAt: 1000, executedAt: null, archived: false, tags: [] },
    { id: "B", text: "B pending new", status: "pending", createdAt: 2000, executedAt: null, archived: false, tags: [] },
    { id: "C", text: "C done new",   status: "done",    createdAt: 500,  executedAt: 3000, archived: false, tags: [] },
    { id: "D", text: "D done old",   status: "done",    createdAt: 400,  executedAt: 1000, archived: false, tags: [] },
  ]));

  // ---- (1)+(2) default time mode
  check("default mode is time", win.__t.mode() === "time", "got=" + win.__t.mode());
  win.__t.render();
  await sleep(5);
  const order = listIds();
  check("time order: unexecuted new->old on top, executed new->old below (oldest bottom)",
        JSON.stringify(order) === JSON.stringify(["B", "A", "C", "D"]), JSON.stringify(order));
  check("time mode -> every card draggable=false", dragFlags().every((d) => d === "false"),
        JSON.stringify(dragFlags()));

  // comparator unit assertions (independent of render)
  const unexec = { status: "pending", createdAt: 1, executedAt: null };
  const execOld = { status: "done", createdAt: 0, executedAt: 1 };
  const execNew = { status: "done", createdAt: 0, executedAt: 9 };
  check("cmp puts unexecuted before executed", win.__t.cmp(unexec, execOld) < 0);
  check("cmp puts newer unexecuted before older", win.__t.cmp({ status: "pending", createdAt: 5, executedAt: null }, { status: "pending", createdAt: 1, executedAt: null }) < 0);
  check("cmp puts executed newer before executed older", win.__t.cmp(execNew, execOld) < 0);

  // ---- (3) switch to custom: seed stored array to the time view, enable drag
  win.__t.setMode("custom");
  await sleep(5);
  const storedOrder = stored().map((s) => s.id);
  check("custom switch seeds stored order = prior time view", JSON.stringify(storedOrder) === JSON.stringify(["B", "A", "C", "D"]),
        JSON.stringify(storedOrder));
  check("custom mode -> every card draggable=true", dragFlags().every((d) => d === "true"),
        JSON.stringify(dragFlags()));
  check("spark.sortMode persisted as custom", JSON.parse(win.localStorage.getItem("strata.spark.sortMode") || "null") === "custom");

  // a manual custom reorder now must persist the new array order (drag path works in custom only)
  const arr = stored();
  arr.push(arr.splice(0, 1)[0]);   // move head to tail -> [A,C,D,B]
  win.localStorage.setItem("strata.spark", JSON.stringify(arr));
  win.__t.render();
  await sleep(5);
  check("custom order follows stored array verbatim", JSON.stringify(listIds()) === JSON.stringify(["A", "C", "D", "B"]),
        JSON.stringify(listIds()));

  // ---- (4) switch back to time: auto sort again + drag disabled
  win.__t.setMode("time");
  await sleep(5);
  // stored was [A,C,D,B]; time view recomputes: unexecuted B(new,2000) before A(old,1000) -> B,A;
  // executed C(3000) before D(1000) -> C,D. So the view is [B,A,C,D] regardless of the stored order.
  check("back to time -> re-sorted view [B,A,C,D] (stored order ignored)", JSON.stringify(listIds()) === JSON.stringify(["B", "A", "C", "D"]),
        JSON.stringify(listIds()));
  // time view from that array: unexecuted B(new) A(old) -> B,A; executed C(3000) D(1000) -> C,D => [B,A,C,D]
  check("back to time -> every card draggable=false", dragFlags().every((d) => d === "false"),
        JSON.stringify(dragFlags()));

  console.log();
  if (FAILURES.length) { console.log(`FAILED (${FAILURES.length}):`); for (const f of FAILURES) console.log("  - " + f); process.exit(1); }
  console.log("SPARK SORT TESTS PASSED");
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
