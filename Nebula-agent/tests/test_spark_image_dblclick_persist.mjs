/* Gate: after reload (a persisted image keeps only a server ref, NO base64 url AND NO kind
 * field -- that is exactly what the OLD saveChat wrote to storage) the chat EDIT MODAL must still
 * show the thumbnail and its double-click must open the viewer.
 *
 * 2026-10-28 lesson locked here: the previous gate stub fed objects WITH kind:"image", so it went
 * green while real reload data (kind-less rows) was silently skipped by the renderEditAttachments
 * guard. This stub now mirrors the real persisted shape (no kind) -- the differential that was missing.
 *
 * Also locked: the modal's default strategy is hard (first card, DOM template hard|soft|branch
 * and the runtime init now agree), and confirmEdit's fallback is hard.
 *
 * Run standalone: node tests/test_spark_image_dblclick_persist.mjs
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
const check = (label, cond) => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (cond ? "" : "  <-- BROKEN"));
  if (!cond) FAILURES.push(label);
};

const srcText = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

// --- static source locks ------------------------------------------------------------------------
check("openEditModal filter accepts url || ref",
  /editAttachments = \(msg\.images \|\| \[\]\)\.filter\(\(a\) => a && \(a\.url \|\| a\.ref\)\)/.test(srcText));
check("the modal inline renderer accepts a KIND-LESS url/ref entry (no kind required)",
  /function ceSetRich\([\s\S]{0,200}?\.filter\(\(a\) => a && \(a\.url \|\| a\.ref\)\)/.test(srcText));
check("the inline thumbnail gains a dblclick -> openImageView (ref fallback)",
  /addEventListener\("dblclick", \(e\) => \{[^}]*openImageView\(src,/.test(srcText));
check("the inline thumbnail resolves its src with a ref fallback (entry.ref || entry.url)",
  /function makeInlineThumb\([\s\S]{0,200}?entry\.ref \|\| entry\.url/.test(srcText));
check("spark add-box gained a dblclick -> openImageView delegation",
  /addInput\.addEventListener\("dblclick"[\s\S]{0,160}openImageView/.test(srcText));
check("spark list gained a dblclick -> openImageView delegation",
  /list\.addEventListener\("dblclick"[\s\S]{0,160}openImageView/.test(srcText));
check("openEditModal runtime default strategy = hard (agrees with DOM template order hard|soft|branch)",
  /m\.dataset\.strategy = "hard";\r?\n\s*m\.querySelectorAll\("\.edit-strategy__opt"\)\.forEach\(o => o\.setAttribute\("aria-checked", o\.dataset\.v === "hard" \? "true" : "false"\)\)/.test(srcText));
check("confirmEdit fallback strategy = hard",
  /const strategy = m\.dataset\.strategy \|\| "hard";/.test(srcText));

const dom = new JSDOM(fs.readFileSync(path.join(WEB, "index.html"), "utf8"), { url: "http://127.0.0.1/", runScripts: "outside-only" });
const win = dom.window;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
if (!win.document.getElementById("toasts")) { const d = win.document.createElement("div"); d.id = "toasts"; win.document.body.appendChild(d); }
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));

let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += `
;window.__probe = (function () {
  var out = {};
  var imgm = document.getElementById("img-modal"), mimg = document.getElementById("img-modal-img");
  var em = function () { return document.getElementById("edit-modal"); };   // the EDIT MODAL (not the image viewer)
  // ---- FAITHFUL old-storage shape: kind-less ref-only row (what pre-2026-10-28 saveChat wrote) ----
  messages.length = 0;
  messages.push({ role: "user", text: "hello", images: [{ name: "pic.png", pid: 1, ref: "/data/uploads/pic.png" }], files: [], time: Date.now() });
  openEditModal(0);
  var area = document.getElementById("edit-area");
  var t = area && area.querySelector("span.ce-thumb[data-pid]");
  out.modalThumbSurvives = !!(t && t.getAttribute("data-pid"));
  if (t) t.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
  out.modalDblclickOpensRef = !!(imgm && imgm.hidden === false && /\\/data\\/uploads\\/pic\\.png/.test(mimg.getAttribute("src") || ""));

  // ---- default strategy on open = hard, and the checked card is the FIRST one (hard leftmost) ----
  var checked = em().querySelectorAll('.edit-strategy__opt[aria-checked="true"]');
  out.defaultHard = !!(checked.length === 1 && checked[0].getAttribute("data-v") === "hard");
  var cards = em().querySelectorAll(".edit-strategy__opt");
  out.cardOrder = Array.prototype.map.call(cards, function (c) { return c.getAttribute("data-v"); }).join(",");
  closeEditModal();

  // ---- openEditModal hands confirmEdit a hard default AND keeps the kind-less image in the list ----
  messages.length = 0;
  messages.push({ role: "user", text: "before edit", images: [{ name: "pic.png", pid: 1, ref: "/data/uploads/pic.png" }], files: [], time: Date.now() });
  messages.push({ role: "assistant", text: "the answer", images: [], files: [], time: Date.now() });
  openEditModal(0);
  out.confirmDefaultHard = (em().dataset.strategy === "hard");
  out.confirmCarriesImage = !!(editAttachments.length === 1 && /\\/data\\/uploads\\/pic\\.png/.test(editAttachments[0].ref || editAttachments[0].url || ""));
  closeEditModal();

  // ---- spark list (stored note) dblclick delegation opens the viewer ----
  if (imgm) imgm.hidden = true;
  var list = document.getElementById("spark-list");
  list.innerHTML = '<div class="kb-item spark-item"><div class="spark-item__body"><pre class="spark-item__text"><img src="/data/uploads/note.png"></pre></div></div>';
  var noteImg = list.querySelector("img");
  if (noteImg) noteImg.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
  out.sparkListDblclickOpens = !!(imgm && imgm.hidden === false && /\\/data\\/uploads\\/note\\.png/.test(mimg.getAttribute("src") || ""));

  // ---- spark add-box dblclick delegation opens the viewer ----
  if (imgm) imgm.hidden = true;
  var add = document.getElementById("spark-add-input");
  add.innerHTML = '<img src="/data/uploads/pasted.png">';
  var addImg = add.querySelector("img");
  if (addImg) addImg.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
  out.sparkAddDblclickOpens = !!(imgm && imgm.hidden === false && /\\/data\\/uploads\\/pasted\\.png/.test(mimg.getAttribute("src") || ""));

  // ---- negative differential: a text-only spark note must NOT trip the viewer ----
  if (imgm) imgm.hidden = true;
  list.innerHTML = '<div class="kb-item spark-item"><div class="spark-item__body"><pre class="spark-item__text">plain text only</pre></div></div>';
  list.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
  out.noImageDblclickIsNoop = !!(imgm && imgm.hidden === true);
  return out;
})();`;
win.eval(appCode);
const r = win.__probe;

check("edit modal shows a KIND-LESS ref-only image chip (faithful old-storage differential)", r.modalThumbSurvives === true);
check("edit modal thumbnail dblclick opens viewer at the ref (functional)", r.modalDblclickOpensRef === true);
check("default strategy on open = hard (checked card data-v=hard)", r.defaultHard === true);
check("strategy cards order = hard,soft,branch (hard leftmost, soft middle)", r.cardOrder === "hard,soft,branch");
check("confirm path sees strategy=hard and carries the kind-less image", r.confirmDefaultHard === true && r.confirmCarriesImage === true);
check("spark stored-note image dblclick opens viewer (functional)", r.sparkListDblclickOpens === true);
check("spark add-box pasted image dblclick opens viewer (functional)", r.sparkAddDblclickOpens === true);
check("text-only note dblclick is a no-op (negative differential)", r.noImageDblclickIsNoop === true);

console.log("\nSPARK-IMAGE-DBLCLICK-PERSIST: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);