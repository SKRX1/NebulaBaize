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

check("openEditModal filter accepts url || ref",
  /editAttachments = \(msg\.images \|\| \[\]\)\.filter\(\(a\) => a && \(a\.url \|\| a\.ref\)\)/.test(srcText));
check("renderEditAttachments guard accepts url || ref",
  /if \(a\.kind === "image" && \(a\.url \|\| a\.ref\)\)/.test(srcText));
check("renderEditAttachments img src falls back to ref",
  /im\.src = a\.url \|\| a\.ref/.test(srcText));
check("renderEditAttachments dblclick openImageView falls back to ref",
  /openImageView\(a\.url \|\| a\.ref, a\.name\)/.test(srcText));
check("spark add-box gained a dblclick -> openImageView delegation",
  /addInput\.addEventListener\("dblclick"[\s\S]{0,160}openImageView/.test(srcText));
check("spark list gained a dblclick -> openImageView delegation",
  /list\.addEventListener\("dblclick"[\s\S]{0,160}openImageView/.test(srcText));

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
  // ---- edit modal: a REF-ONLY image (post-reload state) must still render a thumbnail ----
  messages.length = 0;
  // kind:"image" mirrors what addFiles writes for a real pasted/dropped picture
  messages.push({ role: "user", text: "hello", images: [{ kind: "image", name: "pic.png", pid: 1, ref: "/data/uploads/pic.png" }], files: [], time: Date.now() });
  openEditModal(0);
  var box = document.getElementById("edit-attachments");
  var t = box && box.querySelector(".att-thumb img");
  out.modalThumbSurvives = !!(t && /\\/data\\/uploads\\/pic\\.png/.test(t.getAttribute("src") || ""));
  if (t) t.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
  var modal = document.getElementById("img-modal"), mimg = document.getElementById("img-modal-img");
  out.modalDblclickOpensRef = !!(modal && modal.hidden === false && /\\/data\\/uploads\\/pic\\.png/.test(mimg.getAttribute("src") || ""));
  closeEditModal();

  // ---- spark list (stored note) dblclick delegation opens the viewer ----
  if (modal) modal.hidden = true;
  var list = document.getElementById("spark-list");
  list.innerHTML = '<div class="kb-item spark-item"><div class="spark-item__body"><pre class="spark-item__text"><img src="/data/uploads/note.png"></pre></div></div>';
  var noteImg = list.querySelector("img");
  if (noteImg) noteImg.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
  out.sparkListDblclickOpens = !!(modal && modal.hidden === false && /\\/data\\/uploads\\/note\\.png/.test(mimg.getAttribute("src") || ""));

  // ---- spark add-box dblclick delegation opens the viewer ----
  if (modal) modal.hidden = true;
  var add = document.getElementById("spark-add-input");
  add.innerHTML = '<img src="/data/uploads/pasted.png">';
  var addImg = add.querySelector("img");
  if (addImg) addImg.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
  out.sparkAddDblclickOpens = !!(modal && modal.hidden === false && /\\/data\\/uploads\\/pasted\\.png/.test(mimg.getAttribute("src") || ""));

  // ---- negative differential: a text-only spark note must NOT trip the viewer ----
  if (modal) modal.hidden = true;
  list.innerHTML = '<div class="kb-item spark-item"><div class="spark-item__body"><pre class="spark-item__text">plain text only</pre></div></div>';
  list.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
  out.noImageDblclickIsNoop = !!(modal && modal.hidden === true);
  return out;
})();`;
win.eval(appCode);
const r = win.__probe;

check("edit modal shows a ref-only thumbnail (post-reload persistence)", r.modalThumbSurvives === true);
check("edit modal thumbnail dblclick opens viewer at the ref (functional)", r.modalDblclickOpensRef === true);
check("spark stored-note image dblclick opens viewer (functional)", r.sparkListDblclickOpens === true);
check("spark add-box pasted image dblclick opens viewer (functional)", r.sparkAddDblclickOpens === true);
check("text-only note dblclick is a no-op (negative differential)", r.noImageDblclickIsNoop === true);

console.log("\nSPARK-IMAGE-DBLCLICK-PERSIST: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
