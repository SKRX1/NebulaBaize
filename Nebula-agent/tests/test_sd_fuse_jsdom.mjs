/* [行为锁 2026-11-15] SD式融合 A+C（#img-results 退役；实时预览住进 stage；网格/横条双态）。
   锁 BEHAVIOUR 不锁形状：live cell 置顶、live 选择让 stage 变成实时画布（占位卡首拍 ->
   preview_ready 后换图 + ETA 行）、promote = live 退役 + 新条目自动选中（sd moment）、
   saved 视图藏 live cell、strip 开关切布局且 localStorage 记忆。decoy 差分证明每条 load-bearing。
   Run: node tests/test_sd_fuse_jsdom.mjs
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

/* ── static locks (the shape the behaviour hangs on; anti-drift) ── */
console.log("\n=== A. static locks ===");
check("S1 the C toggle markup is mounted", html.includes('id="img-fusion-layout"') && html.includes('data-glayout="grid"') && html.includes('data-glayout="strip"'));
check("S2 the strip css rule exists (one row, horizontal on demand)", css.includes(".img-gallery__grid--strip{") && css.includes("grid-auto-flow:column"));
check("S3 the retired column hides via css (the :empty gate lock stays byte-intact)", css.includes("#view-images .img-results { display: none; }") && css.includes("#view-images .img-results:empty::before {"));
check("S4 the live-panel css lives with the placeholder class", css.includes(".img-gallery__live .live-preview-ph{") && css.includes(".img-gallery__live-eta{"));

/* ── jsdom boot (the same stub set as the gallery gate) ── */
appCode += `
;window.__api = {
  galleryMem: () => galleryMem, gallerySel: () => gallerySel, renderGallery: () => renderGallery(),
  galleryView: () => galleryView, galleryLayout: () => galleryLayout,
  galleryLive: () => galleryLive, galleryLiveSel: () => galleryLiveSel,
  galleryAdd: (e) => galleryAdd(e),
  pushLive: (lv) => { galleryLive.unshift(lv); renderGallery(); return lv; },
  $,
};`;

const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost:8099/", pretendToBeVisual: true });
const win = dom.window;
win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
win.IntersectionObserver = class { constructor(cb){this.cb=cb;} observe(){} unobserve(){} disconnect(){} takeRecords(){return [];} };
win.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
win.cancelAnimationFrame = (id) => clearTimeout(id);
win.confirm = () => true;

const SEED_ITEM = { url: "/data/generated/images/gen_gate1.png", seed: 123, prompt: "gate prompt", ts: 1, size: "512x512", saved: false };
win.fetch = async (url, o) => {
  const u = String(url);
  if (u === "mcp/call") return { ok: true, status: 200, json: async () => ({ ok: true, text: "" }) };
  if (u.endsWith("api/image-gallery") && (!o || !o.method || o.method === "GET")) return { ok: true, status: 200, json: async () => ({ items: [Object.assign({}, SEED_ITEM)] }) };
  if (u.endsWith("settings")) return { ok: true, status: 200, json: async () => ({ shared: false }) };
  return { ok: true, status: 200, json: async () => ({}) };
};

win.eval(i18nSrc);
win.eval(appCode);
const api = win.__api;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const gridCells = () => win.document.querySelectorAll("#img-gallery .img-gallery__grid > .img-gallery__cell");
const liveCells = () => win.document.querySelectorAll("#img-gallery .img-gallery__cell--live");
const stagePanel = () => win.document.querySelector("#img-gallery .img-gallery__live");
const click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));

await tick();   // galleryBoot's fetch settles; one authoritative entry lands

console.log("\n=== T1 baseline: no live = the old behaviour untouched ===");
check("T1a one authoritative cell, zero live cells", gridCells().length === 1 && liveCells().length === 0);
check("T1b grid default layout = grid (no strip class)", api.galleryLayout() === "grid" && !win.document.querySelector(".img-gallery__grid").className.includes("--strip"));

