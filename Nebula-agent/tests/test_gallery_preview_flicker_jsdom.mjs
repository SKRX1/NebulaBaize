/* [Gate 2026-11-27 sig_guard] the flicker / broken-image behaviour lock.
   ROOT-CAUSE (measured, NOT assumed): while an async generation runs, the poll loop calls
   renderGallery() every ~2 s; renderGallery() ran `host.innerHTML=""` (a FULL rebuild), so
   EVERY finished grid <img> was destroyed and re-created. The src is unchanged, but each
   fresh node makes the browser re-fetch + re-decode, and the blank/alt frame BEFORE decode
   completes is exactly the "一闪一闪 + 破图" the user reported. (The preview png file itself
   was proven intact by a high-frequency read sampler -> the vae is NOT at fault.)
   THE FIX: galleryStructSig() fingerprints the FINISHED grid + live-cell STRUCTURE and
   deliberately EXCLUDES the per-tick preview cache-buster (lv.bust) and progress text. When
   the signature is unchanged renderGallery() light-refreshes the live preview (galleryLiveRefresh)
   and returns WITHOUT tearing down the finished <img> nodes, so they never re-decode.

   SINGLE-VARIABLE DIFFERENTIAL (the ONLY thing that changes between scenes is whether the
   structural-guard block is present in the booted source):
     CONTROL (shipped, guard present)  -> repeated renderGallery() with identical data keeps the
                                          SAME <img> node references (no rebuild => no flicker).
     DECOY   (guard block stripped)     -> repeated renderGallery() RE-CREATES the <img> nodes
                                          every tick (the historical flicker) => proves the guard
                                          is load-bearing, not a no-op.
   Also locks: a live-preview cache-buster tick does NOT rebuild the finished grid (lv.bust is
   excluded from the signature), while a REAL add DOES rebuild (a finished entry appearing).
   Run: node tests/test_gallery_preview_flicker_jsdom.mjs
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
// EOL-agnostic: app.js ships CRLF, GUARD_BLOCK below uses LF, so normalize once
// (same cssLF pattern as test_img_gallery_jsdom) or .includes/.replace would miss.
const appBase = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" +
                 fs.readFileSync(path.join(WEB, "app.js"), "utf8")).replace(/\r\n/g, "\n");

// the exact shipped guard block renderGallery() uses to skip the rebuild. The DECOY strips
// it so renderGallery falls back to the unconditional innerHTML rebuild (the bug behaviour).
const GUARD_BLOCK =
  "  const sig = galleryStructSig();   // [防闪烁修复 2026-11-27] structural fingerprint (preview ticks excluded)\n" +
  "  if (sig === _gallerySig && host.childElementCount) {   // nothing structural moved: light refresh, never rebuild the finished grid\n" +
  "    galleryLiveRefresh();\n" +
  "    return;\n" +
  "  }\n";
check("the shipped app.js carries the structural-guard block (precondition for the lock)",
      appBase.includes(GUARD_BLOCK));

// expose the module-internal let/function so the harness can DRIVE + OBSERVE.
const EXPOSE = `
;window.__api = {
  renderGallery: () => renderGallery(),
  pushEntry: (e) => { if (!galleryMem.some((x) => x.url === e.url)) galleryMem.unshift(e); },
  entries: () => galleryMem,
  addLive: (o) => { galleryLive.unshift(o); },
  live: () => galleryLive,
  resetSig: () => { _gallerySig = ""; },
  structSig: () => galleryStructSig(),
  // every <img> currently inside a FINISHED (non-live) grid cell, in DOM order.
  finishedImgs: () => [...document.querySelectorAll('#img-gallery .img-gallery__grid .img-gallery__cell:not(.img-gallery__cell--live) img')],
};`;

const SEED = [
  { url: "/data/generated/images/g1.png", seed: 1, prompt: "alpha", ts: 1, size: "512x512", saved: false },
  { url: "/data/generated/images/g2.png", seed: 2, prompt: "beta",  ts: 2, size: "512x512", saved: false },
];

// boot the app with a given app source; return the window.
function boot(src) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost:8099/", pretendToBeVisual: true });
  const win = dom.window;
  win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  win.IntersectionObserver = class { constructor(cb){this.cb=cb;} observe(){} unobserve(){} disconnect(){} takeRecords(){return [];} };
  win.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  win.cancelAnimationFrame = (id) => clearTimeout(id);
  win.confirm = () => true;
  win.EventSource = class { constructor() {} close() {} addEventListener() {} };   // jsdom has none; boot's initSessionStream() news one
  win.fetch = async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) });
  win.eval(i18nSrc);
  win.eval(src + EXPOSE);
  return win;
}

// drive a scene: seed 2 finished entries, full-render, then render N more ticks with
// identical data; return the finished <img> node refs before/after the ticks.
function scene(src) {
  const win = boot(src);
  const api = win.__api;
  SEED.forEach((e) => api.pushEntry(Object.assign({}, e)));
  api.renderGallery();                       // first paint builds the grid + sets _gallerySig
  const before = api.finishedImgs();
  const beforeSig = api.structSig();
  for (let k = 0; k < 3; k++) api.renderGallery();   // simulate the 2 s poll ticks (data identical)
  const after = api.finishedImgs();
  return { win, api, before, after, beforeSig };
}

console.log("\n=== CONTROL: shipped source (guard present) ===");
{
  const s = scene(appBase);
  check("C1 two finished grid cells are painted", s.before.length === 2,
        "imgs=" + s.before.length);
  check("C2 THE FIX: identical-data re-renders keep the SAME <img> node refs (no rebuild => no flicker)",
        s.before.length === s.after.length && s.before.every((n, k) => n === s.after[k]),
        "before=" + s.before.length + " after=" + s.after.length);
  // a live-preview cache-buster tick (the lv.bust the poll bumps) must NOT change the
  // structural signature, so the finished grid is preserved across preview progress.
  const sigNoLive = s.api.structSig();
  s.api.addLive({ id: "live9", url: "/data/generated/previews/job_live9.png", bust: "?t=1",
                  seed: null, prompt: "gen", ts: 3, size: "512x512", phTxt: "", eta: "",
                  stop: null, retired: false });
  const sigLiveBust1 = s.api.structSig();
  s.api.live()[0].bust = "?t=999";   // the poll advanced the cache-buster
  const sigLiveBust2 = s.api.structSig();
  check("C3 adding a live cell IS structural (sig moves: p->u present)", sigLiveBust1 !== sigNoLive);
  check("C4 bumping ONLY lv.bust does NOT move the signature (excluded => preview ticks skip the rebuild)",
        sigLiveBust1 === sigLiveBust2, sigLiveBust1 + " vs " + sigLiveBust2);
  // after a real finished-entry ADD the signature MUST move (the grid legitimately rebuilds).
  const sigB4 = s.api.structSig();
  s.api.pushEntry({ url: "/data/generated/images/g3.png", seed: 3, prompt: "gamma", ts: 4, size: "512x512", saved: false });
  s.api.renderGallery();
  check("C5 a real finished-entry add DOES move the signature and grows the grid to 3",
        s.api.structSig() !== sigB4 && s.api.finishedImgs().length === 3,
        "imgs=" + s.api.finishedImgs().length);
  s.win.close();
}

console.log("\n=== DECOY: structural-guard block stripped (must reproduce the flicker) ===");
{
  // single variable: KEEP the `const sig` declaration but DROP ONLY the
  // `if (sig === _gallerySig ...) return;` guard, so renderGallery always runs the
  // innerHTML rebuild (the historical flicker) without dangling a bare `_gallerySig = sig`.
  const stripped = appBase.replace(GUARD_BLOCK, "  const sig = galleryStructSig();\n");
  check("D0 the decoy source really had the guard stripped", stripped !== appBase && !stripped.includes(GUARD_BLOCK));
  const s = scene(stripped);
  check("D1 decoy: identical-data re-renders RE-CREATE the <img> nodes every tick (the historical flicker)",
        s.before.length === s.after.length && s.before.some((n, k) => n !== s.after[k]),
        "before=" + s.before.length + " after=" + s.after.length);
  s.win.close();
}

console.log("\n" + (FAILURES.length ? "FLICKER-GUARD-GATE: " + FAILURES.length + " FAILED -> " + FAILURES.join(" | ") : "FLICKER-GUARD-GATE: ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
