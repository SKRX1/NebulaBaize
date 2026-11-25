/* SPARK THUMBNAIL DELETE — fix gate (real app.js functions via jsdom-boot, real DOM click bubbling).
 * FIXED 2026-11-02: bindInlineThumbDelete() now wires the three spark containers onto their OWN
 * delegation handler sparkThumbDelete() (in addition to composer #input + chat-modal #edit-area,
 * which stay on removeThumb). A stored spark's image lives ONLY in the s.html string, so its delete
 * goes through the spark data path (chip removed -> saveSparkEdit persists the box's remaining HTML);
 * the add-box rides the shared editAttachments runtime array; the composer/modal arrays stay untouched.
 *
 * (This gate REPLACES the 2026-11-01 root-cause lock that asserted "spark containers NOT wired = the
 *  bug"; after the fix those two static locks are flipped to assert the containers ARE now wired.)
 *
 * Differential pairs (real net, real DOM click bubbling per the delegation-bubbling rule):
 *   STATIC  : composer #input + chat #edit-area still on removeThumb; spark-add-input + spark-list on sparkThumbDelete.
 *   STORED  : click a stored spark note's delete -> sparkThumbDelete -> saveSparkEdit persists s.html WITHOUT the chip.
 *   ADD-BOX : click the add-box chip's delete -> editAttachments array spliced.
 *   COMPOSER: click a composer chip's delete -> removeThumb splices the composer array (control group, NOT broken).
 * Run standalone: node tests/test_spark_thumb_delete.mjs
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

// --- static source locks, FLIPPED to the post-fix contract ---
check("static: sparkThumbDelete handler defined", /function sparkThumbDelete/.test(srcText));
check("static: bind wires spark-add-input onto sparkThumbDelete", /\$\("spark-add-input"\)[^\n]*sparkThumbDelete/.test(srcText));
check("static: bind wires spark-list onto sparkThumbDelete", /\$\("spark-list"\)[^\n]*sparkThumbDelete/.test(srcText));
check("static: composer onClick handler body still calls removeThumb (not redirected)", /const onClick = [\s\S]*?removeThumb\(/.test(srcText));
check("static: composer #input wires onClick (the removeThumb handler), not sparkThumbDelete", /\$\("input"\)[^\n]*addEventListener\("click", onClick\)/.test(srcText));
check("static: spark data path persists via saveSparkEdit on the delegated item", /saveSparkEdit\(item\.dataset\.id/.test(srcText));

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1/", runScripts: "outside-only" });
const win = dom.window;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
if (!win.document.getElementById("toasts")) { const d = win.document.createElement("div"); d.id = "toasts"; win.document.body.appendChild(d); }
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
let appCode = fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += "\n;window.__api = { bindInlineThumbDelete, sparkThumbDelete, removeThumb, renderSpark, getSparks, setSparks, getAttachments: () => attachments, setAttachments: (x) => { attachments = x; }, getEditAttachments: () => editAttachments, setEditAttachments: (x) => { editAttachments = x; } };";
win.eval(appCode);
const api = win.__api;
check("sparkThumbDelete boots", typeof api.sparkThumbDelete === "function");
check("bindInlineThumbDelete boots", typeof api.bindInlineThumbDelete === "function");

// chip builder mirroring makeInlineThumb structure (span[data-pid] > box > img + button.ce-thumb__x[data-delpid])
function makeChip(pid) {
  const span = win.document.createElement("span");
  span.className = "ce-thumb"; span.setAttribute("contenteditable", "false"); span.setAttribute("data-pid", String(pid));
  const box = win.document.createElement("span"); box.className = "ce-thumb__box"; span.appendChild(box);
  const img = win.document.createElement("img"); img.className = "inline-ce-img"; img.src = "data:image/png;base64,AAA"; box.appendChild(img);
  const btn = win.document.createElement("button"); btn.type = "button"; btn.className = "ce-thumb__x"; btn.setAttribute("data-delpid", String(pid)); box.appendChild(btn);
  return span;
}

// ensure the three spark containers exist so bind can wire them (index.html may build them lazily)
function ensureId(id) { let el = win.document.getElementById(id); if (!el) { el = win.document.createElement("div"); el.id = id; win.document.body.appendChild(el); } return el; }
const sparkList = ensureId("spark-list");
const sparkAdd = ensureId("spark-add-input");

// seed a stored spark whose s.html carries a full chip; renderSpark builds the real .spark-item DOM
api.setSparks([{ id: "SPK_TEST", text: "note body", html: 'note body <span class="ce-thumb" contenteditable="false" data-pid="7"><span class="ce-thumb__box"><img class="inline-ce-img" src="data:image/png;base64,AAA"><button type="button" class="ce-thumb__x" data-delpid="7"></button></span></span>', status: "pending", createdAt: Date.now(), tags: [], archived: false }]);
api.bindInlineThumbDelete();   // wires composer/edit-area/add-box/spark-list onto their handlers

// STORED spark path: real click bubbling on the rendered chip's delete button
if (typeof api.renderSpark === "function") api.renderSpark();
const item = sparkList.querySelector('.spark-item[data-id="SPK_TEST"]');
check("renderSpark produced the stored spark item DOM", !!item);
if (item) {
  const btn = item.querySelector(".ce-thumb__x");
  btn.click();   // real bubbling -> delegation on spark-list -> sparkThumbDelete -> saveSparkEdit
  const saved = api.getSparks().find((x) => x.id === "SPK_TEST");
  check("STORED: after click, persisted s.html no longer contains the data-pid chip", !!saved && !/data-pid/.test(saved.html || ""));
  check("STORED: persisted s.html keeps the surrounding text (note body survives)", !!saved && /note body/.test(saved.html || saved.text));
}

// ADD-BOX array path: live image rides the shared editAttachments array
api.setEditAttachments([{ kind: "image", url: "data:image/png;base64,AAA", name: "b.png", pid: 9 }]);
sparkAdd.appendChild(makeChip(9));
const beforeA = api.getEditAttachments().length;
sparkAdd.querySelector(".ce-thumb__x").click();   // real bubbling -> sparkThumbDelete -> array splice
check("ADD-BOX: click delete -> shared editAttachments array spliced", api.getEditAttachments().length === beforeA - 1);

// COMPOSER control group: composer chip delete still routed through removeThumb -> composer array (NOT broken by the fix)
const inputEl = win.document.getElementById("input") || win.document.body.appendChild(win.document.createElement("div"));
if (!inputEl.id) inputEl.id = "input";
api.setAttachments([{ kind: "image", url: "data:image/png;base64,AAA", name: "a.png", pid: 1 }]);
inputEl.appendChild(makeChip(1));
const beforeC = api.getAttachments().length;
inputEl.querySelector(".ce-thumb__x").click();
check("COMPOSER (control): composer array still spliced by removeThumb (fix did NOT break it)", api.getAttachments().length === beforeC - 1);

console.log("\nTHUMB-DELETE-SPARK (post-fix): " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
