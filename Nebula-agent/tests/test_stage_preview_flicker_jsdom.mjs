/* [Gate 2026-11-27 stage-flicker] the STAGE live-preview flicker lock.
   ROOT-CAUSE (measured, NOT assumed): the prior sig_guard fix stopped the FINISHED grid from
   re-decoding every 2 s poll tick, but the STAGE (the big preview image on the right) still
   flickered. Measured via browser sim: galleryLiveRefresh used to `old.remove()` the whole
   .img-gallery__live panel then galleryLivePass built a BRAND-NEW <img> whose src carried a
   fresh ?t= every tick. The browser re-fetched AND re-decoded that fresh img, and the gap
   between the old frame vanishing and the new frame decoding rendered as the stage preview
   blanking / "snapping back" (the reported "下面预览缩略图甩到生成图位置、闪一下才正常"). The grid
   cells, by contrast, swap src on the SAME <img> in place (the browser keeps painting the old
   frame while the new decodes) and never flicker — the asymmetry the user saw.
   THE FIX: galleryLiveRefresh now refreshes the stage panel IN PLACE — it reuses the existing
   .img-gallery__live[data-live=id] panel, patches the eta text, and swaps the SAME preview
   <img>'s src (setAttribute) instead of tearing it down. Only a panel that is absent (or whose
   liveSel was cleared) falls back to the full galleryLivePass rebuild.
   SINGLE-VARIABLE DIFFERENTIAL (the only change between scenes is whether the in-place refresh
   branch is present in the booted source):
     CONTROL (shipped)        -> a poll tick (bump lv.bust, call galleryLiveRefresh) keeps the
                                  SAME stage <img> node (only its src changes) => no flicker, and
                                  the eta text updates in place.
     DECOY (branch reverted)  -> the tick destroys and re-CREATES the stage <img> every time
                                  (the historical flicker) => proves the in-place branch is
                                  load-bearing, not a no-op.
   Run: node tests/test_stage_preview_flicker_jsdom.mjs
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
// EOL-agnostic: app.js ships CRLF; the blocks below use LF. Normalize once.
const appBase = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" +
                 fs.readFileSync(path.join(WEB, "app.js"), "utf8")).replace(/\r\n/g, "\n");

// The shipped in-place stage-refresh branch. The DECOY swaps it back for the historical
// remove-then-rebuild (galleryLivePass) so the stage <img> is recreated every tick.
const NEW_BRANCH =
  '    const panel = liveSel ? stage.querySelector(\'.img-gallery__live[data-live="\' + liveSel.id + \'"]\') : null;\n' +
  '    if (panel) {   // light in-place refresh: eta text + the preview frame on the SAME img (or the ph txt)\n';
const OLD_BRANCH =
  '    const old = stage.querySelector(".img-gallery__live"); if (old) old.remove();\n' +
  '    if (liveSel) galleryLivePass(liveSel);\n';

check("shipped app.js carries the in-place stage-refresh branch (precondition for the lock)",
      appBase.includes(NEW_BRANCH));
// sanity: the decoy target (the historical teardown+rebuild) really exists somewhere so the
// single-variable replace is meaningful (it lives in the else-fallback, so we inject a
// standalone decoy variant instead of relying on removing a substring that appears twice).
const decoySrc = appBase.replace(
  // the entire stage refresh sub-block (NEW) -> the old unconditional teardown+rebuild (OLD)
  NEW_BRANCH.slice(0, NEW_BRANCH.indexOf("if (panel)")) + OLD_BRANCH,   // truncate to a unique prefix
  "STAGE_REFRESH_DECOY_MARKER_NOT_FOUND"   // sentinel; replaced below by the real branch swap
);

const EXPOSE = `
;window.__api = {
  renderGallery: () => renderGallery(),
  liveRefresh: () => galleryLiveRefresh(),
  setLiveSel: (id) => { galleryLiveSel = id; },
  addLive: (o) => { galleryLive.unshift(o); },
  live: () => galleryLive,
  resetSig: () => { _gallerySig = ""; },
  stageLiveImg: () => document.querySelector('#img-gallery .img-gallery__stage .img-gallery__live img'),
  stageLiveEta: () => document.querySelector('#img-gallery .img-gallery__stage .img-gallery__live-eta'),
  stageLivePanel: () => document.querySelector('#img-gallery .img-gallery__stage .img-gallery__live'),
};`;

const LIVE = () => ({ id: "liveS", url: "/data/generated/previews/job_liveS.png", bust: "?t=1",
                      seed: 7, prompt: "a fox", ts: 1, size: "256x256",
                      phTxt: "", eta: "", stop: null, retired: false });

function boot(src) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost:8099/", pretendToBeVisual: true });
  const win = dom.window;
  win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  win.IntersectionObserver = class { constructor(cb){this.cb=cb;} observe(){} unobserve(){} disconnect(){} takeRecords(){return [];} };
  win.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  win.cancelAnimationFrame = (id) => clearTimeout(id);
  win.confirm = () => true;
  win.EventSource = class { constructor() {} close() {} addEventListener() {} };
  win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) });
  win.eval(i18nSrc);
  win.eval(src + EXPOSE);
  return win;
}

// paint a live stage panel, then advance the preview cache-buster twice (simulate two poll
// ticks via galleryLiveRefresh) and report the stage <img> node identity + src before/after.
function scene(src) {
  const win = boot(src);
  const api = win.__api;
  api.addLive(LIVE());
  api.setLiveSel("liveS");
  api.renderGallery();                         // first paint: galleryLivePass builds the panel + img
  const img0 = api.stageLiveImg();
  const src0 = img0 ? img0.getAttribute("src") : null;
  // poll tick 1: engine wrote a new preview frame -> lv.url same, lv.bust + eta change
  const lv = api.live()[0];
  lv.bust = "?t=222"; lv.eta = "ETA 4s";
  api.liveRefresh();
  const img1 = api.stageLiveImg();
  const src1 = img1 ? img1.getAttribute("src") : null;
  const eta1 = api.stageLiveEta() ? api.stageLiveEta().textContent : null;
  // poll tick 2
  lv.bust = "?t=333"; lv.eta = "ETA 2s";
  api.liveRefresh();
  const img2 = api.stageLiveImg();
  const src2 = img2 ? img2.getAttribute("src") : null;
  return { win, api, img0, src0, img1, src1, eta1, img2, src2 };
}

console.log("\n=== CONTROL: shipped source (in-place stage refresh) ===");
{
  const s = scene(appBase);
  check("S1 a live stage panel with a preview <img> is painted", !!s.img0 && !!s.src0, "src0=" + s.src0);
  check("S2 THE FIX: a poll tick KEEPS the SAME stage <img> node (only src advances => no flicker)",
        !!s.img0 && s.img0 === s.img1 && s.img1 === s.img2,
        "same=" + (s.img0 === s.img1 && s.img1 === s.img2));
  check("S3 the stage preview src DOES advance each tick (cache-buster applies)",
        s.src0 !== s.src1 && s.src1 !== s.src2, "src2=" + s.src2);
  check("S4 the eta line updates in place (same panel, no rebuild needed for text)", s.eta1 === "ETA 4s",
        "eta1=" + s.eta1);
  s.win.close();
}

console.log("\n=== DECOY: stage refresh reverted to teardown+rebuild (must reproduce the flicker) ===");
{
  // single variable: replace the shipped in-place branch with the historical teardown+rebuild.
  // Build the decoy by splicing the OLD teardown line in front of galleryLivePass and cutting
  // the in-place `const panel ... if (panel) {` head up to (but excluding) that fallback.
  const inPlaceHead =
    '    const panel = liveSel ? stage.querySelector(\'.img-gallery__live[data-live="\' + liveSel.id + \'"]\') : null;\n' +
    '    if (panel) {   // light in-place refresh: eta text + the preview frame on the SAME img (or the ph txt)\n';
  const rebuildBody =
    '      const eta = panel.querySelector(".img-gallery__live-eta"); if (eta) eta.textContent = liveSel.eta || "";\n' +
    '      if (liveSel.url) {\n' +
    '        const pi = panel.querySelector("img");\n' +
    '        const want = liveSel.url + (liveSel.bust || "");\n' +
    '        if (pi) { if (pi.getAttribute("src") !== want) pi.setAttribute("src", want); }\n' +
    '      } else {   // still loading: refresh the placeholder seconds in place (url 0->1 is a STRUCTURAL change,\n';
  // The simplest faithful decoy: drop the panel-reuse and always tear down + rebuild.
  const decoy = appBase.replace(inPlaceHead,
    '    const old = stage.querySelector(".img-gallery__live"); if (old) old.remove();\n' +
    '    if (liveSel) galleryLivePass(liveSel); if (false) {\n');
  check("D0 the decoy really spliced out the in-place reuse (always tears down + rebuilds)",
        decoy !== appBase && decoy.includes('if (old) old.remove();\n    if (liveSel) galleryLivePass(liveSel); if (false) {'));
  const s = scene(decoy);
  check("D1 decoy: a poll tick RE-CREATES the stage <img> node (the historical flicker)",
        !!s.img0 && !!s.img1 && s.img0 !== s.img1,
        "same=" + (s.img0 === s.img1));
  s.win.close();
}

console.log("\n" + (FAILURES.length ? "STAGE-FLICKER-GATE: " + FAILURES.length + " FAILED -> " + FAILURES.join(" | ") : "STAGE-FLICKER-GATE: ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
