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

const gateway = fs.readFileSync(path.join(ROOT, "runtime", "http_server.py"), "utf8");

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const i18nSrc = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
// EOL-agnostic source for the structural CSS locks below: app.css ships CRLF, so a needle
// ending in "\n" would miss on a CR+LF file (the historical I2 false red). Normalise once.
const cssLF = css.replace(/\r\n/g, "\n");

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

/* two bugs this round actually hit, now locked: */
check("A9 saved-image joins GENERATED_DIR once (GENERATED_DIR already ends in images)",
      gateway.includes('f = os.path.join(GENERATED_DIR, name)') &&
      !gateway.includes('os.path.join(GENERATED_DIR, "images", name)'));
check("A10 the /api/saved-image dispatch branch returns True (no fall-through 404)",
      /_api_saved_image\(\)[^\n]*\n\s*return True/.test(gateway));
// decoy differential: each single-variable mutation must flip exactly its own lock
check("decoy control: restoring the double-images join flips A9 red",
      !(() => { const m = gateway.replace('os.path.join(GENERATED_DIR, name)', 'os.path.join(GENERATED_DIR, "images", name)'); return m.includes('f = os.path.join(GENERATED_DIR, name)') && !m.includes('os.path.join(GENERATED_DIR, "images", name)'); })());
check("decoy control: removing the branch return True flips A10 red",
      !/_api_saved_image\(\)[^\n]*\n\s*return True/.test(gateway.replace(/(_api_saved_image\(\)[^\n]*\n\s*)return True/, "$1")));

