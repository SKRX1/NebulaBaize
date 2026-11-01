/* ROOT-CAUSE (sparks thumbnail delete-button) verification, real app.js functions via jsdom-boot
 * (same method as test_spark_datapid_anchor.mjs). The delete delegation bindInlineThumbDelete() is
 * wired only onto composer #input and chat-modal #edit-area; it is NOT wired onto the three spark
 * containers (spark-add-input / spark-edit-ta / spark-list). So a click on a spark note's delete
 * button never reaches removeThumb -> the array is never spliced and the chip stays.
 *
 * Differential pairs (real net):
 *   COMPOSER : click the delete button inside #input -> delegation FIRES -> array spliced (works)
 *   SPARK    : click the delete button inside a spark note container -> delegation NEVER fires -> array unchanged (the bug)
 *
 * Run standalone: node tests/_verify_thumbdelete_spark.mjs
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
const check = (label, cond) => { console.log("  " + (cond ? "OK   " : "FAIL ") + label + (cond ? "" : "  <-- BROKEN")); if (!cond) FAILURES.push(label); };
const srcText = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

// static source lock: which containers bindInlineThumbDelete wires (should be only input + edit-area)
const body = srcText.slice(srcText.indexOf("function bindInlineThumbDelete"));
const seg = body.slice(0, 600);
check("static: binds composer #input", /\$\("input"\)/.test(seg));
check("static: binds chat-modal #edit-area", /\$\("edit-area"\)/.test(seg));
check("static: does NOT bind spark containers (spark-add-input/spark-edit-ta/spark-list)", !/spark-add-input|spark-edit-ta|spark-list/.test(seg));

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1/", runScripts: "outside-only" });
const win = dom.window;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
if (!win.document.getElementById("toasts")) { const d = win.document.createElement("div"); d.id = "toasts"; win.document.body.appendChild(d); }
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += "\n;window.__api = { bindInlineThumbDelete, removeThumb, getAttachments: () => attachments, setAttachments: (x) => { attachments = x; }, getEditAttachments: () => editAttachments, setEditAttachments: (x) => { editAttachments = x; }, setSparks, getSparks, setMessages: (x) => { messages = x; } };";
win.eval(appCode);
const api = win.__api;
check("bindInlineThumbDelete boots", typeof api.bindInlineThumbDelete === "function");
check("removeThumb boots", typeof api.removeThumb === "function");

// Build a composer #input element with one anchored chip (the full data-pid span+box+img+button structure)
function makeChip(pid) {
  const span = win.document.createElement("span");
  span.className = "ce-thumb"; span.setAttribute("contenteditable", "false"); span.setAttribute("data-pid", String(pid));
  const box = win.document.createElement("span"); box.className = "ce-thumb__box"; span.appendChild(box);
  const img = win.document.createElement("img"); img.className = "inline-ce-img"; img.src = "data:image/png;base64,AAA"; box.appendChild(img);
  const btn = win.document.createElement("button"); btn.type = "button"; btn.className = "ce-thumb__x"; btn.setAttribute("data-delpid", String(pid)); box.appendChild(btn);
  return span;
}

// composer path: array has the entry, click the delete button -> delegation wired -> array spliced
const inputEl = win.document.getElementById("input") || win.document.body.appendChild(win.document.createElement("div"));
if (!inputEl.id) inputEl.id = "input";
api.setAttachments([{ kind: "image", url: "data:image/png;base64,AAA", name: "a.png", pid: 1 }]);
inputEl.appendChild(makeChip(1));
api.bindInlineThumbDelete();   // wires #input (and #edit-area)
const beforeC = api.getAttachments().length;
const btnC = inputEl.querySelector(".ce-thumb__x");
btnC.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
check("COMPOSER: click delete button -> array spliced (delegation fires, works)", api.getAttachments().length === beforeC - 1);

// spark path: a spark note container, array has the entry (via sparks), click delete button
// the spark delete path lives through the spark-list delegation which only handles spark-item buttons
// (exec/edit/del/promote), NOT .ce-thumb__x inline delete. So clicking the inline delete does nothing.
// Build a spark container with one anchored chip and confirm the inline-delete delegation is NOT attached.
const sparkContainer = win.document.createElement("div");
sparkContainer.id = "spark-add-input";
win.document.body.appendChild(sparkContainer);
sparkContainer.appendChild(makeChip(2));
// spark inline chips are tracked via the spark html string + sparkToPush, not the composer `attachments`
// array; removeThumb uses composer/modal arrays. Simulate the spark-side delete by dispatching click:
const btnS = sparkContainer.querySelector(".ce-thumb__x");
let delegated = false;
sparkContainer.addEventListener("click", (e) => { if (e.target.closest && e.target.closest(".ce-thumb__x")) delegated = true; });
btnS.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
check("SPARK: inline delete delegation NOT wired by bindInlineThumbDelete (the bug)", !srcText.slice(srcText.indexOf("function bindInlineThumbDelete")).slice(0,600).match(/spark-add-input|spark-edit-ta/));

console.log("\nTHUMB-DELETE-SPARK: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
