/* [行为锁 2026-11-15] 画廊删除增强：B1 修饰键多选（Ctrl/Cmd toggle、Shift 范围从
   gallerySel 锚点）、汇总确认框（勾选默认开 = 文件随条目进回收站；取消勾选 = 仅移
   索引）、批量删除一次确认删多个。每条行为锁都配差分（decoy）证明 load-bearing。
   Run: node tests/test_batch_delete_jsdom.mjs
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
const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");

/* ── static locks (anti-drift; the behaviour hangs on these) ── */
console.log("\n=== A. static locks ===");
check("S1 the batch bar + summary box css exist", css.includes(".img-gallery__batchbar{") && css.includes(".img-gallery__batchconfirm{"));
check("S2 the set is INDEPENDENT of gallerySel (the single-select gates stay byte-intact)", /const gallerySelSet = new Set\(\);/.test(appCode));
check("S3 the default-checked fact is exactly one line (the decoy hits it)", appCode.split("\n").filter((l) => l.includes('ck.checked = true; ck.setAttribute("data-testid", "batch-check")')).length === 1);
check("S4 the single-delete window.confirm gate stayed byte-intact (the G family)", /if \(!window\.confirm\(t\("img\.gallery\.confirm\.del"\)\)\) return;/.test(appCode));

/* ── harness: the same stub set as the gallery/fuse gates ── */
const SEED = [
  { url: "/data/generated/images/gen_b1.png", seed: 11, prompt: "b one", ts: 1, size: "512x512", saved: false },
  { url: "/data/generated/images/gen_b2.png", seed: 22, prompt: "b two", ts: 2, size: "512x512", saved: false },
  { url: "/data/generated/images/gen_b3.png", seed: 33, prompt: "b three", ts: 3, size: "512x512", saved: false },
];
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function freshBoot(seedItems) {
  const RECYCLED = [];
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost:8099/", pretendToBeVisual: true });
  const win = dom.window;
  win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  win.IntersectionObserver = class { constructor(cb){this.cb=cb;} observe(){} unobserve(){} disconnect(){} takeRecords(){return [];} };
  win.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  win.cancelAnimationFrame = (id) => clearTimeout(id);
  win.confirm = () => true;   // the single-delete gate (the G family); the batch path uses the DOM box
  win.fetch = async (url, o) => {
    const u = String(url);
    if (u === "mcp/call") return { ok: true, status: 200, json: async () => ({ ok: true, text: "" }) };
    if (u.endsWith("api/image-gallery") && (!o || !o.method || o.method === "GET")) return { ok: true, status: 200, json: async () => ({ items: seedItems.map((x) => Object.assign({}, x)) }) };
    if (u.endsWith("api/recycle")) { const b = JSON.parse(o.body); RECYCLED.push(b); return { ok: true, status: 200, json: async () => ({ trashed: b.paths.map(() => "x") }) }; }
    if (u.endsWith("settings")) return { ok: true, status: 200, json: async () => ({ shared: false }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  // the workspace seed lands BEFORE eval: sessions load at top level via store.get
  win.localStorage.setItem("strata.sessions", JSON.stringify([{ id: "sX", workspace: "wsX", permission: "full" }]));
  win.localStorage.setItem("strata.session.active", JSON.stringify("sX"));
  win.eval(i18nSrc);
  win.eval(appCode + `
;window.__api = {
  galleryMem: () => galleryMem, gallerySel: () => gallerySel, renderGallery: () => renderGallery(),
  gallerySelSet: () => gallerySelSet,
  $,
};`);
  await tick();   // the boot fetch resolves; the 3 seeded entries land
  return { win, RECYCLED, api: win.__api };
}

const cells = (win) => [...win.document.querySelectorAll('#img-gallery .img-gallery__grid [class*="img-gallery__cell"]')];   // [删除增强] prefix match: the batch counter class (--selset) decorates membership
const click = (win, el, mods = {}) => el.dispatchEvent(new win.MouseEvent("click", Object.assign({ bubbles: true }, mods)));

console.log("\n=== B1 Ctrl+click toggles the set (entry refs) — the batch bar appears ===");
const env = await freshBoot(SEED);
const { win, RECYCLED, api } = env;
check("B1a 3 cells, set empty, no batch bar yet", cells(win).length === 3 && api.gallerySelSet().size === 0 && !win.document.querySelector(".img-gallery__batchbar"));
click(win, cells(win)[0], { ctrlKey: true });
check("B1b after Ctrl+click the set holds the cell0 entry and the bar appears", api.gallerySelSet().size === 1 && [...api.gallerySelSet()][0] === api.galleryMem()[0] && !!win.document.querySelector(".img-gallery__batchbar"));
check("B1c the batch count reflects the set", win.document.querySelector(".img-gallery__batchcount").textContent.includes("1"));
click(win, cells(win)[0], { ctrlKey: true });
check("B1d Ctrl+click again toggles OFF — the bar leaves", api.gallerySelSet().size === 0 && !win.document.querySelector(".img-gallery__batchbar"));
click(win, cells(win)[1], { ctrlKey: true });
check("B1e single membership survives every repaint (the I11 discipline)", api.gallerySelSet().size === 1 && cells(win)[1].className.includes("img-gallery__cell--selset"));

console.log("\n=== B2 Shift+click adds the range from the gallerySel anchor, both ends inclusive ===");
click(win, cells(win)[0]);   // plain click keeps the old single-select behaviour (the C family intact)
check("B2a plain click: gallerySel moves, the set untouched", api.gallerySel() === 0 && api.gallerySelSet().size === 1);
click(win, cells(win)[2], { shiftKey: true });
check("B2b the range adds all three (anchor..target inclusive) — set=3", api.gallerySelSet().size === 3);
check("B2c the batch bar counts 3 now", win.document.querySelector(".img-gallery__batchcount").textContent.includes("3"));

console.log("\n=== B3 the summary box opens DEFAULT-CHECKED -> files ride to the Recycle Bin (real fetch) ===");
click(win, win.document.querySelector(".img-gallery__batchbar .st-btn--danger"), {});   // the batch-delete button
await tick();
const box = win.document.querySelector('[data-testid="batch-confirm"]');
check("B3a the summary box opened", !!box);
const ck = box && box.querySelector('[data-testid="batch-check"]');
check("B3b THE DEFAULT: the box opens CHECKED (files follow)", !!ck && ck.checked === true);
check("B3c the box message counts the whole selection", !!box && box.textContent.includes("3"));
box.querySelectorAll("button")[0].click();   // ok
await tick(120);
check("B3d the recycle fetch fired once for exactly the 3 selected files", RECYCLED.length === 1, "n=" + RECYCLED.length);
check("B3e the payload carries the workspace + the 3 generated paths", RECYCLED[0] && RECYCLED[0].workspace === "wsX" && RECYCLED[0].paths.length === 3);
check("B3f all three entries left the authoritative list", api.galleryMem().length === 0);
check("B3g the set drained with the deletion", api.gallerySelSet().size === 0);

console.log("\n=== B4 decoy differential: box UNCHECKED -> index-only removal, NO recycle fetch ===");
{
  const env2 = await freshBoot(SEED);
  const win2 = env2.win, api2 = env2.api;
  click(win2, cells(win2)[0], { ctrlKey: true });
  click(win2, cells(win2)[2], { ctrlKey: true });
  check("B4a two members selected", api2.gallerySelSet().size === 2);
  click(win2, win2.document.querySelector(".img-gallery__batchbar .st-btn--danger"), {});
  await tick();
  const box2 = win2.document.querySelector('[data-testid="batch-confirm"]');
  const ck2 = box2 && box2.querySelector('[data-testid="batch-check"]');
  check("B4b the box opens checked (the locked default)", !!ck2 && ck2.checked === true);
  ck2.checked = false;   // the user un-ticks: the files stay in the folder
  box2.querySelectorAll("button")[0].click();
  await tick(120);
  check("B4c NO recycle fetch fired when un-checked (decoy proves B3 is load-bearing)", env2.RECYCLED.length === 0);
  check("B4d both entries left the index — empty = real intent, the A5 family (3-2=1 left)", api2.galleryMem().length === 1 && api2.gallerySelSet().size === 0);
}

console.log("\n" + (FAILURES.length ? "BATCH-DELETE-GATE: " + FAILURES.length + " FAILED -> " + FAILURES.join(" | ") : "BATCH-DELETE-GATE: ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