/* ── jsdom boot ── */
appCode += `
;window.__api = {
  galleryMem: () => galleryMem, gallerySel: () => gallerySel, renderGallery: () => renderGallery(),
  galleryView: () => galleryView, galleryQuery: () => galleryQuery, gallerySort: () => gallerySort,
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
win.localStorage.setItem("strata.sessions", JSON.stringify([{ id: "sG", workspace: "wsG", permission: "full" }]));   // [方案A] a workspace so the box file-leg reaches /api/recycle
win.localStorage.setItem("strata.session.active", JSON.stringify("sG"));
const POSTS = [];
const RECYCLED = [];
win.fetch = async (url, o) => {
  const u = String(url);
  if (u === "mcp/call") return { ok: true, status: 200, json: async () => ({ ok: true, text: "" }) };
  if (u.endsWith("api/image-gallery") && (!o || !o.method || o.method === "GET")) return { ok: true, status: 200, json: async () => ({ items: [Object.assign({}, SEED_ITEM)] }) };
  if (u.endsWith("api/image-gallery")) { POSTS.push({ url: u, body: JSON.parse(o.body) }); return { ok: true, status: 200, json: async () => JSON.parse(o.body) }; }
  if (u.endsWith("api/saved-image")) { POSTS.push({ url: u, body: JSON.parse(o.body) }); return { ok: true, status: 200, json: async () => ({ ref: "/data/saved_images/gen_gate1.png" }) }; }
  if (u.endsWith("api/gallery-reveal")) { POSTS.push({ url: u, body: JSON.parse(o.body) }); return { ok: true, status: 200, json: async () => ({ opened: true }) }; }
  if (u.endsWith("workspace/open")) { POSTS.push({ url: u, body: JSON.parse(o.body) }); return { ok: true, status: 200, json: async () => ({ opened: true }) }; }
  if (u.endsWith("api/recycle")) { const b = JSON.parse(o.body); if (b.action === "trace") return { ok: true, status: 200, json: async () => ({ logged: true }) };   // [前端埋点 2026-11-16] the fe_trash mirror is telemetry, not a delete: it must not enter RECYCLED
  RECYCLED.push(b); return { ok: true, status: 200, json: async () => ({ trashed: b.paths.map(() => "x") }) }; }
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
api.__recycled = () => RECYCLED;
const setConfirm = (v) => { CONFIRM_ANSWER = v; };

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

console.log("\n=== B. boot restore: authoritative file wins, cell renders with seed badge ===");
await tick();   // galleryBoot()'s fetch settles
check("B1 gallery memory restored from the server doc", api.galleryMem().length === 1 && api.galleryMem()[0].url === SEED_ITEM.url);
const cellSel = () => win.document.querySelector('.img-gallery__cell[data-idx="0"]');
check("B2 grid cell rendered with the seed badge", !!cellSel() && !!cellSel().querySelector(".img-gallery__seed") && cellSel().querySelector(".img-gallery__seed").textContent === "123");
check("B3 tip renders a non-empty hint while nothing is selected", api.gallerySel() === -1 && win.document.querySelector(".img-gallery__tip").textContent.trim().length > 0);

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

console.log("\n=== G. [方案A 2026-11-16] single delete shares the in-place box (native confirm could NOT carry a checkbox = the root cause) ===");
{
  const boxOf = () => win.document.querySelector('[data-testid="batch-confirm"]');
  const boxBtns = () => boxOf() ? [...boxOf().querySelectorAll("button")] : [];
  const boxChk = () => boxOf() ? boxOf().querySelector('[data-testid="batch-check"]') : null;
  const delClick = () => win.document.querySelector('.img-gallery__actions [data-act="del"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));

  delClick();
  await tick();
  check("G1a the single-delete del click opens the in-place box (NOT a native confirm)", !!boxOf());
  check("G1b THE DEFAULT: the box opens CHECKED (the file follows — the locked fact)", !!boxChk() && boxChk().checked === true);
  boxBtns()[1].click();   // cancel
  await tick();
  check("G1c box CANCEL keeps the entry and fires NO fetch (index still 1)", api.galleryMem().length === 1 && !boxOf() && api.__recycled().length === 0);

  delClick();
  await tick();
  check("G2a the box reopened for the confirmed delete", !!boxOf());
  boxBtns()[0].click();   // OK (box still default-checked)
  await tick(120);
  check("G2b the recycle fetch fired ONCE for exactly this file (default-check is load-bearing)", api.__recycled().length === 1 && api.__recycled()[0].paths.length === 1);
  check("G2c the entry left the authoritative list (empty = real intent, NOT the old value)", api.galleryMem().length === 0 && api.gallerySel() === -1);
  check("G3 the empty gallery renders a non-empty hint again", api.gallerySel() === -1 && win.document.querySelector(".img-gallery__tip").textContent.trim().length > 0);
}

console.log("\n=== H. folder leg: api/gallery-reveal fires with the FULL served ref (the bug fix) ===");
{
  // re-seed via the mirror path so an entry exists again (server doc is static in this harness)
  win.localStorage.setItem("strata.imgGallery", JSON.stringify({ items: [Object.assign({}, SEED_ITEM)] }));
  api.galleryMem().push(Object.assign({}, SEED_ITEM));

  api.renderGallery();
  win.document.querySelector('.img-gallery__cell[data-idx="0"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  const before = POSTS.length;
  win.document.querySelector('.img-gallery__actions [data-act="folder"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await tick();
  const hit = POSTS.slice(before).find((p) => p.url.endsWith("api/gallery-reveal"));
  check("H1 the folder leg posts the FULL ref to api/gallery-reveal (the backend resolves it against the install root)", !!hit && hit.body.ref === "/data/generated/images/gen_gate1.png", hit && JSON.stringify(hit.body));
  check("H1b the OLD buggy path is gone (no relative-folder string to workspace/open on the folder leg)", !POSTS.slice(before).some((p) => p.url.endsWith("workspace/open") && p.body && p.body.path === "data/generated/images"));
}

/* ── [融合时间线 2026-11-15 A+C] fused single-scroll panel + segmented views ──
   Locks BEHAVIOUR not shape: the shell mounts, the three view tabs filter the SAME
   list by the saved flag, the search box filters live, and the grid no longer owns
   its own scrollbar (one scroll container = the page). */
console.log("\n=== I. fused timeline (2026-11-15 A+C): shell, segmented views, search ===");
check("I1 html mounts the fused shell (fusion bar: tabs + search + sort)",
      html.includes('id="img-fusion"') && html.includes('id="img-fusion-tabs"') &&
      html.includes('id="img-fusion-search"') && html.includes('id="img-fusion-sort"'));
check("I2 the fused grid no longer owns a scrollbar (single scroll container)",
      cssLF.includes(".img-gallery__grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:var(--st-s-2)}\n") &&
      !/\.img-gallery__grid\{[^}]*max-height/.test(cssLF));
{
  // entry state after section H: one unsaved entry in the index
  const cells = () => win.document.querySelectorAll(".img-gallery__cell").length;
  const tab = (v) => win.document.querySelector('#img-fusion-tabs [data-gview="' + v + '"]');
  check("I3 default view=all shows the entry", api.galleryView() === "all" && cells() === 1);
  tab("saved").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  check("I4 view=saved hides the unsaved entry (0 cells)", api.galleryView() === "saved" && cells() === 0);
  check("I5 view=saved also hides the session column", win.document.getElementById("img-results").hidden === true);
  tab("session").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  check("I6 view=session shows the unsaved entry again", api.galleryView() === "session" && cells() === 1);
  tab("all").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  check("I7 back to all: the column is revealed and the entry shows", win.document.getElementById("img-results").hidden === false && cells() === 1);
  const si = win.document.getElementById("img-fusion-search");
  si.value = "gate prompt"; si.dispatchEvent(new win.Event("input", { bubbles: true }));
  check("I8 search hit keeps the entry visible", cells() === 1);
  si.value = "zzz-nothing"; si.dispatchEvent(new win.Event("input", { bubbles: true }));
  check("I9 search miss hides it (live filter)", cells() === 0);
  si.value = ""; si.dispatchEvent(new win.Event("input", { bubbles: true }));
  const so = win.document.getElementById("img-fusion-sort");
  so.value = "old"; so.dispatchEvent(new win.Event("change", { bubbles: true }));
  check("I10 sort flips without losing entries", api.gallerySort() === "old" && cells() === 1);
  check("I11 the selection survives re-render (cell keeps the sel class)", !!win.document.querySelector(".img-gallery__cell--sel"));
}

console.log("\n=== J. [ws-空修复 2026-11-16] EMPTY workspace + url-shape path: the delete leg must STILL fire the fetch (the old if(!ws) return silently swallowed it = the bug) ===");
{
  win.localStorage.setItem("strata.sessions", JSON.stringify([{ id: "sProbe", workspace: "", permission: "full" }]));   // wipe the workspace the G section seeded
  win.localStorage.setItem("strata.session.active", JSON.stringify("sProbe"));
  api.galleryMem().push(Object.assign({}, SEED_ITEM));   // re-seed one entry (H/I may have emptied it)
  api.renderGallery();
  const cell0 = () => win.document.querySelector('.img-gallery__cell[data-idx="0"]');
  cell0().dispatchEvent(new win.MouseEvent("click", { bubbles: true }));   // select it
  const recBefore = api.__recycled().length;
  win.document.querySelector('.img-gallery__actions [data-act="del"]').dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await tick();
  const box = win.document.querySelector('[data-testid="batch-confirm"]');
  check("J1 the box opens default-CHECKED even on a workspace-less session", !!box && box.querySelector('[data-testid="batch-check"]').checked === true);
  box.querySelectorAll("button")[0].click();   // OK (default checked)
  await tick(120);
  check("J2 THE FIX: a workspace-EMPTY url-shape delete STILL fires /api/recycle (was silently swallowed)", api.__recycled().length === recBefore + 1);
  check("J3 the fired fetch carried the url-shape path (the backend maps it to the install root)", api.__recycled()[recBefore].paths.length === 1 && api.__recycled()[recBefore].paths[0].startsWith("/data/generated/images/"));
}

console.log("\n" + (FAILURES.length ? "IMG-GALLERY-GATE: " + FAILURES.length + " FAILED -> " + FAILURES.join(" | ") : "IMG-GALLERY-GATE: ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
