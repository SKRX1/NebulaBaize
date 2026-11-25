/* Regression test for "编辑态下禁拖" (note-edit must not be card-draggable).
 *
 * WHY: the .spark-item template is permanently draggable="true" (note reorder). Leaving it on
 * while editing a note lets a native dragstart fire the instant the caret selection escapes the
 * text into card padding -- the "selecting past the text turns into a card-drag" bug. The fix
 * drops draggable for THIS card on entering edit mode (editSpark); leaving edit mode rebuilds the
 * list via renderSpark() and restores it. This gate drives the REAL handlers in jsdom:
 *   - before edit:        card draggable === "true"   (reorder capability intact)
 *   - after clicking edit: card draggable === "false"  (selection in the editor is not hijacked)
 *   - the tag input (a native <input>, lives inside this card) is therefore on a non-draggable
 *     card too, so selecting text in it is doubly safe (native inputs already never get hijacked
 *     by an ancestor's HTML5 drag)
 *   - after cancel:        card draggable === "true"   (renderSpark restored it)
 * It complements test_spark.mjs M3-C, which proves non-edit reorder still works (it dispatches
 * dragstart on a non-edit card, unaffected by the attribute).
 *
 * Run: node tests/test_spark_edit_nodrag.mjs
 */
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
win.localStorage.removeItem("strata.spark");
win.localStorage.removeItem("strata.spark_memory");
win.localStorage.removeItem("strata.chat");
win.localStorage.setItem("strata.spark.sortMode", JSON.stringify("custom"));   // store.get JSON.parses the value   // 2026-11-24: this gate is about the DRAG-able (custom) mode -- time mode disables ALL dragging, so exercise custom so the non-edit card is draggable="true" (test_spark_sort.mjs owns the time-mode no-drag behaviour).

win.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model" }) };
  if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
  return { ok: true, status: 200, json: async () => ({}) };
};
win.confirm = () => true;

const i18nCode = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
const utilsCode = fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8");
const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
win.eval(i18nCode + "\n;\n" + utilsCode + "\n;\n" + appCode);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => doc.querySelector(s);

const main = async () => {
  console.log("=== Sparks edit-mode no-drag regression ===");
  await sleep(40);

  // seed one spark via the tab add box (with a tag so the tag input is populated)
  $("#tab-btn-spark").click();
  await sleep(20);
  $("#spark-add-input").textContent = "drag me only when NOT editing";
  const at = $("#spark-add-tags"); if (at) at.value = "perf, cache";
  $("#spark-add-btn").click();

  const card = () => $("#spark-list .spark-item");
  const id = card().dataset.id;

  // (1) non-edit: card is reorder-draggable
  check("non-edit card is draggable=true", card().getAttribute("draggable") === "true",
        `got=${card().getAttribute("draggable")}`);

  // (2) enter edit mode -> this card must stop being draggable (selection won't become a card-drag)
  card().querySelector(".spark-edit").click();
  await sleep(10);
  check("edit rich box present", !!$(`#spark-list .spark-item[data-id="${id}"] .spark-edit-ta`));
  check("edit-mode card is draggable=false", card().getAttribute("draggable") === "false",
        `got=${card().getAttribute("draggable")}`);

  // (2b) the tag input must exist AND live inside this non-draggable card, so selecting text in it
  //      is not hijacked by a card drag (double-safe: native <input> selections are never taken by
  //      an ancestor's HTML5 drag, and now the card itself is draggable=false anyway).
  const tagInput = $(`#spark-list .spark-item[data-id="${id}"] .spark-edit-tags`);
  check("edit-mode tag input present", !!tagInput);
  check("tag input lives inside the draggable=false card", !!tagInput && tagInput.closest(".spark-item") === card()
        && card().getAttribute("draggable") === "false");

  // (3) cancel -> renderSpark rebuilds the list and restores reorder capability
  card().querySelector(".spark-edit-cancel").click();
  await sleep(10);
  check("after cancel card is draggable=true again", card().getAttribute("draggable") === "true",
        `got=${card().getAttribute("draggable")}`);

  console.log();
  if (FAILURES.length) { console.log(`FAILED (${FAILURES.length}):`); for (const f of FAILURES) console.log("  - " + f); process.exit(1); }
  console.log("SPARK EDIT NO-DRAG PASSED");
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
