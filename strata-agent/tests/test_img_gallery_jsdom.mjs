/* [Gate 2026-11-15] image-gallery jsdom behaviour gate (view stage + selectable grid).
   Locks the shipped wiring: boot restores from the authoritative file (server wins) /
   the mirror; click-selects; double-click reuses the EXISTING lightbox (openImageView);
   save POSTs /api/saved-image and marks the entry; i2i flips gen-mode + fills the file
   slot through the stub-able DataTransfer leg; delete-all = REAL intent (the empty
   state must not fall back to the old value -- the .length trap of the rules); the
   confirm-cancel differential proves the confirm gate is load-bearing.
   Run: node tests/test_img_gallery_jsdom.mjs
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
const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");

/* ── static locks (definition + call-site pairs, anti-drift) ── */
console.log("\n=== A. static locks ===");
check("A1 app.js defines galleryBoot AND calls it", /async function galleryBoot\(/.test(appCode) && appCode.split("\n").some((l) => l.startsWith("galleryBoot();")));
check("A2 app.js defines galleryWire AND calls it", /function galleryWire\(\)/.test(appCode) && /^galleryWire\(\);$/m.test(appCode));
check("A3 galleryAdd defined AND called from the generation renderer", /function galleryAdd\(e\)/.test(appCode) && appCode.includes("galleryAdd({ url: d.url"));
check("A4 the save action posts to api/saved-image", appCode.includes('fetch("api/saved-image"'));
check("A5 the delete leg filters by identity (empty = real intent, no .length fallback)", /galleryMem = galleryMem\.filter\(\(x\) => x !== sel\)/.test(appCode));
check("A6 the i2i/editref leg guards the DataTransfer global (jsdom/stub path)", appCode.includes('typeof DataTransfer === "undefined"'));
check("A7 index.html mounts the gallery container", html.includes('id="img-gallery"'));
check("A8 css styles the selection outline via var tokens", css.includes(".img-gallery__cell--sel") && !/\.[\w-]+\{[^}]*#[0-9a-fA-F]{3,6}/.test(css.split(".img-gallery__cell--sel")[1].split("}")[0]));

/* ── jsdom boot ── */
appCode += `
;window.__api = {
  galleryMem: () => galleryMem, gallerySel: () => gallerySel, renderGallery: () => renderGallery(),
  $,
};`;

const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost:8099/", pretendToBeVisual: true });
const win = dom.window;
win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
win.IntersectionObserver = class { constructor(cb){this.cb=cb;} observe(){} unobserve(){} disconnect(){} takeRecords(){return [];} };
win.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
win.cancelAnimationFrame = (id) => clearTimeout(id);

let CONFIRM_ANSWER = true;
win.confirm = () => CONFIRM_ANSWER;
win.URL.createObjectURL = () => "blob:stub";
// harness-only DOM stub: jsdom's input.files setter validates FileList; the stubbed
// DataTransfer here hands a plain array, so mirror `files` onto a plain property.
Object.defineProperty(win.HTMLInputElement.prototype, "files", { set(v) { this._f = v; }, get() { return this._f; }, configurable: true });

const SEED_ITEM = { url: "/data/generated/images/gen_gate1.png", seed: 123, prompt: "gate prompt", ts: 1, size: "512x512", saved: false };
const POSTS = [];
win.fetch = async (url, o) => {
  const u = String(url);
  if (u === "mcp/call") return { ok: true, status: 200, json: async () => ({ ok: true, text: "" }) };
  if (u.endsWith("api/image-gallery") && (!o || !o.method || o.method === "GET")) return { ok: true, status: 200, json: async () => ({ items: [Object.assign({}, SEED_ITEM)] }) };
  if (u.endsWith("api/image-gallery")) { POSTS.push({ url: u, body: JSON.parse(o.body) }); return { ok: true, status: 200, json: async () => JSON.parse(o.body) }; }
  if (u.endsWith("api/saved-image")) { POSTS.push({ url: u, body: JSON.parse(o.body) }); return { ok: true, status: 200, json: async () => ({ ref: "/data/saved_images/gen_gate1.png" }) }; }
  if (u.endsWith("workspace/open")) { POSTS.push({ url: u, body: JSON.parse(o.body) }); return { ok: true, status: 200, json: async () => ({ opened: true }) }; }
  if (u.endsWith("gen_gate1.png")) return { ok: true, status: 200, blob: async () => ({ size: 3, type: "image/png" }) };
  if (u.endsWith("settings")) return { ok: true, status: 200, json: async () => ({ shared: false }) };
  return { ok: true, status: 200, json: async () => ({}) };
};

// DataTransfer stub: add() records files on a plain array (the app must accept it)
win.DataTransfer = class {
  constructor() { this.files = []; this.items = { add: (f) => { this.files.push(f); } }; }
};

win.eval(i18nSrc);
win.eval(appCode);
const api = win.__api;
const setConfirm = (v) => { CONFIRM_ANSWER = v; };

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

console.log("\n=== B. boot restore: authoritative file wins, cell renders with seed badge ===");
await tick();   // galleryBoot()'s fetch settles
check("B1 gallery memory restored from the server doc", api.galleryMem().length === 1 && api.galleryMem()[0].url === SEED_ITEM.url);
const cellSel = () => win.document.querySelector('.img-gallery__cell[data-idx="0"]');
check("B2 grid cell rendered with the seed badge", !!cellSel() && !!cellSel().querySelector(".img-gallery__seed") && cellSel().querySelector(".img-gallery__seed").textContent === "123");
check("B3 tip shows the empty-gallery hint while nothing is selected", api.gallerySel() === -1 && win.document.querySelector(".img-gallery__tip").textContent.startsWith("\u753b\u5eca\u4e3a\u7a7a"));

console.log("\n=== C. click selects (accent outline), buttons for the selection become enabled ===");
cellSel().dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
check("C1 selection index moves to 0", api.gallerySel() === 0);
check("C2 the selected cell carries the sel class", !!cellSel() && cellSel().className.includes("img-gallery__cell--sel"));
check("C3 the stage shows the selected image", win.document.querySelector(".img-gallery__stage-img").src.endsWith("gen_gate1.png"));
check("C4 action buttons become enabled", [].slice.call(win.document.querySelectorAll(".img-gallery__actions [data-act]")).every((b) => !b.disabled));

console.log("\n=== D. double-click reuses the EXISTING lightbox ===");
cellSel().dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true }));
check("D1 lightbox opens with the entry url", !win.document.getElementById("img-modal").hidden && win.document.getElementById("img-modal-img").src.endsWith("gen_gate1.png"));
win.document.getElementById("img-close").onclick();

