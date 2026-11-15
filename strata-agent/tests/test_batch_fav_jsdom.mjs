/* [批量收藏 2026-11-16] 画廊批量收藏行为锁：多选后 batch bar 出现收藏按钮（data-testid=batch-fav）；
   点击对每个选中项 POST api/saved-image（复用单张收藏端点，后端幂等 copyfile）；成功项 saved=true 且
   saved_ref 被设为后端 ref；失败项不被污染；收藏后【保留选择】（与 batch-delete 的 drain 相反——收藏非
   破坏、可重复）。每条行为锁都配差分（decoy）证明 load-bearing。Run: node tests/test_batch_fav_jsdom.mjs
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
// app.js is CRLF — multiline anchors below match real newlines with explicit \r?\n regexes.

/* ── static locks (anti-drift; the behaviour hangs on these) ── */
console.log("\n=== A. static locks ===");
check("S1 the fav button is addressable by data-testid=batch-fav", /fav\.setAttribute\("data-testid", "batch-fav"\)/.test(appCode));
check("S2 the fav button is appended to the batch bar BETWEEN count and delete", /bar\.append\(cnt, fav, del, clr\)/.test(appCode));
check("S3 fav wires the click to galleryBatchFav", /fav\.addEventListener\("click", \(\) => galleryBatchFav\(\)\)/.test(appCode));
check("S4 galleryBatchFav posts to the SAME endpoint as single-save (api/saved-image)", /async function galleryBatchFav\(\)[\s\S]*?fetch\("api\/saved-image"/.test(appCode));
{
  // the fav function body (from its signature to the next top-level `async function`) must NOT drain the set
  const start = appCode.indexOf("async function galleryBatchFav");
  const end = appCode.indexOf("async function galleryTrashFiles");
  const body = appCode.slice(start, end);
  check("S5 fav is NON-destructive: its body does NOT clear the set (unlike batch-delete's drain)", start >= 0 && end > start && !/gallerySelSet\.clear\(\)/.test(body));
}

/* ── harness ── */
// gen_f4's file name is the decoy: the mock returns NOT-ok for it (the backend rejects a bad src),
// proving the fail branch is load-bearing and never flips a failed pick to saved=true.
const SEED = [
  { url: "/data/generated/images/gen_f1.png", seed: 11, prompt: "f one", ts: 1, size: "512x512", saved: false },
  { url: "/data/generated/images/gen_f2.png", seed: 22, prompt: "f two", ts: 2, size: "512x512", saved: false },
  { url: "/data/generated/images/gen_f3.png", seed: 33, prompt: "f three", ts: 3, size: "512x512", saved: false },
  { url: "/data/generated/images/gen_f4.png", seed: 44, prompt: "f four", ts: 4, size: "512x512", saved: false },
];
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function freshBoot(seedItems) {
  const FAV_POSTS = [];
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost:8099/", pretendToBeVisual: true });
  const win = dom.window;
  win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  win.IntersectionObserver = class { constructor(cb){this.cb=cb;} observe(){} unobserve(){} disconnect(){} takeRecords(){return [];} };
  win.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  win.cancelAnimationFrame = (id) => clearTimeout(id);
  win.fetch = async (url, o) => {
    const u = String(url);
    if (u === "mcp/call") return { ok: true, status: 200, json: async () => ({ ok: true, text: "" }) };
    if (u.endsWith("api/image-gallery") && (!o || !o.method || o.method === "GET")) return { ok: true, status: 200, json: async () => ({ items: seedItems.map((x) => Object.assign({}, x)) }) };
    if (u.endsWith("api/saved-image")) {
      const b = JSON.parse(o.body);
      FAV_POSTS.push(b.src);
      if (String(b.src).includes("gen_f4")) return { ok: false, status: 400, json: async () => ({ error: { message: "bad src (decoy)" } }) };   // the fail branch
      return { ok: true, status: 200, json: async () => ({ ref: "/data/saved_images/" + String(b.src).split("/").pop() }) };
    }
    if (u.endsWith("settings")) return { ok: true, status: 200, json: async () => ({ shared: false }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  win.localStorage.setItem("strata.sessions", JSON.stringify([{ id: "sX", workspace: "wsX", permission: "full" }]));
  win.localStorage.setItem("strata.session.active", JSON.stringify("sX"));
  win.eval(i18nSrc);
  win.eval(appCode + `
;window.__api = {
  galleryMem: () => galleryMem, renderGallery: () => renderGallery(),
  gallerySelSet: () => gallerySelSet, galleryBatchFav: () => galleryBatchFav(),
  $,
};`);
  await tick();   // the boot fetch resolves; the 4 seeded entries land
  return { win, FAV_POSTS, api: win.__api };
}

// the CELL BUTTON only (not the tick-box span inside it) — same selector as the batch-delete gate's
// cellBtns(); in the multi-select mode a click on it registers a pick. Re-query before every click.
const cellBtns = (win) => [...win.document.querySelectorAll(".img-gallery__grid button.img-gallery__cell")];
const favBtn = (win) => win.document.querySelector('[data-testid="batch-fav"]');
const click = (win, el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
const pickModeOn = (win) => { const ms = win.document.getElementById("img-fusion-multisel"); if (ms.getAttribute("aria-pressed") !== "true") ms.click(); };

console.log("\n=== F1 the batch bar grows the fav button when the set is non-empty ===");
const env = await freshBoot(SEED);
const { win, FAV_POSTS, api } = env;
check("F1a 4 cells, set empty, no bar, no fav button", cellBtns(win).length === 4 && api.gallerySelSet().size === 0 && !favBtn(win));
pickModeOn(win);
click(win, cellBtns(win)[0]);   // re-query every time: each click repaints, the node must be live
click(win, cellBtns(win)[1]);
click(win, cellBtns(win)[2]);
check("F1b after 3 picks the batch bar + fav button appear", api.gallerySelSet().size === 3 && !!win.document.querySelector(".img-gallery__batchbar") && !!favBtn(win), "size=" + api.gallerySelSet().size);

console.log("\n=== F2 clicking fav posts api/saved-image for EACH pick (reuses the single-save endpoint) ===");
click(win, favBtn(win));
await tick(200);
check("F2a exactly 3 POSTs fired (one per pick)", FAV_POSTS.length === 3, "n=" + FAV_POSTS.length);
check("F2b the posts carry the 3 picked generated-image urls", ["gen_f1","gen_f2","gen_f3"].every((k)=>FAV_POSTS.some(s=>s.includes(k))), JSON.stringify(FAV_POSTS));

console.log("\n=== F3 successful picks land saved=true + saved_ref = the backend ref ===");
const mem = api.galleryMem();
const byName = (k) => mem.find((x) => x.prompt === k);
check("F3a f one -> saved=true, ref points at saved_images", byName("f one").saved === true && String(byName("f one").saved_ref).startsWith("/data/saved_images/"));
check("F3b f two -> saved=true", byName("f two").saved === true && String(byName("f two").saved_ref).startsWith("/data/saved_images/"));
check("F3c f three -> saved=true", byName("f three").saved === true);

console.log("\n=== F4 the set is KEPT after fav (non-destructive / repeatable — opposite of batch-delete's drain) ===");
check("F4d the 3 picks SURVIVE the action (the fav button is still there, count still 3)", api.gallerySelSet().size === 3 && !!favBtn(win));

console.log("\n=== F5 decoy differential: a failed pick (backend NOT-ok) is NOT flipped to saved=true ===");
{
  const env2 = await freshBoot(SEED);
  const win2 = env2.win, api2 = env2.api;
  pickModeOn(win2);
  click(win2, cellBtns(win2)[3]);   // pick only the decoy (gen_f4 -> mock returns NOT-ok)
  check("F5a one pick, fav present", api2.gallerySelSet().size === 1 && !!favBtn(win2));
  click(win2, favBtn(win2));
  await tick(200);
  check("F5b the decoy DID get a POST (the loop ran for it)", env2.FAV_POSTS.some((s) => s.includes("gen_f4")), JSON.stringify(env2.FAV_POSTS));
  const d = api2.galleryMem().find((x) => x.prompt === "f four");
  check("F5c the failed pick stayed saved=false (the fail branch is load-bearing, not cosmetic)", d.saved === false);
  check("F5d no bogus saved_ref was written for the failed pick", !d.saved_ref);
}

console.log("\n=== F6 empty selection: fav is a no-op (warn toast), no POST ===");
{
  const env3 = await freshBoot(SEED);
  const api3 = env3.api;
  check("F6a set empty", api3.gallerySelSet().size === 0);
  await api3.galleryBatchFav();   // call the function directly with an empty set
  await tick();
  check("F6b no POST fired for an empty selection", env3.FAV_POSTS.length === 0);
  check("F6c nothing in the list was marked saved", api3.galleryMem().every((x) => x.saved === false));
}

console.log("\n" + (FAILURES.length ? "BATCH-FAV-GATE: " + FAILURES.length + " FAILED -> " + FAILURES.join(" | ") : "BATCH-FAV-GATE: ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