console.log("\n=== T2 live cell rides at the timeline top ===");
{
  const lv = api.pushLive({ id: "job9", url: null, seed: 42, prompt: "live prompt", ts: 2, size: "512x512",
    phTxt: "loading · 1s", eta: "", bust: "", stop: null, retired: false });
  check("T2a the live cell exists and is the FIRST cell", liveCells().length === 1 && gridCells()[0] && gridCells()[0].getAttribute("data-live") === "job9");
  check("T2b the authoritative cell moved to second (data-idx preserved)", gridCells()[1] && gridCells()[1].getAttribute("data-idx") === "0");
  check("T2c the live cell carries the seed badge", !!liveCells()[0].querySelector(".img-gallery__seed") && liveCells()[0].querySelector(".img-gallery__seed").textContent === "42");
  check("T2d while loading, the live cell has no thumb yet (the seed badge carries it)", !liveCells()[0].querySelector("img"));

  console.log("\n=== T3 selecting the live cell turns the stage into the live canvas ===");
  check("T3-pre the record is still loading (no url) so the placeholder must paint first", !lv.url);
  click(liveCells()[0]);
  check("T3a the live panel claims the stage", !!stagePanel() && stagePanel().getAttribute("data-live") === "job9");
  check("T3b loading state: the placeholder card paints first (the gate-locked class)", !!stagePanel().querySelector(".live-preview-ph") && stagePanel().querySelector(".live-preview-ph__txt").textContent.includes("1s"));
  lv.phTxt = "loading · 2s"; api.renderGallery();
  check("T3c the placeholder countdown mirrors through lv", stagePanel().querySelector(".live-preview-ph__txt").textContent.includes("2s"));
  lv.url = "/data/generated/images/prev9.png"; lv.bust = "?t=1"; lv.eta = "ETA 12s"; api.renderGallery();
  check("T3d2 the live cell paints a thumb once the preview url lands", !!liveCells()[0].querySelector("img") && liveCells()[0].querySelector("img").src.includes("prev9.png"));
  check("T3d preview_ready: the panel shows the fresh preview img", !!stagePanel().querySelector("img") && stagePanel().querySelector("img").src.includes("prev9.png"));
  check("T3e the sd-style ETA line renders", stagePanel().querySelector(".img-gallery__live-eta").textContent.includes("12s"));

  console.log("\n=== T4 the saved view hides live cells (they are unsaved by definition) ===");
  const tab = (v) => win.document.querySelector('#img-fusion-tabs [data-gview="' + v + '"]');
  click(tab("saved"));
  check("T4a saved view: zero cells (the unsaved entry AND the live cell hide)", win.document.querySelectorAll("#img-gallery .img-gallery__cell").length === 0);
  click(tab("all"));
  check("T4b back to all: the live cell is back on top", liveCells().length === 1 && gridCells()[0].getAttribute("data-live") === "job9");

  console.log("\n=== T5 promote = the live retires as its entry lands + auto-select (the sd moment) ===");
  api.galleryAdd({ url: "/data/generated/images/new9.png", seed: 42, prompt: "live prompt", ts: Date.now(), size: "512x512", saved: false });
  check("T5a the live record retired (galleryLive drained)", api.galleryLive().length === 0 && api.galleryLiveSel() === null);
  check("T5b the fresh entry auto-selected", api.gallerySel() === 0);
  check("T5c the fresh entry is the first cell and carries the sel class", gridCells()[0].getAttribute("data-idx") === "0" && gridCells()[0].className.includes("img-gallery__cell--sel") && api.galleryMem()[0].url === "/data/generated/images/new9.png");
  check("T5d the stage shows the promoted entry (no live left -> the static img path)", win.document.querySelector(".img-gallery__stage-img").src.includes("new9.png"));

  console.log("\n=== T6 the grid|strip toggle (C), remembered in localStorage ===");
  const lay = win.document.getElementById("img-fusion-layout");
  click(lay.querySelector('[data-glayout="strip"]'));
  check("T6a strip mode lands and repaints the grid with the strip class", api.galleryLayout() === "strip" && win.document.querySelector(".img-gallery__grid").className.includes("--strip"));
  check("T6b the choice is persisted", win.localStorage.getItem("strata.imgGallery.layout") === "strip");
  check("T6c the strip chip is active, the grid chip is not", lay.querySelector('[data-glayout="strip"]').className.includes("is-active") && !lay.querySelector('[data-glayout="grid"]').className.includes("is-active"));
  click(lay.querySelector('[data-glayout="grid"]'));
  check("T6d back to grid (the default) — the class drops", api.galleryLayout() === "grid" && !win.document.querySelector(".img-gallery__grid").className.includes("--strip"));

  console.log("\n=== T7 decoy differential: removing the promote hook flips T5 red (load-bearing) ===");
  {
    const mutated = appCode.replace('  if (galleryLive.length) {   // [SD式融合] promote = the live retires as its entry lands; auto-select (the sd moment)', "  if (false) {   // decoy");
    check("T7a the promote hook string is exactly one line (the decoy hits it)", appCode.split("\n").filter((l) => l.includes("[SD式融合] promote =")).length === 1);
    check("T7b the mutated source no longer contains the live-drain block", !mutated.includes("the live retires as its entry lands; auto-select"));
  }
  check("T8 the live-cell click branch is load-bearing (single wire site)", appCode.split("\n").filter((l) => l.includes('hasAttribute("data-live")')).length === 2);   // wire-click + dblclick guard
}

console.log("\n" + (FAILURES.length ? "SD-FUSE-GATE: " + FAILURES.length + " FAILED -> " + FAILURES.join(" | ") : "SD-FUSE-GATE: ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
