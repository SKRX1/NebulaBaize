/* Regression test for "编辑态图片禁拖" (a note-image must never start a CARD drag while editing).
 *
 * WHY: an <img> is natively draggable, and setting the CARD to draggable=false does NOT stop a
 * DESCENDANT image (the draggable attribute does not inherit). Dragging a pasted/existing note
 * image fired a dragstart that bubbled to the list reorder delegation (bindSparks -> list dragstart
 * -> reorderSpark), so the whole card got dragged while editing -- even though selection in the text
 * was already fixed by test_spark_edit_nodrag.mjs. The fix in editSpark (a) marks every image already
 * in the editor draggable=false, and (b) puts a one-shot dragstart guard on the editor box that
 * cancel+stops any drag originating inside it (covers images pasted AFTER edit began). The guard is
 * on the editor box, which renderSpark() destroys on save/cancel, so it self-expires on exit.
 *
 * This gate drives the REAL handlers in jsdom:
 *   - a spark whose html holds a <img data:...>  -> after editSpark, that image must be draggable=false
 *   - dispatching a cancelable dragstart inside the editor must be PREVENTED (guard ran)
 *   - and must NOT set the module-scoped sparkDragId (the reorder delegation never fired)
 *
 * Run: node tests/test_spark_edit_imgdrag.mjs
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

win.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model" }) };
  if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
  return { ok: true, status: 200, json: async () => ({}) };
};
win.confirm = () => true;

const i18nCode = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
const appCode = fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8");
// Bridge in the SAME eval so the test can read the module-scoped reorder id (a separate
// win.eval cannot see app.js's top-level `let`).
const bridge = `\nwindow.__t = { dragId: function () { return sparkDragId; },
  setDrag: function (v) { sparkDragId = v; } };`;
win.eval(i18nCode + "\n;\n" + appCode + "\n;\n" + bridge);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => doc.querySelector(s);

const main = async () => {
  console.log("=== Sparks edit-mode IMAGE no-drag regression ===");
  await sleep(40);

  // Seed a spark whose body carries an inline image (data: URL is sanitizer-safe).
  $("#tab-btn-spark").click();
  await sleep(20);
  const ed0 = $("#spark-add-input");
  ed0.innerHTML = "look at this<img src=\"data:image/png;base64,iVBORw0KGgo=\" alt=\"shot\">";
  $("#spark-add-btn").click();
  await sleep(10);

  // store-level: the saved html must keep the img (proves sanitize kept the data: src)
  const stored = JSON.parse(win.localStorage.getItem("strata.spark") || "[]");
  check("seed spark kept an inline <img> in html", /<img\b[^>]*data:image/i.test(stored[0].html || ""),
        (stored[0].html || "").slice(0, 80));

  // enter edit mode on that card
  const card = () => $("#spark-list .spark-item");
  const id = card().dataset.id;
  card().querySelector(".spark-edit").click();
  await sleep(10);

  const ta = $(`#spark-list .spark-item[data-id="${id}"] .spark-edit-ta`);
  check("edit box present", !!ta);
  const img = ta && ta.querySelector("img");
  check("editor box contains the image", !!img);

  // (1) the image that was already in the note must be hard-disabled for dragging
  check("already-present image is draggable=false", !!img && img.getAttribute("draggable") === "false",
        img ? "got=" + img.getAttribute("draggable") : "no img");

  // (2) a drag that originates inside the editor must be cancelled (guard ran -> dispatch returns false)
  //     AND must not arm the reorder (sparkDragId stays null -> list delegation never fired).
  win.__t.setDrag(null);
  const ev = new win.Event("dragstart", { bubbles: true, cancelable: true });
  const notPrevented = (img || ta).dispatchEvent(ev);
  check("in-editor dragstart was prevented (guard ran)", notPrevented === false,
        "dispatch returned " + notPrevented);
  check("reorder delegation did NOT fire (sparkDragId still null)", win.__t.dragId() === null,
        "sparkDragId=" + win.__t.dragId());

  console.log();
  if (FAILURES.length) { console.log(`FAILED (${FAILURES.length}):`); for (const f of FAILURES) console.log("  - " + f); process.exit(1); }
  console.log("SPARK EDIT IMG NO-DRAG PASSED");
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