console.log("\n=== E. save marks the entry via api/saved-image (dual-write incl. POST) ===");
{
  const before = POSTS.length;
  win.document.querySelector('.img-gallery__actions [data-act="save"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await tick();
  const hit = POSTS.slice(before).find((p) => p.url.endsWith("api/saved-image"));
  check("E1 POST api/saved-image fired with the entry src", !!hit && hit.body.src === SEED_ITEM.url);
  check("E2 the entry is marked saved in the index", api.galleryMem()[0].saved === true && api.galleryMem()[0].saved_ref === "/data/saved_images/gen_gate1.png");
}

console.log("\n=== F. i2i leg: flips gen-mode + fills the file slot through the stub DataTransfer ===");
{
  win.document.querySelector('.img-gallery__actions [data-act="i2i"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await tick();
  check("F1 gen-mode select switched to img2img", win.document.getElementById("img-gen-mode").value === "img2img");
  const fi = win.document.getElementById("img-init-file");
  check("F2 the file slot received exactly one stub File", !!fi.files && fi.files.length === 1);
  check("F3 the gen-mode change handler revealed the img2img row", win.document.getElementById("img-gen-img2img-row").style.display !== "none");
}

console.log("\n=== G. delete: confirm-cancel is load-bearing (differential), then delete-all = REAL empty state ===");
{
  setConfirm(false);
  win.document.querySelector('.img-gallery__actions [data-act="del"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await tick();
  check("G1 confirm CANCEL keeps the entry (index still 1)", api.galleryMem().length === 1);
  setConfirm(true);
  win.document.querySelector('.img-gallery__actions [data-act="del"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await tick();
  check("G2 confirm OK removes it (empty list = real intent, NOT the old value)", api.galleryMem().length === 0 && api.gallerySel() === -1);
  check("G3 the empty gallery renders the hint again", win.document.querySelector(".img-gallery__tip").textContent.startsWith("\u753b\u5eca\u4e3a\u7a7a"));
}

console.log("\n=== H. folder leg: workspace/open fires with the generated-images folder ===");
{
  // re-seed via the mirror path so an entry exists again (server doc is static in this harness)
  win.localStorage.setItem("strata.imgGallery", JSON.stringify({ items: [Object.assign({}, SEED_ITEM)] }));
  api.galleryMem().push(Object.assign({}, SEED_ITEM));
  api.renderGallery();
  win.document.querySelector('.img-gallery__cell[data-idx="0"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  const before = POSTS.length;
  win.document.querySelector('.img-gallery__actions [data-act="folder"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await tick();
  const hit = POSTS.slice(before).find((p) => p.url.endsWith("workspace/open"));
  check("H1 workspace/open fired with data/generated/images", !!hit && hit.body.path === "data/generated/images");
}

console.log("\n" + (FAILURES.length ? "IMG-GALLERY-GATE: " + FAILURES.length + " FAILED -> " + FAILURES.join(" | ") : "IMG-GALLERY-GATE: ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
